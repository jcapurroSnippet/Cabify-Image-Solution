import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertCompleteRatioVariations,
  buildBatchReviewItems,
  buildBatchVariationSheetFormatRequests,
  buildBatchVariationRows,
  buildBatchVariationSourceOutput,
  findSixteenNineImageColumn,
  orderRegisteredReviewItemIds,
  summarizeBatchVariations,
} from '../server/services/batchProcessor.js';
import {
  ASPECT_RATIO_PROMPT_PROFILE,
  extractCardCopyFromSource,
  getVariationPrompts,
  placeCardOnScene,
} from '../server/services/imageGenerator.js';

const captureAspectRatioCardPrompt = async (targetRatio, cardCopyOverrides = {}) => {
  let requestPayload = null;
  const ai = {
    models: {
      generateContent: async (payload) => {
        requestPayload = payload;
        return {
          candidates: [{
            content: {
              parts: [{
                inlineData: {
                  data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
                  mimeType: 'image/png',
                },
              }],
            },
          }],
        };
      },
    },
  };

  const cardCopy = cardCopyOverrides === null
    ? null
    : {
      cardText: 'Texto original',
      buttonPresent: true,
      buttonLabel: 'Pedí ahora',
      cardBackgroundColor: '#ffffff',
      cardTextColor: '#6f49e8',
      cardBrandMarks: '',
      ...cardCopyOverrides,
    };

  await placeCardOnScene(
    ai,
    'data:image/png;base64,c2NlbmU=',
    'c291cmNl',
    'image/png',
    targetRatio,
    cardCopy,
    ASPECT_RATIO_PROMPT_PROFILE,
  );

  assert.ok(requestPayload);
  const parts = requestPayload.contents.parts;
  return { parts, prompt: parts.at(-1).text };
};

test('prefers the explicit 16.9 image header over columns with more URLs', () => {
  const columnIndex = findSixteenNineImageColumn(
    ['Preview', '16.9 IMG', 'Source URL'],
    { 0: 90, 1: 12, 2: 120 },
  );

  assert.equal(columnIndex, 1);
});

test('rejects a 16.9 video header as a batch image source', () => {
  assert.equal(findSixteenNineImageColumn(['16.9 VIDEO'], { 0: 12 }), -1);
});

test('accepts 16:9 and 16x9 image header aliases', () => {
  assert.equal(findSixteenNineImageColumn(['16:9 IMAGE'], { 0: 1 }), 0);
  assert.equal(findSixteenNineImageColumn(['16x9 IMG'], { 0: 1 }), 0);
});

test('requires exactly three generated variants for every ratio', () => {
  assert.throws(
    () => assertCompleteRatioVariations({
      images: ['square-1', 'square-2'],
      ratio: '1:1',
      rowNumber: 8,
    }),
    /Expected exactly 3 1:1 variants for row 8, but generated 2/,
  );

  const complete = ['vertical-1', 'vertical-2', 'vertical-3'];
  assert.strictEqual(
    assertCompleteRatioVariations({ images: complete, ratio: '9:16', rowNumber: 8 }),
    complete,
  );
});

test('orders registered review item IDs by generation ID', () => {
  const expected = Array.from({ length: 6 }, (_, index) => ({
    generationId: `generation-${index + 1}`,
  }));
  const registered = [4, 1, 6, 2, 5, 3].map((number, index) => (
    index % 2 === 0
      ? { generation_id: `generation-${number}`, review_item_id: `item-${number}` }
      : { generationId: `generation-${number}`, reviewItemId: `item-${number}` }
  ));

  assert.deepEqual(
    orderRegisteredReviewItemIds(expected, registered),
    ['item-1', 'item-2', 'item-3', 'item-4', 'item-5', 'item-6'],
  );
});

test('rejects an incomplete Creative Review registration', () => {
  const expected = Array.from({ length: 6 }, (_, index) => ({
    generationId: `generation-${index + 1}`,
  }));
  const registered = Array.from({ length: 5 }, (_, index) => ({
    generationId: `generation-${index + 1}`,
    reviewItemId: `item-${index + 1}`,
  }));

  assert.throws(
    () => orderRegisteredReviewItemIds(expected, registered),
    /must return 6 item IDs/,
  );
});

