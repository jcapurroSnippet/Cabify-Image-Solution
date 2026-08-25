import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertCircle, ArrowLeft, Loader2, Plus, RefreshCw } from 'lucide-react';
import RunStepper from './RunStepper';
import Step1Detect from './steps/Step1Detect';
import Step2Generate from './steps/Step2Generate';
import Step3InternalReview from './steps/Step3InternalReview';
import Step4AwaitClient from './steps/Step4AwaitClient';
import Step5Placement from './steps/Step5Placement';
import {
  createRun as createRunRequest,
  detectRunTargets,
  fetchRun,
  fetchRuns,
  markRunSent as markRunSentRequest,
  streamRunGeneration,
  submitRunForReview,
  syncRunFromReview,
} from './services/runApi';
import type { CreateRunInput, CreativeRun, RunGenerationEvent, RunTarget } from './types';
import { RUN_STATUS_LABELS, RUN_STATUS_STEP, formatDateTime, getErrorMessage } from './constants';
import { DEFAULT_CREATIVE_REVIEW_SHEETS_URL } from '../creative-review/constants';

interface RunFunnelTabProps {
  isActive: boolean;
}

const STATUS_BADGE_STYLES: Record<string, string> = {
  completed: 'border-green-500/30 bg-green-500/10 text-green-200',
  failed: 'border-red-500/30 bg-red-500/10 text-red-200',
  awaiting_client: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
  client_review: 'border-cyan-200/30 bg-cyan-300/10 text-cyan-100',
};

