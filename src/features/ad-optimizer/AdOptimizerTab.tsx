import React, { useCallback, useRef, useState } from 'react';
import {
  AlertCircle,
  CheckCircle,
  ChevronDown,
  Download,
  ImagePlus,
  Loader2,
  Wand2,
  X,
} from 'lucide-react';
import { AnimatePresence, motion } from 'motion/react';
import type { UploadedImage } from './types';
import { scenes } from './scenes';
import { generateVariant } from './services/adOptimizerApi';

const MIN_IMAGES = 3;
const MAX_IMAGES = 20;

const CONSTRAINTS = `Non-negotiable visual constraints — never violate:
- Argentinians only. Subjects must look like real, diverse people from Buenos Aires or Córdoba. No foreigners, no models, no overly styled individuals.
- No same gender couples.
- Never include taxis in the image. The vehicle must always be a private ride-hailing car (Cabify). No yellow cabs, no taxi signage.
- People must appear warm, joyful, and energetic. No serious expressions, no sadness, no melancholy, no neutral blank stares.
- When multiple people are present, they must be interacting — looking at each other, laughing together, sharing a moment. No disconnected individuals ignoring each other.
- The urban background must occupy no more than 30% of the frame. People and the car are the protagonists — the street is context, not the subject.
- Subjects must always be in or around the back seat of the car. Never in the front seat, never driving.
- Car doors must open like standard sedan doors (hinged at the front, swinging outward). No sliding doors, no van-style doors, no bus doors.
- People must look natural and authentic — not professional models, not overly styled or posed. Candid, real, relatable.
- No photo filters, no color grading effects, no vignettes, no Instagram-style treatments. Raw, natural photographic look only.`;

const buildPrompt = (sceneId: number): string => {
  const scene = scenes.find((s) => s.id === sceneId);
  if (!scene) return CONSTRAINTS;

  return `Transform this image to match the following Cabify ad scene.

Scene: "${scene.title}" — Stage: ${scene.stage}
Subject & action: ${scene.scene}
Background: ${scene.background}
Composition guidance: ${scene.designSpace}

${CONSTRAINTS}`;
};

const readFileAsDataUrl = (file: File): Promise<string> =>
  new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(new Error('Error reading file.'));
    reader.readAsDataURL(file);
  });

const downloadImage = (dataUrl: string, filename: string) => {
  const a = document.createElement('a');
  a.href = dataUrl;
  a.download = filename;
  a.click();
};

const STAGE_COLORS: Record<string, string> = {
  Entrada: 'bg-cyan-500/15 text-cyan-300',
  Trayecto: 'bg-violet-500/15 text-violet-300',
  Salida: 'bg-amber-500/15 text-amber-300',
};

