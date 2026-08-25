import crypto from 'node:crypto';
import { getSheetsClient } from './googleAuth.js';
import {
  appendRows,
  buildRange,
  columnIndexToLetter,
  ensureSheetWithHeaders,
  extractSpreadsheetId,
  objectToRow,
  rowToObject,
} from './sheetsService.js';
import {
  CREATIVE_RUNS_SHEET,
  CREATIVE_RUN_HEADERS,
  CREATIVE_RUN_TARGETS_SHEET,
  CREATIVE_RUN_TARGET_HEADERS,
  getCreativeLibraryConfig,
} from './creativeLibraryConfig.js';
import { getAdsLowPerformers, buildAdsReplacementPlan, executeAdsReplacements } from './adsReplacementService.js';
import { generateAspectRatioImages } from './imageGenerator.js';
import { resolveSourceImage } from './sourceImageResolver.js';
import {
  createReviewBatch,
  getReviewBatch,
  issueReviewLink,
  registerReviewItems,
} from './creativeReviewService.js';
import {
  RunOrchestratorError,
  buildRunFamilyId,
  buildRunGenerationId,
  buildRunTargetId,
  getNextRunAction,
  parseIdList,
  selectTargetsForGeneration,
  stringifyIdList,
  summarizeRunTargets,
  transitionRun,
} from './runOrchestratorCore.js';

/** The three ratios every generated family must cover. */
export const RUN_TARGET_RATIOS = Object.freeze(['1:1', '9:16', '1.91:1']);

let runDependencyOverrides = {};

export const setRunDependencyOverrides = (overrides = {}) => {
  runDependencyOverrides = overrides || {};
};

export const resetRunDependencyOverrides = () => {
  runDependencyOverrides = {};
};

const dep = (name, fallback) => runDependencyOverrides[name] || fallback;

const clean = (value) => String(value ?? '').trim();
const cleanInteger = (value, fallback = 0) => {
  const parsed = Number.parseInt(value, 10);
  return Number.isInteger(parsed) ? parsed : fallback;
};
const nowIso = () => new Date().toISOString();
const stringifyJson = (value) => (typeof value === 'string' ? value : JSON.stringify(value || {}));
const parseJson = (value, fallback = {}) => {
  if (value && typeof value === 'object') return value;
  try {
    return value ? JSON.parse(value) : fallback;
  } catch {
    return fallback;
  }
};

const createRunId = () => `run_${crypto.randomBytes(8).toString('hex')}`;

/**
 * The library and replacement services call extractSpreadsheetId() directly,
 * which rejects a bare id. Always hand them a canonical URL.
 */
const canonicalSheetsUrl = (spreadsheetId) =>
  `https://docs.google.com/spreadsheets/d/${clean(spreadsheetId)}/edit`;

/**
 * Serialize mutations in-process. Cloud Run already runs this service at
 * concurrency 1 because Sheets has no compare-and-set, but the lock keeps the
 * invariant local and explicit rather than a deployment-flag side effect.
 */
const runLocks = new Map();
const withRunLock = async (spreadsheetId, fn) => {
  const previous = runLocks.get(spreadsheetId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  runLocks.set(spreadsheetId, previous.then(() => current));
  await previous;
  try {
    return await fn();
  } finally {
    release();
    if (runLocks.get(spreadsheetId) === current) runLocks.delete(spreadsheetId);
  }
};

const resolveSpreadsheetId = (input = {}) => {
  const raw = clean(input.sheetsUrl || input.spreadsheetId)
    || clean(getCreativeLibraryConfig().reviewSheetsUrl);
  if (!raw) {
    throw new RunOrchestratorError(
      'sheetsUrl is required (or set CREATIVE_REVIEW_SHEETS_URL).',
      'RUN_SHEETS_URL_REQUIRED',
    );
  }
  if (/^[a-zA-Z0-9_-]+$/.test(raw)) return raw;
  return extractSpreadsheetId(raw);
};

const getRunSheetsClient = () => dep('getSheetsClient', getSheetsClient)();

const readRows = async (sheets, spreadsheetId, sheetName, headers) => {
  const lastColumn = columnIndexToLetter(headers.length - 1);
  const response = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: buildRange(sheetName, `A:${lastColumn}`),
    // Unformatted so counters come back as numbers rather than locale-formatted text.
    valueRenderOption: 'UNFORMATTED_VALUE',
  });
  const values = response.data.values || [];
  return values.slice(1).map((row, index) => rowToObject(headers, row, index + 2));
};

