import sharp from 'sharp';

const CARD_CONFIG = {
  '9:16': {
    widthRatio: 0.94,
    heightRatio: 0.14,
    bottomMarginRatio: 0.17,
    sideMarginRatio: 0.03,
  },
  '1:1': {
    widthRatio: 0.94,
    heightRatio: 0.30,
    bottomMarginRatio: 0.05,
    sideMarginRatio: 0.03,
  },
};

const dataUrlToBuffer = (dataUrl) => {
  const match = dataUrl.match(/^data:[^;]+;base64,(.+)$/);
  return Buffer.from(match ? match[1] : dataUrl, 'base64');
};

const roundedCornerMask = (width, height, radius) =>
  Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">` +
    `<rect x="0" y="0" width="${width}" height="${height}" rx="${radius}" ry="${radius}" fill="white"/>` +
    `</svg>`
  );

export const compositeCard = async (sceneDataUrl, cardDataUrl, targetRatio) => {
  const config = CARD_CONFIG[targetRatio];
  if (!config) throw new Error(`No card config for ratio: ${targetRatio}`);

  const sceneBuffer = dataUrlToBuffer(sceneDataUrl);
  const cardBuffer = dataUrlToBuffer(cardDataUrl);
  const { width: canvasW, height: canvasH } = await sharp(sceneBuffer).metadata();

  const cardW = Math.round(canvasW * config.widthRatio);
  const cardH = Math.round(canvasH * config.heightRatio);
  const left = Math.round(canvasW * config.sideMarginRatio);
  const top = canvasH - cardH - Math.round(canvasH * config.bottomMarginRatio);
  const radius = Math.round(canvasW * 0.025);

  const resized = await sharp(cardBuffer)
    .resize(cardW, cardH, { fit: 'cover' })
    .toBuffer();

  const mask = roundedCornerMask(cardW, cardH, radius);
  const rounded = await sharp(resized)
    .composite([{ input: mask, blend: 'dest-in' }])
    .png()
    .toBuffer();

  const result = await sharp(sceneBuffer)
    .composite([{ input: rounded, top, left }])
    .png()
    .toBuffer();

  return `data:image/png;base64,${result.toString('base64')}`;
};
