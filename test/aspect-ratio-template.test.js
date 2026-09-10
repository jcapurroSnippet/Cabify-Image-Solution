import assert from 'node:assert/strict';
import { existsSync, statSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';
import {
  ASPECT_RATIO_FONT_REGISTRY,
  ASPECT_RATIO_TEMPLATE_DEFINITIONS,
  ASPECT_RATIO_TEMPLATE_VARIANTS,
  CARD_COPY_FONT_ID,
  DEFAULT_ASPECT_RATIO_FONT_ID,
  composeAspectRatioTemplate,
  listAspectRatioTemplateIds,
  resolveAspectRatioFontId,
} from '../server/services/aspectRatioTemplate.js';
import {
  ASPECT_RATIO_PROMPT_PROFILE,
  generateAspectRatioImages,
  getVariationPrompts,
  resolveCardCopyForSource,
} from '../server/services/imageGenerator.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');
const serviceRoot = path.join(projectRoot, 'server', 'services');

const EXPECTED_TEMPLATES = {
  '1:1': {
    id: '1-1-riders-frame',
    canvas: { width: 1024, height: 1024 },
    logoBox: { x: 72, y: 77, width: 187, height: 63 },
    cardBox: { x: 76, y: 749, width: 872, height: 199 },
    textBox: { x: 116, y: 779, width: 792, height: 139 },
  },
  '9:16': {
    id: '9-16-riders-frame',
    canvas: { width: 1080, height: 1920 },
    logoBox: { x: 91, y: 95, width: 246, height: 80 },
    cardBox: { x: 86, y: 1291, width: 910, height: 374 },
    textBox: { x: 146, y: 1345, width: 790, height: 265 },
  },
};

const EXPECTED_FONTS = {
  'cabify-ciudad-light': ['Cabify Ciudad Light', 'CabifyCiudad-Light.otf'],
  'cabify-ciudad-book': ['Cabify Ciudad Book', 'CabifyCiudad-Book.otf'],
  'cabify-ciudad-semibold': ['Cabify Ciudad SemiBold', 'CabifyCiudad-SemiBold.otf'],
  'cabify-ciudad-bold': ['Cabify Ciudad Bold', 'CabifyCiudad-Bold.otf'],
  'cabify-ciudad-extrabold': ['Cabify Ciudad ExtraBold', 'CabifyCiudad-ExtraBold.otf'],
  'cabify-ciudad-black': ['Cabify Ciudad Black', 'CabifyCiudad-Black.otf'],
  'cabify-ciudad-text-light': ['Cabify Ciudad Text Light', 'CabifyCiudadText-Light.otf'],
  'cabify-ciudad-text-book': ['Cabify Ciudad Text Book', 'CabifyCiudadText-Book.otf'],
  'cabify-ciudad-text-semibold': ['Cabify Ciudad Text SemiBold', 'CabifyCiudadText-SemiBold.otf'],
  'cabify-ciudad-text-bold': ['Cabify Ciudad Text Bold', 'CabifyCiudadText-Bold.otf'],
};

const buildSolidDataUrl = async (colour, width = 96, height = 64) => {
  const buffer = await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: colour,
    },
  }).png().toBuffer();
  return `data:image/png;base64,${buffer.toString('base64')}`;
};

const decodePngDataUrl = (dataUrl) => {
  const match = String(dataUrl).match(/^data:image\/png;base64,([A-Za-z0-9+/=]+)$/);
  assert.ok(match, 'expected a PNG data URL');
  return Buffer.from(match[1], 'base64');
};

const readRaw = async (dataUrl) => {
  const buffer = decodePngDataUrl(dataUrl);
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { buffer, data, info };
};

const assertBoxWithin = (outer, inner, label) => {
  for (const key of ['x', 'y', 'width', 'height']) {
    assert.equal(Number.isInteger(inner[key]), true, `${label}.${key} must be an integer`);
  }
  assert.ok(inner.width > 0 && inner.height > 0, `${label} must have positive dimensions`);
  assert.ok(inner.x >= outer.x && inner.y >= outer.y, `${label} must start inside its parent`);
  assert.ok(
    inner.x + inner.width <= outer.x + outer.width,
    `${label} must not exceed its parent width`,
  );
  assert.ok(
    inner.y + inner.height <= outer.y + outer.height,
    `${label} must not exceed its parent height`,
  );
};

