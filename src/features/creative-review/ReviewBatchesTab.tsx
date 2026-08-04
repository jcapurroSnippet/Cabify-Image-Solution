import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AlertCircle,
  Check,
  Clipboard,
  Eye,
  ExternalLink,
  FileInput,
  Link2,
  Loader2,
  RefreshCw,
  RotateCcw,
  ShieldOff,
} from 'lucide-react';
import {
  createReviewBatch,
  fetchReviewBatches,
  importLegacyReviewBatch,
  retryReviewBatchPublication,
  revokeReviewBatch,
  sendReviewBatch,
} from './services/creativeReviewApi';
import {
  DEFAULT_CREATIVE_REVIEW_SHEETS_URL,
  DEFAULT_CREATIVE_REVIEW_SOURCE_TAB,
  DEFAULT_CREATIVE_REVIEW_TITLE,
} from './constants';
import CreativeReviewPortal from './CreativeReviewPortal';
import type {
  CreativeReviewBatch,
  ImportLegacyReviewResponse,
  ReviewBatchStatus,
  ReviewSourceType,
} from './types';

type BatchAction = 'open' | 'revoke' | 'retry';

interface ReviewBatchesTabProps {
  isActive?: boolean;
}

const STATUS_LABELS: Record<ReviewBatchStatus, string> = {
  draft: 'Borrador',
  in_review: 'En revisión',
  publishing: 'Publicando',
  published: 'Publicada',
  publish_failed: 'Publicación con errores',
  revoked: 'Revocada',
};

const STATUS_STYLES: Record<ReviewBatchStatus, string> = {
  draft: 'border-slate-500/60 bg-slate-900/35 text-slate-200',
  in_review: 'border-cyan-200/40 bg-cyan-300/10 text-cyan-100',
  publishing: 'border-amber-500/40 bg-amber-500/10 text-amber-100',
  published: 'border-green-300/40 bg-green-400/10 text-green-100',
  publish_failed: 'border-red-500/30 bg-red-500/10 text-red-200',
  revoked: 'border-red-500/30 bg-red-500/10 text-red-200',
};

const SOURCE_LABELS: Record<ReviewSourceType, string> = {
  editor_batch: 'Editor Batch',
  batch_sheets: 'Batch from Sheets',
  legacy: 'Migración legacy',
};

const formatDate = (value?: string) => {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-AR', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(date);
};

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Ocurrió un error inesperado.';

const toAbsoluteUrl = (value: string) => {
  try {
    return new URL(value, window.location.origin).toString();
  } catch {
    return value;
  }
};

const getQueryParam = (name: string) =>
  new URLSearchParams(window.location.search).get(name)?.trim() || '';

