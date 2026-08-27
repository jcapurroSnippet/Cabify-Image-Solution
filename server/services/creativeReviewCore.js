import crypto from 'node:crypto';

export const REVIEW_BATCH_STATUSES = Object.freeze([
  'draft',
  'in_review',
  'publishing',
  'published',
  'publish_failed',
  'revoked',
]);

export const REVIEW_ITEM_DECISIONS = Object.freeze([
  'pending',
  'approved',
  'rejected',
  'superseded',
]);

export const REVIEW_PUBLIC_BATCH_STATUSES = new Set(['in_review', 'publishing', 'published', 'publish_failed']);
export const DEFAULT_REVIEW_LINK_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;
const REVIEW_TRANSITIONS = Object.freeze({
  draft: new Set(['in_review', 'revoked']),
  in_review: new Set(['publishing', 'revoked']),
  publishing: new Set(['published', 'publish_failed', 'revoked']),
  publish_failed: new Set(['publishing', 'revoked']),
  published: new Set(['revoked']),
  revoked: new Set(),
});

export class CreativeReviewError extends Error {
  constructor(message, code = 'CREATIVE_REVIEW_ERROR', statusCode = 400, details = {}) {
    super(message);
    this.name = 'CreativeReviewError';
    this.code = code;
    this.statusCode = statusCode;
    this.details = details;
  }
}

export class ReviewVersionConflictError extends CreativeReviewError {
  constructor(itemId, expectedVersion, actualVersion) {
    super(
      `Review item ${itemId} changed from version ${expectedVersion} to ${actualVersion}.`,
      'REVIEW_VERSION_CONFLICT',
      409,
      { itemId, expectedVersion, actualVersion },
    );
    this.name = 'ReviewVersionConflictError';
  }
}

const clean = (value) => String(value ?? '').trim();
const cleanLower = (value) => clean(value).toLowerCase();
const cleanInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};

export const normalizeReviewSourceType = (value) => {
  const sourceType = cleanLower(value).replace(/[\s-]+/g, '_');
  if (['batch_sheets', 'batch_from_sheets', 'sheets_batch'].includes(sourceType)) return 'batch_sheets';
  if (['editor_batch', 'batch_editor'].includes(sourceType)) return 'editor_batch';
  if (['legacy', 'legacy_sheet', 'legacy_import'].includes(sourceType)) return 'legacy_import';
  return sourceType || 'manual';
};

export const normalizeReviewDecision = (value, { allowSuperseded = false } = {}) => {
  const decision = cleanLower(value) || 'pending';
  const allowed = allowSuperseded ? REVIEW_ITEM_DECISIONS : REVIEW_ITEM_DECISIONS.slice(0, 3);
  if (!allowed.includes(decision)) {
    throw new CreativeReviewError(
      `Invalid review decision "${decision}".`,
      'INVALID_REVIEW_DECISION',
      400,
      { decision },
    );
  }
  return decision;
};

export const normalizeReviewBatchStatus = (value) => {
  const status = cleanLower(value) || 'draft';
  if (!REVIEW_BATCH_STATUSES.includes(status)) {
    throw new CreativeReviewError(
      `Invalid review batch status "${status}".`,
      'INVALID_REVIEW_BATCH_STATUS',
      400,
      { status },
    );
  }
  return status;
};

export const canTransitionReviewBatch = (from, to) =>
  REVIEW_TRANSITIONS[normalizeReviewBatchStatus(from)]?.has(normalizeReviewBatchStatus(to)) ?? false;

export const transitionReviewBatch = (batch, nextStatus, now = new Date()) => {
  const from = normalizeReviewBatchStatus(batch?.status);
  const to = normalizeReviewBatchStatus(nextStatus);
  if (from === to) return { ...batch };
  if (!canTransitionReviewBatch(from, to)) {
    throw new CreativeReviewError(
      `Review batch cannot transition from ${from} to ${to}.`,
      'INVALID_REVIEW_BATCH_TRANSITION',
      409,
      { from, to },
    );
  }

  const timestamp = new Date(now).toISOString();
  return {
    ...batch,
    status: to,
    version: cleanInteger(batch?.version, 1) + 1,
    updated_at: timestamp,
    ...(to === 'in_review' && !batch?.issued_at ? { issued_at: timestamp } : {}),
    ...(to === 'revoked' ? { revoked_at: timestamp } : {}),
    ...(to === 'published' ? { published_at: timestamp } : {}),
  };
};