const pixelOffset = (info, x, y) => (y * info.width + x) * info.channels;

const pixelAt = ({ data, info }, x, y) => {
  const offset = pixelOffset(info, x, y);
  return [...data.subarray(offset, offset + info.channels)];
};

const cropRaw = async (imageBuffer, box) => sharp(imageBuffer)
  .extract({ left: box.x, top: box.y, width: box.width, height: box.height })
  .ensureAlpha()
  .raw()
  .toBuffer();

const findInkBounds = ({ data, info }, box, background) => {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -1;
  let maxY = -1;
  let pixels = 0;

  for (let y = box.y; y < box.y + box.height; y += 1) {
    for (let x = box.x; x < box.x + box.width; x += 1) {
      const offset = pixelOffset(info, x, y);
      const distance = Math.max(
        Math.abs(data[offset] - background[0]),
        Math.abs(data[offset + 1] - background[1]),
        Math.abs(data[offset + 2] - background[2]),
      );
      if (distance < 12) continue;
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
      pixels += 1;
    }
  }

  return pixels ? { minX, minY, maxX, maxY, pixels } : null;
};

test('template manifests pin canonical assets and pixel geometry', async () => {
  assert.deepEqual(Object.keys(ASPECT_RATIO_TEMPLATE_DEFINITIONS).sort(), ['1:1', '9:16']);
  assert.equal(Object.isFrozen(ASPECT_RATIO_TEMPLATE_DEFINITIONS), true);

  for (const [ratio, expected] of Object.entries(EXPECTED_TEMPLATES)) {
    const template = ASPECT_RATIO_TEMPLATE_DEFINITIONS[ratio];
    assert.ok(template, `missing template for ${ratio}`);
    assert.equal(template.ratio, ratio);
    assert.equal(template.id, expected.id);
    assert.deepEqual(template.canvas, expected.canvas);
    assert.deepEqual(template.logo.box, expected.logoBox);
    assert.deepEqual(template.card.box, expected.cardBox);
    assert.deepEqual(template.card.textBox, expected.textBox);

    const canvasBox = { x: 0, y: 0, ...template.canvas };
    assertBoxWithin(canvasBox, template.logo.box, `${ratio}.logo.box`);
    assertBoxWithin(canvasBox, template.card.box, `${ratio}.card.box`);
    assertBoxWithin(template.card.box, template.card.textBox, `${ratio}.card.textBox`);
    assert.ok(template.card.fontSize.min > 0);
    assert.ok(template.card.fontSize.max >= template.card.fontSize.min);

    if (template.referenceAsset) {
      const referencePath = path.resolve(serviceRoot, template.referenceAsset);
      assert.equal(existsSync(referencePath), true, `missing reference asset ${referencePath}`);
      const metadata = await sharp(referencePath).metadata();
      assert.deepEqual(
        { width: metadata.width, height: metadata.height },
        template.referenceCanvas || template.canvas,
        `reference asset for ${ratio} must match its declared source canvas`,
      );
    }

    if (template.logo.mode === 'asset') {
      const candidates = ['public', 'dist'].map((root) => path.join(
        projectRoot,
        root,
        template.logo.assetFolder,
        template.logo.assetFile,
      ));
      const logoPath = candidates.find((candidate) => existsSync(candidate));
      assert.ok(logoPath, `missing logo asset ${template.logo.assetFile}`);
      const metadata = await sharp(logoPath).metadata();
      assert.ok(metadata.width > 0 && metadata.height > 0);
      assert.equal(metadata.hasAlpha, true, 'the fixed logo must retain its transparent background');
    }
  }
});

