import assert from 'node:assert/strict';
import test from 'node:test';
import {
  ReviewVersionConflictError,
  applyReviewDecisions,
  assertReviewImageHash,
  backfillReviewDecisionAudit,
  buildPartialFamilyWarnings,
  buildReviewItemSourceKey,
  buildReviewPublicationIdempotencyKey,
  createReviewToken,
  getReviewExpiry,
  hashReviewToken,
  isReviewLinkActive,
  legacyReviewStatusToDecision,
  normalizeImportedReviewDecision,
  parseReviewToken,
  planReviewItemRegistration,
  planReviewPublication,
  resolveVerifiedReviewAspectRatio,
  summarizeReviewItems,
  transitionReviewBatch,
} from '../server/services/creativeReviewCore.js';

const item = (overrides = {}) => ({
  review_item_id: 'item-1',
  review_batch_id: 'batch-1',
  creative_family_id: 'family-1',
  aspect_ratio: '1:1',
  version: 1,
  decision: 'pending',
  feedback: '',
  ...overrides,
});

test('review tokens carry the spreadsheet id while only their SHA-256 hash is persisted', () => {
  const token = createReviewToken('sheet_123', 'abcdefghijklmnopqrstuvwxyz123456');
  assert.equal(token, 'sheet_123.abcdefghijklmnopqrstuvwxyz123456');
  assert.deepEqual(parseReviewToken(token), {
    spreadsheetId: 'sheet_123',
    secret: 'abcdefghijklmnopqrstuvwxyz123456',
    tokenHash: hashReviewToken(token),
  });
  assert.match(hashReviewToken(token), /^[a-f0-9]{64}$/);
  assert.equal(hashReviewToken(token).includes('abcdefghijklmnopqrstuvwxyz'), false);
});

test('review links default to thirty days and remain readable after publication', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');
  const token = createReviewToken('sheet_123', 'abcdefghijklmnopqrstuvwxyz123456');
  const expiresAt = getReviewExpiry(now);
  assert.equal(expiresAt, '2026-08-29T12:00:00.000Z');
  assert.equal(isReviewLinkActive({
    status: 'published',
    token_hash: hashReviewToken(token),
    expires_at: expiresAt,
  }, token, now), true);
  assert.equal(isReviewLinkActive({
    status: 'revoked',
    token_hash: hashReviewToken(token),
    expires_at: expiresAt,
  }, token, now), false);
});

test('expired and wrong tokens cannot open a batch', () => {
  const now = new Date('2026-07-30T12:00:00.000Z');
  const validToken = createReviewToken('sheet_123', 'abcdefghijklmnopqrstuvwxyz123456');
  const otherBatchToken = createReviewToken('sheet_123', 'zyxwvutsrqponmlkjihgfedcba654321');
  const batch = {
    status: 'in_review',
    token_hash: hashReviewToken(validToken),
    expires_at: '2026-07-30T11:59:59.999Z',
  };
  assert.equal(isReviewLinkActive(batch, validToken, now), false, 'expired token');
  assert.equal(isReviewLinkActive({ ...batch, expires_at: '2026-08-01T00:00:00.000Z' }, otherBatchToken, now), false, 'wrong batch token');
});

test('batch transitions follow the review publication lifecycle', () => {
  const draft = { status: 'draft', version: 1 };
  const inReview = transitionReviewBatch(draft, 'in_review', '2026-07-30T12:00:00.000Z');
  const publishing = transitionReviewBatch(inReview, 'publishing', '2026-07-30T13:00:00.000Z');
  const failed = transitionReviewBatch(publishing, 'publish_failed', '2026-07-30T14:00:00.000Z');
  const retrying = transitionReviewBatch(failed, 'publishing', '2026-07-30T15:00:00.000Z');
  const published = transitionReviewBatch(retrying, 'published', '2026-07-30T16:00:00.000Z');
  assert.equal(published.status, 'published');
  assert.equal(published.version, 6);
  assert.throws(() => transitionReviewBatch(draft, 'published'), /cannot transition/i);
});

