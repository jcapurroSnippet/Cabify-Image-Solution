import { GoogleAdsApi } from 'google-ads-api';
import crypto from 'node:crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getCreativeLibraryConfig } from './creativeLibraryConfig.js';
import {
  isGoogleLowPerformanceLabel,
  isImageAssetFieldType,
  normalizeGoogleAdType,
  normalizeGoogleAssetFieldType,
  normalizeGooglePerformanceLabel,
} from './creativeLibraryCore.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const oauthTokenPath = path.join(__dirname, '../../.oauth-token.json');
const SUPPORTED_AD_GROUP_AD_REPLACEMENT_TYPES = new Set(['IMAGE_AD', 'APP_AD', 'APP_ENGAGEMENT_AD']);
const APP_AD_MANUAL_REPLACEMENT_MESSAGE =
  'App Ad image replacement must be completed directly in Google Ads. Google Ads API cannot remove App Ads or create another ad in the same app ad group.';

const normalizeCustomerId = (value) => String(value || '').replace(/\D/g, '');

const getAdGroupAdReplacementStrategy = (adType) => {
  const normalized = normalizeGoogleAdType(adType);
  if (normalized === 'IMAGE_AD') return 'IMAGE_AD_UPDATE';
  if (normalized === 'APP_ENGAGEMENT_AD') return 'APP_ENGAGEMENT_AD_UPDATE';
  if (normalized === 'APP_AD') return 'APP_AD_MANUAL_REPLACEMENT';
  return 'UNSUPPORTED_TARGET';
};

const getOAuthTokens = () => {
  if (process.env.GOOGLE_OAUTH_TOKEN_JSON) {
    try {
      return JSON.parse(process.env.GOOGLE_OAUTH_TOKEN_JSON);
    } catch {
      // fall through
    }
  }

  if (fs.existsSync(oauthTokenPath)) {
    try {
      return JSON.parse(fs.readFileSync(oauthTokenPath, 'utf-8'));
    } catch {
      // fall through
    }
  }
  return null;
};

export const getAccounts = () => {
  const raw = process.env.GOOGLE_ADS_CUSTOMER_IDS || '';
  if (!raw.trim()) return [];

  return raw.split(',').map((entry) => {
    const [idPart, ...nameParts] = entry.trim().split(':');
    const clean = normalizeCustomerId(idPart);
    const label = nameParts.join(':').trim() || idPart.trim().replace(/(\d{3})(\d{3})(\d{4})/, '$1-$2-$3');
    return { id: clean, label };
  });
};

const getClient = (customerId) => {
  const developerToken = process.env.GOOGLE_ADS_DEVELOPER_TOKEN;
  const clientId = process.env.GOOGLE_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GOOGLE_OAUTH_CLIENT_SECRET;

  if (!developerToken) throw new Error('Missing GOOGLE_ADS_DEVELOPER_TOKEN.');
  if (!customerId) throw new Error('customerId is required.');

  const tokens = getOAuthTokens();
  const googleAdsRefreshToken = process.env.GOOGLE_ADS_REFRESH_TOKEN?.trim();
  let refreshToken = googleAdsRefreshToken || tokens?.refresh_token;
  if (!refreshToken) {
    throw new Error('Missing OAuth refresh token. Set up OAuth or set GOOGLE_ADS_REFRESH_TOKEN.');
  }
  if (!googleAdsRefreshToken && tokens?.scope && !String(tokens.scope).includes('https://www.googleapis.com/auth/adwords')) {
    throw new Error(
      'Saved Google OAuth token is missing the Google Ads scope. Run setup-oauth.js again to grant https://www.googleapis.com/auth/adwords.'
    );
  }

  const client = new GoogleAdsApi({
    client_id: clientId || '',
    client_secret: clientSecret || '',
    developer_token: developerToken,
  });

  return client.Customer({
    customer_id: normalizeCustomerId(customerId),
    refresh_token: refreshToken,
    login_customer_id: normalizeCustomerId(process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID) || undefined,
  });
};

/**
 * Fetch all enabled campaigns for an account.
 */
export const getCampaigns = async (customerId) => {
  const customer = getClient(customerId);

  const results = await customer.query(`
    SELECT campaign.id, campaign.name
    FROM campaign
    WHERE campaign.status = 'ENABLED'
    ORDER BY campaign.name ASC
  `);

  return results.map((row) => ({
    id: String(row.campaign.id),
    label: row.campaign.name || `Campaign ${row.campaign.id}`,
  }));
};

const microsToCurrency = (micros) => Number(micros ?? 0) / 1_000_000;

const getAllTimePerformanceDateFilter = () => {
  const startDate = process.env.GOOGLE_LOW_PERFORMANCE_START_DATE || '2010-01-01';
  const endDate = new Date().toISOString().slice(0, 10);
  return `AND segments.date BETWEEN '${startDate}' AND '${endDate}'`;
};

const getAssetFieldType = (view) => {
  if (!view) return '';
  if (view.field_type !== undefined && view.field_type !== null) {
    return normalizeGoogleAssetFieldType(view.field_type);
  }

  const resourceFieldType = String(view.resource_name || '').split('~').pop();
  if (/^[A-Z][A-Z0-9_]*$/.test(resourceFieldType)) return normalizeGoogleAssetFieldType(resourceFieldType);

  return '';
};

