import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canTransitionCreativeStatus,
  describeGoogleReplacementCapability,
  classifyBackgroundColor,
  detectCategoryFromName,
  detectPlazasFromName,
  getCreativeDriveUrl,
  isGoogleLowPerformanceLabel,
  isImageAssetFieldType,
  normalizeGoogleAdType,
  normalizeGoogleAssetFieldType,
  normalizeGooglePerformanceLabel,
  requiresNewAdCreationPermission,
  selectCreativeForCategory,
  selectCreativeSetForCategoryRatios,
} from '../server/services/creativeLibraryCore.js';
import {
  CREATIVE_LIBRARY_HEADERS,
  SOURCE_STATUS_COLUMNS,
  getCreativeLibraryConfig,
} from '../server/services/creativeLibraryConfig.js';

const config = getCreativeLibraryConfig();

const cellWithRgb = (red, green, blue) => ({
  effectiveFormat: {
    backgroundColor: { red, green, blue },
  },
});

test('classifies accepted and rejected sheet colors approximately', () => {
  assert.equal(classifyBackgroundColor(cellWithRgb(0.2, 0.75, 0.25), config), 'ACCEPTED');
  assert.equal(classifyBackgroundColor(cellWithRgb(0.85, 0.1, 0.1), config), 'REJECTED');
  assert.equal(classifyBackgroundColor(cellWithRgb(217 / 255, 234 / 255, 211 / 255), config), 'ACCEPTED');
  assert.equal(classifyBackgroundColor(cellWithRgb(244 / 255, 204 / 255, 204 / 255), config), 'REJECTED');
  assert.equal(classifyBackgroundColor(cellWithRgb(1, 1, 1), config), 'PENDING');
});

test('uses drive_file_id before visible Drive URL for creative downloads', () => {
  assert.equal(
    getCreativeDriveUrl({
      drive_file_id: '1ExactDriveFileId_AbC',
      drive_url: 'https://drive.google.com/file/d/broken-visible-id/view',
    }),
    'https://drive.google.com/file/d/1ExactDriveFileId_AbC/view',
  );
});

test('detects category from mapped ad group text', () => {
  const result = detectCategoryFromName('AR | Partner | Buenos Aires', config);
  assert.equal(result.category, 'Alianzas');
  assert.deepEqual(result.matched, ['Alianzas']);
  assert.equal(result.warning, null);
});

test('keeps plazas next to category in creative sheet headers', () => {
  assert.equal(CREATIVE_LIBRARY_HEADERS.indexOf('plazas'), CREATIVE_LIBRARY_HEADERS.indexOf('category') + 1);
  assert.equal(SOURCE_STATUS_COLUMNS.includes('plazas'), true);
});

test('keeps image metadata next to drive url in creative sheet headers', () => {
  assert.equal(CREATIVE_LIBRARY_HEADERS.indexOf('aspect_ratio'), CREATIVE_LIBRARY_HEADERS.indexOf('drive_url') + 1);
  assert.equal(CREATIVE_LIBRARY_HEADERS.indexOf('image_resolution'), CREATIVE_LIBRARY_HEADERS.indexOf('aspect_ratio') + 1);
});

test('keeps platform-neutral replacement columns before legacy Google resource column', () => {
  assert.equal(CREATIVE_LIBRARY_HEADERS.includes('ads_platform'), true);
  assert.equal(CREATIVE_LIBRARY_HEADERS.includes('ads_resource_name'), true);
  assert.equal(
    CREATIVE_LIBRARY_HEADERS.indexOf('ads_platform') < CREATIVE_LIBRARY_HEADERS.indexOf('google_ads_asset_resource_name'),
    true,
  );
  assert.equal(
    CREATIVE_LIBRARY_HEADERS.indexOf('ads_resource_name') < CREATIVE_LIBRARY_HEADERS.indexOf('google_ads_asset_resource_name'),
    true,
  );
});

