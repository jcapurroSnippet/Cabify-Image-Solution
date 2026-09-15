import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { getAccountPrompts } from '../prompts/index.js';
import {
  ASPECT_RATIO_TEMPLATE_VARIANTS,
  DRIVERS_TEMPLATE_VARIANTS,
  composeAspectRatioTemplate,
  getAspectRatioTemplateVariants,
  listAspectRatioTemplateIds,
} from '../server/services/aspectRatioTemplate.js';
import { extractCardCopyFromSource, sampleSourceColours } from '../server/services/imageGenerator.js';

const hexToRgb = (hex) => hex.slice(1).match(/../g).map((part) => Number.parseInt(part, 16));

const solidDataUrl = async (colour, width = 512, height = 512) => `data:image/png;base64,${(await sharp({
  create: { width, height, channels: 3, background: colour },
}).png().toBuffer()).toString('base64')}`;

const readRaw = async (dataUrl) => sharp(Buffer.from(dataUrl.split(',')[1], 'base64'))
  .removeAlpha()
  .raw()
  .toBuffer({ resolveWithObject: true });

const pixelAt = ({ data, info }, x, y) => {
  const offset = (y * info.width + x) * 3;
  return [data[offset], data[offset + 1], data[offset + 2]];
};

const countNear = (image, box, colour, tolerance = 12) => {
  let count = 0;
  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const pixel = pixelAt(image, x, y);
      if (Math.max(...[0, 1, 2].map((channel) => Math.abs(pixel[channel] - colour[channel]))) <= tolerance) count += 1;
    }
  }
  return count;
};

const DRIVERS_INPUT = { ground: '#7145CE', card: '#FFFFFF', text: '#17171F', accent: '#6034C6' };

test('each account resolves its own template set, Riders by default', () => {
  assert.equal(getAspectRatioTemplateVariants(), ASPECT_RATIO_TEMPLATE_VARIANTS);
  assert.equal(getAspectRatioTemplateVariants('corp'), ASPECT_RATIO_TEMPLATE_VARIANTS);
  assert.equal(getAspectRatioTemplateVariants('drivers'), DRIVERS_TEMPLATE_VARIANTS);
  assert.throws(() => getAspectRatioTemplateVariants('taxi'), /Unknown Cabify account/);
  assert.deepEqual(listAspectRatioTemplateIds('9:16', 'drivers'), [
    '9-16-drivers-frame',
    '9-16-drivers-frame-lavender',
    '9-16-drivers-frame-tall',
  ]);
});

test('Drivers is the Riders template set, identical in everything but colour', () => {
  for (const [ratio, riders] of Object.entries(ASPECT_RATIO_TEMPLATE_VARIANTS)) {
    const drivers = DRIVERS_TEMPLATE_VARIANTS[ratio];
    assert.equal(drivers.length, riders.length);
    drivers.forEach((template, index) => {
      const source = riders[index];
      assert.equal(template.derivedFrom, source.id);
      assert.equal(template.colourSource, 'input');
      assert.deepEqual(template.canvas, source.canvas);
      assert.deepEqual(template.scene, source.scene);
      assert.equal(template.referenceAsset, source.referenceAsset);
      assert.deepEqual(template.logo.box, source.logo.box);
      assert.equal(Boolean(template.frame), Boolean(source.frame));
      for (const key of ['box', 'textBox', 'radius', 'align', 'fontSize']) {
        assert.deepEqual(template.card[key], source.card[key], `${template.id} card.${key} must match ${source.id}`);
      }
    });
  }
});

test('a Drivers render takes the ground, card and headline colours from the input', async () => {
  const template = DRIVERS_TEMPLATE_VARIANTS['1:1'][0];
  const image = await readRaw(await composeAspectRatioTemplate({
    sceneDataUrl: await solidDataUrl('#2E6F9E'),
    targetRatio: '1:1',
    templateId: template.id,
    account: 'drivers',
    colours: { ground: '#1E8A4C', card: '#FDF3C4', text: '#202020', accent: '#C0392B' },
    text: 'En Neuquén, toda la ganancia es para vos.',
    accentText: 'En Neuquén,',
  }));

  assert.deepEqual(pixelAt(image, 0, 0), hexToRgb('#1E8A4C'), 'frame ground');
  assert.deepEqual(
    pixelAt(image, template.card.box.x + template.card.radius, template.card.box.y + 4),
    hexToRgb('#FDF3C4'),
    'card fill',
  );
  assert.ok(countNear(image, template.card.textBox, hexToRgb('#C0392B')) > 200, 'accent words');
  assert.ok(countNear(image, template.card.textBox, hexToRgb('#202020')) > 200, 'body copy');
});