const buildImageResolution = (asset) => {
  const fullSize = asset?.image_asset?.full_size || {};
  const width = Number(fullSize.width_pixels ?? fullSize.widthPixels ?? 0);
  const height = Number(fullSize.height_pixels ?? fullSize.heightPixels ?? 0);

  return {
    imageWidth: Number.isFinite(width) ? width : 0,
    imageHeight: Number.isFinite(height) ? height : 0,
    imageResolution: width > 0 && height > 0 ? `${width}x${height}` : '',
  };
};

const getGoogleAdsUiParam = (key, fallback = '') => String(process.env[key] || fallback).replace(/-/g, '').trim();

const buildGoogleAdsAssetUrl = ({ customerId }) => {
  const cleanCustomerId = String(customerId || '').replace(/-/g, '');
  const ocid = getGoogleAdsUiParam('GOOGLE_ADS_UI_OCID', process.env.GOOGLE_ADS_ASSET_REPORT_OCID || cleanCustomerId);
  const ascid = getGoogleAdsUiParam('GOOGLE_ADS_UI_ASCID', process.env.GOOGLE_ADS_ASSET_REPORT_ASCID || ocid);
  const uscid = getGoogleAdsUiParam(
    'GOOGLE_ADS_UI_USCID',
    process.env.GOOGLE_ADS_ASSET_REPORT_USCID || process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID || ocid,
  );
  const params = new URLSearchParams({
    ocid,
    ascid,
  });
  const optionalParams = [
    ['euid', getGoogleAdsUiParam('GOOGLE_ADS_UI_EUID', '1160530543')],
    ['__u', getGoogleAdsUiParam('GOOGLE_ADS_UI_U', '2272046007')],
    ['uscid', uscid],
    ['__c', getGoogleAdsUiParam('GOOGLE_ADS_UI_C', '2873937632')],
    ['authuser', getGoogleAdsUiParam('GOOGLE_ADS_UI_AUTHUSER', '0')],
  ];

  for (const [key, value] of optionalParams) {
    if (value) params.set(key, value);
  }

  return `https://ads.google.com/aw/assetreport/performance?${params.toString()}`;
};

const normalizeCampaignIds = (options = {}) => {
  const rawIds = Array.isArray(options.campaignIds)
    ? options.campaignIds
    : options.campaignIds
      ? [options.campaignIds]
      : options.campaignId
        ? [options.campaignId]
        : [];
  const cleanedIds = rawIds
    .map((id) => String(id).replace(/-/g, '').trim())
    .filter(Boolean);
  const invalidIds = cleanedIds.filter((id) => !/^\d+$/.test(id));

  if (invalidIds.length > 0) {
    throw new Error('campaignIds must be numeric Google Ads campaign IDs.');
  }

  return [...new Set(cleanedIds)];
};

const buildCampaignFilter = (campaignIds) => {
  if (campaignIds.length === 0) return '';
  if (campaignIds.length === 1) return `AND campaign.id = ${campaignIds[0]}`;
  return `AND campaign.id IN (${campaignIds.join(', ')})`;
};

export const buildGoogleLowPerformerId = ({
  customerId,
  campaignId,
  adGroupId,
  assetGroupId,
  adId,
  assetResourceName,
  assetUrl,
}) =>
  `replacement_${crypto
    .createHash('sha1')
    .update(
      [
        String(customerId || '').replace(/-/g, ''),
        campaignId,
        adGroupId,
        assetGroupId,
        adId,
        assetResourceName,
        assetUrl,
      ]
        .filter(Boolean)
        .join('|'),
    )
    .digest('hex')
    .slice(0, 16)}`;

const buildMetrics = (row) => {
  const impressions = Number(row.metrics?.impressions ?? 0);
  const clicks = Number(row.metrics?.clicks ?? 0);
  const conversions = Number(row.metrics?.conversions ?? 0);
  const cost = microsToCurrency(row.metrics?.cost_micros);
  const ctr = Number.isFinite(Number(row.metrics?.ctr))
    ? Number(row.metrics.ctr)
    : impressions > 0
      ? clicks / impressions
      : 0;
  const conversionRate = Number.isFinite(Number(row.metrics?.conversions_from_interactions_rate))
    ? Number(row.metrics.conversions_from_interactions_rate)
    : clicks > 0
      ? conversions / clicks
      : 0;

  return { impressions, clicks, conversions, cost, ctr, conversionRate };
};

