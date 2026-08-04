import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildBatchReviewItems,
  getBatchRatioColumns,
  getBatchTargetRatios,
} from '../server/services/batchProcessor.js';
import { getVariationPrompts } from '../server/services/imageGenerator.js';

test('detects landscape batch output columns by supported aliases', () => {
  const columns = getBatchRatioColumns([
    'Original image',
    '1:1 output A',
    '9:16 output A',
    'Landscape output A',
    '1200x628 output B',
    '1.91 output C',
  ]);

  assert.deepEqual(columns['1:1'], [1]);
  assert.deepEqual(columns['9:16'], [2]);
  assert.deepEqual(columns['1.91:1'], [3, 4, 5]);
  assert.deepEqual(getBatchTargetRatios(columns), ['1:1', '9:16', '1.91:1']);
});

test('keeps legacy batch target ratios when no output columns are named', () => {
  const columns = getBatchRatioColumns(['Image URL', 'Output A', 'Output B']);

  assert.deepEqual(getBatchTargetRatios(columns), ['1:1', '9:16']);
});

test('adds dedicated prompts for 1.91:1 image generation', () => {
  const prompts = getVariationPrompts('1.91:1');

  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /1\.91:1 landscape canvas/);
  assert.match(prompts[0], /1200x628 Google marketing image/);
});

test('maps uploaded batch variants to review items with exact source cells', () => {
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
    outputCells: {
      '1:1': ['G18', 'H18'],
      '9:16': ['J18'],
      '1.91:1': [],
    },
    category: 'Riders',
    plazas: ['Buenos Aires', 'Córdoba'],
  });

  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map(({ ratio, variantIndex, sourceCell }) => ({ ratio, variantIndex, sourceCell })),
    [
      { ratio: '1:1', variantIndex: 1, sourceCell: 'G18' },
      { ratio: '1:1', variantIndex: 2, sourceCell: 'H18' },
      { ratio: '9:16', variantIndex: 1, sourceCell: 'J18' },
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
    outputCells: { '1:1': ['G4'], '9:16': [], '1.91:1': [] },
  });

  assert.equal(item.category, 'Riders');
  assert.deepEqual(item.plazas, ['Rosario']);
});
