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