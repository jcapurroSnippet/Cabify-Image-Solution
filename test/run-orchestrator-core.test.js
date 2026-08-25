import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RunOrchestratorError,
  buildRunFamilyId,
  buildRunGenerationId,
  buildRunTargetId,
  canTransitionRun,
  getNextRunAction,
  isRunWaitingOnPerson,
  normalizeRunStatus,
  parseIdList,
  selectTargetsForGeneration,
  stringifyIdList,
  summarizeRunTargets,
  transitionRun,
} from '../server/services/runOrchestratorCore.js';

const run = (overrides = {}) => ({
  run_id: 'run_1',
  status: 'draft',
  version: 1,
  ...overrides,
});

test('the run walks the funnel in order and refuses to skip steps', () => {
  assert.equal(canTransitionRun('draft', 'detecting'), true);
  assert.equal(canTransitionRun('detecting', 'generating'), true);
  assert.equal(canTransitionRun('generating', 'internal_review'), true);
  assert.equal(canTransitionRun('internal_review', 'awaiting_client'), true);
  assert.equal(canTransitionRun('awaiting_client', 'client_review'), true);
  assert.equal(canTransitionRun('client_review', 'placement'), true);
  assert.equal(canTransitionRun('placement', 'completed'), true);

  // Jumping the approval gates is exactly what this funnel exists to prevent.
  assert.equal(canTransitionRun('draft', 'placement'), false);
  assert.equal(canTransitionRun('generating', 'client_review'), false);
  assert.equal(canTransitionRun('detecting', 'completed'), false);
  assert.equal(canTransitionRun('completed', 'detecting'), false);
});

test('transitionRun bumps the version, stamps the time and clears a stale error', () => {
  const now = new Date('2026-08-20T12:00:00.000Z');
  const next = transitionRun(run({ status: 'failed', error: 'boom', version: 4 }), 'generating', now);
  assert.equal(next.status, 'generating');
  assert.equal(next.version, 5);
  assert.equal(next.updated_at, '2026-08-20T12:00:00.000Z');
  assert.equal(next.error, '');
});

test('moving to client_review stamps sent_at once and keeps the original afterwards', () => {
  const first = transitionRun(
    run({ status: 'awaiting_client' }),
    'client_review',
    new Date('2026-08-20T10:00:00.000Z'),
  );
  assert.equal(first.sent_at, '2026-08-20T10:00:00.000Z');

  const reentered = transitionRun(
    run({ status: 'client_review', sent_at: '2026-08-20T10:00:00.000Z' }),
    'internal_review',
    new Date('2026-08-20T11:00:00.000Z'),
  );
  assert.equal(reentered.sent_at, '2026-08-20T10:00:00.000Z');
});

test('an invalid transition throws instead of silently corrupting the run', () => {
  assert.throws(
    () => transitionRun(run({ status: 'draft' }), 'completed'),
    (error) => error instanceof RunOrchestratorError && error.code === 'INVALID_RUN_TRANSITION',
  );
});

test('transitioning to the same status is a no-op that does not bump the version', () => {
  const next = transitionRun(run({ status: 'generating', version: 3 }), 'generating');
  assert.equal(next.version, 3);
});

test('a failed run can be retried from wherever it broke', () => {
  assert.equal(canTransitionRun('failed', 'generating'), true);
  assert.equal(canTransitionRun('failed', 'placement'), true);
});

test('normalizeRunStatus rejects statuses that are not part of the funnel', () => {
  assert.equal(normalizeRunStatus(' Generating '), 'generating');
  assert.equal(normalizeRunStatus(''), 'draft');
  assert.throws(
    () => normalizeRunStatus('shipping'),
    (error) => error.code === 'INVALID_RUN_STATUS',
  );
});