export const createReviewToken = (spreadsheetId, randomValue) => {
  const cleanSpreadsheetId = clean(spreadsheetId);
  if (!/^[a-zA-Z0-9_-]+$/.test(cleanSpreadsheetId)) {
    throw new CreativeReviewError('A valid spreadsheetId is required.', 'INVALID_SPREADSHEET_ID');
  }

  const random = randomValue === undefined
    ? crypto.randomBytes(32).toString('base64url')
    : Buffer.isBuffer(randomValue)
      ? randomValue.toString('base64url')
      : clean(randomValue);
  if (!/^[a-zA-Z0-9_-]{16,}$/.test(random)) {
    throw new CreativeReviewError('Review token randomness is too short.', 'INVALID_REVIEW_TOKEN_RANDOMNESS');
  }
  return `${cleanSpreadsheetId}.${random}`;
};

export const hashReviewToken = (token) =>
  crypto.createHash('sha256').update(clean(token), 'utf8').digest('hex');

export const parseReviewToken = (token) => {
  const text = clean(token);
  const separatorIndex = text.indexOf('.');
  const spreadsheetId = separatorIndex > 0 ? text.slice(0, separatorIndex) : '';
  const secret = separatorIndex > 0 ? text.slice(separatorIndex + 1) : '';
  if (!/^[a-zA-Z0-9_-]+$/.test(spreadsheetId) || !/^[a-zA-Z0-9_-]{16,}$/.test(secret)) {
    throw new CreativeReviewError('Invalid review token.', 'INVALID_REVIEW_TOKEN', 401);
  }
  return { spreadsheetId, secret, tokenHash: hashReviewToken(text) };
};

export const getReviewExpiry = (now = new Date(), expiresInDays = DEFAULT_REVIEW_LINK_DAYS) => {
  const days = Number(expiresInDays);
  if (!Number.isFinite(days) || days <= 0 || days > 365) {
    throw new CreativeReviewError('Review link expiry must be between 1 and 365 days.', 'INVALID_REVIEW_EXPIRY');
  }
  return new Date(new Date(now).getTime() + days * DAY_MS).toISOString();
};

export const isReviewLinkActive = (batch, token, now = new Date()) => {
  if (!batch || !REVIEW_PUBLIC_BATCH_STATUSES.has(cleanLower(batch.status))) return false;
  if (!batch.token_hash || !token) return false;
  const expiresAt = Date.parse(batch.expires_at || '');
  if (!Number.isFinite(expiresAt) || expiresAt <= new Date(now).getTime()) return false;

  const expected = Buffer.from(clean(batch.token_hash), 'hex');
  const actual = Buffer.from(hashReviewToken(token), 'hex');
  return expected.length === actual.length && expected.length > 0 && crypto.timingSafeEqual(expected, actual);
};

export const summarizeReviewItems = (items = []) => {
  const summary = { total: 0, pending: 0, approved: 0, rejected: 0, superseded: 0 };
  for (const item of items || []) {
    const decision = normalizeReviewDecision(item?.decision, { allowSuperseded: true });
    summary[decision] += 1;
    if (decision !== 'superseded') summary.total += 1;
  }
  summary.complete = summary.total > 0 && summary.pending === 0;
  return summary;
};

const getDecisionItemId = (decision) => clean(
  decision?.review_item_id || decision?.reviewItemId || decision?.itemId || decision?.id,
);

const getItemId = (item) => clean(item?.review_item_id || item?.reviewItemId || item?.itemId || item?.id);

const sameDecision = (item, decision, feedback) =>
  cleanLower(item?.decision) === decision && clean(item?.feedback) === feedback;

