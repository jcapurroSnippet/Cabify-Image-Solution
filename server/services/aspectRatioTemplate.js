import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..', '..');

const deepFreeze = (value) => {
  if (!value || typeof value !== 'object' || Object.isFrozen(value)) return value;
  Object.values(value).forEach(deepFreeze);
  return Object.freeze(value);
};

/**
 * Canonical, pixel-addressed templates for the Aspect Ratio tool.
 *
 * Reference images are the geometry and palette authority. The generated
 * photograph and OTF-rendered copy are the only mutable pixels.
 */
export const ASPECT_RATIO_TEMPLATE_DEFINITIONS = deepFreeze({
  '1:1': {
    id: '1-1-riders-frame',
    ratio: '1:1',
    canvas: { width: 1024, height: 1024 },
    referenceAsset: '../assets/card-references/1-1/aspect-1-1-1_1-2- (7).png',
    frame: { background: '#C7E0F8' },
    scene: {
      mode: 'reference-panel',
      // Rounded photo panel with the local top-left Cabify-logo notch removed.
      path: [
        'M 309 45',
        'H 936',
        'Q 977 45 977 86',
        'V 934',
        'Q 977 975 936 975',
        'H 88',
        'Q 47 975 47 934',
        'V 211',
        'Q 47 170 88 170',
        'H 233',
        'Q 274 170 274 129',
        'V 86',
        'Q 274 45 309 45',
        'Z',
      ].join(' '),
    },
    logo: {
      mode: 'asset',
      assetFolder: 'branding',
      assetFile: 'cabify-logo-white-rgb.png',
      box: { x: 72, y: 77, width: 187, height: 63 },
      colour: '#7145CE',
    },
    card: {
      box: { x: 76, y: 749, width: 872, height: 199 },
      textBox: { x: 116, y: 779, width: 792, height: 139 },
      radius: 29,
      background: '#6034C6',
      textColour: '#FFFFFF',
      fontSize: { min: 28, max: 58 },
      shadow: { offsetY: 9, sigma: 13, opacity: 0.18 },
    },
  },
  '9:16': {
    id: '9-16-riders-frame',
    ratio: '9:16',
    canvas: { width: 1080, height: 1920 },
    referenceCanvas: { width: 768, height: 1376 },
    referenceAsset: '../assets/card-references/9-16/aspect-9-16-9_16-2 (13).png',
    frame: { background: '#C7E0F8' },
    scene: {
      mode: 'reference-panel',
      path: [
        'M 447 56',
        'H 980',
        'Q 1038 56 1038 114',
        'V 1813',
        'Q 1038 1872 980 1872',
        'H 99',
        'Q 41 1872 41 1813',
        'V 272',
        'Q 41 216 99 216',
        'H 326',
        'Q 388 216 388 154',
        'V 114',
        'Q 388 56 447 56',
        'Z',
      ].join(' '),
    },
    logo: {
      mode: 'asset',
      assetFolder: 'branding',
      assetFile: 'cabify-logo-white-rgb.png',
      box: { x: 91, y: 95, width: 246, height: 80 },
      colour: '#7145CE',
    },
    card: {
      box: { x: 86, y: 1291, width: 910, height: 374 },
      textBox: { x: 146, y: 1345, width: 790, height: 265 },
      radius: 44,
      background: '#6034C6',
      textColour: '#FFFFFF',
      fontSize: { min: 32, max: 74 },
      shadow: { offsetY: 12, sigma: 18, opacity: 0.2 },
    },
  },
});

const buildFontDefinition = (id, family, weight, fileName) => ({
  id,
  family,
  weight,
  label: `${family} ${weight}`,
  pangoName: `${family} ${weight}`,
  fileName,
});