test('the font registry maps every selection to its exact Pango face and shipped OTF', () => {
  assert.equal(DEFAULT_ASPECT_RATIO_FONT_ID, 'cabify-ciudad-bold');
  assert.deepEqual(Object.keys(ASPECT_RATIO_FONT_REGISTRY).sort(), Object.keys(EXPECTED_FONTS).sort());
  assert.equal(Object.isFrozen(ASPECT_RATIO_FONT_REGISTRY), true);

  for (const [fontId, [pangoName, fileName]] of Object.entries(EXPECTED_FONTS)) {
    const font = ASPECT_RATIO_FONT_REGISTRY[fontId];
    assert.equal(font.id, fontId);
    assert.equal(font.pangoName, pangoName);
    assert.equal(font.fileName, fileName);
    assert.equal(resolveAspectRatioFontId({ fontId }), fontId);

    const candidates = ['public', 'dist'].map((root) => path.join(projectRoot, root, 'fonts', fileName));
    const fontPath = candidates.find((candidate) => existsSync(candidate));
    assert.ok(fontPath, `missing OTF for ${fontId}`);
    assert.ok(statSync(fontPath).size > 0, `empty OTF for ${fontId}`);
  }

  assert.equal(resolveAspectRatioFontId(), DEFAULT_ASPECT_RATIO_FONT_ID);
  assert.equal(
    resolveAspectRatioFontId({ fontFamily: ' ', fontWeight: '' }),
    DEFAULT_ASPECT_RATIO_FONT_ID,
  );
  assert.equal(
    resolveAspectRatioFontId({ fontFamily: 'Cabify Ciudad Text', fontWeight: 'Semi Bold' }),
    'cabify-ciudad-text-semibold',
  );
});

test('invalid font, template, ratio, scene and text inputs fail closed', async () => {
  const sceneDataUrl = await buildSolidDataUrl('#123456');

  assert.throws(
    () => resolveAspectRatioFontId({ fontId: 'arial-bold' }),
    /Unknown Aspect Ratio fontId/,
  );
  assert.throws(
    () => resolveAspectRatioFontId({ fontFamily: 'Arial', fontWeight: 'Bold' }),
    /Unknown Aspect Ratio font family/,
  );
  assert.throws(
    () => resolveAspectRatioFontId({ fontFamily: 'Cabify Ciudad', fontWeight: 'Medium' }),
    /Unknown Aspect Ratio font weight/,
  );
  assert.throws(
    () => resolveAspectRatioFontId({ fontFamily: 'Cabify Ciudad Text', fontWeight: 'Black' }),
    /not an available OTF face/,
  );

  const valid = {
    sceneDataUrl,
    targetRatio: '1:1',
    templateId: EXPECTED_TEMPLATES['1:1'].id,
    text: 'Texto válido',
  };

  await assert.rejects(
    () => composeAspectRatioTemplate({ ...valid, targetRatio: '16:9' }),
    /Unsupported Aspect Ratio template ratio/,
  );
  await assert.rejects(
    () => composeAspectRatioTemplate({ ...valid, templateId: EXPECTED_TEMPLATES['9:16'].id }),
    /is not valid for targetRatio/,
  );
  await assert.rejects(
    () => composeAspectRatioTemplate({ ...valid, templateId: '' }),
    /templateId must be a non-empty string/,
  );
  await assert.rejects(
    () => composeAspectRatioTemplate({ ...valid, text: undefined }),
    /text is required/,
  );
  await assert.rejects(
    () => composeAspectRatioTemplate({ ...valid, text: '  \r\n  ' }),
    /text must not be empty/,
  );
  await assert.rejects(
    () => composeAspectRatioTemplate({ ...valid, text: 'Texto\u0000oculto' }),
    /unsupported control characters/,
  );
  await assert.rejects(
    () => composeAspectRatioTemplate({ ...valid, text: 'a'.repeat(1001) }),
    /1000-character/,
  );
  await assert.rejects(
    () => composeAspectRatioTemplate({ ...valid, sceneDataUrl: 'not-a-data-url' }),
    /Invalid sceneDataUrl/,
  );
  await assert.rejects(
    () => composeAspectRatioTemplate({
      ...valid,
      sceneDataUrl: 'data:text/plain;base64,dGV4dA==',
    }),
    /Unsupported sceneDataUrl MIME type/,
  );
});

test('the compositor emits canonical PNG sizes and centres copy inside the fixed text boxes', async () => {
  const sceneDataUrl = await buildSolidDataUrl('#1277CC');

  for (const [ratio, expected] of Object.entries(EXPECTED_TEMPLATES)) {
    const output = await composeAspectRatioTemplate({
      sceneDataUrl,
      targetRatio: ratio,
      templateId: expected.id,
      text: 'Viajá seguro',
    });
    const image = await readRaw(output);
    assert.equal(image.info.width, expected.canvas.width);
    assert.equal(image.info.height, expected.canvas.height);
    assert.equal(image.info.channels, 4);
    assert.equal((await sharp(image.buffer).metadata()).format, 'png');

    const template = ASPECT_RATIO_TEMPLATE_DEFINITIONS[ratio];
    const background = template.card.background
      .slice(1)
      .match(/../g)
      .map((component) => Number.parseInt(component, 16));
    const ink = findInkBounds(image, template.card.textBox, background);
    assert.ok(ink && ink.pixels > 50, `${ratio} copy should render visible glyphs`);

    const inkCentreX = (ink.minX + ink.maxX + 1) / 2;
    const inkCentreY = (ink.minY + ink.maxY + 1) / 2;
    const boxCentreX = template.card.textBox.x + template.card.textBox.width / 2;
    const boxCentreY = template.card.textBox.y + template.card.textBox.height / 2;
    assert.ok(Math.abs(inkCentreX - boxCentreX) <= 2, `${ratio} copy is not horizontally centred`);
    assert.ok(Math.abs(inkCentreY - boxCentreY) <= 2, `${ratio} copy is not vertically centred`);
  }
});

