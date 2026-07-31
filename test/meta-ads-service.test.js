import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildNextMetaAdName,
  buildMetaImageHashByAssetKeyForRatios,
  buildMetaCreativeClonePayload,
  cloneMetaAdWithReplacementCreativeFromOperation,
  collectMetaLowPerformerAssets,
  formatMetaGraphErrorMessage,
  getCampaigns,
  getMetaCreativeReplacementRatios,
  getLowPerformingImageAssets,
  isSafeMetaCreativeForImageClone,
  normalizeMetaLowPerformerAd,
  rankMetaLowPerformers,
} from '../server/services/metaAdsService.js';

test('ranks Meta low performers by lowest impressions first', () => {
  const ranked = rankMetaLowPerformers([
    { id: 'high-impressions', metrics: { conversions: 0, cpa: 100, impressions: '181,466' } },
    { id: 'lowest-impressions', metrics: { conversions: 8, cpa: 400, impressions: 300 } },
    { id: 'middle-impressions', metrics: { conversions: 0, cpa: 300, impressions: 1000 } },
  ]);

  assert.deepEqual(
    ranked.map((entry) => entry.id),
    ['lowest-impressions', 'middle-impressions', 'high-impressions'],
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
  assert.equal(asset.adName, 'Promo BUE image');
  assert.equal(asset.assetId, 'creative-1');
  assert.equal(asset.assetUrl, 'https://example.com/current.png');
  assert.equal(asset.assetPreviewUrl, 'https://example.com/current.png');
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

test('keeps Meta thumbnails out of asset url and resolution', () => {
  const asset = normalizeMetaLowPerformerAd({
    adAccountId: 'act_123456',
    ad: {
      id: 'ad-thumb-only',
      name: 'Promo BUE thumbnail only',
      adset: {
        id: 'adset-1',
        name: 'AR | Beneficios | BUE',
        campaign: { id: 'campaign-1', name: 'AR | BUE | Always On' },
      },
      creative: {
        id: 'creative-thumb-only',
        name: 'Creative thumbnail only',
        thumbnail_url: 'https://example.com/thumbnail-64x64.jpg',
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
    },
    imageResolution: { width: 64, height: 64 },
  });

  assert.equal(asset.assetUrl, '');
  assert.equal(asset.assetPreviewUrl, 'https://example.com/thumbnail-64x64.jpg');
  assert.equal(asset.imageWidth, 0);
  assert.equal(asset.imageHeight, 0);
  assert.equal(asset.imageResolution, '');
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
        text_optimizations: { enroll_status: 'OPT_OUT' },
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
  assert.deepEqual(payload.degrees_of_freedom_spec, {
    creative_features_spec: {
      text_optimizations: { enroll_status: 'OPT_OUT' },
    },
  });
  assert.equal(payload.url_tags, 'utm_source=meta');
  assert.equal(creative.object_story_spec.link_data.image_hash, 'old-hash');
  assert.equal(creative.object_story_spec.link_data.picture, 'https://example.com/old.png');
  assert.deepEqual(creative.degrees_of_freedom_spec.creative_features_spec.standard_enhancements, {
    enroll_status: 'OPT_OUT',
  });
});

test('builds Meta dynamic creative payload by replacing only the selected image asset', () => {
  const creative = {
    id: 'creative-dynamic',
    name: 'Dynamic Creative',
    object_story_spec: { page_id: 'page-1' },
    asset_feed_spec: {
      images: [
        { hash: 'high-hash', url: 'https://example.com/high.png' },
        { hash: 'low-hash', url: 'https://example.com/low.png' },
      ],
      bodies: [{ text: 'Ride now' }],
    },
    degrees_of_freedom_spec: {
      creative_features_spec: {
        standard_enhancements: { enroll_status: 'OPT_OUT' },
      },
    },
  };

  const payload = buildMetaCreativeClonePayload(
    creative,
    'new-hash',
    'Replacement Creative',
    { selectedImageAssetKey: 'low-hash' },
  );

  assert.equal(payload.name, 'Replacement Creative');
  assert.equal(payload.object_story_spec.page_id, 'page-1');
  assert.deepEqual(payload.asset_feed_spec.images, [
    { hash: 'high-hash', url: 'https://example.com/high.png' },
    { hash: 'new-hash' },
  ]);
  assert.deepEqual(payload.asset_feed_spec.bodies, [{ text: 'Ride now' }]);
  assert.equal(payload.degrees_of_freedom_spec, undefined);
  assert.equal(creative.asset_feed_spec.images[1].hash, 'low-hash');
});

test('fetches only active Meta campaigns', async () => {
  const calls = [];
  const campaigns = await getCampaigns('act_123', async (endpoint, params) => {
    calls.push({ endpoint, params });
    return {
      data: [
        { id: 'campaign-active', name: 'Active campaign', effective_status: 'ACTIVE' },
        { id: 'campaign-paused', name: 'Paused campaign', effective_status: 'PAUSED' },
      ],
    };
  });

  assert.deepEqual(campaigns, [{ id: 'campaign-active', label: 'Active campaign' }]);
  assert.equal(calls[0].endpoint, '/act_123/campaigns');
  assert.equal(calls[0].params.effective_status, '["ACTIVE"]');
});

test('filters selected Meta campaign IDs to active campaigns before reading insights', async () => {
  const calls = [];
  const assets = await getLowPerformingImageAssets('act_123', {
    campaignIds: ['campaign-active', 'campaign-paused'],
    limit: 10,
    graphGetImpl: async (endpoint, params) => {
      calls.push({ endpoint, params });
      if (endpoint === '/act_123/campaigns') {
        return {
          data: [
            { id: 'campaign-active', name: 'Active campaign', effective_status: 'ACTIVE' },
            { id: 'campaign-paused', name: 'Paused campaign', effective_status: 'PAUSED' },
          ],
        };
      }
      if (endpoint === '/campaign-active/insights') return { data: [] };
      throw new Error(`Unexpected endpoint ${endpoint}`);
    },
  });

  assert.deepEqual(assets, []);
  assert.deepEqual(
    calls.map((call) => call.endpoint),
    ['/act_123/campaigns', '/campaign-active/insights', '/campaign-active/insights'],
  );
  assert.deepEqual(calls.slice(1).map((call) => call.params.breakdowns), [undefined, 'image_asset']);
});

test('builds incremented Meta duplicate ad names', () => {
  assert.equal(buildNextMetaAdName('METODO DE PAGO-144'), 'METODO DE PAGO-145');
  assert.equal(buildNextMetaAdName('METODO DE PAGO'), 'METODO DE PAGO-1');
  assert.equal(buildNextMetaAdName('AD-009'), 'AD-010');
});

test('clones a Meta ad paused, pauses the original, then activates the duplicate', async () => {
  const imageDataUrl = 'data:image/png;base64,AAAA';
  const calls = [];
  const getCalls = [];
  const result = await cloneMetaAdWithReplacementCreativeFromOperation(
    'act_123',
    {
      adId: 'ad-original',
      adName: 'METODO DE PAGO-144',
      adGroupId: 'adset-1',
      requiredAspectRatio: '1:1',
      metaCreative: {
        id: 'creative-original',
        name: 'Original Creative',
        object_story_spec: {
          page_id: 'page-1',
          link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
        },
      },
    },
    imageDataUrl,
    {
      replacementImageDataUrlsByRatio: { '1:1': imageDataUrl },
      graphPostImpl: async (endpoint, data) => {
        calls.push({ endpoint, data });
        if (endpoint === '/act_123/adimages') return { images: { uploaded: { hash: 'new-image-hash' } } };
        if (endpoint === '/act_123/adcreatives') return { id: 'creative-new' };
        if (endpoint === '/act_123/ads') return { id: 'ad-new' };
        if (endpoint === '/ad-original') return { success: true };
        if (endpoint === '/ad-new') return { success: true };
        throw new Error(`Unexpected endpoint ${endpoint}`);
      },
      graphGetImpl: async (endpoint, params) => {
        getCalls.push({ endpoint, params });
        if (endpoint === '/ad-original') {
          return {
            id: 'ad-original',
            status: 'PAUSED',
            configured_status: 'PAUSED',
            effective_status: 'PAUSED',
          };
        }
        throw new Error(`Unexpected endpoint ${endpoint}`);
      },
    },
  );

  assert.equal(result.newAdId, 'ad-new');
  assert.equal(result.newAdName, 'METODO DE PAGO-145');
  assert.equal(result.newCreativeId, 'creative-new');
  assert.equal(result.pausedOriginalAdId, 'ad-original');
  assert.deepEqual(
    calls.map((call) => call.endpoint),
    ['/act_123/adimages', '/act_123/adcreatives', '/act_123/ads', '/ad-original', '/ad-new'],
  );
  assert.deepEqual(calls[2].data, {
    name: 'METODO DE PAGO-145',
    adset_id: 'adset-1',
    creative: { creative_id: 'creative-new' },
    status: 'PAUSED',
  });
  assert.deepEqual(calls[3].data, { status: 'PAUSED' });
  assert.deepEqual(calls[4].data, { status: 'ACTIVE' });
  assert.deepEqual(getCalls, [
    {
      endpoint: '/ad-original',
      params: { fields: 'id,status,configured_status,effective_status' },
    },
  ]);
});

test('does not activate Meta duplicate when the original ad remains active after pause request', async () => {
  const imageDataUrl = 'data:image/png;base64,AAAA';
  const calls = [];

  await assert.rejects(
    () => cloneMetaAdWithReplacementCreativeFromOperation(
      'act_123',
      {
        adId: 'ad-original',
        adName: 'METODO DE PAGO-144',
        adGroupId: 'adset-1',
        requiredAspectRatio: '1:1',
        metaCreative: {
          id: 'creative-original',
          name: 'Original Creative',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      },
      imageDataUrl,
      {
        replacementImageDataUrlsByRatio: { '1:1': imageDataUrl },
        pauseVerificationAttempts: 1,
        pauseVerificationDelayMs: 0,
        graphPostImpl: async (endpoint, data) => {
          calls.push({ endpoint, data });
          if (endpoint === '/act_123/adimages') return { images: { uploaded: { hash: 'new-image-hash' } } };
          if (endpoint === '/act_123/adcreatives') return { id: 'creative-new' };
          if (endpoint === '/act_123/ads') return { id: 'ad-new' };
          if (endpoint === '/ad-original') return { success: true };
          if (endpoint === '/ad-new') throw new Error('Duplicate should not be activated');
          throw new Error(`Unexpected endpoint ${endpoint}`);
        },
        graphGetImpl: async (endpoint) => {
          if (endpoint === '/ad-original') {
            return {
              id: 'ad-original',
              status: 'ACTIVE',
              configured_status: 'ACTIVE',
              effective_status: 'ACTIVE',
            };
          }
          throw new Error(`Unexpected endpoint ${endpoint}`);
        },
      },
    ),
    (error) => {
      assert.equal(error.metaPartialReplacement.newAdId, 'ad-new');
      assert.equal(error.metaPartialReplacement.newCreativeId, 'creative-new');
      assert.equal(error.metaPartialReplacement.originalAdId, 'ad-original');
      return /did not pause after update/.test(error.message) &&
        /Duplicate ad ad-new was left paused and was not activated/.test(error.message);
    },
  );

  assert.deepEqual(
    calls.map((call) => call.endpoint),
    ['/act_123/adimages', '/act_123/adcreatives', '/act_123/ads', '/ad-original'],
  );
});

test('fails Meta clone replacement if the original ad cannot be paused', async () => {
  const imageDataUrl = 'data:image/png;base64,AAAA';
  const calls = [];

  await assert.rejects(
    () => cloneMetaAdWithReplacementCreativeFromOperation(
      'act_123',
      {
        adId: 'ad-original',
        adName: 'METODO DE PAGO-144',
        adGroupId: 'adset-1',
        requiredAspectRatio: '1:1',
        metaCreative: {
          id: 'creative-original',
          name: 'Original Creative',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      },
      imageDataUrl,
      {
        replacementImageDataUrlsByRatio: { '1:1': imageDataUrl },
        graphPostImpl: async (endpoint, data) => {
          calls.push({ endpoint, data });
          if (endpoint === '/act_123/adimages') return { images: { uploaded: { hash: 'new-image-hash' } } };
          if (endpoint === '/act_123/adcreatives') return { id: 'creative-new' };
          if (endpoint === '/act_123/ads') return { id: 'ad-new' };
          if (endpoint === '/ad-original') {
            const error = new Error('Cannot pause original ad');
            error.response = { status: 400, data: { error: { message: 'Cannot pause original ad' } } };
            throw error;
          }
          throw new Error(`Unexpected endpoint ${endpoint}`);
        },
      },
    ),
    (error) => {
      assert.equal(error.metaPartialReplacement.newAdId, 'ad-new');
      assert.equal(error.metaPartialReplacement.newCreativeId, 'creative-new');
      assert.equal(error.metaPartialReplacement.originalAdId, 'ad-original');
      return /Cannot pause original ad/.test(error.message);
    },
  );

  assert.deepEqual(
    calls.map((call) => call.endpoint),
    ['/act_123/adimages', '/act_123/adcreatives', '/act_123/ads', '/ad-original'],
  );
});

test('matches Meta dynamic creative images by placement rules when image URLs are absent', async () => {
  const creative = {
    id: 'creative-dynamic',
    object_story_spec: { page_id: 'page-1' },
    asset_feed_spec: {
      images: [
        { hash: 'square-hash', adlabels: [{ id: 'label-square', name: 'square' }] },
        { hash: 'story-hash', adlabels: [{ id: 'label-story', name: 'story' }] },
        { hash: 'search-hash', adlabels: [{ id: 'label-search', name: 'search' }] },
      ],
      asset_customization_rules: [
        {
          image_label: { id: 'label-story', name: 'story' },
          customization_spec: {
            publisher_platforms: ['facebook', 'instagram', 'messenger'],
            facebook_positions: ['story', 'facebook_reels'],
            instagram_positions: ['story', 'reels'],
            messenger_positions: ['story'],
          },
          priority: 1,
        },
        {
          image_label: { id: 'label-search', name: 'search' },
          customization_spec: {
            publisher_platforms: ['facebook'],
            facebook_positions: ['search'],
          },
          priority: 2,
        },
        {
          image_label: { id: 'label-square', name: 'square' },
          customization_spec: {},
          priority: 3,
        },
      ],
    },
  };

  const imageHashByAssetKey = await buildMetaImageHashByAssetKeyForRatios({
    creative,
    replacementImageHashByRatio: {
      '1:1': 'new-square-hash',
      '9:16': 'new-story-hash',
      '1.91:1': 'new-search-hash',
    },
  });

  assert.deepEqual(imageHashByAssetKey, {
    'square-hash': 'new-square-hash',
    'story-hash': 'new-story-hash',
    'search-hash': 'new-search-hash',
  });

  const payload = buildMetaCreativeClonePayload(creative, 'new-square-hash', 'Replacement Creative', {
    imageHashByAssetKey,
  });

  assert.deepEqual(
    payload.asset_feed_spec.images.map((image) => image.hash),
    ['new-square-hash', 'new-story-hash', 'new-search-hash'],
  );
});

test('detects only ratios that exist in a Meta creative', async () => {
  const creative = {
    id: 'creative-dynamic',
    object_story_spec: { page_id: 'page-1' },
    asset_feed_spec: {
      images: [
        { hash: 'square-hash', adlabels: [{ id: 'label-square' }] },
        { hash: 'story-hash', adlabels: [{ id: 'label-story' }] },
      ],
      asset_customization_rules: [
        { image_label: { id: 'label-square' }, customization_spec: {}, priority: 2 },
        {
          image_label: { id: 'label-story' },
          customization_spec: { instagram_positions: ['story', 'reels'] },
          priority: 1,
        },
      ],
    },
  };

  const ratios = await getMetaCreativeReplacementRatios(creative, '16:9');

  assert.deepEqual(ratios, ['1:1', '9:16']);
});

test('ignores replacement ratios that are not part of the Meta creative', async () => {
  const creative = {
    id: 'creative-dynamic',
    object_story_spec: { page_id: 'page-1' },
    asset_feed_spec: {
      images: [
        { hash: 'square-hash', adlabels: [{ id: 'label-square' }] },
        { hash: 'story-hash', adlabels: [{ id: 'label-story' }] },
      ],
      asset_customization_rules: [
        { image_label: { id: 'label-square' }, customization_spec: {}, priority: 2 },
        {
          image_label: { id: 'label-story' },
          customization_spec: { instagram_positions: ['story', 'reels'] },
          priority: 1,
        },
      ],
    },
  };

  const imageHashByAssetKey = await buildMetaImageHashByAssetKeyForRatios({
    creative,
    replacementImageHashByRatio: {
      '1:1': 'new-square-hash',
      '9:16': 'new-story-hash',
      '16:9': 'new-landscape-hash',
    },
  });

  assert.deepEqual(imageHashByAssetKey, {
    'square-hash': 'new-square-hash',
    'story-hash': 'new-story-hash',
  });
});

test('collects Meta low performers unchanged for at least 30 days by lowest impressions', async () => {
  const calls = [];
  const graphGetImpl = async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (endpoint === '/campaign-1/insights') {
      if (params?.breakdowns === 'image_asset') return { data: [] };
      return {
        data: [
          { ad_id: 'ad-new', impressions: '100', clicks: '10', spend: '20' },
          { ad_id: 'ad-low-impressions-old', impressions: '300', clicks: '50', spend: '300' },
          { ad_id: 'ad-high-impressions-old', impressions: '5000', clicks: '100', spend: '100' },
        ],
      };
    }
    if (endpoint === '/ad-new') {
      return {
        id: 'ad-new',
        name: 'New ad',
        created_time: '2026-01-01T00:00:00+0000',
        updated_time: '2026-03-10T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-new',
          name: 'AR | Promo | BUE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo' },
        },
        creative: {
          id: 'creative-new',
          image_url: 'https://example.com/new.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    if (endpoint === '/ad-low-impressions-old') {
      return {
        id: 'ad-low-impressions-old',
        name: 'Low ad',
        created_time: '2026-01-01T00:00:00+0000',
        updated_time: '2026-01-15T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo' },
        },
        creative: {
          id: 'creative-low',
          name: 'Creative low',
          image_url: 'https://example.com/low.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const assets = await collectMetaLowPerformerAssets({
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 1,
    graphGetImpl,
    resolveImageResolutionImpl: async () => ({ width: 1080, height: 1080 }),
    now: new Date('2026-03-20T00:00:00Z'),
  });

  assert.equal(assets.length, 1);
  assert.equal(assets[0].adId, 'ad-low-impressions-old');
  assert.deepEqual(calls.map((call) => call.endpoint), [
    '/campaign-1/insights',
    '/campaign-1/insights',
    '/ad-new',
    '/ad-low-impressions-old',
  ]);
  assert.equal(calls[0].params.date_preset, 'maximum');
  assert.equal(calls[0].params.breakdowns, undefined);
  assert.equal(calls[1].params.breakdowns, 'image_asset');
  assert.match(calls.find((call) => call.endpoint === '/ad-new').params.fields, /updated_time/);
  assert.equal(calls.some((call) => call.endpoint === '/campaign-1/ads'), false);
});

test('requires a full calendar month for the Meta 30-day age setting', async () => {
  const graphGetImpl = async (endpoint, params) => {
    if (endpoint === '/campaign-1/insights') {
      if (params?.breakdowns === 'image_asset') return { data: [] };
      return { data: [{ ad_id: 'ad-1', impressions: '100', clicks: '10', spend: '20' }] };
    }
    if (endpoint === '/ad-1') {
      return {
        id: 'ad-1',
        name: 'Updated July ad',
        created_time: '2026-01-01T12:00:00+0000',
        updated_time: '2026-07-01T12:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          effective_status: 'ACTIVE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo', effective_status: 'ACTIVE' },
        },
        creative: {
          id: 'creative-1',
          image_url: 'https://example.com/image.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'image-hash' },
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };
  const options = {
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 1,
    minRunningDays: 30,
    graphGetImpl,
    resolveImageResolutionImpl: async () => ({ width: 1080, height: 1080 }),
  };

  const beforeCalendarMonth = await collectMetaLowPerformerAssets({
    ...options,
    now: new Date('2026-07-31T13:00:00Z'),
  });
  const atCalendarMonth = await collectMetaLowPerformerAssets({
    ...options,
    now: new Date('2026-08-01T12:00:00Z'),
  });

  assert.deepEqual(beforeCalendarMonth, []);
  assert.deepEqual(atCalendarMonth.map((asset) => asset.adId), ['ad-1']);
});

test('does not truncate Meta low performer candidates before age filtering', async () => {
  const calls = [];
  const graphGetImpl = async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (endpoint === '/campaign-1/insights') {
      if (params?.breakdowns === 'image_asset') return { data: [] };
      return {
        data: [
          ...Array.from({ length: 6 }, (_, index) => ({
            ad_id: `ad-new-${index + 1}`,
            impressions: String(100 + index),
            clicks: '1',
            spend: '1',
          })),
          { ad_id: 'ad-old-low', impressions: '126', clicks: '1', spend: '0.33' },
          { ad_id: 'ad-old-high', impressions: '181,466', clicks: '1815', spend: '308.90' },
        ],
      };
    }
    if (/^\/ad-new-\d+$/.test(endpoint)) {
      const id = endpoint.slice(1);
      return {
        id,
        name: 'New ad',
        created_time: '2026-07-24T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          effective_status: 'ACTIVE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo', effective_status: 'ACTIVE' },
        },
        creative: {
          id: `creative-${id}`,
          image_url: `https://example.com/${id}.png`,
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    if (endpoint === '/ad-old-low') {
      return {
        id: 'ad-old-low',
        name: 'SI_PRECIO - IA',
        created_time: '2026-04-29T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          effective_status: 'ACTIVE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo', effective_status: 'ACTIVE' },
        },
        creative: {
          id: 'creative-old-low',
          name: 'SI_PRECIO - IA',
          image_url: 'https://example.com/old-low.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    if (endpoint === '/ad-old-high') {
      throw new Error('High-impression old ad should not be fetched once the lower eligible ad is selected');
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const assets = await collectMetaLowPerformerAssets({
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 1,
    graphGetImpl,
    resolveImageResolutionImpl: async () => ({ width: 1080, height: 1080 }),
    now: new Date('2026-07-30T00:00:00Z'),
  });

  assert.equal(assets.length, 1);
  assert.equal(assets[0].adId, 'ad-old-low');
  assert.equal(assets[0].metrics.impressions, 126);
  assert.deepEqual(
    calls.map((call) => call.endpoint),
    [
      '/campaign-1/insights',
      '/campaign-1/insights',
      '/ad-new-1',
      '/ad-new-2',
      '/ad-new-3',
      '/ad-new-4',
      '/ad-new-5',
      '/ad-new-6',
      '/ad-old-low',
    ],
  );
});

test('keeps Meta candidates that already have conversions', async () => {
  const calls = [];
  const graphGetImpl = async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (endpoint === '/campaign-1/insights') {
      if (params?.breakdowns === 'image_asset') {
        return {
          data: [
            {
              ad_id: 'ad-old-with-purchases',
              impressions: '13',
              clicks: '0',
              spend: '0.03',
              image_asset: { hash: 'converted-low-image-hash' },
            },
          ],
        };
      }
      return {
        data: [
          {
            ad_id: 'ad-old-low',
            impressions: '126',
            clicks: '1',
            spend: '0.33',
          },
          {
            ad_id: 'ad-old-with-purchases',
            impressions: '181,466',
            clicks: '1815',
            spend: '308.90',
            actions: [{ action_type: 'purchase', value: '20' }],
            cost_per_action_type: [{ action_type: 'purchase', value: '15.45' }],
          },
        ],
      };
    }
    if (endpoint === '/ad-old-low') {
      return {
        id: 'ad-old-low',
        name: 'SI_PRECIO - IA',
        created_time: '2026-04-29T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          effective_status: 'ACTIVE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo', effective_status: 'ACTIVE' },
        },
        creative: {
          id: 'creative-old-low',
          image_url: 'https://example.com/old-low.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    if (endpoint === '/ad-old-with-purchases') {
      return {
        id: 'ad-old-with-purchases',
        name: 'SI_PRECIO - IA with purchases',
        created_time: '2026-04-24T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          effective_status: 'ACTIVE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo', effective_status: 'ACTIVE' },
        },
        creative: {
          id: 'creative-with-purchases',
          image_url: 'https://example.com/with-purchases.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'converted-low-image-hash' },
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const assets = await collectMetaLowPerformerAssets({
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 5,
    graphGetImpl,
    resolveImageResolutionImpl: async () => ({ width: 1080, height: 1080 }),
    now: new Date('2026-07-30T00:00:00Z'),
  });

  assert.deepEqual(assets.map((asset) => asset.adId), [
    'ad-old-low',
    'ad-old-with-purchases',
  ]);
  assert.deepEqual(assets.map((asset) => asset.metrics.conversions), [0, 20]);
  assert.ok(assets.every((asset) => asset.reason === 'META_LOW_IMPRESSIONS'));
  assert.deepEqual(calls.map((call) => call.endpoint), [
    '/campaign-1/insights',
    '/campaign-1/insights',
    '/ad-old-low',
    '/ad-old-with-purchases',
  ]);
});

test('skips Meta low performers whose ad, ad set, or campaign is not active', async () => {
  const graphGetImpl = async (endpoint) => {
    if (endpoint === '/campaign-1/insights') {
      return {
        data: [
          { ad_id: 'ad-paused', impressions: '100', clicks: '10', spend: '20' },
          { ad_id: 'ad-without-delivery', impressions: '200', clicks: '20', spend: '40' },
          { ad_id: 'ad-active', impressions: '300', clicks: '30', spend: '60' },
        ],
      };
    }
    if (endpoint === '/ad-paused') {
      return {
        id: 'ad-paused',
        name: 'Paused ad',
        created_time: '2026-01-01T00:00:00+0000',
        effective_status: 'PAUSED',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          effective_status: 'ACTIVE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo', effective_status: 'ACTIVE' },
        },
        creative: {
          id: 'creative-paused',
          image_url: 'https://example.com/paused.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    if (endpoint === '/ad-without-delivery') {
      return {
        id: 'ad-without-delivery',
        name: 'Ad without active delivery',
        created_time: '2026-01-01T00:00:00+0000',
        adset: {
          id: 'adset-without-delivery',
          name: 'AR | Promo | BUE',
          effective_status: 'ACTIVE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo', effective_status: 'ACTIVE' },
        },
        creative: {
          id: 'creative-without-delivery',
          image_url: 'https://example.com/without-delivery.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    if (endpoint === '/ad-active') {
      return {
        id: 'ad-active',
        name: 'Active ad',
        created_time: '2026-01-01T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-active',
          name: 'AR | Promo | BUE',
          effective_status: 'ACTIVE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo', effective_status: 'ACTIVE' },
        },
        creative: {
          id: 'creative-active',
          image_url: 'https://example.com/active.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const assets = await collectMetaLowPerformerAssets({
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 1,
    graphGetImpl,
    resolveImageResolutionImpl: async () => ({ width: 1080, height: 1080 }),
    now: new Date('2026-03-20T00:00:00Z'),
  });

  assert.deepEqual(assets.map((asset) => asset.adId), ['ad-active']);
});

test('collects the lowest-impression Meta image asset for each ad', async () => {
  const calls = [];
  const graphGetImpl = async (endpoint, params) => {
    calls.push({ endpoint, params });
    if (endpoint === '/campaign-1/insights') {
      if (params?.breakdowns !== 'image_asset') {
        return {
          data: [
            {
              ad_id: 'ad-1',
              impressions: '1000',
              clicks: '100',
              spend: '100',
            },
          ],
        };
      }
      return {
        data: [
          {
            ad_id: 'ad-1',
            impressions: '900',
            clicks: '90',
            spend: '90',
            image_asset: { hash: 'high-hash' },
          },
          {
            ad_id: 'ad-1',
            impressions: '100',
            clicks: '10',
            spend: '10',
            image_asset: { hash: 'low-hash' },
          },
        ],
      };
    }
    if (endpoint === '/ad-1') {
      return {
        id: 'ad-1',
        name: 'Dynamic image ad',
        created_time: '2026-01-01T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo' },
        },
        creative: {
          id: 'creative-dynamic',
          name: 'Dynamic Creative',
          thumbnail_url: 'https://example.com/preview.jpg',
          object_story_spec: { page_id: 'page-1' },
          asset_feed_spec: {
            images: [
              { hash: 'high-hash', url: 'https://example.com/high.png' },
              { hash: 'low-hash', url: 'https://example.com/low.png' },
            ],
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const assets = await collectMetaLowPerformerAssets({
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 1,
    graphGetImpl,
    resolveImageResolutionImpl: async (url) => {
      assert.equal(url, 'https://example.com/low.png');
      return { width: 1080, height: 1080 };
    },
    now: new Date('2026-03-20T00:00:00Z'),
  });

  assert.equal(assets.length, 1);
  assert.equal(assets[0].adId, 'ad-1');
  assert.equal(assets[0].assetId, 'low-hash');
  assert.equal(assets[0].assetUrl, 'https://example.com/low.png');
  assert.equal(assets[0].selectedMetaImageAssetKey, 'low-hash');
  assert.equal(assets[0].metrics.impressions, 1000);
  assert.equal(assets[0].supportedReplacement, true);
  assert.equal(calls[0].params.breakdowns, undefined);
  assert.equal(calls[1].params.breakdowns, 'image_asset');
  assert.doesNotMatch(calls[1].params.fields, /image_asset/);
});

test('does not use generic Meta creative image URL for hash-only dynamic image assets', async () => {
  const resolvedUrls = [];
  const graphGetImpl = async (endpoint) => {
    if (endpoint === '/campaign-1/insights') {
      return {
        data: [
          {
            ad_id: 'ad-1',
            impressions: '100',
            clicks: '10',
            spend: '10',
            image_asset: { hash: 'low-hash' },
          },
        ],
      };
    }
    if (endpoint === '/ad-1') {
      return {
        id: 'ad-1',
        name: 'Dynamic image ad',
        created_time: '2026-01-01T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo' },
        },
        creative: {
          id: 'creative-dynamic',
          name: 'Dynamic Creative',
          image_url: 'https://example.com/generic-preview.png',
          thumbnail_url: 'https://example.com/thumbnail.jpg',
          object_story_spec: { page_id: 'page-1' },
          asset_feed_spec: {
            images: [{ hash: 'low-hash' }],
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const assets = await collectMetaLowPerformerAssets({
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 1,
    graphGetImpl,
    resolveImageResolutionImpl: async (url) => {
      resolvedUrls.push(url);
      return { width: 1080, height: 1080 };
    },
    now: new Date('2026-03-20T00:00:00Z'),
  });

  assert.equal(assets.length, 1);
  assert.equal(assets[0].assetId, 'low-hash');
  assert.equal(assets[0].assetUrl, '');
  assert.equal(assets[0].assetPreviewUrl, 'https://example.com/thumbnail.jpg');
  assert.equal(assets[0].imageResolution, '');
  assert.deepEqual(resolvedUrls, []);
});

test('keeps Meta dynamic creatives replaceable when insight image hash is stale', async () => {
  const graphGetImpl = async (endpoint) => {
    if (endpoint === '/campaign-1/insights') {
      return {
        data: [
          {
            ad_id: 'ad-1',
            impressions: '100',
            clicks: '10',
            spend: '10',
            image_asset: { hash: 'stale-insight-hash' },
          },
        ],
      };
    }
    if (endpoint === '/ad-1') {
      return {
        id: 'ad-1',
        name: 'Dynamic image ad',
        created_time: '2026-01-01T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-1',
          name: 'AR | Promo | BUE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo' },
        },
        creative: {
          id: 'creative-dynamic',
          name: 'Dynamic Creative',
          thumbnail_url: 'https://example.com/thumbnail.jpg',
          object_story_spec: { page_id: 'page-1' },
          asset_feed_spec: {
            images: [
              { hash: 'square-hash', adlabels: [{ id: 'label-square' }] },
              { hash: 'story-hash', adlabels: [{ id: 'label-story' }] },
              { hash: 'search-hash', adlabels: [{ id: 'label-search' }] },
            ],
            asset_customization_rules: [
              { image_label: { id: 'label-square' }, customization_spec: {}, priority: 3 },
              {
                image_label: { id: 'label-story' },
                customization_spec: { facebook_positions: ['story'], instagram_positions: ['reels'] },
                priority: 1,
              },
              {
                image_label: { id: 'label-search' },
                customization_spec: { facebook_positions: ['search'] },
                priority: 2,
              },
            ],
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const assets = await collectMetaLowPerformerAssets({
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 1,
    graphGetImpl,
    resolveImageResolutionImpl: async () => {
      throw new Error('No image URL should be resolved for stale hash');
    },
    now: new Date('2026-03-20T00:00:00Z'),
  });

  assert.equal(assets.length, 1);
  assert.equal(assets[0].assetId, 'stale-insight-hash');
  assert.equal(assets[0].assetPreviewUrl, 'https://example.com/thumbnail.jpg');
  assert.equal(assets[0].supportedReplacement, true);
  assert.equal(assets[0].replacementSupportReason, null);
});

test('collects only Meta image low performers and skips video thumbnails', async () => {
  const resolvedUrls = [];
  const graphGetImpl = async (endpoint) => {
    if (endpoint === '/campaign-1/insights') {
      return {
        data: [
          { ad_id: 'ad-video', impressions: '100', clicks: '10', spend: '20' },
          { ad_id: 'ad-image', impressions: '300', clicks: '50', spend: '300' },
        ],
      };
    }
    if (endpoint === '/ad-video') {
      return {
        id: 'ad-video',
        name: 'Video ad',
        created_time: '2026-01-01T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-video',
          name: 'AR | Promo | BUE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo' },
        },
        creative: {
          id: 'creative-video',
          name: 'Creative video',
          thumbnail_url: 'https://example.com/video-thumbnail.jpg',
          object_story_spec: {
            page_id: 'page-1',
            video_data: { video_id: 'video-1' },
          },
        },
      };
    }
    if (endpoint === '/ad-image') {
      return {
        id: 'ad-image',
        name: 'Image ad',
        created_time: '2026-01-01T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-image',
          name: 'AR | Promo | BUE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo' },
        },
        creative: {
          id: 'creative-image',
          name: 'Creative image',
          image_url: 'https://example.com/image.png',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const assets = await collectMetaLowPerformerAssets({
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 1,
    graphGetImpl,
    resolveImageResolutionImpl: async (url) => {
      resolvedUrls.push(url);
      return { width: 1080, height: 1080 };
    },
    now: new Date('2026-03-20T00:00:00Z'),
  });

  assert.deepEqual(assets.map((asset) => asset.adId), ['ad-image']);
  assert.deepEqual(resolvedUrls, ['https://example.com/image.png']);
});

test('does not resolve Meta thumbnail-only creatives as image assets', async () => {
  const resolvedUrls = [];
  const graphGetImpl = async (endpoint) => {
    if (endpoint === '/campaign-1/insights') {
      return {
        data: [
          { ad_id: 'ad-thumb-only', impressions: '100', clicks: '10', spend: '20' },
        ],
      };
    }
    if (endpoint === '/ad-thumb-only') {
      return {
        id: 'ad-thumb-only',
        name: 'Image ad with thumbnail only',
        created_time: '2026-01-01T00:00:00+0000',
        effective_status: 'ACTIVE',
        adset: {
          id: 'adset-image',
          name: 'AR | Promo | BUE',
          campaign: { id: 'campaign-1', name: 'AR | BUE | Promo' },
        },
        creative: {
          id: 'creative-thumb-only',
          name: 'Creative thumbnail only',
          thumbnail_url: 'https://example.com/thumbnail-64x64.jpg',
          object_story_spec: {
            page_id: 'page-1',
            link_data: { link: 'https://cabify.com', image_hash: 'old-hash' },
          },
        },
      };
    }
    throw new Error(`Unexpected endpoint ${endpoint}`);
  };

  const assets = await collectMetaLowPerformerAssets({
    adAccountId: 'act_123',
    campaignIds: ['campaign-1'],
    limit: 1,
    graphGetImpl,
    resolveImageResolutionImpl: async (url) => {
      resolvedUrls.push(url);
      return { width: 64, height: 64 };
    },
    now: new Date('2026-03-20T00:00:00Z'),
  });

  assert.equal(assets.length, 1);
  assert.equal(assets[0].assetUrl, '');
  assert.equal(assets[0].assetPreviewUrl, 'https://example.com/thumbnail-64x64.jpg');
  assert.equal(assets[0].imageResolution, '');
  assert.deepEqual(resolvedUrls, []);
});

test('formats Meta Graph API rate limit errors for the UI', () => {
  const error = new Error('Request failed with status code 400');
  error.response = {
    status: 400,
    data: {
      error: {
        error_user_title: 'Ad Account Has Too Many API Calls',
        error_user_msg: 'Please wait a bit and try again.',
        code: 17,
        fbtrace_id: 'trace-1',
      },
    },
  };

  assert.equal(
    formatMetaGraphErrorMessage(error),
    'Meta Ads: Ad Account Has Too Many API Calls. Please wait a bit and try again. (code 17, fbtrace_id trace-1)',
  );
});