/** A whitelist prevents callers from selecting arbitrary server-side files. */
export const ASPECT_RATIO_FONT_REGISTRY = deepFreeze({
  'cabify-ciudad-light': buildFontDefinition(
    'cabify-ciudad-light',
    'Cabify Ciudad',
    'Light',
    'CabifyCiudad-Light.otf',
  ),
  'cabify-ciudad-book': buildFontDefinition(
    'cabify-ciudad-book',
    'Cabify Ciudad',
    'Book',
    'CabifyCiudad-Book.otf',
  ),
  'cabify-ciudad-semibold': buildFontDefinition(
    'cabify-ciudad-semibold',
    'Cabify Ciudad',
    'SemiBold',
    'CabifyCiudad-SemiBold.otf',
  ),
  'cabify-ciudad-bold': buildFontDefinition(
    'cabify-ciudad-bold',
    'Cabify Ciudad',
    'Bold',
    'CabifyCiudad-Bold.otf',
  ),
  'cabify-ciudad-extrabold': buildFontDefinition(
    'cabify-ciudad-extrabold',
    'Cabify Ciudad',
    'ExtraBold',
    'CabifyCiudad-ExtraBold.otf',
  ),
  'cabify-ciudad-black': buildFontDefinition(
    'cabify-ciudad-black',
    'Cabify Ciudad',
    'Black',
    'CabifyCiudad-Black.otf',
  ),
  'cabify-ciudad-text-light': buildFontDefinition(
    'cabify-ciudad-text-light',
    'Cabify Ciudad Text',
    'Light',
    'CabifyCiudadText-Light.otf',
  ),
  'cabify-ciudad-text-book': buildFontDefinition(
    'cabify-ciudad-text-book',
    'Cabify Ciudad Text',
    'Book',
    'CabifyCiudadText-Book.otf',
  ),
  'cabify-ciudad-text-semibold': buildFontDefinition(
    'cabify-ciudad-text-semibold',
    'Cabify Ciudad Text',
    'SemiBold',
    'CabifyCiudadText-SemiBold.otf',
  ),
  'cabify-ciudad-text-bold': buildFontDefinition(
    'cabify-ciudad-text-bold',
    'Cabify Ciudad Text',
    'Bold',
    'CabifyCiudadText-Bold.otf',
  ),
});

export const DEFAULT_ASPECT_RATIO_FONT_ID = 'cabify-ciudad-bold';

const normalizeToken = (value) => String(value ?? '')
  .trim()
  .toLowerCase()
  .normalize('NFD')
  .replace(/[\u0300-\u036f]/g, '')
  .replace(/[^a-z0-9]+/g, '');

const FONT_ID_BY_NORMALIZED_ID = new Map(
  Object.keys(ASPECT_RATIO_FONT_REGISTRY).map((id) => [normalizeToken(id), id]),
);

const FONT_FAMILY_ALIASES = new Map([
  ['cabifyciudad', 'cabify-ciudad'],
  ['ciudad', 'cabify-ciudad'],
  ['cabifyciudadtext', 'cabify-ciudad-text'],
  ['ciudadtext', 'cabify-ciudad-text'],
]);

const FONT_WEIGHT_ALIASES = new Map([
  ['light', 'light'],
  ['300', 'light'],
  ['book', 'book'],
  ['regular', 'book'],
  ['normal', 'book'],
  ['400', 'book'],
  ['semibold', 'semibold'],
  ['demibold', 'semibold'],
  ['600', 'semibold'],
  ['bold', 'bold'],
  ['700', 'bold'],
  ['extrabold', 'extrabold'],
  ['ultrabold', 'extrabold'],
  ['800', 'extrabold'],
  ['black', 'black'],
  ['heavy', 'black'],
  ['900', 'black'],
]);

/**
 * Resolve either a stable font id or the family/weight fields returned by the
 * existing card-copy extractor. Missing font information selects the canonical
 * default; supplied but unknown information is rejected.
 */
export const resolveAspectRatioFontId = ({ fontId, fontFamily, fontWeight } = {}) => {
  if (fontId !== undefined && fontId !== null) {
    if (typeof fontId !== 'string' || fontId.trim().length === 0) {
      throw new Error('fontId must be a non-empty Aspect Ratio font id.');
    }
    const resolved = FONT_ID_BY_NORMALIZED_ID.get(normalizeToken(fontId));
    if (!resolved) throw new Error(`Unknown Aspect Ratio fontId: ${fontId}.`);
    return resolved;
  }

  const normalizedFamily = normalizeToken(fontFamily);
  const normalizedWeight = normalizeToken(fontWeight);
  const hasFamily = normalizedFamily.length > 0;
  const hasWeight = normalizedWeight.length > 0;
  if (!hasFamily && !hasWeight) return DEFAULT_ASPECT_RATIO_FONT_ID;

  const familyKey = hasFamily
    ? FONT_FAMILY_ALIASES.get(normalizedFamily)
    : 'cabify-ciudad';
  if (!familyKey) throw new Error(`Unknown Aspect Ratio font family: ${fontFamily}.`);

  const weightKey = hasWeight
    ? FONT_WEIGHT_ALIASES.get(normalizedWeight)
    : 'bold';
  if (!weightKey) throw new Error(`Unknown Aspect Ratio font weight: ${fontWeight}.`);

  const resolved = `${familyKey}-${weightKey}`;
  if (!ASPECT_RATIO_FONT_REGISTRY[resolved]) {
    throw new Error(`${fontFamily || 'Cabify Ciudad'} ${fontWeight || 'Bold'} is not an available OTF face.`);
  }
  return resolved;
};

