import axios from 'axios';
import crypto from 'node:crypto';
import FormData from 'form-data';
import { downloadAdImage } from './adImageDownloader.js';
import { getImageResolutionFromDataUrl } from './imageRatio.js';

const GRAPH_API_VERSION = 'v25.0';
const GRAPH_BASE_URL = `https://graph.facebook.com/${GRAPH_API_VERSION}`;
const META_CREATIVE_FIELDS =
  'id,name,image_url,thumbnail_url,object_story_spec,asset_feed_spec,degrees_of_freedom_spec,url_tags,effective_object_story_id';
const META_AD_FIELDS =
  `id,name,created_time,effective_status,adset{id,name,campaign{id,name}},creative{${META_CREATIVE_FIELDS}}`;
const META_ADS_FIELDS = META_AD_FIELDS;
const META_INSIGHTS_FIELDS =
  'ad_id,ad_name,adset_id,adset_name,campaign_id,campaign_name,impressions,clicks,spend,actions,cost_per_action_type';

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

export const formatMetaGraphErrorMessage = (error) => {
  const graphError = error?.response?.data?.error;
  if (!graphError) return error?.message || String(error);

  const title = graphError.error_user_title || graphError.message || 'Meta API error';
  const body = graphError.error_user_msg && graphError.error_user_msg !== title
    ? ` ${graphError.error_user_msg}`
    : '';
  const details = [
    graphError.code !== undefined ? `code ${graphError.code}` : '',
    graphError.fbtrace_id ? `fbtrace_id ${graphError.fbtrace_id}` : '',
  ].filter(Boolean).join(', ');

  return `Meta Ads: ${title}.${body}${details ? ` (${details})` : ''}`;
};

const decorateMetaGraphError = (error) => {
  error.message = formatMetaGraphErrorMessage(error);
  return error;
};

const graphGet = async (endpoint, params = {}) => {
  const accessToken = getAccessToken();
  try {
    const response = await axios.get(`${GRAPH_BASE_URL}${endpoint}`, {
      params: { access_token: accessToken, ...params },
      timeout: 30000,
    });
    return response.data;
  } catch (error) {
    throw decorateMetaGraphError(error);
  }
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
  try {
    const response = await axios.post(`${GRAPH_BASE_URL}${endpoint}`, body, config);
    return response.data;
  } catch (error) {
    throw decorateMetaGraphError(error);
  }
};

const getMetaErrorDetails = (error) => ({
  message: error?.message || String(error),
  status: error?.response?.status || error?.code || null,
  statusText: error?.response?.statusText || null,
  data: error?.response?.data || null,
});

const pushMetaTrace = (trace, step, status, details = {}) => {
  const entry = {
    timestamp: new Date().toISOString(),
    step,
    status,
    ...details,
  };
  trace.push(entry);
  return entry;
};

const throwWithMetaTrace = (error, trace) => {
  error.metaAdsTrace = trace;
  throw error;
};

const parseNumber = (value) => {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
};

const deepClone = (value) =>
  value === undefined ? undefined : JSON.parse(JSON.stringify(value));

const buildMetaLowPerformerId = ({
  adAccountId,
  campaignId,
  adsetId,
  adId,
  creativeId,
  imageUrl,
}) =>
  `meta_${crypto
    .createHash('sha1')
    .update([adAccountId, campaignId, adsetId, adId, creativeId, imageUrl].filter(Boolean).join('|'))
    .digest('hex')
    .slice(0, 16)}`;

const buildMetaAdsUrl = (adAccountId, adId) => {
  const cleanAccountId = String(adAccountId || '').replace(/^act_/i, '').trim();
  const params = new URLSearchParams();
  if (cleanAccountId) params.set('act', cleanAccountId);
  if (adId) params.set('selected_ad_ids', adId);
  return `https://adsmanager.facebook.com/adsmanager/manage/ads?${params.toString()}`;
};

const getMetaCreativeImageUrl = (creative = {}) =>
  creative.image_url ||
  creative.object_story_spec?.link_data?.picture ||
  '';

