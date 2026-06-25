import { getCreativeLibraryConfig } from './creativeLibraryConfig.js';
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
  detectCategoryFromName,
  detectPlazasFromName,
  normalizeCategory,
  selectCreativeForCategory,
} from './creativeLibraryCore.js';
import {
  getLowPerformingImageAssets,
  replaceAdCreativeFromOperation,
} from './metaAdsService.js';
import { downloadImageAsDataUrl } from './batchProcessor.js';
import {
  assertReplacementImageAspectRatio,
  formatResolution,
  getImageResolutionFromDataUrl,
  getRequiredAspectRatio,
} from './imageRatio.js';

export const buildMetaTargetCategoryName = (asset) => asset.adName || asset.assetName || '';
const buildTargetPlazasName = (asset) => asset.campaignName || '';

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

  const match = detectCategoryFromName(buildMetaTargetCategoryName(asset), config);
  return {
    ...match,
    source: match.category ? 'automatic' : 'none',
  };
};

const buildPlazasMatch = (asset, config) => detectPlazasFromName(buildTargetPlazasName(asset), config);

const getConfigForReplacement = async (sheetsUrl) => {
  if (!sheetsUrl) return getCreativeLibraryConfig();
  return (await getCreativeLibrarySheetConfig({ sheetsUrl })).config;
};

export const getMetaLowPerformers = async ({ accountId, campaignId, campaignIds, limit, sheetsUrl }) => {
  if (!accountId) throw new Error('accountId is required.');
  const config = await getConfigForReplacement(sheetsUrl);
  const assets = await getLowPerformingImageAssets(accountId, {
    campaignIds: normalizeCampaignIds({ campaignId, campaignIds }),
    limit,
  });

  return assets.map((asset) => {
    const categoryMatch = buildCategoryMatch(asset, config);
    const plazasMatch = buildPlazasMatch(asset, config);
    return {
      ...asset,
      detectedCategory: categoryMatch.category,
      categorySource: categoryMatch.source,
      categoryWarning: categoryMatch.warning,
      matchedCategories: categoryMatch.matched,
      detectedPlazas: plazasMatch.plazas || null,
    };
  });
};

