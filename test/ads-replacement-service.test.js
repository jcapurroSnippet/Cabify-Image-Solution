import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAdsReplacementPlan,
  executeAdsReplacements,
  getAdsLowPerformers,
} from '../server/services/adsReplacementService.js';

test('fetches low performers for the selected platform and tags assets', async () => {
  const result = await getAdsLowPerformers({
    source: 'meta',
    selections: {
      meta: { accountId: 'act_456', campaignIds: ['m-campaign'] },
    },
    limit: 10,
    sheetsUrl: 'sheet',
    deps: {
      google: {
        getLowPerformers: async () => {
          throw new Error('Google should not be queried for a Meta source.');
        },
      },
      meta: {
        getLowPerformers: async (args) => [{
          id: 'meta-asset',
          platform: args.platform,
          accountId: args.accountId,
        }],
      },
    },
  });

  assert.deepEqual(result.assets, [
    { id: 'meta-asset', platform: 'meta', platformLabel: 'Meta Ads', accountId: 'act_456' },
  ]);
});

test('rejects both as an Ads source', async () => {
  await assert.rejects(
    () => getAdsLowPerformers({ source: 'both' }),
    /source must be "google" or "meta"/,
  );
  await assert.rejects(
    () => buildAdsReplacementPlan({ source: 'both' }),
    /source must be "google" or "meta"/,
  );
  await assert.rejects(
    () => executeAdsReplacements({ source: 'both' }),
    /source must be "google" or "meta"/,
  );
});

test('builds a replacement plan for one selected platform', async () => {
  const metaCalls = [];
  const result = await buildAdsReplacementPlan({
    source: 'meta',
    selections: {
      meta: { accountId: 'act_456', campaignIds: ['m-campaign'] },
    },
    sheetsUrl: 'sheet',
    limit: 10,
    deps: {
      google: {
        buildReplacementPlan: async () => {
          throw new Error('Google should not be planned for a Meta source.');
        },
      },
      meta: {
        buildReplacementPlan: async (args) => {
          metaCalls.push(args);
          return {
            dryRun: true,
            summary: { lowPerformers: 1, planned: 1, executable: 1, skipped: 0 },
            operations: [
              {
                id: 'meta-op',
                platform: 'meta',
                status: 'planned',
                executableInMode: true,
                creative: { creative_id: 'creative-1' },
              },
            ],
            librarySummary: { total: 2 },
          };
        },
      },
    },
  });

  assert.deepEqual(metaCalls[0].excludedCreativeIds, []);
  assert.deepEqual(
    result.operations.map((operation) => operation.id),
    ['meta-op'],
  );
  assert.deepEqual(result.summary, {
    lowPerformers: 1,
    planned: 1,
    executable: 1,
    skipped: 0,
  });
  assert.deepEqual(result.librarySummary, { total: 2 });
});

test('executes selected operations on one selected platform', async () => {
  const result = await executeAdsReplacements({
    source: 'google',
    selections: {
      google: { accountId: '123', campaignIds: [] },
    },
    sheetsUrl: 'sheet',
    selectedOperationIds: ['google-op'],
    confirm: true,
    deps: {
      google: {
        executeReplacements: async () => ({
          dryRun: false,
          summary: { attempted: 1, success: 1, failed: 0, skipped: 0 },
          googleAdsTrace: [{ step: 'google', status: 'success' }],
          results: [{ id: 'google-op', platform: 'google', executionStatus: 'success' }],
        }),
      },
      meta: {
        executeReplacements: async () => {
          throw new Error('Meta should not execute for a Google source.');
        },
      },
    },
  });

  assert.deepEqual(result.summary, { attempted: 1, success: 1, failed: 0, skipped: 0 });
  assert.deepEqual(result.googleAdsTrace, [{ step: 'google', status: 'success' }]);
  assert.deepEqual(result.metaAdsTrace, []);
  assert.deepEqual(
    result.results.map((operation) => operation.id),
    ['google-op'],
  );
});