const getMetaCreativePreviewUrl = (creative = {}) =>
  getMetaCreativeImageUrl(creative) || creative.thumbnail_url || '';

const hasListEntries = (value) => Array.isArray(value) && value.length > 0;

const isMetaVideoCreative = (creative = {}) => {
  const objectStorySpec = creative.object_story_spec || {};
  const assetFeedSpec = creative.asset_feed_spec || {};
  return Boolean(
    creative.video_id ||
    objectStorySpec.video_data ||
    objectStorySpec.video_id ||
    objectStorySpec.link_data?.video_id ||
    hasListEntries(assetFeedSpec.videos),
  );
};

export const isSafeMetaCreativeForImageClone = (creative = {}) => {
  if (!creative || typeof creative !== 'object') {
    return {
      supported: false,
      reason: 'META_CREATIVE_NOT_FOUND',
      message: 'Review this Meta creative before replacing it.',
    };
  }

  if (creative.asset_feed_spec) {
    return {
      supported: false,
      reason: 'META_DYNAMIC_CREATIVE',
      message: 'Flexible Meta creatives need a manual review before replacement.',
    };
  }

  const objectStorySpec = creative.object_story_spec || {};
  if (isMetaVideoCreative(creative)) {
    return {
      supported: false,
      reason: 'META_VIDEO_CREATIVE',
      message: 'Video Meta creatives need a manual review before replacement.',
    };
  }

  const linkData = objectStorySpec.link_data;
  if (!linkData || typeof linkData !== 'object') {
    return {
      supported: false,
      reason: 'META_UNSUPPORTED_CREATIVE_SHAPE',
      message: 'This Meta creative needs a manual review before replacement.',
    };
  }

  if (Array.isArray(linkData.child_attachments) && linkData.child_attachments.length > 0) {
    return {
      supported: false,
      reason: 'META_CAROUSEL_CREATIVE',
      message: 'Carousel Meta creatives need a manual review before replacement.',
    };
  }

  if (!objectStorySpec.page_id) {
    return {
      supported: false,
      reason: 'META_PAGE_ID_NOT_FOUND',
      message: 'This Meta creative is missing the Page context needed for replacement.',
    };
  }

  return {
    supported: true,
    reason: null,
    message: null,
  };
};

export const buildMetaCreativeClonePayload = (creative, imageHash, name) => {
  const safety = isSafeMetaCreativeForImageClone(creative);
  if (!safety.supported) {
    throw new Error(safety.message || 'Meta creative cannot be cloned safely.');
  }
  if (!imageHash) throw new Error('imageHash is required.');

  const objectStorySpec = deepClone(creative.object_story_spec);
  objectStorySpec.link_data = {
    ...objectStorySpec.link_data,
    image_hash: imageHash,
  };
  delete objectStorySpec.link_data.picture;
  delete objectStorySpec.link_data.image_crops;

  const payload = {
    name: name || `${creative.name || 'Creative'} replacement`,
    object_story_spec: objectStorySpec,
  };

  if (creative.degrees_of_freedom_spec) {
    payload.degrees_of_freedom_spec = deepClone(creative.degrees_of_freedom_spec);
  }
  if (creative.url_tags) {
    payload.url_tags = creative.url_tags;
  }

  return payload;
};

const buildMetaMetrics = (insight = {}) => {
  const impressions = parseNumber(insight.impressions);
  const clicks = parseNumber(insight.clicks);
  const conversions = insight.conversions !== undefined
    ? parseNumber(insight.conversions)
    : extractConversions(insight);
  const cpa = insight.cpa !== undefined ? parseNumber(insight.cpa) : extractCPA(insight);
  const cost = parseNumber(insight.spend);
  const ctr = clicks > 0 && impressions > 0 ? clicks / impressions : 0;
  const conversionRate = clicks > 0 ? conversions / clicks : 0;

  return { impressions, clicks, ctr, conversions, conversionRate, cost, cpa };
};