test('without readable input colours, Drivers falls back to its measured palette', async () => {
  const template = DRIVERS_TEMPLATE_VARIANTS['9:16'][0];
  const image = await readRaw(await composeAspectRatioTemplate({
    sceneDataUrl: await solidDataUrl('#2E6F9E'),
    targetRatio: '9:16',
    templateId: template.id,
    account: 'drivers',
    colours: { ground: 'purple', card: undefined, text: '#12345' },
    text: 'Manejá con Cabify y ganá $600.000 semanales',
    accentText: 'Manejá con Cabify',
  }));

  assert.deepEqual(pixelAt(image, 0, 0), hexToRgb(DRIVERS_INPUT.ground));
  assert.deepEqual(
    pixelAt(image, template.card.box.x + template.card.radius, template.card.box.y + 4),
    hexToRgb(DRIVERS_INPUT.card),
  );
  assert.ok(countNear(image, template.card.textBox, hexToRgb(DRIVERS_INPUT.accent)) > 200);
  assert.ok(countNear(image, template.card.textBox, hexToRgb(DRIVERS_INPUT.text)) > 200);
});

test('an accent that is not part of the copy leaves the headline in one colour', async () => {
  const template = DRIVERS_TEMPLATE_VARIANTS['1:1'][0];
  const common = {
    sceneDataUrl: await solidDataUrl('#2E6F9E'),
    targetRatio: '1:1',
    templateId: template.id,
    account: 'drivers',
    colours: DRIVERS_INPUT,
    text: 'En Neuquén, toda la ganancia es para vos.',
  };
  for (const accentText of [undefined, '', 'En Córdoba,']) {
    const image = await readRaw(await composeAspectRatioTemplate({ ...common, accentText }));
    assert.equal(countNear(image, template.card.textBox, hexToRgb(DRIVERS_INPUT.accent)), 0);
  }
});

test('the logo takes whichever colour reads on what sits behind it', async () => {
  const template = DRIVERS_TEMPLATE_VARIANTS['1:1'][0];
  const logoInk = async (ground) => {
    const image = await readRaw(await composeAspectRatioTemplate({
      sceneDataUrl: await solidDataUrl('#2E6F9E'),
      targetRatio: '1:1',
      templateId: template.id,
      account: 'drivers',
      colours: { ...DRIVERS_INPUT, ground },
      text: 'Hola',
    }));
    return {
      white: countNear(image, template.logo.box, [255, 255, 255], 2),
      purple: countNear(image, template.logo.box, hexToRgb('#7145CE'), 2),
    };
  };

  // On the Drivers purple ground the wordmark turns white (the card colour).
  // The ground itself is that purple, so only the white ink is telling here.
  const onPurple = await logoInk('#7145CE');
  assert.ok(onPurple.white > 1000, `expected a white wordmark on purple, got ${onPurple.white} white pixels`);
  // On a pastel ground it stays purple, as the Riders frames have it.
  const onPastel = await logoInk('#C7E0F8');
  assert.ok(onPastel.purple > 1000, `expected a purple wordmark on pastel, got ${onPastel.purple} purple pixels`);
  assert.ok(onPastel.white < 50, 'no white wordmark on a pastel ground');
});

test('Riders renders ignore input colours and accents entirely', async () => {
  const common = { sceneDataUrl: await solidDataUrl('#2E6F9E'), targetRatio: '1:1', text: 'Movete con Cabify' };
  assert.equal(
    await composeAspectRatioTemplate({ ...common, colours: DRIVERS_INPUT, accentText: 'Movete' }),
    await composeAspectRatioTemplate(common),
  );
});

test('a Drivers template cannot be reached without the Drivers account', async () => {
  const sceneDataUrl = await solidDataUrl('#123456');
  await assert.rejects(
    () => composeAspectRatioTemplate({ sceneDataUrl, targetRatio: '1:1', templateId: '1-1-drivers-frame', text: 'Hola' }),
    /is not valid for targetRatio/,
  );
});