const updateRow = async (sheets, spreadsheetId, sheetName, headers, row) => {
  if (!row?.__rowNumber) return;
  const lastColumn = columnIndexToLetter(headers.length - 1);
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: buildRange(sheetName, `A${row.__rowNumber}:${lastColumn}${row.__rowNumber}`),
    valueInputOption: 'RAW',
    requestBody: { values: [objectToRow(headers, row)] },
  });
};

export const ensureRunSheets = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const sheets = await getRunSheetsClient();
  await ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS);
  await ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_RUN_TARGETS_SHEET, CREATIVE_RUN_TARGET_HEADERS);
  return { spreadsheetId, sheets };
};

const readRunState = async (spreadsheetId) => {
  const sheets = await getRunSheetsClient();
  await ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS);
  await ensureSheetWithHeaders(sheets, spreadsheetId, CREATIVE_RUN_TARGETS_SHEET, CREATIVE_RUN_TARGET_HEADERS);
  const [runs, targets] = await Promise.all([
    readRows(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS),
    readRows(sheets, spreadsheetId, CREATIVE_RUN_TARGETS_SHEET, CREATIVE_RUN_TARGET_HEADERS),
  ]);
  return { sheets, runs, targets };
};

const findRun = (runs, runId) => runs.find((run) => clean(run.run_id) === clean(runId));

const assertRun = (run, runId) => {
  if (!run) {
    throw new RunOrchestratorError(`Run ${runId} was not found.`, 'RUN_NOT_FOUND', 404, { runId });
  }
  return run;
};

const getRunTargets = (targets, runId) =>
  targets.filter((target) => clean(target.run_id) === clean(runId));

const hydrateRun = (run, targets = []) => ({
  id: clean(run.run_id),
  status: clean(run.status) || 'draft',
  title: clean(run.title),
  createdBy: clean(run.created_by),
  createdAt: clean(run.created_at),
  updatedAt: clean(run.updated_at),
  platform: clean(run.platform),
  accountId: clean(run.account_id),
  campaignIds: parseIdList(run.campaign_ids),
  category: clean(run.category),
  plazas: parseIdList(run.plazas),
  sheetsUrl: canonicalSheetsUrl(run.source_sheet_id),
  reviewBatchId: clean(run.review_batch_id),
  privateUrl: clean(run.private_url),
  sentAt: clean(run.sent_at),
  targetCount: cleanInteger(run.target_count, 0),
  generatedCount: cleanInteger(run.generated_count, 0),
  approvedCount: cleanInteger(run.approved_count, 0),
  replacedCount: cleanInteger(run.replaced_count, 0),
  error: clean(run.error),
  version: cleanInteger(run.version, 1),
  metadata: parseJson(run.metadata_json, {}),
  summary: summarizeRunTargets(targets),
});

const hydrateTarget = (target) => ({
  runId: clean(target.run_id),
  targetId: clean(target.target_id),
  status: clean(target.status) || 'detected',
  platform: clean(target.platform),
  accountId: clean(target.account_id),
  campaignId: clean(target.campaign_id),
  campaignName: clean(target.campaign_name),
  adGroupId: clean(target.ad_group_id),
  adGroupName: clean(target.ad_group_name),
  adId: clean(target.ad_id),
  assetId: clean(target.asset_id),
  assetResourceName: clean(target.asset_resource_name),
  oldImageUrl: clean(target.old_image_url),
  requiredRatio: clean(target.required_ratio),
  detectedCategory: clean(target.detected_category),
  detectedPlazas: parseIdList(target.detected_plazas),
  sourceImageOrigin: clean(target.source_image_origin),
  sourceImageUrl: clean(target.source_image_url),
  creativeFamilyId: clean(target.creative_family_id),
  reviewItemIds: parseIdList(target.review_item_ids),
  creativeId: clean(target.creative_id),
  error: clean(target.error),
  createdAt: clean(target.created_at),
  updatedAt: clean(target.updated_at),
  metrics: parseJson(target.metrics_json, {}),
});