test('keeps separate platform usage columns and removes legacy used_at header', () => {
  assert.equal(CREATIVE_LIBRARY_HEADERS.includes('used_at'), false);
  assert.equal(CREATIVE_LIBRARY_HEADERS.includes('used_at_google'), true);
  assert.equal(CREATIVE_LIBRARY_HEADERS.includes('used_at_meta'), true);
  assert.equal(
    CREATIVE_LIBRARY_HEADERS.indexOf('used_at_google') < CREATIVE_LIBRARY_HEADERS.indexOf('used_at_meta'),
    true,
  );
});

test('uses Riders AR as the default creative source sheet', () => {
  assert.deepEqual(config.sourceSheets, ['Riders | AR']);
});

test('detects beneficios ad set text as promo category', () => {
  const result = detectCategoryFromName('AR | Beneficios | BUE', config);
  assert.equal(result.category, 'Promo');
  assert.deepEqual(result.matched, ['Promo']);
  assert.equal(result.warning, null);
});

test('detects plaza codes from campaign text', () => {
  const result = detectPlazasFromName('AR | BUE | Partner | Always On', config);
  assert.equal(result.plazas, 'BUE');
  assert.deepEqual(result.matched, ['BUE']);
  assert.equal(result.warning, null);
});

test('detects multiple Uruguay plaza codes from campaign text', () => {
  const result = detectPlazasFromName('UY | MVD | CAN | MAL | Promo', config);
  assert.equal(result.plazas, 'MVD, CAN, MAL');
  assert.deepEqual(result.matched, ['MVD', 'CAN', 'MAL']);
});

test('does not infer free-form city names as plazas', () => {
  const result = detectPlazasFromName('AR | Partner | Buenos Aires', config);
  assert.equal(result.plazas, '');
  assert.deepEqual(result.matched, []);
  assert.equal(result.warning, 'PLAZAS_NOT_FOUND');
});

test('uses Google performance label LOW for low performer detection', () => {
  assert.equal(isGoogleLowPerformanceLabel('LOW'), true);
  assert.equal(isGoogleLowPerformanceLabel('low'), true);
  assert.equal(isGoogleLowPerformanceLabel(4), true);
  assert.equal(normalizeGooglePerformanceLabel(4), 'LOW');
  assert.equal(isGoogleLowPerformanceLabel('GOOD'), false);
  assert.equal(isGoogleLowPerformanceLabel('PENDING'), false);
});

test('keeps only image asset field types', () => {
  assert.equal(isImageAssetFieldType('MARKETING_IMAGE'), true);
  assert.equal(isImageAssetFieldType(5), true);
  assert.equal(normalizeGoogleAssetFieldType(5), 'MARKETING_IMAGE');
  assert.equal(isImageAssetFieldType('SQUARE_MARKETING_IMAGE'), true);
  assert.equal(isImageAssetFieldType('LOGO'), true);
  assert.equal(isImageAssetFieldType('HEADLINE'), false);
  assert.equal(isImageAssetFieldType('YOUTUBE_VIDEO'), false);
});

test('normalizes Google numeric ad types used by low performer rows', () => {
  assert.equal(normalizeGoogleAdType(14), 'IMAGE_AD');
  assert.equal(normalizeGoogleAdType(17), 'APP_AD');
  assert.equal(normalizeGoogleAdType(23), 'APP_ENGAGEMENT_AD');
});

test('selects an available creative by category and avoids reserved ids', () => {
  const creatives = [
    { creative_id: 'a', category: 'promo', plazas: 'CBA', status: 'used', created_at: '2026-01-01T00:00:00Z' },
    { creative_id: 'b', category: 'promo', plazas: 'CBA', status: 'available', created_at: '2026-01-02T00:00:00Z' },
    { creative_id: 'c', category: 'promo', plazas: 'BUE', status: 'available', created_at: '2026-01-03T00:00:00Z' },
    { creative_id: 'd', category: 'promo', plazas: 'ALL', status: 'available', created_at: '2026-01-04T00:00:00Z' },
  ];

  assert.equal(selectCreativeForCategory(creatives, 'Promo')?.creative_id, 'd');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(['d']))?.creative_id, 'b');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'BUE')?.creative_id, 'c');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'TUC')?.creative_id, 'd');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'ALL')?.creative_id, 'd');
});