test('rejection requires feedback and saves reviewer audit fields', () => {
  assert.throws(
    () => applyReviewDecisions([item()], [{ itemId: 'item-1', decision: 'rejected', version: 1 }]),
    (error) => error.code === 'REJECTION_REASON_REQUIRED',
  );
  const saved = applyReviewDecisions(
    [item()],
    [{
      itemId: 'item-1',
      decision: 'rejected',
      reason: 'Logo is clipped',
      version: 1,
      reviewerName: 'Spoofed Reviewer',
      reviewerEmail: 'spoofed@example.com',
    }],
    {
      reviewerName: 'Client Reviewer',
      reviewerEmail: 'client@example.com',
      now: '2026-07-30T12:00:00.000Z',
    },
  );
  assert.equal(saved.updated[0].feedback, 'Logo is clipped');
  assert.equal(saved.updated[0].reviewer_name, 'Client Reviewer');
  assert.equal(saved.updated[0].reviewer_email, 'client@example.com');
  assert.equal(saved.updated[0].version, 2);
});

test('decision version conflicts are explicit while exact autosave retries are idempotent', () => {
  const approved = item({ decision: 'approved', version: 2 });
  const retry = applyReviewDecisions(
    [approved],
    [{ itemId: 'item-1', decision: 'approved', version: 1 }],
  );
  assert.equal(retry.updated.length, 0);
  assert.equal(retry.unchanged.length, 1);
  assert.equal(retry.unchanged[0].version, 2);
  assert.throws(
    () => applyReviewDecisions(
      [approved],
      [{ itemId: 'item-1', decision: 'rejected', reason: 'Wrong copy', version: 1 }],
    ),
    (error) => error instanceof ReviewVersionConflictError && error.statusCode === 409,
  );
});

test('finalization audit backfill assigns identity and date without changing decisions', () => {
  const audited = backfillReviewDecisionAudit([
    item({ decision: 'approved', version: 2, decided_at: '2026-07-30T11:00:00.000Z' }),
    item({ review_item_id: 'item-2', decision: 'rejected', feedback: 'Wrong CTA', version: 2 }),
    item({ review_item_id: 'item-3', decision: 'pending' }),
  ], {
    reviewerName: 'Final Reviewer',
    reviewerEmail: 'final@example.com',
    now: '2026-07-30T12:00:00.000Z',
  });
  assert.equal(audited.updated.length, 2);
  assert.equal(audited.items[0].decision, 'approved');
  assert.equal(audited.items[0].decided_at, '2026-07-30T11:00:00.000Z');
  assert.equal(audited.items[1].decided_at, '2026-07-30T12:00:00.000Z');
  assert.equal(audited.items[1].reviewer_email, 'final@example.com');
  assert.equal(audited.items[2].reviewer_email, undefined);
});

test('legacy color statuses map independently, including pending landscape cells', () => {
  assert.equal(legacyReviewStatusToDecision('ACCEPTED'), 'approved');
  assert.equal(legacyReviewStatusToDecision('REJECTED'), 'rejected');
  assert.equal(legacyReviewStatusToDecision('PENDING'), 'pending');
  assert.equal(legacyReviewStatusToDecision('UNKNOWN_COLOR'), 'pending');
});

test('legacy import preserves explicit green/red decisions and rejection feedback', () => {
  const approved = normalizeImportedReviewDecision({
    decision: legacyReviewStatusToDecision('ACCEPTED'),
    feedback: 'stale feedback',
    now: '2026-07-30T12:00:00.000Z',
  });
  const rejected = normalizeImportedReviewDecision({
    decision: legacyReviewStatusToDecision('REJECTED'),
    feedback: 'Change the CTA',
    now: '2026-07-30T12:00:00.000Z',
  });
  assert.equal(approved.decision, 'approved');
  assert.equal(approved.feedback, '');
  assert.equal(rejected.decision, 'rejected');
  assert.equal(rejected.feedback, 'Change the CTA');
  assert.equal(rejected.reviewer_name, 'Legacy import');
});

