import assert from 'node:assert/strict';
import test from 'node:test';
import { buildAppAdCloneReplacementMutations } from '../server/services/googleAdsService.js';

test('pauses app engagement ads before creating the replacement ad', () => {
  const assetCreate = {
    entity: 'asset',
    operation: 'create',
    resource: { resource_name: 'customers/123/assets/-1' },
  };

  const mutations = buildAppAdCloneReplacementMutations({
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
  });

  assert.deepEqual(
    mutations.map((mutation) => `${mutation.entity}:${mutation.operation}`),
    ['asset:create', 'ad_group_ad:update', 'ad_group_ad:create'],
  );
  assert.equal(mutations[1].resource.resource_name, 'customers/123/adGroupAds/456~789');
  assert.equal(mutations[1].resource.status, 'PAUSED');
  assert.equal(mutations[2].resource.ad_group, 'customers/123/adGroups/456');
  assert.equal(mutations[2].resource.status, 'ENABLED');
  assert.equal(mutations.some((mutation) => mutation.operation === 'remove'), false);
});