test('selects creatives by platform-specific usage columns', () => {
  const creatives = [
    {
      creative_id: 'google-used',
      category: 'promo',
      plazas: 'ALL',
      status: 'used',
      used_at_google: '2026-06-01T00:00:00Z',
      used_at_meta: '',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      creative_id: 'meta-used',
      category: 'promo',
      plazas: 'ALL',
      status: 'used',
      used_at_google: '',
      used_at_meta: '2026-06-02T00:00:00Z',
      created_at: '2026-01-02T00:00:00Z',
    },
    {
      creative_id: 'both-used',
      category: 'promo',
      plazas: 'ALL',
      status: 'used',
      used_at_google: '2026-06-01T00:00:00Z',
      used_at_meta: '2026-06-02T00:00:00Z',
      created_at: '2026-01-03T00:00:00Z',
    },
  ];

  assert.equal(
    selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'ALL', null, 'google')?.creative_id,
    'meta-used',
  );
  assert.equal(
    selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'ALL', null, 'meta')?.creative_id,
    'google-used',
  );
  assert.equal(
    selectCreativeForCategory([creatives[2]], 'Promo', 'oldest_first', new Set(), 'ALL', null, 'google'),
    null,
  );
  assert.equal(
    selectCreativeForCategory([creatives[2]], 'Promo', 'oldest_first', new Set(), 'ALL', null, 'meta'),
    null,
  );
});

test('treats legacy used_at rows as Google usage only', () => {
  const creative = {
    creative_id: 'legacy-google-used',
    category: 'promo',
    plazas: 'ALL',
    status: 'used',
    used_at: '2026-06-01T00:00:00Z',
    created_at: '2026-01-01T00:00:00Z',
  };

  assert.equal(
    selectCreativeForCategory([creative], 'Promo', 'oldest_first', new Set(), 'ALL', null, 'google'),
    null,
  );
  assert.equal(
    selectCreativeForCategory([creative], 'Promo', 'oldest_first', new Set(), 'ALL', null, 'meta')?.creative_id,
    'legacy-google-used',
  );
});

test('prefers exact plaza creatives before ALL fallback', () => {
  const creatives = [
    { creative_id: 'all', category: 'promo', plazas: 'ALL', status: 'available', created_at: '2026-01-01T00:00:00Z' },
    { creative_id: 'exact', category: 'promo', plazas: 'BUE', status: 'available', created_at: '2026-01-02T00:00:00Z' },
  ];

  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'BUE')?.creative_id, 'exact');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'TUC')?.creative_id, 'all');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'CBA')?.creative_id, 'all');
});

test('prefers ALL creatives when target plaza is not detected', () => {
  const creatives = [
    { creative_id: 'bue', category: 'promo', plazas: 'BUE', status: 'available', created_at: '2026-01-01T00:00:00Z' },
    { creative_id: 'all', category: 'promo', plazas: 'ALL', status: 'available', created_at: '2026-01-02T00:00:00Z' },
  ];

  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), '')?.creative_id, 'all');
});

test('selects creatives by required aspect ratio', () => {
  const creatives = [
    { creative_id: 'square', category: 'promo', plazas: 'ALL', status: 'available', aspect_ratio: '1:1', created_at: '2026-01-01T00:00:00Z' },
    { creative_id: 'portrait', category: 'promo', plazas: 'ALL', status: 'available', aspect_ratio: '9:16', created_at: '2026-01-02T00:00:00Z' },
    { creative_id: 'landscape', category: 'promo', plazas: 'ALL', status: 'available', aspect_ratio: '1.91:1', created_at: '2026-01-03T00:00:00Z' },
  ];

  assert.equal(
    selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'BUE', '1.91:1')?.creative_id,
    'landscape',
  );
  assert.equal(
    selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(['landscape']), 'BUE', '1.91:1'),
    null,
  );
});

