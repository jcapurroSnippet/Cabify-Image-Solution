import crypto from 'node:crypto';
import { getCreativeLibraryConfig } from './creativeLibraryConfig.js';
import {
  detectCategoryFromName,
  normalizeCategory,
  selectCreativeForCategory,
} from './creativeLibraryCore.js';
import {
  appendAuditLog,
  getSpreadsheetIdFromLibraryInput,
  getCreativeLibrarySheetConfig,
  listCreativeLibrary,
  markCreativeUsed,
  releaseCreativeReservation,
  reserveCreative,
} from './creativeLibraryService.js';
import {
  getLowPerformingImageAssets,
  replaceAdCreative,
} from './googleAdsService.js';
import { downloadImageAsDataUrl } from './batchProcessor.js';

const buildOperationId = (parts) =>
  `replacement_${crypto
    .createHash('sha1')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex')
    .slice(0, 16)}`;

const buildTargetCategoryName = (asset) =>
  [asset.assetGroupName, asset.adGroupName, asset.campaignName, asset.assetName]
    .filter(Boolean)
    .join(' | ');

const normalizeCampaignIds = ({ campaignId, campaignIds } = {}) => {
  const rawIds = Array.isArray(campaignIds)
    ? campaignIds
    : campaignIds
      ? [campaignIds]
      : campaignId
        ? [campaignId]
        : [];

  return [...new Set(rawIds.map((id) => String(id).trim()).filter(Boolean))];
};

const normalizeLowPerformerCategories = (value, config) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return new Map();

  const entries = Object.entries(value)
    .map(([id, category]) => [String(id), normalizeCategory(category, config.categories)])
    .filter(([id, category]) => id && category);

  return new Map(entries);
};

const buildCategoryMatch = (asset, config, lowPerformerCategories = new Map()) => {
  const overrideCategory = lowPerformerCategories.get(String(asset.id));
  if (overrideCategory) {
    return {
      category: overrideCategory,
      matched: [overrideCategory],
      warning: null,
      source: 'manual',
    };
  }

  const match = detectCategoryFromName(buildTargetCategoryName(asset), config);
  return {
    ...match,
    source: match.category ? 'automatic' : 'none',
  };
};

const getConfigForReplacement = async (sheetsUrl) => {
  if (!sheetsUrl) return getCreativeLibraryConfig();
  return (await getCreativeLibrarySheetConfig({ sheetsUrl })).config;
};

export const getGoogleLowPerformers = async ({ accountId, campaignId, campaignIds, limit, sheetsUrl }) => {
  if (!accountId) throw new Error('accountId is required.');
  const config = await getConfigForReplacement(sheetsUrl);
  const assets = await getLowPerformingImageAssets(accountId, {
    campaignIds: normalizeCampaignIds({ campaignId, campaignIds }),
    limit,
  });

  return assets.map((asset) => {
    const categoryMatch = buildCategoryMatch(asset, config);
    return {
      ...asset,
      detectedCategory: categoryMatch.category,
      categorySource: categoryMatch.source,
      categoryWarning: categoryMatch.warning,
      matchedCategories: categoryMatch.matched,
    };
  });
};