const persistRunCounters = (run, targets) => {
  const summary = summarizeRunTargets(targets);
  return {
    ...run,
    target_count: summary.total,
    generated_count: summary.generated + summary.approved + summary.replaced,
    replaced_count: summary.replaced,
  };
};

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

export const createRun = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const platform = clean(input.platform).toLowerCase();
  if (!['google', 'meta'].includes(platform)) {
    throw new RunOrchestratorError('platform must be "google" or "meta".', 'RUN_PLATFORM_REQUIRED');
  }
  const accountId = clean(input.accountId);
  if (!accountId) throw new RunOrchestratorError('accountId is required.', 'RUN_ACCOUNT_REQUIRED');
  const campaignIds = parseIdList(input.campaignIds);
  if (campaignIds.length === 0) {
    throw new RunOrchestratorError('At least one campaignId is required.', 'RUN_CAMPAIGNS_REQUIRED');
  }
  const category = clean(input.category);
  if (!category) throw new RunOrchestratorError('category is required.', 'RUN_CATEGORY_REQUIRED');
  const plazas = parseIdList(input.plazas);
  if (plazas.length === 0) throw new RunOrchestratorError('At least one plaza is required.', 'RUN_PLAZAS_REQUIRED');

  return withRunLock(spreadsheetId, async () => {
    const { sheets, runs } = await readRunState(spreadsheetId);
    const timestamp = nowIso();
    const run = {
      run_id: createRunId(),
      status: 'draft',
      title: clean(input.title) || `Ciclo ${timestamp.slice(0, 10)}`,
      created_by: clean(input.createdBy),
      created_at: timestamp,
      updated_at: timestamp,
      platform,
      account_id: accountId,
      campaign_ids: stringifyIdList(campaignIds),
      category,
      plazas: stringifyIdList(plazas),
      source_sheet_id: spreadsheetId,
      review_batch_id: '',
      private_url: '',
      sent_at: '',
      target_count: 0,
      generated_count: 0,
      approved_count: 0,
      replaced_count: 0,
      error: '',
      version: 1,
      metadata_json: stringifyJson({
        analysisDays: cleanInteger(input.analysisDays, 30),
        minImpressions: cleanInteger(input.minImpressions, 0),
        maxAssetsPerAd: cleanInteger(input.maxAssetsPerAd, 1),
        limit: cleanInteger(input.limit, 20),
      }),
    };
    await appendRows(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, [run]);
    return hydrateRun({ ...run, __rowNumber: runs.length + 2 }, []);
  });
};

export const listRuns = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const { runs, targets } = await readRunState(spreadsheetId);
  return runs
    .filter((run) => clean(run.run_id))
    .map((run) => hydrateRun(run, getRunTargets(targets, run.run_id)))
    .sort((left, right) => Date.parse(right.createdAt || '') - Date.parse(left.createdAt || ''));
};

export const getRun = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const runId = clean(input.runId);
  if (!runId) throw new RunOrchestratorError('runId is required.', 'RUN_ID_REQUIRED');
  const { runs, targets } = await readRunState(spreadsheetId);
  const run = assertRun(findRun(runs, runId), runId);
  const runTargets = getRunTargets(targets, runId);
  return {
    run: hydrateRun(run, runTargets),
    targets: runTargets.map(hydrateTarget),
  };
};

// ---------------------------------------------------------------------------
// Step 1 — detection
// ---------------------------------------------------------------------------

