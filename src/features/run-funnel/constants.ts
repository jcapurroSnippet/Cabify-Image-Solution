import type { RunStatus } from './types';

export const FUNNEL_STEPS: Array<{ step: number; label: string; hint: string }> = [
  { step: 1, label: 'Detección', hint: 'Buscar creativos low performer' },
  { step: 2, label: 'Generación', hint: 'Nuevas piezas en los 3 ratios' },
  { step: 3, label: 'Pre-aprobación', hint: 'Snippet descarta lo que no va' },
  { step: 4, label: 'Aprobación Cabify', hint: 'Compartir el enlace y esperar' },
  { step: 5, label: 'Ubicación', hint: 'Confirmar destinos y reemplazar' },
];

/** Which funnel step each run status sits in — mirrors RUN_STATUS_STEPS on the server. */
export const RUN_STATUS_STEP: Record<RunStatus, number> = {
  draft: 1,
  detecting: 1,
  generating: 2,
  internal_review: 3,
  awaiting_client: 4,
  client_review: 4,
  placement: 5,
  completed: 5,
  failed: 0,
};

export const RUN_STATUS_LABELS: Record<RunStatus, string> = {
  draft: 'Sin iniciar',
  detecting: 'Detectando',
  generating: 'Generando',
  internal_review: 'Pre-aprobación Snippet',
  awaiting_client: 'Listo para enviar a Cabify',
  client_review: 'Esperando a Cabify',
  placement: 'Asignando destinos',
  completed: 'Completado',
  failed: 'Con error',
};

/** Statuses where the funnel deliberately stops and waits for a person. */
export const RUN_WAITING_STATUSES: RunStatus[] = [
  'internal_review',
  'awaiting_client',
  'client_review',
  'placement',
];

export const CATEGORY_OPTIONS = ['Generic', 'Promo', 'Alianzas'];

export const getErrorMessage = (error: unknown) =>
  error instanceof Error ? error.message : 'Ocurrió un error inesperado.';

export const formatDateTime = (value?: string) => {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return new Intl.DateTimeFormat('es-AR', { dateStyle: 'medium', timeStyle: 'short' }).format(date);
};