test('rejects duplicate or mismatched Creative Review item IDs', () => {
  const expected = Array.from({ length: 6 }, (_, index) => ({
    generationId: `generation-${index + 1}`,
  }));
  const duplicated = Array.from({ length: 6 }, (_, index) => ({
    generationId: `generation-${index + 1}`,
    reviewItemId: index === 5 ? 'item-5' : `item-${index + 1}`,
  }));
  const mismatched = Array.from({ length: 6 }, (_, index) => ({
    generationId: index === 5 ? 'another-generation' : `generation-${index + 1}`,
    reviewItemId: `item-${index + 1}`,
  }));

  assert.throws(
    () => orderRegisteredReviewItemIds(expected, duplicated),
    /must return 6 item IDs/,
  );
  assert.throws(
    () => orderRegisteredReviewItemIds(expected, mismatched),
    /must return 6 item IDs/,
  );
});

test('formats the batch output tab across all 19 canonical columns', () => {
  const requests = buildBatchVariationSheetFormatRequests(321, 47);
  const sheetProperties = requests.find((request) => request.updateSheetProperties)
    ?.updateSheetProperties;
  const headerFormat = requests.find((request) => request.repeatCell)?.repeatCell;
  const filter = requests.find((request) => request.setBasicFilter)?.setBasicFilter;

  assert.equal(sheetProperties?.properties?.gridProperties?.frozenRowCount, 1);
  assert.deepEqual(
    sheetProperties?.properties?.tabColorStyle?.rgbColor,
    { red: 0.435, green: 0.286, blue: 0.91 },
  );
  assert.equal(headerFormat?.range?.sheetId, 321);
  assert.equal(headerFormat?.range?.endColumnIndex, 19);
  assert.equal(headerFormat?.cell?.userEnteredFormat?.textFormat?.bold, true);
  assert.deepEqual(filter?.filter?.range, {
    sheetId: 321,
    startRowIndex: 0,
    endRowIndex: 47,
    startColumnIndex: 0,
    endColumnIndex: 19,
  });
});

test('adds dedicated prompts for 1.91:1 image generation', () => {
  const prompts = getVariationPrompts('1.91:1');

  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /1\.91:1 landscape canvas/);
  assert.match(prompts[0], /1200x628 Google marketing image/);
});

test('the Aspect Ratio prompt profile is scoped to that tool alone', () => {
  for (const ratio of ['1:1', '9:16', '1.91:1']) {
    const ciclo = getVariationPrompts(ratio).join('\n');
    const aspectRatio = getVariationPrompts(ratio, ASPECT_RATIO_PROMPT_PROFILE).join('\n');

    // Only the Aspect Ratio tool forbids inventing content that is absent from
    // the source; the ciclo keeps the wording it shipped with.
    assert.match(aspectRatio, /CONTENT LOCK/);
    assert.doesNotMatch(ciclo, /CONTENT LOCK/);
  }

  // Half the approved creatives have no vehicle at all, so demanding a visible
  // car invites the model to invent one. The ciclo still asserts it.
  const carDemand = /the car must remain clearly visible/;
  assert.match(getVariationPrompts('9:16').join('\n'), carDemand);
  assert.doesNotMatch(getVariationPrompts('9:16', ASPECT_RATIO_PROMPT_PROFILE).join('\n'), carDemand);
});