export const detectRunTargets = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const runId = clean(input.runId);
  if (!runId) throw new RunOrchestratorError('runId is required.', 'RUN_ID_REQUIRED');

  return withRunLock(spreadsheetId, async () => {
    const { sheets, runs, targets } = await readRunState(spreadsheetId);
    const runRow = assertRun(findRun(runs, runId), runId);
    const existing = getRunTargets(targets, runId);
    const knownIds = new Set(existing.map((target) => clean(target.target_id)));
    const options = parseJson(runRow.metadata_json, {});
    const platform = clean(runRow.platform);
    const accountId = clean(runRow.account_id);
    const campaignIds = parseIdList(runRow.campaign_ids);

    let detected;
    try {
      const result = await dep('getAdsLowPerformers', getAdsLowPerformers)({
        source: platform,
        selections: { [platform]: { accountId, campaignIds } },
        sheetsUrl: canonicalSheetsUrl(spreadsheetId),
        limit: cleanInteger(options.limit, 20),
        analysisDays: cleanInteger(options.analysisDays, 30),
        minImpressions: cleanInteger(options.minImpressions, 0),
        maxAssetsPerAd: cleanInteger(options.maxAssetsPerAd, 1),
      });
      detected = result?.assets || [];
    } catch (error) {
      const failed = { ...transitionRun(runRow, 'failed'), error: clean(error?.message) || 'Detection failed.' };
      await updateRow(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, failed);
      throw error;
    }

    const timestamp = nowIso();
    const newRows = [];
    detected.forEach((asset, index) => {
      const targetId = buildRunTargetId(asset, index);
      if (knownIds.has(targetId)) return;
      knownIds.add(targetId);
      newRows.push({
        run_id: runId,
        target_id: targetId,
        status: 'detected',
        platform: clean(asset.platform) || platform,
        account_id: clean(asset.accountId) || accountId,
        campaign_id: clean(asset.campaignId),
        campaign_name: clean(asset.campaignName),
        ad_group_id: clean(asset.adGroupId),
        ad_group_name: clean(asset.adGroupName),
        ad_id: clean(asset.adId),
        asset_id: clean(asset.assetId),
        asset_resource_name: clean(asset.assetResourceName),
        old_image_url: clean(asset.assetUrl),
        required_ratio: clean(asset.imageResolution),
        detected_category: clean(asset.detectedCategory) || clean(runRow.category),
        detected_plazas: stringifyIdList(asset.detectedPlazas || runRow.plazas),
        source_image_origin: '',
        source_image_url: '',
        creative_family_id: buildRunFamilyId(runId, targetId),
        review_item_ids: '',
        creative_id: '',
        error: '',
        created_at: timestamp,
        updated_at: timestamp,
        metrics_json: stringifyJson({
          ...(asset.metrics || {}),
          reason: clean(asset.reason),
          adName: clean(asset.adName),
          adType: clean(asset.adType),
          supportedReplacement: asset.supportedReplacement !== false,
        }),
      });
    });

    if (newRows.length > 0) {
      await appendRows(sheets, spreadsheetId, CREATIVE_RUN_TARGETS_SHEET, CREATIVE_RUN_TARGET_HEADERS, newRows);
    }

    const allTargets = [...existing, ...newRows];
    const advanced = persistRunCounters(transitionRun(runRow, 'detecting'), allTargets);
    await updateRow(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, advanced);

    return {
      run: hydrateRun(advanced, allTargets),
      targets: allTargets.map(hydrateTarget),
      detected: newRows.length,
    };
  });
};

// ---------------------------------------------------------------------------
// Step 2 — generation (reuses the existing aspect-ratio generator)
// ---------------------------------------------------------------------------

