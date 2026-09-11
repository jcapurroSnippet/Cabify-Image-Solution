import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  ASPECT_RATIO_TEMPLATE_DEFINITIONS,
  composeAspectRatioTemplate,
} from '../server/services/aspectRatioTemplate.js';
import { buildCardExtrasCrop } from '../server/services/imageGenerator.js';

const COPY = '¡El método de pago lo elegís vos!';

const buildScene = async () => {
  const buffer = await sharp({
    create: { width: 512, height: 512, channels: 3, background: '#2E6F9E' },
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
};

/** A stand-in for a source card's option pills, on a named panel colour. */
const buildExtras = async (panel, pillColour = '#3ECF8E') => sharp({
  create: { width: 460, height: 260, channels: 3, background: panel },
})
  .composite([0, 1, 2].map((index) => ({
    input: {
      create: { width: 420, height: 64, channels: 3, background: pillColour },
    },
    left: 0,
    top: index * 92,
  })))
  .png()
  .toBuffer();

const readRaw = async (dataUrl) => {
  const buffer = Buffer.from(String(dataUrl).split(',')[1], 'base64');
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { data, info };
};

const pixelAt = ({ data, info }, x, y) => {
  const offset = (y * info.width + x) * info.channels;
  return [data[offset], data[offset + 1], data[offset + 2]];
};

const countMatching = ({ data, info }, colour, tolerance = 10) => {
  let count = 0;
  for (let offset = 0; offset < data.length; offset += info.channels) {
    const distance = Math.max(
      Math.abs(data[offset] - colour[0]),
      Math.abs(data[offset + 1] - colour[1]),
      Math.abs(data[offset + 2] - colour[2]),
    );
    if (distance <= tolerance) count += 1;
  }
  return count;
};

test('the source card marks are composited inside the card, never outside it', async () => {
  const sceneDataUrl = await buildScene();
  const extras = await buildExtras('#6034C6');

  for (const ratio of ['1:1', '9:16']) {
    const template = ASPECT_RATIO_TEMPLATE_DEFINITIONS[ratio];
    const [withMarks, copyOnly] = await Promise.all([
      composeAspectRatioTemplate({
        sceneDataUrl,
        targetRatio: ratio,
        text: COPY,
        cardExtras: extras,
        cardExtrasPanelColour: [0x60, 0x34, 0xC6],
      }),
      composeAspectRatioTemplate({ sceneDataUrl, targetRatio: ratio, text: COPY }),
    ]);
    assert.notEqual(withMarks, copyOnly, `${ratio} should render the marks`);

    // The pill colour appears only inside the card box. Anywhere else would
    // mean the crop escaped the element box.
    const image = await readRaw(withMarks);
    const pill = [0x3E, 0xCF, 0x8E];
    const { box } = template.card;
    let inside = 0;
    let outside = 0;
    for (let y = 0; y < image.info.height; y += 1) {
      for (let x = 0; x < image.info.width; x += 1) {
        const [r, g, b] = pixelAt(image, x, y);
        const isPill = Math.abs(r - pill[0]) <= 20 && Math.abs(g - pill[1]) <= 20 && Math.abs(b - pill[2]) <= 20;
        if (!isPill) continue;
        const withinCard = x >= box.x && x < box.x + box.width && y >= box.y && y < box.y + box.height;
        if (withinCard) inside += 1; else outside += 1;
      }
    }
    assert.ok(inside > 500, `${ratio} marks should be visible inside the card`);
    assert.equal(outside, 0, `${ratio} marks escaped the card box`);
  }
});

test('the source panel is keyed out instead of pasted over the card', async () => {
  const sceneDataUrl = await buildScene();
  // A source card on white: without keying this lands as a white slab on the
  // purple card, which is the whole failure mode this guards.
  const extras = await buildExtras('#FFFFFF');

  const output = await composeAspectRatioTemplate({
    sceneDataUrl,
    targetRatio: '9:16',
    text: COPY,
    cardExtras: extras,
    cardExtrasPanelColour: [0xFF, 0xFF, 0xFF],
  });
  const image = await readRaw(output);

  // The copy itself is white, so a handful of white pixels is expected; a
  // pasted panel would be tens of thousands.
  const template = ASPECT_RATIO_TEMPLATE_DEFINITIONS['9:16'];
  const { box } = template.card;
  const cardOnly = await sharp(Buffer.from(String(output).split(',')[1], 'base64'))
    .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  const white = countMatching({ data: cardOnly.data, info: cardOnly.info }, [0xFF, 0xFF, 0xFF], 6);
  const purple = countMatching({ data: cardOnly.data, info: cardOnly.info }, [0x60, 0x34, 0xC6], 6);
  assert.ok(purple > white * 3, 'the card should still read as purple, not as a white slab');
});

test('marks are dropped rather than failing the variation when the copy needs the box', async () => {
  const sceneDataUrl = await buildScene();
  const extras = await buildExtras('#6034C6');
  // Copy long enough that it needs the whole box at its smallest size.
  const longCopy = 'Viajá con la tranquilidad de moverte seguro por toda tu ciudad cuando quieras';

  const output = await composeAspectRatioTemplate({
    sceneDataUrl,
    targetRatio: '1:1',
    text: longCopy,
    cardExtras: extras,
    cardExtrasPanelColour: [0x60, 0x34, 0xC6],
  });
  assert.match(output, /^data:image\/png;base64,/, 'a crowded card must still compose');
});

test('an absent or unusable extras box yields no crop', async () => {
  const source = (await sharp({
    create: { width: 400, height: 400, channels: 3, background: '#6034C6' },
  }).png().toBuffer()).toString('base64');

  assert.equal(await buildCardExtrasCrop(source, undefined), null);
  // A card that is only a headline reports the empty box.
  assert.equal(await buildCardExtrasCrop(source, [0, 0, 0, 0]), null);
  assert.equal(await buildCardExtrasCrop(source, [500, 500, 505, 505]), null, 'a sliver is not a crop');
  assert.equal(await buildCardExtrasCrop(source, [0, 0, 1000, 1000]), null, 'the whole canvas is not the marks');

  const crop = await buildCardExtrasCrop(source, [600, 100, 900, 800]);
  assert.ok(Buffer.isBuffer(crop), 'a plausible box should crop');
  const metadata = await sharp(crop).metadata();
  assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 280, height: 120 });
});
