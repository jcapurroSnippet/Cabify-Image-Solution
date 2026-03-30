import { GoogleAdsApi } from 'google-ads-api';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const oauthTokenPath = path.join(__dirname, '../../.oauth-token.json');

const getOAuthTokens = () => {
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
    const clean = idPart.replace(/-/g, '');
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
  if (!tokens?.refresh_token && !process.env.GOOGLE_ADS_REFRESH_TOKEN) {
    throw new Error('Missing OAuth refresh token. Set up OAuth or set GOOGLE_ADS_REFRESH_TOKEN.');
  }

  const client = new GoogleAdsApi({
    client_id: clientId || '',
    client_secret: clientSecret || '',
    developer_token: developerToken,
  });

  return client.Customer({
    customer_id: customerId.replace(/-/g, ''),
    refresh_token: tokens?.refresh_token || process.env.GOOGLE_ADS_REFRESH_TOKEN,
    login_customer_id: process.env.GOOGLE_ADS_LOGIN_CUSTOMER_ID?.replace(/-/g, ''),
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

/**
 * Replace an ad's creative:
 * 1. Upload new image as an asset
 * 2. Create a new ad in the same ad group
 * 3. Pause the old ad
 */
export const replaceAdCreative = async (customerId, adGroupId, oldAdId, newImageDataUrl) => {
  const customer = getClient(customerId);
  const cleanCustomerId = customerId.replace(/-/g, '');

  const match = newImageDataUrl.match(/^data:[^;]+;base64,(.+)$/);
  if (!match) throw new Error('Invalid image data URL format.');
  const imageData = Buffer.from(match[1], 'base64');

  // 1. Create image asset
  const assetResult = await customer.mutateAsync([{
    entity: 'asset',
    operation: 'create',
    resource: {
      name: `Optimized creative ${Date.now()}`,
      type: 'IMAGE',
      image_asset: { data: imageData },
    },
  }]);

  const assetResourceName = assetResult?.results?.[0]?.resource_name;
  if (!assetResourceName) throw new Error('Failed to create image asset in Google Ads.');

  // 2. Create new ad
  const adResult = await customer.mutateAsync([{
    entity: 'ad_group_ad',
    operation: 'create',
    resource: {
      ad_group: `customers/${cleanCustomerId}/adGroups/${adGroupId}`,
      ad: { image_ad: { image_asset: assetResourceName } },
      status: 'ENABLED',
    },
  }]);

  const newAdResourceName = adResult?.results?.[0]?.resource_name;

  // 3. Pause old ad
  await customer.mutateAsync([{
    entity: 'ad_group_ad',
    operation: 'update',
    resource: {
      resource_name: `customers/${cleanCustomerId}/adGroupAds/${adGroupId}~${oldAdId}`,
      status: 'PAUSED',
    },
    update_mask: { paths: ['status'] },
  }]);

  return { success: true, newAdResourceName, oldAdPaused: true };
};
