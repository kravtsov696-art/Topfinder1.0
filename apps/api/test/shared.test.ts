import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifyFreshness, percentile, normalizeInviteCode } from '../../../packages/shared/src/index.ts';
import { isPlausible, validateFix } from '../src/fixes.ts';
import { toCsv } from '../src/csv.ts';

test('классификация свежести по экспериментальным порогам', () => {
  const m = 60_000;
  assert.equal(classifyFreshness({ ageMs: null, accuracyM: null }), 'unavailable');
  assert.equal(classifyFreshness({ ageMs: 30_000, accuracyM: 10 }), 'fresh');
  assert.equal(classifyFreshness({ ageMs: 30_000, accuracyM: 500 }), 'approximate');
  assert.equal(classifyFreshness({ ageMs: 30_000, accuracyM: 10, reducedAccuracy: true }), 'approximate');
  assert.equal(classifyFreshness({ ageMs: 5 * m, accuracyM: 10 }), 'recent');
  assert.equal(classifyFreshness({ ageMs: 37 * m, accuracyM: 10 }), 'stale');
  assert.equal(classifyFreshness({ ageMs: 61 * m, accuracyM: 10 }), 'historical');
  assert.equal(classifyFreshness({ ageMs: -5000, accuracyM: 10 }), 'fresh');
});

test('правдоподобие перемещения', () => {
  const t = 1_760_000_000_000;
  assert.equal(isPlausible({ lat: 45, lon: 39, accuracyM: 10, measuredAt: t }, { lat: 45.001, lon: 39, accuracyM: 10, measuredAt: t + 10_000 }), true);
  assert.equal(isPlausible({ lat: 45, lon: 39, accuracyM: 10, measuredAt: t }, { lat: 55, lon: 37, accuracyM: 10, measuredAt: t + 10_000 }), false);
});

test('validateFix не принимает строки вместо чисел', () => {
  const r = validateFix({ clientFixId: '0b6b5d1e-3c39-4c8e-8c55-0d7f3c1a2b3c', measuredAt: '1760000000000', lat: 45, lon: 39, accuracyM: 5, source: 'manual' }, 1_760_000_100_000, 86400_000);
  assert.equal(r.ok, false);
});

test('перцентили, нормализация кода, CSV-экранирование', () => {
  assert.equal(percentile([5, 1, 3, 2, 4], 50), 3);
  assert.equal(percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 90), 9);
  assert.equal(percentile([], 50), null);
  assert.equal(normalizeInviteCode(' ab2c-d3ef '), 'AB2CD3EF');
  const csv = toCsv([{ a: 'x,y', b: '=cmd()', c: -5, d: null }]);
  assert.equal(csv, '﻿a,b,c,d\r\n"x,y",\'=cmd(),-5,\r\n');
});
