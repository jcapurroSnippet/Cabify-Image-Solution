interface NanoEditorResponse {
  imageUrl?: string;
  error?: string;
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
): Promise<string> => {
  const response = await fetch('/api/nano-editor', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ imageDataUrl, prompt }),
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