const getLowPerformersWithLimit = async ({
  accountId,
  campaignIds,
  sheetsUrl,
  limit,
  selectedLowPerformerIds,
}) => {
  const maxResults = Math.max(1, Number(limit || 20));
  const assets = await getMetaLowPerformers({
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

export const buildMetaReplacementPlan = async ({
  sheetsUrl,
  accountId,
  campaignId,
  campaignIds,
  limit = 20,
  selectedLowPerformerIds,
  lowPerformerCategories,
  excludedCreativeIds = [],
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
  const reservedCreativeIds = new Set(excludedCreativeIds.map((id) => String(id)).filter(Boolean));
  const operations = [];

  for (const asset of lowPerformers) {
    const categoryMatch = buildCategoryMatch(asset, config, selectedCategories);
    const plazasMatch = buildPlazasMatch(asset, config);
    const requiredAspectRatio = getRequiredAspectRatio({
      oldImageResolution: asset.imageResolution || '',
      assetFieldType: asset.assetFieldType,
    });
    const supportedReplacement = asset.supportedReplacement !== false;
    const baseOperation = {
      id: asset.id,
      platform: 'meta',
      platformLabel: 'Meta Ads',
      status: 'skipped',
      accountId,
      customerId: accountId,
      campaignId: asset.campaignId,
      campaignName: asset.campaignName,
      adGroupId: asset.adGroupId,
      adGroupName: asset.adGroupName,
      assetGroupId: '',
      assetGroupName: '',
      adId: asset.adId,
      adName: asset.adName || '',
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
      requiredAspectRatio,
      adsUrl: asset.adsUrl || '',
      googleAdsUrl: '',
      reason: asset.reason,
      metrics: asset.metrics,
      detectedCategory: categoryMatch.category,
      detectedPlazas: plazasMatch.plazas || null,
      categorySource: categoryMatch.source,
      categoryWarning: categoryMatch.warning,
      matchedCategories: categoryMatch.matched,
      supportedReplacement,
      supportReason: asset.replacementSupportReason,
      supportMessage: asset.replacementSupportMessage,
      canPreserveAdId: supportedReplacement,
      canPreserveServingContainer: supportedReplacement,
      requiresNewAd: false,
      executableInMode: supportedReplacement,
      executionPolicy: supportedReplacement ? 'same_ad_update' : 'manual_only',
      blockedReason: supportedReplacement ? null : asset.replacementSupportReason || 'META_MANUAL_REVIEW',
      blockedMessage: supportedReplacement
        ? null
        : asset.replacementSupportMessage || 'Review this Meta creative before replacing it.',
      metaCreative: asset.metaCreative || null,
      creative: null,
      message: '',
    };

    if (!supportedReplacement) {
      operations.push({
        ...baseOperation,
        message: baseOperation.blockedMessage || baseOperation.blockedReason,
      });
      continue;
    }

    if (!categoryMatch.category) {
      operations.push({
        ...baseOperation,
        message: 'CATEGORY_NOT_FOUND',
      });
      continue;
    }

    const creative = selectCreativeForCategory(
      library.creatives,
      categoryMatch.category,
      config.selectionStrategy,
      reservedCreativeIds,
      plazasMatch.plazas,
      requiredAspectRatio,
      'meta',
    );

    if (!creative) {
      operations.push({
        ...baseOperation,
        message: requiredAspectRatio ? 'NO_AVAILABLE_CREATIVE_FOR_RATIO' : 'NO_AVAILABLE_CREATIVE',
        blockedMessage: requiredAspectRatio ? `No ${requiredAspectRatio} creative` : undefined,
      });
      continue;
    }

    reservedCreativeIds.add(creative.creative_id);
    operations.push({
      ...baseOperation,
      status: 'planned',
      creative: {
        creative_id: creative.creative_id,
        category: creative.category,
        plazas: creative.plazas || '',
        drive_url: creative.drive_url,
        aspect_ratio: creative.aspect_ratio || '',
        image_resolution: creative.image_resolution || '',
        created_at: creative.created_at,
      },
      message: 'READY',
    });
  }

  return {
    dryRun: true,
    source: 'meta',
    accountId,
    campaignId: selectedCampaignIds.length === 1 ? selectedCampaignIds[0] : '',
    campaignIds: selectedCampaignIds,
    limit,
    summary: {
      lowPerformers: lowPerformers.length,
      planned: operations.filter((operation) => operation.status === 'planned').length,
      executable: operations.filter((operation) => operation.status === 'planned' && operation.executableInMode).length,
      sameAdUpdates: operations.filter((operation) => operation.executionPolicy === 'same_ad_update').length,
      cloneReplacements: 0,
      manualOnly: operations.filter((operation) => operation.executionPolicy === 'manual_only').length,
      assetGroupReassociations: 0,
      skipped: operations.filter((operation) => operation.status === 'skipped').length,
    },
    operations,
    librarySummary: library.summary,
  };
};

const getExecutionErrorDetails = (error) => ({
  name: error?.name || null,
  message: error?.message || String(error),
  code: error?.code || null,
  status: error?.status || error?.response?.status || null,
  details: error?.details || null,
  errors: error?.errors || error?.response?.data?.errors || null,
  response: error?.response?.data || null,
  metaAdsTrace: error?.metaAdsTrace || [],
});

export const collectExecutionMetaAdsTrace = (results = []) =>
  results.flatMap((result) => [
    ...(result.metaAdsTrace || []),
    ...(result.executionError?.metaAdsTrace || []),
    ...(result.replacement?.metaAdsTrace || []),
  ]);

const logReplacementFailure = ({ operation, creativeId, executionError }) => {
  console.error('[META_REPLACEMENT] Replacement failed', {
    operationId: operation.id,
    creativeId,
    campaignName: operation.campaignName,
    adGroupName: operation.adGroupName,
    adId: operation.adId,
    message: executionError.message,
    code: executionError.code,
    status: executionError.status,
    errors: executionError.errors,
    details: executionError.details,
    response: executionError.response,
    metaAdsTrace: executionError.metaAdsTrace,
  });
};

export const executeMetaReplacements = async ({
  sheetsUrl,
  accountId,
  campaignId,
  campaignIds,
  limit = 10,
  confirm,
  selectedOperationIds,
  selectedLowPerformerIds,
  lowPerformerCategories,
  excludedCreativeIds = [],
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

  const plan = await buildMetaReplacementPlan({
    sheetsUrl,
    accountId,
    campaignId,
    campaignIds,
    limit,
    selectedLowPerformerIds,
    lowPerformerCategories,
    excludedCreativeIds,
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

    if (!operation.executableInMode) {
      results.push({
        ...operation,
        executionStatus: 'skipped',
        executionMessage: operation.blockedMessage || operation.blockedReason || operation.message || 'META_MANUAL_REVIEW',
      });
      continue;
    }

    const creativeId = operation.creative?.creative_id;
    if (!creativeId) {
      results.push({ ...operation, executionStatus: 'skipped', executionMessage: 'NO_CREATIVE_SELECTED' });
      continue;
    }

    try {
      const reserved = await reserveCreative(spreadsheetId, creativeId, operation.id, 'meta');
      const creativeUrl = reserved.drive_url || operation.creative.drive_url;
      const imageDataUrl = await downloadImageAsDataUrl(creativeUrl);
      const replacementImageResolution = await getImageResolutionFromDataUrl(imageDataUrl);
      const imageAspectRatioValidation = assertReplacementImageAspectRatio({
        expectedResolution: operation.oldImageResolution,
        expectedAspectRatio: operation.requiredAspectRatio,
        replacementResolution: replacementImageResolution,
        creativeId,
      });
      const replacement = await replaceAdCreativeFromOperation(
        accountId,
        operation,
        imageDataUrl,
      );
      const replacementResourceName = replacement.newCreativeId || replacement.assetResourceName || '';

      await markCreativeUsed(spreadsheetId, creativeId, {
        adsPlatform: 'meta',
        adsResourceName: replacementResourceName,
        operationId: operation.id,
        notes: `Used for ${operation.campaignName} / ${operation.adGroupName}`,
      });

      await appendAuditLog(spreadsheetId, [
        {
          event: 'ASSET_REPLACED',
          creative_id: creativeId,
          category: reserved.category || operation.detectedCategory || '',
          customer_id: accountId,
          campaign_id: operation.campaignId,
          ad_group_id: operation.adGroupId,
          asset_group_id: '',
          old_asset_resource_name: operation.oldAssetResourceName,
          new_asset_resource_name: replacementResourceName,
          status: 'success',
          message: 'Replacement completed.',
          payload_json: { platform: 'meta', operation, replacement, replacementImageResolution, imageAspectRatioValidation },
        },
      ]);

      results.push({
        ...operation,
        executionStatus: 'success',
        replacementImageResolution: formatResolution(replacementImageResolution),
        replacementAspectRatio: imageAspectRatioValidation?.replacementAspectRatio || null,
        replacement,
      });
    } catch (error) {
      const executionError = getExecutionErrorDetails(error);
      logReplacementFailure({ operation, creativeId, executionError });
      await releaseCreativeReservation(spreadsheetId, creativeId, error.message);
      await appendAuditLog(spreadsheetId, [
        {
          event: 'REPLACEMENT_FAILED',
          creative_id: creativeId,
          category: operation.detectedCategory || '',
          customer_id: accountId,
          campaign_id: operation.campaignId,
          ad_group_id: operation.adGroupId,
          asset_group_id: '',
          old_asset_resource_name: operation.oldAssetResourceName,
          new_asset_resource_name: '',
          status: 'failed',
          message: error.message,
          payload_json: { platform: 'meta', operation, executionError },
        },
      ]);

      results.push({
        ...operation,
        executionStatus: 'failed',
        executionMessage: error.message,
        executionError,
        metaAdsTrace: executionError.metaAdsTrace,
      });
    }
  }

  const summary = {
    attempted: results.filter((result) => result.executionStatus === 'success' || result.executionStatus === 'failed').length,
    success: results.filter((result) => result.executionStatus === 'success').length,
    failed: results.filter((result) => result.executionStatus === 'failed').length,
    skipped: results.filter((result) => result.executionStatus === 'skipped').length,
  };

  return {
    dryRun: false,
    source: 'meta',
    accountId,
    campaignId: plan.campaignIds?.length === 1 ? plan.campaignIds[0] : '',
    campaignIds: plan.campaignIds || normalizeCampaignIds({ campaignId, campaignIds }),
    summary,
    metaAdsTrace: collectExecutionMetaAdsTrace(results),
    results,
  };
};