const ensureRunReviewBatch = async ({ sheets, spreadsheetId, runRow }) => {
  const existingBatchId = clean(runRow.review_batch_id);
  if (existingBatchId) return { runRow, batchId: existingBatchId };

  const batch = await dep('createReviewBatch', createReviewBatch)({
    sheetsUrl: canonicalSheetsUrl(spreadsheetId),
    sourceType: 'editor_batch',
    title: clean(runRow.title),
    createdBy: clean(runRow.created_by),
    category: clean(runRow.category),
    plazas: parseIdList(runRow.plazas).join(','),
    context: `Ciclo ${clean(runRow.run_id)} — reemplazo automático de low performers`,
    metadata: { runId: clean(runRow.run_id), platform: clean(runRow.platform) },
  });
  const batchId = clean(batch?.review_batch_id || batch?.id || batch?.reviewBatchId);
  if (!batchId) throw new RunOrchestratorError('Review batch creation returned no id.', 'RUN_BATCH_FAILED', 502);

  const updated = { ...runRow, review_batch_id: batchId, updated_at: nowIso() };
  await updateRow(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, updated);
  return { runRow: updated, batchId };
};

/**
 * Generate replacement pieces for every pending target: three variants in each
 * of the three ratios, registered into the run's review batch.
 *
 * `onProgress` is called with NDJSON-friendly events so the request can stream.
 * Per-target failures are recorded and skipped — one bad asset never kills the run.
 */
