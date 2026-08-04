interface NanoEditorResponse {
  imageUrl?: string;
  error?: string;
}

export interface EditorReviewContext {
  sheetsUrl: string;
  batchId: string;
  sourceAssetName: string;
  sourceIndex: number;
  generationId: string;
  familyId: string;
  category: string;
  plazas: string[];
}

export interface CreateEditorReviewBatchInput {
  title: string;
  category: string;
  plazas: string[];
  createdBy: string;
  expectedItemCount: number;
}

export interface EditorReviewBatch {
  batchId: string;
  reviewBatchId: string;
  sheetsUrl: string;
  [key: string]: unknown;
}

const parseErrorMessage = async (response: Response): Promise<string> => {
  try {
    const payload = (await response.json()) as { error?: string };
    return payload?.error || `Request failed with status ${response.status}.`;
  } catch {
    return `Request failed with status ${response.status}.`;
  }
};

export const generateVariant = async (
  imageDataUrl: string,
  prompt: string,
  reviewContext?: EditorReviewContext,
): Promise<string> => {
  const response = await fetch('/api/nano-editor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      imageDataUrl,
      prompt,
      ...(reviewContext && { reviewContext }),
    }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const data = (await response.json()) as NanoEditorResponse;
  if (!data.imageUrl) {
    throw new Error('The model did not return an image.');
  }

  return data.imageUrl;
};

export const createEditorReviewBatch = async (
  input: CreateEditorReviewBatchInput,
): Promise<EditorReviewBatch> => {
  const response = await fetch('/api/creative-reviews/batches', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      ...input,
      sourceType: 'editor_batch',
      metadata: { expectedItemCount: input.expectedItemCount },
    }),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  const data = (await response.json()) as Partial<EditorReviewBatch> & {
    id?: string;
  };
  const batchId = String(data.reviewBatchId || data.batchId || data.id || '').trim();
  const sheetsUrl = String(data.sheetsUrl || '').trim();
  if (!batchId || !sheetsUrl) {
    throw new Error('The review service did not return a batch ID and operational Sheet.');
  }

  return {
    ...data,
    batchId,
    reviewBatchId: batchId,
    sheetsUrl,
  };
};