const buildLowPerformerEntry = (row, customerId, performanceLabel) => {
  const adId = String(row.ad_group_ad?.ad?.id ?? '');
  const adGroupId = String(row.ad_group?.id ?? '');
  const adType = normalizeGoogleAdType(row.ad_group_ad?.ad?.type);
  const assetFieldType = getAssetFieldType(row.ad_group_ad_asset_view);
  const assetResourceName =
    row.asset?.resource_name ||
    row.ad_group_ad_asset_view?.asset ||
    '';
  const assetId = String(row.asset?.id ?? '');
  const campaignId = String(row.campaign?.id ?? '');
  const assetUrl = row.asset?.image_asset?.full_size?.url || '';
  const resolution = buildImageResolution(row.asset);
  const hasReplacementTarget = Boolean(adId && adGroupId);
  const supportedReplacement = Boolean(
    hasReplacementTarget &&
    SUPPORTED_AD_GROUP_AD_REPLACEMENT_TYPES.has(adType)
  );

  return {
    id: buildGoogleLowPerformerId({
      customerId,
      campaignId,
      adGroupId,
      adId,
      assetResourceName,
      assetUrl,
    }),
    customerId: customerId.replace(/-/g, ''),
    campaignId,
    campaignName: row.campaign?.name || 'Unknown Campaign',
    adGroupId,
    adGroupName: row.ad_group?.name || 'Unknown Ad Group',
    assetGroupId: '',
    assetGroupName: '',
    adId,
    adType,
    adResourceName: row.ad_group_ad?.resource_name || '',
    assetId,
    assetResourceName,
    assetName: row.asset?.name || '',
    assetUrl,
    ...resolution,
    targetType: 'AD_GROUP_AD',
    associationResourceName: row.ad_group_ad?.resource_name || '',
    assetFieldType,
    googleAdsUrl: buildGoogleAdsAssetUrl({
      customerId,
      campaignId,
      adGroupId,
      assetId,
    }),
    targetName: [row.campaign?.name, row.ad_group?.name].filter(Boolean).join(' | '),
    metrics: buildMetrics(row),
    performanceLabel,
    reason: 'GOOGLE_PERFORMANCE_LABEL_LOW',
    supportedReplacement,
    replacementSupportReason:
      supportedReplacement
        ? null
        : 'UNSUPPORTED_TARGET',
    replacementSupportMessage: null,
    replacementStrategy: getAdGroupAdReplacementStrategy(adType),
  };
};

const buildAssetGroupLowPerformerEntry = (row, customerId, performanceLabel) => {
  const assetResourceName = row.asset?.resource_name || row.asset_group_asset?.asset || '';
  const assetId = String(row.asset?.id ?? '');
  const campaignId = String(row.campaign?.id ?? '');
  const assetGroupId = String(row.asset_group?.id ?? '');
  const assetFieldType = normalizeGoogleAssetFieldType(row.asset_group_asset?.field_type);
  const assetUrl = row.asset?.image_asset?.full_size?.url || '';
  const resolution = buildImageResolution(row.asset);

  return {
    id: buildGoogleLowPerformerId({
      customerId,
      campaignId,
      assetGroupId,
      assetResourceName,
      assetUrl,
    }),
    customerId: customerId.replace(/-/g, ''),
    campaignId,
    campaignName: row.campaign?.name || 'Unknown Campaign',
    adGroupId: '',
    adGroupName: '',
    assetGroupId,
    assetGroupName: row.asset_group?.name || 'Unknown Asset Group',
    adId: '',
    adType: 'ASSET_GROUP_ASSET',
    adResourceName: '',
    assetId,
    assetResourceName,
    assetName: row.asset?.name || '',
    assetUrl,
    ...resolution,
    targetType: 'ASSET_GROUP_ASSET',
    associationResourceName: row.asset_group_asset?.resource_name || '',
    assetFieldType,
    googleAdsUrl: buildGoogleAdsAssetUrl({
      customerId,
      campaignId,
      assetGroupId,
      assetId,
    }),
    targetName: [row.campaign?.name, row.asset_group?.name].filter(Boolean).join(' | '),
    metrics: buildMetrics(row),
    performanceLabel,
    reason: 'GOOGLE_PERFORMANCE_LABEL_LOW',
    supportedReplacement: Boolean(assetGroupId && assetResourceName && row.asset_group_asset?.resource_name),
    replacementSupportReason:
      assetGroupId && assetResourceName && row.asset_group_asset?.resource_name
        ? null
        : 'UNSUPPORTED_TARGET',
    replacementStrategy: 'ASSET_GROUP_ASSET_ASSOCIATION',
  };
};

/**
 * Fetch image assets that Google itself labels as LOW performance.
 * Only returns targets that the current replacement executor can safely apply.
 */
