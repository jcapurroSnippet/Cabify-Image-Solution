import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AlertCircle,
  Check,
  CheckCircle2,
  ChevronDown,
  Clock3,
  Image as ImageIcon,
  Loader2,
  Lock,
  Maximize2,
  RefreshCw,
  Save,
  Send,
  Square,
  SquareCheckBig,
  TriangleAlert,
  X,
  XCircle,
} from 'lucide-react';
import {
  exchangeReviewSession,
  fetchReviewBatch,
  fetchPublicReview,
  finalizeReviewBatch,
  finalizePublicReview,
  updateReviewBatchDecisions,
  updatePublicDecisions,
} from './services/creativeReviewApi';
import type {
  CreativeReviewBatch,
  CreativeReviewItem,
  ReviewBatchStatus,
  ReviewDecisionInput,
  ReviewItemStatus,
  ReviewSummary,
} from './types';

type StatusFilter = 'all' | Extract<ReviewItemStatus, 'pending' | 'approved' | 'rejected'>;

interface CreativeReviewPortalProps {
  token?: string;
  batchId?: string;
  sheetsUrl?: string;
  embedded?: boolean;
  onBatchChange?: (batch: CreativeReviewBatch) => void;
}

interface RejectDialogState {
  ids: string[];
  title: string;
}

const EMPTY_SUMMARY: ReviewSummary = {
  total: 0,
  pending: 0,
  approved: 0,
  rejected: 0,
  superseded: 0,
  stored: 0,
  failed: 0,
};

const STATUS_FILTERS: Array<{ value: StatusFilter; label: string }> = [
  { value: 'all', label: 'Todos' },
  { value: 'pending', label: 'Pendientes' },
  { value: 'approved', label: 'Aprobados' },
  { value: 'rejected', label: 'Rechazados' },
];

const LOCKED_BATCH_STATUSES: ReviewBatchStatus[] = ['publishing', 'published', 'publish_failed', 'revoked'];
const META_REQUIRED_RATIOS = ['1:1', '9:16', '16:9'];

const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Ocurrió un error inesperado.';

const getPreviewSrc = (url?: string) => {
  if (!url) return '';
  if (url.startsWith('data:') || url.startsWith('blob:') || url.startsWith('/api/')) return url;
  return `/api/image-preview?url=${encodeURIComponent(url)}`;
};

const calculateSummary = (items: CreativeReviewItem[]): ReviewSummary => {
  if (items.length === 0) return EMPTY_SUMMARY;
  const active = items.filter((item) => item.status !== 'superseded');
  return {
    total: active.length,
    pending: active.filter((item) => item.status === 'pending').length,
    approved: active.filter((item) => item.status === 'approved').length,
    rejected: active.filter((item) => item.status === 'rejected').length,
    superseded: items.length - active.length,
    stored: items.filter((item) => item.publicationStatus === 'stored').length,
    failed: items.filter((item) => item.publicationStatus === 'failed').length,
  };
};

const mergeItems = (current: CreativeReviewItem[], updates: CreativeReviewItem[]) => {
  if (updates.length === 0) return current;
  const updatesById = new Map(updates.map((item) => [item.id, item]));
  const merged = current.map((item) => updatesById.get(item.id) || item);
  const currentIds = new Set(current.map((item) => item.id));
  for (const item of updates) {
    if (!currentIds.has(item.id)) merged.push(item);
  }
  return merged;
};

const formatDate = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'long' }).format(date);
};

const formatCount = (value: number, singular: string, plural: string) =>
  `${value} ${value === 1 ? singular : plural}`;

const isValidEmail = (value: string) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());

const normalizeRatio = (value: string) => {
  const normalized = value.trim().toLowerCase().replaceAll(' ', '');
  if (normalized === 'square') return '1:1';
  if (normalized === 'portrait' || normalized === 'vertical') return '9:16';
  if (['landscape', '1.91:1', '1.91', '1200x628', '16.9'].includes(normalized)) return '16:9';
  return normalized;
};

const getMissingMetaRatios = (familyItems: CreativeReviewItem[]) => {
  const approvedRatios = new Set(
    familyItems
      .filter((item) => item.status === 'approved')
      .map((item) => normalizeRatio(item.ratio)),
  );
  if (approvedRatios.size === 0) return [];
  return META_REQUIRED_RATIOS.filter((ratio) => !approvedRatios.has(ratio));
};

const getFamilyContextLabel = (familyItems: CreativeReviewItem[]) => {
  const categories = Array.from(new Set(
    familyItems.map((item) => item.category.trim()).filter(Boolean),
  ));
  const plazas = Array.from(new Set(
    familyItems.map((item) => item.plaza.trim()).filter((value) => value && value !== 'Sin plaza'),
  ));

  const categoryLabel = categories.length > 2
    ? `${categories.length} categorías`
    : categories.join(' + ');
  const plazaLabel = plazas.length === 1
    ? (plazas[0].toUpperCase() === 'ALL' ? 'Todas las plazas' : plazas[0])
    : plazas.length > 1
      ? `${plazas.length} plazas`
      : '';

  return [categoryLabel, plazaLabel].filter(Boolean).join(' · ');
};

const getStatusPresentation = (status: ReviewItemStatus) => {
  if (status === 'approved') return {
    label: 'Aprobado',
    icon: <CheckCircle2 className="h-4 w-4" />,
    className: 'border-emerald-200 bg-emerald-50 text-emerald-700',
  };
  if (status === 'rejected') return {
    label: 'Rechazado',
    icon: <XCircle className="h-4 w-4" />,
    className: 'border-red-200 bg-red-50 text-red-700',
  };
  if (status === 'superseded') return {
    label: 'Reemplazado',
    icon: <Clock3 className="h-4 w-4" />,
    className: 'border-slate-200 bg-slate-100 text-slate-600',
  };
  return {
    label: 'Pendiente',
    icon: <Clock3 className="h-4 w-4" />,
    className: 'border-amber-200 bg-amber-50 text-amber-700',
  };
};

