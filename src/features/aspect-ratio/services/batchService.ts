import { BatchProgressEvent, BatchResult } from '../types';

/**
 * Start batch processing from a Google Sheets URL
 * Returns a stream of progress events via callback
 * Uses hardcoded Drive folder: 1gWY-ZEMbWBcM_lwSKzc5HD89Pa_SiBWO
 */
export const startBatchProcessing = async (
  sheetsUrl: string,
  onProgress: (event: BatchProgressEvent) => void,
  onComplete: (result: BatchResult) => void,
  onError: (error: string) => void
): Promise<void> => {
  try {
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
    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error('Failed to read response stream');
    }

    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();

      if (done) {
        if (buffer.trim()) {
          try {
            const event = JSON.parse(buffer);
            if (event.state === 'completed') {
              onComplete(event);
            } else {
              onProgress(event);
            }
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
          const event: BatchProgressEvent = JSON.parse(line);

          if (event.state === 'completed') {
            onComplete(event as unknown as BatchResult);
          } else if (event.state === 'error') {
            onError(event.error || 'Unknown batch processing error');
          } else {
            onProgress(event);
          }
        } catch (e) {
          console.error('Failed to parse batch progress event:', e, line);
        }
      }
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