test('the Aspect Ratio reframe applies supplied frames as geometry only and keeps the 9:16 logo straight', () => {
  const square = getVariationPrompts('1:1', ASPECT_RATIO_PROMPT_PROFILE).join('\n');
  const vertical = getVariationPrompts('9:16', ASPECT_RATIO_PROMPT_PROFILE).join('\n');

  assert.match(square, /PREVIOUS visual identity/);
  assert.match(square, /SOURCE layout is NOT authoritative/);
  assert.match(square, /TARGET FRAME GEOMETRY - 1:1 \(frame only\)/);
  assert.match(square, /outer ground is therefore a thin, even frame of about 5%/);
  assert.match(square, /must never exceed 6\.5%/);
  assert.match(vertical, /TARGET FRAME GEOMETRY - 9:16 \(frame only\)/);
  assert.match(vertical, /left and right frame gaps of about 4\.7%/);
  assert.match(vertical, /top\/bottom frame gaps of about 2\.7%/);
  assert.match(vertical, /side gaps must never exceed 5\.5%/);
  assert.match(vertical, /must never create a full-width header/);
  assert.match(square, /width about 19% of canvas width/);
  assert.match(vertical, /width about 24% of canvas width/);
  assert.match(vertical, /LOCAL TOP-LEFT notch/);
  assert.match(vertical, /anchored to the left frame edge at x=4\.7%/);
  assert.match(vertical, /left tab\/notch position and size are fixed/);
  assert.match(vertical, /perfectly straight and horizontal/);
  assert.match(vertical, /0-degree rotation/);
  assert.match(vertical, /no tilt, skew, curve or perspective distortion/);
  assert.match(vertical, /9:16 SUBJECT COMPOSITION - NON-NEGOTIABLE/);
  assert.match(vertical, /centred around x=50%/);
  assert.match(vertical, /central x=42%-58% band/);
  assert.match(vertical, /centre the person's face and torso rather than the combined silhouette/);
  assert.match(vertical, /Horizontal translation\/reframing of the complete unchanged subject is required/);
});

test('the Aspect Ratio card pass receives the source for current identity, never its layout', async () => {
  const { parts, prompt } = await captureAspectRatioCardPrompt('1:1');

  assert.equal(parts.length, 3);
  assert.deepEqual(parts[0].inlineData, { data: 'c2NlbmU=', mimeType: 'image/png' });
  assert.deepEqual(parts[1].inlineData, { data: 'c291cmNl', mimeType: 'image/png' });
  assert.match(prompt, /Image 2 - the CURRENT source creative and identity reference/);
  assert.match(prompt, /CARD COPY LOCK is authoritative for literal words/);
  assert.match(prompt, /IMAGE 2 DEFINES STYLE, NEVER LAYOUT/);
  assert.match(prompt, /NEVER take from Image 2: card width, card height, card aspect ratio/);
  assert.match(prompt, /Never scale Image 2's complete card as one rigid object/);
});

test('the Aspect Ratio card prompt locks target geometry while preserving current typography and CTA styling', async () => {
  for (const ratio of ['1:1', '9:16']) {
    const { prompt } = await captureAspectRatioCardPrompt(ratio);

    assert.match(prompt, ratio === '1:1' ? /width=85%/ : /width=93%/);
    assert.match(prompt, ratio === '1:1'
      ? /left and right gaps are ALWAYS 7\.5% each/
      : /left and right gaps are ALWAYS 3\.5% each/);
    assert.match(prompt, /Never use the narrow source-card width/);
    assert.match(prompt, /INPUT COLOUR LOCK - ABSOLUTE/);
    assert.match(prompt, /Every visible colour from the input is locked/);
    assert.match(prompt, /Never borrow a colour from a target-frame example or another campaign/);
    assert.match(prompt, /typeface and glyph shapes, weight, width, capitalization/);
    assert.match(prompt, /Do NOT substitute a generic sans-serif/);
    assert.match(prompt, /CABIFY CIUDAD TYPOGRAPHY SYSTEM - REQUIRED/);
    assert.match(prompt, /Promotional headlines and expressive card messages use Cabify Ciudad only/);
    assert.match(prompt, /CTA labels, promo codes, buttons and any UI-like component use Cabify Ciudad Text only/);
    assert.match(prompt, /Never tighten tracking or line-height merely to fit more copy/);
    assert.match(prompt, /Source line wrapping is incidental and must NOT be copied/);
    assert.match(prompt, /same proportions, shape, internal spacing, fill or gradient, colour values/);
    assert.match(prompt, /icon, logo, illustration, photograph and image crop/);
    assert.match(prompt, /Card background colour: EXACTLY #FFFFFF/);
    assert.match(prompt, /Text colour: EXACTLY #6F49E8/);
    assert.match(prompt, /grow the card UPWARD only to a maximum/);
    assert.match(prompt, /scale down uniformly by at most 10%/);
    assert.match(prompt, ratio === '1:1' ? /maximum of 32%/ : /maximum of 28%/);

    if (ratio === '1:1') {
      assert.match(prompt, /1:1 card is ALWAYS HORIZONTAL \/ LANDSCAPE/);
      assert.match(prompt, /width-to-height ratio must never be below 2\.3:1/);
      assert.match(prompt, /Never make it square, portrait, narrow, tall or vertically oriented/);
      assert.match(prompt, /x=7\.5%, y=71%, width=85%, height=22%/);
      assert.match(prompt, /bottom edge is fixed at y=93%/);
    }
  }
});

test('long 9:16 copy removes source visual wraps and keeps its fixed bottom edge', async () => {
  const { prompt } = await captureAspectRatioCardPrompt('9:16', {
    cardText: 'Línea uno\nLínea dos\nLínea tres\nLínea cuatro',
  });

  assert.match(prompt, /"cardText": "Línea uno Línea dos Línea tres Línea cuatro"/);
  assert.match(prompt, /9:16 PLATFORM SAFE ZONE - ABSOLUTE/);
  assert.match(prompt, /safe region runs vertically from y=15% through y=84%/);
  assert.match(prompt, /No card pixel may enter either exclusion band/);
  assert.match(prompt, /x=3\.5%, y=62%, width=93%, height=18%/);
  assert.match(prompt, /bottom edge is fixed at y=80%/);
  assert.match(prompt, /visible 4% buffer/);
  assert.match(prompt, /maximum of 28%/);
  assert.match(prompt, /bottom edge remains fixed at 80%/);
  assert.match(prompt, /fixed y=80% bottom edge applies to the panel AND its shadow/);
  assert.match(prompt, /Never render a yellow overlay/);
});

test('the Aspect Ratio card prompt forbids inventing a CTA and re-locks the 9:16 logo orientation', async () => {
  const { prompt } = await captureAspectRatioCardPrompt('9:16', {
    buttonPresent: false,
    buttonLabel: '',
  });

  assert.match(prompt, /"buttonPresent": false/);
  assert.match(prompt, /If "buttonPresent" is false, do not render a button/);
  assert.match(prompt, /If Image 2 has no CTA, do not create one/);
  assert.match(prompt, /9:16 LOGO ORIENTATION LOCK/);
  assert.match(prompt, /exactly 0-degree rotation/);
  assert.match(prompt, /fixed LOCAL TOP-LEFT position/);
  assert.match(prompt, /Do not tilt, skew, warp, curve, rotate, redraw or apply perspective/);
});

test('the Aspect Ratio fallback reads CTA presence and styling directly from the source', async () => {
  const { parts, prompt } = await captureAspectRatioCardPrompt('9:16', null);

  assert.equal(parts.length, 3);
  assert.match(prompt, /Read the exact card text and button label from Image 2 only/);
  assert.match(prompt, /extraction fallback reveals a CTA in Image 2/);
  assert.match(prompt, /extraction fallback visibly shows one in Image 2/);
});

test('card-copy extraction collapses visual source line wrapping before target layout', async () => {
  const ai = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          cardText: 'En\nBuenos Aires,\nmovete\nmejor.',
          buttonPresent: false,
          buttonLabel: '',
          cardBackgroundColor: '#6f49e8',
          cardTextColor: '#ffffff',
          cardBrandMarks: '',
        }),
      }),
    },
  };

  const copy = await extractCardCopyFromSource(ai, 'c291cmNl', 'image/png');

  assert.equal(copy.cardText, 'En Buenos Aires, movete mejor.');
});

