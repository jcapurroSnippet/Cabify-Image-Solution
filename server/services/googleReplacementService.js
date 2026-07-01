import crypto from 'node:crypto';
import { getCreativeLibraryConfig } from './creativeLibraryConfig.js';
import {
  detectCategoryFromName,
  detectPlazasFromName,
  describeGoogleReplacementCapability,
  getCreativeDriveUrl,
  normalizeGoogleReplacementMode,
  normalizeCategory,
  requiresNewAdCreationPermission,
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
import {
  assertReplacementImageAspectRatio,
  formatResolution,
  getImageResolutionFromDataUrl,
  getRequiredAspectRatio,
} from './imageRatio.js';

const buildOperationId = (parts) =>
  `replacement_${crypto
    .createHash('sha1')
    .update(parts.filter(Boolean).join('|'))
    .digest('hex')
    .slice(0, 16)}`;

const buildTargetCategoryName = (asset) =>
  [asset.adGroupName, asset.assetGroupName]
    .filter(Boolean)
    .join(' | ');

const buildTargetPlazasName = (asset) =>
  asset.campaignName || '';

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

const buildPlazasMatch = (asset, config) => detectPlazasFromName(buildTargetPlazasName(asset), config);

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
    const plazasMatch = buildPlazasMatch(asset, config);
    return {
      ...asset,
      platform: 'google',
      platformLabel: 'Google Ads',
      accountId,
      detectedCategory: categoryMatch.category,
      categorySource: categoryMatch.source,
      categoryWarning: categoryMatch.warning,
      matchedCategories: categoryMatch.matched,
      detectedPlazas: plazasMatch.plazas || null,
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
  replacementMode,
}) => {
  if (!sheetsUrl) throw new Error('sheetsUrl is required.');
  if (!accountId) throw new Error('accountId is required.');

  const effectiveReplacementMode = normalizeGoogleReplacementMode(replacementMode);
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
    const plazasMatch = buildPlazasMatch(asset, config);
    const requiredAspectRatio = getRequiredAspectRatio({
      oldImageResolution: asset.imageResolution || '',
      assetFieldType: asset.assetFieldType,
    });
    const baseOperation = {
      id: '',
      platform: 'google',
      platformLabel: 'Google Ads',
      accountId,
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
      requiredAspectRatio,
      googleAdsUrl: asset.googleAdsUrl || '',
      reason: asset.reason,
      metrics: asset.metrics,
      detectedCategory: categoryMatch.category,
      detectedPlazas: plazasMatch.plazas || null,
      categorySource: categoryMatch.source,
      categoryWarning: categoryMatch.warning,
      matchedCategories: categoryMatch.matched,
      supportedReplacement: asset.supportedReplacement,
      supportReason: asset.replacementSupportReason,
      supportMessage: asset.replacementSupportMessage,
      creative: null,
      message: '',
    };
    const replacementCapability = describeGoogleReplacementCapability(baseOperation, effectiveReplacementMode);
    baseOperation.id = asset.id || buildOperationId([
      accountId.replace(/-/g, ''),
      asset.campaignId,
      asset.adGroupId,
      asset.assetGroupId,
      asset.adId,
      asset.assetResourceName,
      asset.assetUrl,
    ]);

    if (replacementCapability.executionPolicy === 'manual_only') {
      operations.push({
        ...baseOperation,
        ...replacementCapability,
        message:
          replacementCapability.blockedMessage ||
          replacementCapability.blockedReason ||
          'UNSUPPORTED_TARGET',
      });
      continue;
    }

    if (!categoryMatch.category) {
      operations.push({
        ...baseOperation,
        ...replacementCapability,
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
      'google',
    );

    if (!creative) {
      operations.push({
        ...baseOperation,
        ...replacementCapability,
        message: requiredAspectRatio ? 'NO_AVAILABLE_CREATIVE_FOR_RATIO' : 'NO_AVAILABLE_CREATIVE',
        blockedMessage: requiredAspectRatio ? `No ${requiredAspectRatio} creative` : undefined,
      });
      continue;
    }

    reservedCreativeIds.add(creative.creative_id);
    operations.push({
      ...baseOperation,
      ...replacementCapability,
      status: 'planned',
      creative: {
        creative_id: creative.creative_id,
        category: creative.category,
        plazas: creative.plazas || '',
        drive_file_id: creative.drive_file_id || '',
        drive_url: getCreativeDriveUrl(creative) || creative.drive_url,
        aspect_ratio: creative.aspect_ratio || '',
        image_resolution: creative.image_resolution || '',
        created_at: creative.created_at,
      },
      message: replacementCapability.executableInMode
        ? 'READY'
        : replacementCapability.blockedMessage ||
          replacementCapability.blockedReason ||
          'UNSUPPORTED_TARGET',
    });
  }

  return {
    dryRun: true,
    replacementMode: effectiveReplacementMode,
    accountId,
    campaignId: selectedCampaignIds.length === 1 ? selectedCampaignIds[0] : '',
    campaignIds: selectedCampaignIds,
    limit,
    summary: {
      lowPerformers: lowPerformers.length,
      planned: operations.filter((operation) => operation.status === 'planned').length,
      executable: operations.filter((operation) => operation.status === 'planned' && operation.executableInMode).length,
      sameAdUpdates: operations.filter((operation) => operation.executionPolicy === 'same_ad_update').length,
      cloneReplacements: operations.filter((operation) => operation.executionPolicy === 'clone_replace').length,
      manualOnly: operations.filter((operation) => operation.executionPolicy === 'manual_only').length,
      assetGroupReassociations: operations.filter((operation) => operation.executionPolicy === 'asset_group_reassociation').length,
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

const getExecutionErrorDetails = (error) => ({
  name: error?.name || null,
  message: error?.message || String(error),
  code: error?.code || null,
  status: error?.status || error?.response?.status || null,
  details: error?.details || null,
  errors: error?.errors || error?.failure?.errors || error?.response?.data?.errors || null,
  response: error?.response?.data || null,
  googleAdsTrace: error?.googleAdsTrace || [],
  metaAdsTrace: error?.metaAdsTrace || [],
});

export const collectExecutionGoogleAdsTrace = (results = []) =>
  results.flatMap((result) => [
    ...(result.googleAdsTrace || []),
    ...(result.executionError?.googleAdsTrace || []),
    ...(result.replacement?.googleAdsTrace || []),
  ]);

const logReplacementFailure = ({ operation, creativeId, executionError }) => {
  console.error('[GOOGLE_REPLACEMENT] Replacement failed', {
    operationId: operation.id,
    creativeId,
    campaignName: operation.campaignName,
    adGroupName: operation.adGroupName,
    assetGroupName: operation.assetGroupName || null,
    targetType: operation.targetType || null,
    adType: operation.adType || null,
    assetFieldType: operation.assetFieldType || null,
    oldAssetResourceName: operation.oldAssetResourceName || null,
    associationResourceName: operation.associationResourceName || null,
    message: executionError.message,
    code: executionError.code,
    status: executionError.status,
    errors: executionError.errors,
    details: executionError.details,
    response: executionError.response,
    googleAdsTrace: executionError.googleAdsTrace,
  });
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
  replacementMode,
  allowNewAdCreation = false,
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
    replacementMode,
  });
  const needsNewAdCreationPermission = requiresNewAdCreationPermission(plan.operations, selectedIds);
  if (needsNewAdCreationPermission && allowNewAdCreation !== true) {
    throw new Error('New ad creation permission is required for the selected replacements.');
  }

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
        executionMessage:
          operation.blockedMessage ||
          operation.blockedReason ||
          operation.message ||
          'UNSUPPORTED_TARGET',
      });
      continue;
    }

    const creativeId = operation.creative?.creative_id;
    if (!creativeId) {
      results.push({ ...operation, executionStatus: 'skipped', executionMessage: 'NO_CREATIVE_SELECTED' });
      continue;
    }

    try {
      const reserved = await reserveCreative(spreadsheetId, creativeId, operation.id, 'google');
      const creativeUrl = getCreativeDriveUrl(reserved) || getCreativeDriveUrl(operation.creative);
      const imageDataUrl = await downloadImageAsDataUrl(creativeUrl);
      const replacementImageResolution = await getImageResolutionFromDataUrl(imageDataUrl);
      const imageAspectRatioValidation = assertReplacementImageAspectRatio({
        expectedResolution: operation.oldImageResolution,
        expectedAspectRatio: operation.requiredAspectRatio,
        replacementResolution: replacementImageResolution,
        creativeId,
      });
      const replacement = await replaceAdCreative(
        accountId,
        operation,
        imageDataUrl,
      );
      const replacementResourceName =
        replacement.assetResourceName ||
        replacement.newAdResourceName ||
        replacement.updatedAdResourceName ||
        '';

      await markCreativeUsed(spreadsheetId, creativeId, {
        adsPlatform: 'google',
        adsResourceName: replacementResourceName,
        googleAdsAssetResourceName: replacementResourceName,
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
          new_asset_resource_name: replacementResourceName,
          status: 'success',
          message: 'Replacement completed.',
          payload_json: { operation, replacement, replacementImageResolution, imageAspectRatioValidation },
        },
      ]);

      results.push({
        ...operation,
        status: 'success',
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
          customer_id: accountId.replace(/-/g, ''),
          campaign_id: operation.campaignId,
          ad_group_id: operation.adGroupId,
          asset_group_id: operation.assetGroupId || '',
          old_asset_resource_name: operation.oldAssetResourceName,
          new_asset_resource_name: '',
          status: 'failed',
          message: error.message,
          payload_json: { operation, executionError },
        },
      ]);

      results.push({
        ...operation,
        status: 'failed',
        executionStatus: 'failed',
        executionMessage: error.message,
        executionError,
        googleAdsTrace: executionError.googleAdsTrace,
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

  console.log('[GOOGLE_REPLACEMENT] Execute completed', {
    accountId,
    campaignIds: plan.campaignIds || normalizeCampaignIds({ campaignId, campaignIds }),
    summary,
  });

  return {
    dryRun: false,
    replacementMode: plan.replacementMode,
    accountId,
    campaignId: plan.campaignIds?.length === 1 ? plan.campaignIds[0] : '',
    campaignIds: plan.campaignIds || normalizeCampaignIds({ campaignId, campaignIds }),
    summary,
    googleAdsTrace: collectExecutionGoogleAdsTrace(results),
    results,
  };
};
