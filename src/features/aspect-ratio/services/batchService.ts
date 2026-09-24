import {
  BatchAspectRatio,
  BatchProgressEvent,
  BatchResult,
  BatchProgressStatus,
  BatchReviewMetadata,
} from '../types';

export interface BatchStatusRow {
  status: BatchProgressStatus;
  links?: Record<BatchAspectRatio, string[]>;
}

export interface BatchStatusSnapshot {
  totalRows: number;
  completedRows: number;
  remainingRows: number;
  batchComplete: boolean;
  rows: Record<number, BatchStatusRow>;
  reviewBatchId?: string;
}

/**
 * Where a cut stream got to, in one sentence, for the error the operator reads.
 * Exported so the wording is testable without driving a whole batch.
 */
export const describeStreamEnd = (
  lastEvent: BatchProgressEvent | null,
  eventCount: number,
): string => {
  if (!lastEvent) {
    return eventCount > 0
      ? 'The server sent only keepalives before the connection dropped.'
      : 'The server sent nothing at all, so it was cut before it started work.';
  }
  const where = lastEvent.state || lastEvent.status || 'an unnamed step';
  const row = Number.isFinite(lastEvent.rowNumber)
    ? ` on source row ${lastEvent.rowNumber}`
    : '';
  const ratio = lastEvent.ratio ? ` (${lastEvent.ratio})` : '';
  return `It was last seen at "${where}"${row}${ratio}, ${eventCount} event(s) in.`;
};

/**
 * Start batch processing from a Google Sheets URL
 * Returns a stream of progress events via callback
 * Uses server-side Drive folder configuration
 */
export const startBatchProcessing = async (
  sheetsUrl: string,
  onProgress: (event: BatchProgressEvent) => void,
  onComplete: (result: BatchResult) => void,
  onError: (error: string) => void,
  reviewMetadata?: BatchReviewMetadata,
  initialReviewBatchId?: string | null,
): Promise<void> => {
  try {
    let reviewBatchId = initialReviewBatchId?.trim() || undefined;
    let previousProcessedRows = -1;

    // Each request handles a bounded number of source rows. This keeps a
    // 12-image Sheet well below Cloud Run's one-hour request ceiling while all
    // chunks continue to write into the same review batch.
    for (let chunk = 0; chunk < 1000; chunk += 1) {
      const response = await fetch('/api/batch-aspect-ratio', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          sheetsUrl,
          ...(reviewMetadata || {}),
          ...(reviewBatchId && { reviewBatchId }),
          rowsPerRequest: 3,
        }),
      });

      if (!response.ok) {
        const errorData = await response.json().catch(() => ({}));
        throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
      }

      let chunkResult: BatchResult | null = null;
      let streamError = '';
      // A stream that stops short of its result says nothing about why. Keeping
      // the last thing the server managed to send turns "the connection ended"
      // into "the connection ended while generating source row 7", which is the
      // difference between a guess and a place to look.
      let lastEvent: BatchProgressEvent | null = null;
      let eventCount = 0;
      const handleEvent = (event: BatchProgressEvent) => {
        eventCount += 1;
        if (event.state !== 'keepalive') lastEvent = event;
        if (event.reviewBatchId) reviewBatchId = event.reviewBatchId;
        if (event.state === 'completed') {
          chunkResult = event as unknown as BatchResult;
          return;
        }
        if (event.state === 'error') {
          streamError = event.error || 'Unknown batch processing error';
          return;
        }
        if (event.state !== 'keepalive' && event.state !== 'started') onProgress(event);
      };

      const parseLine = (line: string) => {
        if (!line.trim()) return;
        try {
          handleEvent(JSON.parse(line) as BatchProgressEvent);
        } catch (error) {
          throw new Error(`Invalid batch progress response: ${(error as Error).message}`);
        }
      };

      const reader = response.body?.getReader();
      if (!reader) {
        const text = await response.text();
        text.split('\n').forEach(parseLine);
      } else {
        const decoder = new TextDecoder();
        let buffer = '';
        while (true) {
          const { done, value } = await reader.read();
          if (done) {
            buffer += decoder.decode();
            if (buffer.trim()) parseLine(buffer);
            break;
          }
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split('\n');
          buffer = lines.pop() || '';
          lines.forEach(parseLine);
        }
      }

      if (streamError) throw new Error(streamError);
      if (!chunkResult) {
        throw new Error(
          `The batch connection ended before the current chunk was persisted. ${describeStreamEnd(lastEvent, eventCount)}`,
        );
      }
      if (typeof chunkResult.batchComplete !== 'boolean') {
        throw new Error('The server returned an invalid batch completion state.');
      }
      if (!Number.isFinite(chunkResult.processedRows)) {
        throw new Error('The server returned an invalid processed-row count.');
      }

      reviewBatchId = chunkResult.reviewBatchId || reviewBatchId;
      if (chunkResult.batchComplete) {
        onComplete({ ...chunkResult, reviewBatchId });
        return;
      }
      if (!reviewBatchId) {
        throw new Error('The server did not return the review batch ID required to continue.');
      }
      if (chunkResult.processedRows <= previousProcessedRows) {
        throw new Error('Batch processing made no progress; refusing to repeat the same chunk.');
      }
      previousProcessedRows = chunkResult.processedRows;
    }

    throw new Error('Batch processing exceeded the maximum number of chunks.');
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    console.error('Batch processing error:', error);
    onError(errorMessage);
  }
};

/**
 * Poll batch status from the server, which rebuilds it from the batch_variations
 * tab. Pass the batch id when known: the tab is accumulative, so without it the
 * server falls back to the most recent batch for that source tab.
 */
export const fetchBatchStatus = async (
  sheetsUrl: string,
  reviewBatchId?: string | null
): Promise<BatchStatusSnapshot> => {
  const response = await fetch('/api/batch-status', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ sheetsUrl, ...(reviewBatchId && { reviewBatchId }) }),
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || `HTTP ${response.status}: ${response.statusText}`);
  }

  return response.json();
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