export const getLowPerformingImageAssets = async (customerId, options = {}) => {
  const customer = getClient(customerId);
  const config = getCreativeLibraryConfig();
  const limit = Math.max(1, Math.min(Number(options.limit || 100), 500));
  const queryLimit = Math.max(limit, Math.min(Math.max(limit * 5, 100), 500));
  const campaignIds = normalizeCampaignIds(options);
  const campaignFilter = buildCampaignFilter(campaignIds);
  const allTimeDateFilter = getAllTimePerformanceDateFilter();
  const lowLabel = String(config.googleLowPerformanceLabel || 'LOW').toUpperCase();

  const adGroupAdResults = await customer.query(`
    SELECT
      campaign.id,
      campaign.name,
      ad_group.id,
      ad_group.name,
      ad_group_ad.resource_name,
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      ad_group_ad.ad.type,
      ad_group_ad_asset_view.asset,
      ad_group_ad_asset_view.field_type,
      ad_group_ad_asset_view.performance_label,
      asset.id,
      asset.name,
      asset.resource_name,
      asset.image_asset.full_size.width_pixels,
      asset.image_asset.full_size.height_pixels,
      asset.image_asset.full_size.url,
      metrics.impressions,
      metrics.clicks,
      metrics.ctr,
      metrics.conversions,
      metrics.conversions_from_interactions_rate,
      metrics.cost_micros
    FROM ad_group_ad_asset_view
    WHERE campaign.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND ad_group_ad.status = 'ENABLED'
      AND ad_group_ad.ad.type IN ('IMAGE_AD', 'APP_AD', 'APP_ENGAGEMENT_AD')
      AND asset.type = 'IMAGE'
      AND ad_group_ad_asset_view.enabled = TRUE
      AND ad_group_ad_asset_view.performance_label = '${lowLabel}'
      ${allTimeDateFilter}
      ${campaignFilter}
    ORDER BY ad_group_ad_asset_view.performance_label ASC, metrics.impressions DESC
    LIMIT ${queryLimit}
  `);

  const lowPerformers = [];
  const seenKeys = new Set();
  for (const row of adGroupAdResults) {
    const performanceLabel = row.ad_group_ad_asset_view?.performance_label;
    if (!isGoogleLowPerformanceLabel(performanceLabel, lowLabel)) continue;
    if (!isImageAssetFieldType(getAssetFieldType(row.ad_group_ad_asset_view))) continue;

    const key = [
      row.ad_group_ad?.resource_name,
      row.asset?.resource_name || row.ad_group_ad_asset_view?.asset,
      getAssetFieldType(row.ad_group_ad_asset_view),
    ].filter(Boolean).join('|');
    if (key && seenKeys.has(key)) continue;
    if (key) seenKeys.add(key);
    const entry = {
      ...buildLowPerformerEntry(row, customerId, performanceLabel),
      performanceLabel: normalizeGooglePerformanceLabel(performanceLabel),
    };
    if (!entry.supportedReplacement) continue;
    lowPerformers.push(entry);
  }

  try {
    const assetGroupResults = await customer.query(`
      SELECT
        campaign.id,
        campaign.name,
        asset_group.id,
        asset_group.name,
        asset_group_asset.resource_name,
        asset_group_asset.asset,
        asset_group_asset.field_type,
        asset_group_asset.performance_label,
        asset_group_asset.status,
        asset.id,
        asset.name,
        asset.resource_name,
        asset.image_asset.full_size.width_pixels,
        asset.image_asset.full_size.height_pixels,
        asset.image_asset.full_size.url,
        metrics.impressions,
        metrics.clicks,
        metrics.ctr,
        metrics.conversions,
        metrics.conversions_from_interactions_rate,
        metrics.cost_micros
      FROM asset_group_asset
      WHERE campaign.status = 'ENABLED'
        AND asset_group.status = 'ENABLED'
        AND asset_group_asset.status = 'ENABLED'
        AND asset.type = 'IMAGE'
        AND asset_group_asset.performance_label = '${lowLabel}'
        ${allTimeDateFilter}
        ${campaignFilter}
      ORDER BY asset_group_asset.performance_label ASC, metrics.impressions DESC
      LIMIT ${queryLimit}
    `);

    for (const row of assetGroupResults) {
      const performanceLabel = row.asset_group_asset?.performance_label;
      const assetFieldType = normalizeGoogleAssetFieldType(row.asset_group_asset?.field_type);
      if (!isGoogleLowPerformanceLabel(performanceLabel, lowLabel)) continue;
      if (!isImageAssetFieldType(assetFieldType)) continue;

      const key = [
        row.asset_group_asset?.resource_name,
        row.asset?.resource_name || row.asset_group_asset?.asset,
        assetFieldType,
      ].filter(Boolean).join('|');
      if (key && seenKeys.has(key)) continue;
      if (key) seenKeys.add(key);

      const entry = {
        ...buildAssetGroupLowPerformerEntry(row, customerId, performanceLabel),
        performanceLabel: normalizeGooglePerformanceLabel(performanceLabel),
      };
      if (!entry.supportedReplacement) continue;
      lowPerformers.push(entry);
    }
  } catch (error) {
    console.warn('[GOOGLE_ADS] Skipping asset_group_asset low performers', getGoogleAdsErrorDetails(error));
  }

  return lowPerformers.slice(0, limit);
};

/**
 * Fetch the 3 worst performing ads (lowest conversions, tie-break by highest CPA).
 * Handles image_ad, responsive_display_ad, and app/local ads via asset lookup.
 */
