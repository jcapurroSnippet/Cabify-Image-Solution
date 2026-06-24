import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildMetaCreativeClonePayload,
  isSafeMetaCreativeForImageClone,
  normalizeMetaLowPerformerAd,
  rankMetaLowPerformers,
} from '../server/services/metaAdsService.js';

test('ranks Meta low performers by conversions, CPA, then impressions', () => {
  const ranked = rankMetaLowPerformers([
    { id: 'high-conversions', metrics: { conversions: 3, cpa: 400, impressions: 900 } },
    { id: 'low-low-cpa', metrics: { conversions: 0, cpa: 100, impressions: 2000 } },
    { id: 'low-high-cpa', metrics: { conversions: 0, cpa: 300, impressions: 1000 } },
    { id: 'low-high-cpa-more-impressions', metrics: { conversions: 0, cpa: 300, impressions: 5000 } },
  ]);

  assert.deepEqual(
    ranked.map((entry) => entry.id),
    ['low-high-cpa-more-impressions', 'low-high-cpa', 'low-low-cpa', 'high-conversions'],
  );
});

test('normalizes Meta ads into Creative Library low performer assets', () => {
  const asset = normalizeMetaLowPerformerAd({
    adAccountId: 'act_123456',
    ad: {
      id: 'ad-1',
      name: 'Promo BUE image',
      adset: {
        id: 'adset-1',
        name: 'AR | Beneficios | BUE',
        campaign: { id: 'campaign-1', name: 'AR | BUE | Always On' },
      },
      creative: {
        id: 'creative-1',
        name: 'Creative 1',
        image_url: 'https://example.com/current.png',
        object_story_spec: {
          page_id: 'page-1',
          link_data: { link: 'https://cabify.com', message: 'Ride now', image_hash: 'old-hash' },
        },
      },
    },
    insight: {
      impressions: '1200',
      clicks: '60',
      spend: '240.50',
      conversions: 2,
      cpa: 120.25,
    },
    imageResolution: { width: 1080, height: 1080 },
  });

  assert.equal(asset.platform, 'meta');
  assert.equal(asset.platformLabel, 'Meta Ads');
  assert.equal(asset.accountId, 'act_123456');
  assert.equal(asset.campaignId, 'campaign-1');
  assert.equal(asset.adGroupId, 'adset-1');
  assert.equal(asset.adId, 'ad-1');
  assert.equal(asset.assetId, 'creative-1');
  assert.equal(asset.assetUrl, 'https://example.com/current.png');
  assert.equal(asset.imageResolution, '1080x1080');
  assert.equal(asset.supportedReplacement, true);
  assert.equal(asset.replacementStrategy, 'META_CREATIVE_CLONE');
  assert.match(asset.adsUrl, /selected_ad_ids=ad-1/);
  assert.deepEqual(asset.metrics, {
    impressions: 1200,
    clicks: 60,
    ctr: 0.05,
    conversions: 2,
    conversionRate: 2 / 60,
    cost: 240.5,
    cpa: 120.25,
  });
});

test('detects Meta creatives that can be cloned by swapping one image', () => {
  assert.equal(
    isSafeMetaCreativeForImageClone({
      object_story_spec: {
        page_id: 'page-1',
        link_data: { link: 'https://cabify.com', message: 'Ride now', image_hash: 'old-hash' },
      },
    }).supported,
    true,
  );

  assert.equal(
    isSafeMetaCreativeForImageClone({
      object_story_spec: {
        page_id: 'page-1',
        link_data: { child_attachments: [{ image_hash: 'one' }, { image_hash: 'two' }] },
      },
    }).supported,
    false,
  );

  assert.equal(
    isSafeMetaCreativeForImageClone({
      asset_feed_spec: { images: [{ hash: 'one' }, { hash: 'two' }] },
      object_story_spec: { page_id: 'page-1' },
    }).supported,
    false,
  );
});

test('builds Meta creative payload by cloning existing link data and replacing only the image', () => {
  const creative = {
    id: 'creative-1',
    name: 'Original Creative',
    object_story_spec: {
      page_id: 'page-1',
      instagram_actor_id: 'ig-1',
      link_data: {
        link: 'https://cabify.com',
        message: 'Ride now',
        name: 'Cabify',
        call_to_action: { type: 'LEARN_MORE' },
        image_hash: 'old-hash',
        picture: 'https://example.com/old.png',
      },
    },
    degrees_of_freedom_spec: {
      creative_features_spec: {
        standard_enhancements: { enroll_status: 'OPT_OUT' },
      },
    },
    url_tags: 'utm_source=meta',
  };

  const payload = buildMetaCreativeClonePayload(creative, 'new-hash', 'Replacement Creative');

  assert.equal(payload.name, 'Replacement Creative');
  assert.equal(payload.object_story_spec.page_id, 'page-1');
  assert.equal(payload.object_story_spec.instagram_actor_id, 'ig-1');
  assert.equal(payload.object_story_spec.link_data.image_hash, 'new-hash');
  assert.equal(payload.object_story_spec.link_data.picture, undefined);
  assert.equal(payload.object_story_spec.link_data.message, 'Ride now');
  assert.deepEqual(payload.object_story_spec.link_data.call_to_action, { type: 'LEARN_MORE' });
  assert.deepEqual(payload.degrees_of_freedom_spec, creative.degrees_of_freedom_spec);
  assert.equal(payload.url_tags, 'utm_source=meta');
  assert.equal(creative.object_story_spec.link_data.image_hash, 'old-hash');
  assert.equal(creative.object_story_spec.link_data.picture, 'https://example.com/old.png');
});
