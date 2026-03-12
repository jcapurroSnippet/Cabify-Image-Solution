export enum AspectRatio {
  RATIO_1_1 = '1:1',
  RATIO_3_4 = '3:4',
  RATIO_4_3 = '4:3',
  RATIO_9_16 = '9:16',
  RATIO_16_9 = '16:9',
}

export interface GeneratedImage {
  id: string;
  url: string;
  ratio: AspectRatio;
  prompt: string;
  timestamp: number;
}

export interface AspectRatioState {
  originalImage: string | null;
  isProcessing: boolean;
  results: GeneratedImage[];
  error: string | null;
}

// Batch Processing Types

export type BatchProgressStatus =
  | 'reading-sheet'
  | 'downloading'
  | 'generating'
  | 'uploading'
  | 'completed'
  | 'skipped'
  | 'error'
  | 'updating-sheet';

export interface BatchRowData {
  [key: string]: string;
}

export interface BatchProgressEvent {
  state?: string;
  message?: string;
  error?: string;
  rowNumber?: number;
  currentRow?: number;
  totalRows?: number;
  status?: BatchProgressStatus;
  ratio?: '1:1' | '9:16';
  imageUrl?: string;
  reason?: string;
  rowData?: BatchRowData;
  links?: {
    '1:1': string[];
    '9:16': string[];
  };
}

export interface BatchResult {
  success: boolean;
  totalRows: number;
  processedRows: number;
  errors?: {
    rowNumber: number;
    error: string;
  }[];
}

export interface BatchState {
  sheetsUrl: string;
  driveFolderUrl: string;
  isProcessing: boolean;
  progress: {
    totalRows: number;
    processedRows: number;
    currentRowNumber: number;
    currentStatus: BatchProgressStatus;
  };
  results: {
    [rowNumber: number]: {
      status: BatchProgressStatus;
      links?: {
        '1:1': string[];
        '9:16': string[];
      };
      error?: string;
    };
  };
  error: string | null;
}