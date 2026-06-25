import assert from 'node:assert/strict';
import test from 'node:test';
import { buildMetaTargetCategoryName } from '../server/services/metaReplacementService.js';

test('uses Meta ad name instead of ad set name for category detection', () => {
  const targetName = buildMetaTargetCategoryName({
    adName: 'Promo BUE image',
    adGroupName: 'AR | Alianzas | BUE',
    assetName: 'Creative 1',
  });

  assert.equal(targetName, 'Promo BUE image');
});