export default function RunFunnelTab({ isActive }: RunFunnelTabProps) {
  const [runs, setRuns] = useState<CreativeRun[]>([]);
  const [activeRun, setActiveRun] = useState<CreativeRun | null>(null);
  const [targets, setTargets] = useState<RunTarget[]>([]);
  const [events, setEvents] = useState<RunGenerationEvent[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [isGenerating, setIsGenerating] = useState(false);
  const [isSyncing, setIsSyncing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hasLoadedOnce, setHasLoadedOnce] = useState(false);
  // Guards the auto-advance effect so a run is never driven twice at once.
  const advancingRunId = useRef<string | null>(null);

  const sheetsUrl = DEFAULT_CREATIVE_REVIEW_SHEETS_URL;

  const loadRuns = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    try {
      setRuns(await fetchRuns(sheetsUrl));
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setIsLoading(false);
      setHasLoadedOnce(true);
    }
  }, [sheetsUrl]);

  useEffect(() => {
    if (isActive && !hasLoadedOnce) void loadRuns();
  }, [isActive, hasLoadedOnce, loadRuns]);

  const openRun = useCallback(async (runId: string) => {
    setIsBusy(true);
    setError(null);
    try {
      const detail = await fetchRun(runId, sheetsUrl);
      setActiveRun(detail.run);
      setTargets(detail.targets);
    } catch (openError) {
      setError(getErrorMessage(openError));
    } finally {
      setIsBusy(false);
    }
  }, [sheetsUrl]);

  const refreshActiveRun = useCallback(async (runId: string) => {
    const detail = await fetchRun(runId, sheetsUrl);
    setActiveRun(detail.run);
    setTargets(detail.targets);
    return detail;
  }, [sheetsUrl]);

  const runGeneration = useCallback(async (runId: string) => {
    setIsGenerating(true);
    setEvents([]);
    try {
      await streamRunGeneration(runId, sheetsUrl, (event) => {
        setEvents((current) => [...current.slice(-40), event]);
        if (event.state === 'error') setError(event.error || 'La generación falló.');
        if (event.run) setActiveRun(event.run);
        if (event.targets) setTargets(event.targets);
      });
      await refreshActiveRun(runId);
    } catch (generationError) {
      setError(getErrorMessage(generationError));
    } finally {
      setIsGenerating(false);
    }
  }, [sheetsUrl, refreshActiveRun]);

  /**
   * Steps 1 and 2 chain without asking: once a run exists, detection runs and
   * generation follows immediately. The funnel only stops at the approval gates.
   */
  useEffect(() => {
    if (!activeRun || isGenerating || isBusy) return;
    if (advancingRunId.current === `${activeRun.id}:${activeRun.status}`) return;

    const drive = async () => {
      advancingRunId.current = `${activeRun.id}:${activeRun.status}`;
      try {
        if (activeRun.status === 'draft') {
          setIsBusy(true);
          const detected = await detectRunTargets(activeRun.id, sheetsUrl);
          setActiveRun(detected.run);
          setTargets(detected.targets);
          setIsBusy(false);
          return;
        }
        if (activeRun.status === 'detecting' || activeRun.status === 'generating') {
          if (targets.length === 0) return;
          await runGeneration(activeRun.id);
        }
      } catch (driveError) {
        setError(getErrorMessage(driveError));
        setIsBusy(false);
      }
    };

    void drive();
  }, [activeRun, targets.length, isGenerating, isBusy, sheetsUrl, runGeneration]);

  const handleCreateRun = async (input: Omit<CreateRunInput, 'sheetsUrl'>) => {
    setIsBusy(true);
    setError(null);
    try {
      const created = await createRunRequest({ ...input, sheetsUrl });
      setRuns((current) => [created, ...current]);
      setActiveRun(created);
      setTargets([]);
      setEvents([]);
    } finally {
      setIsBusy(false);
    }
  };

  const handleSubmitForClientReview = async () => {
    if (!activeRun) return;
    const response = await submitRunForReview(activeRun.id, sheetsUrl);
    setActiveRun(response.run);
  };

  const handleMarkSent = async () => {
    if (!activeRun) return;
    const response = await markRunSentRequest(activeRun.id, sheetsUrl);
    setActiveRun(response.run);
  };

  const handleSync = async () => {
    if (!activeRun) return;
    setIsSyncing(true);
    setError(null);
    try {
      const response = await syncRunFromReview(activeRun.id, sheetsUrl);
      setActiveRun(response.run);
      setTargets(response.targets);
      if (response.reviewStatus !== 'published' && response.summary.approved === 0) {
        setError('Cabify todavía no terminó de aprobar la tanda.');
      }
    } catch (syncError) {
      setError(getErrorMessage(syncError));
    } finally {
      setIsSyncing(false);
    }
  };

  const closeRun = () => {
    setActiveRun(null);
    setTargets([]);
    setEvents([]);
    advancingRunId.current = null;
    void loadRuns();
  };

  // ── Run list ──────────────────────────────────────────────────────────────
  if (!activeRun) {
    return (
      <div className="space-y-4">
        <Step1Detect run={null} targets={[]} isBusy={isBusy} onCreateRun={handleCreateRun} />

        <section className="panel-surface space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-medium uppercase tracking-wider text-slate-400">Ciclos</h3>
            <button
              type="button"
              onClick={() => void loadRuns()}
              disabled={isLoading}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700/80 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white disabled:opacity-50"
            >
              {isLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              Actualizar
            </button>
          </div>

          {error && (
            <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
              <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
              <p className="whitespace-pre-wrap">{error}</p>
            </div>
          )}

          {runs.length === 0 && !isLoading && (
            <p className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-4 text-sm text-slate-400">
              Todavía no hay ciclos. Creá el primero arriba.
            </p>
          )}

          <div className="space-y-2">
            {runs.map((run) => (
              <button
                key={run.id}
                type="button"
                onClick={() => void openRun(run.id)}
                className="flex w-full flex-wrap items-center gap-3 rounded-xl border border-slate-700/70 bg-slate-900/40 p-3 text-left transition-colors hover:border-slate-500"
              >
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-white">{run.title}</p>
                  <p className="truncate text-xs text-slate-500">
                    {run.platform === 'meta' ? 'Meta Ads' : 'Google Ads'} · {run.category}
                    {run.createdAt && ` · ${formatDateTime(run.createdAt)}`}
                  </p>
                </div>
                <span className="text-xs text-slate-400">
                  Paso {RUN_STATUS_STEP[run.status] || '—'} de 5
                </span>
                <span className={`rounded-full border px-3 py-1 text-xs ${
                  STATUS_BADGE_STYLES[run.status] || 'border-slate-600/60 bg-slate-900/60 text-slate-300'
                }`}>
                  {RUN_STATUS_LABELS[run.status]}
                </span>
              </button>
            ))}
          </div>
        </section>
      </div>
    );
  }

  // ── Active run ────────────────────────────────────────────────────────────
  const currentStep = RUN_STATUS_STEP[activeRun.status] || 1;
  const busyStep = isGenerating ? 2 : isBusy ? currentStep : null;

  return (
    <div className="space-y-4">
      <section className="panel-surface space-y-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <button
              type="button"
              onClick={closeRun}
              className="mb-2 inline-flex items-center gap-1.5 text-xs text-slate-400 transition-colors hover:text-white"
            >
              <ArrowLeft className="h-3.5 w-3.5" />
              Todos los ciclos
            </button>
            <h2 className="truncate text-xl font-semibold text-white">{activeRun.title}</h2>
            <p className="mt-1 text-sm text-slate-400">
              {activeRun.platform === 'meta' ? 'Meta Ads' : 'Google Ads'} · {activeRun.category}
              {activeRun.plazas.length > 0 && ` · ${activeRun.plazas.join(', ')}`}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <span className={`rounded-full border px-3 py-1 text-xs ${
              STATUS_BADGE_STYLES[activeRun.status] || 'border-slate-600/60 bg-slate-900/60 text-slate-300'
            }`}>
              {RUN_STATUS_LABELS[activeRun.status]}
            </span>
            <button
              type="button"
              onClick={() => void refreshActiveRun(activeRun.id)}
              className="inline-flex items-center gap-2 rounded-lg border border-slate-700/80 px-3 py-1.5 text-xs text-slate-300 transition-colors hover:border-slate-500 hover:text-white"
            >
              <RefreshCw className="h-3.5 w-3.5" />
              Actualizar
            </button>
          </div>
        </div>

        <RunStepper currentStep={currentStep} busyStep={busyStep} failed={activeRun.status === 'failed'} />
      </section>

      {(error || activeRun.error) && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="whitespace-pre-wrap">{error || activeRun.error}</p>
        </div>
      )}

      {currentStep === 1 && (
        <Step1Detect run={activeRun} targets={targets} isBusy={isBusy} onCreateRun={handleCreateRun} />
      )}

      {currentStep === 2 && (
        <Step2Generate run={activeRun} targets={targets} isGenerating={isGenerating} events={events} />
      )}

      {activeRun.status === 'internal_review' && (
        <Step3InternalReview run={activeRun} onSubmitForClientReview={handleSubmitForClientReview} />
      )}

      {(activeRun.status === 'awaiting_client' || activeRun.status === 'client_review') && (
        <Step4AwaitClient
          run={activeRun}
          onMarkSent={handleMarkSent}
          onSync={handleSync}
          isSyncing={isSyncing}
        />
      )}

      {(activeRun.status === 'placement' || activeRun.status === 'completed') && (
        <Step5Placement run={activeRun} onRunUpdated={setActiveRun} />
      )}

      {activeRun.status === 'failed' && (
        <section className="panel-surface space-y-3">
          <h3 className="text-lg font-semibold text-white">El ciclo se detuvo</h3>
          <p className="text-sm text-slate-400">{activeRun.error || 'Ocurrió un error durante el ciclo.'}</p>
          <button
            type="button"
            onClick={() => void runGeneration(activeRun.id)}
            className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-2.5 font-semibold text-slate-900 transition-colors hover:bg-cyan-200"
          >
            <Plus className="h-4 w-4" />
            Reintentar generación
          </button>
        </section>
      )}
    </div>
  );
}