test('the landscape template does not inherit the square and vertical source-card lock', async () => {
  const { parts, prompt } = await captureAspectRatioCardPrompt('1.91:1');

  assert.equal(parts.length, 2);
  assert.doesNotMatch(prompt, /SOURCE CARD APPEARANCE LOCK/);
  assert.doesNotMatch(prompt, /Image 2 remains the authoritative visual source/);
  assert.match(prompt, /CANVAS COMPOSITION - 1\.91:1/);
  assert.match(prompt, /Build the purple copy panel, the pastel background and the logo tab/);
});

test('maps uploaded batch variants to review items keyed on the source row', () => {
  const items = buildBatchReviewItems({
    batchId: 'review-123',
    spreadsheetId: 'sheet-456',
    sheetName: 'RIDERS | AR',
    row: { Categoria: 'Legacy category', Ciudad: 'Córdoba' },
    rowNumber: 18,
    referenceUrl: 'https://drive.google.com/reference',
    uploadedLinks: {
      '1:1': ['https://drive.google.com/square-1', 'https://drive.google.com/square-2'],
      '9:16': ['https://drive.google.com/story-1'],
    },
    category: 'Riders',
    plazas: ['Buenos Aires', 'Córdoba'],
  });

  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map(({ ratio, variantIndex, sourceOutput }) => ({ ratio, variantIndex, sourceOutput })),
    [
      { ratio: '1:1', variantIndex: 1, sourceOutput: 'batch:sheet-456:RIDERS | AR:18:1:1:1' },
      { ratio: '1:1', variantIndex: 2, sourceOutput: 'batch:sheet-456:RIDERS | AR:18:1:1:2' },
      { ratio: '9:16', variantIndex: 1, sourceOutput: 'batch:sheet-456:RIDERS | AR:18:9:16:1' },
    ]
  );
  assert.equal(items[0].familyId, 'review-123:row:18');
  assert.equal(items[0].sourceTab, 'RIDERS | AR');
  assert.equal(items[0].sourceSpreadsheetId, 'sheet-456');
  assert.equal(items[0].sourceRowNumber, 18);
  assert.equal(items[0].referenceUrl, 'https://drive.google.com/reference');
  assert.equal(items[0].category, 'Riders');
  assert.deepEqual(items[0].plazas, ['Buenos Aires', 'Córdoba']);
  assert.equal(items[0].decision, 'pending');
});

