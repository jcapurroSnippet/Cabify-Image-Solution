import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNoReadyReplacementMessage,
  buildNewAdPermissionMessage,
  describeAdsTargetType,
  describeAdsVisibleContext,
  describeGoogleAdType,
  describeReplacementChange,
  describeReplacementStatus,
  summarizeCreativeLibraryPlazas,
  summarizeCreativeLibraryResolutions,
  summarizeReplacementSelection,
} from '../src/features/creative-library/replacementUi.js';

const operation = (overrides = {}) => ({
  id: overrides.id || 'op-1',
  status: 'planned',
  executableInMode: true,
  executionPolicy: 'same_ad_update',
  requiresNewAd: false,
  creative: { creative_id: 'creative-1' },
  ...overrides,
});

test('summarizes selected replacements in user-facing terms', () => {
  const selectedIds = new Set(['same', 'new-ad', 'manual']);
  const summary = summarizeReplacementSelection([
    operation({ id: 'same' }),
    operation({ id: 'new-ad', requiresNewAd: true, executionPolicy: 'clone_replace' }),
    operation({ id: 'manual', executableInMode: false, executionPolicy: 'manual_only' }),
    operation({ id: 'not-selected' }),
  ], selectedIds);

  assert.deepEqual(summary, {
    selected: 3,
    ready: 1,
    needsNewAd: 1,
    manual: 1,
    blocked: 0,
  });
});

test('describes replacement changes without technical strategy labels', () => {
  assert.equal(describeReplacementChange(operation()).label, 'Updates current ad');
  assert.equal(
    describeReplacementChange(operation({ requiresNewAd: true, executionPolicy: 'clone_replace' })).label,
    'Creates new ad',
  );
  assert.equal(
    describeReplacementChange(operation({ executableInMode: false, executionPolicy: 'manual_only' })).label,
    'Review manually',
  );
});

test('describes replacement status in operational language', () => {
  assert.equal(describeReplacementStatus(operation()).label, 'Ready');
  assert.equal(
    describeReplacementStatus(operation({ requiresNewAd: true, executionPolicy: 'clone_replace' })).label,
    'Needs approval',
  );
  assert.equal(
    describeReplacementStatus(operation({ executableInMode: false, executionPolicy: 'manual_only' })).label,
    'Manual change',
  );
  assert.equal(
    describeReplacementStatus(operation({
      status: 'skipped',
      creative: null,
      message: 'CATEGORY_NOT_FOUND',
      detectedCategory: null,
    })).label,
    'No category',
  );
  assert.equal(
    describeReplacementStatus(operation({
      status: 'skipped',
      creative: null,
      message: 'NO_AVAILABLE_CREATIVE_FOR_RATIO',
      requiredAspectRatio: '1.91:1',
    })).label,
    'No 1.91:1 creative',
  );
});

test('explains plans that have no ready replacements', () => {
  const message = buildNoReadyReplacementMessage([
    operation({
      id: 'missing-category',
      status: 'skipped',
      creative: null,
      message: 'CATEGORY_NOT_FOUND',
      detectedCategory: null,
    }),
    operation({
      id: 'missing-ratio',
      status: 'skipped',
      creative: null,
      message: 'NO_AVAILABLE_CREATIVE_FOR_RATIO',
      requiredAspectRatio: '1:1',
    }),
    operation({
      id: 'manual',
      status: 'skipped',
      executableInMode: false,
      executionPolicy: 'manual_only',
      blockedMessage: 'Video Meta creatives need a manual review before replacement.',
    }),
  ]);

  assert.match(message, /No replacements are ready/);
  assert.match(message, /1 missing category/);
  assert.match(message, /1 missing 1:1 creative/);
  assert.match(message, /1 manual review/);
  assert.doesNotMatch(message.toLowerCase(), /dry run/);
});

