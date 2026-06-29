import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMetaTargetCategoryName,
  getMetaReplacementFamilyCreatives,
} from '../server/services/metaReplacementService.js';

test('uses Meta ad name instead of ad set name for category detection', () => {
  const targetName = buildMetaTargetCategoryName({
    adName: 'Promo BUE image',
    adGroupName: 'AR | Alianzas | BUE',
    assetName: 'Creative 1',
  });

  assert.equal(targetName, 'Promo BUE image');
});

test('uses selected Meta creative plus its family ratios for replacement', () => {
  const family = getMetaReplacementFamilyCreatives({
    creative: { creative_id: 'creative-1x1', aspect_ratio: '1:1' },
    creativeFamilyCreatives: [
      { creative_id: 'creative-1x1', aspect_ratio: '1:1' },
      { creative_id: 'creative-9x16', aspect_ratio: '9:16' },
      { creative_id: 'creative-16x9', aspect_ratio: '16:9' },
    ],
  });

  assert.deepEqual(
    family.map((creative) => creative.creative_id),
    ['creative-1x1', 'creative-9x16', 'creative-16x9'],
  );
});