export const normalizeMetaLowPerformerAd = ({
  adAccountId,
  ad,
  insight = {},
  imageResolution = {},
}) => {
  const creative = ad?.creative || {};
  const campaign = ad?.adset?.campaign || {};
  const campaignId = String(campaign.id || insight.campaign_id || '');
  const campaignName = campaign.name || insight.campaign_name || 'Unknown Campaign';
  const adsetId = String(ad?.adset?.id || insight.adset_id || '');
  const adsetName = ad?.adset?.name || insight.adset_name || 'Unknown Ad Set';
  const adId = String(ad?.id || insight.ad_id || '');
  const creativeId = String(creative.id || '');
  const imageUrl = getMetaCreativeImageUrl(creative);
  const previewUrl = getMetaCreativePreviewUrl(creative);
  const width = parseNumber(imageResolution.width);
  const height = parseNumber(imageResolution.height);
  const safety = isSafeMetaCreativeForImageClone(creative);
  const hasRealImageUrl = Boolean(imageUrl);

  return {
    id: buildMetaLowPerformerId({
      adAccountId,
      campaignId,
      adsetId,
      adId,
      creativeId,
      imageUrl: imageUrl || previewUrl,
    }),
    platform: 'meta',
    platformLabel: 'Meta Ads',
    accountId: adAccountId,
    customerId: adAccountId,
    campaignId,
    campaignName,
    adGroupId: adsetId,
    adGroupName: adsetName,
    assetGroupId: '',
    assetGroupName: '',
    adId,
    adName: ad?.name || `Ad ${adId}`,
    adType: 'META_IMAGE_AD',
    adResourceName: adId,
    assetId: creativeId,
    assetResourceName: creativeId,
    assetName: creative.name || ad?.name || `Ad ${adId}`,
    assetUrl: imageUrl,
    assetPreviewUrl: previewUrl,
    imageWidth: hasRealImageUrl && width > 0 ? width : 0,
    imageHeight: hasRealImageUrl && height > 0 ? height : 0,
    imageResolution: hasRealImageUrl && width > 0 && height > 0 ? `${width}x${height}` : '',
    targetType: 'META_AD',
    associationResourceName: adId,
    assetFieldType: '',
    googleAdsUrl: '',
    adsUrl: buildMetaAdsUrl(adAccountId, adId),
    targetName: [campaignName, adsetName].filter(Boolean).join(' | '),
    metrics: buildMetaMetrics(insight),
    performanceLabel: '',
    reason: 'META_LOW_CONVERSIONS_HIGH_CPA',
    supportedReplacement: safety.supported,
    replacementSupportReason: safety.supported ? null : safety.reason,
    replacementSupportMessage: safety.supported ? null : safety.message,
    replacementStrategy: safety.supported ? 'META_CREATIVE_CLONE' : 'META_MANUAL_REVIEW',
    metaCreative: creative,
  };
};

export const rankMetaLowPerformers = (assets = []) =>
  [...assets].sort((left, right) => {
    const leftMetrics = left.metrics || {};
    const rightMetrics = right.metrics || {};
    return parseNumber(leftMetrics.impressions) - parseNumber(rightMetrics.impressions);
  });

const normalizeCampaignIds = (options = {}) => {
  const rawIds = Array.isArray(options.campaignIds)
    ? options.campaignIds
    : options.campaignIds
      ? [options.campaignIds]
      : options.campaignId
        ? [options.campaignId]
        : [];

  return [...new Set(rawIds.map((id) => String(id).trim()).filter(Boolean))];
};

const resolveImageResolution = async (imageUrl) => {
  if (!imageUrl) return {};

  try {
    const dataUrl = await downloadAdImage(imageUrl);
    return await getImageResolutionFromDataUrl(dataUrl);
  } catch {
    return {};
  }
};

const insightMapByAdId = (insights = []) =>
  new Map((insights || []).map((insight) => [String(insight.ad_id || ''), insight]));

const normalizeInsightCandidate = (insight = {}) => ({
  adId: String(insight.ad_id || '').trim(),
  insight,
  metrics: buildMetaMetrics(insight),
});