test('synthetic background changes cannot move or rewrite fixed template geometry', async () => {
  const [redScene, blueScene] = await Promise.all([
    buildSolidDataUrl('#F02020'),
    buildSolidDataUrl('#2050F0'),
  ]);

  for (const [ratio, expected] of Object.entries(EXPECTED_TEMPLATES)) {
    const options = {
      targetRatio: ratio,
      templateId: expected.id,
      text: 'Siempre igual',
    };
    const [redOutput, blueOutput] = await Promise.all([
      composeAspectRatioTemplate({ ...options, sceneDataUrl: redScene }),
      composeAspectRatioTemplate({ ...options, sceneDataUrl: blueScene }),
    ]);
    const [red, blue] = await Promise.all([readRaw(redOutput), readRaw(blueOutput)]);
    const template = ASPECT_RATIO_TEMPLATE_DEFINITIONS[ratio];

    assert.notDeepEqual(
      pixelAt(red, Math.floor(template.canvas.width / 2), Math.floor(template.canvas.height / 2)),
      pixelAt(blue, Math.floor(template.canvas.width / 2), Math.floor(template.canvas.height / 2)),
      `${ratio} must retain the generated background`,
    );

    // Removing the rounded ends leaves an entirely opaque card strip. The same
    // text and template must make every decoded pixel in it independent of the
    // model-generated background underneath.
    const cardCore = {
      x: template.card.box.x + template.card.radius,
      y: template.card.box.y,
      width: template.card.box.width - template.card.radius * 2,
      height: template.card.box.height,
    };
    const [redCard, blueCard] = await Promise.all([
      cropRaw(red.buffer, cardCore),
      cropRaw(blue.buffer, cardCore),
    ]);
    assert.equal(redCard.equals(blueCard), true, `${ratio} card geometry changed with the background`);

    if (template.logo.mode === 'reference-exterior') {
      const [redLogo, blueLogo] = await Promise.all([
        cropRaw(red.buffer, template.logo.box),
        cropRaw(blue.buffer, template.logo.box),
      ]);
      assert.equal(redLogo.equals(blueLogo), true, `${ratio} reference logo changed with the background`);
      assert.deepEqual(pixelAt(red, 0, 0), pixelAt(blue, 0, 0), `${ratio} frame changed`);
    } else {
      const logoCandidates = ['public', 'dist'].map((root) => path.join(
        projectRoot,
        root,
        template.logo.assetFolder,
        template.logo.assetFile,
      ));
      const logoPath = logoCandidates.find((candidate) => existsSync(candidate));
      const { data: logo, info } = await sharp(logoPath)
        .resize(template.logo.box.width, template.logo.box.height, { fit: 'fill' })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      let comparedPixels = 0;
      for (let y = 0; y < info.height; y += 1) {
        for (let x = 0; x < info.width; x += 1) {
          const logoOffset = pixelOffset(info, x, y);
          // Only fully opaque source pixels can be bit-identical across two
          // different backgrounds; antialiased edge pixels intentionally blend
          // with the scene beneath the fixed logo mask.
          if (logo[logoOffset + 3] !== 255) continue;
          assert.deepEqual(
            pixelAt(red, template.logo.box.x + x, template.logo.box.y + y),
            pixelAt(blue, template.logo.box.x + x, template.logo.box.y + y),
          );
          comparedPixels += 1;
        }
      }
      assert.ok(comparedPixels > 1000, `${ratio} logo mask did not contain enough opaque pixels`);
    }
  }
});

