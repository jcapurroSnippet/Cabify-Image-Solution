import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAppAdCloneReplacementMutations } from '../server/services/googleAdsService.js';

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

test('rejects app engagement ads before building replacement mutations', () => {
  assert.throws(
    () => buildAppAdCloneReplacementMutations(buildInput('APP_ENGAGEMENT_AD')),
    /APP_ENGAGEMENT_AD cannot be replaced automatically by Google Ads API/,
  );
});

test('does not build pause operations for app engagement ads', () => {
  const assetCreate = {
    entity: 'asset',
    operation: 'create',
    resource: { resource_name: 'customers/123/assets/-1' },
  };

  assert.throws(() => buildAppAdCloneReplacementMutations({
    adType: 'APP_ENGAGEMENT_AD',
    assetCreate,
    cleanCustomerId: '123',
    target: { adGroupId: '456' },
    oldAdResourceName: 'customers/123/adGroupAds/456~789',
    clonedAd: {
      name: 'Replacement app engagement ad',
      app_engagement_ad: {
        images: [{ asset: 'customers/123/assets/-1' }],
      },
    },
  }), /APP_ENGAGEMENT_AD cannot be replaced automatically by Google Ads API/);
});
