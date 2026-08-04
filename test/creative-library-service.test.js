import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildCampaignUsageRowsFromAudit,
  buildRecentlyReplacedTargetKeys,
  buildSourceCreativeFamilyId,
  buildSourceColumnIndex,
  filterRecentlyReplacedLowPerformers,
  findOutputColumns,
  formatLibraryAspectRatioCell,
  formatLibraryUrlCell,
  getUnavailableCreativeIdsForCampaign,
  getUrlFromSheetValue,
  inferCreativeFamilyIdFromImageUrl,
  inferCreativeFamilyIdFromSourceRows,
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

test('keeps every pending output pending until it is explicitly approved', () => {
  assert.equal(
    resolveOutputReviewStatus({
      cell: pendingCell(),
      columnHeader: '16.9 IMG',
      rowHasAcceptedOutput: true,
      config,
    }),
    'PENDING',
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

test('blocks creative usage only within the same platform account and campaign', () => {
  const usageRows = [
    {
      creative_id: 'creative-1',
      platform: 'google',
      account_id: '123-456',
      campaign_id: 'campaign-a',
      status: 'used',
    },
    {
      creative_id: 'creative-2',
      platform: 'google',
      account_id: '123456',
      campaign_id: 'campaign-a',
      status: 'reserved',
    },
    {
      creative_id: 'creative-3',
      platform: 'google',
      account_id: '123456',
      campaign_id: 'campaign-a',
      operation_id: 'operation-3',
      status: 'reserved',
    },
    {
      creative_id: 'creative-3',
      platform: 'google',
      account_id: '123456',
      campaign_id: 'campaign-a',
      operation_id: 'operation-3',
      status: 'released',
    },
  ];

  assert.deepEqual(
    [...getUnavailableCreativeIdsForCampaign(usageRows, {
      platform: 'google',
      accountId: '123456',
      campaignId: 'campaign-a',
    })].sort(),
    ['creative-1', 'creative-2'],
  );
  assert.equal(getUnavailableCreativeIdsForCampaign(usageRows, {
    platform: 'google',
    accountId: '123456',
    campaignId: 'campaign-b',
  }).size, 0);
  assert.equal(getUnavailableCreativeIdsForCampaign(usageRows, {
    platform: 'meta',
    accountId: '123456',
    campaignId: 'campaign-a',
  }).size, 0);
});

test('migrates successful campaign audit usage idempotently and ignores unknown campaigns', () => {
  const auditRows = [
    {
      __rowNumber: 2,
      timestamp: '2026-07-01T12:00:00.000Z',
      event: 'ASSET_REPLACED',
      status: 'success',
      creative_id: 'creative-primary',
      customer_id: 'act_123',
      campaign_id: 'campaign-a',
      new_asset_resource_name: 'new-ad',
      payload_json: JSON.stringify({
        platform: 'meta',
        operation: { id: 'operation-1', campaignName: 'Campaign A' },
        replacementCreativeIds: ['creative-primary', 'creative-portrait'],
      }),
    },
    {
      __rowNumber: 3,
      timestamp: '2026-07-01T12:00:00.000Z',
      event: 'ASSET_REPLACED',
      status: 'success',
      creative_id: 'legacy-without-campaign',
      customer_id: 'act_123',
      campaign_id: '',
      payload_json: JSON.stringify({ platform: 'meta' }),
    },
  ];
  const existingUsage = [{
    creative_id: 'creative-primary',
    platform: 'meta',
    account_id: 'act_123',
    campaign_id: 'campaign-a',
    status: 'used',
  }];

  const migrated = buildCampaignUsageRowsFromAudit(auditRows, existingUsage);

  assert.deepEqual(migrated.map((row) => row.creative_id), ['creative-portrait']);
  assert.equal(migrated[0].campaign_name, 'Campaign A');
  assert.equal(migrated[0].operation_id, 'operation-1');
});

test('formats aspect ratios as literal text for Google Sheets', () => {
  assert.equal(formatLibraryAspectRatioCell('9:16'), "'9:16");
  assert.equal(formatLibraryAspectRatioCell('16:9'), "'16:9");
  assert.equal(formatLibraryAspectRatioCell('1:1'), "'1:1");
  assert.equal(formatLibraryAspectRatioCell("'9:16"), "'9:16");
  assert.equal(formatLibraryAspectRatioCell(''), '');
});

test('keeps creative library Drive URLs exact instead of rewriting them as formulas', () => {
  const driveUrl = 'https://drive.google.com/file/d/1XMt5xcIDSEISsIXG7TbUaUsrys7NxlO4/view';

  assert.equal(formatLibraryUrlCell(driveUrl), driveUrl);
  assert.equal(getUrlFromSheetValue(`=HYPERLINK("${driveUrl}","Drive file")`), driveUrl);
  assert.equal(getUrlFromSheetValue(`=HIPERVINCULO("${driveUrl}";"Drive file")`), driveUrl);
  assert.equal(
    getUrlFromSheetValue(`Stored link: ${driveUrl},`),
    driveUrl,
  );
});

test('filters low performers recently replaced in the audit log', () => {
  const replacementKeys = buildRecentlyReplacedTargetKeys(
    [
      {
        timestamp: '2026-07-01T12:00:00.000Z',
        event: 'ASSET_REPLACED',
        status: 'success',
        customer_id: 'act_123',
        campaign_id: 'campaign-1',
        old_asset_resource_name: 'old-hash',
        payload_json: JSON.stringify({
          platform: 'meta',
          operation: {
            adId: 'ad-1',
            adResourceName: 'ad-1',
            associationResourceName: 'ad-1',
          },
        }),
      },
    ],
    {
      accountId: 'act_123',
      campaignIds: ['campaign-1'],
      platform: 'meta',
      now: new Date('2026-07-02T12:00:00.000Z'),
      cooldownDays: 30,
    },
  );

  const filtered = filterRecentlyReplacedLowPerformers(
    [
      { id: 'old-ad', adId: 'ad-1', assetResourceName: 'old-hash' },
      { id: 'fresh-ad', adId: 'ad-2', assetResourceName: 'other-hash' },
    ],
    replacementKeys,
  );

  assert.deepEqual(filtered.map((asset) => asset.id), ['fresh-ad']);
});

test('does not filter replacements outside the cooldown window', () => {
  const replacementKeys = buildRecentlyReplacedTargetKeys(
    [
      {
        timestamp: '2026-05-01T12:00:00.000Z',
        event: 'ASSET_REPLACED',
        status: 'success',
        customer_id: 'act_123',
        campaign_id: 'campaign-1',
        payload_json: JSON.stringify({
          platform: 'meta',
          operation: { adId: 'ad-1' },
        }),
      },
    ],
    {
      accountId: 'act_123',
      campaignIds: ['campaign-1'],
      platform: 'meta',
      now: new Date('2026-07-02T12:00:00.000Z'),
      cooldownDays: 30,
    },
  );

  assert.equal(replacementKeys.size, 0);
});

test('keeps legacy Google audit rows out of Meta replacement filtering', () => {
  const replacementKeys = buildRecentlyReplacedTargetKeys(
    [
      {
        timestamp: '2026-07-01T12:00:00.000Z',
        event: 'ASSET_REPLACED',
        status: 'success',
        customer_id: '1234567890',
        campaign_id: 'campaign-1',
        old_asset_resource_name: 'customers/1234567890/assets/111',
        payload_json: JSON.stringify({
          operation: {
            adGroupId: '222',
            adId: '333',
            adResourceName: 'customers/1234567890/adGroupAds/222~333',
            assetResourceName: 'customers/1234567890/assets/111',
          },
        }),
      },
    ],
    {
      accountId: '',
      campaignIds: ['campaign-1'],
      platform: 'meta',
      now: new Date('2026-07-02T12:00:00.000Z'),
      cooldownDays: 30,
    },
  );

  assert.equal(replacementKeys.size, 0);
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

test('infers creative family from nearby source row marker', () => {
  const rowData = [
    { values: [textCell(''), textCell('1080x1920')] },
    { values: [textCell(''), textCell('1200x628')] },
    { values: [textCell('2'), textCell('1080x1080')] },
    { values: [textCell(''), textCell('1080x1920')] },
    { values: [textCell(''), textCell('1200x628')] },
    { values: [textCell('3'), textCell('1080x1080')] },
  ];
  const headers = ['', '1080x1080'];

  assert.equal(
    inferCreativeFamilyIdFromSourceRows({ rowData, headers, sourceRowIndex: 0, sourceSheetName: 'Riders | AR' }),
    'Riders_AR::2',
  );
  assert.equal(
    inferCreativeFamilyIdFromSourceRows({ rowData, headers, sourceRowIndex: 1, sourceSheetName: 'Riders | AR' }),
    'Riders_AR::2',
  );
  assert.equal(
    inferCreativeFamilyIdFromSourceRows({ rowData, headers, sourceRowIndex: 2, sourceSheetName: 'Riders | AR' }),
    'Riders_AR::2',
  );
  assert.equal(
    inferCreativeFamilyIdFromSourceRows({ rowData, headers, sourceRowIndex: 3, sourceSheetName: 'Riders | AR' }),
    'Riders_AR::3',
  );
});
