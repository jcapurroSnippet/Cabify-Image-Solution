import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertAppEngagementAdImageUpdate,
  buildAppAdCloneReplacementMutations,
  buildAppEngagementAdImageUpdateMutations,
} from '../server/services/googleAdsService.js';

const buildInput = (adType) => ({
  adType,
  assetCreate: {
    entity: 'asset',
    operation: 'create',
    resource: { resource_name: 'customers/123/assets/-1' },
  },
  cleanCustomerId: '123',
  target: { adGroupId: '456' },
  oldAdResourceName: 'customers/123/adGroupAds/456~789',
  clonedAd: {
    name: 'Replacement app ad',
    app_ad: {
      images: [{ asset: 'customers/123/assets/-1' }],
    },
  },
});

test('removes regular app ads before creating the replacement ad', () => {
  const mutations = buildAppAdCloneReplacementMutations(buildInput('APP_AD'));

  assert.deepEqual(
    mutations.map((mutation) => `${mutation.entity}:${mutation.operation}`),
    ['asset:create', 'ad_group_ad:remove', 'ad_group_ad:create'],
  );
  assert.equal(mutations[1].resource, 'customers/123/adGroupAds/456~789');
  assert.equal(mutations[2].resource.ad_group, 'customers/123/adGroups/456');
  assert.equal(mutations[2].resource.status, 'ENABLED');
});

test('updates app engagement ads by replacing the image list on the same ad', () => {
  const mutations = buildAppEngagementAdImageUpdateMutations({
    assetCreate: {
      entity: 'asset',
      operation: 'create',
      resource: { resource_name: 'customers/123/assets/-1' },
    },
    cleanCustomerId: '123',
    target: {
      adId: '789',
      oldAssetResourceName: 'customers/123/assets/111',
    },
    existingAd: {
      app_engagement_ad: {
        images: [
          { asset: 'customers/123/assets/111' },
          { asset: 'customers/123/assets/222' },
        ],
      },
    },
    newAssetResourceName: 'customers/123/assets/-1',
  });

  assert.deepEqual(
    mutations.map((mutation) => `${mutation.entity}:${mutation.operation}`),
    ['asset:create', 'ad:update'],
  );
  assert.equal(mutations[1].resource.resource_name, 'customers/123/ads/789');
  assert.deepEqual(mutations[1].resource.app_engagement_ad.images, [
    { asset: 'customers/123/assets/-1' },
    { asset: 'customers/123/assets/222' },
  ]);
  assert.equal('resourceName' in mutations[1].resource, false);
});

test('does not build pause operations for app engagement ads', () => {
  const assetCreate = {
    entity: 'asset',
    operation: 'create',
    resource: { resource_name: 'customers/123/assets/-1' },
  };

  const mutations = buildAppEngagementAdImageUpdateMutations({
    assetCreate,
    cleanCustomerId: '123',
    target: {
      adId: '789',
      oldAssetResourceName: 'customers/123/assets/111',
    },
    existingAd: {
      app_engagement_ad: {
        images: [{ asset: 'customers/123/assets/111' }],
      },
    },
    newAssetResourceName: 'customers/123/assets/-1',
  });

  assert.equal(
    mutations.some((mutation) => mutation.entity === 'ad_group_ad'),
    false,
  );
  assert.equal(
    mutations.some((mutation) => mutation.operation === 'remove'),
    false,
  );
});

test('verifies app engagement ads reference the created image asset after update', () => {
  const imageAssets = assertAppEngagementAdImageUpdate({
    ad: {
      app_engagement_ad: {
        images: [
          { asset: 'customers/123/assets/222' },
          { asset: 'customers/123/assets/333' },
        ],
      },
    },
    expectedAssetResourceName: 'customers/123/assets/333',
  });

  assert.deepEqual(imageAssets, [
    'customers/123/assets/222',
    'customers/123/assets/333',
  ]);
});

test('rejects successful app engagement mutates that do not persist the new image asset', () => {
  assert.throws(
    () => assertAppEngagementAdImageUpdate({
      ad: {
        app_engagement_ad: {
          images: [{ asset: 'customers/123/assets/222' }],
        },
      },
      expectedAssetResourceName: 'customers/123/assets/333',
    }),
    /Google Ads accepted the App Engagement Ad update but the ad does not reference the new image asset/,
  );
});
