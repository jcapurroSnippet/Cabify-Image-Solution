import sharp from 'sharp';

const ASPECT_RATIO_TOLERANCE = 0.01;

const KNOWN_ASPECT_RATIOS = [
  { label: '1:1', value: 1, aliases: ['1', 'square'] },
  { label: '9:16', value: 9 / 16, aliases: ['portrait'] },
  { label: '16:9', value: 16 / 9, aliases: ['video'] },
  { label: '4:5', value: 4 / 5, aliases: ['vertical'] },
  { label: '1.91:1', value: 1.91, aliases: ['1.91', 'landscape', '1200x628'] },
];

const FIELD_TYPE_ASPECT_RATIOS = new Map([
  ['MARKETING_IMAGE', '1.91:1'],
  ['SQUARE_MARKETING_IMAGE', '1:1'],
  ['PORTRAIT_MARKETING_IMAGE', '9:16'],
  ['TALL_PORTRAIT_MARKETING_IMAGE', '9:16'],
]);

export const formatResolution = ({ width, height } = {}) => `${width}x${height}`;

export const parseResolution = (value) => {
  if (value && typeof value === 'object') {
    const width = Number(value.width);
    const height = Number(value.height);
    if (Number.isFinite(width) && Number.isFinite(height) && width > 0 && height > 0) {
      return { width, height };
    }
  }

  const match = String(value || '').match(/(\d+)\s*[xX\u00d7]\s*(\d+)/);
  if (!match) return null;

  const width = Number(match[1]);
  const height = Number(match[2]);
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return null;

  return { width, height };
};

const ratioValueFromResolution = (resolution) => resolution.width / resolution.height;

export const normalizeAspectRatio = (value) => {
  const text = String(value || '').trim().toLowerCase();
  if (!text) return null;

  const resolution = parseResolution(text);
  if (resolution) return classifyAspectRatio(resolution);

  const normalized = text.replace(/\s+/g, '');
  const known = KNOWN_ASPECT_RATIOS.find(
    (ratio) =>
      ratio.label.toLowerCase() === normalized ||
      ratio.aliases.some((alias) => alias.toLowerCase() === normalized),
  );
  if (known) return known.label;

  const numeric = Number(normalized);
  if (Number.isFinite(numeric) && numeric > 0) {
    const numericMatch = KNOWN_ASPECT_RATIOS.find(
      (ratio) => Math.abs(numeric - ratio.value) <= ASPECT_RATIO_TOLERANCE,
    );
    if (numericMatch) return numericMatch.label;
  }

  return null;
};

export const classifyAspectRatio = (value) => {
  const resolution = parseResolution(value);
  if (!resolution) return normalizeAspectRatio(value);

  const ratioValue = ratioValueFromResolution(resolution);
  const known = KNOWN_ASPECT_RATIOS.find(
    (ratio) => Math.abs(ratioValue - ratio.value) <= ASPECT_RATIO_TOLERANCE,
  );
  if (known) return known.label;

  const divisor = greatestCommonDivisor(resolution.width, resolution.height);
  return `${Math.round(resolution.width / divisor)}:${Math.round(resolution.height / divisor)}`;
};

const greatestCommonDivisor = (left, right) => {
  let a = Math.abs(Math.round(left));
  let b = Math.abs(Math.round(right));
  while (b > 0) {
    const next = a % b;
    a = b;
    b = next;
  }
  return a || 1;
};

export const getRequiredAspectRatio = ({ oldImageResolution, assetFieldType } = {}) => {
  const fromResolution = classifyAspectRatio(oldImageResolution);
  if (fromResolution) return fromResolution;

  return FIELD_TYPE_ASPECT_RATIOS.get(String(assetFieldType || '').trim().toUpperCase()) || null;
};

export const getImageResolutionFromBuffer = async (buffer) => {
  const metadata = await sharp(buffer).metadata();
  const width = Number(metadata.width || 0);
  const height = Number(metadata.height || 0);

  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    throw new Error('Could not read image resolution.');
  }

  return { width, height };
};

export const getImageResolutionFromDataUrl = async (dataUrl) => {
  const match = String(dataUrl || '').match(/^data:[^;]+;base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL format.');

  return getImageResolutionFromBuffer(Buffer.from(match[1], 'base64'));
};

const hasMatchingAspectRatio = (expected, replacement) => {
  const expectedAspectRatio = classifyAspectRatio(expected);
  const replacementAspectRatio = classifyAspectRatio(replacement);
  if (expectedAspectRatio && replacementAspectRatio) {
    return expectedAspectRatio === replacementAspectRatio;
  }

  const expectedResolution = parseResolution(expected);
  const replacementResolution = parseResolution(replacement);
  if (!expectedResolution || !replacementResolution) return false;

  return Math.abs(
    ratioValueFromResolution(expectedResolution) - ratioValueFromResolution(replacementResolution),
  ) <= ASPECT_RATIO_TOLERANCE;
};

export const assertReplacementImageAspectRatio = ({
  expectedResolution,
  expectedAspectRatio,
  replacementResolution,
  creativeId,
}) => {
  const expected = parseResolution(expectedResolution);
  const requiredAspectRatio = normalizeAspectRatio(expectedAspectRatio) || classifyAspectRatio(expected);
  if (!expected && !requiredAspectRatio) return null;

  const replacement = parseResolution(replacementResolution);
  if (!replacement) throw new Error('Could not read replacement image resolution.');

  const replacementAspectRatio = classifyAspectRatio(replacement);
  const matches = requiredAspectRatio
    ? replacementAspectRatio === requiredAspectRatio
    : hasMatchingAspectRatio(expected, replacement);

  if (matches) {
    return {
      expected,
      replacement,
      expectedAspectRatio: requiredAspectRatio,
      replacementAspectRatio,
    };
  }

  const expectedLabel = requiredAspectRatio || classifyAspectRatio(expected);
  const expectedResolutionLabel = expected ? formatResolution(expected) : expectedLabel;
  throw new Error(
    `Replacement creative ${creativeId || 'selected creative'} has resolution ${formatResolution(replacement)} ` +
      `(${replacementAspectRatio}), but Google asset expects ${expectedResolutionLabel} ` +
      `(${expectedLabel}). Choose a ${expectedLabel} creative for this replacement.`
  );
};
