import { AspectRatio } from '../features/aspect-ratio/types';

type JsonResponse = {
  error?: string;
  imageUrl?: string;
  images?: string[];
  details?: unknown;
};

const parseErrorMessage = async (response: Response): Promise<string> => {
  let payload: JsonResponse | null = null;

  try {
    payload = (await response.json()) as JsonResponse;
  } catch (_error) {
    payload = null;
  }

  return payload?.error || `Request failed with status ${response.status}.`;
};

const postJson = async <TResponse>(url: string, body: unknown): Promise<TResponse> => {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(await parseErrorMessage(response));
  }

  return (await response.json()) as TResponse;
};

export const generateNanoImage = async (imageDataUrl: string, prompt: string): Promise<string> => {
  const data = await postJson<{ imageUrl?: string }>('/api/nano-editor', {
    imageDataUrl,
    prompt,
  });

  if (!data.imageUrl) {
    throw new Error('The model did not return an image.');
  }

  return data.imageUrl;
};

export const generateAspectRatioImages = async (
  imageDataUrl: string,
  targetRatio: AspectRatio,
): Promise<string[]> => {
  const data = await postJson<{ images?: string[] }>('/api/aspect-ratio', {
    imageDataUrl,
    targetRatio,
  });

  if (!Array.isArray(data.images) || data.images.length === 0) {
    throw new Error('The model did not return images.');
  }

  return data.images;
};
