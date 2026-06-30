import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildSourceCreativeFamilyId,
  buildSourceColumnIndex,
  findOutputColumns,
  inferCreativeFamilyIdFromImageUrl,
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

test('migrates legacy family id columns into creative_family_id', () => {
  const rows = migrateRowsToHeaders(
    [
      ['creative_id', 'family_id', 'aspect_ratio'],
      ['promo-1', 'riders-ar-001', '1:1'],
    ],
    ['creative_id', 'creative_family_id', 'aspect_ratio'],
  );

  assert.deepEqual(rows, [['promo-1', 'riders-ar-001', '1:1']]);
});

test('infers the same creative family from ratio-specific filenames', () => {
  assert.equal(
    inferCreativeFamilyIdFromImageUrl('https://cdn.example.com/1080x1080_AR_RIDERS_2025_BUE_12.png', 'Riders | AR'),
    'Riders_AR::AR_RIDERS_2025_BUE_12',
  );
  assert.equal(
    inferCreativeFamilyIdFromImageUrl('https://cdn.example.com/1080x1920_AR_RIDERS_2025_BUE_12.png', 'Riders | AR'),
    'Riders_AR::AR_RIDERS_2025_BUE_12',
  );
  assert.equal(
    inferCreativeFamilyIdFromImageUrl('https://cdn.example.com/1920x1080_AR_RIDERS_2025_BUE_12.png', 'Riders | AR'),
    'Riders_AR::AR_RIDERS_2025_BUE_12',
  );
});

test('builds family ids from explicit value, filename, then row fallback', () => {
  assert.equal(
    buildSourceCreativeFamilyId({
      explicitFamilyId: ' Manual Set 01 ',
      spreadsheetId: 'sheet-1',
      sourceSheetName: 'Riders | AR',
      rowNumber: 10,
      imageUrl: 'https://cdn.example.com/1080x1080_AR_RIDERS_2025_BUE_12.png',
    }),
    'Manual_Set_01',
  );
  assert.equal(
    buildSourceCreativeFamilyId({
      spreadsheetId: 'sheet-1',
      sourceSheetName: 'Riders | AR',
      rowNumber: 10,
      imageUrl: 'https://cdn.example.com/1080x1080_AR_RIDERS_2025_BUE_12.png',
    }),
    'Riders_AR::AR_RIDERS_2025_BUE_12',
  );
  assert.equal(
    buildSourceCreativeFamilyId({
      spreadsheetId: 'sheet-1',
      sourceSheetName: 'Riders | AR',
      rowNumber: 10,
    }),
    'sheet-1::Riders_AR::row-10',
  );
});
