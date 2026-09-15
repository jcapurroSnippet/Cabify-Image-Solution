import assert from 'node:assert/strict';
import test from 'node:test';
import {
  CABIFY_ACCOUNTS,
  DEFAULT_CABIFY_ACCOUNT,
  normalizeCabifyAccount,
} from '../prompts/accounts.js';
import { getAccountPrompts } from '../prompts/index.js';
import {
  ASPECT_RATIO_PROMPT_PROFILE,
  extractCardCopyFromSource,
  getVariationPrompts,
} from '../server/services/imageGenerator.js';

const ACCOUNT_IDS = CABIFY_ACCOUNTS.map((account) => account.id);

test('offers Riders, Drivers and Corp, defaulting to Riders', () => {
  assert.deepEqual(ACCOUNT_IDS, ['riders', 'drivers', 'corp']);
  assert.equal(DEFAULT_CABIFY_ACCOUNT, 'riders');
});

test('a missing account means Riders, but an unknown one is refused', () => {
  assert.equal(normalizeCabifyAccount(undefined), 'riders');
  assert.equal(normalizeCabifyAccount(''), 'riders');
  assert.equal(normalizeCabifyAccount(' Drivers '), 'drivers');
  assert.equal(normalizeCabifyAccount('corp'), 'corp');
  assert.equal(normalizeCabifyAccount('taxi'), null);
  assert.equal(normalizeCabifyAccount('__proto__'), null);
  assert.throws(() => getAccountPrompts('taxi'), /Unknown Cabify account/);
  assert.throws(() => getAccountPrompts('constructor'), /Unknown Cabify account/);
});

// Guards the per-account copies once they start to diverge: a prompt the code
// reads must never go missing from one account.
test('every account defines every prompt the tools read', async () => {
  for (const id of ACCOUNT_IDS) {
    const { aspectRatio, nanoEditor } = getAccountPrompts(id);
    const editorBatch = await import(`../prompts/${id}/editorBatch.js`);

    for (const [name, prompt] of Object.entries({
      NANO_EDITOR_LIMITATIONS: nanoEditor.NANO_EDITOR_LIMITATIONS,
      CARD_COPY_EXTRACTION_PROMPT: aspectRatio.CARD_COPY_EXTRACTION_PROMPT,
      'SCENE_PROMPTS 1:1': aspectRatio.SCENE_PROMPTS?.['1:1'],
      'SCENE_PROMPTS 9:16': aspectRatio.SCENE_PROMPTS?.['9:16'],
      EDITOR_BATCH_CONSTRAINTS: editorBatch.EDITOR_BATCH_CONSTRAINTS,
    })) {
      assert.equal(typeof prompt, 'string', `${id} is missing ${name}`);
      assert.ok(prompt.trim().length > 0, `${id} has an empty ${name}`);
    }

    assert.ok(editorBatch.EDITOR_BATCH_SCENES.length > 0, `${id} has no Editor Batch scenes`);
    const sceneIds = editorBatch.EDITOR_BATCH_SCENES.map((scene) => scene.id);
    assert.equal(new Set(sceneIds).size, sceneIds.length, `${id} repeats an Editor Batch scene id`);
  }
});

test('Aspect Ratio sends the selected account\'s prompts to Gemini', async () => {
  for (const id of ACCOUNT_IDS) {
    const { aspectRatio } = getAccountPrompts(id);
    for (const ratio of ['1:1', '9:16']) {
      assert.deepEqual(
        getVariationPrompts(ratio, ASPECT_RATIO_PROMPT_PROFILE, id),
        [aspectRatio.SCENE_PROMPTS[ratio]],
      );
    }

    let sentPrompt = '';
    const ai = {
      models: {
        generateContent: async (payload) => {
          sentPrompt = payload.contents.parts[1].text;
          return { text: '{}' };
        },
      },
    };
    await extractCardCopyFromSource(ai, 'AAAA', 'image/png', id);
    assert.equal(sentPrompt, aspectRatio.CARD_COPY_EXTRACTION_PROMPT);
  }

  assert.deepEqual(
    getVariationPrompts('1:1', ASPECT_RATIO_PROMPT_PROFILE),
    getVariationPrompts('1:1', ASPECT_RATIO_PROMPT_PROFILE, 'riders'),
  );
});

test('generation endpoints reject an unknown account before calling the model', async (t) => {
  const { app } = await import(`../server/index.js?account-test=${Date.now()}`);
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const { port } = server.address();

  const post = (path, body) => fetch(`http://127.0.0.1:${port}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

  for (const [path, body] of [
    ['/api/nano-editor', { prompt: 'Make it brighter', imageDataUrl: 'data:image/png;base64,AAAA' }],
    ['/api/aspect-ratio', { targetRatio: '1:1', imageDataUrl: 'data:image/png;base64,AAAA' }],
    ['/api/batch-aspect-ratio', { sheetsUrl: 'https://docs.google.com/spreadsheets/d/abc/edit' }],
  ]) {
    const response = await post(path, { ...body, account: 'taxi' });
    assert.equal(response.status, 400, path);
    assert.match((await response.json()).error, /account must be "riders", "drivers" or "corp"/, path);
  }

  // A valid account gets past that check and stops at the next one, still
  // before any model call.
  const accepted = await post('/api/nano-editor', { prompt: 'Make it brighter', account: 'drivers' });
  assert.equal(accepted.status, 400);
  assert.equal((await accepted.json()).error, 'imageDataUrl is required.');
});