test('review generation IDs stay stable per uploaded artifact and change for a retry', () => {
  const build = (imageUrl) => buildBatchReviewItems({
    batchId: 'review-123',
    spreadsheetId: 'sheet-456',
    sheetName: 'RIDERS | AR',
    row: { Categoria: 'Riders', Ciudad: 'CBA' },
    rowNumber: 18,
    referenceUrl: 'https://drive.google.com/reference',
    uploadedLinks: { '1:1': [imageUrl], '9:16': [] },
  })[0].generationId;

  assert.equal(build('https://drive.google.com/file/d/file-a/view'), build('https://drive.google.com/file/d/file-a/view'));
  assert.notEqual(build('https://drive.google.com/file/d/file-a/view'), build('https://drive.google.com/file/d/file-b/view'));
});

test('review items carry no source cell now that the source sheet is read-only', () => {
  const items = buildBatchReviewItems({
    batchId: 'review-123',
    spreadsheetId: 'sheet-456',
    sheetName: 'RIDERS | AR',
    row: {},
    rowNumber: 18,
    referenceUrl: 'https://drive.google.com/reference',
    uploadedLinks: {
      '1:1': ['https://drive.google.com/square-1'],
      '9:16': [],
    },
    category: 'Riders',
    plazas: ['Buenos Aires'],
  });

  assert.equal(items[0].sourceCell, '');
});

test('source output stays stable across batches so regeneration still supersedes', () => {
  const args = {
    spreadsheetId: 'sheet-456',
    sourceTab: 'RIDERS | AR',
    rowNumber: 18,
    ratio: '1:1',
    variant: 2,
  };

  // buildReviewItemSourceKey falls back to source_output when source_cell is
  // empty. If the batch id leaked into this key, a re-run would register new
  // items instead of superseding the old ones.
  assert.equal(
    buildBatchVariationSourceOutput(args),
    buildBatchVariationSourceOutput(args),
  );
  assert.equal(buildBatchVariationSourceOutput(args), 'batch:sheet-456:RIDERS | AR:18:1:1:2');
});

