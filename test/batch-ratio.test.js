import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBatchReviewItems,
  buildBatchVariationRows,
  buildBatchVariationSourceOutput,
  summarizeBatchVariations,
} from '../server/services/batchProcessor.js';
import { getVariationPrompts } from '../server/services/imageGenerator.js';

test('adds dedicated prompts for 1.91:1 image generation', () => {
  const prompts = getVariationPrompts('1.91:1');

  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /1\.91:1 landscape canvas/);
  assert.match(prompts[0], /1200x628 Google marketing image/);
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
      '1.91:1': [],
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
      '1.91:1': [],
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
      '1.91:1': [],
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
  assert.equal(rows[0].creative_family_id, 'review-123:row:18');
  assert.equal(rows[0].source_row, 18);
  assert.equal(rows[0].source_image_url, 'https://drive.google.com/reference');
  assert.equal(rows[0].plazas, 'Buenos Aires, Córdoba');
  assert.equal(rows[0].status, 'generated');
  assert.equal(rows[0].created_at, '2026-08-24T10:00:00.000Z');
});

test('leaves review_item_id empty when registration returned fewer ids', () => {
  const rows = buildBatchVariationRows({
    batchId: 'review-123',
    spreadsheetId: 'sheet-456',
    sourceTab: 'Origen',
    rowNumber: 7,
    uploadedLinks: {
      '1:1': ['https://d/s1', 'https://d/s2'],
      '9:16': [],
      '1.91:1': [],
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
