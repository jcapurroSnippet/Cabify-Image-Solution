import assert from 'node:assert/strict';
import test from 'node:test';
import { readRowsIfPresent } from '../server/services/sheetsService.js';

test('readRowsIfPresent maps a pre-migration row with its stored headers', async () => {
  const sheets = {
    spreadsheets: {
      get: async () => ({
        data: {
          sheets: [{ properties: { sheetId: 17, title: 'batch_variations' } }],
        },
      }),
      values: {
        get: async () => ({
          data: {
            values: [
              ['review_item_id', 'creative_family_id', 'source_row'],
              ['item-1', 'family-1', '18'],
            ],
          },
        }),
      },
    },
  };

  const rows = await readRowsIfPresent(
    sheets,
    'spreadsheet-1',
    'batch_variations',
    ['review_item_id', 'creative_review_url', 'creative_family_id', 'source_row'],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0].review_item_id, 'item-1');
  assert.equal(rows[0].creative_family_id, 'family-1');
  assert.equal(rows[0].source_row, '18');
  assert.equal(rows[0].creative_review_url, undefined);
});
