import { GoogleGenAI } from '@google/genai';

const getApiKey = (): string => {
  const apiKey = import.meta.env.VITE_GEMINI_API_KEY;
  return typeof apiKey === 'string' ? apiKey.trim() : '';
};

export const hasGeminiApiKey = (): boolean => getApiKey().length > 0;

export const getGeminiClient = (): GoogleGenAI => {
  const apiKey = getApiKey();

  if (!apiKey) {
    throw new Error('Missing VITE_GEMINI_API_KEY. Define it in your .env file.');
  }

  return new GoogleGenAI({ apiKey });
};