import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSourceColumnIndex,
  migrateRowsToHeaders,
  resolveCreativePlazas,
} from '../server/services/creativeLibraryService.js';
import { getCreativeLibraryConfig } from '../server/services/creativeLibraryConfig.js';

const config = getCreativeLibraryConfig();
const textCell = (value) => ({
  userEnteredValue: {
    stringValue: value,
  },
});

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