test('selects complete creative families by required ratios', () => {
  const creatives = [
    {
      creative_id: 'family-a-square',
      category: 'promo',
      plazas: 'ALL',
      status: 'available',
      aspect_ratio: '1:1',
      source_sheet_id: 'sheet-1',
      source_tab: 'Riders | AR',
      source_row: '10',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      creative_id: 'family-a-portrait',
      category: 'promo',
      plazas: 'ALL',
      status: 'available',
      aspect_ratio: '9:16',
      source_sheet_id: 'sheet-1',
      source_tab: 'Riders | AR',
      source_row: '10',
      created_at: '2026-01-01T00:00:01Z',
    },
    {
      creative_id: 'family-a-landscape',
      category: 'promo',
      plazas: 'ALL',
      status: 'available',
      aspect_ratio: '1.91:1',
      source_sheet_id: 'sheet-1',
      source_tab: 'Riders | AR',
      source_row: '10',
      created_at: '2026-01-01T00:00:02Z',
    },
    {
      creative_id: 'family-b-square',
      category: 'promo',
      plazas: 'ALL',
      status: 'available',
      aspect_ratio: '1:1',
      source_sheet_id: 'sheet-1',
      source_tab: 'Riders | AR',
      source_row: '11',
      created_at: '2026-01-02T00:00:00Z',
    },
    {
      creative_id: 'family-b-portrait',
      category: 'promo',
      plazas: 'ALL',
      status: 'available',
      aspect_ratio: '9:16',
      source_sheet_id: 'sheet-1',
      source_tab: 'Riders | AR',
      source_row: '11',
      created_at: '2026-01-02T00:00:01Z',
    },
  ];

  const set = selectCreativeSetForCategoryRatios(
    creatives,
    'Promo',
    ['1:1', '9:16', '1.91:1'],
    'oldest_first',
    new Set(),
    'BUE',
    'meta',
  );

  assert.equal(set.familyKey, 'sheet-1::Riders | AR::10');
  assert.equal(set.creativesByRatio['1:1'].creative_id, 'family-a-square');
  assert.equal(set.creativesByRatio['9:16'].creative_id, 'family-a-portrait');
  assert.equal(set.creativesByRatio['1.91:1'].creative_id, 'family-a-landscape');
  assert.equal(
    selectCreativeSetForCategoryRatios(
      creatives,
      'Promo',
      ['1:1', '9:16', '1.91:1'],
      'oldest_first',
      new Set(['family-a-landscape']),
      'BUE',
      'meta',
    ),
    null,
  );
});

test('groups separated ratio creatives by explicit family id', () => {
  const creatives = [
    {
      creative_id: 'set-1-square',
      creative_family_id: 'set-1',
      category: 'promo',
      plazas: 'ALL',
      status: 'available',
      aspect_ratio: '1:1',
      source_row: '10',
      created_at: '2026-01-01T00:00:00Z',
    },
    {
      creative_id: 'set-1-portrait',
      creative_family_id: 'set-1',
      category: 'promo',
      plazas: 'ALL',
      status: 'available',
      aspect_ratio: '9:16',
      source_row: '11',
      created_at: '2026-01-01T00:00:01Z',
    },
    {
      creative_id: 'set-1-landscape',
      creative_family_id: 'set-1',
      category: 'promo',
      plazas: 'ALL',
      status: 'available',
      aspect_ratio: '1.91:1',
      source_row: '12',
      created_at: '2026-01-01T00:00:02Z',
    },
  ];

  const set = selectCreativeSetForCategoryRatios(
    creatives,
    'Promo',
    ['1:1', '9:16', '1.91:1'],
    'oldest_first',
    new Set(),
    'BUE',
    'meta',
  );

  assert.equal(set.familyKey, 'set-1');
  assert.equal(set.creativesByRatio['1:1'].creative_id, 'set-1-square');
  assert.equal(set.creativesByRatio['9:16'].creative_id, 'set-1-portrait');
  assert.equal(set.creativesByRatio['1.91:1'].creative_id, 'set-1-landscape');
});

test('allows only expected creative status transitions', () => {
  assert.equal(canTransitionCreativeStatus('available', 'reserved'), true);
  assert.equal(canTransitionCreativeStatus('reserved', 'used'), true);
  assert.equal(canTransitionCreativeStatus('used', 'available'), false);
});

