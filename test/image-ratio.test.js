import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  assertReplacementImageAspectRatio,
  classifyAspectRatio,
  getImageResolutionFromDataUrl,
  getRequiredAspectRatio,
} from '../server/services/imageRatio.js';

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

test('classifies common Google creative aspect ratios from resolutions', () => {
  assert.equal(classifyAspectRatio('1200x628'), '1.91:1');
  assert.equal(classifyAspectRatio('1080x1080'), '1:1');
  assert.equal(classifyAspectRatio('1080x1920'), '9:16');
  assert.equal(classifyAspectRatio('1600x900'), '16:9');
  assert.equal(classifyAspectRatio('1080x1350'), '4:5');
});

test('falls back from Google asset field type when resolution is missing', () => {
  assert.equal(getRequiredAspectRatio({ oldImageResolution: '', assetFieldType: 'MARKETING_IMAGE' }), '1.91:1');
  assert.equal(getRequiredAspectRatio({ oldImageResolution: '', assetFieldType: 'SQUARE_MARKETING_IMAGE' }), '1:1');
  assert.equal(getRequiredAspectRatio({ oldImageResolution: '', assetFieldType: 'PORTRAIT_MARKETING_IMAGE' }), '9:16');
});

test('reads replacement image resolution from a data URL', async () => {
  const dataUrl = await buildImageDataUrl({ width: 320, height: 180 });
  const resolution = await getImageResolutionFromDataUrl(dataUrl);

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
      expectedResolution: '1200x628',
      replacementResolution: { width: 1080, height: 1920 },
      creativeId: 'passenger_177',
    }),
    /passenger_177.*1080x1920.*9:16.*1200x628.*1.91:1/,
  );
});
