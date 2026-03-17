import React, { useState, useCallback, useEffect } from 'react';
import {
  AlertCircle,
  Download,
  Eraser,
  ImagePlus,
  Loader2,
  Ratio,
  Link as LinkIcon,
  CheckCircle,
  AlertTriangle,
  Clock,
} from 'lucide-react';
import { generateAspectRatioImages } from '../../lib/api';
import {
  AspectRatio,
  AspectRatioState,
  GeneratedImage,
  BatchState,
  BatchProgressEvent,
  BatchResult,
} from './types';
import {
  startBatchProcessing,
  fetchBatchStatus,
  isValidSheetsUrl,
  isValidDriveFolderUrl,
  getProgressPercentage,
} from './services/batchService';

const INITIAL_STATE: AspectRatioState = {
  originalImage: null,
  isProcessing: false,
  results: [],
  error: null,
};

const HARDCODED_DRIVE_FOLDER = 'https://drive.google.com/drive/u/0/folders/1gWY-ZEMbWBcM_lwSKzc5HD89Pa_SiBWO';

const INITIAL_BATCH_STATE: BatchState = {
  sheetsUrl: '',
  driveFolderUrl: HARDCODED_DRIVE_FOLDER,
  isProcessing: false,
  progress: {
    totalRows: 0,
    processedRows: 0,
    currentRowNumber: 0,
    currentStatus: 'reading-sheet' as const,
  },
  results: {},
  error: null,
};

const SUPPORTED_RATIOS: AspectRatio[] = [AspectRatio.RATIO_1_1, AspectRatio.RATIO_9_16];
const BATCH_STATUS_POLL_MS = 15000;

const getAspectClass = (ratio: AspectRatio): string => {
  if (ratio === AspectRatio.RATIO_9_16) {
    return 'aspect-[9/16]';
  }

  if (ratio === AspectRatio.RATIO_16_9) {
    return 'aspect-video';
  }

  return 'aspect-square';
};

type Mode = 'single' | 'batch';