export default function ReviewBatchesTab({ isActive = true }: ReviewBatchesTabProps) {
  const linkedBatchId = useMemo(() => new URLSearchParams(window.location.search).get('batchId') || '', []);
  const [sheetsUrl, setSheetsUrl] = useState(() =>
    getQueryParam('sheetsUrl') || DEFAULT_CREATIVE_REVIEW_SHEETS_URL);
  const [sourceTab, setSourceTab] = useState(() =>
    getQueryParam('sheetName') || DEFAULT_CREATIVE_REVIEW_SOURCE_TAB);
  const [importTitle, setImportTitle] = useState(DEFAULT_CREATIVE_REVIEW_TITLE);
  const [title, setTitle] = useState('');
  const [sourceType, setSourceType] = useState<Exclude<ReviewSourceType, 'legacy'>>('editor_batch');
  const [category, setCategory] = useState('');
  const [plaza, setPlaza] = useState('');
  const [batches, setBatches] = useState<CreativeReviewBatch[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isImporting, setIsImporting] = useState(false);
  const [isCreating, setIsCreating] = useState(false);
  const [busyBatch, setBusyBatch] = useState<{ id: string; action: BatchAction } | null>(null);
  const [copiedBatchId, setCopiedBatchId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [lastImport, setLastImport] = useState<ImportLegacyReviewResponse | null>(null);
  const [activeBatchId, setActiveBatchId] = useState(linkedBatchId);
  const [isBootstrapping, setIsBootstrapping] = useState(false);
  const [bootstrapError, setBootstrapError] = useState<string | null>(null);
  const wasActiveRef = useRef(false);
  const bootstrapPromiseRef = useRef<Promise<void> | null>(null);
  const autoImportAttemptsRef = useRef<Set<string>>(new Set());

  const canCreate = useMemo(
    () => Boolean(sheetsUrl.trim() && title.trim() && category.trim() && plaza.trim()),
    [category, plaza, sheetsUrl, title],
  );
  const canImport = Boolean(sheetsUrl.trim() && sourceTab.trim());
  const importedBatch = lastImport
    ? batches.find((batch) => batch.id === lastImport.batch.id) || lastImport.batch
    : null;

  const activeBatch = batches.find((batch) => batch.id === activeBatchId) || null;

  const loadBatches = async () => {
    if (!sheetsUrl.trim()) {
      setError('Ingresá la URL del Google Sheet para buscar sus tandas.');
      return;
    }
    setIsLoading(true);
    setError(null);
    setNotice(null);
    try {
      await bootstrapWorkspace();
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setIsLoading(false);
    }
  };

  const upsertBatch = (batch: CreativeReviewBatch) => {
    setBatches((current) => [batch, ...current.filter((item) => item.id !== batch.id)]);
  };

  const prepareBatchForReview = async (batch: CreativeReviewBatch): Promise<CreativeReviewBatch> => {
    if (batch.status !== 'draft') return batch;
    const response = await sendReviewBatch(batch.id, batch.sheetsUrl || sheetsUrl.trim());
    return {
      ...batch,
      ...response.batch,
      id: batch.id,
      status: response.batch?.status || 'in_review',
      privateUrl: response.privateUrl || response.batch?.privateUrl || batch.privateUrl,
      summary: response.batch?.summary || batch.summary,
    };
  };

  const selectDefaultBatch = (available: CreativeReviewBatch[]) => {
    if (linkedBatchId) return available.find((batch) => batch.id === linkedBatchId) || null;
    const usable = available.filter((batch) => batch.status !== 'revoked');
    const preferredTab = DEFAULT_CREATIVE_REVIEW_SOURCE_TAB.trim().toLowerCase();
    const preferred = usable.filter((batch) => batch.sheetName?.trim().toLowerCase() === preferredTab);
    return preferred.find((batch) => batch.sourceType === 'legacy' && batch.status === 'in_review' && batch.summary.total > 0)
      || preferred.find((batch) => batch.status === 'in_review' && batch.summary.total > 0)
      || preferred.find((batch) => batch.summary.total > 0)
      || preferred[0]
      || usable.find((batch) => batch.summary.total > 0)
      || usable[0]
      || null;
  };

  const bootstrapWorkspace = () => {
    if (bootstrapPromiseRef.current) return bootstrapPromiseRef.current;
    const run = (async () => {
      const operationalSheet = sheetsUrl.trim() || DEFAULT_CREATIVE_REVIEW_SHEETS_URL;
      setIsBootstrapping(true);
      setBootstrapError(null);
      try {
        let available = await fetchReviewBatches(operationalSheet);
        setBatches(available);
        let selected = selectDefaultBatch(available);

        if (linkedBatchId && !selected) {
          setActiveBatchId(linkedBatchId);
          return;
        }

        if (!selected) {
          const importKey = `${operationalSheet}::${DEFAULT_CREATIVE_REVIEW_SOURCE_TAB}`.toLowerCase();
          if (autoImportAttemptsRef.current.has(importKey)) {
            throw new Error('No encontramos una tanda disponible después de preparar la pestaña predeterminada.');
          }
          autoImportAttemptsRef.current.add(importKey);
          let imported: ImportLegacyReviewResponse;
          try {
            imported = await importLegacyReviewBatch({
              sheetsUrl: operationalSheet,
              sheetName: DEFAULT_CREATIVE_REVIEW_SOURCE_TAB,
              title: DEFAULT_CREATIVE_REVIEW_TITLE,
            });
          } catch (error) {
            autoImportAttemptsRef.current.delete(importKey);
            throw error;
          }
          selected = imported.batch;
          available = [selected, ...available.filter((batch) => batch.id !== selected!.id)];
          setLastImport(imported);
        }

        const prepared = await prepareBatchForReview(selected);
        available = [prepared, ...available.filter((batch) => batch.id !== prepared.id)];
        setBatches(available);
        setActiveBatchId(prepared.id);
        setLastImport((current) => current && current.batch.id === prepared.id
          ? { ...current, batch: prepared }
          : current);
      } catch (error) {
        setBootstrapError(getErrorMessage(error));
      } finally {
        setIsBootstrapping(false);
      }
    })();
    bootstrapPromiseRef.current = run;
    void run.finally(() => {
      if (bootstrapPromiseRef.current === run) bootstrapPromiseRef.current = null;
    });
    return run;
  };

  const handleLegacyImport = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canImport) {
      setError('Ingresá la URL del Google Sheet y el nombre exacto de la pestaña que contiene los creativos.');
      return;
    }
    setIsImporting(true);
    setError(null);
    setNotice(null);
    setLastImport(null);
    try {
      const result = await importLegacyReviewBatch({
        sheetsUrl: sheetsUrl.trim(),
        sheetName: sourceTab.trim(),
        title: importTitle.trim() || DEFAULT_CREATIVE_REVIEW_TITLE,
      });
      const prepared = await prepareBatchForReview(result.batch);
      upsertBatch(prepared);
      setActiveBatchId(prepared.id);
      setLastImport({ ...result, batch: prepared });
      setNotice(result.alreadyImported
        ? 'Esta pestaña ya estaba importada. Reutilizamos la tanda existente y no duplicamos ningún creativo.'
        : `Importamos ${result.importedCount} ${result.importedCount === 1 ? 'creativo' : 'creativos'}. Ya podés abrir la revisión visual.`);
    } catch (importError) {
      setError(`No se pudieron importar los creativos de “${sourceTab.trim()}”. ${getErrorMessage(importError)}`);
    } finally {
      setIsImporting(false);
    }
  };

  useEffect(() => {
    const justOpened = isActive && !wasActiveRef.current;
    wasActiveRef.current = isActive;
    if (justOpened) void bootstrapWorkspace();
    // Reload only when the Creative Review tab transitions from closed to open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive]);

  useEffect(() => {
    if (!linkedBatchId || !batches.some((batch) => batch.id === linkedBatchId)) return;
    window.requestAnimationFrame(() => {
      document.getElementById(`review-batch-${linkedBatchId}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    });
  }, [batches, linkedBatchId]);

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!canCreate) {
      setError('Completá título, Sheet, categoría y plaza antes de crear la tanda.');
      return;
    }
    setIsCreating(true);
    setError(null);
    setNotice(null);
    try {
      const batch = await createReviewBatch({
        title: title.trim(),
        sourceType,
        sheetsUrl: sheetsUrl.trim(),
        category: category.trim(),
        plazas: plaza.trim(),
      });
      upsertBatch(batch);
      setTitle('');
      setNotice('La tanda quedó creada como borrador. Podés cargar sus creativos y generar el enlace cuando esté lista.');
    } catch (createError) {
      setError(getErrorMessage(createError));
    } finally {
      setIsCreating(false);
    }
  };

  const patchBatch = (
    batchId: string,
    responseBatch: CreativeReviewBatch | undefined,
    fallbackStatus: ReviewBatchStatus,
    privateUrl?: string,
  ) => {
    const mergeBatch = (batch: CreativeReviewBatch): CreativeReviewBatch => {
      if (batch.id !== batchId) return batch;
      return {
        ...batch,
        ...responseBatch,
        id: batch.id,
        status: responseBatch?.status || fallbackStatus,
        privateUrl: privateUrl || responseBatch?.privateUrl || batch.privateUrl,
        summary: responseBatch?.summary || batch.summary,
      };
    };
    setBatches((current) => current.map(mergeBatch));
    setLastImport((current) => current && current.batch.id === batchId
      ? { ...current, batch: mergeBatch(current.batch) }
      : current);
  };

  const syncWorkspaceBatch = useCallback((updated: CreativeReviewBatch) => {
    setBatches((current) => {
      const existing = current.find((batch) => batch.id === updated.id);
      const merged = existing
        ? { ...existing, ...updated, privateUrl: updated.privateUrl || existing.privateUrl }
        : updated;
      return [merged, ...current.filter((batch) => batch.id !== updated.id)];
    });
    setLastImport((current) => current && current.batch.id === updated.id
      ? {
        ...current,
        batch: {
          ...current.batch,
          ...updated,
          privateUrl: updated.privateUrl || current.batch.privateUrl,
        },
      }
      : current);
  }, []);

  const openVisualReview = async (batch: CreativeReviewBatch) => {
    if (batch.privateUrl && batch.status !== 'revoked') {
      const opened = window.open(toAbsoluteUrl(batch.privateUrl), '_blank');
      if (opened) opened.opener = null;
      else setError('Tu navegador bloqueó la pestaña nueva. Habilitá las ventanas emergentes o abrí el enlace desde la tarjeta.');
      return;
    }
    if (!['draft', 'in_review'].includes(batch.status)) {
      setError(`La tanda está ${STATUS_LABELS[batch.status].toLowerCase()} y ya no admite un nuevo enlace de revisión.`);
      return;
    }

    const reviewWindow = window.open('about:blank', '_blank');
    if (reviewWindow) reviewWindow.opener = null;
    setBusyBatch({ id: batch.id, action: 'open' });
    setError(null);
    setNotice(null);
    try {
      const response = await sendReviewBatch(batch.id, batch.sheetsUrl || sheetsUrl.trim());
      const privateUrl = response.privateUrl || response.batch?.privateUrl;
      if (!privateUrl) throw new Error('El servidor no devolvió el enlace privado de revisión.');
      patchBatch(batch.id, response.batch, 'in_review', privateUrl);
      const absoluteUrl = toAbsoluteUrl(privateUrl);
      if (reviewWindow) {
        reviewWindow.location.href = absoluteUrl;
        setNotice('La revisión visual se abrió en una pestaña nueva. El enlace también quedó disponible en la tarjeta de la tanda.');
      } else {
        setNotice('El enlace quedó generado. Tu navegador bloqueó la pestaña nueva; usá “Abrir portal visual” en la tarjeta.');
      }
    } catch (openError) {
      reviewWindow?.close();
      setError(`No se pudo preparar el portal visual. ${getErrorMessage(openError)}`);
    } finally {
      setBusyBatch(null);
    }
  };

  const runAction = async (batch: CreativeReviewBatch, action: Exclude<BatchAction, 'open'>) => {
    if (action === 'revoke' && !window.confirm('¿Revocar este enlace? El cliente perderá el acceso inmediatamente.')) return;
    setBusyBatch({ id: batch.id, action });
    setError(null);
    setNotice(null);
    try {
      if (action === 'revoke') {
        const response = await revokeReviewBatch(batch.id, batch.sheetsUrl || sheetsUrl.trim());
        patchBatch(batch.id, response.batch, 'revoked');
        setNotice('El enlace de revisión fue revocado.');
      } else {
        const response = await retryReviewBatchPublication(batch.id, batch.sheetsUrl || sheetsUrl.trim());
        patchBatch(batch.id, response.batch, 'publishing');
        setNotice('Se reintentó la publicación de los creativos fallidos.');
      }
    } catch (actionError) {
      setError(getErrorMessage(actionError));
    } finally {
      setBusyBatch(null);
    }
  };

  const copyPrivateLink = async (batch: CreativeReviewBatch) => {
    if (!batch.privateUrl) return;
    try {
      await navigator.clipboard.writeText(toAbsoluteUrl(batch.privateUrl));
      setCopiedBatchId(batch.id);
      window.setTimeout(() => setCopiedBatchId((current) => current === batch.id ? null : current), 1800);
    } catch {
      setError('No se pudo copiar el enlace. Seleccionalo y copialo manualmente.');
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {isBootstrapping && (
        <section className="creative-review-portal flex min-h-[520px] items-center justify-center rounded-2xl border border-violet-100 p-6">
          <div className="rounded-2xl bg-white px-8 py-7 text-center shadow-xl">
            <Loader2 className="mx-auto h-8 w-8 animate-spin text-violet-600" />
            <p className="mt-3 text-sm font-semibold text-slate-800">Preparando la revisión visual…</p>
            <p className="mt-1 text-xs text-slate-500">Buscando la tanda de {DEFAULT_CREATIVE_REVIEW_SOURCE_TAB} y cargando sus creativos.</p>
          </div>
        </section>
      )}

      {!isBootstrapping && activeBatchId && (
        <CreativeReviewPortal
          embedded
          batchId={activeBatchId}
          sheetsUrl={activeBatch?.sheetsUrl || sheetsUrl.trim() || DEFAULT_CREATIVE_REVIEW_SHEETS_URL}
          onBatchChange={syncWorkspaceBatch}
        />
      )}

      {!isBootstrapping && !activeBatchId && (
        <section className="creative-review-portal flex min-h-[420px] items-center justify-center rounded-2xl border border-violet-100 p-6">
          <div className="w-full max-w-lg rounded-2xl bg-white p-7 text-center shadow-xl">
            <AlertCircle className="mx-auto h-10 w-10 text-red-500" />
            <h2 className="mt-4 text-xl font-semibold text-slate-900">No pudimos preparar la grilla visual</h2>
            <p className="mt-2 text-sm text-slate-600">{bootstrapError || 'No encontramos una tanda de creativos disponible.'}</p>
            <button
              type="button"
              onClick={() => void bootstrapWorkspace()}
              className="mt-5 inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700"
            >
              <RefreshCw className="h-4 w-4" /> Reintentar carga
            </button>
          </div>
        </section>
      )}

      <details className="panel-surface group order-first">
        <summary className="cursor-pointer list-none marker:hidden">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-sm font-semibold text-slate-200">Gestión de tandas y enlace privado</p>
              <p className="mt-1 text-xs text-slate-400">Importación manual, cambio de Sheet, backup y opciones para compartir.</p>
            </div>
            {activeBatch && <span className="text-xs text-cyan-200">Activa: {activeBatch.title}</span>}
          </div>
        </summary>
        <div className="mt-4 space-y-4 border-t border-slate-700/60 pt-4">
      <section className="panel-surface space-y-4">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
          <div>
            <h2 className="text-xl font-semibold text-white">Revisión de creativos</h2>
            <p className="mt-1 max-w-3xl text-sm text-slate-300">
              Prepará tandas visuales, compartí un enlace privado y seguí cada aprobación hasta Creative Library.
            </p>
          </div>
          <span className="inline-flex items-center gap-1.5 self-start rounded-full border border-cyan-200/30 bg-cyan-300/10 px-3 py-1 text-xs text-cyan-100">
            <Link2 className="h-3.5 w-3.5" /> Enlaces con vencimiento de 30 días
          </span>
        </div>

        <div className="flex flex-col gap-2 sm:flex-row">
          <label className="flex-1 text-sm text-slate-200">
            Google Sheet operativo
            <input
              type="url"
              value={sheetsUrl}
              onChange={(event) => setSheetsUrl(event.target.value)}
              placeholder="https://docs.google.com/spreadsheets/d/..."
              className="mt-1 w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
            />
          </label>
          <button
            type="button"
            onClick={loadBatches}
            disabled={isLoading || !sheetsUrl.trim()}
            className="mt-auto inline-flex items-center justify-center gap-2 rounded-lg border border-slate-600/60 bg-slate-900/40 px-4 py-2 text-sm font-medium text-white hover:border-slate-400/80 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isLoading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Actualizar tandas
          </button>
        </div>
      </section>

      <form onSubmit={handleLegacyImport} className="panel-surface space-y-4 border-cyan-300/35 bg-cyan-300/[0.04]">
        <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex h-7 w-7 items-center justify-center rounded-full bg-cyan-300 text-sm font-bold text-slate-950">1</span>
              <h3 className="text-base font-semibold text-white">Importar los creativos que ya están en el Sheet</h3>
            </div>
            <p className="mt-2 max-w-3xl text-sm text-slate-300">
              Lee los links de la pestaña, los convierte en tarjetas visuales y conserva el estado actual: verde aprobado, rojo rechazado y cualquier otro color pendiente.
            </p>
          </div>
          <span className="inline-flex shrink-0 items-center gap-1.5 self-start rounded-full border border-green-300/30 bg-green-400/10 px-3 py-1 text-xs text-green-100">
            No duplica una importación existente
          </span>
        </div>

        <div className="grid gap-3 lg:grid-cols-[minmax(220px,0.8fr)_minmax(260px,1.2fr)_auto] lg:items-end">
          <label className="text-sm text-slate-200">
            Pestaña con los creativos
            <input
              value={sourceTab}
              onChange={(event) => setSourceTab(event.target.value)}
              placeholder={DEFAULT_CREATIVE_REVIEW_SOURCE_TAB}
              className="mt-1 w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
            />
          </label>
          <label className="text-sm text-slate-200">
            Título de la revisión <span className="text-slate-500">(opcional)</span>
            <input
              value={importTitle}
              onChange={(event) => setImportTitle(event.target.value)}
              placeholder={DEFAULT_CREATIVE_REVIEW_TITLE}
              className="mt-1 w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
            />
          </label>
          <button
            type="submit"
            disabled={!canImport || isImporting}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-cyan-300 px-4 py-2 text-sm font-semibold text-slate-950 hover:bg-cyan-200 disabled:cursor-not-allowed disabled:bg-slate-700 disabled:text-slate-400"
          >
            {isImporting ? <Loader2 className="h-4 w-4 animate-spin" /> : <FileInput className="h-4 w-4" />}
            {isImporting ? 'Importando creativos…' : 'Importar creativos y preparar revisión'}
          </button>
        </div>
        <p className="text-xs text-slate-400">
          Antes de modificar el Sheet, el sistema crea automáticamente una copia de respaldo en Drive.
        </p>
      </form>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-red-500/30 bg-red-500/10 p-3 text-sm text-red-200" role="alert">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          <span className="whitespace-pre-line">{error}</span>
        </div>
      )}
      {notice && (
        <div className="flex items-start gap-2 rounded-xl border border-green-300/30 bg-green-400/10 p-3 text-sm text-green-100" role="status">
          <Check className="mt-0.5 h-4 w-4 shrink-0" /> {notice}
        </div>
      )}

      {lastImport && importedBatch && (
        <section className="panel-surface space-y-4 border-green-300/35 bg-green-400/[0.04]" aria-label="Resultado de la importación">
          <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
            <div>
              <div className="flex items-center gap-2">
                <span className="flex h-7 w-7 items-center justify-center rounded-full bg-green-300 text-sm font-bold text-slate-950">2</span>
                <h3 className="text-base font-semibold text-white">Los creativos están listos para revisar</h3>
              </div>
              <p className="mt-2 text-sm text-slate-300">
                {lastImport.alreadyImported
                  ? 'Encontramos la importación anterior y abrimos la misma tanda, sin crear duplicados.'
                  : `Se preparó “${importedBatch.title}” con ${lastImport.importedCount} ${lastImport.importedCount === 1 ? 'creativo' : 'creativos'}.`}
              </p>
            </div>
            {['draft', 'in_review'].includes(importedBatch.status) && (
              <button
                type="button"
                onClick={() => openVisualReview(importedBatch)}
                disabled={busyBatch?.id === importedBatch.id}
                className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg bg-green-300 px-4 py-2.5 text-sm font-semibold text-slate-950 hover:bg-green-200 disabled:cursor-wait disabled:opacity-60"
              >
                {busyBatch?.id === importedBatch.id && busyBatch.action === 'open'
                  ? <Loader2 className="h-4 w-4 animate-spin" />
                  : <Eye className="h-4 w-4" />}
                {busyBatch?.id === importedBatch.id && busyBatch.action === 'open'
                  ? 'Preparando portal…'
                  : importedBatch.privateUrl
                    ? 'Abrir portal visual'
                    : importedBatch.status === 'in_review'
                      ? 'Renovar enlace y abrir portal'
                      : 'Generar enlace y abrir portal'}
              </button>
            )}
          </div>

          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <div className="rounded-lg bg-slate-900/45 px-3 py-2">
              <p className="text-lg font-semibold text-white">{importedBatch.summary.total}</p>
              <p className="text-[11px] uppercase text-slate-400">Creativos</p>
            </div>
            <div className="rounded-lg bg-slate-900/45 px-3 py-2">
              <p className="text-lg font-semibold text-white">{importedBatch.summary.pending}</p>
              <p className="text-[11px] uppercase text-slate-400">Pendientes</p>
            </div>
            <div className="rounded-lg bg-green-400/10 px-3 py-2">
              <p className="text-lg font-semibold text-green-100">{importedBatch.summary.approved}</p>
              <p className="text-[11px] uppercase text-green-100">Aprobados</p>
            </div>
            <div className="rounded-lg bg-red-500/10 px-3 py-2">
              <p className="text-lg font-semibold text-red-200">{importedBatch.summary.rejected}</p>
              <p className="text-[11px] uppercase text-red-200">Rechazados</p>
            </div>
          </div>

          <div className="flex flex-col gap-2 border-t border-slate-700/60 pt-3 text-xs text-slate-300 sm:flex-row sm:items-center sm:justify-between">
            <p>En el portal podés aprobar o rechazar cada imagen. Al finalizar, sólo las aprobadas pasan a Creative Library.</p>
            {lastImport.backup?.url && (
              <a
                href={lastImport.backup.url}
                target="_blank"
                rel="noreferrer"
                className="inline-flex shrink-0 items-center gap-1 text-cyan-200 hover:text-cyan-100"
              >
                Ver copia de respaldo <ExternalLink className="h-3.5 w-3.5" />
              </a>
            )}
          </div>

          {lastImport.warnings.some((warning) => warning.code !== 'LEGACY_ALREADY_IMPORTED') && (
            <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-3 text-xs text-amber-100">
              <p className="font-semibold">La importación terminó con advertencias:</p>
              <ul className="mt-1 list-disc space-y-1 pl-4">
                {lastImport.warnings
                  .filter((warning) => warning.code !== 'LEGACY_ALREADY_IMPORTED')
                  .map((warning, index) => <li key={`${warning.code || 'warning'}-${index}`}>{warning.message}</li>)}
              </ul>
            </div>
          )}
        </section>
      )}

      {batches.length > 0 ? (
        <section className="panel-surface space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-200">Tandas del Sheet</h3>
            <span className="text-xs text-slate-400">{batches.length} {batches.length === 1 ? 'tanda' : 'tandas'}</span>
          </div>
          <div className="grid gap-3 lg:grid-cols-2">
            {batches.map((batch) => {
              const isBusy = busyBatch?.id === batch.id;
              const isOpening = isBusy && busyBatch.action === 'open';
              const canSend = batch.status === 'draft' || batch.status === 'in_review';
              const canRevoke = ['in_review', 'publishing', 'published', 'publish_failed'].includes(batch.status);
              const publishingAge = Date.now() - Date.parse(batch.updatedAt || '');
              const canRetry = batch.status === 'publish_failed'
                || (batch.status === 'publishing' && (!Number.isFinite(publishingAge) || publishingAge >= 300_000));
              return (
                <article
                  key={batch.id}
                  id={`review-batch-${batch.id}`}
                  className={`rounded-xl border bg-slate-900/35 p-4 transition ${batch.id === linkedBatchId ? 'border-cyan-300 ring-2 ring-cyan-300/30' : 'border-slate-700/70'}`}
                >
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div>
                      <p className="text-base font-semibold text-white">{batch.title}</p>
                      <p className="mt-1 text-xs text-slate-400">{SOURCE_LABELS[batch.sourceType]} · {batch.category} · {batch.plaza}</p>
                    </div>
                    <span className={`rounded-full border px-2.5 py-1 text-xs font-medium ${STATUS_STYLES[batch.status]}`}>
                      {STATUS_LABELS[batch.status]}
                    </span>
                  </div>

                  <div className="mt-4 grid grid-cols-3 gap-2 text-center">
                    <div className="rounded-lg bg-slate-900/40 px-2 py-2">
                      <p className="text-lg font-semibold text-white">{batch.summary.pending}</p>
                      <p className="text-[11px] uppercase text-slate-400">Pendientes</p>
                    </div>
                    <div className="rounded-lg bg-green-400/10 px-2 py-2">
                      <p className="text-lg font-semibold text-green-100">{batch.summary.approved}</p>
                      <p className="text-[11px] uppercase text-green-100">Aprobados</p>
                    </div>
                    <div className="rounded-lg bg-red-500/10 px-2 py-2">
                      <p className="text-lg font-semibold text-red-200">{batch.summary.rejected}</p>
                      <p className="text-[11px] uppercase text-red-200">Rechazados</p>
                    </div>
                  </div>

                  <dl className="mt-4 grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
                    <div><dt className="text-slate-500">Creada</dt><dd className="mt-0.5 text-slate-300">{formatDate(batch.createdAt)}</dd></div>
                    <div><dt className="text-slate-500">Vencimiento</dt><dd className="mt-0.5 text-slate-300">{formatDate(batch.expiresAt)}</dd></div>
                  </dl>

                  {batch.privateUrl && batch.status !== 'revoked' && (
                    <div className="mt-4 flex gap-2 rounded-lg border border-slate-700/70 bg-slate-950/65 p-2">
                      <input
                        value={toAbsoluteUrl(batch.privateUrl)}
                        readOnly
                        aria-label={`Enlace privado de ${batch.title}`}
                        onFocus={(event) => event.currentTarget.select()}
                        className="min-w-0 flex-1 bg-transparent px-1 text-xs text-slate-300 outline-none"
                      />
                      <button
                        type="button"
                        onClick={() => copyPrivateLink(batch)}
                        className="inline-flex shrink-0 items-center gap-1 rounded-md border border-slate-600/60 px-2 py-1 text-xs text-white hover:border-slate-400/80"
                      >
                        {copiedBatchId === batch.id ? <Check className="h-3.5 w-3.5" /> : <Clipboard className="h-3.5 w-3.5" />}
                        {copiedBatchId === batch.id ? 'Copiado' : 'Copiar'}
                      </button>
                      <a
                        href={batch.privateUrl}
                        target="_blank"
                        rel="noreferrer"
                        aria-label="Abrir enlace de revisión"
                        className="inline-flex h-7 w-7 shrink-0 items-center justify-center rounded-md border border-slate-600/60 text-white hover:border-slate-400/80"
                      >
                        <ExternalLink className="h-3.5 w-3.5" />
                      </a>
                    </div>
                  )}

                  {(canSend || canRevoke || canRetry) && (
                    <div className="mt-4 flex flex-wrap gap-2">
                      {canSend && (
                        <button
                          type="button"
                          onClick={() => openVisualReview(batch)}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-lg bg-cyan-300 px-3 py-2 text-xs font-semibold text-slate-900 hover:bg-cyan-200 disabled:opacity-50"
                        >
                          {isOpening ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Eye className="h-3.5 w-3.5" />}
                          {isOpening
                            ? 'Preparando portal…'
                            : batch.privateUrl
                              ? 'Abrir portal visual'
                              : batch.status === 'in_review'
                                ? 'Renovar enlace y abrir'
                                : 'Generar enlace y abrir'}
                        </button>
                      )}
                      {canRevoke && (
                        <button
                          type="button"
                          onClick={() => runAction(batch, 'revoke')}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 px-3 py-2 text-xs font-medium text-red-200 hover:border-red-400/60 disabled:opacity-50"
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <ShieldOff className="h-3.5 w-3.5" />}
                          Revocar enlace
                        </button>
                      )}
                      {canRetry && (
                        <button
                          type="button"
                          onClick={() => runAction(batch, 'retry')}
                          disabled={isBusy}
                          className="inline-flex items-center gap-1.5 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs font-medium text-amber-100 disabled:opacity-50"
                        >
                          {isBusy ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RotateCcw className="h-3.5 w-3.5" />}
                          Reintentar fallidos
                        </button>
                      )}
                    </div>
                  )}
                </article>
              );
            })}
          </div>
        </section>
      ) : !isLoading && (
        <section className="panel-surface py-10 text-center">
          <FileInput className="mx-auto h-8 w-8 text-cyan-200" />
          <p className="mt-3 text-sm font-medium text-slate-200">Todavía no hay creativos preparados para revisar.</p>
          <p className="mt-1 text-xs text-slate-400">Completá el Sheet y la pestaña arriba, y elegí “Importar creativos y preparar revisión”.</p>
        </section>
      )}

      <details className="panel-surface group">
        <summary className="cursor-pointer list-none text-sm font-semibold text-slate-200 marker:hidden">
          <span className="inline-flex items-center gap-2">
            <Link2 className="h-4 w-4 text-slate-400" />
            Crear una tanda manual <span className="font-normal text-slate-500">(opcional)</span>
          </span>
          <p className="mt-1 text-xs font-normal text-slate-400">Para outputs nuevos que todavía no están cargados en la pestaña elegida.</p>
        </summary>
        <form onSubmit={handleCreate} className="mt-4 space-y-4 border-t border-slate-700/60 pt-4">
          <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-4">
            <label className="text-sm text-slate-200 md:col-span-2">
              Título para el cliente
              <input
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Ej. Riders Argentina · Agosto"
                className="mt-1 w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
              />
            </label>
            <label className="text-sm text-slate-200">
              Origen
              <select
                value={sourceType}
                onChange={(event) => setSourceType(event.target.value as Exclude<ReviewSourceType, 'legacy'>)}
                className="mt-1 w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
              >
                <option value="editor_batch">Editor Batch</option>
                <option value="batch_sheets">Batch from Sheets</option>
              </select>
            </label>
            <label className="text-sm text-slate-200">
              Categoría
              <select
                value={category}
                onChange={(event) => setCategory(event.target.value)}
                className="mt-1 w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
              >
                <option value="">Seleccionar categoría</option>
                <option value="Generic">Generic</option>
                <option value="Promo">Promo</option>
                <option value="Alianzas">Alianzas</option>
              </select>
            </label>
            <label className="text-sm text-slate-200">
              Plaza
              <input
                value={plaza}
                onChange={(event) => setPlaza(event.target.value)}
                placeholder="AR, CABA, Córdoba…"
                className="mt-1 w-full rounded-lg border border-slate-700/80 bg-slate-900/70 px-3 py-2 text-sm text-white outline-none focus:border-cyan-300/70"
              />
            </label>
          </div>
          <button
            type="submit"
            disabled={!canCreate || isCreating}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-slate-600/70 bg-slate-900/50 px-4 py-2 text-sm font-semibold text-white hover:border-slate-400 disabled:cursor-not-allowed disabled:opacity-50"
          >
            {isCreating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Link2 className="h-4 w-4" />}
            Crear tanda manual
          </button>
        </form>
      </details>
        </div>
      </details>
    </div>
  );
}