test('summaries ignore superseded versions and partial families warn for Meta', () => {
  const items = [
    item({ decision: 'approved', aspect_ratio: '1:1' }),
    item({ review_item_id: 'portrait', decision: 'rejected', aspect_ratio: '9:16', feedback: 'Wrong CTA' }),
    item({ review_item_id: 'old', decision: 'superseded', aspect_ratio: '16:9' }),
  ];
  assert.deepEqual(summarizeReviewItems(items), {
    total: 2,
    pending: 0,
    approved: 1,
    rejected: 1,
    superseded: 1,
    complete: true,
  });
  assert.deepEqual(buildPartialFamilyWarnings(items)[0].missingRatios, ['9:16', '16:9']);
});

test('regeneration in the same source cell supersedes the old decision and starts a new version', () => {
  const previous = item({
    review_item_id: 'old-item',
    source_sheet_id: 'sheet-1',
    source_tab: 'RIDERS | AR',
    source_cell: 'Q8',
    image_hash: 'old-hash',
    creative_version: 3,
    decision: 'approved',
    version: 7,
  });
  const incoming = {
    source_sheet_id: 'sheet-1',
    source_tab: 'RIDERS | AR',
    source_cell: 'Q8',
    image_hash: 'new-hash',
  };
  const plan = planReviewItemRegistration([previous], incoming, {
    now: '2026-07-30T12:00:00.000Z',
  });

  assert.equal(buildReviewItemSourceKey(incoming), 'sheet-1::RIDERS | AR::Q8');
  assert.equal(plan.creativeVersion, 4);
  assert.equal(plan.sameImage, null);
  assert.equal(plan.superseded.length, 1);
  assert.equal(plan.superseded[0].decision, 'superseded');
  assert.equal(plan.superseded[0].version, 8);
  assert.equal(plan.superseded[0].superseded_at, '2026-07-30T12:00:00.000Z');

  const regenerated = item({
    review_item_id: 'new-item',
    image_hash: incoming.image_hash,
    creative_version: plan.creativeVersion,
    generation_id: 'generation-1',
    variant: '1',
  });
  assert.equal(regenerated.decision, 'pending', 'the new version never inherits approval');

  const idempotent = planReviewItemRegistration([regenerated], {
    creative_family_id: regenerated.creative_family_id,
    aspect_ratio: regenerated.aspect_ratio,
    variant: '1',
    image_hash: regenerated.image_hash,
    generation_id: 'generation-1',
  });
  assert.equal(idempotent.sameImage.review_item_id, 'new-item');

  const identicalRegeneration = planReviewItemRegistration([regenerated], {
    creative_family_id: regenerated.creative_family_id,
    aspect_ratio: regenerated.aspect_ratio,
    variant: '1',
    image_hash: regenerated.image_hash,
    generation_id: 'generation-2',
  });
  assert.equal(identicalRegeneration.sameImage, null);
  assert.equal(identicalRegeneration.creativeVersion, regenerated.creative_version + 1);
  assert.equal(identicalRegeneration.superseded[0].decision, 'superseded');
});

test('publication plan includes approved failures, skips stored items and excludes every non-approved item', () => {
  const approvedStored = item({
    review_item_id: 'stored',
    decision: 'approved',
    publication_status: 'stored',
    creative_id: 'creative-1',
    image_hash: 'hash-1',
  });
  const approvedFailed = item({
    review_item_id: 'retry',
    decision: 'approved',
    publication_status: 'failed',
    image_hash: 'hash-2',
  });
  const rejected = item({ review_item_id: 'rejected', decision: 'rejected', feedback: 'Wrong CTA' });
  const pending = item({ review_item_id: 'pending' });
  const superseded = item({ review_item_id: 'superseded', decision: 'superseded' });

  const plan = planReviewPublication([approvedStored, approvedFailed, rejected, pending, superseded]);
  assert.deepEqual(plan.publishable.map((entry) => entry.review_item_id), ['retry']);
  assert.deepEqual(plan.alreadyStored.map((entry) => entry.review_item_id), ['stored']);
  assert.deepEqual(plan.excluded.map((entry) => entry.review_item_id), ['rejected', 'pending', 'superseded']);
  assert.equal(buildReviewPublicationIdempotencyKey(approvedFailed), 'retry:hash-2');
});

