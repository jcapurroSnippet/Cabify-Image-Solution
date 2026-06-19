import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canTransitionCreativeStatus,
  describeGoogleReplacementCapability,
  classifyBackgroundColor,
  detectCategoryFromName,
  detectPlazasFromName,
  isGoogleLowPerformanceLabel,
  isImageAssetFieldType,
  normalizeGoogleAdType,
  normalizeGoogleAssetFieldType,
  normalizeGooglePerformanceLabel,
  selectCreativeForCategory,
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

  assert.equal(selectCreativeForCategory(creatives, 'Promo')?.creative_id, 'b');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(['b']))?.creative_id, 'c');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'BUE')?.creative_id, 'c');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'TUC')?.creative_id, 'd');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'ALL')?.creative_id, 'd');
});

test('prefers exact plaza creatives before ALL fallback', () => {
  const creatives = [
    { creative_id: 'all', category: 'promo', plazas: 'ALL', status: 'available', created_at: '2026-01-01T00:00:00Z' },
    { creative_id: 'exact', category: 'promo', plazas: 'BUE', status: 'available', created_at: '2026-01-02T00:00:00Z' },
  ];

  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'BUE')?.creative_id, 'exact');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(), 'TUC')?.creative_id, 'all');
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

test('blocks clone-only app ads in strict same-ad mode', () => {
  const capability = describeGoogleReplacementCapability({
    supportedReplacement: true,
    targetType: 'AD_GROUP_AD',
    adType: 'APP_AD',
    replacementStrategy: 'APP_AD_CLONE_REPLACE',
  }, 'strict_same_ad');

  assert.equal(capability.canPreserveAdId, false);
  assert.equal(capability.requiresNewAd, true);
  assert.equal(capability.executableInMode, false);
  assert.equal(capability.blockedReason, 'REQUIRES_NEW_AD');
});

test('allows clone-only app ads when clone mode is explicit', () => {
  const capability = describeGoogleReplacementCapability({
    supportedReplacement: true,
    targetType: 'AD_GROUP_AD',
    adType: 'APP_ENGAGEMENT_AD',
    replacementStrategy: 'APP_ENGAGEMENT_AD_CLONE_REPLACE',
  }, 'allow_google_required_clone');

  assert.equal(capability.canPreserveAdId, false);
  assert.equal(capability.requiresNewAd, true);
  assert.equal(capability.executableInMode, true);
  assert.equal(capability.executionPolicy, 'clone_replace');
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