const getMetaAdRunningDays = (ad = {}, now = new Date()) => {
  const createdTime = Date.parse(ad.created_time || '');
  if (!Number.isFinite(createdTime)) return 0;
  return Math.floor((now.getTime() - createdTime) / (24 * 60 * 60 * 1000));
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

export const collectMetaLowPerformerAssets = async ({
  adAccountId,
  campaignIds,
  limit,
  datePreset = 'last_30d',
  graphGetImpl = graphGet,
  resolveImageResolutionImpl = resolveImageResolution,
  now = new Date(),
}) => {
  const maxResults = Math.max(1, Math.min(Number(limit || 100), 500));
  const selectedCampaignIds = normalizeCampaignIds({ campaignIds });
  const insights = [];

  for (const campaignId of selectedCampaignIds) {
    const insightsResponse = await graphGetImpl(`/${campaignId}/insights`, {
      level: 'ad',
      fields: META_INSIGHTS_FIELDS,
      date_preset: datePreset,
      limit: 500,
    });
    insights.push(...(insightsResponse?.data || []));
  }

  const rankedCandidates = rankMetaLowPerformers(
    insights
      .map(normalizeInsightCandidate)
      .filter((candidate) => candidate.adId),
  ).slice(0, Math.min(Math.max(maxResults * 5, maxResults), 100));
  const assets = [];

  for (const candidate of rankedCandidates) {
    if (assets.length >= maxResults) break;

    const ad = await graphGetImpl(`/${candidate.adId}`, {
      fields: META_AD_FIELDS,
    });
    if (getMetaAdRunningDays(ad, now) < 30) continue;

    const creative = ad?.creative || {};
    if (isMetaVideoCreative(creative)) continue;

    const imageUrl = getMetaCreativeImageUrl(creative);
    const previewUrl = getMetaCreativePreviewUrl(creative);
    if (!imageUrl && !previewUrl) continue;

    const imageResolution = imageUrl ? await resolveImageResolutionImpl(imageUrl) : {};
    assets.push(normalizeMetaLowPerformerAd({
      adAccountId,
      ad,
      insight: candidate.insight,
      imageResolution,
    }));
  }

  return assets;
};

export const getLowPerformingImageAssets = async (adAccountId, options = {}) => {
  if (!adAccountId) throw new Error('adAccountId is required.');

  const limit = Math.max(1, Math.min(Number(options.limit || 100), 500));
  const datePreset = options.datePreset || 'last_30d';
  const selectedCampaignIds = normalizeCampaignIds(options);
  const campaigns = selectedCampaignIds.length > 0
    ? selectedCampaignIds.map((id) => ({ id }))
    : await getCampaigns(adAccountId);
  const campaignIds = campaigns.map((campaign) => String(campaign.id || '').trim()).filter(Boolean);

  return collectMetaLowPerformerAssets({
    adAccountId,
    campaignIds,
    limit,
    datePreset,
  });
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
      fields: 'id,name,adset{name,campaign{name}},creative{image_url,thumbnail_url,object_story_spec,asset_feed_spec}',
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

        if (isMetaVideoCreative(ad.creative || {})) return null;

        const imageUrl = getMetaCreativeImageUrl(ad.creative || {});

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

export const getAdCreativeForReplacement = async (adId) => {
  if (!adId) throw new Error('adId is required.');

  const response = await graphGet(`/${adId}`, {
    fields: `creative{${META_CREATIVE_FIELDS}}`,
  });

  return response?.creative || null;
};

const uploadMetaImage = async ({ adAccountId, imageDataUrl, metaAdsTrace }) => {
  const match = imageDataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error('Invalid image data URL format.');
  }

  const imageBuffer = Buffer.from(match[2], 'base64');
  pushMetaTrace(metaAdsTrace, 'validate_input', 'success', {
    adAccountId,
    mimeType: match[1],
    imageBytes: imageBuffer.length,
  });

  const fileName = `creative_replacement_${Date.now()}.png`;
  const form = new FormData();
  form.append('filename', fileName);
  form.append('file', imageBuffer, {
    filename: fileName,
    contentType: match[1],
  });

  let uploadResponse;
  try {
    pushMetaTrace(metaAdsTrace, 'upload_image_to_meta_adimages', 'started', {
      endpoint: `/${adAccountId}/adimages`,
      fileName,
    });
    uploadResponse = await graphPost(`/${adAccountId}/adimages`, form);
  } catch (error) {
    pushMetaTrace(metaAdsTrace, 'upload_image_to_meta_adimages', 'error', getMetaErrorDetails(error));
    throwWithMetaTrace(error, metaAdsTrace);
  }

  const imageHash = Object.values(uploadResponse?.images || {})[0]?.hash;
  if (!imageHash) {
    const error = new Error('Failed to upload image to Meta.');
    pushMetaTrace(metaAdsTrace, 'upload_image_to_meta_adimages', 'error', {
      message: error.message,
      response: uploadResponse,
    });
    throwWithMetaTrace(error, metaAdsTrace);
  }

  pushMetaTrace(metaAdsTrace, 'upload_image_to_meta_adimages', 'success', {
    imageHash,
    responseImageKeys: Object.keys(uploadResponse?.images || {}),
  });
  return imageHash;
};

export const replaceAdCreativeFromOperation = async (adAccountId, operation, newImageDataUrl) => {
  const metaAdsTrace = [];

  if (!adAccountId) {
    throw new Error('adAccountId is required.');
  }
  if (!operation?.adId) {
    throw new Error('operation.adId is required.');
  }

  const imageHash = await uploadMetaImage({
    adAccountId,
    imageDataUrl: newImageDataUrl,
    metaAdsTrace,
  });
  const existingCreative = operation.metaCreative || await getAdCreativeForReplacement(operation.adId);
  const creativePayload = buildMetaCreativeClonePayload(
    existingCreative,
    imageHash,
    `${existingCreative?.name || operation.assetName || 'Meta creative'} replacement`,
  );

  let creativeResponse;
  try {
    pushMetaTrace(metaAdsTrace, 'create_meta_adcreative', 'started', {
      endpoint: `/${adAccountId}/adcreatives`,
      sourceCreativeId: existingCreative?.id || null,
    });
    creativeResponse = await graphPost(`/${adAccountId}/adcreatives`, creativePayload);
  } catch (error) {
    pushMetaTrace(metaAdsTrace, 'create_meta_adcreative', 'error', getMetaErrorDetails(error));
    throwWithMetaTrace(error, metaAdsTrace);
  }

  const newCreativeId = creativeResponse?.id;
  if (!newCreativeId) {
    const error = new Error('Failed to create ad creative in Meta.');
    pushMetaTrace(metaAdsTrace, 'create_meta_adcreative', 'error', {
      message: error.message,
      response: creativeResponse,
    });
    throwWithMetaTrace(error, metaAdsTrace);
  }
  pushMetaTrace(metaAdsTrace, 'create_meta_adcreative', 'success', {
    newCreativeId,
  });

  try {
    pushMetaTrace(metaAdsTrace, 'update_meta_ad', 'started', {
      endpoint: `/${operation.adId}`,
      newCreativeId,
    });
    await graphPost(`/${operation.adId}`, {
      creative: { creative_id: newCreativeId },
    });
  } catch (error) {
    pushMetaTrace(metaAdsTrace, 'update_meta_ad', 'error', getMetaErrorDetails(error));
    throwWithMetaTrace(error, metaAdsTrace);
  }

  pushMetaTrace(metaAdsTrace, 'update_meta_ad', 'success', {
    adId: operation.adId,
    newCreativeId,
  });

  return {
    success: true,
    newCreativeId,
    imageHash,
    assetResourceName: newCreativeId,
    updatedAdResourceName: operation.adId,
    metaAdsTrace,
  };
};

/**
 * Replace an ad's creative with a new image.
 */
export const replaceAdCreative = async (adAccountId, adId, newImageDataUrl) => {
  return replaceAdCreativeFromOperation(adAccountId, { adId }, newImageDataUrl);
};
