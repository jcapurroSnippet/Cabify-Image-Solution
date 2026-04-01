import React, { useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import { AlertCircle, Download, Image as ImageIcon, Loader2, RefreshCw, Upload, Wand2 } from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import { generateNanoImage } from '../../lib/api';

export default function NanoEditorTab() {
  const [selectedImage, setSelectedImage] = useState<string | null>(null);
  const [prompt, setPrompt] = useState('');
  const [resultImage, setResultImage] = useState<string | null>(null);
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const processFile = (file: File) => {
    if (!file.type.startsWith('image/')) {
      setError('Please upload a valid image file.');
      return;
    }

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

    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleGenerate = async () => {
    if (!selectedImage || !prompt.trim()) {
      setError('Please provide an image and editing instructions.');
      return;
    }

    setIsGenerating(true);
    setError(null);

    // If there's already a result, edit on top of it (iterative editing)
    const sourceImage = resultImage ?? selectedImage;

    try {
      const generatedImageUrl = await generateNanoImage(sourceImage, prompt.trim());
      setResultImage(generatedImageUrl);
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
            disabled={!selectedImage || !prompt.trim() || isGenerating}
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
          <div className="space-y-0.5">
            <h3 className="text-lg font-semibold text-white">Result</h3>
            {resultImage && !isGenerating && (
              <p className="text-xs text-cyan-300">Next generation will edit this output</p>
            )}
          </div>
          <div className="flex items-center gap-2">
            {resultImage && !isGenerating && (
              <>
                <button
                  type="button"
                  onClick={() => setResultImage(null)}
                  className="inline-flex items-center gap-2 rounded-full border border-slate-600/60 bg-slate-800/60 px-3 py-1 text-xs font-medium text-slate-300 hover:text-white"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  Reset to original
                </button>
                <a
                  href={resultImage}
                  download="nano-editor-result.png"
                  className="inline-flex items-center gap-2 rounded-full border border-cyan-200/40 bg-cyan-200/10 px-3 py-1 text-xs font-medium text-cyan-100"
                >
                  <Download className="h-3.5 w-3.5" />
                  Download
                </a>
              </>
            )}
          </div>
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