test('publication is bound to the reviewed bytes and their detected ratio', () => {
  assert.equal(assertReviewImageHash('sha256-a', 'sha256-a'), 'sha256-a');
  assert.throws(
    () => assertReviewImageHash('sha256-a', 'sha256-b'),
    (error) => error.code === 'REVIEW_IMAGE_HASH_MISMATCH' && error.statusCode === 409,
  );
  assert.equal(resolveVerifiedReviewAspectRatio({ declared: '16:9', detected: '16:9' }), '16:9');
  assert.equal(resolveVerifiedReviewAspectRatio({ declared: '', detected: '1:1' }), '1:1');
  assert.throws(
    () => resolveVerifiedReviewAspectRatio({ declared: '1:1', detected: '9:16' }),
    (error) => error.code === 'REVIEW_ASPECT_RATIO_MISMATCH',
  );
});

test('review ratio verification keeps canonical buckets for near-ratio exports', () => {
  assert.equal(
    resolveVerifiedReviewAspectRatio({ declared: '16:9', detected: '43:24' }),
    '16:9',
  );
  assert.throws(
    () => resolveVerifiedReviewAspectRatio({ declared: '16:9', detected: '3:2' }),
    (error) => error.code === 'REVIEW_ASPECT_RATIO_MISMATCH',
  );
});

test('in-memory review flow publishes approved creatives once and retries only partial failures', () => {
  let reviewed = applyReviewDecisions([
    item({ review_item_id: 'creative-a', image_hash: 'hash-a' }),
    item({ review_item_id: 'creative-b', image_hash: 'hash-b' }),
    item({ review_item_id: 'creative-c', image_hash: 'hash-c' }),
  ], [
    { itemId: 'creative-a', decision: 'approved', version: 1 },
    { itemId: 'creative-b', decision: 'approved', version: 1 },
    { itemId: 'creative-c', decision: 'rejected', reason: 'Wrong copy', version: 1 },
  ], { now: '2026-07-30T12:00:00.000Z' }).items;

  reviewed = backfillReviewDecisionAudit(reviewed, {
    reviewerName: 'Client Reviewer',
    reviewerEmail: 'client@example.com',
    now: '2026-07-30T13:00:00.000Z',
  }).items;
  assert.equal(summarizeReviewItems(reviewed).complete, true);

  const storedKeys = new Set();
  let firstAttempt = true;
  const firstPlan = planReviewPublication(reviewed);
  assert.deepEqual(firstPlan.publishable.map((entry) => entry.review_item_id), ['creative-a', 'creative-b']);
  reviewed = reviewed.map((entry) => {
    if (entry.review_item_id === 'creative-a') {
      storedKeys.add(buildReviewPublicationIdempotencyKey(entry));
      return { ...entry, publication_status: 'stored', creative_id: 'library-a' };
    }
    if (entry.review_item_id === 'creative-b' && firstAttempt) {
      firstAttempt = false;
      return { ...entry, publication_status: 'failed', publication_error: 'temporary failure' };
    }
    return entry;
  });

  const retryPlan = planReviewPublication(reviewed);
  assert.deepEqual(retryPlan.publishable.map((entry) => entry.review_item_id), ['creative-b']);
  assert.deepEqual(retryPlan.alreadyStored.map((entry) => entry.review_item_id), ['creative-a']);
  for (const entry of retryPlan.publishable) storedKeys.add(buildReviewPublicationIdempotencyKey(entry));
  assert.deepEqual([...storedKeys].sort(), ['creative-a:hash-a', 'creative-b:hash-b']);
});
