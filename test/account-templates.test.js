import assert from 'node:assert/strict';
import test from 'node:test';
import sharp from 'sharp';
import { getAccountPrompts } from '../prompts/index.js';
import {
  ASPECT_RATIO_TEMPLATE_VARIANTS,
  CORP_TEMPLATE_VARIANTS,
  DRIVERS_TEMPLATE_VARIANTS,
  composeAspectRatioTemplate,
  getAspectRatioTemplateVariants,
  listAspectRatioTemplateIds,
} from '../server/services/aspectRatioTemplate.js';
import {
  buildImageBadgeCrop,
  extractCardCopyFromSource,
  sampleSourceColours,
} from '../server/services/imageGenerator.js';

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
  assert.equal(getAspectRatioTemplateVariants('corp'), CORP_TEMPLATE_VARIANTS);
  assert.equal(getAspectRatioTemplateVariants('drivers'), DRIVERS_TEMPLATE_VARIANTS);
  assert.throws(() => getAspectRatioTemplateVariants('taxi'), /Unknown Cabify account/);
  assert.deepEqual(listAspectRatioTemplateIds('9:16', 'drivers'), [
    '9-16-drivers-frame',
    '9-16-drivers-frame-lavender',
    '9-16-drivers-frame-tall',
  ]);
  assert.deepEqual(listAspectRatioTemplateIds('1:1', 'corp'), [
    '1-1-corp-frame',
    '1-1-corp-frame-lavender',
    '1-1-corp-fullbleed',
  ]);
});