test('falls back to source row category and plaza for legacy batch calls', () => {
  const [item] = buildBatchReviewItems({
    batchId: 'review-legacy',
    spreadsheetId: 'sheet-legacy',
    sheetName: 'Legacy',
    row: { Categoria: 'Riders', Ciudad: 'Rosario' },
    rowNumber: 4,
    referenceUrl: 'https://example.com/original.png',
    uploadedLinks: {
      '1:1': ['https://example.com/output.png'],
      '9:16': [],
    },
  });

  assert.equal(item.category, 'Riders');
  assert.deepEqual(item.plazas, ['Rosario']);
});

// The batch covers square and vertical only; landscape belongs to the ciclo.
const fullLinks = () => ({
  '1:1': ['https://d/s1', 'https://d/s2', 'https://d/s3'],
  '9:16': ['https://d/t1', 'https://d/t2', 'https://d/t3'],
});

test('builds one batch_variations row per generated variation', () => {
  const rows = buildBatchVariationRows({
    batchId: 'review-123',
    batchTitle: 'Riders Agosto',
    creativeReviewUrl: 'https://studio.example/?tab=review&batchId=review-123',
    spreadsheetId: 'sheet-456',
    sourceTab: 'RIDERS | AR',
    rowNumber: 18,
    sourceImageUrl: 'https://drive.google.com/reference',
    familyId: 'review-123:row:18',
    uploadedLinks: fullLinks(),
    driveFileIds: {
      '1:1': ['f1', 'f2', 'f3'],
      '9:16': ['f4', 'f5', 'f6'],
    },
    reviewItemIds: ['i1', 'i2', 'i3', 'i4', 'i5', 'i6'],
    category: 'Promo',
    plazas: ['Buenos Aires', 'Córdoba'],
    createdAt: '2026-08-24T10:00:00.000Z',
  });

  assert.equal(rows.length, 6);
  assert.deepEqual(
    rows.map((row) => `${row.aspect_ratio}#${row.variant}`),
    ['1:1#1', '1:1#2', '1:1#3', '9:16#1', '9:16#2', '9:16#3'],
  );

  // review_item_ids come back flat from registerReviewItems; they must line up
  // with the same ratio-major order buildBatchReviewItems emitted.
  assert.deepEqual(rows.map((row) => row.review_item_id), ['i1', 'i2', 'i3', 'i4', 'i5', 'i6']);
  assert.deepEqual(rows.map((row) => row.drive_file_id), ['f1', 'f2', 'f3', 'f4', 'f5', 'f6']);

  assert.equal(rows[0].variation_id, 'batch:sheet-456:RIDERS | AR:18:1:1:1');
  assert.equal(rows[0].review_batch_id, 'review-123');
  assert.equal(rows[0].creative_review_url, 'https://studio.example/?tab=review&batchId=review-123');
  assert.equal(rows[0].creative_family_id, 'review-123:row:18');
  assert.equal(rows[0].source_row, 18);
  assert.equal(rows[0].source_image_url, 'https://drive.google.com/reference');
  assert.equal(rows[0].plazas, 'Buenos Aires, Córdoba');
  assert.equal(rows[0].status, 'generated');
  assert.equal(rows[0].created_at, '2026-08-24T10:00:00.000Z');
});

test('keeps positional gaps in the pure row builder before the registration guard', () => {
  const rows = buildBatchVariationRows({
    batchId: 'review-123',
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    rowNumber: 7,
    uploadedLinks: {
      '1:1': ['https://d/s1', 'https://d/s2'],
      '9:16': [],
    },
    reviewItemIds: ['i1'],
  });

  assert.deepEqual(rows.map((row) => row.review_item_id), ['i1', '']);
});

const variationRowsFor = (batchId, rowNumber, createdAt) =>
  buildBatchVariationRows({
    batchId,
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    rowNumber,
    uploadedLinks: fullLinks(),
    reviewItemIds: [],
    createdAt,
  });

