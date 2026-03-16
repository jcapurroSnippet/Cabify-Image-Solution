import { BatchProgressEvent, BatchResult } from '../types';

/**
 * Start batch processing from a Google Sheets URL
 * Returns a stream of progress events via callback
 * Uses server-side Drive folder configuration
 */
export const startBatchProcessing = async (
  sheetsUrl: string,
  onProgress: (event: BatchProgressEvent) => void,
  onComplete: (result: BatchResult) => void,
  onError: (error: string) => void
): Promise<void> => {
  try {
    let sawCompleted = false;
    let sawError = false;
    let lastTotalRows = 0;
    let lastProcessedRows = 0;

    const response = await fetch('/api/batch-aspect-ratio', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        sheetsUrl,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json().catch(() => ({}));
      throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
    }

    // Read the response as a stream of NDJSON
    const handleEvent = (event: BatchProgressEvent) => {
      if (event.totalRows !== undefined) {
        lastTotalRows = event.totalRows;
      }
      if (event.currentRow !== undefined) {
        lastProcessedRows = event.currentRow;
      }

      if (event.state === 'completed') {
        if (sawCompleted) return;
        sawCompleted = true;
        onComplete(event as unknown as BatchResult);
        return;
      }
      if (event.state === 'error') {
        if (sawError) return;
        sawError = true;
        onError(event.error || 'Unknown batch processing error');
        return;
      }

      onProgress(event);
    };

    const reader = response.body?.getReader();
    if (!reader) {
      const text = await response.text();
      text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .forEach((line) => {
          try {
            handleEvent(JSON.parse(line));
          } catch (e) {
            console.error('Failed to parse batch progress event:', e, line);
          }
        });
    } else {
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();

        if (done) {
          if (buffer.trim()) {
            try {
              handleEvent(JSON.parse(buffer));
            } catch (e) {
              console.error('Failed to parse final batch event:', e);
            }
          }
          break;
        }

        buffer += decoder.decode(value, { stream: true });

        // Process complete lines
        const lines = buffer.split('\n');
        buffer = lines.pop() || ''; // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;

          try {
            handleEvent(JSON.parse(line));
          } catch (e) {
            console.error('Failed to parse batch progress event:', e, line);
          }
        }
      }
    }

    if (!sawCompleted && !sawError) {
      onComplete({
        success: true,
        totalRows: lastTotalRows,
        processedRows: lastProcessedRows,
      });
    }
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Batch processing error:', error);
    onError(errorMessage);
  }
};

/**
 * Validate a Google Sheets URL
 */
export const isValidSheetsUrl = (url: string): boolean => {
  try {
    return /\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/.test(url);
  } catch {
    return false;
  }
};

/**
 * Validate a Google Drive folder URL
 */
export const isValidDriveFolderUrl = (url: string): boolean => {
  try {
    return /folders\/([a-zA-Z0-9-_]+)/.test(url);
  } catch {
    return false;
  }
};

/**
 * Extract error message from batch event
 */
export const getErrorMessage = (event: BatchProgressEvent): string | null => {
  if (event.error) {
    return event.error;
  }
  if (event.status === 'error') {
    return 'Processing error occurred';
  }
  return null;
};

/**
 * Format progress percentage
 */
export const getProgressPercentage = (current: number, total: number): number => {
  if (total === 0) return 0;
  return Math.round((current / total) * 100);
};