test('Drivers and Corp are the Riders template set, identical in everything but colour', () => {
  for (const variants of [DRIVERS_TEMPLATE_VARIANTS, CORP_TEMPLATE_VARIANTS]) {
    for (const [ratio, riders] of Object.entries(ASPECT_RATIO_TEMPLATE_VARIANTS)) {
      const account = variants[ratio];
      assert.equal(account.length, riders.length);
      account.forEach((template, index) => {
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
  }
});

test('only Corp signs "para empresas", and only Drivers carries a badge', () => {
  for (const template of Object.values(CORP_TEMPLATE_VARIANTS).flat()) {
    assert.deepEqual(template.logo.descriptor, { text: 'para empresas', fontId: 'cabify-ciudad-light' });
    assert.equal(template.badge, undefined);
  }
  for (const template of Object.values(DRIVERS_TEMPLATE_VARIANTS).flat()) {
    assert.equal(template.logo.descriptor, undefined);
    assert.ok(template.badge);
  }
  for (const template of Object.values(ASPECT_RATIO_TEMPLATE_VARIANTS).flat()) {
    assert.equal(template.logo.descriptor, undefined);
    assert.equal(template.badge, undefined);
  }
});

test('only Corp asks for a taller CTA, and only Corp may stretch it', async () => {
  for (const template of Object.values(CORP_TEMPLATE_VARIANTS).flat()) {
    assert.equal(template.card.extrasToFontRatio, 1.5);
    assert.equal(template.card.extrasMaxScale, 1.3);
  }
  for (const variants of [ASPECT_RATIO_TEMPLATE_VARIANTS, DRIVERS_TEMPLATE_VARIANTS]) {
    for (const template of variants['1:1'].concat(variants['9:16'])) {
      assert.equal(template.card.extrasToFontRatio, undefined, `${template.id} must keep the default CTA sizing`);
      assert.equal(template.card.extrasMaxScale, undefined, `${template.id} must not enlarge its marks`);
    }
  }

  // A Corp CTA lands taller than the same crop on the same geometry in Riders,
  // and the copy gives up only a little for it.
  // Not the card purple: on a Riders card that colour IS the card.
  const CTA_COLOUR = '#00A3FF';
  const cta = await sharp({ create: { width: 311, height: 75, channels: 3, background: CTA_COLOUR } }).png().toBuffer();
  const common = {
    sceneDataUrl: await solidDataUrl('#2E6F9E'),
    targetRatio: '9:16',
    text: 'Tu empresa ahorra, tus empleados viajan mejor.',
    cardExtras: cta,
    cardExtrasPanelColour: [255, 255, 255],
  };
  const ctaHeight = async (options) => {
    const image = await readRaw(await composeAspectRatioTemplate({ ...common, ...options }));
    const box = (options.account === 'corp' ? CORP_TEMPLATE_VARIANTS : ASPECT_RATIO_TEMPLATE_VARIANTS)['9:16'][0].card.textBox;
    let rows = 0;
    for (let y = box.y; y < box.y + box.height; y += 1) {
      let run = 0;
      let longest = 0;
      for (let x = box.x; x < box.x + box.width; x += 1) {
        if (countNear(image, { x, y, width: 1, height: 1 }, hexToRgb(CTA_COLOUR), 8)) {
          run += 1;
          if (run > longest) longest = run;
        } else run = 0;
      }
      if (longest > 100) rows += 1;
    }
    return rows;
  };

  const corp = await ctaHeight({ account: 'corp', colours: { ground: '#1A1A38', card: '#FFFFFF', text: '#17171F', accent: '#6034C6' } });
  const riders = await ctaHeight({});
  assert.ok(corp > riders * 1.2, `Corp CTA (${corp}px) should stand clearly taller than the default (${riders}px)`);
  // Its own source pixels are 75 tall: Corp is allowed past them, but not far.
  assert.ok(corp <= Math.round(75 * 1.3), `Corp CTA (${corp}px) stretched past its allowance`);
});

test('the Corp signature stacks the wordmark over its descriptor inside the logo box', async () => {
  const template = CORP_TEMPLATE_VARIANTS['1:1'][0];
  const image = await readRaw(await composeAspectRatioTemplate({
    sceneDataUrl: await solidDataUrl('#203040'),
    targetRatio: '1:1',
    templateId: template.id,
    account: 'corp',
    colours: { ground: '#1A1A38', card: '#FFFFFF', text: '#17171F', accent: '#6034C6' },
    text: 'Movilidad cómoda y segura para tus clientes',
  }));

  const { box } = template.logo;
  const inkRows = [];
  for (let y = box.y; y < box.y + box.height; y += 1) {
    const row = countNear(image, { x: box.x, y, width: box.width, height: 1 }, [255, 255, 255], 40);
    inkRows.push(row > 0);
  }
  // Two bands of ink — wordmark, then descriptor — with a clear gap between.
  const bands = inkRows.reduce((list, inked, index) => {
    if (inked && (index === 0 || !inkRows[index - 1])) list.push({ start: index, end: index });
    else if (inked) list[list.length - 1].end = index;
    return list;
  }, []);
  assert.equal(bands.length, 2, `expected a wordmark and a descriptor, got ${bands.length} bands`);
  const [wordmark, descriptor] = bands;
  assert.ok(wordmark.end - wordmark.start > descriptor.end - descriptor.start, 'the wordmark must be the taller band');
  assert.ok(descriptor.start - wordmark.end >= 2, 'the two must not touch');
  assert.ok(descriptor.end <= box.height, 'the lockup must stay inside the logo box');

  // The descriptor is wider than the wordmark, as in the approved lockup.
  const bandWidth = (band) => {
    let left = box.x + box.width;
    let right = box.x;
    for (let y = box.y + band.start; y <= box.y + band.end; y += 1) {
      for (let x = box.x; x < box.x + box.width; x += 1) {
        if (countNear(image, { x, y, width: 1, height: 1 }, [255, 255, 255], 40)) {
          if (x < left) left = x;
          if (x > right) right = x;
        }
      }
    }
    return right - left + 1;
  };
  assert.ok(bandWidth(descriptor) > bandWidth(wordmark), 'the descriptor should run wider than the wordmark');
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

test('the badge slot mirrors the logo: top-right, on the picture, clear of the card', () => {
  for (const variants of Object.values(ASPECT_RATIO_TEMPLATE_VARIANTS)) {
    for (const template of variants) assert.equal(template.badge, undefined, `${template.id} must not gain a badge`);
  }
  for (const variants of Object.values(DRIVERS_TEMPLATE_VARIANTS)) {
    for (const template of variants) {
      const { badge, logo, canvas, card } = template;
      assert.equal(badge.box.width, badge.box.height, `${template.id} badge must be square`);
      assert.equal(canvas.width - (badge.box.x + badge.box.width), logo.box.x, `${template.id} badge must mirror the logo margin`);
      assert.equal(badge.box.y, logo.box.y, `${template.id} badge must top-align with the logo`);
      assert.ok(badge.box.x > logo.box.x + logo.box.width, `${template.id} badge overlaps the logo`);
      assert.ok(badge.box.y + badge.box.height < card.box.y, `${template.id} badge reaches the card`);
    }
  }
});

test('the input badge is placed in its slot, and only when the input has one', async () => {
  const template = DRIVERS_TEMPLATE_VARIANTS['1:1'][0];
  const badge = await sharp({ create: { width: 93, height: 93, channels: 3, background: '#FFFFFF' } }).png().toBuffer();
  const common = {
    sceneDataUrl: await solidDataUrl('#203040'),
    targetRatio: '1:1',
    templateId: template.id,
    account: 'drivers',
    colours: DRIVERS_INPUT,
    text: 'Tu comodidad es nuestra prioridad.',
  };
  const core = {
    x: template.badge.box.x + 25,
    y: template.badge.box.y + 25,
    width: template.badge.box.width - 50,
    height: template.badge.box.height - 50,
  };

  const withBadge = await readRaw(await composeAspectRatioTemplate({ ...common, badge }));
  assert.equal(countNear(withBadge, core, [255, 255, 255], 2), core.width * core.height);
  const withoutBadge = await readRaw(await composeAspectRatioTemplate(common));
  assert.equal(countNear(withoutBadge, core, [255, 255, 255], 2), 0);

  // The mask rounds the corners off: the slot's corner pixel shows the picture.
  assert.deepEqual(pixelAt(withBadge, template.badge.box.x, template.badge.box.y), [0x20, 0x30, 0x40]);
});

test('Riders renders ignore a badge', async () => {
  const badge = await sharp({ create: { width: 93, height: 93, channels: 3, background: '#FFFFFF' } }).png().toBuffer();
  const common = { sceneDataUrl: await solidDataUrl('#2E6F9E'), targetRatio: '9:16', text: 'Movete con Cabify' };
  assert.equal(await composeAspectRatioTemplate({ ...common, badge }), await composeAspectRatioTemplate(common));
});

/** A 1200x628 stand-in: bright sky and a pure-white badge with a purple wheel. */
const buildBadgeSource = async ({ leakingBar = false } = {}) => {
  const wheel = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="93" height="93"><rect width="93" height="93" rx="18" fill="#FFFFFF"/><circle cx="46" cy="46" r="24" fill="none" stroke="#6034C6" stroke-width="8"/></svg>');
  const layers = [{ input: wheel, left: 75, top: 83 }];
  if (leakingBar) {
    layers.push({ input: await sharp({ create: { width: 400, height: 40, channels: 3, background: '#FFFFFF' } }).png().toBuffer(), left: 150, top: 110 });
  }
  const buffer = await sharp({ create: { width: 1200, height: 628, channels: 3, background: '#E9EEF2' } })
    .composite(layers)
    .png()
    .toBuffer();
  return buffer.toString('base64');
};

test('the badge crop snaps to the white square instead of the model\'s rough box', async () => {
  // A few pixels off on every side, as Gemini returns them.
  const roughBox = [120, 55, 290, 150];
  const { width, height } = await sharp(await buildImageBadgeCrop(await buildBadgeSource(), roughBox)).metadata();
  assert.ok(Math.abs(width - 93) <= 2 && Math.abs(height - 93) <= 2, `expected ~93x93, got ${width}x${height}`);

  // White that runs into the picture is not the badge: keep the model's box.
  const leaked = await sharp(await buildImageBadgeCrop(await buildBadgeSource({ leakingBar: true }), roughBox)).metadata();
  assert.equal(leaked.width, Math.round(0.150 * 1200) - Math.round(0.055 * 1200));

  assert.equal(await buildImageBadgeCrop(await buildBadgeSource(), [0, 0, 0, 0]), null);
  assert.equal(await buildImageBadgeCrop(await buildBadgeSource(), undefined), null);
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

test('only an account whose templates use them asks Gemini for an accent and a badge', async () => {
  const schemaFor = async (account) => {
    let schema;
    await extractCardCopyFromSource({
      models: { generateContent: async (payload) => { schema = payload.config.responseJsonSchema; return { text: '{}' }; } },
    }, 'AAAA', 'image/png', account);
    return schema;
  };
  // The Riders request must stay byte-for-byte what it was before the other
  // accounts existed.
  for (const account of [undefined, 'riders']) {
    const { properties } = await schemaFor(account);
    assert.equal('cardTextAccent' in properties, false, `${account} schema changed`);
    assert.equal('imageBadgeBox' in properties, false, `${account} schema changed`);
  }
  // Corp has a two-colour headline but no badge; Drivers has both.
  const corp = await schemaFor('corp');
  assert.equal(corp.properties.cardTextAccent.type, 'string');
  assert.equal('imageBadgeBox' in corp.properties, false);

  const drivers = await schemaFor('drivers');
  assert.equal(drivers.properties.cardTextAccent.type, 'string');
  assert.equal(drivers.properties.imageBadgeBox.type, 'array');
  for (const field of ['cardTextAccent', 'imageBadgeBox']) {
    assert.equal(drivers.required.includes(field), false, `${field} must stay optional`);
  }
});

test('extraction keeps a usable badge box and drops an empty one', async () => {
  const extract = async (imageBadgeBox) => (await extractCardCopyFromSource({
    models: { generateContent: async () => ({ text: JSON.stringify({ cardText: 'Hola', imageBadgeBox }) }) },
  }, 'AAAA', 'image/png', 'drivers')).imageBadgeBox;
  assert.deepEqual(await extract([728, 855, 870, 932]), [728, 855, 870, 932]);
  assert.equal(await extract([0, 0, 0, 0]), null);
  assert.equal(await extract(undefined), null);
});

test('each extraction prompt asks for exactly what its templates consume', () => {
  const drivers = getAccountPrompts('drivers').aspectRatio.CARD_COPY_EXTRACTION_PROMPT;
  assert.match(drivers, /"cardTextAccent"/);
  assert.match(drivers, /"imageBadgeBox"/);

  const corp = getAccountPrompts('corp').aspectRatio.CARD_COPY_EXTRACTION_PROMPT;
  assert.match(corp, /"cardTextAccent"/);
  assert.doesNotMatch(corp, /"imageBadgeBox"/);

  const riders = getAccountPrompts('riders').aspectRatio.CARD_COPY_EXTRACTION_PROMPT;
  assert.doesNotMatch(riders, /"cardTextAccent"/);
  assert.doesNotMatch(riders, /"imageBadgeBox"/);
});