const RUNTIME_ASSET_ROOTS = Object.freeze([
  path.join(projectRoot, 'public'),
  path.join(projectRoot, 'dist'),
]);

const resolveRuntimeAsset = (folder, fileName) => {
  const candidates = RUNTIME_ASSET_ROOTS.map((root) => path.join(root, folder, fileName));
  const assetPath = candidates.find((candidate) => existsSync(candidate));
  if (!assetPath) {
    throw new Error(`Missing Aspect Ratio asset ${folder}/${fileName}. Checked public and dist.`);
  }
  return assetPath;
};

const assetBufferCache = new Map();

const readAsset = async (assetPath) => {
  if (!assetBufferCache.has(assetPath)) {
    const loading = readFile(assetPath).catch((error) => {
      assetBufferCache.delete(assetPath);
      throw error;
    });
    assetBufferCache.set(assetPath, loading);
  }
  return assetBufferCache.get(assetPath);
};

const resolveTemplate = (targetRatio, templateId) => {
  if (typeof targetRatio !== 'string' || !targetRatio.trim()) {
    throw new Error('targetRatio is required.');
  }
  const ratio = targetRatio.trim();
  const template = ASPECT_RATIO_TEMPLATE_DEFINITIONS[ratio];
  if (!template) throw new Error(`Unsupported Aspect Ratio template ratio: ${targetRatio}.`);

  if (templateId !== undefined && templateId !== null) {
    if (typeof templateId !== 'string' || !templateId.trim()) {
      throw new Error('templateId must be a non-empty string when supplied.');
    }
    const requested = templateId.trim();
    if (requested !== template.id && requested !== ratio) {
      throw new Error(`Template ${requested} is not valid for targetRatio ${ratio}.`);
    }
  }

  return template;
};

const SUPPORTED_DATA_URL_MIME_TYPES = new Set([
  'image/avif',
  'image/gif',
  'image/jpeg',
  'image/jpg',
  'image/png',
  'image/tiff',
  'image/webp',
]);

const parseSceneDataUrl = async (sceneDataUrl) => {
  if (typeof sceneDataUrl !== 'string' || sceneDataUrl.trim().length === 0) {
    throw new Error('sceneDataUrl is required.');
  }
  const match = sceneDataUrl.match(/^data:([^;,]+);base64,([A-Za-z0-9+/=\r\n]+)$/);
  if (!match) throw new Error('Invalid sceneDataUrl. Expected a base64 image data URL.');

  const mimeType = match[1].trim().toLowerCase();
  if (!SUPPORTED_DATA_URL_MIME_TYPES.has(mimeType)) {
    throw new Error(`Unsupported sceneDataUrl MIME type: ${mimeType}.`);
  }

  const encoded = match[2].replace(/\s+/g, '');
  if (!encoded || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error('Invalid sceneDataUrl base64 content.');
  }

  const buffer = Buffer.from(encoded, 'base64');
  const canonicalInput = encoded.replace(/=+$/g, '');
  const canonicalBuffer = buffer.toString('base64').replace(/=+$/g, '');
  if (!buffer.length || canonicalInput !== canonicalBuffer) {
    throw new Error('Invalid sceneDataUrl base64 content.');
  }

  try {
    const metadata = await sharp(buffer, { failOn: 'error' }).metadata();
    if (!metadata.width || !metadata.height) throw new Error('Image has no dimensions.');
  } catch (error) {
    throw new Error(`sceneDataUrl does not contain a readable image: ${error.message}`);
  }
  return buffer;
};

