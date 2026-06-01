import assert from 'node:assert/strict';
import test from 'node:test';
import {
  canTransitionCreativeStatus,
  classifyBackgroundColor,
  detectCategoryFromName,
  isGoogleLowPerformanceLabel,
  isImageAssetFieldType,
  normalizeGoogleAdType,
  normalizeGoogleAssetFieldType,
  normalizeGooglePerformanceLabel,
  selectCreativeForCategory,
} from '../server/services/creativeLibraryCore.js';
import { getCreativeLibraryConfig } from '../server/services/creativeLibraryConfig.js';

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
    { creative_id: 'a', category: 'promo', status: 'used', created_at: '2026-01-01T00:00:00Z' },
    { creative_id: 'b', category: 'promo', status: 'available', created_at: '2026-01-02T00:00:00Z' },
    { creative_id: 'c', category: 'promo', status: 'available', created_at: '2026-01-03T00:00:00Z' },
  ];

  assert.equal(selectCreativeForCategory(creatives, 'Promo')?.creative_id, 'b');
  assert.equal(selectCreativeForCategory(creatives, 'Promo', 'oldest_first', new Set(['b']))?.creative_id, 'c');
});

test('allows only expected creative status transitions', () => {
  assert.equal(canTransitionCreativeStatus('available', 'reserved'), true);
  assert.equal(canTransitionCreativeStatus('reserved', 'used'), true);
  assert.equal(canTransitionCreativeStatus('used', 'available'), false);
});
