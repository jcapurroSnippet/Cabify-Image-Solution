export interface UploadedImage {
  id: string;
  file: File;
  previewUrl: string;
  processedUrl: string | null;
  isProcessing: boolean;
  error: string | null;
}

export interface PresetPrompt {
  id: string;
  label: string;
  value: string;
}