const normalizeText = (text) => {
  if (typeof text !== 'string') throw new Error('text is required.');
  const normalized = text.replace(/\r\n?/g, '\n').replace(/\t/g, ' ').trim();
  if (!normalized) throw new Error('text must not be empty.');
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.test(normalized)) {
    throw new Error('text contains unsupported control characters.');
  }
  if ([...normalized].length > 1000) {
    throw new Error('text exceeds the 1000-character Aspect Ratio limit.');
  }
  return normalized;
};

const escapePangoMarkup = (value) => value
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;')
  .replace(/'/g, '&apos;');

let fontReferenceCache = null;

/**
 * Render the ten bundled OTFs into one labelled visual catalog. The extraction
 * model receives this beside the source creative, so font classification is a
 * direct glyph comparison rather than a guess based only on weight names.
 */
export const buildAspectRatioFontReference = async () => {
  if (fontReferenceCache) return fontReferenceCache;

  fontReferenceCache = (async () => {
    const width = 1400;
    const rowHeight = 92;
    const entries = Object.entries(ASPECT_RATIO_FONT_REGISTRY);
    const height = rowHeight * entries.length;
    const backgroundSvg = Buffer.from(
      `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
      + '<rect width="100%" height="100%" fill="#FFFFFF"/>'
      + entries.map((_, index) => (
        index % 2 === 0
          ? `<rect x="0" y="${index * rowHeight}" width="${width}" height="${rowHeight}" fill="#F5F2FF"/>`
          : ''
      )).join('')
      + entries.slice(1).map((_, index) => (
        `<line x1="0" y1="${(index + 1) * rowHeight}" x2="${width}" y2="${(index + 1) * rowHeight}" stroke="#DED8F4" stroke-width="1"/>`
      )).join('')
      + '</svg>',
    );

    const textLayers = await Promise.all(entries.map(async ([fontId, font], index) => {
      const fontPath = resolveRuntimeAsset('fonts', font.fileName);
      const sample = `${fontId}  ·  Aa Ee Gg Rr 123  ·  Viajá cómodo y seguro`;
      const input = await sharp({
        text: {
          text: `<span foreground="#241742">${escapePangoMarkup(sample)}</span>`,
          font: `${font.pangoName} 32`,
          fontfile: fontPath,
          width: width - 64,
          align: 'left',
          rgba: true,
          dpi: 72,
          wrap: 'none',
        },
      }).png().toBuffer();
      const metadata = await sharp(input).metadata();
      return {
        input,
        left: 32,
        top: index * rowHeight + Math.max(0, Math.floor((rowHeight - (metadata.height || 0)) / 2)),
      };
    }));

    const output = await sharp(backgroundSvg)
      .composite(textLayers)
      .png()
      .toBuffer();
    return Object.freeze({ data: output.toString('base64'), mimeType: 'image/png' });
  })().catch((error) => {
    fontReferenceCache = null;
    throw error;
  });

  return fontReferenceCache;
};

const buildTransparentCanvas = ({ width, height }) => sharp({
  create: {
    width,
    height,
    channels: 4,
    background: { r: 0, g: 0, b: 0, alpha: 0 },
  },
});

const roundedRectangleSvg = ({ width, height, radius, fill, opacity = 1 }) => Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
  + `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="${fill}" fill-opacity="${opacity}"/>`
  + '</svg>',
);

const fixedCardLayerCache = new Map();

const buildFixedCardLayers = async (template) => {
  if (fixedCardLayerCache.has(template.id)) return fixedCardLayerCache.get(template.id);

  const loading = (async () => {
    const { canvas, card } = template;
    const cardShape = await sharp(roundedRectangleSvg({
      width: card.box.width,
      height: card.box.height,
      radius: card.radius,
      fill: card.background,
    })).png().toBuffer();

    const shadowShape = await sharp(roundedRectangleSvg({
      width: card.box.width,
      height: card.box.height,
      radius: card.radius,
      fill: '#000000',
      opacity: card.shadow.opacity,
    })).png().toBuffer();

    const shadow = await buildTransparentCanvas(canvas)
      .composite([{
        input: shadowShape,
        left: card.box.x,
        top: card.box.y + card.shadow.offsetY,
      }])
      .blur(card.shadow.sigma)
      .png()
      .toBuffer();

    return { cardShape, shadow };
  })().catch((error) => {
    fixedCardLayerCache.delete(template.id);
    throw error;
  });

  fixedCardLayerCache.set(template.id, loading);
  return loading;
};

const sceneMaskCache = new Map();

const buildSceneMask = async (template) => {
  if (template.scene.mode !== 'reference-panel') return null;
  if (sceneMaskCache.has(template.id)) return sceneMaskCache.get(template.id);

  const { width, height } = template.canvas;
  const loading = sharp(Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`
    + `<path d="${template.scene.path}" fill="#FFFFFF"/>`
    + '</svg>',
  )).png().toBuffer().catch((error) => {
    sceneMaskCache.delete(template.id);
    throw error;
  });

  sceneMaskCache.set(template.id, loading);
  return loading;
};

const normalizeSceneToCanvas = (sceneBuffer, canvas) => sharp(sceneBuffer, { failOn: 'error' })
  .rotate()
  .resize(canvas.width, canvas.height, {
    fit: 'cover',
    position: 'centre',
  })
  .flatten({ background: '#000000' })
  .toColourspace('srgb')
  .png()
  .toBuffer();

const buildTemplateBase = async (sceneBuffer, template) => {
  const normalizedScene = await normalizeSceneToCanvas(sceneBuffer, template.canvas);
  if (template.scene.mode === 'full-bleed') return normalizedScene;

  if (template.scene.mode !== 'reference-panel' || !template.referenceAsset || !template.frame) {
    throw new Error(`Template ${template.id} has an invalid scene definition.`);
  }

  const referencePath = path.resolve(__dirname, template.referenceAsset);
  if (!existsSync(referencePath)) {
    throw new Error(`Missing Aspect Ratio reference asset for template ${template.id}.`);
  }
  // Keep checking the declared reference: it is the provenance for this
  // pixel-addressed aperture even though its campaign colours are not reused.
  await readAsset(referencePath);
  const sceneMask = await buildSceneMask(template);

  const maskedScene = await sharp(normalizedScene)
    .ensureAlpha()
    .composite([{ input: sceneMask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  // The path, dimensions, notch and fill are immutable template properties.
  return sharp({
    create: {
      width: template.canvas.width,
      height: template.canvas.height,
      channels: 4,
      background: template.frame.background,
    },
  })
    .composite([{ input: maskedScene, left: 0, top: 0 }])
    .png()
    .toBuffer();
};

const textLayerCache = new Map();
const MAX_TEXT_LAYER_CACHE_ENTRIES = 64;

const cacheTextLayer = (key, loader) => {
  if (textLayerCache.has(key)) {
    const cached = textLayerCache.get(key);
    textLayerCache.delete(key);
    textLayerCache.set(key, cached);
    return cached;
  }

  const loading = loader().catch((error) => {
    textLayerCache.delete(key);
    throw error;
  });
  textLayerCache.set(key, loading);
  while (textLayerCache.size > MAX_TEXT_LAYER_CACHE_ENTRIES) {
    textLayerCache.delete(textLayerCache.keys().next().value);
  }
  return loading;
};

const renderTextAtSize = async ({ text, font, fontPath, card, fontSize }) => {
  const escapedText = escapePangoMarkup(text);
  const markup = `<span foreground="${card.textColour}">${escapedText}</span>`;
  const buffer = await sharp({
    text: {
      text: markup,
      font: `${font.pangoName} ${fontSize}`,
      fontfile: fontPath,
      width: card.textBox.width,
      align: 'centre',
      rgba: true,
      dpi: 72,
      wrap: 'word-char',
    },
  }).png().toBuffer();
  const metadata = await sharp(buffer).metadata();
  if (!metadata.width || !metadata.height) throw new Error('Sharp returned an empty text layer.');
  return { buffer, width: metadata.width, height: metadata.height, fontSize };
};

const textFits = (rendered, textBox) =>
  rendered.width <= textBox.width && rendered.height <= textBox.height;

const buildTextLayer = async (template, text, fontId) => {
  const key = `${template.id}\u0000${fontId}\u0000${text}`;
  return cacheTextLayer(key, async () => {
    const font = ASPECT_RATIO_FONT_REGISTRY[fontId];
    const fontPath = resolveRuntimeAsset('fonts', font.fileName);
    const { card } = template;
    const minimum = card.fontSize.min;
    const maximum = card.fontSize.max;
    const renderedBySize = new Map();

    const render = async (fontSize) => {
      if (!renderedBySize.has(fontSize)) {
        renderedBySize.set(fontSize, renderTextAtSize({
          text,
          font,
          fontPath,
          card,
          fontSize,
        }));
      }
      return renderedBySize.get(fontSize);
    };

    const minimumRender = await render(minimum);
    if (!textFits(minimumRender, card.textBox)) {
      throw new Error(
        `Text overflow in template ${template.id}: copy does not fit at the minimum ${minimum}px font size.`,
      );
    }

    let best = minimumRender;
    const maximumRender = await render(maximum);
    if (textFits(maximumRender, card.textBox)) {
      best = maximumRender;
    } else {
      let low = minimum + 1;
      let high = maximum - 1;
      while (low <= high) {
        const middle = Math.floor((low + high) / 2);
        const candidate = await render(middle);
        if (textFits(candidate, card.textBox)) {
          best = candidate;
          low = middle + 1;
        } else {
          high = middle - 1;
        }
      }
    }

    const left = card.textBox.x + Math.floor((card.textBox.width - best.width) / 2);
    const top = card.textBox.y + Math.floor((card.textBox.height - best.height) / 2);
    if (
      left < card.textBox.x
      || top < card.textBox.y
      || left + best.width > card.textBox.x + card.textBox.width
      || top + best.height > card.textBox.y + card.textBox.height
    ) {
      throw new Error(`Text overflow in template ${template.id}.`);
    }

    return { input: best.buffer, left, top, fontSize: best.fontSize };
  });
};

const fixedLogoCache = new Map();

const buildFixedLogo = async (template) => {
  if (template.logo.mode !== 'asset') return null;
  if (fixedLogoCache.has(template.id)) return fixedLogoCache.get(template.id);

  const loading = (async () => {
    const assetPath = resolveRuntimeAsset(template.logo.assetFolder, template.logo.assetFile);
    const source = await readAsset(assetPath);
    const resized = await sharp(source, { failOn: 'error' })
      .resize(template.logo.box.width, template.logo.box.height, { fit: 'fill' })
      .ensureAlpha()
      .png()
      .toBuffer();
    const alpha = await sharp(resized).extractChannel('alpha').png().toBuffer();
    const input = await sharp({
      create: {
        width: template.logo.box.width,
        height: template.logo.box.height,
        channels: 3,
        background: template.logo.colour,
      },
    })
      .joinChannel(alpha)
      .png()
      .toBuffer();
    return {
      input,
      left: template.logo.box.x,
      top: template.logo.box.y,
    };
  })().catch((error) => {
    fixedLogoCache.delete(template.id);
    throw error;
  });

  fixedLogoCache.set(template.id, loading);
  return loading;
};

/**
 * Place a generated scene behind immutable template layers and render the copy
 * locally with the selected OTF. No model call occurs in this function.
 */
export const composeAspectRatioTemplate = async ({
  sceneDataUrl,
  targetRatio,
  text,
  fontId,
  templateId,
} = {}) => {
  const template = resolveTemplate(targetRatio, templateId);
  const normalizedText = normalizeText(text);
  const resolvedFontId = resolveAspectRatioFontId({ fontId });
  const sceneBuffer = await parseSceneDataUrl(sceneDataUrl);

  const [base, cardLayers, textLayer, logoLayer] = await Promise.all([
    buildTemplateBase(sceneBuffer, template),
    buildFixedCardLayers(template),
    buildTextLayer(template, normalizedText, resolvedFontId),
    buildFixedLogo(template),
  ]);

  const composites = [
    { input: cardLayers.shadow, left: 0, top: 0 },
    { input: cardLayers.cardShape, left: template.card.box.x, top: template.card.box.y },
    ...(logoLayer ? [logoLayer] : []),
    { input: textLayer.input, left: textLayer.left, top: textLayer.top },
  ];

  const result = await sharp(base, { failOn: 'error' })
    .resize(template.canvas.width, template.canvas.height, { fit: 'fill' })
    .ensureAlpha()
    .composite(composites)
    .png()
    .toBuffer();

  return `data:image/png;base64,${result.toString('base64')}`;
};
