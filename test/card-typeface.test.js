import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import {
  ASPECT_RATIO_TEMPLATE_DEFINITIONS,
  composeAspectRatioTemplate,
} from '../server/services/aspectRatioTemplate.js';
import { classifyCardTypeface, measureInkDensity } from '../server/services/cardTypeface.js';

const CARD_BACKGROUND = '#6034C6';
const CARD_TEXT_COLOUR = '#FFFFFF';
const COPY = 'Viajá cómodo y seguro por toda tu ciudad';
// Ordered light to heavy. Cabify Ciudad Text is excluded on purpose: the
// typography system reserves it for CTA labels, never the headline.
const WEIGHTS = [
  'cabify-ciudad-light',
  'cabify-ciudad-book',
  'cabify-ciudad-semibold',
  'cabify-ciudad-bold',
  'cabify-ciudad-extrabold',
  'cabify-ciudad-black',
];

const template = ASPECT_RATIO_TEMPLATE_DEFINITIONS['1:1'];

const buildScene = async () => {
  const buffer = await sharp({
    create: { width: 1024, height: 1024, channels: 3, background: '#2E6F9E' },
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
};

/** A creative whose card copy is set in a known face, as a caller would supply it. */
const buildSource = async (sceneDataUrl, fontId) => {
  const dataUrl = await composeAspectRatioTemplate({
    sceneDataUrl,
    targetRatio: '1:1',
    text: COPY,
    fontId,
  });
  return Buffer.from(dataUrl.split(',')[1], 'base64');
};

/** The copy block in the 0-1000 grid the extraction model reports. */
const copyBlockBox = () => {
  const { textBox } = template.card;
  const { width, height } = template.canvas;
  return [
    Math.round((textBox.y / height) * 1000),
    Math.round((textBox.x / width) * 1000),
    Math.round(((textBox.y + textBox.height) / height) * 1000),
    Math.round(((textBox.x + textBox.width) / width) * 1000),
  ];
};

const classify = (buffer, box) => classifyCardTypeface({
  sourceImageData: buffer.toString('base64'),
  cardTextBox: box ?? copyBlockBox(),
  cardText: COPY,
  cardBackgroundColor: CARD_BACKGROUND,
  cardTextColor: CARD_TEXT_COLOUR,
});

test('ink density rises monotonically from Light to Black', async () => {
  const scene = await buildScene();
  const densities = [];

  for (const fontId of WEIGHTS) {
    const result = await classify(await buildSource(scene, fontId));
    assert.ok(result, `${fontId} should be measurable`);
    densities.push(result.density);
  }

  for (let index = 1; index < densities.length; index += 1) {
    assert.ok(
      densities[index] > densities[index - 1],
      `${WEIGHTS[index]} must read heavier than ${WEIGHTS[index - 1]}`
        + ` (${densities[index - 1].toFixed(3)} -> ${densities[index].toFixed(3)})`,
    );
  }
});

test('the source card face is measured, not guessed, across every shipped weight', async () => {
  const scene = await buildScene();

  for (const fontId of WEIGHTS) {
    const result = await classify(await buildSource(scene, fontId));
    assert.equal(result?.fontId, fontId, `${fontId} was read as ${result?.fontId}`);
  }
});

test('a JPEG source and a tightly drawn copy block still read the right weight', async () => {
  const scene = await buildScene();

  for (const fontId of WEIGHTS) {
    const png = await buildSource(scene, fontId);
    // Real sources arrive as JPEG, and the model draws its box tight around the
    // copy rather than around the panel.
    const jpeg = await sharp(png).jpeg({ quality: 82 }).toBuffer();
    const { textBox } = template.card;
    const tight = [
      Math.round(((textBox.y + 24) / 1024) * 1000),
      Math.round(((textBox.x + 10) / 1024) * 1000),
      Math.round(((textBox.y + textBox.height - 24) / 1024) * 1000),
      Math.round(((textBox.x + textBox.width - 10) / 1024) * 1000),
    ];
    const result = await classify(jpeg, tight);
    assert.equal(result?.fontId, fontId, `${fontId} was read as ${result?.fontId} from a JPEG crop`);
  }
});

test('an unreadable copy block returns null so the caller keeps the model answer', async () => {
  const scene = await buildScene();
  const png = await buildSource(scene, 'cabify-ciudad-bold');

  assert.equal(await classify(png, null) === null, false, 'the control case must measure');
  assert.equal(await classifyCardTypeface(), null);
  assert.equal(await classifyCardTypeface({ sourceImageData: png.toString('base64') }), null);
  assert.equal(await classify(png, [0, 0, 2, 2]), null, 'a degenerate box has nothing to measure');
  assert.equal(
    await classifyCardTypeface({
      sourceImageData: png.toString('base64'),
      cardTextBox: copyBlockBox(),
      cardText: 'ok',
      cardBackgroundColor: CARD_BACKGROUND,
      cardTextColor: CARD_TEXT_COLOUR,
    }),
    null,
    'copy too short to carry a measurable sample',
  );
});

test('a mask with no ink, or too little of it, yields no reading', () => {
  const empty = new Uint8Array(64 * 64);
  assert.equal(measureInkDensity(empty, 64, 64), null);

  // A single solid block has ink runs but no interior gaps to divide by.
  const solid = new Uint8Array(64 * 64);
  for (let y = 10; y < 40; y += 1) for (let x = 10; x < 40; x += 1) solid[y * 64 + x] = 1;
  assert.equal(measureInkDensity(solid, 64, 64), null);
});
