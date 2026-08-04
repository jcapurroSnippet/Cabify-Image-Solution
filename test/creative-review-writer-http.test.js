import assert from 'node:assert/strict';
import test from 'node:test';

test('review runtime protects and validates the internal writer endpoint', async (t) => {
  const previousMode = process.env.APP_MODE;
  const previousSecret = process.env.CREATIVE_REVIEW_WRITER_SECRET;
  process.env.APP_MODE = 'review';
  process.env.CREATIVE_REVIEW_WRITER_SECRET = 'writer-secret-with-at-least-32-characters';

  const { app } = await import(`../server/index.js?writer-test=${Date.now()}`);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(async () => {
    await new Promise((resolve) => server.close(resolve));
    if (previousMode === undefined) delete process.env.APP_MODE;
    else process.env.APP_MODE = previousMode;
    if (previousSecret === undefined) delete process.env.CREATIVE_REVIEW_WRITER_SECRET;
    else process.env.CREATIVE_REVIEW_WRITER_SECRET = previousSecret;
  });

  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/api/creative-reviews/internal/writer`;
  const unauthorized = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'ensureReviewSheets', input: {} }),
  });
  assert.equal(unauthorized.status, 401);
  assert.equal((await unauthorized.json()).code, 'REVIEW_WRITER_UNAUTHORIZED');

  const invalidAction = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-creative-review-writer-secret': process.env.CREATIVE_REVIEW_WRITER_SECRET,
    },
    body: JSON.stringify({ action: 'notAllowed', input: {} }),
  });
  assert.equal(invalidAction.status, 400);
  assert.equal((await invalidAction.json()).code, 'REVIEW_WRITER_ACTION_INVALID');
});