export const buildGoogleReplacementPlan = async ({
  sheetsUrl,
  accountId,
  campaignId,
  campaignIds,
  limit = 20,
  selectedLowPerformerIds,
  lowPerformerCategories,
}) => {
  if (!sheetsUrl) throw new Error('sheetsUrl is required.');
  if (!accountId) throw new Error('accountId is required.');

  const config = await getConfigForReplacement(sheetsUrl);
  const selectedCampaignIds = normalizeCampaignIds({ campaignId, campaignIds });
  const selectedCategories = normalizeLowPerformerCategories(lowPerformerCategories, config);
  const library = await listCreativeLibrary({ sheetsUrl });
  const selectedLowIds = Array.isArray(selectedLowPerformerIds)
    ? new Set(selectedLowPerformerIds.map((id) => String(id)))
    : null;
  const lowPerformers = await getLowPerformersWithLimit({
    accountId,
    campaignIds: selectedCampaignIds,
    sheetsUrl,
    limit,
    selectedLowPerformerIds: selectedLowIds,
  });
  const reservedCreativeIds = new Set();
  const operations = [];

  for (const asset of lowPerformers) {
    const categoryMatch = buildCategoryMatch(asset, config, selectedCategories);
    const baseOperation = {
      id: '',
      status: 'skipped',
      customerId: accountId.replace(/-/g, ''),
      campaignId: asset.campaignId,
      campaignName: asset.campaignName,
      adGroupId: asset.adGroupId,
      adGroupName: asset.adGroupName,
      assetGroupId: asset.assetGroupId,
      assetGroupName: asset.assetGroupName,
      adId: asset.adId,
      adType: asset.adType,
      adResourceName: asset.adResourceName,
      targetType: asset.targetType,
      associationResourceName: asset.associationResourceName,
      assetFieldType: asset.assetFieldType,
      replacementStrategy: asset.replacementStrategy,
      oldAssetId: asset.assetId,
      oldAssetResourceName: asset.assetResourceName,
      oldAssetUrl: asset.assetUrl,
      oldImageResolution: asset.imageResolution || '',
      googleAdsUrl: asset.googleAdsUrl || '',
      reason: asset.reason,
      metrics: asset.metrics,
      detectedCategory: categoryMatch.category,
      categorySource: categoryMatch.source,
      categoryWarning: categoryMatch.warning,
      matchedCategories: categoryMatch.matched,
      supportedReplacement: asset.supportedReplacement,
      supportReason: asset.replacementSupportReason,
      creative: null,
      message: '',
    };
    baseOperation.id = asset.id || buildOperationId([
      accountId.replace(/-/g, ''),
      asset.campaignId,
      asset.adGroupId,
      asset.assetGroupId,
      asset.adId,
      asset.assetResourceName,
      asset.assetUrl,
    ]);

    if (!categoryMatch.category) {
      operations.push({ ...baseOperation, message: 'CATEGORY_NOT_FOUND' });
      continue;
    }

    const creative = selectCreativeForCategory(
      library.creatives,
      categoryMatch.category,
      config.selectionStrategy,
      reservedCreativeIds,
    );

    if (!creative) {
      operations.push({ ...baseOperation, message: 'NO_AVAILABLE_CREATIVE' });
      continue;
    }

    reservedCreativeIds.add(creative.creative_id);
    operations.push({
      ...baseOperation,
      status: 'planned',
      creative: {
        creative_id: creative.creative_id,
        category: creative.category,
        drive_url: creative.drive_url,
        created_at: creative.created_at,
      },
      message: asset.supportedReplacement ? 'READY' : 'UNSUPPORTED_TARGET',
    });
  }

  return {
    dryRun: true,
    accountId,
    campaignId: selectedCampaignIds.length === 1 ? selectedCampaignIds[0] : '',
    campaignIds: selectedCampaignIds,
    limit,
    summary: {
      lowPerformers: lowPerformers.length,
      planned: operations.filter((operation) => operation.status === 'planned').length,
      executable: operations.filter((operation) => operation.status === 'planned' && operation.supportedReplacement).length,
      skipped: operations.filter((operation) => operation.status === 'skipped').length,
    },
    operations,
    librarySummary: library.summary,
  };
};

const getLowPerformersWithLimit = async ({
  accountId,
  campaignIds,
  sheetsUrl,
  limit,
  selectedLowPerformerIds,
}) => {
  const maxResults = Math.max(1, Number(limit || 20));
  const assets = await getGoogleLowPerformers({
    accountId,
    campaignIds,
    sheetsUrl,
    limit: Math.max(maxResults * 4, 50),
  });

  if (selectedLowPerformerIds?.size) {
    return assets.filter((asset) => selectedLowPerformerIds.has(String(asset.id))).slice(0, maxResults);
  }

  return assets.slice(0, maxResults);
};

