/**
 * Pure domain logic for the creative funnel "run".
 *
 * A run is the entity that spans the five funnel steps and is the thing the
 * individual tools were always missing: it links a low performer detected in
 * step 1 to the pieces generated for it in step 2, the review items those
 * became in steps 3-4, and the creative that finally shipped in step 5.
 *
 * Kept free of Sheets/network access so the state machine and the progress
 * accounting can be tested directly.
 */

export const RUN_STATUSES = Object.freeze([
  'draft',
  'detecting',
  'generating',
  'internal_review',
  'awaiting_client',
  'client_review',
  'placement',
  'completed',
  'failed',
]);

/** Which funnel step (1-5) each run status belongs to, for the UI stepper. */
export const RUN_STATUS_STEPS = Object.freeze({
  draft: 1,
  detecting: 1,
  generating: 2,
  internal_review: 3,
  awaiting_client: 4,
  client_review: 4,
  placement: 5,
  completed: 5,
  failed: 0,
});

const RUN_TRANSITIONS = Object.freeze({
  draft: new Set(['detecting', 'failed']),
  detecting: new Set(['generating', 'failed']),
  generating: new Set(['internal_review', 'failed']),
  internal_review: new Set(['awaiting_client', 'failed']),
  awaiting_client: new Set(['client_review', 'internal_review', 'failed']),
  client_review: new Set(['placement', 'internal_review', 'failed']),
  placement: new Set(['completed', 'failed']),
  completed: new Set([]),
  // A failed run is retried from wherever it broke.
  failed: new Set(['detecting', 'generating', 'internal_review', 'awaiting_client', 'client_review', 'placement']),
});

export const RUN_TARGET_STATUSES = Object.freeze([
  'detected',
  'generating',
  'generated',
  'no_source',
  'failed',
  'approved',
  'replaced',
]);

/** Target states that generation should not revisit — this is what makes a run resumable. */
export const TERMINAL_GENERATION_STATUSES = Object.freeze(new Set([
  'generated',
  'no_source',
  'approved',
  'replaced',
]));

export class RunOrchestratorError extends Error {
  constructor(message, code = 'RUN_ERROR', statusCode = 400, details = {}) {
    super(message);
    this.name = 'RunOrchestratorError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

const clean = (value) => String(value ?? '').trim();
const cleanLower = (value) => clean(value).toLowerCase();

export const normalizeRunStatus = (value) => {
  const status = cleanLower(value) || 'draft';
  if (!RUN_STATUSES.includes(status)) {
    throw new RunOrchestratorError(`Invalid run status "${status}".`, 'INVALID_RUN_STATUS', 400, { status });
  }
  return status;
};

export const canTransitionRun = (from, to) =>
  RUN_TRANSITIONS[normalizeRunStatus(from)]?.has(normalizeRunStatus(to)) ?? false;

export const transitionRun = (run, nextStatus, now = new Date()) => {
  const from = normalizeRunStatus(run?.status);
  const to = normalizeRunStatus(nextStatus);
  if (from === to) return { ...run };
  if (!canTransitionRun(from, to)) {
    throw new RunOrchestratorError(
      `Run cannot transition from ${from} to ${to}.`,
      'INVALID_RUN_TRANSITION',
      409,
      { from, to },
    );
  }

  const timestamp = new Date(now).toISOString();
  const version = Number.parseInt(run?.version, 10);
  return {
    ...run,
    status: to,
    version: (Number.isInteger(version) ? version : 1) + 1,
    updated_at: timestamp,
    // Clear the previous failure once the run is moving again.
    ...(to === 'failed' ? {} : { error: '' }),
    ...(to === 'client_review' && !run?.sent_at ? { sent_at: timestamp } : {}),
  };
};

/**
 * Which action `advance` should run for a given status.
 * Statuses that wait on a human return null — the funnel deliberately stops
 * there and the UI takes over.
 */
export const getNextRunAction = (status) => {
  switch (normalizeRunStatus(status)) {
    case 'draft':
      return 'detect';
    case 'detecting':
      return 'generate';
    case 'generating':
      return 'generate';
    case 'client_review':
      // Polling the review batch is safe to automate; the client is the one waiting.
      return 'sync';
    default:
      // internal_review and awaiting_client wait on Snippet, placement waits on
      // someone confirming destinations, completed/failed are done.
      return null;
  }
};

export const isRunWaitingOnPerson = (status) =>
  ['internal_review', 'awaiting_client', 'client_review', 'placement'].includes(normalizeRunStatus(status));

/**
 * Build a stable, collision-free target id. Google and Meta both hand us an
 * asset id, but a run may legitimately touch the same asset in two ad groups.
 */
export const buildRunTargetId = (asset = {}, index = 0) => {
  const base = clean(asset.id)
    || [clean(asset.adGroupId), clean(asset.adId), clean(asset.assetId)].filter(Boolean).join(':');
  return base || `target-${index + 1}`;
};

export const buildRunFamilyId = (runId, targetId) => `${clean(runId)}:${clean(targetId)}`;

export const buildRunGenerationId = (runId, targetId, ratio, variantIndex) =>
  `${clean(runId)}:${clean(targetId)}:${clean(ratio)}:${variantIndex}`;

/**
 * Recompute the run counters from its targets so the UI never has to.
 */
export const summarizeRunTargets = (targets = []) => {
  const summary = {
    total: 0,
    detected: 0,
    generating: 0,
    generated: 0,
    no_source: 0,
    failed: 0,
    approved: 0,
    replaced: 0,
  };
  for (const target of targets || []) {
    const status = cleanLower(target?.status) || 'detected';
    summary.total += 1;
    if (status in summary) summary[status] += 1;
  }
  summary.pendingGeneration = summary.detected + summary.generating + summary.failed;
  return summary;
};

/**
 * Targets that still need generation. Anything already generated, unsourceable
 * or further down the funnel is skipped, so re-running `generate` after a
 * closed tab picks up exactly where it left off instead of regenerating.
 */
export const selectTargetsForGeneration = (targets = []) =>
  (targets || []).filter((target) => !TERMINAL_GENERATION_STATUSES.has(cleanLower(target?.status) || 'detected'));

export const parseIdList = (value) => {
  if (Array.isArray(value)) return value.map(clean).filter(Boolean);
  return clean(value)
    .split(',')
    .map((entry) => entry.trim())
    .filter(Boolean);
};

export const stringifyIdList = (value) => parseIdList(value).join(',');