function ReviewImage({
  url,
  label,
  onZoom,
}: {
  url?: string;
  label: string;
  onZoom: (url: string, label: string) => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [url]);

  if (!url || failed) {
    return (
      <div className="flex h-64 items-center justify-center rounded-xl bg-slate-100 text-center text-sm text-slate-500">
        <div><ImageIcon className="mx-auto mb-2 h-7 w-7" />Vista previa no disponible</div>
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onZoom(url, label)}
      className="group relative block h-64 w-full cursor-zoom-in overflow-hidden rounded-xl bg-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500 focus:ring-offset-2"
      aria-label={`Ampliar ${label}`}
    >
      <img
        src={getPreviewSrc(url)}
        alt={label}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-contain transition duration-200 group-hover:scale-[1.015]"
      />
      <span className="absolute bottom-2 right-2 inline-flex items-center gap-1 rounded-full bg-slate-950/75 px-2.5 py-1 text-xs font-medium text-white opacity-90">
        <Maximize2 className="h-3.5 w-3.5" /> Ampliar
      </span>
    </button>
  );
}

function ReviewThumbnail({
  url,
  label,
  onZoom,
}: {
  url?: string;
  label: string;
  onZoom: (url: string, label: string) => void;
}) {
  const [failed, setFailed] = useState(false);

  useEffect(() => setFailed(false), [url]);

  if (!url || failed) {
    return (
      <div className="review-compact-thumbnail flex h-24 w-full items-center justify-center rounded-lg bg-slate-100 text-slate-500 sm:h-24 sm:w-24">
        <ImageIcon className="h-6 w-6" />
      </div>
    );
  }

  return (
    <button
      type="button"
      onClick={() => onZoom(url, label)}
      className="review-compact-thumbnail group relative block h-28 w-full cursor-zoom-in overflow-hidden rounded-lg bg-slate-100 focus:outline-none focus:ring-2 focus:ring-violet-500 sm:h-24 sm:w-24"
      aria-label={`Ampliar ${label}`}
    >
      <img
        src={getPreviewSrc(url)}
        alt={label}
        loading="lazy"
        onError={() => setFailed(true)}
        className="h-full w-full object-contain transition-transform group-hover:scale-[1.03]"
      />
      <span className="absolute bottom-1.5 right-1.5 flex h-6 w-6 items-center justify-center rounded-full bg-slate-950/75 text-white">
        <Maximize2 className="h-3.5 w-3.5" />
      </span>
    </button>
  );
}

function Counter({ label, value, tone }: { label: string; value: number; tone: 'neutral' | 'pending' | 'approved' | 'rejected' }) {
  const toneClass = {
    neutral: 'border-violet-100 bg-violet-50 text-violet-800',
    pending: 'border-amber-100 bg-amber-50 text-amber-800',
    approved: 'border-emerald-100 bg-emerald-50 text-emerald-800',
    rejected: 'border-red-100 bg-red-50 text-red-800',
  }[tone];
  return (
    <div className={`review-counter rounded-xl border px-3 py-2 ${toneClass}`} data-tone={tone}>
      <p className="text-xl font-semibold leading-none">{value}</p>
      <p className="mt-1 text-[11px] font-semibold uppercase tracking-wide">{label}</p>
    </div>
  );
}

function ReviewedDetails({
  initiallyOpen,
  className,
  children,
}: {
  initiallyOpen: boolean;
  className: string;
  children: React.ReactNode;
}) {
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    if (detailsRef.current) detailsRef.current.open = initiallyOpen;
  }, [initiallyOpen]);

  return <details ref={detailsRef} className={className}>{children}</details>;
}

