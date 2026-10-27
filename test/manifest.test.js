// -----------------------------------------------------------------------------
// Consistency checks between `gladys-assistant-integration.json` and the code.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { SSDP_SEARCH_TARGET } from '../src/constants.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

test('manifest description is 10-100 characters in every declared language', () => {
  for (const [lang, text] of Object.entries(manifest.description)) {
    assert.ok(
      text.length >= 10 && text.length <= 100,
      `description.${lang} is ${text.length} chars`,
    );
  }
});

test('the manifest SSDP search target matches the constant the code relies on', () => {
  const ssdpEntry = manifest.network_discovery.find((entry) => entry.type === 'ssdp');
  assert.ok(ssdpEntry, 'manifest must declare an ssdp network_discovery entry');
  assert.equal(ssdpEntry.st, SSDP_SEARCH_TARGET);
});

test('every manifest action has a registered handler', () => {
  // Kept in sync by hand with index.js's gladys.onAction(...) calls.
  const handled = new Set(['scan_now']);
  for (const action of manifest.actions ?? []) {
    assert.ok(handled.has(action.key), `manifest action "${action.key}" has no handler`);
  }
});

test('declaring catalog categories requires Gladys >= 4.86.0', () => {
  assert.ok(manifest.categories.length >= 1 && manifest.categories.length <= 3);
  const minVersion = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/);
  assert.ok(minVersion, 'gladys_version must declare a minimum version');
  const [, major, minor] = minVersion.map(Number);
  assert.ok(
    major > 4 || (major === 4 && minor >= 86),
    `categories requires gladys_version >= 4.86.0, got "${manifest.gladys_version}"`,
  );
});

test('this integration declares no cloud transport (LAN-only control)', () => {
  assert.deepEqual(manifest.transports, ['local']);
});

test('declaring a music player requires Gladys >= 5.3.0', () => {
  // Every operation declared here is answered by an onMusic* handler in
  // index.js (browse/search/queue/play).
  assert.ok(manifest.music, 'manifest must declare a music block');
  for (const flag of ['browse', 'search', 'queue', 'append']) {
    assert.equal(typeof manifest.music[flag], 'boolean', `music.${flag} must be a boolean`);
  }
  const [, major, minor] = manifest.gladys_version.match(/>=\s*(\d+)\.(\d+)\.\d+/).map(Number);
  assert.ok(
    major > 5 || (major === 5 && minor >= 3),
    `music requires gladys_version >= 5.3.0, got "${manifest.gladys_version}"`,
  );
});
