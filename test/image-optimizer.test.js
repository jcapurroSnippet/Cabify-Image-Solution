import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { detectImageMimeType } from '../server/services/imageOptimizer.js';

const createImageBuffer = (format) =>
  sharp({
    create: {
      width: 2,
      height: 2,
      channels: 3,
      background: '#ffffff',
    },
  })
    .toFormat(format)
    .toBuffer();

test('detects the MIME type from real PNG, JPEG, and WebP bytes', async () => {
  const formats = [
    ['png', 'image/png'],
    ['jpeg', 'image/jpeg'],
    ['webp', 'image/webp'],
  ];

  for (const [format, expectedMimeType] of formats) {
    const imageBuffer = await createImageBuffer(format);
    assert.equal(await detectImageMimeType(imageBuffer), expectedMimeType);
  }
});

test('rejects bytes that are not a supported image', async () => {
  await assert.rejects(() => detectImageMimeType(Buffer.from('not-an-image')));
});