export const generateRunCreatives = async (input = {}, onProgress = () => {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const runId = clean(input.runId);
  if (!runId) throw new RunOrchestratorError('runId is required.', 'RUN_ID_REQUIRED');

  return withRunLock(spreadsheetId, async () => {
    const { sheets, runs, targets } = await readRunState(spreadsheetId);
    let runRow = assertRun(findRun(runs, runId), runId);
    const allTargets = getRunTargets(targets, runId);
    const pending = selectTargetsForGeneration(allTargets);

    if (clean(runRow.status) !== 'generating') {
      runRow = transitionRun(runRow, 'generating');
      await updateRow(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, runRow);
    }

    const batchContext = await ensureRunReviewBatch({ sheets, spreadsheetId, runRow });
    runRow = batchContext.runRow;
    const { batchId } = batchContext;

    onProgress({
      state: 'started',
      runId,
      batchId,
      total: allTargets.length,
      pending: pending.length,
      skipped: allTargets.length - pending.length,
    });

    const bankFolderId = clean(getCreativeLibraryConfig().sourceBankFolderId);
    let completed = 0;

    for (const target of pending) {
      const targetId = clean(target.target_id);
      onProgress({ state: 'target_started', runId, targetId, index: completed + 1, pending: pending.length });

      const source = await dep('resolveSourceImage', resolveSourceImage)(target, { bankFolderId });
      if (!source.dataUrl) {
        const updated = {
          ...target,
          status: 'no_source',
          error: clean(source.error) || 'No source image available.',
          updated_at: nowIso(),
        };
        await updateRow(sheets, spreadsheetId, CREATIVE_RUN_TARGETS_SHEET, CREATIVE_RUN_TARGET_HEADERS, updated);
        Object.assign(target, updated);
        completed += 1;
        onProgress({ state: 'target_skipped', runId, targetId, reason: updated.error });
        continue;
      }

      const familyId = clean(target.creative_family_id) || buildRunFamilyId(runId, targetId);
      const items = [];
      const ratioErrors = [];

      for (const ratio of RUN_TARGET_RATIOS) {
        try {
          const { images, errors } = await dep('generateAspectRatioImages', generateAspectRatioImages)(
            source.dataUrl,
            ratio,
          );
          (errors || []).forEach((error) => ratioErrors.push(`${ratio}: ${clean(error?.message || error)}`));
          (images || []).forEach((imageUrl, index) => {
            items.push({
              familyId,
              generationId: buildRunGenerationId(runId, targetId, ratio, index + 1),
              ratio,
              variantIndex: index + 1,
              imageUrl,
              referenceUrl: source.sourceUrl || '',
              category: clean(target.detected_category) || clean(runRow.category),
              plazas: parseIdList(target.detected_plazas).length > 0
                ? parseIdList(target.detected_plazas)
                : parseIdList(runRow.plazas),
              sourceOutput: `run:${runId}:${targetId}:${ratio}:${index + 1}`,
              metadata: {
                runId,
                targetId,
                ratio,
                sourceImageOrigin: source.origin,
                oldImageUrl: clean(target.old_image_url),
                campaignName: clean(target.campaign_name),
                adGroupName: clean(target.ad_group_name),
              },
            });
          });
          onProgress({ state: 'ratio_done', runId, targetId, ratio, variants: (images || []).length });
        } catch (error) {
          ratioErrors.push(`${ratio}: ${clean(error?.message) || 'generation failed'}`);
          onProgress({ state: 'ratio_failed', runId, targetId, ratio, error: clean(error?.message) });
        }
      }

      let updated;
      if (items.length === 0) {
        updated = {
          ...target,
          status: 'failed',
          source_image_origin: source.origin || '',
          source_image_url: source.sourceUrl || '',
          error: ratioErrors.join(' | ') || 'No images were generated.',
          updated_at: nowIso(),
        };
      } else {
        try {
          const registration = await dep('registerReviewItems', registerReviewItems)({
            sheetsUrl: canonicalSheetsUrl(spreadsheetId),
            batchId,
            items,
          });
          const registeredIds = (registration?.items || [])
            .map((item) => clean(item.review_item_id || item.reviewItemId || item.itemId))
            .filter(Boolean);
          updated = {
            ...target,
            status: 'generated',
            source_image_origin: source.origin || '',
            source_image_url: source.sourceUrl || '',
            creative_family_id: familyId,
            review_item_ids: stringifyIdList(registeredIds),
            error: ratioErrors.join(' | '),
            updated_at: nowIso(),
          };
        } catch (error) {
          updated = {
            ...target,
            status: 'failed',
            source_image_origin: source.origin || '',
            source_image_url: source.sourceUrl || '',
            error: clean(error?.message) || 'Failed to register review items.',
            updated_at: nowIso(),
          };
        }
      }

      await updateRow(sheets, spreadsheetId, CREATIVE_RUN_TARGETS_SHEET, CREATIVE_RUN_TARGET_HEADERS, updated);
      Object.assign(target, updated);
      completed += 1;
      onProgress({
        state: updated.status === 'generated' ? 'target_done' : 'target_failed',
        runId,
        targetId,
        variants: items.length,
        error: clean(updated.error) || undefined,
      });
    }

    const summary = summarizeRunTargets(allTargets);
    let finalRun = persistRunCounters(runRow, allTargets);
    // Only move on once something actually exists to review.
    if (summary.generated > 0) {
      finalRun = persistRunCounters(transitionRun(finalRun, 'internal_review'), allTargets);
    }
    await updateRow(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, finalRun);

    onProgress({ state: 'completed', runId, batchId, summary });
    return {
      run: hydrateRun(finalRun, allTargets),
      targets: allTargets.map(hydrateTarget),
      summary,
    };
  });
};

// ---------------------------------------------------------------------------
// Steps 3-4 — internal cull, then hand off to the client
// ---------------------------------------------------------------------------

export const submitRunForClientReview = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const runId = clean(input.runId);
  if (!runId) throw new RunOrchestratorError('runId is required.', 'RUN_ID_REQUIRED');

  return withRunLock(spreadsheetId, async () => {
    const { sheets, runs, targets } = await readRunState(spreadsheetId);
    const runRow = assertRun(findRun(runs, runId), runId);
    const batchId = clean(runRow.review_batch_id);
    if (!batchId) {
      throw new RunOrchestratorError('This run has no review batch yet.', 'RUN_BATCH_MISSING', 409);
    }

    const link = await dep('issueReviewLink', issueReviewLink)({
      sheetsUrl: canonicalSheetsUrl(spreadsheetId),
      batchId,
    });
    const privateUrl = clean(link?.privateUrl || link?.reviewUrl || link?.batch?.privateUrl);
    if (!privateUrl) {
      throw new RunOrchestratorError('The review link could not be issued.', 'RUN_LINK_FAILED', 502);
    }

    const runTargets = getRunTargets(targets, runId);
    const updated = persistRunCounters(
      { ...transitionRun(runRow, 'awaiting_client'), private_url: privateUrl },
      runTargets,
    );
    await updateRow(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, updated);

    return { run: hydrateRun(updated, runTargets), privateUrl, expiresAt: clean(link?.expiresAt) };
  });
};

