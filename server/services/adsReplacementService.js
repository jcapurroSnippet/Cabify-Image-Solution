import {
  buildGoogleReplacementPlan,
  executeGoogleReplacements,
  getGoogleLowPerformers,
} from './googleReplacementService.js';
import {
  buildMetaReplacementPlan,
  executeMetaReplacements,
  getMetaLowPerformers,
} from './metaReplacementService.js';

const PLATFORM_LABELS = {
  google: 'Google Ads',
  meta: 'Meta Ads',
};

const DEFAULT_DEPS = {
  google: {
    getLowPerformers: getGoogleLowPerformers,
    buildReplacementPlan: buildGoogleReplacementPlan,
    executeReplacements: executeGoogleReplacements,
  },
  meta: {
    getLowPerformers: getMetaLowPerformers,
    buildReplacementPlan: buildMetaReplacementPlan,
    executeReplacements: executeMetaReplacements,
  },
};

const normalizeSource = (source = 'google') => {
  const normalized = String(source || 'google').trim().toLowerCase();
  if (normalized === 'both') return ['google', 'meta'];
  if (normalized === 'google' || normalized === 'meta') return [normalized];
  throw new Error('source must be "google", "meta", or "both".');
};

const normalizeStringList = (value) => {
  if (value === undefined || value === null || value === '') return [];
  const rawValues = Array.isArray(value) ? value : [value];
  return [...new Set(rawValues.map((item) => String(item).trim()).filter(Boolean))];
};

const getSelectionForPlatform = ({ platform, selections, accountId, campaignId, campaignIds }) => {
  const selection = selections?.[platform] || {};
  return {
    accountId: String(selection.accountId || accountId || '').trim(),
    campaignIds: normalizeStringList(selection.campaignIds ?? selection.campaignId ?? campaignIds ?? campaignId),
  };
};

const tagPlatform = (item, platform, accountId) => ({
  ...item,
  platform,
  platformLabel: PLATFORM_LABELS[platform],
  accountId: item.accountId || accountId,
});

const mergeSummaries = (summaries) => {
  const merged = {};
  for (const summary of summaries) {
    for (const [key, value] of Object.entries(summary || {})) {
      if (typeof value === 'number' && Number.isFinite(value)) {
        merged[key] = (merged[key] || 0) + value;
      }
    }
  }
  return merged;
};

const collectPlannedCreativeIds = (operations = []) =>
  operations
    .map((operation) => operation.creative?.creative_id)
    .filter(Boolean)
    .map((creativeId) => String(creativeId));

const collectResultCreativeIds = (results = []) =>
  results
    .map((result) => result.creative?.creative_id)
    .filter(Boolean)
    .map((creativeId) => String(creativeId));

const getDeps = (deps = {}) => ({
  google: { ...DEFAULT_DEPS.google, ...(deps.google || {}) },
  meta: { ...DEFAULT_DEPS.meta, ...(deps.meta || {}) },
});

export const getAdsLowPerformers = async ({
  source = 'google',
  selections,
  accountId,
  campaignId,
  campaignIds,
  limit = 100,
  sheetsUrl,
  deps,
} = {}) => {
  const activePlatforms = normalizeSource(source);
  const effectiveDeps = getDeps(deps);
  const assets = [];

  for (const platform of activePlatforms) {
    const selection = getSelectionForPlatform({ platform, selections, accountId, campaignId, campaignIds });
    if (!selection.accountId) throw new Error(`${platform} accountId is required.`);

    const platformAssets = await effectiveDeps[platform].getLowPerformers({
      platform,
      accountId: selection.accountId,
      campaignIds: selection.campaignIds,
      sheetsUrl,
      limit,
    });

    assets.push(...platformAssets.map((asset) => tagPlatform(asset, platform, selection.accountId)));
  }

  return {
    source,
    limit,
    assets,
  };
};

export const buildAdsReplacementPlan = async ({
  source = 'google',
  selections,
  accountId,
  campaignId,
  campaignIds,
  sheetsUrl,
  limit = 20,
  selectedLowPerformerIds,
  lowPerformerCategories,
  replacementMode,
  deps,
} = {}) => {
  const activePlatforms = normalizeSource(source);
  const effectiveDeps = getDeps(deps);
  const operations = [];
  const summaries = [];
  const excludedCreativeIds = [];
  let librarySummary = null;

  for (const platform of activePlatforms) {
    const selection = getSelectionForPlatform({ platform, selections, accountId, campaignId, campaignIds });
    if (!selection.accountId) throw new Error(`${platform} accountId is required.`);

    const plan = await effectiveDeps[platform].buildReplacementPlan({
      platform,
      sheetsUrl,
      accountId: selection.accountId,
      campaignIds: selection.campaignIds,
      limit,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
      excludedCreativeIds: [...excludedCreativeIds],
    });

    const platformOperations = (plan.operations || []).map((operation) =>
      tagPlatform(operation, platform, selection.accountId),
    );
    operations.push(...platformOperations);
    summaries.push(plan.summary || {});
    excludedCreativeIds.push(...collectPlannedCreativeIds(platformOperations));
    librarySummary = plan.librarySummary || librarySummary;
  }

  return {
    dryRun: true,
    source,
    limit,
    summary: mergeSummaries(summaries),
    operations,
    librarySummary,
  };
};

export const executeAdsReplacements = async ({
  source = 'google',
  selections,
  accountId,
  campaignId,
  campaignIds,
  sheetsUrl,
  limit = 10,
  confirm,
  selectedOperationIds,
  selectedLowPerformerIds,
  lowPerformerCategories,
  replacementMode,
  allowNewAdCreation,
  deps,
} = {}) => {
  const activePlatforms = normalizeSource(source);
  const effectiveDeps = getDeps(deps);
  const results = [];
  const summaries = [];
  const googleAdsTrace = [];
  const metaAdsTrace = [];
  const excludedCreativeIds = [];

  for (const platform of activePlatforms) {
    const selection = getSelectionForPlatform({ platform, selections, accountId, campaignId, campaignIds });
    if (!selection.accountId) throw new Error(`${platform} accountId is required.`);

    const execution = await effectiveDeps[platform].executeReplacements({
      platform,
      sheetsUrl,
      accountId: selection.accountId,
      campaignIds: selection.campaignIds,
      limit,
      confirm,
      selectedOperationIds,
      selectedLowPerformerIds,
      lowPerformerCategories,
      replacementMode,
      allowNewAdCreation,
      excludedCreativeIds: [...excludedCreativeIds],
    });

    const platformResults = (execution.results || []).map((result) =>
      tagPlatform(result, platform, selection.accountId),
    );
    results.push(...platformResults);
    summaries.push(execution.summary || {});
    googleAdsTrace.push(...(execution.googleAdsTrace || []));
    metaAdsTrace.push(...(execution.metaAdsTrace || []));
    excludedCreativeIds.push(...collectResultCreativeIds(platformResults));
  }

  return {
    dryRun: false,
    source,
    limit,
    summary: mergeSummaries(summaries),
    googleAdsTrace,
    metaAdsTrace,
    results,
  };
};
