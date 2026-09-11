import assert from 'node:assert/strict';
import test from 'node:test';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  ASPECT_RATIO_TEMPLATE_VARIANTS,
  composeAspectRatioTemplate,
} from '../server/services/aspectRatioTemplate.js';

const SERVICES_DIR = path.resolve(fileURLToPath(new URL('.', import.meta.url)), '../server/services');

const allVariants = Object.entries(ASPECT_RATIO_TEMPLATE_VARIANTS)
  .flatMap(([ratio, variants]) => variants.map((variant) => ({ ratio, variant })));

// A reference that is not on disk throws only at compose time, and the batch
// then drops that variation silently — the operator sees two creatives and no
// error. This is the cheap check that keeps a renamed asset loud.
test('every template declares a reference asset that exists on disk', () => {
  for (const { ratio, variant } of allVariants) {
    if (!variant.referenceAsset) continue;
    const resolved = path.resolve(SERVICES_DIR, variant.referenceAsset);
    assert.ok(existsSync(resolved), `${ratio} ${variant.id} points at a missing asset: ${variant.referenceAsset}`);
  }
});

test('every template composes a real image, so each ratio yields its full set', async () => {
  const scene = `data:image/png;base64,${(await sharp({
    create: { width: 512, height: 512, channels: 3, background: '#2E6F9E' },
  }).png().toBuffer()).toString('base64')}`;

  for (const { ratio, variant } of allVariants) {
    const output = await composeAspectRatioTemplate({
      sceneDataUrl: scene,
      targetRatio: ratio,
      templateId: variant.id,
      text: '¡El método de pago lo elegís vos!',
    });
    assert.match(output, /^data:image\/png;base64,/, `${ratio} ${variant.id} failed to compose`);
  }
});
