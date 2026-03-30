import axios from 'axios';
import FormData from 'form-data';

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;

const getAccessToken = () => {
  const accessToken = process.env.META_ACCESS_TOKEN;
  if (!accessToken) {
    throw new Error('Missing META_ACCESS_TOKEN.');
  }
  return accessToken;
};

/**
 * Parse META_AD_ACCOUNT_IDS env var (comma-separated).
 * Ensures each ID has the "act_" prefix.
 */
export const getAccounts = () => {
  const raw = process.env.META_AD_ACCOUNT_IDS || '';
  if (!raw.trim()) return [];

  return raw.split(',').map((entry) => {
    const [idPart, ...nameParts] = entry.trim().split(':');
    const clean = idPart.trim();
    const id = clean.startsWith('act_') ? clean : `act_${clean}`;
    const label = nameParts.join(':').trim() || id;
    return { id, label };
  });
};

const graphGet = async (endpoint, params = {}) => {
  const accessToken = getAccessToken();
  const response = await axios.get(`${GRAPH_BASE_URL}${endpoint}`, {
    params: { access_token: accessToken, ...params },
    timeout: 30000,
  });
  return response.data;
};

const graphPost = async (endpoint, data = {}) => {
  const accessToken = getAccessToken();
  const isFormData = data instanceof FormData;

  const config = {
    timeout: 60000,
  };

  if (isFormData) {
    config.params = { access_token: accessToken };
    config.headers = data.getHeaders();
  } else {
    config.headers = { 'Content-Type': 'application/json' };
  }

  const body = isFormData ? data : { access_token: accessToken, ...data };
  const response = await axios.post(`${GRAPH_BASE_URL}${endpoint}`, body, config);
  return response.data;
};

/**
 * Fetch all active campaigns for an ad account.
 */
export const getCampaigns = async (adAccountId) => {
  if (!adAccountId) throw new Error('adAccountId is required.');

  const response = await graphGet(`/${adAccountId}/campaigns`, {
    fields: 'id,name',
    effective_status: '["ACTIVE","PAUSED"]',
    limit: 200,
  });

  return (response?.data || []).map((c) => ({
    id: c.id,
    label: c.name || `Campaign ${c.id}`,
  }));
};

/**
 * Fetch the 3 worst performing ads (lowest conversions, tie-break by highest CPA).
 */
export const getWorstPerformers = async (adAccountId, campaignId, days = 30) => {
  if (!adAccountId) {
    throw new Error('adAccountId is required.');
  }

  // Step 1: Fetch ads filtered by campaign
  const adsResponse = await graphGet(`/${campaignId}/ads`, {
    fields: 'id,name,adset{name,campaign{name}},creative{image_url,thumbnail_url}',
    effective_status: '["ACTIVE"]',
    limit: 200,
  });

  const ads = adsResponse?.data || [];
  if (ads.length === 0) {
    return [];
  }

  // Step 2: Fetch insights for each ad (batch in parallel, max 10 at a time)
  const adsWithMetrics = [];
  const batchSize = 10;

  for (let i = 0; i < ads.length; i += batchSize) {
    const batch = ads.slice(i, i + batchSize);

    const insightsPromises = batch.map(async (ad) => {
      try {
        const datePreset = days === 7 ? 'last_7d' : 'last_30d';
        const insights = await graphGet(`/${ad.id}/insights`, {
          fields: 'actions,cost_per_action_type',
          date_preset: datePreset,
        });

        const insightData = insights?.data?.[0];
        const conversions = extractConversions(insightData);
        const cpa = extractCPA(insightData);

        const imageUrl =
          ad.creative?.image_url || ad.creative?.thumbnail_url || null;

        if (!imageUrl) return null;

        return {
          id: ad.id,
          name: ad.name || `Ad ${ad.id}`,
          campaignName: ad.adset?.campaign?.name || 'Unknown Campaign',
          adGroupName: ad.adset?.name || 'Unknown Ad Set',
          imageUrl,
          metrics: { conversions, cpa },
          platform: 'meta',
        };
      } catch {
        return null;
      }
    });

    const results = await Promise.all(insightsPromises);
    adsWithMetrics.push(...results.filter(Boolean));
  }

  // Step 3: Sort by conversions ASC, then CPA DESC (higher CPA = worse)
  adsWithMetrics.sort((a, b) => {
    if (a.metrics.conversions !== b.metrics.conversions) {
      return a.metrics.conversions - b.metrics.conversions;
    }
    return b.metrics.cpa - a.metrics.cpa;
  });

  return adsWithMetrics.slice(0, 3);
};

const extractConversions = (insightData) => {
  if (!insightData?.actions) return 0;

  const conversionAction = insightData.actions.find(
    (a) =>
      a.action_type === 'offsite_conversion' ||
      a.action_type === 'onsite_conversion' ||
      a.action_type === 'omni_purchase' ||
      a.action_type === 'purchase'
  );

  return conversionAction ? Number(conversionAction.value ?? 0) : 0;
};

const extractCPA = (insightData) => {
  if (!insightData?.cost_per_action_type) return 0;

  const cpaAction = insightData.cost_per_action_type.find(
    (a) =>
      a.action_type === 'offsite_conversion' ||
      a.action_type === 'onsite_conversion' ||
      a.action_type === 'omni_purchase' ||
      a.action_type === 'purchase'
  );

  return cpaAction ? Number(cpaAction.value ?? 0) : 0;
};

/**
 * Replace an ad's creative with a new image.
 */
export const replaceAdCreative = async (adAccountId, adId, newImageDataUrl) => {
  if (!adAccountId) {
    throw new Error('adAccountId is required.');
  }

  const match = newImageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid image data URL format.');
  }

  const imageBuffer = Buffer.from(match[2], 'base64');

  // 1. Upload image to ad account
  const form = new FormData();
  form.append('filename', `optimized_${Date.now()}.png`);
  form.append('file', imageBuffer, {
    filename: `optimized_${Date.now()}.png`,
    contentType: match[1],
  });

  const uploadResponse = await graphPost(`/${adAccountId}/adimages`, form);

  const imageHash = Object.values(uploadResponse?.images || {})[0]?.hash;
  if (!imageHash) {
    throw new Error('Failed to upload image to Meta.');
  }

  // 2. Create new ad creative
  const creativeResponse = await graphPost(`/${adAccountId}/adcreatives`, {
    name: `Optimized Creative ${Date.now()}`,
    object_story_spec: {
      page_id: process.env.META_PAGE_ID,
      link_data: {
        image_hash: imageHash,
        link: 'https://www.cabify.com',
      },
    },
  });

  const newCreativeId = creativeResponse?.id;
  if (!newCreativeId) {
    throw new Error('Failed to create ad creative in Meta.');
  }

  // 3. Update ad to use new creative
  await graphPost(`/${adId}`, {
    creative: { creative_id: newCreativeId },
  });

  return {
    success: true,
    newCreativeId,
    imageHash,
  };
};