export const executeGoogleReplacements = async ({
  sheetsUrl,
  accountId,
  campaignId,
  campaignIds,
  limit = 10,
  confirm,
  selectedOperationIds,
  selectedLowPerformerIds,
  lowPerformerCategories,
}) => {
  if (confirm !== true) {
    throw new Error('confirm must be true to execute replacements.');
  }

  const spreadsheetId = getSpreadsheetIdFromLibraryInput(sheetsUrl);
  const selectedIds = Array.isArray(selectedOperationIds)
    ? new Set(selectedOperationIds.map((id) => String(id)))
    : null;

  if (selectedIds && selectedIds.size === 0) {
    throw new Error('At least one replacement operation must be selected.');
  }

  const plan = await buildGoogleReplacementPlan({
    sheetsUrl,
    accountId,
    campaignId,
    campaignIds,
    limit,
    selectedLowPerformerIds,
    lowPerformerCategories,
  });
  const results = [];

  for (const operation of plan.operations) {
    if (selectedIds && !selectedIds.has(operation.id)) {
      results.push({ ...operation, executionStatus: 'skipped', executionMessage: 'NOT_SELECTED' });
      continue;
    }

    if (operation.status !== 'planned') {
      results.push({ ...operation, executionStatus: 'skipped', executionMessage: operation.message });
      continue;
    }

    if (!operation.supportedReplacement) {
      results.push({ ...operation, executionStatus: 'skipped', executionMessage: 'UNSUPPORTED_TARGET' });
      continue;
    }

    const creativeId = operation.creative?.creative_id;
    if (!creativeId) {
      results.push({ ...operation, executionStatus: 'skipped', executionMessage: 'NO_CREATIVE_SELECTED' });
      continue;
    }

    try {
      const reserved = await reserveCreative(spreadsheetId, creativeId, operation.id);
      const creativeUrl = reserved.drive_url || operation.creative.drive_url;
      const imageDataUrl = await downloadImageAsDataUrl(creativeUrl);
      const replacement = await replaceAdCreative(
        accountId,
        operation,
        imageDataUrl,
      );

      await markCreativeUsed(spreadsheetId, creativeId, {
        googleAdsAssetResourceName: replacement.assetResourceName || replacement.newAdResourceName || '',
        operationId: operation.id,
        notes: `Used for ${operation.campaignName} / ${operation.adGroupName}`,
      });

      await appendAuditLog(spreadsheetId, [
        {
          event: 'ASSET_REPLACED',
          creative_id: creativeId,
          category: reserved.category || operation.detectedCategory || '',
          customer_id: accountId.replace(/-/g, ''),
          campaign_id: operation.campaignId,
          ad_group_id: operation.adGroupId,
          asset_group_id: operation.assetGroupId || '',
          old_asset_resource_name: operation.oldAssetResourceName,
          new_asset_resource_name: replacement.assetResourceName || replacement.newAdResourceName || '',
          status: 'success',
          message: 'Replacement completed.',
          payload_json: { operation, replacement },
        },
      ]);

      results.push({
        ...operation,
        executionStatus: 'success',
        replacement,
      });
    } catch (error) {
      await releaseCreativeReservation(spreadsheetId, creativeId, error.message);
      await appendAuditLog(spreadsheetId, [
        {
          event: 'REPLACEMENT_FAILED',
          creative_id: creativeId,
          category: operation.detectedCategory || '',
          customer_id: accountId.replace(/-/g, ''),
          campaign_id: operation.campaignId,
          ad_group_id: operation.adGroupId,
          asset_group_id: operation.assetGroupId || '',
          old_asset_resource_name: operation.oldAssetResourceName,
          new_asset_resource_name: '',
          status: 'failed',
          message: error.message,
          payload_json: { operation },
        },
      ]);

      results.push({
        ...operation,
        executionStatus: 'failed',
        executionMessage: error.message,
      });
    }
  }

  return {
    dryRun: false,
    accountId,
    campaignId: plan.campaignIds?.length === 1 ? plan.campaignIds[0] : '',
    campaignIds: plan.campaignIds || normalizeCampaignIds({ campaignId, campaignIds }),
    summary: {
      attempted: results.filter((result) => result.executionStatus === 'success' || result.executionStatus === 'failed').length,
      success: results.filter((result) => result.executionStatus === 'success').length,
      failed: results.filter((result) => result.executionStatus === 'failed').length,
      skipped: results.filter((result) => result.executionStatus === 'skipped').length,
    },
    results,
  };
};
