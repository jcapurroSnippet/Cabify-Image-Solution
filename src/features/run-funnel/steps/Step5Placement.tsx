import { useState } from 'react';
import { AlertCircle, CheckCircle2, ListChecks, Loader2, Rocket } from 'lucide-react';
import { buildRunPlan, executeRunPlacement } from '../services/runApi';
import type { LowPerformerCategories } from '../../creative-library/services/creativeLibraryApi';
import type { ReplacementOperation } from '../../creative-library/types';
import type { CreativeRun } from '../types';
import { CATEGORY_OPTIONS, getErrorMessage } from '../constants';

interface Step5PlacementProps {
  run: CreativeRun;
  onRunUpdated: (run: CreativeRun) => void;
}

const getPreviewSrc = (url?: string) => {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('/api/')) return url;
  return `/api/image-preview?url=${encodeURIComponent(url)}`;
};

/**
 * Step 5 — "elijo dónde van". The plan is pre-built from each creative's
 * detected category, so the common path is one click; the category dropdown is
 * there for the cases where the automatic match got it wrong.
 */
export default function Step5Placement({ run, onRunUpdated }: Step5PlacementProps) {
  const [operations, setOperations] = useState<ReplacementOperation[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [categories, setCategories] = useState<LowPerformerCategories>({});
  const [isPlanning, setIsPlanning] = useState(false);
  const [isExecuting, setIsExecuting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<string | null>(null);

  const loadPlan = async () => {
    setIsPlanning(true);
    setError(null);
    setResult(null);
    try {
      const plan = await buildRunPlan(run.id, run.sheetsUrl, categories);
      setOperations(plan.operations || []);
      setSelectedIds(
        (plan.operations || [])
          .filter((operation) => operation.status === 'planned' && operation.executableInMode !== false)
          .map((operation) => operation.id),
      );
      if (plan.run) onRunUpdated(plan.run);
    } catch (planError) {
      setError(getErrorMessage(planError));
    } finally {
      setIsPlanning(false);
    }
  };

  const execute = async () => {
    if (selectedIds.length === 0) return;
    if (!window.confirm(
      `Vas a reemplazar ${selectedIds.length} creativo${selectedIds.length !== 1 ? 's' : ''} en cuentas reales. ¿Confirmás?`,
    )) return;

    setIsExecuting(true);
    setError(null);
    try {
      const execution = await executeRunPlacement(run.id, run.sheetsUrl, selectedIds, categories);
      const succeeded = (execution.results || []).filter(
        (operation) => (operation.executionStatus || operation.status) === 'success',
      ).length;
      setResult(`${succeeded} de ${selectedIds.length} reemplazos ejecutados.`);
      setOperations(execution.results || []);
      if (execution.run) onRunUpdated(execution.run);
    } catch (executeError) {
      setError(getErrorMessage(executeError));
    } finally {
      setIsExecuting(false);
    }
  };

  const toggle = (id: string) => {
    setSelectedIds((current) =>
      current.includes(id) ? current.filter((value) => value !== id) : [...current, id],
    );
  };

  return (
    <section className="panel-surface space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-white">Paso 5 · Dónde van</h3>
          <p className="mt-1 max-w-2xl text-sm text-slate-400">
            El sistema propone un destino por creativo según la categoría detectada.
            Revisá, ajustá lo que haga falta y ejecutá.
          </p>
        </div>
        <button
          type="button"
          onClick={() => void loadPlan()}
          disabled={isPlanning || isExecuting}
          className="inline-flex items-center gap-2 rounded-xl border border-slate-700/80 px-4 py-2.5 text-sm text-slate-300 transition-colors hover:border-slate-500 hover:text-white disabled:opacity-50"
        >
          {isPlanning ? <Loader2 className="h-4 w-4 animate-spin" /> : <ListChecks className="h-4 w-4" />}
          {operations.length === 0 ? 'Armar plan' : 'Recalcular plan'}
        </button>
      </div>

      {operations.length === 0 && !isPlanning && (
        <p className="rounded-xl border border-slate-700/70 bg-slate-900/40 p-4 text-sm text-slate-400">
          Armá el plan para ver qué pieza aprobada reemplaza a cada low performer.
        </p>
      )}

      {operations.length > 0 && (
        <div className="space-y-2">
          {operations.map((operation) => {
            const isSelectable = operation.status === 'planned' && operation.executableInMode !== false;
            const executionStatus = operation.executionStatus || '';
            return (
              <div
                key={operation.id}
                className={`flex flex-wrap items-center gap-3 rounded-xl border p-3 ${
                  executionStatus === 'success'
                    ? 'border-green-500/30 bg-green-500/5'
                    : isSelectable
                      ? 'border-slate-700/70 bg-slate-900/40'
                      : 'border-slate-800/80 bg-slate-900/25 opacity-70'
                }`}
              >
                <input
                  type="checkbox"
                  checked={selectedIds.includes(operation.id)}
                  onChange={() => toggle(operation.id)}
                  disabled={!isSelectable || isExecuting}
                  className="h-4 w-4 shrink-0 accent-cyan-300"
                />

                <div className="flex shrink-0 items-center gap-2">
                  {operation.oldAssetPreviewUrl || operation.oldAssetUrl ? (
                    <img
                      src={getPreviewSrc(operation.oldAssetPreviewUrl || operation.oldAssetUrl)}
                      alt="Creativo actual"
                      className="h-12 w-12 rounded-lg object-cover opacity-60"
                    />
                  ) : null}
                  <span className="text-slate-600">→</span>
                  {operation.creative?.drive_url ? (
                    <img
                      src={getPreviewSrc(operation.creative.drive_url)}
                      alt="Creativo nuevo"
                      className="h-12 w-12 rounded-lg object-cover"
                    />
                  ) : (
                    <div className="flex h-12 w-12 items-center justify-center rounded-lg bg-slate-800/80 text-xs text-slate-500">
                      —
                    </div>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-slate-200">{operation.campaignName || '—'}</p>
                  <p className="truncate text-xs text-slate-500">
                    {operation.adGroupName || operation.assetGroupName || '—'}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-slate-400">
                    {executionStatus ? (operation.executionMessage || executionStatus) : operation.message}
                  </p>
                </div>

                <label className="shrink-0 text-xs text-slate-400">
                  Categoría
                  <select
                    value={categories[operation.id] ?? operation.detectedCategory ?? ''}
                    onChange={(event) =>
                      setCategories((current) => ({ ...current, [operation.id]: event.target.value }))}
                    disabled={isExecuting}
                    className="ml-2 rounded-lg border border-slate-700/80 bg-slate-900/70 px-2 py-1 text-xs text-slate-200 outline-none focus:border-cyan-300/70"
                  >
                    <option value="">Automática</option>
                    {CATEGORY_OPTIONS.map((category) => (
                      <option key={category} value={category}>{category}</option>
                    ))}
                  </select>
                </label>

                {executionStatus === 'success' && (
                  <CheckCircle2 className="h-5 w-5 shrink-0 text-green-400" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <p className="whitespace-pre-wrap">{error}</p>
        </div>
      )}

      {result && (
        <div className="flex items-start gap-2 rounded-xl border border-green-500/30 bg-green-500/10 p-3 text-sm text-green-200">
          <CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" />
          <p>{result}</p>
        </div>
      )}

      {operations.length > 0 && (
        <button
          type="button"
          onClick={() => void execute()}
          disabled={selectedIds.length === 0 || isExecuting || isPlanning}
          className="inline-flex items-center gap-2 rounded-xl bg-cyan-300 px-5 py-2.5 font-semibold text-slate-900 transition-colors hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
        >
          {isExecuting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Rocket className="h-4 w-4" />}
          Ejecutar {selectedIds.length > 0 ? `(${selectedIds.length})` : ''}
        </button>
      )}
    </section>
  );
}