export default function CreativeReviewPortal({
  token,
  batchId,
  sheetsUrl,
  embedded = false,
  onBatchChange,
}: CreativeReviewPortalProps) {
  const [batch, setBatch] = useState<CreativeReviewBatch | null>(null);
  const [items, setItems] = useState<CreativeReviewItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all');
  const [ratioFilter, setRatioFilter] = useState('all');
  const [familyFilter, setFamilyFilter] = useState('all');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [savingIds, setSavingIds] = useState<Set<string>>(new Set());
  const [saveError, setSaveError] = useState<string | null>(null);
  const [failedDecisions, setFailedDecisions] = useState<ReviewDecisionInput[] | null>(null);
  const [rejectDialog, setRejectDialog] = useState<RejectDialogState | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [rejectError, setRejectError] = useState<string | null>(null);
  const [zoomedImage, setZoomedImage] = useState<{ url: string; label: string } | null>(null);
  const [reviewerName, setReviewerName] = useState('');
  const [reviewerEmail, setReviewerEmail] = useState('');
  const [finalizeError, setFinalizeError] = useState<string | null>(null);
  const [isFinalizing, setIsFinalizing] = useState(false);
  const exchangePromiseRef = useRef<Promise<void> | null>(null);
  const sessionReadyRef = useRef(false);
  const isInternalWorkspace = Boolean(batchId && sheetsUrl);

  const loadReview = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      if (isInternalWorkspace) {
        const payload = await fetchReviewBatch(batchId!, sheetsUrl!);
        setBatch(payload.batch);
        setItems(payload.items);
        setReviewerName((current) => current || payload.batch.reviewerName || 'Equipo Cabify');
        setReviewerEmail((current) => current || payload.batch.reviewerEmail || '');
        return;
      }
      if (token && !sessionReadyRef.current) {
        if (!exchangePromiseRef.current) {
          exchangePromiseRef.current = exchangeReviewSession(token)
            .then(() => {
              sessionReadyRef.current = true;
              window.history.replaceState({}, '', '/review');
            })
            .catch((error) => {
              exchangePromiseRef.current = null;
              throw error;
            });
        }
        await exchangePromiseRef.current;
      }
      const payload = await fetchPublicReview();
      setBatch(payload.batch);
      setItems(payload.items);
      setReviewerName((current) => current || payload.batch.reviewerName || '');
      setReviewerEmail((current) => current || payload.batch.reviewerEmail || '');
    } catch (error) {
      setLoadError(getErrorMessage(error));
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    setBatch(null);
    setItems([]);
    setSelectedIds(new Set());
    setSaveError(null);
    setFinalizeError(null);
    void loadReview();
    // The public token is immutable; internal batch selection can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [batchId, sheetsUrl]);

  useEffect(() => {
    if (batch) onBatchChange?.(batch);
  }, [batch, onBatchChange]);

  useEffect(() => {
    if (!zoomedImage && !rejectDialog) return;
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return;
      if (zoomedImage) setZoomedImage(null);
      else setRejectDialog(null);
    };
    window.addEventListener('keydown', closeOnEscape);
    return () => window.removeEventListener('keydown', closeOnEscape);
  }, [rejectDialog, zoomedImage]);

  useEffect(() => {
    setSelectedIds(new Set());
  }, [familyFilter, ratioFilter, statusFilter]);

  const activeItems = useMemo(() => items.filter((item) => item.status !== 'superseded'), [items]);
  const summary = useMemo(() => calculateSummary(items), [items]);
  const ratios = useMemo(
    () => Array.from(new Set(activeItems.map((item) => item.ratio).filter(Boolean))).sort(),
    [activeItems],
  );
  const families = useMemo(
    () => Array.from(new Set(activeItems.map((item) => item.familyId).filter(Boolean))),
    [activeItems],
  );
  const familyLabels = useMemo(() => {
    const numberWidth = Math.max(2, String(families.length).length);
    return new Map(families.map((familyId, index) => [
      familyId,
      `Familia ${String(index + 1).padStart(numberWidth, '0')}`,
    ]));
  }, [families]);
  const visibleItems = useMemo(() => activeItems.filter((item) => (
    (statusFilter === 'all' || item.status === statusFilter || savingIds.has(item.id))
    && (ratioFilter === 'all' || item.ratio === ratioFilter)
    && (familyFilter === 'all' || item.familyId === familyFilter)
  )), [activeItems, familyFilter, ratioFilter, savingIds, statusFilter]);
  const selectableVisibleItems = useMemo(() => {
    if (statusFilter === 'all') return visibleItems.filter((item) => item.status === 'pending');
    if (statusFilter === 'pending') return visibleItems;
    return [];
  }, [statusFilter, visibleItems]);
  const visibleFamilies = useMemo(() => {
    const groups = new Map<string, CreativeReviewItem[]>();
    for (const item of visibleItems) {
      const current = groups.get(item.familyId) || [];
      current.push(item);
      groups.set(item.familyId, current);
    }
    return Array.from(groups.entries());
  }, [visibleItems]);
  const allFamilies = useMemo(() => {
    const groups = new Map<string, CreativeReviewItem[]>();
    for (const item of activeItems) groups.set(item.familyId, [...(groups.get(item.familyId) || []), item]);
    return groups;
  }, [activeItems]);
  const partialFamilyCount = useMemo(
    () => Array.from(allFamilies.values()).filter((familyItems) => getMissingMetaRatios(familyItems).length > 0).length,
    [allFamilies],
  );
  const isLocked = batch ? LOCKED_BATCH_STATUSES.includes(batch.status) : false;
  const isSaving = savingIds.size > 0;

  const applyDecisions = async (decisions: ReviewDecisionInput[]) => {
    if (decisions.length === 0 || isLocked || isSaving) return;
    const decisionById = new Map(decisions.map((decision) => [decision.reviewItemId, decision]));
    const snapshot = items;
    setItems((current) => current.map((item) => {
      const decision = decisionById.get(item.id);
      if (!decision) return item;
      return {
        ...item,
        status: decision.status,
        reason: decision.status === 'rejected' ? decision.reason : undefined,
      };
    }));
    setSavingIds(new Set(decisions.map((decision) => decision.reviewItemId)));
    setSaveError(null);
    setFailedDecisions(null);
    try {
      const payload = isInternalWorkspace
        ? await updateReviewBatchDecisions(batchId!, sheetsUrl!, decisions)
        : await updatePublicDecisions(decisions);
      if (payload.batch.id) setBatch((current) => current ? { ...current, ...payload.batch } : payload.batch);
      if (payload.items.length > 0) setItems((current) => mergeItems(current, payload.items));
      setSelectedIds((current) => {
        const next = new Set(current);
        decisions.forEach((decision) => next.delete(decision.reviewItemId));
        return next;
      });
    } catch (error) {
      setItems(snapshot);
      setSaveError(getErrorMessage(error));
      setFailedDecisions(decisions);
    } finally {
      setSavingIds(new Set());
    }
  };

  const decideIds = (ids: string[], status: 'approved' | 'rejected', reason = '') => {
    const idSet = new Set(ids);
    const decisions = activeItems
      .filter((item) => idSet.has(item.id))
      .map((item) => ({
        reviewItemId: item.id,
        version: item.version,
        status,
        reason: status === 'rejected' ? reason.trim() : '',
      }));
    void applyDecisions(decisions);
  };

  const openRejectDialog = (ids: string[], title: string) => {
    const uniqueIds = Array.from(new Set(ids));
    if (uniqueIds.length === 0 || isLocked || isSaving) return;
    const existingReason = uniqueIds.length === 1
      ? activeItems.find((item) => item.id === uniqueIds[0])?.reason || ''
      : '';
    setRejectReason(existingReason);
    setRejectError(null);
    setRejectDialog({ ids: uniqueIds, title });
  };

  const submitRejection = (event: React.FormEvent) => {
    event.preventDefault();
    if (!rejectReason.trim()) {
      setRejectError('Contanos qué hay que corregir antes de rechazar.');
      return;
    }
    if (!rejectDialog) return;
    const { ids } = rejectDialog;
    setRejectDialog(null);
    decideIds(ids, 'rejected', rejectReason);
  };

  const toggleSelection = (id: string) => {
    if (isLocked || isSaving) return;
    setSelectedIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const selectVisible = () => {
    setSelectedIds((current) => {
      const next = new Set(current);
      const allSelected = selectableVisibleItems.length > 0 && selectableVisibleItems.every((item) => next.has(item.id));
      selectableVisibleItems.forEach((item) => allSelected ? next.delete(item.id) : next.add(item.id));
      return next;
    });
  };

  const finalizeReview = async (event: React.FormEvent) => {
    event.preventDefault();
    setFinalizeError(null);
    if (summary.pending > 0) {
      setFinalizeError(`Todavía quedan ${summary.pending} creativos pendientes.`);
      return;
    }
    if (!reviewerName.trim()) {
      setFinalizeError('Ingresá tu nombre para registrar la revisión.');
      return;
    }
    if (!isValidEmail(reviewerEmail)) {
      setFinalizeError('Ingresá un email válido para registrar la revisión.');
      return;
    }
    setIsFinalizing(true);
    try {
      const finalization = {
        reviewerName: reviewerName.trim(),
        reviewerEmail: reviewerEmail.trim(),
      };
      const payload = isInternalWorkspace
        ? await finalizeReviewBatch(batchId!, sheetsUrl!, finalization)
        : await finalizePublicReview(finalization);
      if (payload.batch.id) setBatch((current) => current ? { ...current, ...payload.batch } : payload.batch);
      if (payload.items.length > 0) setItems((current) => mergeItems(current, payload.items));
    } catch (error) {
      setFinalizeError(getErrorMessage(error));
    } finally {
      setIsFinalizing(false);
    }
  };

  const renderPendingCreativeCard = (item: CreativeReviewItem) => {
    const presentation = getStatusPresentation(item.status);
    const selected = selectedIds.has(item.id);
    const isItemSaving = savingIds.has(item.id);
    return (
      <article key={item.id} className={`review-creative-card rounded-2xl border p-4 transition ${selected ? 'border-violet-400 ring-2 ring-violet-100' : 'border-slate-200'}`}>
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-semibold text-slate-900">{item.label || item.variant}</h3>
              <span data-status={item.status} className={`review-status-badge inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-xs font-semibold ${presentation.className}`}>{presentation.icon}{presentation.label}</span>
            </div>
            <p className="mt-1 text-xs text-slate-500">{item.ratio} · {item.category} · {item.plaza} · versión {item.version}</p>
          </div>
          {!isLocked && (
            <button type="button" onClick={() => toggleSelection(item.id)} disabled={isSaving} aria-pressed={selected} aria-label={`${selected ? 'Quitar' : 'Seleccionar'} ${item.label || item.variant}`} className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-violet-400 hover:text-violet-600 disabled:opacity-40">
              {selected ? <SquareCheckBig className="h-5 w-5 text-violet-600" /> : <Square className="h-5 w-5" />}
            </button>
          )}
        </div>

        <div className={`mt-4 grid gap-3 ${item.referenceUrl ? 'sm:grid-cols-2' : ''}`}>
          {item.referenceUrl && (
            <div>
              <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Referencia</p>
              <ReviewImage url={item.referenceUrl} label={`Referencia de ${item.label || item.variant}`} onZoom={(url, label) => setZoomedImage({ url, label })} />
            </div>
          )}
          <div>
            <p className="mb-1.5 text-xs font-semibold uppercase tracking-wide text-slate-500">Creativo generado</p>
            <ReviewImage url={item.imageUrl} label={`Creativo ${item.label || item.variant}`} onZoom={(url, label) => setZoomedImage({ url, label })} />
          </div>
        </div>

        {item.status === 'rejected' && item.reason && (
          <div className="mt-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-sm text-red-800"><strong>Motivo:</strong> {item.reason}</div>
        )}
        {item.publicationStatus === 'failed' && item.publicationError && (
          <div className="mt-3 rounded-lg border border-amber-100 bg-amber-50 px-3 py-2 text-xs text-amber-800">Publicación pendiente: {item.publicationError}</div>
        )}

        {!isLocked && (
          <div className="mt-4 grid grid-cols-2 gap-2">
            <button type="button" onClick={() => decideIds([item.id], 'approved')} disabled={isSaving} className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-semibold transition disabled:opacity-50 ${item.status === 'approved' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}>
              {isItemSaving ? <Loader2 className="h-4 w-4 animate-spin" /> : <Check className="h-4 w-4" />} Aprobar
            </button>
            <button type="button" onClick={() => openRejectDialog([item.id], item.label || item.variant)} disabled={isSaving} className={`inline-flex items-center justify-center gap-1.5 rounded-xl border px-3 py-2.5 text-sm font-semibold transition disabled:opacity-50 ${item.status === 'rejected' ? 'border-red-600 bg-red-600 text-white' : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'}`}>
              <X className="h-4 w-4" /> Rechazar
            </button>
          </div>
        )}
      </article>
    );
  };

  const renderReviewedCreativeCard = (item: CreativeReviewItem) => {
    const presentation = getStatusPresentation(item.status);
    const selected = selectedIds.has(item.id);
    const isItemSaving = savingIds.has(item.id);
    const label = item.label || item.variant;
    return (
      <article key={item.id} className={`review-compact-card grid gap-3 rounded-xl border p-3 transition sm:grid-cols-[6rem_minmax(0,1fr)] ${selected ? 'border-violet-400 ring-2 ring-violet-100' : 'border-slate-200'}`}>
        <ReviewThumbnail
          url={item.imageUrl}
          label={`Creativo ${label}`}
          onZoom={(url, zoomLabel) => setZoomedImage({ url, label: zoomLabel })}
        />
        <div className="flex min-w-0 flex-col">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <h3 className="truncate text-sm font-semibold text-slate-900" title={label}>{label}</h3>
              <span data-status={item.status} className={`review-status-badge mt-1 inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] font-semibold ${presentation.className}`}>{presentation.icon}{presentation.label}</span>
            </div>
            {!isLocked && (
              <button type="button" onClick={() => toggleSelection(item.id)} disabled={isSaving} aria-pressed={selected} aria-label={`${selected ? 'Quitar' : 'Seleccionar'} ${label}`} className="flex h-7 w-7 shrink-0 items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:border-violet-400 hover:text-violet-600 disabled:opacity-40">
                {selected ? <SquareCheckBig className="h-4 w-4 text-violet-600" /> : <Square className="h-4 w-4" />}
              </button>
            )}
          </div>

          <p className="mt-2 truncate text-[11px] text-slate-500" title={`${item.ratio} · ${item.category} · ${item.plaza} · versión ${item.version}`}>
            {item.ratio} · {item.category} · {item.plaza} · v{item.version}
          </p>

          {item.status === 'rejected' && item.reason && (
            <p className="review-compact-reason mt-2 text-xs leading-relaxed text-red-800" title={item.reason}>
              <strong>Motivo:</strong> {item.reason}
            </p>
          )}
          {item.publicationStatus === 'failed' && item.publicationError && (
            <p className="review-compact-reason mt-2 text-[11px] leading-relaxed text-amber-800" title={item.publicationError}>Publicación pendiente: {item.publicationError}</p>
          )}

          <div className="mt-auto flex flex-wrap items-center gap-1.5 pt-3">
            {item.referenceUrl && (
              <button type="button" onClick={() => setZoomedImage({ url: item.referenceUrl!, label: `Referencia de ${label}` })} className="inline-flex items-center gap-1 rounded-lg border border-slate-200 px-2 py-1.5 text-[11px] font-semibold text-slate-600 hover:border-violet-300">
                <Maximize2 className="h-3 w-3" /> Referencia
              </button>
            )}
            {!isLocked && (
              <>
                <button type="button" onClick={() => decideIds([item.id], 'approved')} disabled={isSaving} className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold disabled:opacity-50 ${item.status === 'approved' ? 'border-emerald-600 bg-emerald-600 text-white' : 'border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100'}`}>
                  {isItemSaving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Check className="h-3 w-3" />} Aprobar
                </button>
                <button type="button" onClick={() => openRejectDialog([item.id], label)} disabled={isSaving} className={`inline-flex items-center gap-1 rounded-lg border px-2 py-1.5 text-[11px] font-semibold disabled:opacity-50 ${item.status === 'rejected' ? 'border-red-600 bg-red-600 text-white' : 'border-red-200 bg-red-50 text-red-700 hover:bg-red-100'}`}>
                  <X className="h-3 w-3" /> Rechazar
                </button>
              </>
            )}
          </div>
        </div>
      </article>
    );
  };

  if (isLoading && !batch) {
    return (
      <main className={`creative-review-portal flex items-center justify-center p-6 ${embedded ? 'creative-review-portal--studio min-h-[420px] rounded-2xl border border-violet-100' : 'min-h-screen'}`}>
        <div className="review-state-panel rounded-2xl bg-white px-8 py-7 text-center shadow-xl">
          <Loader2 className="mx-auto h-8 w-8 animate-spin text-violet-600" />
          <p className="mt-3 text-sm font-medium text-slate-700">{embedded ? 'Cargando creativos…' : 'Preparando tu revisión…'}</p>
        </div>
      </main>
    );
  }

  if (loadError || !batch) {
    return (
      <main className={`creative-review-portal flex items-center justify-center p-6 ${embedded ? 'creative-review-portal--studio min-h-[420px] rounded-2xl border border-violet-100' : 'min-h-screen'}`}>
        <section className="review-state-panel w-full max-w-md rounded-2xl bg-white p-7 text-center shadow-xl">
          <AlertCircle className="mx-auto h-10 w-10 text-red-500" />
          <h1 className="mt-4 text-xl font-semibold text-slate-900">{embedded ? 'No pudimos cargar los creativos' : 'No pudimos abrir esta revisión'}</h1>
          <p className="mt-2 text-sm leading-relaxed text-slate-600">
            {loadError || 'El enlace no es válido, venció o fue revocado.'}
          </p>
          <button
            type="button"
            onClick={loadReview}
            className="mt-5 inline-flex items-center gap-2 rounded-xl bg-violet-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-violet-700"
          >
            <RefreshCw className="h-4 w-4" /> Reintentar
          </button>
        </section>
      </main>
    );
  }

  const selectedCount = selectedIds.size;
  const allVisibleSelected = selectableVisibleItems.length > 0
    && selectableVisibleItems.every((item) => selectedIds.has(item.id));

  return (
    <div className={`creative-review-portal pb-12 text-slate-900 ${embedded ? 'creative-review-portal--studio min-h-[520px] overflow-hidden rounded-2xl border border-violet-100' : 'min-h-screen'}`}>
      <header className="review-shell-header border-b border-violet-100 bg-white/95 shadow-sm backdrop-blur">
        <div className="mx-auto flex max-w-[1500px] flex-col gap-4 px-4 py-5 sm:px-6 lg:flex-row lg:items-center lg:justify-between lg:px-8">
          <div className="flex items-center gap-4">
            {!embedded && (
              <div className="rounded-xl bg-violet-700 px-3 py-2">
                <img src="/branding/cabify-logo-white-rgb.png" alt="Cabify" className="h-7 w-auto" />
              </div>
            )}
            <div>
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-violet-600">Revisión de creativos</p>
              <h1 className="mt-0.5 text-2xl font-semibold text-slate-900">{batch.title}</h1>
              <p className="mt-1 text-sm text-slate-600">{batch.category} · {batch.plaza}</p>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <Counter label="Total" value={summary.total} tone="neutral" />
            <Counter label="Pendientes" value={summary.pending} tone="pending" />
            <Counter label="Aprobados" value={summary.approved} tone="approved" />
            <Counter label="Rechazados" value={summary.rejected} tone="rejected" />
          </div>
        </div>
      </header>

      <main className="review-shell-main mx-auto max-w-[1500px] space-y-5 px-4 py-6 sm:px-6 lg:px-8">
        {batch.status === 'published' && (
          <div className="review-notice flex flex-col gap-3 rounded-2xl border border-emerald-200 bg-emerald-50 p-5 sm:flex-row sm:items-center">
            <CheckCircle2 className="h-7 w-7 shrink-0 text-emerald-600" />
            <div>
              <h2 className="font-semibold text-emerald-900">Revisión completada</h2>
              <p className="mt-1 text-sm text-emerald-800">Las decisiones quedaron bloqueadas y los creativos aprobados se publicaron en Creative Library.</p>
            </div>
          </div>
        )}
        {batch.status === 'publishing' && (
          <div className="review-notice flex flex-col gap-3 rounded-2xl border border-violet-200 bg-violet-50 p-5 sm:flex-row sm:items-center">
            <Loader2 className="h-7 w-7 shrink-0 animate-spin text-violet-600" />
            <div className="flex-1">
              <h2 className="font-semibold text-violet-900">Publicando creativos aprobados</h2>
              <p className="mt-1 text-sm text-violet-800">Tus decisiones ya están guardadas. Podés cerrar esta ventana con tranquilidad.</p>
            </div>
            <button type="button" onClick={loadReview} disabled={isLoading} className="inline-flex items-center gap-2 self-start rounded-lg border border-violet-300 bg-white px-3 py-2 text-sm font-semibold text-violet-700">
              <RefreshCw className={`h-4 w-4 ${isLoading ? 'animate-spin' : ''}`} /> Actualizar
            </button>
          </div>
        )}
        {batch.status === 'publish_failed' && (
          <div className="review-notice flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-5">
            <TriangleAlert className="h-6 w-6 shrink-0 text-amber-600" />
            <div>
              <h2 className="font-semibold text-amber-900">La revisión quedó guardada</h2>
              <p className="mt-1 text-sm text-amber-800">Algunos creativos no pudieron publicarse. El equipo de Cabify puede reintentar sólo los fallidos; no necesitás volver a revisar.</p>
            </div>
          </div>
        )}
        {batch.status === 'revoked' && (
          <div className="review-notice flex gap-3 rounded-2xl border border-red-200 bg-red-50 p-5">
            <Lock className="h-6 w-6 shrink-0 text-red-600" />
            <div><h2 className="font-semibold text-red-900">Acceso revocado</h2><p className="mt-1 text-sm text-red-800">Esta tanda ya no admite cambios.</p></div>
          </div>
        )}

        {!isLocked && (
          <section className="review-toolbar rounded-2xl border border-violet-100 bg-white p-4 shadow-sm">
            <div className="flex flex-col gap-3 xl:flex-row xl:items-end xl:justify-between">
              <div className="flex flex-wrap gap-2">
                {STATUS_FILTERS.map((filter) => {
                  const count = filter.value === 'all' ? summary.total : summary[filter.value];
                  return (
                    <button
                      key={filter.value}
                      type="button"
                      onClick={() => setStatusFilter(filter.value)}
                      data-active={statusFilter === filter.value}
                      className="review-filter-pill"
                    >
                      {filter.label} <span className="opacity-70">{count}</span>
                    </button>
                  );
                })}
                <label className="relative">
                  <span className="sr-only">Filtrar por ratio</span>
                  <select
                    value={ratioFilter}
                    onChange={(event) => setRatioFilter(event.target.value)}
                    className="review-filter-select h-9 appearance-none rounded-full border border-slate-200 bg-white pl-3 pr-8 text-sm font-medium text-slate-700 outline-none hover:border-violet-300 focus:border-violet-500"
                  >
                    <option value="all">Todos los ratios</option>
                    {ratios.map((ratio) => <option key={ratio} value={ratio}>{ratio}</option>)}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-slate-400" />
                </label>
                <label className="relative max-w-xs">
                  <span className="sr-only">Filtrar por familia</span>
                  <select
                    value={familyFilter}
                    onChange={(event) => setFamilyFilter(event.target.value)}
                    className="review-filter-select h-9 max-w-xs appearance-none truncate rounded-full border border-slate-200 bg-white pl-3 pr-8 text-sm font-medium text-slate-700 outline-none hover:border-violet-300 focus:border-violet-500"
                  >
                    <option value="all">Todas las familias</option>
                    {families.map((familyId) => {
                      const familyLabel = familyLabels.get(familyId) || 'Familia';
                      const familyContext = getFamilyContextLabel(allFamilies.get(familyId) || []);
                      return (
                        <option key={familyId} value={familyId}>
                          {familyLabel}{familyContext ? ` · ${familyContext}` : ''}
                        </option>
                      );
                    })}
                  </select>
                  <ChevronDown className="pointer-events-none absolute right-2.5 top-2.5 h-4 w-4 text-slate-400" />
                </label>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {selectableVisibleItems.length > 0 && (
                  <button type="button" onClick={selectVisible} disabled={isSaving} className="inline-flex items-center gap-1.5 rounded-lg border border-slate-200 px-3 py-2 text-sm font-medium text-slate-700 hover:border-violet-300 disabled:opacity-40">
                    {allVisibleSelected ? <SquareCheckBig className="h-4 w-4 text-violet-600" /> : <Square className="h-4 w-4" />}
                    {allVisibleSelected ? 'Quitar pendientes' : 'Seleccionar pendientes'}
                  </button>
                )}
                {selectedCount > 0 && (
                  <>
                    <span className="text-sm font-medium text-slate-600">{selectedCount} seleccionados</span>
                    <button type="button" onClick={() => decideIds(Array.from(selectedIds), 'approved')} disabled={isSaving} className="inline-flex items-center gap-1.5 rounded-lg bg-emerald-600 px-3 py-2 text-sm font-semibold text-white hover:bg-emerald-700 disabled:opacity-50"><Check className="h-4 w-4" /> Aprobar</button>
                    <button type="button" onClick={() => openRejectDialog(Array.from(selectedIds), `${selectedCount} creativos seleccionados`)} disabled={isSaving} className="inline-flex items-center gap-1.5 rounded-lg bg-red-600 px-3 py-2 text-sm font-semibold text-white hover:bg-red-700 disabled:opacity-50"><X className="h-4 w-4" /> Rechazar</button>
                  </>
                )}
              </div>
            </div>
          </section>
        )}

        {isSaving && (
          <div className="review-notice flex items-center gap-2 rounded-xl border border-violet-200 bg-violet-50 px-4 py-3 text-sm font-medium text-violet-800" role="status">
            <Loader2 className="h-4 w-4 animate-spin" /> Guardando {savingIds.size === 1 ? 'decisión' : 'decisiones'}…
          </div>
        )}
        {saveError && (
          <div className="review-notice flex flex-col gap-3 rounded-xl border border-red-200 bg-red-50 px-4 py-3 sm:flex-row sm:items-center" role="alert">
            <AlertCircle className="h-5 w-5 shrink-0 text-red-600" />
            <p className="flex-1 text-sm text-red-800"><strong>No se guardaron los cambios.</strong> {saveError}</p>
            {failedDecisions && (
              <button type="button" onClick={() => applyDecisions(failedDecisions)} className="inline-flex items-center gap-1.5 self-start rounded-lg border border-red-300 bg-white px-3 py-2 text-sm font-semibold text-red-700">
                <RefreshCw className="h-4 w-4" /> Reintentar
              </button>
            )}
          </div>
        )}
        {partialFamilyCount > 0 && (
          <div className="review-notice flex gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3">
            <TriangleAlert className="h-5 w-5 shrink-0 text-amber-600" />
            <p className="text-sm text-amber-900">
              {partialFamilyCount === 1 ? 'Hay una familia con aprobación parcial.' : `Hay ${partialFamilyCount} familias con aprobación parcial.`}
              {' '}Google puede usar piezas individuales; Meta sólo podrá usar familias con todos sus ratios aprobados.
            </p>
          </div>
        )}

        {visibleFamilies.length > 0 ? visibleFamilies.map(([familyId, familyItems]) => {
          const completeFamily = allFamilies.get(familyId) || familyItems;
          const approvedCount = completeFamily.filter((item) => item.status === 'approved').length;
          const rejectedCount = completeFamily.filter((item) => item.status === 'rejected').length;
          const pendingCount = completeFamily.filter((item) => item.status === 'pending').length;
          const missingMetaRatios = getMissingMetaRatios(completeFamily);
          const isPartial = missingMetaRatios.length > 0;
          const pendingItems = familyItems.filter((item) => item.status === 'pending' || savingIds.has(item.id));
          const reviewedItems = familyItems.filter((item) => (
            (item.status === 'approved' || item.status === 'rejected') && !savingIds.has(item.id)
          ));
          const visibleApprovedCount = reviewedItems.filter((item) => item.status === 'approved').length;
          const visibleRejectedCount = reviewedItems.filter((item) => item.status === 'rejected').length;
          const familyLabel = familyLabels.get(familyId) || 'Familia';
          const familyContext = getFamilyContextLabel(completeFamily);
          return (
            <section key={familyId} className="review-family-panel overflow-hidden rounded-2xl border border-violet-100 bg-white shadow-sm">
              <div className="review-family-header flex flex-col gap-3 border-b border-slate-100 bg-slate-50/80 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:px-5">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2">
                    <h2 className="text-base font-semibold text-slate-900">{familyLabel}</h2>
                    {isPartial && <span title={`Ratios faltantes para Meta: ${missingMetaRatios.join(', ')}`} className="rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-xs font-medium text-amber-700">Faltan ratios: {missingMetaRatios.join(', ')}</span>}
                  </div>
                  <p className="mt-1 text-xs text-slate-500">
                    {[
                      familyContext,
                      formatCount(completeFamily.length, 'pieza', 'piezas'),
                      formatCount(approvedCount, 'aprobada', 'aprobadas'),
                      formatCount(rejectedCount, 'rechazada', 'rechazadas'),
                      formatCount(pendingCount, 'pendiente', 'pendientes'),
                    ].filter(Boolean).join(' · ')}
                  </p>
                </div>
                {!isLocked && (
                  <div className="flex shrink-0 gap-2">
                    <button type="button" onClick={() => decideIds(completeFamily.map((item) => item.id), 'approved')} disabled={isSaving} className="inline-flex items-center gap-1.5 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-xs font-semibold text-emerald-700 hover:bg-emerald-100 disabled:opacity-50"><Check className="h-3.5 w-3.5" /> Aprobar familia</button>
                    <button type="button" onClick={() => openRejectDialog(completeFamily.map((item) => item.id), familyLabel)} disabled={isSaving} className="inline-flex items-center gap-1.5 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs font-semibold text-red-700 hover:bg-red-100 disabled:opacity-50"><X className="h-3.5 w-3.5" /> Rechazar familia</button>
                  </div>
                )}
              </div>
              <div className="space-y-4 p-4 xl:p-5">
                {pendingItems.length > 0 && (
                  <div className="grid gap-4 xl:grid-cols-2">
                    {pendingItems.map(renderPendingCreativeCard)}
                  </div>
                )}

                {reviewedItems.length > 0 && (
                  <ReviewedDetails
                    key={`reviewed-${familyId}-${statusFilter}`}
                    className="review-reviewed-group group overflow-hidden rounded-xl border border-slate-200 bg-slate-50/60"
                    initiallyOpen={statusFilter === 'approved' || statusFilter === 'rejected'}
                  >
                    <summary className="review-reviewed-summary flex cursor-pointer list-none items-center justify-between gap-3 px-4 py-3 marker:hidden hover:bg-slate-100/80">
                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
                        <span className="text-sm font-semibold text-slate-800">Creativos revisados</span>
                        <span className="text-xs text-slate-500">
                          {formatCount(reviewedItems.length, 'revisado', 'revisados')} · {formatCount(visibleApprovedCount, 'aprobado', 'aprobados')} · {formatCount(visibleRejectedCount, 'rechazado', 'rechazados')}
                        </span>
                      </div>
                      <ChevronDown className="h-4 w-4 shrink-0 text-slate-500 transition-transform group-open:rotate-180" />
                    </summary>
                    <div className="review-reviewed-list grid gap-3 border-t border-slate-200 bg-white p-3 md:grid-cols-2 2xl:grid-cols-3">
                      {reviewedItems.map(renderReviewedCreativeCard)}
                    </div>
                  </ReviewedDetails>
                )}
              </div>
            </section>
          );
        }) : (
          <section className="review-empty-state rounded-2xl border border-violet-100 bg-white px-5 py-14 text-center shadow-sm">
            <ImageIcon className="mx-auto h-9 w-9 text-slate-400" />
            <h2 className="mt-3 font-semibold text-slate-800">No hay creativos para estos filtros</h2>
            <p className="mt-1 text-sm text-slate-500">Probá cambiar el estado o el ratio seleccionado.</p>
          </section>
        )}

        {!isLocked && (
          <form onSubmit={finalizeReview} className="review-finalize-panel rounded-2xl border border-violet-200 bg-white p-5 shadow-sm sm:p-6">
            <div className="flex flex-col gap-5 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <div className="flex items-center gap-2">
                  <Save className="h-5 w-5 text-violet-600" />
                  <h2 className="text-lg font-semibold text-slate-900">Finalizar revisión</h2>
                </div>
                <p className="mt-2 text-sm leading-relaxed text-slate-600">
                  Al finalizar, las decisiones se bloquean y sólo los creativos aprobados se envían a Creative Library.
                  {summary.pending > 0 && <strong className="text-amber-700"> Todavía faltan {summary.pending} {summary.pending === 1 ? 'decisión' : 'decisiones'}.</strong>}
                </p>
                {batch.expiresAt && <p className="mt-2 text-xs text-slate-500">Este enlace vence el {formatDate(batch.expiresAt)}.</p>}
              </div>
              <div className="grid w-full gap-3 sm:grid-cols-2 lg:max-w-2xl">
                <label className="text-sm font-medium text-slate-700">
                  Nombre y apellido
                  <input value={reviewerName} onChange={(event) => setReviewerName(event.target.value)} autoComplete="name" placeholder="Tu nombre" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100" />
                </label>
                <label className="text-sm font-medium text-slate-700">
                  Email
                  <input type="email" value={reviewerEmail} onChange={(event) => setReviewerEmail(event.target.value)} autoComplete="email" placeholder="nombre@empresa.com" className="mt-1 w-full rounded-xl border border-slate-200 bg-white px-3 py-2.5 text-sm text-slate-900 outline-none focus:border-violet-500 focus:ring-2 focus:ring-violet-100" />
                </label>
                <button type="submit" disabled={summary.pending > 0 || isSaving || isFinalizing || activeItems.length === 0} className="inline-flex items-center justify-center gap-2 rounded-xl bg-violet-600 px-4 py-3 text-sm font-semibold text-white hover:bg-violet-700 disabled:cursor-not-allowed disabled:bg-slate-200 disabled:text-slate-500 sm:col-span-2">
                  {isFinalizing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />}
                  {isFinalizing ? 'Finalizando…' : 'Finalizar y publicar aprobados'}
                </button>
              </div>
            </div>
            {finalizeError && <div className="mt-4 flex items-center gap-2 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700" role="alert"><AlertCircle className="h-4 w-4 shrink-0" /> {finalizeError}</div>}
          </form>
        )}
      </main>

      {rejectDialog && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-labelledby="reject-title" onClick={() => setRejectDialog(null)}>
          <form onSubmit={submitRejection} onClick={(event) => event.stopPropagation()} className="review-dialog-card w-full max-w-lg rounded-2xl bg-white p-6 shadow-2xl">
            <div className="flex items-start justify-between gap-4">
              <div><p className="text-xs font-semibold uppercase tracking-wide text-red-600">Rechazar</p><h2 id="reject-title" className="mt-1 text-xl font-semibold text-slate-900">{rejectDialog.title}</h2></div>
              <button type="button" onClick={() => setRejectDialog(null)} aria-label="Cerrar" className="flex h-8 w-8 items-center justify-center rounded-full bg-slate-100 text-slate-600 hover:bg-slate-200"><X className="h-4 w-4" /></button>
            </div>
            <p className="mt-3 text-sm text-slate-600">El motivo se compartirá con el equipo creativo y se aplicará a {rejectDialog.ids.length === 1 ? 'esta pieza' : `las ${rejectDialog.ids.length} piezas`}.</p>
            <label className="mt-5 block text-sm font-semibold text-slate-700">
              ¿Qué hay que corregir?
              <textarea autoFocus value={rejectReason} onChange={(event) => { setRejectReason(event.target.value); setRejectError(null); }} rows={5} placeholder="Describí el cambio de forma concreta…" className="mt-1 w-full resize-y rounded-xl border border-slate-200 px-3 py-3 text-sm text-slate-900 outline-none focus:border-red-400 focus:ring-2 focus:ring-red-100" />
            </label>
            {rejectError && <p className="mt-2 text-sm font-medium text-red-600">{rejectError}</p>}
            <div className="mt-5 flex justify-end gap-2">
              <button type="button" onClick={() => setRejectDialog(null)} className="rounded-xl border border-slate-200 px-4 py-2.5 text-sm font-semibold text-slate-700 hover:bg-slate-50">Cancelar</button>
              <button type="submit" className="inline-flex items-center gap-2 rounded-xl bg-red-600 px-4 py-2.5 text-sm font-semibold text-white hover:bg-red-700"><XCircle className="h-4 w-4" /> Confirmar rechazo</button>
            </div>
          </form>
        </div>
      )}

      {zoomedImage && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/90 p-4 backdrop-blur-sm" role="dialog" aria-modal="true" aria-label={zoomedImage.label} onClick={() => setZoomedImage(null)}>
          <div className="relative flex max-h-[94vh] max-w-[94vw] items-center justify-center" onClick={(event) => event.stopPropagation()}>
            <img src={getPreviewSrc(zoomedImage.url)} alt={zoomedImage.label} className="max-h-[90vh] max-w-[90vw] rounded-xl object-contain shadow-2xl" />
            <button type="button" onClick={() => setZoomedImage(null)} aria-label="Cerrar imagen ampliada" className="absolute right-2 top-2 flex h-10 w-10 items-center justify-center rounded-full bg-slate-950/80 text-white hover:bg-slate-800"><X className="h-5 w-5" /></button>
          </div>
        </div>,
        document.body,
      )}
    </div>
  );
}
