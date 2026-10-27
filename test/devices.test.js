import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_FEATURE_TYPES, MUSIC_PLAYBACK_STATE } from '@gladysassistant/integration-sdk';

import { convertToGladysDevice } from '../src/convertToGladysDevice.js';
import {
  sonosUuidFromFeature,
  sonosUuidFromDevice,
  setDeviceValue,
  pollDevice,
  musicBrowse,
  musicSearch,
  musicPlay,
  musicQueueGet,
  musicQueuePlay,
} from '../src/devices.js';
import { createFakeGladys } from './helpers/fakeGladys.js';

const { MUSIC } = DEVICE_FEATURE_TYPES;

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

test('convertToGladysDevice publishes a full 5.3 music player', () => {
  const device = convertToGladysDevice(gladysStub, {
    uuid: 'RINCON_1',
    name: 'Salon',
    host: '192.168.1.50',
  });

  assert.equal(device.external_id, 'ext:ext-dev-sonos:sonos:RINCON_1');
  assert.equal(device.name, 'Salon');
  assert.equal(device.should_poll, true);
  assert.ok(device.poll_frequency > 0);

  const byKey = Object.fromEntries(device.features.map((f) => [f.external_id.split(':').pop(), f]));

  // Feature external_id keys are the SDK's own MUSIC type strings, so
  // publishNowPlaying's default `${device}:${type}` convention hits them.
  assert.equal(byKey.play.external_id, 'ext:ext-dev-sonos:sonos:RINCON_1:play');
  assert.equal(byKey[MUSIC.VOLUME].min, 0);
  assert.equal(byKey[MUSIC.VOLUME].max, 100);

  // The now-playing read-only states are present.
  for (const type of [MUSIC.TITLE, MUSIC.ARTIST, MUSIC.ALBUM, MUSIC.ARTWORK, MUSIC.DURATION]) {
    assert.ok(byKey[type], `missing feature ${type}`);
    assert.equal(byKey[type].read_only, true, `${type} must be read-only`);
  }

  // The writable states are the player's source of truth -> has_feedback.
  for (const type of [
    MUSIC.VOLUME,
    MUSIC.MUTE,
    MUSIC.PLAYBACK_STATE,
    MUSIC.POSITION,
    MUSIC.SHUFFLE,
    MUSIC.REPEAT,
  ]) {
    assert.ok(byKey[type], `missing feature ${type}`);
    assert.equal(byKey[type].read_only, false, `${type} must be writable`);
    assert.equal(byKey[type].has_feedback, true, `${type} must have feedback`);
  }

  assert.equal(byKey[MUSIC.REPEAT].max, 2); // OFF / ALL / ONE
  assert.equal(byKey[MUSIC.PLAYBACK_STATE].max, 3); // PAUSED/PLAYING/IDLE/BUFFERING

  // The historical text command stays, told apart by category.
  assert.equal(byKey['play-uri'].category, 'text');
  assert.equal(byKey['play-uri'].read_only, false);
  assert.equal(byKey['play-notification'].category, 'music');
  assert.equal(byKey['play-notification'].type, MUSIC.PLAY_NOTIFICATION);

  // The whole music category keeps no history (forced by the core).
  for (const feature of device.features) {
    assert.equal(feature.keep_history, false);
  }
});

test('sonosUuidFromFeature extracts the uuid before the feature key', () => {
  assert.equal(sonosUuidFromFeature('ext:ext-dev-sonos:sonos:RINCON_1:playback_state'), 'RINCON_1');
  assert.equal(sonosUuidFromFeature('ext:ext-dev-sonos:sonos:RINCON_1:volume'), 'RINCON_1');
});

test('sonosUuidFromDevice extracts the last segment', () => {
  assert.equal(sonosUuidFromDevice('ext:ext-dev-sonos:sonos:RINCON_1'), 'RINCON_1');
});

// --- setDeviceValue dispatch -------------------------------------------------

function fakeClient(overrides = {}) {
  const calls = [];
  const record =
    (name) =>
    (...args) => {
      calls.push([name, ...args]);
    };
  return {
    calls,
    play: record('play'),
    pause: record('pause'),
    stop: record('stop'),
    next: record('next'),
    previous: record('previous'),
    setVolume: record('setVolume'),
    setMute: record('setMute'),
    seek: record('seek'),
    setPlayMode: record('setPlayMode'),
    playUri: record('playUri'),
    playNotification: record('playNotification'),
    ...overrides,
  };
}

