import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clearCreativeReviewPreviewAuthorization,
  clearCreativeReviewSession,
  getCreativeReviewPreviewAuthorization,
  getCreativeReviewSessionToken,
  isCreativeReviewWriterAuthorized,
  isReviewRuntimeApiAllowed,
  normalizeCreativeReviewDecisionPayload,
  parseCookies,
  serializeCreativeReviewSession,
} from '../server/services/creativeReviewHttp.js';

test('parses and reads the private creative review cookie', () => {
  assert.deepEqual(parseCookies('theme=dark; cabify_creative_review=sheet.token%2Dvalue'), {
    theme: 'dark',
    cabify_creative_review: 'sheet.token-value',
  });
  assert.equal(
    getCreativeReviewSessionToken({ headers: { cookie: 'cabify_creative_review=sheet.token' } }),
    'sheet.token',
  );
});

test('serializes expiring HttpOnly review sessions and clears them', () => {
  const session = serializeCreativeReviewSession({
    token: 'sheet.secret',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    secure: true,
  });
  assert.match(session, /cabify_creative_review=sheet.secret/);
  assert.match(session, /HttpOnly/);
  assert.match(session, /SameSite=Lax/);
  assert.match(session, /Secure/);
  assert.match(clearCreativeReviewSession({ secure: false }), /Max-Age=0/);
});

test('review runtime only exposes the client review API surface', () => {
  assert.equal(isReviewRuntimeApiAllowed('/api/creative-reviews/public'), true);
  assert.equal(isReviewRuntimeApiAllowed('/api/creative-reviews/internal/writer'), true);
  assert.equal(isReviewRuntimeApiAllowed('/api/creative-reviews/batches/batch-1'), false);
  assert.equal(isReviewRuntimeApiAllowed('/api/creative-reviews/batches/batch-1/decisions'), false);
  assert.equal(isReviewRuntimeApiAllowed('/api/image-preview'), true);
  assert.equal(isReviewRuntimeApiAllowed('/api/nano-editor'), false);
  assert.equal(isReviewRuntimeApiAllowed('/api/creative-library'), false);
  assert.equal(isReviewRuntimeApiAllowed('/api/ads/google/execute'), false);
});

test('internal review writer authentication requires an exact strong shared secret', () => {
  const configuredSecret = 'writer-secret-with-at-least-32-characters';
  assert.equal(isCreativeReviewWriterAuthorized({ providedSecret: configuredSecret, configuredSecret }), true);
  assert.equal(isCreativeReviewWriterAuthorized({ providedSecret: `${configuredSecret}x`, configuredSecret }), false);
  assert.equal(isCreativeReviewWriterAuthorized({ providedSecret: 'wrong', configuredSecret }), false);
  assert.equal(isCreativeReviewWriterAuthorized({ providedSecret: 'short', configuredSecret: 'short' }), false);
});

test('normalizes the same decision contract for public and Studio review surfaces', () => {
  assert.deepEqual(normalizeCreativeReviewDecisionPayload({
    decisions: [{
      id: 'item-1',
      decision: 'rejected',
      feedback: 'Wrong CTA',
      expected_version: 4,
    }],
  }), [{
    reviewItemId: 'item-1',
    status: 'rejected',
    reason: 'Wrong CTA',
    expectedVersion: 4,
  }]);
});

test('coalesces preview authorization reads and refreshes the short-lived cache', async () => {
  const token = 'sheet.preview-cache-secret';
  const previousTtl = process.env.CREATIVE_REVIEW_PREVIEW_AUTH_TTL_SECONDS;
  process.env.CREATIVE_REVIEW_PREVIEW_AUTH_TTL_SECONDS = '1';
  let reads = 0;
  const load = async () => {
    reads += 1;
    return {
      items: [{
        image_url: 'https://drive.google.com/file/d/image/view',
        reference_url: 'https://drive.google.com/file/d/reference/view',
      }],
    };
  };

  try {
    const authorizations = await Promise.all([
      getCreativeReviewPreviewAuthorization({ token, load }),
      getCreativeReviewPreviewAuthorization({ token, load }),
      getCreativeReviewPreviewAuthorization({ token, load }),
    ]);
    assert.equal(reads, 1);
    assert.equal(authorizations[0].has('https://drive.google.com/file/d/image/view'), true);
    assert.equal(authorizations[0].has('https://drive.google.com/file/d/reference/view'), true);

    await getCreativeReviewPreviewAuthorization({ token, load });
    assert.equal(reads, 1);

    await getCreativeReviewPreviewAuthorization({ token, load, now: Date.now() + 2_000 });
    assert.equal(reads, 2);
  } finally {
    clearCreativeReviewPreviewAuthorization(token);
    if (previousTtl === undefined) delete process.env.CREATIVE_REVIEW_PREVIEW_AUTH_TTL_SECONDS;
    else process.env.CREATIVE_REVIEW_PREVIEW_AUTH_TTL_SECONDS = previousTtl;
  }
});