export const applyReviewDecisions = (
  items = [],
  decisions = [],
  { reviewerName = '', reviewerEmail = '', now = new Date(), allowSuperseded = false } = {},
) => {
  if (!Array.isArray(decisions) || decisions.length === 0) {
    throw new CreativeReviewError('At least one review decision is required.', 'REVIEW_DECISIONS_REQUIRED');
  }

  const itemsById = new Map((items || []).map((item) => [getItemId(item), item]));
  const duplicateIds = new Set();
  const seenIds = new Set();
  for (const decision of decisions) {
    const itemId = getDecisionItemId(decision);
    if (seenIds.has(itemId)) duplicateIds.add(itemId);
    seenIds.add(itemId);
  }
  if (duplicateIds.size > 0) {
    throw new CreativeReviewError(
      `Duplicate decisions were provided for: ${[...duplicateIds].join(', ')}.`,
      'DUPLICATE_REVIEW_DECISION',
    );
  }

  const timestamp = new Date(now).toISOString();
  const changedById = new Map();
  const updated = [];
  const unchanged = [];

  for (const input of decisions) {
    const itemId = getDecisionItemId(input);
    const item = itemsById.get(itemId);
    if (!itemId || !item) {
      throw new CreativeReviewError(`Review item ${itemId || '(missing id)'} was not found.`, 'REVIEW_ITEM_NOT_FOUND', 404);
    }
    if (cleanLower(item.decision) === 'superseded') {
      throw new CreativeReviewError(`Review item ${itemId} was superseded.`, 'REVIEW_ITEM_SUPERSEDED', 409);
    }

    // `superseded` is the internal discard used by the Snippet pre-approval
    // gate. It is never accepted from the public client portal.
    const decision = normalizeReviewDecision(input.decision || input.status, { allowSuperseded });
    const feedback = clean(input.feedback ?? input.reason);
    if (decision === 'rejected' && !feedback) {
      throw new CreativeReviewError(
        `A rejection reason is required for review item ${itemId}.`,
        'REJECTION_REASON_REQUIRED',
        400,
        { itemId },
      );
    }

    const currentVersion = Math.max(1, cleanInteger(item.version, 1));
    const expectedRaw = input.expectedVersion ?? input.expected_version ?? input.version;
    const expectedVersion = expectedRaw === undefined || expectedRaw === null || expectedRaw === ''
      ? null
      : cleanInteger(expectedRaw, Number.NaN);
    if (expectedVersion !== null && expectedVersion !== currentVersion) {
      if (sameDecision(item, decision, decision === 'rejected' ? feedback : '')) {
        unchanged.push(item);
        continue;
      }
      throw new ReviewVersionConflictError(itemId, expectedVersion, currentVersion);
    }

    const normalizedFeedback = ['rejected', 'superseded'].includes(decision) ? feedback : '';
    if (sameDecision(item, decision, normalizedFeedback)) {
      unchanged.push(item);
      continue;
    }

    const next = {
      ...item,
      decision,
      feedback: normalizedFeedback,
      // Reviewer identity is trusted only from the service context (normally
      // supplied at finalization), never from a per-item public payload.
      reviewer_name: clean(reviewerName),
      reviewer_email: clean(reviewerEmail),
      decided_at: timestamp,
      updated_at: timestamp,
      version: currentVersion + 1,
    };
    changedById.set(itemId, next);
    updated.push(next);
  }

  const nextItems = (items || []).map((item) => changedById.get(getItemId(item)) || item);
  return { items: nextItems, updated, unchanged, summary: summarizeReviewItems(nextItems) };
};

export const backfillReviewDecisionAudit = (
  items = [],
  { reviewerName = '', reviewerEmail = '', now = new Date() } = {},
) => {
  const name = clean(reviewerName);
  const email = clean(reviewerEmail);
  const timestamp = new Date(now).toISOString();
  const updated = [];
  const nextItems = (items || []).map((item) => {
    const decision = normalizeReviewDecision(item?.decision, { allowSuperseded: true });
    if (!['approved', 'rejected'].includes(decision)) return item;
    if (clean(item.reviewer_name) && clean(item.reviewer_email) && clean(item.decided_at)) return item;
    const next = {
      ...item,
      reviewer_name: clean(item.reviewer_name) || name,
      reviewer_email: clean(item.reviewer_email) || email,
      decided_at: clean(item.decided_at) || timestamp,
      updated_at: timestamp,
      version: Math.max(1, cleanInteger(item.version, 1)) + 1,
    };
    updated.push(next);
    return next;
  });
  return { items: nextItems, updated };
};

export const buildReviewItemSourceKey = (item = {}) => {
  const spreadsheetId = clean(item.source_sheet_id || item.sourceSpreadsheetId);
  const tab = clean(item.source_tab || item.sourceTab || item.sheetName);
  const cell = clean(item.source_cell || item.sourceCell);
  if (spreadsheetId && tab && cell) return `${spreadsheetId}::${tab}::${cell}`;

  const output = clean(item.source_output || item.sourceOutput);
  const family = clean(item.creative_family_id || item.familyId || item.creativeFamilyId);
  const ratio = clean(item.aspect_ratio || item.ratio || item.aspectRatio);
  const variant = clean(item.variant ?? item.variantIndex);
  return output || (family && ratio && variant ? `${family}::${ratio}::${variant}` : '');
};