/** A 1200x628 stand-in for a source creative: ground, flat card, headline. */
const buildSource = async ({ ground, card, headline }) => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="628">
    <rect width="1200" height="628" fill="${ground}"/>
    <rect x="51" y="56" width="500" height="516" rx="30" fill="${card}"/>
    <text x="90" y="260" font-family="sans-serif" font-weight="700" font-size="56">${headline}</text>
  </svg>`;
  return (await sharp(Buffer.from(svg)).png().toBuffer()).toString('base64');
};
// The headline's box over the stand-in, on the model's 0-1000 grid.
const HEADLINE_BOX = [290, 70, 450, 450];

test('source colours are read off the input: ground, card and both headline colours', async () => {
  const source = await buildSource({
    ground: '#7145CE',
    card: '#FFFFFF',
    headline: '<tspan fill="#6034C6">En Neuquén,</tspan><tspan fill="#17171F"> toda</tspan>',
  });
  assert.deepEqual(await sampleSourceColours(source, { cardTextBox: HEADLINE_BOX }), DRIVERS_INPUT);
});

test('a single-colour headline yields no accent, and a Riders-style input reads as such', async () => {
  const source = await buildSource({
    ground: '#C7E0F8',
    card: '#6034C6',
    headline: '<tspan fill="#FFFFFF">Movete con Cabify</tspan>',
  });
  assert.deepEqual(
    await sampleSourceColours(source, { cardTextBox: HEADLINE_BOX }),
    { ground: '#C7E0F8', card: '#6034C6', text: '#FFFFFF' },
  );
});

test('only what reads reliably is returned', async () => {
  const source = await buildSource({ ground: '#7145CE', card: '#FFFFFF', headline: 'Hola' });
  // No headline box: the card and copy cannot be located, the ground still can.
  assert.deepEqual(await sampleSourceColours(source, {}), { ground: '#7145CE' });

  // A full-bleed picture has no common corner colour.
  const photo = await sharp({ create: { width: 400, height: 300, channels: 3, background: '#335577' } })
    .composite([{ input: await sharp({ create: { width: 60, height: 60, channels: 3, background: '#EEDD11' } }).png().toBuffer(), left: 0, top: 0 }])
    .png()
    .toBuffer();
  assert.equal((await sampleSourceColours(photo.toString('base64'), {})).ground, undefined);

  assert.deepEqual(await sampleSourceColours('not-an-image', { cardTextBox: HEADLINE_BOX }), {});
});

test('extraction keeps an accent only when it is literally part of the copy', async () => {
  const extract = async (payload) => extractCardCopyFromSource({
    models: { generateContent: async () => ({ text: JSON.stringify(payload) }) },
  }, 'AAAA', 'image/png', 'drivers');
  const base = { cardText: 'En Neuquén, toda la\nganancia es para vos.', buttonPresent: false, buttonLabel: '' };

  assert.equal((await extract({ ...base, cardTextAccent: 'En  Neuquén,' })).cardTextAccent, 'En Neuquén,');
  assert.equal((await extract({ ...base, cardTextAccent: 'En Córdoba,' })).cardTextAccent, '');
  assert.equal((await extract(base)).cardTextAccent, '');
});

test('only an account whose templates take input colours asks Gemini for an accent', async () => {
  const schemaFor = async (account) => {
    let schema;
    await extractCardCopyFromSource({
      models: { generateContent: async (payload) => { schema = payload.config.responseJsonSchema; return { text: '{}' }; } },
    }, 'AAAA', 'image/png', account);
    return schema;
  };
  // The Riders request must stay byte-for-byte what it was before Drivers existed.
  for (const account of [undefined, 'riders', 'corp']) {
    assert.equal('cardTextAccent' in (await schemaFor(account)).properties, false, `${account} schema changed`);
  }
  const drivers = await schemaFor('drivers');
  assert.equal(drivers.properties.cardTextAccent.type, 'string');
  assert.equal(drivers.required.includes('cardTextAccent'), false);
});

test('the Drivers extraction prompt asks which words are set in purple', () => {
  assert.match(getAccountPrompts('drivers').aspectRatio.CARD_COPY_EXTRACTION_PROMPT, /"cardTextAccent"/);
});