test('callers cannot recolour the immutable template layers', async () => {
  const attemptedOverrides = {
    frameColor: '#FF0000',
    logoColor: '#00FF00',
    cardBackgroundColor: '#0000FF',
    cardTextColor: '#111111',
  };
  const output = await composeAspectRatioTemplate({
    sceneDataUrl: await buildSolidDataUrl('#102030'),
    targetRatio: '1:1',
    text: 'Color exacto',
    ...attemptedOverrides,
  });
  const image = await readRaw(output);
  const template = ASPECT_RATIO_TEMPLATE_DEFINITIONS['1:1'];

  assert.deepEqual(pixelAt(image, 0, 0), [0xC7, 0xE0, 0xF8, 0xFF]);
  assert.deepEqual(
    pixelAt(image, template.card.box.x + template.card.radius, template.card.box.y + 4),
    [0x60, 0x34, 0xC6, 0xFF],
  );

  const logoCrop = await sharp(image.buffer)
    .extract({
      left: template.logo.box.x,
      top: template.logo.box.y,
      width: template.logo.box.width,
      height: template.logo.box.height,
    })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });
  let exactLogoPixels = 0;
  for (let offset = 0; offset < logoCrop.data.length; offset += logoCrop.info.channels) {
    if (
      logoCrop.data[offset] === 0x71
      && logoCrop.data[offset + 1] === 0x45
      && logoCrop.data[offset + 2] === 0xCE
      && logoCrop.data[offset + 3] === 0xFF
    ) exactLogoPixels += 1;
  }
  assert.ok(exactLogoPixels > 1000, 'logo should be tinted with the source wordmark colour');
});

test('every card is set in the one hardcoded face, whatever the caller passes', async () => {
  const sceneDataUrl = await buildSolidDataUrl('#186CAA');
  const common = { sceneDataUrl, targetRatio: '1:1', text: 'Movete con Cabify' };

  assert.equal(CARD_COPY_FONT_ID, 'cabify-ciudad-bold');

  // The compositor takes no font input. Anything a caller invents is ignored
  // rather than honoured, so no code path can ship a card in another weight.
  const [plain, withStrayFontId, withStrayFamily] = await Promise.all([
    composeAspectRatioTemplate(common),
    composeAspectRatioTemplate({ ...common, fontId: 'cabify-ciudad-black' }),
    composeAspectRatioTemplate({ ...common, cardFontFamily: 'Arial', cardFontWeight: 'Light' }),
  ]);
  assert.equal(withStrayFontId, plain, 'a stray fontId must not change the render');
  assert.equal(withStrayFamily, plain, 'stray family/weight must not change the render');

  // And the copy really renders: an empty text box would satisfy every
  // assertion above, since all three renders would be identically blank.
  const ink = async (dataUrl) => {
    const image = await readRaw(dataUrl);
    const { textBox } = ASPECT_RATIO_TEMPLATE_DEFINITIONS['1:1'].card;
    let count = 0;
    for (let y = textBox.y; y < textBox.y + textBox.height; y += 1) {
      for (let x = textBox.x; x < textBox.x + textBox.width; x += 1) {
        const [r, g, b] = pixelAt(image, x, y);
        if (r > 205 && g > 205 && b > 205) count += 1;
      }
    }
    return count;
  };
  assert.ok(await ink(plain) > 100, 'the copy should render visible glyphs');
});

test('copy is escaped before Pango rendering and cannot inject markup or colour', async () => {
  const output = await composeAspectRatioTemplate({
    sceneDataUrl: await buildSolidDataUrl('#2080C0'),
    targetRatio: '1:1',
    text: '<span foreground="#FF0000">X</span> & literal',
  });
  const image = await readRaw(output);
  const { textBox } = ASPECT_RATIO_TEMPLATE_DEFINITIONS['1:1'].card;
  let redPixels = 0;
  let lightTextPixels = 0;

  for (let y = textBox.y; y < textBox.y + textBox.height; y += 1) {
    for (let x = textBox.x; x < textBox.x + textBox.width; x += 1) {
      const [r, g, b] = pixelAt(image, x, y);
      if (r > 200 && g < 90 && b < 90) redPixels += 1;
      if (r > 205 && g > 205 && b > 205) lightTextPixels += 1;
    }
  }

  assert.equal(redPixels, 0, 'Pango foreground markup was interpreted instead of escaped');
  assert.ok(lightTextPixels > 100, 'the literal escaped copy should still be rendered visibly');
});