export const planReviewItemRegistration = (
  existingItems = [],
  incomingItem = {},
  {
    requestedCreativeVersion = 1,
    now = new Date(),
    canSupersede = () => true,
  } = {},
) => {
  const sourceKey = buildReviewItemSourceKey(incomingItem);
  if (!sourceKey) {
    throw new CreativeReviewError(
      'A review item needs an exact source cell/output or family, ratio and variant identity.',
      'REVIEW_ITEM_IDENTITY_REQUIRED',
    );
  }

  const previousVersions = (existingItems || []).filter(
    (candidate) => buildReviewItemSourceKey(candidate) === sourceKey,
  );
  const incomingHash = clean(incomingItem.image_hash || incomingItem.imageHash);
  const generationId = clean(
    incomingItem.generation_id || incomingItem.generationId || incomingItem.registration_key || incomingItem.registrationKey,
  );
  const sameGeneration = generationId
    ? previousVersions.find((candidate) => (
        clean(
          candidate.generation_id || candidate.generationId || candidate.registration_key || candidate.registrationKey,
        ) === generationId
      )) || null
    : null;
  if (sameGeneration && clean(sameGeneration.image_hash) !== incomingHash) {
    throw new CreativeReviewError(
      `Generation ${generationId} was already registered with different image content.`,
      'REVIEW_GENERATION_CONFLICT',
      409,
      { generationId, sourceKey },
    );
  }
  if (sameGeneration) {
    return {
      sourceKey,
      previousVersions,
      sameImage: sameGeneration,
      superseded: [],
      creativeVersion: Math.max(1, cleanInteger(sameGeneration.creative_version, 1)),
    };
  }

  const timestamp = new Date(now).toISOString();
  const superseded = previousVersions
    .filter((candidate) => cleanLower(candidate.decision) !== 'superseded' && canSupersede(candidate))
    .map((candidate) => ({
      ...candidate,
      decision: 'superseded',
      superseded_at: timestamp,
      updated_at: timestamp,
      version: Math.max(1, cleanInteger(candidate.version, 1)) + 1,
    }));
  const maxCreativeVersion = previousVersions.reduce(
    (max, candidate) => Math.max(max, cleanInteger(candidate.creative_version, 1)),
    0,
  );
  const requested = Math.max(1, cleanInteger(requestedCreativeVersion, 1));
  return {
    sourceKey,
    previousVersions,
    sameImage: null,
    superseded,
    creativeVersion: maxCreativeVersion > 0 ? Math.max(maxCreativeVersion + 1, requested) : requested,
  };
};

export const planReviewPublication = (items = []) => {
  const publishable = [];
  const alreadyStored = [];
  const excluded = [];
  for (const item of items || []) {
    const decision = normalizeReviewDecision(item?.decision, { allowSuperseded: true });
    if (decision !== 'approved') {
      excluded.push(item);
      continue;
    }
    if (cleanLower(item.publication_status) === 'stored' && clean(item.creative_id)) {
      alreadyStored.push(item);
      continue;
    }
    publishable.push(item);
  }
  return { publishable, alreadyStored, excluded };
};

export const buildReviewPublicationIdempotencyKey = (item = {}) => {
  const itemId = getItemId(item);
  const imageHash = clean(item.image_hash || item.imageHash);
  return itemId && imageHash ? `${itemId}:${imageHash}` : '';
};

export const assertReviewImageHash = (expectedHash, actualHash) => {
  const expected = clean(expectedHash);
  const actual = clean(actualHash);
  if (!expected) {
    throw new CreativeReviewError(
      'The reviewed image has no persisted content hash.',
      'REVIEW_IMAGE_HASH_REQUIRED',
      409,
    );
  }
  if (!actual || actual !== expected) {
    throw new CreativeReviewError(
      'The image content changed after it was registered for review.',
      'REVIEW_IMAGE_HASH_MISMATCH',
      409,
      { expectedHash: expected, actualHash: actual },
    );
  }
  return actual;
};

const REVIEW_ASPECT_RATIO_RELATIVE_TOLERANCE = 0.01;

const parseReviewAspectRatioValue = (value) => {
  const match = clean(value).match(/^(\d+(?:\.\d+)?)\s*:\s*(\d+(?:\.\d+)?)$/);
  if (!match) return null;
  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;
  return width / height;
};

