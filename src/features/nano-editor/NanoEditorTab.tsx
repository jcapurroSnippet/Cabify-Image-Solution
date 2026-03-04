import React, { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { AlertCircle, Download, Image as ImageIcon, Loader2, RefreshCw, Upload, Wand2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { getGeminiClient, hasGeminiApiKey } from '../../lib/geminiClient';

const PROMPT_LIMITATIONS = `**Role & Mission**
You are the **Cabify Creative Refiner**. Generate exactly one ad variation using only assets already present in the source image.

**Non-negotiable constraints**
1. Do not add new visual elements.
2. Do not change style direction.
3. Do not rotate, mirror, or flip existing elements.
4. Typography must stay exactly as source.
5. Colors must stay exactly as source.
6. Brand fidelity must stay strict.
7. Allowed changes are only layout-level: reorder, reposition, recombine, proportional scale.
8. Do not redraw or replace objects.
9. Produce one output only.
`;

export default function NanoEditorTab() {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [mimeType, setMimeType] = useState('');
  const [prompt, setPrompt] = useState('');
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const apiKeyReady = hasGeminiApiKey();

  const processFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please upload a valid image file.');
      return;
    }

    setMimeType(file.type);
    const reader = new FileReader();
    reader.onloadend = () => {
      setSelectedImage(reader.result as string);
      setResultImage(null);
      setError(null);
    };
    reader.readAsDataURL(file);
  };

  const handleImageUpload = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(true);
  };

  const handleDragLeave = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
  };

  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    setIsDragging(false);
    const file = event.dataTransfer.files?.[0];
    if (file) {
      processFile(file);
    }
  };

  const handleReset = () => {
    setSelectedImage(null);
    setResultImage(null);
    setPrompt('');
    setError(null);
    setMimeType('');

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleGenerate = async () => {
    if (!apiKeyReady) {
      setError('Missing API key. Set VITE_GEMINI_API_KEY in .env.');
      return;
    }

    if (!selectedImage || !prompt.trim()) {
      setError('Please provide an image and editing instructions.');
      return;
    }

    setIsGenerating(true);
    setError(null);

    try {
      const base64Data = selectedImage.split(',')[1];
      const finalPrompt = `${prompt.trim()}\n\n${PROMPT_LIMITATIONS}`;

      const ai = getGeminiClient();
      const response = await ai.models.generateContent({
        model: 'gemini-3.1-flash-image-preview',
        contents: {
          parts: [
            {
              inlineData: {
                data: base64Data,
                mimeType,
              },
            },
            {
              text: finalPrompt,
            },
          ],
        },
        config: {
          responseModalities: ['IMAGE', 'TEXT'],
        },
      });

      let generatedImageUrl: string | null = null;
      for (const part of response.candidates?.[0]?.content?.parts ?? []) {
        if (part.inlineData?.data) {
          generatedImageUrl = `data:${part.inlineData.mimeType || 'image/png'};base64,${part.inlineData.data}`;
          break;
        }
      }

      if (generatedImageUrl) {
        setResultImage(generatedImageUrl);
      } else {
        setError('The model did not return an image. Try again with a more specific prompt.');
      }
    } catch (generationError) {
      console.error(generationError);
      const message = (generationError as { message?: string })?.message || 'Unexpected image generation error.';
      setError(message);
    } finally {
      setIsGenerating(false);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-2">
      <div className="space-y-4">
        {!apiKeyReady && (
          <div className="rounded-2xl border border-amber-500/40 bg-amber-500/10 p-4 text-sm text-amber-100">
            Missing <code className="font-mono">VITE_GEMINI_API_KEY</code>
          </div>
        )}

        <section className="panel-surface space-y-3">
          <div>
            <h3 className="text-lg font-semibold text-white">Image</h3>
          </div>

          <div
            className={`relative flex aspect-video cursor-pointer items-center justify-center overflow-hidden rounded-2xl border-2 border-dashed transition-all ${
              isDragging
                ? 'border-cyan-300 bg-cyan-300/10'
                : 'border-slate-600/60 bg-slate-900/40 hover:border-slate-400/80'
            } ${selectedImage ? 'border-solid border-slate-500/60' : ''}`}
            onDragOver={handleDragOver}
            onDragLeave={handleDragLeave}
            onDrop={handleDrop}
            onClick={() => !selectedImage && fileInputRef.current?.click()}
          >
            <input
              ref={fileInputRef}
              type="file"
              accept="image/*"
              className="hidden"
              onChange={handleImageUpload}
            />

            {selectedImage ? (
              <>
                <img src={selectedImage} alt="Uploaded source" className="h-full w-full object-cover" />
                <div className="absolute inset-0 flex items-center justify-center bg-slate-950/65 opacity-0 transition-opacity hover:opacity-100">
                  <button
                    type="button"
                    onClick={(event) => {
                      event.stopPropagation();
                      handleReset();
                    }}
                    className="inline-flex items-center gap-2 rounded-full border border-white/30 bg-white/10 px-4 py-2 text-sm text-white"
                  >
                    <RefreshCw className="h-4 w-4" />
                    Change
                  </button>
                </div>
              </>
            ) : (
              <div className="px-6 text-center">
                <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-slate-800/80">
                  <Upload className="h-5 w-5 text-slate-200" />
                </div>
                <p className="text-sm font-medium text-slate-100">Click or drag</p>
              </div>
            )}
          </div>
        </section>

        <section className="panel-surface space-y-3">
          <div>
            <h3 className="text-lg font-semibold text-white">Prompt</h3>
          </div>

          <textarea
            value={prompt}
            onChange={(event) => setPrompt(event.target.value)}
            placeholder="Describe the edit..."
            className="min-h-36 w-full rounded-2xl border border-slate-700/80 bg-slate-900/70 p-4 text-sm text-slate-100 outline-none transition-colors placeholder:text-slate-500 focus:border-cyan-300/70"
          />

          {error && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{error}</p>
            </motion.div>
          )}

          <button
            type="button"
            onClick={handleGenerate}
            disabled={!apiKeyReady || !selectedImage || !prompt.trim() || isGenerating}
            className="inline-flex w-full items-center justify-center gap-2 rounded-xl bg-cyan-300 px-4 py-3 font-semibold text-slate-900 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {isGenerating ? (
              <>
                <Loader2 className="h-4 w-4 animate-spin" />
                Generating...
              </>
            ) : (
              <>
                <Wand2 className="h-4 w-4" />
                Generate
              </>
            )}
          </button>
        </section>
      </div>

      <section className="panel-surface space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Result</h3>
          </div>
          {resultImage && !isGenerating && (
            <a
              href={resultImage}
              download="nano-editor-result.png"
              className="inline-flex items-center gap-2 rounded-full border border-cyan-200/40 bg-cyan-200/10 px-3 py-1 text-xs font-medium text-cyan-100"
            >
              <Download className="h-3.5 w-3.5" />
              Download
            </a>
          )}
        </div>

        <div className="relative flex aspect-video items-center justify-center overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-900/45">
          <AnimatePresence mode="wait">
            {isGenerating ? (
              <motion.div
                key="loading"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                exit={{ opacity: 0 }}
                className="flex flex-col items-center text-slate-300"
              >
                <Loader2 className="mb-2 h-8 w-8 animate-spin" />
                <p className="text-sm">Generating...</p>
              </motion.div>
            ) : resultImage ? (
              <motion.img
                key="result"
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                src={resultImage}
                alt="Generated output"
                className="h-full w-full object-cover"
              />
            ) : (
              <motion.div
                key="empty"
                initial={{ opacity: 0 }}
                animate={{ opacity: 1 }}
                className="text-center text-slate-500"
              >
                <ImageIcon className="mx-auto mb-2 h-8 w-8" />
                <p className="text-sm">No result yet.</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>
      </section>
    </div>
  );
}
