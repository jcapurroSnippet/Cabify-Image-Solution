import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertReviewableRatioVariations,
  buildBatchReviewItems,
  buildBatchVariationSheetFormatRequests,
  buildBatchVariationRows,
  buildBatchVariationSourceOutput,
  findSixteenNineImageColumn,
  orderRegisteredReviewItemIds,
  summarizeBatchVariations,
} from '../server/services/batchProcessor.js';
import sharp from 'sharp';
import {
  ASPECT_RATIO_PROMPT_PROFILE,
  buildSourceTypographyReference,
  extractCardCopyFromSource,
  getVariationPrompts,
} from '../server/services/imageGenerator.js';

/** A stand-in source creative big enough for a copy-block crop to be magnified. */
const buildSourceImageData = async (width = 1080, height = 1080) => {
  const buffer = await sharp({
    create: { width, height, channels: 3, background: '#6f49e8' },
  }).png().toBuffer();
  return buffer.toString('base64');
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

test('keeps a ratio that lost a template and only fails one with nothing to review', () => {
  // The operator picks one of the variations, so two usable options still make
  // a shippable row. Only an empty ratio is a row failure.
  assert.deepEqual(
    assertReviewableRatioVariations({
      images: ['square-1', 'square-2'],
      ratio: '1:1',
      rowNumber: 8,
    }),
    ['square-1', 'square-2'],
  );

  assert.deepEqual(
    assertReviewableRatioVariations({
      images: ['square-1', null, 'square-3'],
      ratio: '1:1',
      rowNumber: 8,
    }),
    ['square-1', 'square-3'],
  );

  assert.deepEqual(
    assertReviewableRatioVariations({
      images: ['vertical-1', 'vertical-2', 'vertical-3'],
      ratio: '9:16',
      rowNumber: 8,
    }),
    ['vertical-1', 'vertical-2', 'vertical-3'],
  );

  assert.throws(
    () => assertReviewableRatioVariations({
      images: [],
      ratio: '1:1',
      rowNumber: 8,
      errors: ['Text overflow in template 1-1-riders-frame-lavender.'],
    }),
    /Generated no 1:1 variants for row 8\. Underlying errors: Text overflow/,
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
    /must return one item ID per generated variation/,
  );
});

test('registers a row that lost a template against its own variation count', () => {
  // Five variations because one 1:1 template did not compose. The guarantee is
  // one review item per generated piece, not a fixed six.
  const expected = Array.from({ length: 5 }, (_, index) => ({
    generationId: `generation-${index + 1}`,
  }));
  const registered = expected.map((item, index) => ({
    generationId: item.generationId,
    reviewItemId: `item-${index + 1}`,
  }));

  assert.deepEqual(
    orderRegisteredReviewItemIds(expected, registered),
    ['item-1', 'item-2', 'item-3', 'item-4', 'item-5'],
  );

  assert.throws(
    () => orderRegisteredReviewItemIds([], []),
    /must return one item ID per generated variation/,
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
    /must return one item ID per generated variation/,
  );
  assert.throws(
    () => orderRegisteredReviewItemIds(expected, mismatched),
    /must return one item ID per generated variation/,
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

test('the Aspect Ratio reframe generates only the background for immutable 1:1 and 9:16 templates', () => {
  const square = getVariationPrompts('1:1', ASPECT_RATIO_PROMPT_PROFILE).join('\n');
  const vertical = getVariationPrompts('9:16', ASPECT_RATIO_PROMPT_PROFILE).join('\n');

  for (const prompt of [square, vertical]) {
    assert.match(prompt, /BACKGROUND-ONLY GENERATION - CRITICAL/);
    assert.match(prompt, /Return only the photograph\/background/);
    assert.match(prompt, /IMMUTABLE TEMPLATE LAYERS/);
    assert.match(prompt, /This model call owns ONLY the photograph\/background/);
    assert.match(prompt, /adds the reference template's frame, logo and text box at exact pixel coordinates/);
    assert.match(prompt, /real Cabify OTF/);
    assert.match(prompt, /Return no text of any kind/);
  }

  assert.match(square, /TEMPLATE APERTURE - 1:1/);
  assert.match(square, /rounded photo aperture, outer frame, local logo notch, logo or text box/);
  assert.match(vertical, /TEMPLATE APERTURE - 9:16/);
  assert.match(vertical, /continuous vertical photograph\/background all the way to every canvas edge/);
});

test('rejects copy-block boxes that localise nothing usable', async () => {
  const sourceImageData = await buildSourceImageData();

  for (const box of [
    null,
    [0, 0, 1000, 1000],
    [400, 400, 405, 900],
    [400, 0, 900, 1200],
    ['a', 'b', 'c', 'd'],
    [710, 75, 930],
  ]) {
    assert.equal(
      await buildSourceTypographyReference(sourceImageData, box),
      null,
      `expected ${JSON.stringify(box)} to be rejected`,
    );
  }

  assert.equal(await buildSourceTypographyReference('bm90LWFuLWltYWdl', [710, 75, 930, 925]), null);
});

test('card-copy extraction drops an unusable box and carries no card face', async () => {
  const ai = {
    models: {
      generateContent: async () => ({
        text: JSON.stringify({
          cardText: 'Movete mejor',
          buttonPresent: true,
          buttonLabel: 'Pedí ahora',
          cardBackgroundColor: '#fff',
          cardTextColor: '#6f49e8',
          cardBrandMarks: '',
          cardTextBox: [0, 0, 1000, 1000],
          buttonFontWeight: 'not a weight',
        }),
      }),
    },
  };

  const copy = await extractCardCopyFromSource(ai, 'c291cmNl', 'image/png');

  assert.equal(copy.cardTextBox, null);
  // The card face is a compositor constant now, so extraction neither reports
  // nor carries one; a stray value from the model must not resurface.
  assert.equal('cardFontId' in copy, false);
  assert.equal('cardFontFamily' in copy, false);
  assert.equal('cardFontWeight' in copy, false);
  assert.equal(copy.buttonFontWeight, '');
  assert.equal(copy.cardBackgroundColor, '#FFFFFF');
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
          cardTextBox: [700, 100, 900, 900],
          buttonFontWeight: '',
        }),
      }),
    },
  };

  const copy = await extractCardCopyFromSource(ai, 'c291cmNl', 'image/png');

  assert.equal(copy.cardText, 'En Buenos Aires, movete mejor.');
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

test('summarizes a source row as completed once every ratio has something to review', () => {
  const complete = variationRowsFor('review-1', 5, '2026-08-24T10:00:00.000Z');
  // Row 6 lost one 1:1 template. It is still a row an operator can decide on,
  // so a resume must not regenerate it chasing the third variation.
  const partial = variationRowsFor('review-1', 6, '2026-08-24T10:00:00.000Z')
    .filter((row) => !(row.aspect_ratio === '1:1' && row.variant === 3));
  // Row 7 produced no vertical piece at all: nothing to review for that ratio.
  const missingRatio = variationRowsFor('review-1', 7, '2026-08-24T10:00:00.000Z')
    .filter((row) => row.aspect_ratio === '1:1');

  const summary = summarizeBatchVariations([...complete, ...partial, ...missingRatio], {
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    reviewBatchId: 'review-1',
  });

  assert.equal(summary.completedRows, 2);
  assert.equal(summary.rows[5].status, 'completed');
  assert.deepEqual(summary.rows[5].links['9:16'], ['https://d/t1', 'https://d/t2', 'https://d/t3']);
  assert.equal(summary.rows[6].status, 'completed');
  assert.deepEqual(summary.rows[6].links['1:1'], ['https://d/s1', 'https://d/s2']);
  assert.equal(summary.rows[7].status, 'generating');
});

test('compacts variation slots so a lost template leaves no hole in the links', () => {
  const rows = variationRowsFor('review-gap', 9, '2026-08-24T10:00:00.000Z')
    // Variants 1 and 3 survived; the middle template did not compose.
    .filter((row) => !(row.aspect_ratio === '1:1' && row.variant === 2));

  const summary = summarizeBatchVariations(rows, {
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    reviewBatchId: 'review-gap',
  });

  assert.deepEqual(summary.rows[9].links['1:1'], ['https://d/s1', 'https://d/s3']);
  assert.equal(summary.rows[9].links['1:1'].every(Boolean), true);
  assert.equal(summary.rows[9].status, 'completed');
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
