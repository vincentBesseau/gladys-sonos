import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

import { convertToGladysDevice } from '../src/convertToGladysDevice.js';
import {
  sonosUuidFromFeature,
  sonosUuidFromDevice,
  setDeviceValue,
  pollDevice,
} from '../src/devices.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

// Minimal Gladys SDK stub matching the real SDK's externalIds() prefixing.
const gladysStub = {
  selector: 'ext-dev-sonos',
  externalId(suffix) {
    return `ext:${this.selector}:${suffix}`;
  },
  externalIds(type, platformId) {
    const device = this.externalId(`${type}:${platformId}`);
    return { device, feature: (key) => `${device}:${key}` };
  },
};

test('convertToGladysDevice builds prefixed external ids and the 9 features', () => {
  const device = convertToGladysDevice(gladysStub, {
    uuid: 'RINCON_1',
    name: 'Salon',
    host: '192.168.1.50',
  });

  assert.equal(device.external_id, 'ext:ext-dev-sonos:sonos:RINCON_1');
  assert.equal(device.name, 'Salon');
  assert.equal(device.features.length, 9);
  assert.equal(device.should_poll, true);
  assert.ok(device.poll_frequency > 0);

  const byExternalId = Object.fromEntries(
    device.features.map((f) => [f.external_id.split(':').pop(), f]),
  );
  assert.equal(byExternalId.play.external_id, 'ext:ext-dev-sonos:sonos:RINCON_1:play');
  assert.equal(byExternalId.volume.min, 0);
  assert.equal(byExternalId.volume.max, 100);
  assert.equal(byExternalId['playback-state'].read_only, true);
  // "Play URI" (command) and "Now playing" (sensor) are both free-text
  // features (category text, type text), told apart by read_only.
  assert.equal(byExternalId['play-uri'].category, 'text');
  assert.equal(byExternalId['play-uri'].read_only, false);
  assert.equal(byExternalId['now-playing'].category, 'text');
  assert.equal(byExternalId['now-playing'].read_only, true);
  assert.equal(byExternalId['play-notification'].category, 'music');
  assert.equal(
    byExternalId['play-notification'].type,
    DEVICE_FEATURE_TYPES.MUSIC.PLAY_NOTIFICATION,
  );
  assert.equal(byExternalId['play-notification'].read_only, false);
});

test('sonosUuidFromFeature extracts the uuid before the feature key', () => {
  assert.equal(sonosUuidFromFeature('ext:ext-dev-sonos:sonos:RINCON_1:playback-state'), 'RINCON_1');
  assert.equal(sonosUuidFromFeature('ext:ext-dev-sonos:sonos:RINCON_1:volume'), 'RINCON_1');
});

test('sonosUuidFromDevice extracts the last segment', () => {
  assert.equal(sonosUuidFromDevice('ext:ext-dev-sonos:sonos:RINCON_1'), 'RINCON_1');
});

// --- setDeviceValue dispatch -------------------------------------------------

function fakeClient(overrides = {}) {
  const calls = [];
  return {
    calls,
    play: async (uuid) => calls.push(['play', uuid]),
    pause: async (uuid) => calls.push(['pause', uuid]),
    next: async (uuid) => calls.push(['next', uuid]),
    previous: async (uuid) => calls.push(['previous', uuid]),
    setVolume: async (uuid, v) => calls.push(['setVolume', uuid, v]),
    playUri: async (uuid, uri) => calls.push(['playUri', uuid, uri]),
    playNotification: async (uuid, uri) => calls.push(['playNotification', uuid, uri]),
    ...overrides,
  };
}

test('setDeviceValue dispatches play/pause/next/previous/volume to the right uuid', async () => {
  const client = fakeClient();
  const feature = (type) => ({ external_id: 'ext:sel:sonos:RINCON_1:x', type });

  await setDeviceValue(client, feature('play'), 1);
  await setDeviceValue(client, feature('pause'), 1);
  await setDeviceValue(client, feature('next'), 1);
  await setDeviceValue(client, feature('previous'), 1);
  await setDeviceValue(client, feature('volume'), 42);

  assert.deepEqual(client.calls, [
    ['play', 'RINCON_1'],
    ['pause', 'RINCON_1'],
    ['next', 'RINCON_1'],
    ['previous', 'RINCON_1'],
    ['setVolume', 'RINCON_1', 42],
  ]);
});

test('setDeviceValue dispatches the "Play URI" text feature to playUri', async () => {
  const client = fakeClient();
  const feature = { external_id: 'ext:sel:sonos:RINCON_1:play-uri', type: 'text' };

  await setDeviceValue(client, feature, 'spotify:playlist:37i9dQZF1E8PXhqiaG89Vv');

  assert.deepEqual(client.calls, [
    ['playUri', 'RINCON_1', 'spotify:playlist:37i9dQZF1E8PXhqiaG89Vv'],
  ]);
});

test('setDeviceValue dispatches the "Play Notification" feature to playNotification', async () => {
  const client = fakeClient();
  const feature = {
    external_id: 'ext:sel:sonos:RINCON_1:play-notification',
    type: DEVICE_FEATURE_TYPES.MUSIC.PLAY_NOTIFICATION,
  };

  await setDeviceValue(client, feature, 'https://example.com/notification.mp3');

  assert.deepEqual(client.calls, [
    ['playNotification', 'RINCON_1', 'https://example.com/notification.mp3'],
  ]);
});

// --- pollDevice ---------------------------------------------------------------

test('pollDevice publishes playback-state, volume and now-playing from the client state', async () => {
  const gladys = createFakeGladys();
  const client = {
    getState: async () => ({
      transportState: 'PLAYING',
      volume: 37,
      nowPlaying: "Indochine — L'aventurier",
    }),
  };
  const device = { external_id: 'ext:ext-dev-sonos:sonos:RINCON_1', name: 'Salon' };

  await pollDevice(gladys, client, device);

  assert.deepEqual(gladys.published, [
    { featureExternalId: 'sonos:RINCON_1:playback-state', state: 1, text: undefined },
    { featureExternalId: 'sonos:RINCON_1:volume', state: 37, text: undefined },
    {
      featureExternalId: 'sonos:RINCON_1:now-playing',
      state: undefined,
      text: "Indochine — L'aventurier",
    },
  ]);
});

test('pollDevice reports paused for any non-playing transport state', async () => {
  const gladys = createFakeGladys();
  const client = { getState: async () => ({ transportState: 'PAUSED_PLAYBACK', volume: 10 }) };
  const device = { external_id: 'ext:ext-dev-sonos:sonos:RINCON_1', name: 'Salon' };

  await pollDevice(gladys, client, device);

  assert.equal(gladys.published[0].state, 0);
});

test('pollDevice swallows a client error instead of throwing', async () => {
  const gladys = createFakeGladys();
  const client = {
    getState: async () => {
      throw new Error('unreachable');
    },
  };
  const device = { external_id: 'ext:ext-dev-sonos:sonos:RINCON_1', name: 'Salon' };

  await pollDevice(gladys, client, device);

  assert.equal(gladys.published.length, 0);
});