export const getWorstPerformers = async (customerId, campaignId, days = 30) => {
  const customer = getClient(customerId);
  const dateDuring = days === 30 ? 'LAST_30_DAYS' : days === 7 ? 'LAST_7_DAYS' : 'LAST_30_DAYS';

  // Step 1: Query ads with metrics — include all image-bearing ad types
  const results = await customer.query(`
    SELECT
      campaign.name,
      campaign.id,
      ad_group.name,
      ad_group.id,
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      ad_group_ad.ad.type,
      ad_group_ad.ad.image_ad.image_url,
      ad_group_ad.ad.responsive_display_ad.marketing_images,
      ad_group_ad.ad.app_ad.images,
      ad_group_ad.ad.local_ad.marketing_images,
      ad_group_ad.ad.demand_gen_multi_asset_ad.marketing_images,
      metrics.conversions,
      metrics.cost_per_conversion
    FROM ad_group_ad
    WHERE ad_group_ad.status = 'ENABLED'
      AND campaign.status = 'ENABLED'
      AND ad_group.status = 'ENABLED'
      AND campaign.id = ${campaignId}
      AND metrics.impressions > 0
      AND segments.date DURING ${dateDuring}
    ORDER BY metrics.conversions ASC, metrics.cost_per_conversion DESC
    LIMIT 100
  `);

  // Step 2: Separate ads with direct image URLs vs those needing asset lookup
  const adsWithImages = [];
  const assetResourceNames = new Set();
  const pendingAds = []; // ads that need asset lookup

  for (const row of results) {
    const directUrl = extractDirectImageUrl(row);

    if (directUrl) {
      adsWithImages.push(buildAdEntry(row, directUrl));
      if (adsWithImages.length >= 3) break;
      continue;
    }

    // Collect asset resource names for app/local ads
    const assetRefs = collectAssetRefs(row);
    if (assetRefs.length > 0 && pendingAds.length < 20) {
      pendingAds.push({ row, assetRefs });
      assetRefs.forEach((ref) => assetResourceNames.add(ref));
    }
  }

  // Step 3: If needed, resolve asset URLs via a batch query
  if (adsWithImages.length < 3 && assetResourceNames.size > 0) {
    const assetUrlMap = await resolveAssetUrls(customer, [...assetResourceNames]);

    for (const { row, assetRefs } of pendingAds) {
      if (adsWithImages.length >= 3) break;

      const imageUrl = assetRefs.map((ref) => assetUrlMap[ref]).find(Boolean);
      if (imageUrl) {
        adsWithImages.push(buildAdEntry(row, imageUrl));
      }
    }
  }

  return adsWithImages;
};

/**
 * Extract image URL directly from ad fields — only returns actual HTTP URLs.
 */
const extractDirectImageUrl = (row) => {
  const ad = row.ad_group_ad?.ad;
  if (!ad) return null;

  // image_ad.image_url is a real URL
  if (ad.image_ad?.image_url) return ad.image_ad.image_url;

  return null;
};

/**
 * Collect asset resource names from all ad types that use asset references.
 * Covers: responsive_display_ad, demand_gen_multi_asset_ad, app_ad, local_ad.
 */
const collectAssetRefs = (row) => {
  const ad = row.ad_group_ad?.ad;
  if (!ad) return [];

  const refs = [];
  const addAssets = (list) => {
    if (Array.isArray(list)) {
      list.forEach((img) => { if (img?.asset) refs.push(img.asset); });
    }
  };

  addAssets(ad.responsive_display_ad?.marketing_images);
  addAssets(ad.demand_gen_multi_asset_ad?.marketing_images);
  addAssets(ad.app_ad?.images);
  addAssets(ad.local_ad?.marketing_images);

  return refs;
};

/**
 * Batch-resolve asset resource names → image URLs.
 */
const resolveAssetUrls = async (customer, resourceNames) => {
  if (resourceNames.length === 0) return {};

  // Extract asset IDs from resource names like "customers/xxx/assets/yyy"
  const assetIds = resourceNames
    .map((rn) => rn.match(/\/assets\/(\d+)$/)?.[1])
    .filter(Boolean);

  if (assetIds.length === 0) return {};

  try {
    const assetResults = await customer.query(`
      SELECT asset.resource_name, asset.image_asset.full_size.url
      FROM asset
      WHERE asset.id IN (${assetIds.join(',')})
        AND asset.type = 'IMAGE'
    `);

    const map = {};
    for (const row of assetResults) {
      const rn = row.asset?.resource_name;
      const url = row.asset?.image_asset?.full_size?.url;
      if (rn && url) map[rn] = url;
    }
    return map;
  } catch {
    return {};
  }
};

const buildAdEntry = (row, imageUrl) => ({
  id: String(row.ad_group_ad?.ad?.id ?? ''),
  name: row.ad_group_ad?.ad?.name || `Ad ${row.ad_group_ad?.ad?.id}`,
  campaignName: row.campaign?.name || 'Unknown Campaign',
  adGroupName: row.ad_group?.name || 'Unknown Ad Group',
  adGroupId: String(row.ad_group?.id ?? ''),
  imageUrl,
  metrics: {
    conversions: Number(row.metrics?.conversions ?? 0),
    cpa: Number(row.metrics?.cost_per_conversion ?? 0),
  },
  platform: 'google',
});

const extractResourceNameFromMutateResponse = (response, resultKey, { preferLast = false } = {}) => {
  const directResult = response?.results?.find((result) => result?.resource_name)?.resource_name;
  if (directResult && !resultKey) return directResult;

  const operationResponses = [...(response?.mutate_operation_responses || response?.mutateOperationResponses || [])];
  if (preferLast) operationResponses.reverse();
  for (const operationResponse of operationResponses) {
    const result = operationResponse?.[resultKey] || operationResponse?.[resultKey?.replace(/_([a-z])/g, (_, letter) => letter.toUpperCase())];
    if (result?.resource_name) return result.resource_name;
    if (result?.resourceName) return result.resourceName;
  }

  if (resultKey) {
    const results = [...(response?.results || [])];
    if (preferLast) results.reverse();
    const result = results.find((item) => item?.[resultKey]);
    if (result?.[resultKey]?.resource_name) return result[resultKey].resource_name;
  }

  return directResult || '';
};

const buildTempAssetResourceName = (customerId) => `customers/${customerId}/assets/-1`;

const buildAdResourceName = (customerId, adId) => `customers/${customerId}/ads/${String(adId).replace(/-/g, '')}`;