test('summarizes a source row as completed only once all six variations exist', () => {
  const complete = variationRowsFor('review-1', 5, '2026-08-24T10:00:00.000Z');
  const partial = variationRowsFor('review-1', 6, '2026-08-24T10:00:00.000Z').slice(0, 4);

  const summary = summarizeBatchVariations([...complete, ...partial], {
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    reviewBatchId: 'review-1',
  });

  assert.equal(summary.completedRows, 1);
  assert.equal(summary.rows[5].status, 'completed');
  assert.deepEqual(summary.rows[5].links['9:16'], ['https://d/t1', 'https://d/t2', 'https://d/t3']);
  assert.equal(summary.rows[6].status, 'generating');
});

test('does not complete a row with four square entries and only two vertical slots', () => {
  const rows = variationRowsFor('review-unbalanced', 9, '2026-08-24T10:00:00.000Z');
  const unbalanced = [
    ...rows.filter((row) => row.aspect_ratio === '1:1'),
    { ...rows.find((row) => row.aspect_ratio === '1:1'), variant: 4, image_url: 'https://d/s4' },
    ...rows.filter((row) => row.aspect_ratio === '9:16').slice(0, 2),
  ];

  const summary = summarizeBatchVariations(unbalanced, {
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    reviewBatchId: 'review-unbalanced',
  });

  assert.equal(summary.completedRows, 0);
  assert.equal(summary.rows[9].status, 'generating');
});

test('counts only the requested batch when the accumulative tab holds several', () => {
  const older = variationRowsFor('review-old', 5, '2026-08-20T10:00:00.000Z');
  const newer = variationRowsFor('review-new', 5, '2026-08-24T10:00:00.000Z').slice(0, 2);

  const scoped = summarizeBatchVariations([...older, ...newer], {
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    reviewBatchId: 'review-new',
  });

  assert.equal(scoped.completedRows, 0);
  assert.equal(scoped.rows[5].status, 'generating');
});

test('falls back to the most recent batch when none is requested', () => {
  const older = variationRowsFor('review-old', 5, '2026-08-20T10:00:00.000Z');
  const newer = variationRowsFor('review-new', 5, '2026-08-24T10:00:00.000Z').slice(0, 2);

  const summary = summarizeBatchVariations([...older, ...newer], {
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
  });

  assert.equal(summary.reviewBatchId, 'review-new');
  assert.equal(summary.completedRows, 0);
});

test('does not mix legacy batches when the latest batch ID is blank', () => {
  const older = variationRowsFor('review-old', 5, '2026-08-20T10:00:00.000Z').slice(0, 3);
  const latestWithoutId = variationRowsFor('', 5, '2026-08-24T10:00:00.000Z').slice(3);

  const summary = summarizeBatchVariations([...older, ...latestWithoutId], {
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
  });

  assert.equal(summary.reviewBatchId, '');
  assert.equal(summary.completedRows, 0);
  assert.equal(summary.rows[5].status, 'generating');
});

test('does not reuse completed outputs after the 16:9 source URL changes', () => {
  const oldSourceRows = variationRowsFor('review-source-change', 5, '2026-08-24T10:00:00.000Z')
    .map((row) => ({ ...row, source_image_url: 'https://drive.google.com/file/d/old-source/view' }));

  const summary = summarizeBatchVariations(oldSourceRows, {
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    reviewBatchId: 'review-source-change',
    sourceImageUrlsByRow: {
      5: 'https://drive.google.com/file/d/new-source/view',
    },
  });

  assert.equal(summary.completedRows, 0);
  assert.equal(summary.rows[5], undefined);
});

test('ignores variations from another tab or spreadsheet', () => {
  const mine = variationRowsFor('review-1', 5, '2026-08-24T10:00:00.000Z');
  const foreignTab = mine.map((row) => ({ ...row, source_tab: 'Otra pestaña' }));
  const foreignSheet = mine.map((row) => ({ ...row, source_sheet_id: 'otro-sheet' }));

  const summary = summarizeBatchVariations([...mine, ...foreignTab, ...foreignSheet], {
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    reviewBatchId: 'review-1',
  });

  assert.equal(summary.completedRows, 1);
  assert.deepEqual(Object.keys(summary.rows), ['5']);
});
