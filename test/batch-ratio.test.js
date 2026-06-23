import assert from 'node:assert/strict';
import test from 'node:test';
import {
  getBatchRatioColumns,
  getBatchTargetRatios,
} from '../server/services/batchProcessor.js';
import { getVariationPrompts } from '../server/services/imageGenerator.js';

test('detects landscape batch output columns by supported aliases', () => {
  const columns = getBatchRatioColumns([
    'Original image',
    '1:1 output A',
    '9:16 output A',
    'Landscape output A',
    '1200x628 output B',
    '1.91 output C',
  ]);

  assert.deepEqual(columns['1:1'], [1]);
  assert.deepEqual(columns['9:16'], [2]);
  assert.deepEqual(columns['1.91:1'], [3, 4, 5]);
  assert.deepEqual(getBatchTargetRatios(columns), ['1:1', '9:16', '1.91:1']);
});

test('keeps legacy batch target ratios when no output columns are named', () => {
  const columns = getBatchRatioColumns(['Image URL', 'Output A', 'Output B']);

  assert.deepEqual(getBatchTargetRatios(columns), ['1:1', '9:16']);
});

test('adds dedicated prompts for 1.91:1 image generation', () => {
  const prompts = getVariationPrompts('1.91:1');

  assert.equal(prompts.length, 3);
  assert.match(prompts[0], /1\.91:1 landscape canvas/);
  assert.match(prompts[0], /1200x628 Google marketing image/);
});
