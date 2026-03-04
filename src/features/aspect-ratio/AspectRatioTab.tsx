import React, { useState } from 'react';
import { AlertCircle, Download, Eraser, ImagePlus, Loader2, Ratio } from 'lucide-react';
import { generateAspectRatioImages } from '../../lib/api';
import { AspectRatio, AspectRatioState, GeneratedImage } from './types';

const INITIAL_STATE: AspectRatioState = {
  originalImage: null,
  isProcessing: false,
  results: [],
  error: null,
};

const SUPPORTED_RATIOS: AspectRatio[] = [AspectRatio.RATIO_1_1, AspectRatio.RATIO_9_16];

const getAspectClass = (ratio: AspectRatio): string => {
  if (ratio === AspectRatio.RATIO_9_16) {
    return 'aspect-[9/16]';
  }

  if (ratio === AspectRatio.RATIO_16_9) {
    return 'aspect-video';
  }

  return 'aspect-square';
};

export default function AspectRatioTab() {
  const [state, setState] = useState<AspectRatioState>(INITIAL_STATE);
  const [activeRatio, setActiveRatio] = useState<AspectRatio | null>(null);

  const onFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    if (!file) {
      return;
    }

    if (!file.type.startsWith('image/')) {
      setState((previous) => ({
        ...previous,
        error: 'Please upload a valid image file.',
      }));
      return;
    }

    const reader = new FileReader();
    reader.onload = (readerEvent) => {
      setState((previous) => ({
        ...previous,
        originalImage: readerEvent.target?.result as string,
        error: null,
        results: [],
      }));
    };
    reader.readAsDataURL(file);
  };

  const clearGallery = () => {
    setState((previous) => ({ ...previous, results: [] }));
  };

  const handleError = (error: unknown) => {
    const message = (error as { message?: string })?.message || 'Unexpected generation error.';
    setState((previous) => ({
      ...previous,
      isProcessing: false,
      error: message,
    }));
  };

  const generateCustomRatio = async (ratio: AspectRatio) => {
    if (!state.originalImage) {
      setState((previous) => ({ ...previous, error: 'Upload an image before generating variations.' }));
      return;
    }

    setState((previous) => ({ ...previous, isProcessing: true, error: null }));
    setActiveRatio(ratio);

    try {
      const urls = await generateAspectRatioImages(state.originalImage, ratio);
      const newResults: GeneratedImage[] = urls.map((url, index) => ({
        id: `${ratio}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        url,
        ratio,
        prompt: `Variation ${index + 1} - ${ratio}`,
        timestamp: Date.now(),
      }));

      setState((previous) => ({
        ...previous,
        isProcessing: false,
        results: [...newResults, ...previous.results],
      }));
    } catch (error) {
      handleError(error);
    } finally {
      setActiveRatio(null);
    }
  };

  return (
    <div className="grid gap-6 lg:grid-cols-[360px_1fr]">
      <div className="space-y-4">
        <section className="panel-surface space-y-3">
          <div>
            <h3 className="text-lg font-semibold text-white">Image</h3>
          </div>

          {!state.originalImage ? (
            <label className="flex aspect-square cursor-pointer flex-col items-center justify-center rounded-2xl border-2 border-dashed border-slate-600/60 bg-slate-900/40 transition-colors hover:border-slate-400/80">
              <ImagePlus className="mb-3 h-8 w-8 text-slate-300" />
              <p className="text-sm text-slate-100">Click to upload</p>
              <input type="file" className="hidden" accept="image/*" onChange={onFileChange} />
            </label>
          ) : (
            <div className="space-y-3">
              <div className="overflow-hidden rounded-2xl border border-slate-700/70 bg-black">
                <img src={state.originalImage} alt="Original for resize" className="h-auto max-h-[340px] w-full object-contain" />
              </div>
              <button
                type="button"
                onClick={() => setState((previous) => ({ ...previous, originalImage: null, results: [], error: null }))}
                className="w-full rounded-xl border border-slate-700/80 bg-slate-900/60 px-3 py-2 text-sm text-slate-200 transition-colors hover:border-slate-500"
              >
                Remove
              </button>
            </div>
          )}
        </section>

        <section className="panel-surface space-y-3">
          <div className="flex items-center justify-between">
            <div>
              <h3 className="text-lg font-semibold text-white">Ratio</h3>
            </div>
            <Ratio className="h-5 w-5 text-slate-400" />
          </div>

          <div className="grid grid-cols-2 gap-2">
            {SUPPORTED_RATIOS.map((ratio) => (
              <button
                key={ratio}
                type="button"
                onClick={() => generateCustomRatio(ratio)}
                disabled={state.isProcessing || !state.originalImage}
                className={`inline-flex items-center justify-center gap-2 rounded-xl border px-3 py-3 text-sm font-semibold transition-all ${
                  activeRatio === ratio
                    ? 'border-cyan-300/90 bg-cyan-300 text-slate-900'
                    : 'border-slate-700/80 bg-slate-900/60 text-slate-200 hover:border-slate-500'
                } disabled:cursor-not-allowed disabled:opacity-50`}
              >
                {activeRatio === ratio ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
                {ratio}
              </button>
            ))}
          </div>

          {state.error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{state.error}</p>
            </div>
          )}
        </section>
      </div>

      <section className="panel-surface space-y-4">
        <div className="flex items-center justify-between">
          <div>
            <h3 className="text-lg font-semibold text-white">Results</h3>
          </div>

          <div className="flex items-center gap-2">
            <span className="rounded-full border border-slate-700/80 bg-slate-900/60 px-3 py-1 text-xs text-slate-300">
              {state.results.length}
            </span>
            {state.results.length > 0 && (
              <button
                type="button"
                onClick={clearGallery}
                className="inline-flex items-center gap-1 rounded-full border border-slate-700/80 bg-slate-900/60 px-3 py-1 text-xs text-slate-200 transition-colors hover:border-red-400/60 hover:text-red-200"
              >
                <Eraser className="h-3.5 w-3.5" />
                Clear
              </button>
            )}
          </div>
        </div>

        {state.results.length === 0 ? (
          <div className="flex min-h-[420px] flex-col items-center justify-center rounded-2xl border border-dashed border-slate-700/80 bg-slate-900/25 text-slate-500">
            {state.isProcessing ? (
              <>
                <Loader2 className="mb-3 h-8 w-8 animate-spin text-cyan-200" />
                <p className="text-sm text-slate-300">Generating...</p>
              </>
            ) : (
              <>
                <ImagePlus className="mb-3 h-8 w-8" />
                <p className="text-sm">No results yet.</p>
              </>
            )}
          </div>
        ) : (
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-2">
            {state.results.map((image) => (
              <article key={image.id} className="overflow-hidden rounded-2xl border border-slate-700/70 bg-slate-900/35">
                <div className={`relative w-full overflow-hidden bg-black ${getAspectClass(image.ratio)}`}>
                  <img src={image.url} alt={image.prompt} className="h-full w-full object-contain" />
                  <div className="absolute left-2 top-2 rounded-full bg-cyan-300 px-2 py-1 text-[10px] font-bold text-slate-900">
                    {image.ratio}
                  </div>
                  <a
                    href={image.url}
                    download={`aspect-${image.ratio.replace(':', '-')}-${image.id.slice(0, 6)}.png`}
                    className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full border border-white/30 bg-white/10 px-2 py-1 text-[10px] text-white backdrop-blur-sm"
                  >
                    <Download className="h-3 w-3" />
                    Save
                  </a>
                </div>
              </article>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
