import assert from 'node:assert/strict';
import test from 'node:test';
import { collectExecutionGoogleAdsTrace } from '../server/services/googleReplacementService.js';

test('collects google ads trace entries from successful and failed replacement results', () => {
  const trace = collectExecutionGoogleAdsTrace([
    {
      replacement: {
        googleAdsTrace: [
          { step: 'validate_input', status: 'success' },
          { step: 'verify_app_engagement_ad_image_update', status: 'success' },
        ],
      },
    },
    {
      executionError: {
        googleAdsTrace: [
          { step: 'upload_asset_and_update_app_engagement_ad', status: 'error' },
        ],
      },
    },
  ]);

  assert.deepEqual(
    trace.map((entry) => `${entry.step}:${entry.status}`),
    [
      'validate_input:success',
      'verify_app_engagement_ad_image_update:success',
      'upload_asset_and_update_app_engagement_ad:error',
    ],
  );
});
