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

// The frame ground is painted from a constant, not sampled from the reference,
// so the two can drift apart silently — which is how a lavender reference ended
// up shipping as a mint frame. This pins each constant to its own source.
test('each framed template is painted the ground its reference actually uses', async () => {
  for (const { ratio, variant } of allVariants) {
    if (!variant.frame || !variant.referenceAsset) continue;
    const resolved = path.resolve(SERVICES_DIR, variant.referenceAsset);
    const { data, info } = await sharp(resolved).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const at = (x, y) => {
      const offset = (y * info.width + x) * info.channels;
      return [data[offset], data[offset + 1], data[offset + 2]];
    };
    // The outer margin is the frame ground on every approved reference.
    const corners = [[3, 3], [info.width - 4, 3], [3, info.height - 4], [info.width - 4, info.height - 4]];
    const average = [0, 1, 2].map((channel) => Math.round(
      corners.reduce((sum, [x, y]) => sum + at(x, y)[channel], 0) / corners.length,
    ));

    const declared = variant.frame.background.replace('#', '').match(/../g).map((part) => parseInt(part, 16));
    const distance = Math.max(...[0, 1, 2].map((channel) => Math.abs(declared[channel] - average[channel])));
    assert.ok(
      distance <= 6,
      `${ratio} ${variant.id}: declared ${variant.frame.background} but its reference is #${average.map((v) => v.toString(16).padStart(2, '0')).join('')}`,
    );
  }
});
