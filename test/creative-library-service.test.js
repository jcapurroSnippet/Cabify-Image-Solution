import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSourceColumnIndex,
  findOutputColumns,
  migrateRowsToHeaders,
  resolveOutputReviewStatus,
  resolveCreativePlazas,
} from '../server/services/creativeLibraryService.js';
import { getCreativeLibraryConfig } from '../server/services/creativeLibraryConfig.js';

const config = getCreativeLibraryConfig();
const textCell = (value) => ({
  userEnteredValue: {
    stringValue: value,
  },
});
const pendingCell = () => ({});

test('maps Riders AR city-style source columns to creative plazas', () => {
  const indexes = buildSourceColumnIndex(['Campaign', 'Ciudad']);

  assert.equal(indexes.get('plazas'), 1);
});

test('resolves plazas from plaza-like source row columns when no explicit plazas field is present', () => {
  const plazas = resolveCreativePlazas({
    explicitPlazas: '',
    cells: [
      textCell('Generic always on'),
      textCell('BUE'),
    ],
    headers: ['Copy', 'Ciudad'],
    sourceSheetName: 'Riders | AR',
    fallbackPlazas: '',
    config,
  });

  assert.equal(plazas, 'BUE');
});

test('detects 16.9 IMG source output columns for library sync', () => {
  const columns = findOutputColumns(['Copy', '1:1 IMG', '9:16 IMG', '16.9 IMG', 'category']);

  assert.deepEqual(columns, [1, 2, 3]);
});

test('loads pending 16.9 output cells when the row has an accepted output', () => {
  assert.equal(
    resolveOutputReviewStatus({
      cell: pendingCell(),
      columnHeader: '16.9 IMG',
      rowHasAcceptedOutput: true,
      config,
    }),
    'ACCEPTED',
  );
  assert.equal(
    resolveOutputReviewStatus({
      cell: pendingCell(),
      columnHeader: '9:16 IMG',
      rowHasAcceptedOutput: true,
      config,
    }),
    'PENDING',
  );
});

test('migrates legacy used_at values into used_at_google', () => {
  const rows = migrateRowsToHeaders(
    [
      ['creative_id', 'used_at', 'used_at_meta'],
      ['promo-1', '2026-06-01T00:00:00Z', ''],
    ],
    ['creative_id', 'used_at_google', 'used_at_meta'],
  );

  assert.deepEqual(rows, [['promo-1', '2026-06-01T00:00:00Z', '']]);
});
