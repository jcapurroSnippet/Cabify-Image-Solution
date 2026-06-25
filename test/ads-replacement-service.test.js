import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildAdsReplacementPlan,
  executeAdsReplacements,
  getAdsLowPerformers,
} from '../server/services/adsReplacementService.js';

test('fetches low performers for both platforms and tags merged assets', async () => {
  const result = await getAdsLowPerformers({
    source: 'both',
    selections: {
      google: { accountId: '123', campaignIds: ['g-campaign'] },
      meta: { accountId: 'act_456', campaignIds: ['m-campaign'] },
    },
    limit: 10,
    sheetsUrl: 'sheet',
    deps: {
      google: {
        getLowPerformers: async (args) => [{
          id: 'google-asset',
          platform: args.platform,
          accountId: args.accountId,
        }],
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
    { id: 'google-asset', platform: 'google', platformLabel: 'Google Ads', accountId: '123' },
    { id: 'meta-asset', platform: 'meta', platformLabel: 'Meta Ads', accountId: 'act_456' },
  ]);
});

test('builds a combined replacement plan without cross-platform creative exclusions', async () => {
  const metaCalls = [];
  const result = await buildAdsReplacementPlan({
    source: 'both',
    selections: {
      google: { accountId: '123', campaignIds: ['g-campaign'] },
      meta: { accountId: 'act_456', campaignIds: ['m-campaign'] },
    },
    sheetsUrl: 'sheet',
    limit: 10,
    deps: {
      google: {
        buildReplacementPlan: async () => ({
          dryRun: true,
          summary: { lowPerformers: 1, planned: 1, executable: 1, skipped: 0 },
          operations: [
            {
              id: 'google-op',
              platform: 'google',
              status: 'planned',
              executableInMode: true,
              creative: { creative_id: 'creative-1' },
            },
          ],
          librarySummary: { total: 2 },
        }),
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
    ['google-op', 'meta-op'],
  );
  assert.deepEqual(result.summary, {
    lowPerformers: 2,
    planned: 2,
    executable: 2,
    skipped: 0,
  });
  assert.deepEqual(result.librarySummary, { total: 2 });
});

test('executes selected operations on each platform and merges traces', async () => {
  const result = await executeAdsReplacements({
    source: 'both',
    selections: {
      google: { accountId: '123', campaignIds: [] },
      meta: { accountId: 'act_456', campaignIds: [] },
    },
    sheetsUrl: 'sheet',
    selectedOperationIds: ['google-op', 'meta-op'],
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
        executeReplacements: async () => ({
          dryRun: false,
          summary: { attempted: 1, success: 1, failed: 0, skipped: 0 },
          metaAdsTrace: [{ step: 'meta', status: 'success' }],
          results: [{ id: 'meta-op', platform: 'meta', executionStatus: 'success' }],
        }),
      },
    },
  });

  assert.deepEqual(result.summary, { attempted: 2, success: 2, failed: 0, skipped: 0 });
  assert.deepEqual(result.googleAdsTrace, [{ step: 'google', status: 'success' }]);
  assert.deepEqual(result.metaAdsTrace, [{ step: 'meta', status: 'success' }]);
  assert.deepEqual(
    result.results.map((operation) => operation.id),
    ['google-op', 'meta-op'],
  );
});
