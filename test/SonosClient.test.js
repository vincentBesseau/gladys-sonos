import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseKnownIps, formatNowPlaying } from '../src/SonosClient.js';

test('parseKnownIps splits on commas, newlines and whitespace', () => {
  assert.deepEqual(parseKnownIps('192.168.10.21, 192.168.10.22\n192.168.10.23'), [
    '192.168.10.21',
    '192.168.10.22',
    '192.168.10.23',
  ]);
});

test('parseKnownIps trims entries and drops empty ones', () => {
  assert.deepEqual(parseKnownIps('  192.168.10.21 ,,\n\n 192.168.10.22  '), [
    '192.168.10.21',
    '192.168.10.22',
  ]);
});

test('parseKnownIps returns an empty array for empty/undefined input', () => {
  assert.deepEqual(parseKnownIps(''), []);
  assert.deepEqual(parseKnownIps(undefined), []);
  assert.deepEqual(parseKnownIps(null), []);
});

test('formatNowPlaying joins artist and title', () => {
  assert.equal(
    formatNowPlaying({ Title: "L'aventurier", Artist: 'Indochine' }),
    "Indochine — L'aventurier",
  );
});

test('formatNowPlaying falls back to just the title when there is no artist', () => {
  assert.equal(formatNowPlaying({ Title: 'Some Stream' }), 'Some Stream');
});

test('formatNowPlaying returns an empty string for anything unusable', () => {
  assert.equal(formatNowPlaying(undefined), '');
  assert.equal(formatNowPlaying('NOT_IMPLEMENTED'), '');
  assert.equal(formatNowPlaying({}), '');
  assert.equal(formatNowPlaying(null), '');
});