const reviewAspectRatiosMatch = (expected, actual) => {
  if (expected === actual) return true;
  const expectedValue = parseReviewAspectRatioValue(expected);
  const actualValue = parseReviewAspectRatioValue(actual);
  if (!expectedValue || !actualValue) return false;
  return Math.abs(actualValue - expectedValue) / expectedValue <= REVIEW_ASPECT_RATIO_RELATIVE_TOLERANCE;
};

export const resolveVerifiedReviewAspectRatio = ({ declared, detected } = {}) => {
  const expected = clean(declared);
  const actual = clean(detected);
  if (expected && actual && !reviewAspectRatiosMatch(expected, actual)) {
    throw new CreativeReviewError(
      `Declared review ratio ${expected} does not match image ratio ${actual}.`,
      'REVIEW_ASPECT_RATIO_MISMATCH',
      400,
      { declaredAspectRatio: expected, detectedAspectRatio: actual },
    );
  }
  // Keep the canonical declared bucket when the bytes are a near-ratio export
  // (for example, 43:24 is only 0.78% wider than 16:9). This same verifier runs
  // again at publication, so the reviewed and published metadata stay stable.
  return expected || actual;
};

export const legacyReviewStatusToDecision = (status) => {
  const value = clean(status).toUpperCase();
  if (value === 'ACCEPTED' || value === 'APPROVED') return 'approved';
  if (value === 'REJECTED') return 'rejected';
  return 'pending';
};

export const normalizeImportedReviewDecision = ({
  decision = 'pending',
  feedback = '',
  reviewerName = 'Legacy import',
  reviewerEmail = '',
  now = new Date(),
} = {}) => {
  const normalizedDecision = normalizeReviewDecision(decision);
  const normalizedFeedback = normalizedDecision === 'rejected'
    ? clean(feedback) || 'Imported legacy rejection (no feedback provided).'
    : '';
  return {
    decision: normalizedDecision,
    feedback: normalizedFeedback,
    reviewer_name: normalizedDecision === 'pending' ? '' : clean(reviewerName) || 'Legacy import',
    reviewer_email: normalizedDecision === 'pending' ? '' : clean(reviewerEmail),
    decided_at: normalizedDecision === 'pending' ? '' : new Date(now).toISOString(),
  };
};

const normalizeRatio = (ratio) => {
  const value = cleanLower(ratio).replace(/\s+/g, '');
  if (['1:1', 'square'].includes(value)) return '1:1';
  if (['9:16', 'portrait', 'vertical'].includes(value)) return '9:16';
  if (['16:9', '16.9', '1.91:1', '1.91', 'landscape', '1200x628'].includes(value)) return '16:9';
  return value;
};

export const buildPartialFamilyWarnings = (
  items = [],
  requiredRatios = ['1:1', '9:16', '16:9'],
) => {
  const required = [...new Set(requiredRatios.map(normalizeRatio).filter(Boolean))];
  const families = new Map();
  // Superseded versions stay in the grouping so a ratio the family once
  // produced still counts as expected; they are excluded from approval below.
  for (const item of items || []) {
    const familyId = clean(item.creative_family_id || item.familyId || item.family_id);
    if (!familyId) continue;
    if (!families.has(familyId)) families.set(familyId, []);
    families.get(familyId).push(item);
  }

  const warnings = [];
  for (const [familyId, familyItems] of families) {
    const approved = new Set(
      familyItems
        .filter((item) => cleanLower(item.decision) === 'approved')
        .map((item) => normalizeRatio(item.aspect_ratio || item.ratio))
        .filter(Boolean),
    );
    if (approved.size === 0) continue;
    // Only a ratio the family actually produced can be missing. Generation
    // covers square and vertical alone, so demanding a landscape piece that
    // was never generated would mark every family incomplete forever.
    const produced = new Set(
      familyItems
        .map((item) => normalizeRatio(item.aspect_ratio || item.ratio))
        .filter(Boolean),
    );
    const missingRatios = required.filter((ratio) => produced.has(ratio) && !approved.has(ratio));
    if (missingRatios.length > 0) {
      warnings.push({
        code: 'INCOMPLETE_META_FAMILY',
        familyId,
        missingRatios,
        message: `Family ${familyId} is approved for Google use but is missing Meta ratios: ${missingRatios.join(', ')}.`,
      });
    }
  }
  return warnings;
};

export const createReviewId = (prefix = 'review') =>
  `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(8).toString('hex')}`;