test('classifies image ads as same-ad replacements in strict mode', () => {
  const capability = describeGoogleReplacementCapability({
    supportedReplacement: true,
    targetType: 'AD_GROUP_AD',
    adType: 'IMAGE_AD',
    replacementStrategy: 'IMAGE_AD_UPDATE',
  }, 'strict_same_ad');

  assert.equal(capability.canPreserveAdId, true);
  assert.equal(capability.requiresNewAd, false);
  assert.equal(capability.executableInMode, true);
  assert.equal(capability.executionPolicy, 'same_ad_update');
});

test('classifies app install ads as manual replacements in strict mode', () => {
  const capability = describeGoogleReplacementCapability({
    supportedReplacement: true,
    targetType: 'AD_GROUP_AD',
    adType: 'APP_AD',
    replacementStrategy: 'APP_AD_CLONE_REPLACE',
  }, 'strict_same_ad');

  assert.equal(capability.canPreserveAdId, false);
  assert.equal(capability.requiresNewAd, false);
  assert.equal(capability.executableInMode, false);
  assert.equal(capability.executionPolicy, 'manual_only');
  assert.equal(capability.blockedReason, 'APP_AD_REPLACEMENT_REQUIRES_GOOGLE_ADS_UI');
});

test('keeps app install ads as manual replacements even when new ads are allowed', () => {
  const capability = describeGoogleReplacementCapability({
    supportedReplacement: true,
    targetType: 'AD_GROUP_AD',
    adType: 'APP_AD',
    replacementStrategy: 'APP_AD_CLONE_REPLACE',
  }, 'allow_google_required_clone');

  assert.equal(capability.canPreserveAdId, false);
  assert.equal(capability.requiresNewAd, false);
  assert.equal(capability.executableInMode, false);
  assert.equal(capability.executionPolicy, 'manual_only');
  assert.equal(capability.blockedReason, 'APP_AD_REPLACEMENT_REQUIRES_GOOGLE_ADS_UI');
});

test('classifies app engagement ads as same-ad image-list updates', () => {
  const capability = describeGoogleReplacementCapability({
    supportedReplacement: true,
    targetType: 'AD_GROUP_AD',
    adType: 'APP_ENGAGEMENT_AD',
    replacementStrategy: 'APP_ENGAGEMENT_AD_UPDATE',
  }, 'allow_google_required_clone');

  assert.equal(capability.canPreserveAdId, true);
  assert.equal(capability.requiresNewAd, false);
  assert.equal(capability.executableInMode, true);
  assert.equal(capability.executionPolicy, 'same_ad_update');
  assert.equal(capability.blockedReason, null);
  assert.equal(capability.blockedMessage, null);
});

test('marks asset group replacements as preserving the container, not an ad id', () => {
  const capability = describeGoogleReplacementCapability({
    supportedReplacement: true,
    targetType: 'ASSET_GROUP_ASSET',
    adType: 'ASSET_GROUP_ASSET',
    replacementStrategy: 'ASSET_GROUP_ASSET_ASSOCIATION',
  }, 'strict_same_ad');

  assert.equal(capability.canPreserveAdId, false);
  assert.equal(capability.canPreserveServingContainer, true);
  assert.equal(capability.executableInMode, false);
  assert.equal(capability.blockedReason, 'NO_AD_ID_FOR_ASSET_GROUP_ASSET');
});

test('requires explicit permission only when selected operations create a new ad', () => {
  const operations = [
    { id: 'same', requiresNewAd: false, executionPolicy: 'same_ad_update' },
    { id: 'asset-group', requiresNewAd: false, executionPolicy: 'asset_group_reassociation' },
    { id: 'clone', requiresNewAd: true, executionPolicy: 'clone_replace' },
    { id: 'manual', requiresNewAd: false, executionPolicy: 'manual_only' },
  ];

  assert.equal(requiresNewAdCreationPermission(operations, new Set(['same', 'asset-group'])), false);
  assert.equal(requiresNewAdCreationPermission(operations, new Set(['manual'])), false);
  assert.equal(requiresNewAdCreationPermission(operations, new Set(['clone'])), true);
  assert.equal(requiresNewAdCreationPermission(operations), true);
});