test('the dispatcher chains detection into generation and stops at every human gate', () => {
  assert.equal(getNextRunAction('draft'), 'detect');
  assert.equal(getNextRunAction('detecting'), 'generate');
  assert.equal(getNextRunAction('generating'), 'generate');
  assert.equal(getNextRunAction('client_review'), 'sync');

  // These are the only places a person is supposed to be involved.
  assert.equal(getNextRunAction('internal_review'), null);
  assert.equal(getNextRunAction('awaiting_client'), null);
  assert.equal(getNextRunAction('placement'), null);
  assert.equal(getNextRunAction('completed'), null);

  assert.equal(isRunWaitingOnPerson('internal_review'), true);
  assert.equal(isRunWaitingOnPerson('placement'), true);
  assert.equal(isRunWaitingOnPerson('generating'), false);

  // Every status that waits on a person must have no automatic action, and vice
  // versa — client_review is the one exception, where polling is safe.
  for (const status of ['internal_review', 'awaiting_client', 'placement']) {
    assert.equal(getNextRunAction(status), null, `${status} must not auto-advance`);
    assert.equal(isRunWaitingOnPerson(status), true);
  }
});

test('generation resumes: already-generated targets are never regenerated', () => {
  const targets = [
    { target_id: 'a', status: 'generated' },
    { target_id: 'b', status: 'detected' },
    { target_id: 'c', status: 'no_source' },
    { target_id: 'd', status: 'failed' },
    { target_id: 'e', status: 'approved' },
    { target_id: 'f', status: 'replaced' },
    { target_id: 'g', status: '' },
  ];

  const pending = selectTargetsForGeneration(targets).map((target) => target.target_id);
  // 'failed' is retried, blank defaults to detected, everything terminal is skipped.
  assert.deepEqual(pending, ['b', 'd', 'g']);
});

test('summarizeRunTargets counts every state and reports what still needs generating', () => {
  const summary = summarizeRunTargets([
    { status: 'generated' },
    { status: 'generated' },
    { status: 'detected' },
    { status: 'failed' },
    { status: 'no_source' },
    { status: 'approved' },
  ]);

  assert.equal(summary.total, 6);
  assert.equal(summary.generated, 2);
  assert.equal(summary.detected, 1);
  assert.equal(summary.failed, 1);
  assert.equal(summary.no_source, 1);
  assert.equal(summary.approved, 1);
  assert.equal(summary.pendingGeneration, 2);
});

test('target ids stay unique when the same asset appears in two ad groups', () => {
  const asset = { assetId: 'asset-1', adId: 'ad-1' };
  const first = buildRunTargetId({ ...asset, adGroupId: 'ag-1' }, 0);
  const second = buildRunTargetId({ ...asset, adGroupId: 'ag-2' }, 1);
  assert.notEqual(first, second);

  // A server-supplied id always wins.
  assert.equal(buildRunTargetId({ id: 'replacement_abc' }, 0), 'replacement_abc');
  // And there is always a fallback so a target is never id-less.
  assert.equal(buildRunTargetId({}, 4), 'target-5');
});

test('family and generation ids tie a generated piece back to the low performer it replaces', () => {
  const familyId = buildRunFamilyId('run_1', 'replacement_abc');
  assert.equal(familyId, 'run_1:replacement_abc');

  const generationId = buildRunGenerationId('run_1', 'replacement_abc', '1.91:1', 2);
  assert.equal(generationId, 'run_1:replacement_abc:1.91:1:2');
  // Generation ids must be unique per ratio+variant so registration is idempotent.
  assert.notEqual(generationId, buildRunGenerationId('run_1', 'replacement_abc', '1.91:1', 3));
});

test('id lists survive the Sheets round trip', () => {
  assert.deepEqual(parseIdList('a, b ,, c'), ['a', 'b', 'c']);
  assert.deepEqual(parseIdList(['a', ' b ', '']), ['a', 'b']);
  assert.deepEqual(parseIdList(''), []);
  assert.deepEqual(parseIdList(undefined), []);
  assert.equal(stringifyIdList([' a', 'b ']), 'a,b');
});