test('setDeviceValue dispatches the transport commands to the right uuid', async () => {
  const client = fakeClient();
  const feature = (type) => ({ external_id: `ext:sel:sonos:RINCON_1:${type}`, type });

  await setDeviceValue(client, feature(MUSIC.PLAY), 1);
  await setDeviceValue(client, feature(MUSIC.PAUSE), 1);
  await setDeviceValue(client, feature(MUSIC.NEXT), 1);
  await setDeviceValue(client, feature(MUSIC.PREVIOUS), 1);
  await setDeviceValue(client, feature(MUSIC.VOLUME), 42);

  assert.deepEqual(client.calls, [
    ['play', 'RINCON_1'],
    ['pause', 'RINCON_1'],
    ['next', 'RINCON_1'],
    ['previous', 'RINCON_1'],
    ['setVolume', 'RINCON_1', 42],
  ]);
});

test('setDeviceValue dispatches mute, seek, shuffle and repeat', async () => {
  const client = fakeClient();
  const feature = (type) => ({ external_id: `ext:sel:sonos:RINCON_1:${type}`, type });

  await setDeviceValue(client, feature(MUSIC.MUTE), 1);
  await setDeviceValue(client, feature(MUSIC.POSITION), 125);
  await setDeviceValue(client, feature(MUSIC.SHUFFLE), 1);
  await setDeviceValue(client, feature(MUSIC.REPEAT), 2);

  assert.deepEqual(client.calls, [
    ['setMute', 'RINCON_1', 1],
    ['seek', 'RINCON_1', 125],
    ['setPlayMode', 'RINCON_1', { shuffle: 1 }],
    ['setPlayMode', 'RINCON_1', { repeat: 2 }],
  ]);
});