export default function AdOptimizerTab() {
  const [images, setImages] = useState<UploadedImage[]>([]);
  const [selectedSceneId, setSelectedSceneId] = useState<number>(scenes[0].id);
  const [isProcessing, setIsProcessing] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [globalError, setGlobalError] = useState<string | null>(null);
  const [doneCount, setDoneCount] = useState(0);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const addFiles = useCallback(async (files: FileList | File[]) => {
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'));
    const remaining = MAX_IMAGES - images.length;
    const toAdd = arr.slice(0, remaining);
    if (toAdd.length === 0) return;

    const newImages: UploadedImage[] = await Promise.all(
      toAdd.map(async (file) => ({
        id: `${Date.now()}-${Math.random()}`,
        file,
        previewUrl: await readFileAsDataUrl(file),
        processedUrl: null,
        isProcessing: false,
        error: null,
      })),
    );
    setImages((prev) => [...prev, ...newImages]);
    setGlobalError(null);
  }, [images.length]);

  const removeImage = (id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  };

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setIsDragging(false);
      void addFiles(e.dataTransfer.files);
    },
    [addFiles],
  );

  const handleProcess = async () => {
    if (images.length < MIN_IMAGES) return;
    const prompt = buildPrompt(selectedSceneId);

    setIsProcessing(true);
    setGlobalError(null);
    setDoneCount(0);
    setImages((prev) =>
      prev.map((img) => ({ ...img, processedUrl: null, isProcessing: true, error: null })),
    );

    let processed = 0;
    for (const img of images) {
      try {
        const result = await generateVariant(img.previewUrl, prompt);
        setImages((prev) =>
          prev.map((i) => i.id === img.id ? { ...i, processedUrl: result, isProcessing: false } : i),
        );
      } catch (err) {
        const message = (err as { message?: string })?.message ?? 'Error procesando imagen.';
        setImages((prev) =>
          prev.map((i) => i.id === img.id ? { ...i, isProcessing: false, error: message } : i),
        );
      }
      processed++;
      setDoneCount(processed);
    }

    setIsProcessing(false);
  };

  const processedImages = images.filter((img) => img.processedUrl);
  const hasResults = processedImages.length > 0;
  const canProcess = images.length >= MIN_IMAGES && !isProcessing;
  const selectedScene = scenes.find((s) => s.id === selectedSceneId)!;

  const handleDownloadAll = () => {
    processedImages.forEach((img) => {
      downloadImage(img.processedUrl!, `optimized_${img.file.name}`);
    });
  };

  return (
    <div className="space-y-4">
      <section className="panel-surface space-y-5">
        <div>
          <h3 className="text-lg font-semibold text-white">Editor Batch</h3>
          <p className="mt-1 text-sm text-slate-400">
            Subí entre {MIN_IMAGES} y {MAX_IMAGES} imágenes, elegí una escena y procesalas con IA.
          </p>
        </div>

        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={handleDrop}
          onClick={() => !isProcessing && fileInputRef.current?.click()}
          className={`flex cursor-pointer flex-col items-center justify-center rounded-xl border-2 border-dashed py-10 transition-colors ${
            isDragging
              ? 'border-cyan-300/70 bg-cyan-300/5'
              : 'border-slate-700/70 hover:border-slate-600/80 hover:bg-slate-800/30'
          } ${isProcessing ? 'pointer-events-none opacity-50' : ''}`}
        >
          <ImagePlus className="mb-2 h-8 w-8 text-slate-500" />
          <p className="text-sm font-medium text-slate-300">
            {images.length === 0
              ? 'Arrastrá imágenes o hacé click para seleccionar'
              : `${images.length}/${MAX_IMAGES} imágenes — click para agregar más`}
          </p>
          <p className="mt-1 text-xs text-slate-500">
            PNG, JPG, WebP · mínimo {MIN_IMAGES}, máximo {MAX_IMAGES}
          </p>
        </div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          multiple
          className="hidden"
          onChange={(e) => e.target.files && void addFiles(e.target.files)}
        />

        {/* Thumbnails */}
        {images.length > 0 && (
          <div className="grid grid-cols-5 gap-2 sm:grid-cols-8 md:grid-cols-10">
            {images.map((img) => (
              <div key={img.id} className="group relative aspect-square">
                <img src={img.previewUrl} alt="preview" className="h-full w-full rounded-lg object-cover" />
                {!isProcessing && (
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeImage(img.id); }}
                    className="absolute -right-1 -top-1 hidden rounded-full bg-slate-900 p-0.5 text-slate-300 hover:text-white group-hover:flex"
                  >
                    <X className="h-3 w-3" />
                  </button>
                )}
                {img.isProcessing && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-slate-950/60">
                    <Loader2 className="h-5 w-5 animate-spin text-cyan-300" />
                  </div>
                )}
                {img.processedUrl && !img.isProcessing && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-green-500/20">
                    <CheckCircle className="h-5 w-5 text-green-400" />
                  </div>
                )}
                {img.error && !img.isProcessing && (
                  <div className="absolute inset-0 flex items-center justify-center rounded-lg bg-red-500/20">
                    <AlertCircle className="h-5 w-5 text-red-400" />
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Scene selector */}
        <div className="space-y-3">
          <p className="text-sm font-medium text-slate-300">Escena</p>

          {/* Dropdown */}
          <div className="relative">
            <select
              value={selectedSceneId}
              onChange={(e) => setSelectedSceneId(Number(e.target.value))}
              disabled={isProcessing}
              className="w-full appearance-none rounded-xl border border-slate-700/80 bg-slate-900/70 py-2.5 pl-4 pr-9 text-sm text-slate-100 outline-none transition-colors focus:border-cyan-300/70 disabled:cursor-not-allowed disabled:text-slate-500"
            >
              {scenes.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.id}. {s.title} — {s.stage}
                </option>
              ))}
            </select>
            <ChevronDown className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-400" />
          </div>

          {/* Scene preview card */}
          <div className="rounded-xl border border-slate-700/60 bg-slate-900/40 p-4 space-y-2">
            <div className="flex items-center gap-2">
              <span className={`rounded-md px-2 py-0.5 text-xs font-medium ${STAGE_COLORS[selectedScene.stage] ?? 'bg-slate-700 text-slate-300'}`}>
                {selectedScene.stage}
              </span>
              <span className="text-sm font-semibold text-white">{selectedScene.title}</span>
            </div>
            <p className="text-xs leading-relaxed text-slate-400">{selectedScene.scene}</p>
            <p className="text-xs text-slate-500"><span className="text-slate-400">Fondo:</span> {selectedScene.background}</p>
            <p className="text-xs text-slate-500"><span className="text-slate-400">Composición:</span> {selectedScene.designSpace}</p>
          </div>
        </div>

        {/* Process button */}
        <div className="flex items-center gap-4">
          <button
            type="button"
            onClick={() => void handleProcess()}
            disabled={!canProcess}
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-2.5 font-semibold text-slate-900 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {isProcessing ? (
              <><Loader2 className="h-4 w-4 animate-spin" />Procesando...</>
            ) : (
              <><Wand2 className="h-4 w-4" />Procesar imágenes</>
            )}
          </button>

          {isProcessing && (
            <span className="text-sm text-slate-400">{doneCount} / {images.length} completadas</span>
          )}
          {!isProcessing && images.length > 0 && images.length < MIN_IMAGES && (
            <span className="text-sm text-yellow-400">Necesitás al menos {MIN_IMAGES} imágenes.</span>
          )}
        </div>

        <AnimatePresence>
          {globalError && (
            <motion.div
              initial={{ opacity: 0, y: -8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -8 }}
              className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200"
            >
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p>{globalError}</p>
            </motion.div>
          )}
        </AnimatePresence>
      </section>

      {/* Results */}
      {hasResults && (
        <section className="panel-surface space-y-4">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium uppercase tracking-wider text-slate-400">
              Resultados — {processedImages.length} imagen{processedImages.length !== 1 ? 'es' : ''} procesada{processedImages.length !== 1 ? 's' : ''}
            </h3>
            <button
              type="button"
              onClick={handleDownloadAll}
              className="inline-flex items-center gap-2 rounded-xl border border-slate-700/80 px-4 py-2 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            >
              <Download className="h-4 w-4" />
              Descargar todas
            </button>
          </div>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 md:grid-cols-3">
            {processedImages.map((img, index) => (
              <motion.div
                key={img.id}
                initial={{ opacity: 0, scale: 0.96 }}
                animate={{ opacity: 1, scale: 1 }}
                transition={{ delay: index * 0.04 }}
                className="space-y-2 rounded-xl border border-slate-700/60 bg-slate-900/40 p-3"
              >
                <img src={img.processedUrl!} alt="processed" className="w-full rounded-lg object-contain" />
                <button
                  type="button"
                  onClick={() => downloadImage(img.processedUrl!, `optimized_${img.file.name}`)}
                  className="flex w-full items-center justify-center gap-1.5 rounded-lg border border-slate-700/70 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
                >
                  <Download className="h-3.5 w-3.5" />
                  Descargar
                </button>
              </motion.div>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
