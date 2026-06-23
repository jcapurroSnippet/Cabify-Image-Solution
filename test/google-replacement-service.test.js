import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  assertReplacementImageAspectRatio,
  collectExecutionGoogleAdsTrace,
  readImageResolutionFromDataUrl,
} from '../server/services/googleReplacementService.js';

const buildImageDataUrl = async ({ width, height }) => {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: '#ffffff',
    },
  })
    .png()
    .toBuffer();

  return `data:image/png;base64,${buffer.toString('base64')}`;
};

test('collects google ads trace entries from successful and failed replacement results', () => {
  const trace = collectExecutionGoogleAdsTrace([
    {
      replacement: {
        googleAdsTrace: [
          { step: 'validate_input', status: 'success' },
          { step: 'verify_app_engagement_ad_image_update', status: 'success' },
        ],
      },
    },
    {
      executionError: {
        googleAdsTrace: [
          { step: 'upload_asset_and_update_app_engagement_ad', status: 'error' },
        ],
      },
    },
  ]);

  assert.deepEqual(
    trace.map((entry) => `${entry.step}:${entry.status}`),
    [
      'validate_input:success',
      'verify_app_engagement_ad_image_update:success',
      'upload_asset_and_update_app_engagement_ad:error',
    ],
  );
});

test('reads replacement image resolution from a data URL', async () => {
  const dataUrl = await buildImageDataUrl({ width: 320, height: 180 });
  const resolution = await readImageResolutionFromDataUrl(dataUrl);

  assert.deepEqual(resolution, { width: 320, height: 180 });
});

test('allows replacement creatives with the same aspect ratio at a different size', () => {
  assert.doesNotThrow(() => assertReplacementImageAspectRatio({
    expectedResolution: '1080x1080',
    replacementResolution: { width: 1024, height: 1024 },
    creativeId: 'square_001',
  }));

  assert.doesNotThrow(() => assertReplacementImageAspectRatio({
    expectedResolution: '1080x1920',
    replacementResolution: { width: 900, height: 1600 },
    creativeId: 'portrait_001',
  }));
});

test('rejects replacement creatives when their aspect ratio does not match the Google asset', () => {
  assert.throws(
    () => assertReplacementImageAspectRatio({
      expectedResolution: '1080x1080',
      replacementResolution: { width: 1080, height: 1920 },
      creativeId: 'passenger_177',
    }),
    /passenger_177.*1080x1920.*9:16.*1080x1080.*1:1/,
  );
});