export const markRunSent = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const runId = clean(input.runId);
  if (!runId) throw new RunOrchestratorError('runId is required.', 'RUN_ID_REQUIRED');

  return withRunLock(spreadsheetId, async () => {
    const { sheets, runs, targets } = await readRunState(spreadsheetId);
    const runRow = assertRun(findRun(runs, runId), runId);
    const runTargets = getRunTargets(targets, runId);
    const updated = persistRunCounters(transitionRun(runRow, 'client_review'), runTargets);
    await updateRow(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, updated);
    return { run: hydrateRun(updated, runTargets) };
  });
};

/**
 * Pull the client's decisions back into the run. Once the review batch is
 * published, the approved creatives exist in creative_library and the run can
 * move to placement.
 */
export const syncRunFromReview = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const runId = clean(input.runId);
  if (!runId) throw new RunOrchestratorError('runId is required.', 'RUN_ID_REQUIRED');

  return withRunLock(spreadsheetId, async () => {
    const { sheets, runs, targets } = await readRunState(spreadsheetId);
    const runRow = assertRun(findRun(runs, runId), runId);
    const batchId = clean(runRow.review_batch_id);
    if (!batchId) throw new RunOrchestratorError('This run has no review batch yet.', 'RUN_BATCH_MISSING', 409);

    const batch = await dep('getReviewBatch', getReviewBatch)({
      sheetsUrl: canonicalSheetsUrl(spreadsheetId),
      batchId,
    });
    const items = batch?.items || [];
    const approvedByFamily = new Map();
    for (const item of items) {
      const decision = clean(item.decision || item.status).toLowerCase();
      if (decision !== 'approved') continue;
      const familyId = clean(item.creative_family_id || item.familyId);
      if (!familyId) continue;
      const creativeId = clean(item.creative_id || item.creativeId);
      if (!approvedByFamily.has(familyId)) approvedByFamily.set(familyId, []);
      if (creativeId) approvedByFamily.get(familyId).push(creativeId);
    }

    const runTargets = getRunTargets(targets, runId);
    for (const target of runTargets) {
      const familyId = clean(target.creative_family_id);
      if (!approvedByFamily.has(familyId)) continue;
      if (clean(target.status) === 'replaced') continue;
      const creativeIds = approvedByFamily.get(familyId);
      const updated = {
        ...target,
        status: 'approved',
        creative_id: creativeIds[0] || clean(target.creative_id),
        updated_at: nowIso(),
      };
      await updateRow(sheets, spreadsheetId, CREATIVE_RUN_TARGETS_SHEET, CREATIVE_RUN_TARGET_HEADERS, updated);
      Object.assign(target, updated);
    }

    const summary = summarizeRunTargets(runTargets);
    const batchStatus = clean(batch?.status).toLowerCase();
    let updatedRun = persistRunCounters({ ...runRow, approved_count: summary.approved }, runTargets);
    if (batchStatus === 'published' && summary.approved > 0 && clean(runRow.status) === 'client_review') {
      updatedRun = persistRunCounters(transitionRun(updatedRun, 'placement'), runTargets);
    }
    await updateRow(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, updatedRun);

    return {
      run: hydrateRun(updatedRun, runTargets),
      targets: runTargets.map(hydrateTarget),
      reviewStatus: batchStatus,
      summary,
    };
  });
};

// ---------------------------------------------------------------------------
// Step 5 — placement
// ---------------------------------------------------------------------------

const buildPlacementArgs = (runRow, input) => {
  const platform = clean(runRow.platform);
  return {
    source: platform,
    selections: {
      [platform]: {
        accountId: clean(runRow.account_id),
        campaignIds: parseIdList(runRow.campaign_ids),
      },
    },
    sheetsUrl: canonicalSheetsUrl(runRow.source_sheet_id),
    limit: cleanInteger(parseJson(runRow.metadata_json, {}).limit, 20),
    replacementMode: clean(input.replacementMode) || 'allow_google_required_clone',
    lowPerformerCategories: input.lowPerformerCategories || {},
    selectedLowPerformerIds: parseIdList(input.selectedTargetIds),
  };
};