test('Aspect Ratio prompts request background only and never ask the model to draw overlays', () => {
  for (const ratio of ['1:1', '9:16']) {
    const prompts = getVariationPrompts(ratio, ASPECT_RATIO_PROMPT_PROFILE);
    // One photograph per ratio: the variations differ by template, not framing.
    assert.equal(prompts.length, 1);
    for (const prompt of prompts) {
      assert.match(prompt, /BACKGROUND-ONLY GENERATION - CRITICAL/);
      assert.match(prompt, /deterministic compositor adds the template frame, logo, text box and OTF-rendered text/);
      assert.match(prompt, /This model call owns ONLY the photograph\/background/);
      assert.match(prompt, /Do NOT draw a replacement frame, logo, card, placeholder/);
      assert.doesNotMatch(prompt, /TARGET FRAME GEOMETRY/);
      assert.doesNotMatch(prompt, /Place the visible logo lockup/);
      assert.doesNotMatch(prompt, /Logo: use the source's CURRENT logo lockup/);
    }
  }
});

test('Aspect Ratio extracts the copy once, then makes ONE model call for the whole ratio', async () => {
  const sourceDataUrl = await buildSolidDataUrl('#5A44A8', 160, 90);
  const generatedBackgroundDataUrl = await buildSolidDataUrl('#2A8CB8', 128, 128);
  const generatedBackground = decodePngDataUrl(generatedBackgroundDataUrl);
  const calls = [];
  const ai = {
    models: {
      generateContent: async (payload) => {
        calls.push(payload);
        if (payload.config?.responseMimeType === 'application/json') {
          return {
            text: JSON.stringify({
              cardText: 'Copy detectado desde el input',
              buttonPresent: false,
              buttonLabel: '',
              cardBackgroundColor: '#6f49e8',
              cardTextColor: '#ffffff',
              cardBrandMarks: '',
              cardTextBox: [700, 100, 900, 900],
              cardFontId: 'cabify-ciudad-semibold',
              buttonFontWeight: '',
            }),
          };
        }
        return {
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  data: generatedBackground.toString('base64'),
                  mimeType: 'image/png',
                },
              }],
            },
          }],
        };
      },
    },
  };

  const result = await generateAspectRatioImages(sourceDataUrl, '1:1', {
    profile: ASPECT_RATIO_PROMPT_PROFILE,
    ai,
    variationConcurrency: 1,
  });

  assert.equal(calls.length, 2, 'expected one extraction and one shared background generation');
  assert.equal(result.images.length, 3);
  assert.deepEqual(result.errors, []);
  const [extractionCall, ...backgroundCalls] = calls;
  assert.equal(extractionCall.config.responseMimeType, 'application/json');
  // No face is requested any more, so the rendered OTF catalog that used to be
  // the second part of this call is gone with it.
  assert.equal('cardFontId' in extractionCall.config.responseJsonSchema.properties, false);
  assert.equal(extractionCall.contents.parts.length, 2);
  assert.match(extractionCall.contents.parts[1].text, /extract the literal copy/);
  assert.doesNotMatch(extractionCall.contents.parts[1].text, /OTF/);

  for (const call of backgroundCalls) {
    assert.equal(call.contents.parts.length, 2);
    assert.match(call.contents.parts[1].text, /BACKGROUND-ONLY GENERATION - CRITICAL/);
  }

  const templateIds = listAspectRatioTemplateIds('1:1');
  assert.equal(templateIds.length, result.images.length);

  for (const [index, imageDataUrl] of result.images.entries()) {
    const expectedOutput = await composeAspectRatioTemplate({
      sceneDataUrl: generatedBackgroundDataUrl,
      targetRatio: '1:1',
      templateId: templateIds[index],
      text: 'Copy detectado desde el input',
    });
    assert.equal(
      imageDataUrl,
      expectedOutput,
      `variation ${index + 1} must be the shared scene composed through ${templateIds[index]}`,
    );
    const metadata = await sharp(decodePngDataUrl(imageDataUrl)).metadata();
    assert.deepEqual({ width: metadata.width, height: metadata.height }, { width: 1024, height: 1024 });
  }

  // The whole point of the change: one source row can no longer ship three
  // outputs an operator cannot tell apart.
  assert.equal(new Set(result.images).size, 3, 'every variation must differ from the others');
});