const decodeImageDataUrl = (newImageDataUrl) => {
  const match = String(newImageDataUrl || '').match(/^data:[^;]+;base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL format.');
  return Buffer.from(match[1], 'base64');
};

const cloneAssetRefs = (assets) =>
  Array.isArray(assets)
    ? assets
      .map((asset) => ({ asset: asset?.asset }))
      .filter((asset) => asset.asset)
    : [];

const replaceAssetRef = (assets, oldAssetResourceName, newAssetResourceName) => {
  const seen = new Set();
  const replaced = { value: false };
  const oldAsset = String(oldAssetResourceName || '');
  const nextAssets = [];

  for (const asset of cloneAssetRefs(assets)) {
    if (asset.asset === oldAsset) {
      replaced.value = true;
      if (!seen.has(newAssetResourceName)) {
        nextAssets.push({ asset: newAssetResourceName });
        seen.add(newAssetResourceName);
      }
      continue;
    }

    if (!seen.has(asset.asset)) {
      nextAssets.push(asset);
      seen.add(asset.asset);
    }
  }

  return {
    replaced: replaced.value,
    assets: nextAssets,
  };
};

const fetchAdForReplacement = async (customer, adGroupId, adId) => {
  const rows = await customer.query(`
    SELECT
      ad_group_ad.resource_name,
      ad_group_ad.ad.id,
      ad_group_ad.ad.name,
      ad_group_ad.ad.type,
      ad_group_ad.ad.final_urls,
      ad_group_ad.ad.final_mobile_urls,
      ad_group_ad.ad.final_app_urls,
      ad_group_ad.ad.final_url_suffix,
      ad_group_ad.ad.tracking_url_template,
      ad_group_ad.ad.url_custom_parameters,
      ad_group_ad.ad.app_ad.app_deep_link,
      ad_group_ad.ad.app_ad.descriptions,
      ad_group_ad.ad.app_ad.headlines,
      ad_group_ad.ad.app_ad.html5_media_bundles,
      ad_group_ad.ad.app_ad.images,
      ad_group_ad.ad.app_ad.mandatory_ad_text,
      ad_group_ad.ad.app_ad.youtube_videos,
      ad_group_ad.ad.app_engagement_ad.descriptions,
      ad_group_ad.ad.app_engagement_ad.headlines,
      ad_group_ad.ad.app_engagement_ad.images,
      ad_group_ad.ad.app_engagement_ad.videos
    FROM ad_group_ad
    WHERE ad_group.id = ${String(adGroupId).replace(/-/g, '')}
      AND ad_group_ad.ad.id = ${String(adId).replace(/-/g, '')}
    LIMIT 1
  `);

  if (!rows[0]?.ad_group_ad?.ad) {
    throw new Error(`Google Ads ad ${adId} was not found in ad group ${adGroupId}.`);
  }

  return rows[0];
};

const buildReplacementTarget = (adGroupIdOrOperation, oldAdId) => {
  if (typeof adGroupIdOrOperation === 'object' && adGroupIdOrOperation !== null) {
    return adGroupIdOrOperation;
  }

  return {
    targetType: 'AD_GROUP_AD',
    replacementStrategy: getAdGroupAdReplacementStrategy('IMAGE_AD'),
    adType: 'IMAGE_AD',
    adGroupId: adGroupIdOrOperation,
    adId: oldAdId,
  };
};

export const buildAppAdCloneReplacementMutations = ({
  adType,
}) => {
  const normalizedAdType = normalizeGoogleAdType(adType);
  if (normalizedAdType === 'APP_AD') {
    throw new Error(APP_AD_MANUAL_REPLACEMENT_MESSAGE);
  }
  throw new Error(`Unsupported clone replacement ad type: ${normalizedAdType || 'UNKNOWN'}.`);
};

export const buildAppEngagementAdImageUpdateMutations = ({
  assetCreate,
  cleanCustomerId,
  target,
  existingAd,
  newAssetResourceName,
}) => {
  const adId = String(target?.adId || '').replace(/-/g, '');
  if (!adId) throw new Error('adId is required for App Engagement Ad image replacement.');
  if (!target?.oldAssetResourceName) {
    throw new Error('oldAssetResourceName is required for App Engagement Ad image replacement.');
  }

  const replacementImages = replaceAssetRef(
    existingAd?.app_engagement_ad?.images,
    target.oldAssetResourceName,
    newAssetResourceName,
  );
  if (!replacementImages.replaced) {
    throw new Error('Old image asset was not found in the App Engagement Ad image list.');
  }
  if (replacementImages.assets.length === 0) {
    throw new Error('App Engagement Ad must keep at least one image asset.');
  }

  return [
    assetCreate,
    {
      entity: 'ad',
      operation: 'update',
      resource: {
        resource_name: buildAdResourceName(cleanCustomerId, adId),
        app_engagement_ad: {
          images: replacementImages.assets,
        },
      },
    },
  ];
};

export const getAppEngagementAdImageAssetNames = (ad) =>
  cloneAssetRefs(ad?.app_engagement_ad?.images).map((image) => image.asset);

export const assertAppEngagementAdImageUpdate = ({ ad, expectedAssetResourceName }) => {
  const expectedAsset = String(expectedAssetResourceName || '').trim();
  if (!expectedAsset) {
    throw new Error('Google Ads response did not include the created image asset resource name.');
  }

  const imageAssets = getAppEngagementAdImageAssetNames(ad);
  if (!imageAssets.includes(expectedAsset)) {
    throw new Error(
      `Google Ads accepted the App Engagement Ad update but the ad does not reference the new image asset ${expectedAsset}.`
    );
  }

  return imageAssets;
};

const runAtomicReplacementMutations = async (customer, mutations) => {
  const response = await customer.mutateResources(mutations, { partial_failure: false });
  const adGroupAdHasReplacementCreate =
    mutations.some((mutation) => mutation.entity === 'ad_group_ad' && mutation.operation !== 'create') &&
    mutations.some((mutation) => mutation.entity === 'ad_group_ad' && mutation.operation === 'create');
  return {
    response,
    assetResourceName: extractResourceNameFromMutateResponse(response, 'asset_result'),
    updatedAdResourceName: extractResourceNameFromMutateResponse(response, 'ad_result'),
    newAdResourceName: extractResourceNameFromMutateResponse(response, 'ad_group_ad_result', {
      preferLast: adGroupAdHasReplacementCreate,
    }),
    newAssociationResourceName:
      extractResourceNameFromMutateResponse(response, 'asset_group_asset_result') ||
      extractResourceNameFromMutateResponse(response, 'ad_group_asset_result') ||
      extractResourceNameFromMutateResponse(response, 'campaign_asset_result'),
  };
};

const getGoogleAdsErrorDetails = (error) => ({
  name: error?.name || null,
  message: error?.message || String(error),
  code: error?.code || null,
  status: error?.status || error?.response?.status || null,
  details: error?.details || null,
  errors: error?.errors || error?.failure?.errors || error?.response?.data?.errors || null,
  response: error?.response?.data || null,
});

const pushGoogleAdsTrace = (trace, step, status, details = {}) => {
  const entry = {
    timestamp: new Date().toISOString(),
    step,
    status,
    ...details,
  };
  trace.push(entry);
  return entry;
};

const throwWithGoogleAdsTrace = (error, trace) => {
  error.googleAdsTrace = trace;
  throw error;
};

const runTracedAtomicReplacementMutations = async (customer, mutations, trace, step) => {
  try {
    pushGoogleAdsTrace(trace, step, 'started', {
      mutationEntities: mutations.map((mutation) => `${mutation.entity}:${mutation.operation}`),
    });
    const replacement = await runAtomicReplacementMutations(customer, mutations);
    pushGoogleAdsTrace(trace, step, 'success', {
      assetResourceName: replacement.assetResourceName || null,
      updatedAdResourceName: replacement.updatedAdResourceName || null,
      newAdResourceName: replacement.newAdResourceName || null,
      newAssociationResourceName: replacement.newAssociationResourceName || null,
    });
    return replacement;
  } catch (error) {
    pushGoogleAdsTrace(trace, step, 'error', getGoogleAdsErrorDetails(error));
    throwWithGoogleAdsTrace(error, trace);
  }
};

/**
 * Replace an ad's creative:
 * 1. Create a new immutable image Asset.
 * 2. Update the target association/ad when Google allows it.
 * 3. For immutable app install ads, clone the whole ad with one image swapped and remove the old ad.
 * 4. For app engagement ads, update the existing ad image list to preserve the ad id.
 */
export const replaceAdCreative = async (customerId, adGroupIdOrOperation, oldAdId, newImageDataUrl) => {
  const googleAdsTrace = [];
  const cleanCustomerId = customerId.replace(/-/g, '');
  const target = buildReplacementTarget(adGroupIdOrOperation, oldAdId);
  const imageDataUrl = typeof adGroupIdOrOperation === 'object' ? oldAdId : newImageDataUrl;
  const targetType = String(target.targetType || '').toUpperCase();
  const adType = normalizeGoogleAdType(target.adType);

  const imageData = decodeImageDataUrl(imageDataUrl);
  pushGoogleAdsTrace(googleAdsTrace, 'validate_input', 'success', {
    customerId: cleanCustomerId,
    targetType: targetType || null,
    adGroupId: target.adGroupId || null,
    adId: target.adId || null,
    adType: adType || null,
    imageBytes: imageData.length,
  });

  if (adType === 'APP_AD') {
    throwWithGoogleAdsTrace(new Error(APP_AD_MANUAL_REPLACEMENT_MESSAGE), googleAdsTrace);
  }

  const customer = getClient(customerId);
  const tempAssetResourceName = buildTempAssetResourceName(cleanCustomerId);
  const assetCreate = {
    entity: 'asset',
    operation: 'create',
    resource: {
      resource_name: tempAssetResourceName,
      name: `Creative Library asset ${Date.now()}`,
      type: 'IMAGE',
      image_asset: { data: imageData },
    },
  };

  if (targetType === 'ASSET_GROUP_ASSET') {
    if (!target.assetGroupId) throwWithGoogleAdsTrace(new Error('assetGroupId is required for asset group replacements.'), googleAdsTrace);
    if (!target.assetFieldType) throwWithGoogleAdsTrace(new Error('assetFieldType is required for asset group replacements.'), googleAdsTrace);
    if (!target.associationResourceName) throwWithGoogleAdsTrace(new Error('associationResourceName is required to remove the old asset group association.'), googleAdsTrace);

    const replacement = await runTracedAtomicReplacementMutations(customer, [
      assetCreate,
      {
        entity: 'asset_group_asset',
        operation: 'create',
        resource: {
          asset_group: `customers/${cleanCustomerId}/assetGroups/${target.assetGroupId}`,
          asset: tempAssetResourceName,
          field_type: normalizeGoogleAssetFieldType(target.assetFieldType),
        },
      },
      {
        entity: 'asset_group_asset',
        operation: 'remove',
        resource: target.associationResourceName,
      },
    ], googleAdsTrace, 'upload_asset_and_replace_asset_group_asset');

    return {
      success: true,
      replacementType: 'ASSET_GROUP_ASSET',
      assetResourceName: replacement.assetResourceName,
      newAssociationResourceName: replacement.newAssociationResourceName,
      oldAssociationRemoved: true,
      googleAdsTrace,
    };
  }

  if (targetType !== 'AD_GROUP_AD') {
    throwWithGoogleAdsTrace(new Error(`Unsupported replacement target: ${target.targetType || 'UNKNOWN_TARGET'}.`), googleAdsTrace);
  }

  if (!target.adGroupId || !target.adId) {
    throwWithGoogleAdsTrace(new Error('adGroupId and adId are required for ad replacements.'), googleAdsTrace);
  }

  const oldAdResourceName = target.adResourceName || `customers/${cleanCustomerId}/adGroupAds/${target.adGroupId}~${target.adId}`;

  if (adType === 'IMAGE_AD') {
    const updatedAd = {
      image_ad: {
        image_asset: { asset: tempAssetResourceName },
      },
    };

    const replacement = await runTracedAtomicReplacementMutations(customer, [
      assetCreate,
      {
        entity: 'ad_group_ad',
        operation: 'update',
        resource: {
          resource_name: oldAdResourceName,
          ad: updatedAd,
        },
      },
    ], googleAdsTrace, 'upload_asset_and_update_image_ad');

    return {
      success: true,
      replacementType: getAdGroupAdReplacementStrategy(adType),
      assetResourceName: replacement.assetResourceName,
      updatedAdResourceName: replacement.newAdResourceName || oldAdResourceName,
      oldAdUpdated: true,
      googleAdsTrace,
    };
  }

  if (adType === 'APP_ENGAGEMENT_AD') {
    if (!target.oldAssetResourceName) {
      throwWithGoogleAdsTrace(new Error('oldAssetResourceName is required for App Engagement Ad image replacement.'), googleAdsTrace);
    }
    let existingAdRow;
    try {
      pushGoogleAdsTrace(googleAdsTrace, 'fetch_existing_ad_for_image_list_update', 'started', {
        adGroupId: target.adGroupId,
        adId: target.adId,
      });
      existingAdRow = await fetchAdForReplacement(customer, target.adGroupId, target.adId);
      pushGoogleAdsTrace(googleAdsTrace, 'fetch_existing_ad_for_image_list_update', 'success');
    } catch (error) {
      pushGoogleAdsTrace(googleAdsTrace, 'fetch_existing_ad_for_image_list_update', 'error', getGoogleAdsErrorDetails(error));
      throwWithGoogleAdsTrace(error, googleAdsTrace);
    }

    const appEngagementReplacementMutations = buildAppEngagementAdImageUpdateMutations({
      assetCreate,
      cleanCustomerId,
      target,
      existingAd: existingAdRow.ad_group_ad.ad,
      newAssetResourceName: tempAssetResourceName,
    });
    const replacement = await runTracedAtomicReplacementMutations(
      customer,
      appEngagementReplacementMutations,
      googleAdsTrace,
      'upload_asset_and_update_app_engagement_ad',
    );
    let verifiedImageAssets = [];
    try {
      pushGoogleAdsTrace(googleAdsTrace, 'verify_app_engagement_ad_image_update', 'started', {
        adGroupId: target.adGroupId,
        adId: target.adId,
        assetResourceName: replacement.assetResourceName || null,
      });
      const verifiedAdRow = await fetchAdForReplacement(customer, target.adGroupId, target.adId);
      verifiedImageAssets = assertAppEngagementAdImageUpdate({
        ad: verifiedAdRow.ad_group_ad.ad,
        expectedAssetResourceName: replacement.assetResourceName,
      });
      pushGoogleAdsTrace(googleAdsTrace, 'verify_app_engagement_ad_image_update', 'success', {
        assetResourceName: replacement.assetResourceName,
        imageAssets: verifiedImageAssets,
      });
    } catch (error) {
      pushGoogleAdsTrace(googleAdsTrace, 'verify_app_engagement_ad_image_update', 'error', getGoogleAdsErrorDetails(error));
      throwWithGoogleAdsTrace(error, googleAdsTrace);
    }

    return {
      success: true,
      replacementType: getAdGroupAdReplacementStrategy(adType),
      assetResourceName: replacement.assetResourceName,
      updatedAdResourceName: replacement.updatedAdResourceName || buildAdResourceName(cleanCustomerId, target.adId),
      oldAdResourceName,
      oldAdUpdated: true,
      updatedAssetCount: verifiedImageAssets.length,
      verifiedImageAssets,
      googleAdsTrace,
    };
  }

  throwWithGoogleAdsTrace(new Error(`Unsupported ad type for replacement: ${adType || 'UNKNOWN_AD_TYPE'}.`), googleAdsTrace);
};