export const buildRunPlacementPlan = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const runId = clean(input.runId);
  if (!runId) throw new RunOrchestratorError('runId is required.', 'RUN_ID_REQUIRED');
  const { runs, targets } = await readRunState(spreadsheetId);
  const runRow = assertRun(findRun(runs, runId), runId);
  const plan = await dep('buildAdsReplacementPlan', buildAdsReplacementPlan)(buildPlacementArgs(runRow, input));
  return { run: hydrateRun(runRow, getRunTargets(targets, runId)), ...plan };
};

export const executeRunPlacement = async (input = {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const runId = clean(input.runId);
  if (!runId) throw new RunOrchestratorError('runId is required.', 'RUN_ID_REQUIRED');
  if (input.confirm !== true) {
    throw new RunOrchestratorError('confirm must be true to execute replacements.', 'RUN_CONFIRM_REQUIRED');
  }

  return withRunLock(spreadsheetId, async () => {
    const { sheets, runs, targets } = await readRunState(spreadsheetId);
    const runRow = assertRun(findRun(runs, runId), runId);
    const execution = await dep('executeAdsReplacements', executeAdsReplacements)({
      ...buildPlacementArgs(runRow, input),
      confirm: true,
      selectedOperationIds: parseIdList(input.selectedOperationIds),
      allowNewAdCreation: input.allowNewAdCreation === true,
    });

    const replacedCreativeIds = new Set(
      (execution.results || [])
        .filter((result) => clean(result.executionStatus || result.status).toLowerCase() === 'success')
        .map((result) => clean(result.creative?.creative_id))
        .filter(Boolean),
    );

    const runTargets = getRunTargets(targets, runId);
    for (const target of runTargets) {
      if (!replacedCreativeIds.has(clean(target.creative_id))) continue;
      const updated = { ...target, status: 'replaced', updated_at: nowIso() };
      await updateRow(sheets, spreadsheetId, CREATIVE_RUN_TARGETS_SHEET, CREATIVE_RUN_TARGET_HEADERS, updated);
      Object.assign(target, updated);
    }

    const summary = summarizeRunTargets(runTargets);
    let updatedRun = persistRunCounters(runRow, runTargets);
    if (summary.replaced > 0 && summary.approved === 0 && clean(runRow.status) === 'placement') {
      updatedRun = persistRunCounters(transitionRun(updatedRun, 'completed'), runTargets);
    }
    await updateRow(sheets, spreadsheetId, CREATIVE_RUNS_SHEET, CREATIVE_RUN_HEADERS, updatedRun);

    return { run: hydrateRun(updatedRun, runTargets), ...execution };
  });
};

// ---------------------------------------------------------------------------
// Dispatcher — this is what chains step 1 into step 2 without a person
// ---------------------------------------------------------------------------

export const advanceRun = async (input = {}, onProgress = () => {}) => {
  const spreadsheetId = resolveSpreadsheetId(input);
  const runId = clean(input.runId);
  if (!runId) throw new RunOrchestratorError('runId is required.', 'RUN_ID_REQUIRED');
  const { runs } = await readRunState(spreadsheetId);
  const runRow = assertRun(findRun(runs, runId), runId);
  const action = getNextRunAction(runRow.status);

  switch (action) {
    case 'detect':
      return { action, ...(await detectRunTargets({ sheetsUrl: spreadsheetId, runId })) };
    case 'generate':
      return { action, ...(await generateRunCreatives({ sheetsUrl: spreadsheetId, runId }, onProgress)) };
    case 'sync':
      return { action, ...(await syncRunFromReview({ sheetsUrl: spreadsheetId, runId })) };
    default:
      return {
        action: null,
        waiting: true,
        ...(await getRun({ sheetsUrl: spreadsheetId, runId })),
      };
  }
};