test('builds new ad permission copy without dry-run language', () => {
  const message = buildNewAdPermissionMessage(2, 5);

  assert.match(message, /Google needs to create a new ad for 2 replacements/);
  assert.match(message, /Continue and replace/);
  assert.doesNotMatch(message.toLowerCase(), /dry run/);
});

test('describes Google Ads target types plainly', () => {
  assert.deepEqual(describeGoogleAdType({ adType: 'IMAGE_AD' }), {
    label: 'Image ad',
    description: 'Updates the existing image ad.',
  });
  assert.deepEqual(describeGoogleAdType({ adType: 'APP_ENGAGEMENT_AD' }), {
    label: 'App engagement ad',
    description: 'Updates the image list on the existing ad.',
  });
  assert.deepEqual(describeGoogleAdType({ adType: 'ASSET_GROUP_ASSET', targetType: 'ASSET_GROUP_ASSET' }), {
    label: 'Asset group asset',
    description: 'Replaces the asset association in an asset group.',
  });
  assert.deepEqual(describeGoogleAdType({ adType: 'APP_AD' }), {
    label: 'App install ad',
    description: 'Needs a manual change in Google Ads.',
  });
});

test('describes Meta Ads target types plainly', () => {
  assert.deepEqual(describeAdsTargetType({ platform: 'meta', adType: 'META_IMAGE_AD' }), {
    label: 'Meta image ad',
    description: 'Updates the current Meta ad with a new creative.',
  });
  assert.deepEqual(describeAdsTargetType({ platform: 'meta', adType: 'META_UNSUPPORTED_CREATIVE_SHAPE' }), {
    label: 'Meta ad',
    description: 'Review this Meta ad before replacing.',
  });
});

test('uses Meta ad name as the visible context instead of ad group name', () => {
  assert.equal(
    describeAdsVisibleContext({
      platform: 'meta',
      adName: 'Promo BUE image',
      adGroupName: 'AR | Alianzas | BUE',
      assetGroupName: '',
    }),
    'Promo BUE image',
  );
  assert.equal(
    describeAdsVisibleContext({
      platform: 'google',
      adName: 'Google image ad',
      adGroupName: 'AR | Alianzas | BUE',
      assetGroupName: '',
    }),
    'AR | Alianzas | BUE',
  );
});

test('summarizes available creative plazas by category', () => {
  const creatives = [
    { creative_id: 'all-1', category: 'Promo', plazas: 'ALL', status: 'available' },
    { creative_id: 'bue-1', category: 'promo', plazas: 'BUE', status: 'available' },
    { creative_id: 'bue-2', category: 'Promo', plazas: 'BUE, MVD', status: 'available' },
    { creative_id: 'used-1', category: 'Promo', plazas: 'CBA', status: 'used' },
    { creative_id: 'generic-1', category: 'Generic', plazas: 'CAN', status: 'available' },
  ];

  assert.deepEqual(summarizeCreativeLibraryPlazas(creatives, 'promo'), [
    { plaza: 'ALL', count: 1 },
    { plaza: 'BUE', count: 2 },
    { plaza: 'MVD', count: 1 },
  ]);
});

test('summarizes available creative resolutions by category', () => {
  const creatives = [
    { creative_id: 'square-1', category: 'Promo', image_resolution: '1080x1080', status: 'available' },
    { creative_id: 'square-2', category: 'promo', image_resolution: '1080 x 1080', status: 'available' },
    { creative_id: 'landscape-1', category: 'Promo', image_resolution: '1200x628', status: 'available' },
    { creative_id: 'used-1', category: 'Promo', image_resolution: '1080x1920', status: 'used' },
    { creative_id: 'generic-1', category: 'Generic', image_resolution: '1080x1080', status: 'available' },
  ];

  assert.deepEqual(summarizeCreativeLibraryResolutions(creatives, 'promo'), [
    { resolution: '1080x1080', count: 2 },
    { resolution: '1200x628', count: 1 },
  ]);
});