export default function AspectRatioTab() {
  const [mode, setMode] = useState<Mode>('single');
  const [state, setState] = useState<AspectRatioState>(INITIAL_STATE);
  const [batchState, setBatchState] = useState<BatchState>(INITIAL_BATCH_STATE);
  const [activeRatio, setActiveRatio] = useState<AspectRatio | null>(null);

  useEffect(() => {
    if (!batchState.isProcessing || !batchState.sheetsUrl.trim()) {
      return;
    }

    let isActive = true;

    const pollStatus = async () => {
      try {
        const snapshot = await fetchBatchStatus(batchState.sheetsUrl);
        if (!isActive) return;

        setBatchState((previous) => {
          const results = { ...previous.results };
          const snapshotRows = snapshot.rows || {};

          Object.entries(snapshotRows).forEach(([rowNumber, rowStatus]) => {
            const numericRow = Number(rowNumber);
            if (!Number.isFinite(numericRow)) return;

            results[numericRow] = {
              ...results[numericRow],
              status: rowStatus.status,
              ...(rowStatus.links && { links: rowStatus.links }),
            };
          });

          const totalRows = snapshot.totalRows || previous.progress.totalRows;
          const completedRows = snapshot.completedRows ?? previous.progress.processedRows;
          const processedRows = Math.max(previous.progress.processedRows, completedRows);
          const isDone = totalRows > 0 && completedRows >= totalRows;

          return {
            ...previous,
            isProcessing: isDone ? false : previous.isProcessing,
            progress: {
              ...previous.progress,
              totalRows,
              processedRows,
              currentRowNumber: Math.max(previous.progress.currentRowNumber, processedRows),
              currentStatus: isDone ? 'completed' : previous.progress.currentStatus,
            },
            results,
          };
        });
      } catch (error) {
        console.warn('Batch status polling error:', error);
      }
    };

    pollStatus();
    const intervalId = setInterval(pollStatus, BATCH_STATUS_POLL_MS);

    return () => {
      isActive = false;
      clearInterval(intervalId);
    };
  }, [batchState.isProcessing, batchState.sheetsUrl]);

  // ==================== Single Mode Handlers ====================
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

  // ==================== Batch Mode Handlers ====================
  const handleBatchInputChange = (field: 'sheetsUrl' | 'driveFolderUrl', value: string) => {
    setBatchState((previous) => ({
      ...previous,
      [field]: value,
    }));
  };

  const validateBatchInputs = (): boolean => {
    if (!batchState.sheetsUrl.trim()) {
      setBatchState((p) => ({ ...p, error: 'Please enter a Google Sheets URL.' }));
      return false;
    }

    if (!isValidSheetsUrl(batchState.sheetsUrl)) {
      setBatchState((p) => ({ ...p, error: 'Invalid Google Sheets URL format.' }));
      return false;
    }

    return true;
  };

  const handleStartBatch = async () => {
    if (!validateBatchInputs()) {
      return;
    }

    setBatchState((previous) => ({
      ...previous,
      isProcessing: true,
      error: null,
      results: {},
      progress: {
        totalRows: 0,
        processedRows: 0,
        currentRowNumber: 0,
        currentStatus: 'reading-sheet',
      },
    }));

    await startBatchProcessing(
      batchState.sheetsUrl,
      (event: BatchProgressEvent) => {
        setBatchState((previous) => {
          const progress = { ...previous.progress };
          const results = { ...previous.results };

          // Update overall progress
          if (event.totalRows !== undefined) {
            progress.totalRows = event.totalRows;
          }

          if (event.currentRow !== undefined) {
            progress.processedRows = event.currentRow;
          }

          if (event.rowNumber) {
            progress.currentRowNumber = event.rowNumber;
          }

          if (event.status) {
            progress.currentStatus = event.status;
          } else if (event.state === 'updating-sheet') {
            progress.currentStatus = 'updating-sheet';
          } else if (event.state === 'reading-sheet') {
            progress.currentStatus = 'reading-sheet';
          }

          // Update individual row results
          if (event.rowNumber) {
            results[event.rowNumber] = {
              status: event.status || 'downloading',
              ...(event.links && { links: event.links }),
              ...(event.error && { error: event.error }),
            };
          }

          return {
            ...previous,
            progress,
            results,
          };
        });
      },
      (result: BatchResult) => {
        setBatchState((previous) => {
          const totalRows = result.totalRows ?? previous.progress.totalRows;
          const processedRows =
            result.processedRows ?? result.totalRows ?? previous.progress.processedRows;

          return {
            ...previous,
            isProcessing: false,
            progress: {
              ...previous.progress,
              totalRows,
              processedRows,
              currentRowNumber: Math.max(previous.progress.currentRowNumber, processedRows || 0),
              currentStatus: 'completed',
            },
          };
        });
      },
      (error: string) => {
        setBatchState((previous) => ({
          ...previous,
          isProcessing: false,
          error,
        }));
      }
    );
  };

  const getStatusIcon = (status: string) => {
    switch (status) {
      case 'completed':
        return <CheckCircle className="h-4 w-4 text-green-400" />;
      case 'error':
        return <AlertTriangle className="h-4 w-4 text-red-400" />;
      case 'skipped':
        return <Clock className="h-4 w-4 text-slate-400" />;
      default:
        return <Loader2 className="h-4 w-4 animate-spin text-cyan-400" />;
    }
  };

  const getStatusColor = (status: string): string => {
    switch (status) {
      case 'completed':
        return 'bg-green-500/10 text-green-200';
      case 'error':
        return 'bg-red-500/10 text-red-200';
      case 'skipped':
        return 'bg-slate-500/10 text-slate-300';
      default:
        return 'bg-cyan-500/10 text-cyan-200';
    }
  };

  // ==================== Render ====================
  if (mode === 'batch') {
    return (
      <div className="space-y-6">
        {/* Mode Selector */}
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setMode('single')}
            className="rounded-lg border border-slate-700/80 bg-slate-900/60 px-4 py-2 text-sm text-slate-200 transition-colors hover:border-slate-500"
          >
            Single Image
          </button>
          <button
            type="button"
            onClick={() => setMode('batch')}
            className="rounded-lg border border-cyan-300/90 bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-900"
          >
            Batch from Sheets
          </button>
        </div>

        {/* Batch Input Section */}
        <div className="panel-surface space-y-4">
          <h3 className="text-lg font-semibold text-white">Batch Processing</h3>

          <div className="space-y-3">
            <div>
              <label className="block text-sm font-medium text-slate-300 mb-2">
                Google Sheets URL
              </label>
              <input
                type="text"
                placeholder="https://docs.google.com/spreadsheets/d/..."
                value={batchState.sheetsUrl}
                onChange={(e) => handleBatchInputChange('sheetsUrl', e.target.value)}
                disabled={batchState.isProcessing}
                className="w-full rounded-lg border border-slate-700/80 bg-slate-900/60 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 transition-colors hover:border-slate-500 focus:border-cyan-400 focus:outline-none disabled:opacity-50"
              />
            </div>



            {batchState.error && (
              <div className="flex items-start gap-2 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
                <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
                <p>{batchState.error}</p>
              </div>
            )}

            <button
              type="button"
              onClick={handleStartBatch}
              disabled={
                batchState.isProcessing ||
                !batchState.sheetsUrl.trim()
              }
              className={`w-full rounded-lg px-4 py-2 font-semibold text-sm transition-colors ${
                batchState.isProcessing
                  ? 'bg-slate-700/60 text-slate-400 cursor-not-allowed'
                  : 'bg-cyan-500 text-slate-900 hover:bg-cyan-400'
              }`}
            >
              {batchState.isProcessing ? (
                <>
                  <Loader2 className="inline h-4 w-4 animate-spin mr-2" />
                  Processing...
                </>
              ) : (
                'Start Batch Processing'
              )}
            </button>
          </div>
        </div>

        {/* Progress Section */}
        {(batchState.isProcessing ||
          batchState.progress.totalRows > 0 ||
          batchState.progress.processedRows > 0 ||
          Object.keys(batchState.results).length > 0) && (
          <div className="panel-surface space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold text-white">Progress</h3>
              {!batchState.isProcessing && (
                <span className="text-xs text-slate-400">
                  {batchState.progress.processedRows}/{batchState.progress.totalRows} rows
                </span>
              )}
            </div>

            {/* Progress Bar */}
            {batchState.progress.totalRows > 0 && (
              <div className="space-y-2">
                <div className="h-2 w-full rounded-full bg-slate-700/40 overflow-hidden">
                  <div
                    className="h-full bg-gradient-to-r from-cyan-500 to-cyan-400 transition-all duration-300"
                    style={{
                      width: `${getProgressPercentage(
                        batchState.progress.processedRows,
                        batchState.progress.totalRows
                      )}%`,
                    }}
                  />
                </div>
                <p className="text-xs text-slate-400">
                  {getProgressPercentage(
                    batchState.progress.processedRows,
                    batchState.progress.totalRows
                  )}% complete
                </p>
              </div>
            )}

            {/* Results Table */}
            {Object.keys(batchState.results).length > 0 && (
              <div className="max-h-96 overflow-y-auto rounded-lg border border-slate-700/50 bg-slate-900/20">
                <table className="w-full text-sm">
                  <thead className="sticky top-0 bg-slate-900/60">
                    <tr className="border-b border-slate-700/50">
                      <th className="px-4 py-2 text-left text-slate-300 font-medium">Row</th>
                      <th className="px-4 py-2 text-left text-slate-300 font-medium">Status</th>
                      <th className="px-4 py-2 text-left text-slate-300 font-medium">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {Object.entries(batchState.results).map(([rowNumber, result]) => {
                      const typedResult = result as typeof batchState.results[keyof typeof batchState.results];
                      return (
                      <tr
                        key={rowNumber}
                        className="border-b border-slate-700/30 hover:bg-slate-800/20"
                      >
                        <td className="px-4 py-2 text-slate-300">Row {rowNumber}</td>
                        <td className="px-4 py-2">
                          <div className="flex items-center gap-2">
                            {getStatusIcon(typedResult.status)}
                            <span className={`px-2 py-1 rounded text-xs font-medium ${getStatusColor(typedResult.status)}`}>
                              {typedResult.status}
                            </span>
                          </div>
                        </td>
                        <td className="px-4 py-2 text-slate-400">
                          {typedResult.error ? (
                            <span className="text-red-300">{typedResult.error}</span>
                          ) : typedResult.links ? (
                            <div className="flex gap-1">
                              <span className="text-green-300">✓</span>
                              <span className="text-slate-300">
                                {typedResult.links['1:1'].length + typedResult.links['9:16'].length} images uploaded
                              </span>
                            </div>
                          ) : (
                            <span className="text-slate-500">-</span>
                          )}
                        </td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
    );
  }

  // ==================== Single Mode ====================

  return (
    <div className="space-y-6">
      {/* Mode Selector */}
      <div className="flex gap-2">
        <button
          type="button"
          onClick={() => setMode('single')}
          className="rounded-lg border border-cyan-300/90 bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-900"
        >
          Single Image
        </button>
        <button
          type="button"
          onClick={() => setMode('batch')}
          className="rounded-lg border border-slate-700/80 bg-slate-900/60 px-4 py-2 text-sm text-slate-200 transition-colors hover:border-slate-500"
        >
          Batch from Sheets
        </button>
      </div>

      {/* Single Mode Content */}
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
    </div>
  );
}