test('setDeviceValue relays a playback_state write as play/pause/stop', async () => {
  const client = fakeClient();
  const feature = {
    external_id: 'ext:sel:sonos:RINCON_1:playback_state',
    type: MUSIC.PLAYBACK_STATE,
  };

  await setDeviceValue(client, feature, MUSIC_PLAYBACK_STATE.PLAYING);
  await setDeviceValue(client, feature, MUSIC_PLAYBACK_STATE.PAUSED);
  await setDeviceValue(client, feature, MUSIC_PLAYBACK_STATE.IDLE);

  assert.deepEqual(client.calls, [
    ['play', 'RINCON_1'],
    ['pause', 'RINCON_1'],
    ['stop', 'RINCON_1'],
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
    type: MUSIC.PLAY_NOTIFICATION,
  };

  await setDeviceValue(client, feature, 'https://example.com/notification.mp3');

  assert.deepEqual(client.calls, [
    ['playNotification', 'RINCON_1', 'https://example.com/notification.mp3'],
  ]);
});

// --- pollDevice ---------------------------------------------------------------

const fullState = {
  transportState: 'PLAYING',
  volume: 37,
  mute: 0,
  shuffle: 1,
  repeat: 1,
  title: "L'aventurier",
  artist: 'Indochine',
  album: 'Le Péril Jaune',
  albumArtUrl: 'http://192.168.1.50:1400/getaa?u=x',
  duration: 232,
  position: 42,
};

test('pollDevice publishes the now-playing snapshot through publishNowPlaying', async () => {
  const gladys = createFakeGladys();
  const client = { getState: async () => ({ ...fullState }) };
  const device = { external_id: 'ext:ext-dev-sonos:sonos:RINCON_1', name: 'Salon' };

  await pollDevice(gladys, client, device);

  assert.equal(gladys.nowPlaying.length, 1);
  const { deviceExternalId, snapshot } = gladys.nowPlaying[0];
  assert.equal(deviceExternalId, 'sonos:RINCON_1');
  assert.equal(snapshot.playback_state, MUSIC_PLAYBACK_STATE.PLAYING);
  assert.equal(snapshot.volume, 37);
  assert.equal(snapshot.shuffle, 1);
  assert.equal(snapshot.repeat, 1);
  assert.equal(snapshot.title, "L'aventurier");
  assert.equal(snapshot.artwork_url, 'http://192.168.1.50:1400/getaa?u=x');
  assert.equal(snapshot.duration, 232);
  assert.equal(snapshot.position, 42);
});

test('pollDevice maps transport states to the playback enum', async () => {
  const cases = [
    ['PLAYING', MUSIC_PLAYBACK_STATE.PLAYING],
    ['PAUSED_PLAYBACK', MUSIC_PLAYBACK_STATE.PAUSED],
    ['TRANSITIONING', MUSIC_PLAYBACK_STATE.BUFFERING],
    ['STOPPED', MUSIC_PLAYBACK_STATE.IDLE],
    ['SOMETHING_ELSE', MUSIC_PLAYBACK_STATE.IDLE],
  ];
  for (const [transportState, expected] of cases) {
    const gladys = createFakeGladys();
    const client = { getState: async () => ({ ...fullState, transportState }) };
    const device = { external_id: 'ext:ext-dev-sonos:sonos:RINCON_1', name: 'Salon' };
    await pollDevice(gladys, client, device);
    assert.equal(gladys.nowPlaying[0].snapshot.playback_state, expected, transportState);
  }
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

  assert.equal(gladys.nowPlaying.length, 0);
});

// --- music handlers (catalog / search / queue / play) ------------------------

const device = { external_id: 'ext:ext-dev-sonos:sonos:RINCON_1', name: 'Salon' };

test('musicBrowse at the root lists the household entry points as folders', async () => {
  const gladys = createFakeGladys();
  const client = {};
  const { items, total } = await musicBrowse(gladys, client, device, { parentId: null });

  assert.equal(total, 3);
  assert.deepEqual(
    items.map((i) => i.id),
    ['FV:2', 'SQ:', 'R:0/0'],
  );
  assert.ok(items.every((i) => i.type === 'folder' && i.browsable && !i.playable));
});

test('musicBrowse of a container maps items and proxies the artwork', async () => {
  const gladys = createFakeGladys();
  const client = {
    browse: async (uuid, parentId, offset, limit) => {
      assert.equal(uuid, 'RINCON_1');
      assert.equal(parentId, 'FV:2');
      assert.equal(offset, 0);
      assert.equal(limit, 50);
      return {
        total: 1,
        items: [
          {
            id: 'x-rincon-cpcontainer:1006',
            type: 'playlist',
            title: 'Road trip',
            subtitle: 'Spotify',
            duration: null,
            artworkUrl: 'http://192.168.1.50:1400/getaa?u=pl',
            browsable: false,
            playable: true,
          },
          // dropped: no title
          { id: 'y', type: 'track', title: '', browsable: false, playable: true },
        ],
      };
    },
  };

  const { items, total } = await musicBrowse(gladys, client, device, {
    parentId: 'FV:2',
    offset: 0,
    limit: 50,
  });

  assert.equal(total, 1);
  assert.equal(items.length, 1);
  assert.equal(items[0].id, 'x-rincon-cpcontainer:1006');
  assert.equal(items[0].subtitle, 'Spotify');
  assert.equal(items[0].artwork_key, 'art-0');
  assert.equal(gladys.artworkUrls.get('art-0'), 'http://192.168.1.50:1400/getaa?u=pl');
});

test('musicSearch maps the client results', async () => {
  const gladys = createFakeGladys();
  const client = {
    search: async (uuid, query, type, limit) => {
      assert.deepEqual([uuid, query, type, limit], ['RINCON_1', 'road', null, 10]);
      return {
        items: [
          { id: 'a', type: 'playlist', title: 'Road trip', browsable: false, playable: true },
        ],
      };
    },
  };
  const { items } = await musicSearch(gladys, client, device, {
    query: 'road',
    type: null,
    limit: 10,
  });
  assert.equal(items[0].title, 'Road trip');
});

test('musicPlay and musicQueuePlay forward to the client with the uuid', async () => {
  const calls = [];
  const client = {
    playMedia: async (...a) => calls.push(['playMedia', ...a]),
    playQueueItem: async (...a) => calls.push(['playQueueItem', ...a]),
  };
  await musicPlay(client, device, { id: 'x-rincon-cpcontainer:1', type: 'playlist' }, 'replace');
  await musicQueuePlay(client, device, 4);
  assert.deepEqual(calls, [
    ['playMedia', 'RINCON_1', 'x-rincon-cpcontainer:1', 'replace'],
    ['playQueueItem', 'RINCON_1', 4],
  ]);
});

test('musicQueueGet maps items and passes the current index through', async () => {
  const gladys = createFakeGladys();
  const client = {
    getQueue: async () => ({
      currentIndex: 1,
      total: 2,
      items: [
        { id: 'a', type: 'track', title: 'A', browsable: false, playable: true },
        { id: 'b', type: 'track', title: 'B', browsable: false, playable: true },
      ],
    }),
  };
  const page = await musicQueueGet(gladys, client, device, { offset: 0, limit: 50 });
  assert.equal(page.currentIndex, 1);
  assert.equal(page.total, 2);
  assert.deepEqual(
    page.items.map((i) => i.title),
    ['A', 'B'],
  );
});