test('the card is a flat panel: nothing is shaded outside its box', async () => {
  // A pale, perfectly flat scene turns any drop shadow into an obvious halo.
  const sceneDataUrl = await buildSolidDataUrl('#F2F2F2', 512, 512);

  for (const ratio of ['1:1', '9:16']) {
    for (const templateId of listAspectRatioTemplateIds(ratio)) {
      const template = ASPECT_RATIO_TEMPLATE_VARIANTS[ratio].find((entry) => entry.id === templateId);
      assert.equal('shadow' in template.card, false, `${templateId} must not declare a shadow`);

      const image = await readRaw(await composeAspectRatioTemplate({
        sceneDataUrl,
        targetRatio: ratio,
        templateId,
        text: 'Viajá seguro',
      }));
      const { box } = template.card;
      const centreX = box.x + Math.floor(box.width / 2);

      // A drop shadow fell below the card and bled past its sides.
      for (const offset of [1, 4, 10, 18]) {
        assert.deepEqual(
          pixelAt(image, centreX, box.y + box.height + offset).slice(0, 3),
          [0xF2, 0xF2, 0xF2],
          `${templateId} darkened the scene ${offset}px below the card`,
        );
        assert.deepEqual(
          pixelAt(image, box.x - offset, box.y + Math.floor(box.height / 2)).slice(0, 3),
          [0xF2, 0xF2, 0xF2],
          `${templateId} darkened the scene ${offset}px left of the card`,
        );
      }
    }
  }
});

test('every ratio ships one variation per approved reference, and only the template changes', async () => {
  const sceneDataUrl = await buildSolidDataUrl('#2E6F9E', 256, 256);

  for (const ratio of ['1:1', '9:16']) {
    const templateIds = listAspectRatioTemplateIds(ratio);
    assert.equal(templateIds.length, 3, `${ratio} must declare exactly three templates`);
    assert.equal(new Set(templateIds).size, 3, `${ratio} template ids must be unique`);
    assert.equal(templateIds[0], ASPECT_RATIO_TEMPLATE_DEFINITIONS[ratio].id, 'index 0 is the default');

    const referenceAssets = new Set();
    const outputs = [];

    for (const templateId of templateIds) {
      const template = ASPECT_RATIO_TEMPLATE_VARIANTS[ratio].find((entry) => entry.id === templateId);
      assert.equal(template.ratio, ratio);
      assert.deepEqual(template.canvas, ASPECT_RATIO_TEMPLATE_DEFINITIONS[ratio].canvas);

      // Each variant must be measured off its own approved reference file.
      const referencePath = path.resolve(serviceRoot, template.referenceAsset);
      assert.equal(existsSync(referencePath), true, `missing reference asset ${referencePath}`);
      assert.equal(referenceAssets.has(template.referenceAsset), false, 'references must not repeat');
      referenceAssets.add(template.referenceAsset);
      const metadata = await sharp(referencePath).metadata();
      assert.deepEqual(
        { width: metadata.width, height: metadata.height },
        template.referenceCanvas || template.canvas,
        `${templateId} must match its declared source canvas`,
      );

      const canvasBox = { x: 0, y: 0, ...template.canvas };
      assertBoxWithin(canvasBox, template.logo.box, `${templateId}.logo.box`);
      assertBoxWithin(canvasBox, template.card.box, `${templateId}.card.box`);
      assertBoxWithin(template.card.box, template.card.textBox, `${templateId}.card.textBox`);

      // A framed template hides its logo inside the aperture's notch; the
      // full-bleed one has no notch to sit in.
      if (template.scene.mode === 'reference-panel') {
        assert.ok(template.frame.background.match(/^#[0-9A-F]{6}$/), `${templateId} needs a frame ground`);
        assert.match(template.scene.path, /^M [\d.]+ [\d.]+ H /);
      } else {
        assert.equal(template.scene.mode, 'full-bleed');
      }

      outputs.push(await composeAspectRatioTemplate({
        sceneDataUrl,
        targetRatio: ratio,
        templateId,
        text: 'Viajá con la tranquilidad de moverte seguro',
      }));
    }

    assert.equal(new Set(outputs).size, 3, `${ratio} variants must not render identically`);
    for (const output of outputs) {
      const metadata = await sharp(decodePngDataUrl(output)).metadata();
      assert.deepEqual(
        { width: metadata.width, height: metadata.height },
        ASPECT_RATIO_TEMPLATE_DEFINITIONS[ratio].canvas,
      );
    }
  }
});
