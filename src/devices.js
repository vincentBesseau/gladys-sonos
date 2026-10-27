// -----------------------------------------------------------------------------
// Device orchestration: discovery, commands, the polled now-playing snapshot,
// and the on-demand music catalog/queue/search handlers (Gladys 5.3).
//
// External ids are `ext:<selector>:sonos:<uuid>:<featureKey>`; the Sonos
// device uuid is the segment right before the feature key (or the last
// segment of the device external_id). A Sonos uuid has no ':', so a split is
// safe (RINCON_XXXXXXXXXXXXXXXXX01400, no colon ever appears in it).
// -----------------------------------------------------------------------------

import {
  logger,
  DEVICE_FEATURE_TYPES,
  MUSIC_PLAYBACK_STATE,
} from '@gladysassistant/integration-sdk';

import { convertToGladysDevice } from './convertToGladysDevice.js';
import { TRANSPORT_STATE_TO_PLAYBACK, CATALOG_ROOT } from './constants.js';

const { MUSIC, TEXT } = DEVICE_FEATURE_TYPES;

/**
 * Extract the Sonos device uuid from a feature external_id.
 * `ext:<selector>:sonos:<uuid>:<featureKey>` -> `<uuid>`.
 * @param {string} featureExternalId - The feature external id.
 * @returns {string} The Sonos device uuid.
 * @example
 * sonosUuidFromFeature('ext:sel:sonos:RINCON_1:play'); // 'RINCON_1'
 */
export function sonosUuidFromFeature(featureExternalId) {
  const parts = featureExternalId.split(':');
  return parts[parts.length - 2];
}

/**
 * Extract the Sonos device uuid from a device external_id.
 * `ext:<selector>:sonos:<uuid>` -> `<uuid>`.
 * @param {string} deviceExternalId - The device external id.
 * @returns {string} The Sonos device uuid.
 * @example
 * sonosUuidFromDevice('ext:sel:sonos:RINCON_1'); // 'RINCON_1'
 */
export function sonosUuidFromDevice(deviceExternalId) {
  const parts = deviceExternalId.split(':');
  return parts[parts.length - 1];
}

/**
 * Discover the Sonos household and build the Gladys devices to publish.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SonosClient} client - The Sonos client.
 * @param {Array<string>} knownIps - User-configured known IPs (see constants.js).
 * @param {Array<string>} [ssdpIps] - IPs from a mediated SSDP scan.
 * @returns {Promise<Array>} The Gladys devices to publish.
 * @example
 * const devices = await buildDiscoveredDevices(gladys, client, knownIps, ssdpIps);
 */
export async function buildDiscoveredDevices(gladys, client, knownIps, ssdpIps = []) {
  const sonosDevices = await client.discover(knownIps, ssdpIps);
  return sonosDevices.map((device) => convertToGladysDevice(gladys, device));
}

/**
 * Apply a command on a Sonos device feature.
 * @param {SonosClient} client - The Sonos client.
 * @param {object} feature - The Gladys device feature actioned.
 * @param {number|string} value - The new value.
 * @returns {Promise<void>} Resolves once the command is applied.
 * @example
 * await setDeviceValue(client, feature, 1);
 */
export async function setDeviceValue(client, feature, value) {
  const uuid = sonosUuidFromFeature(feature.external_id);
  switch (feature.type) {
    case MUSIC.PLAY:
      await client.play(uuid);
      break;
    case MUSIC.PAUSE:
      await client.pause(uuid);
      break;
    case MUSIC.NEXT:
      await client.next(uuid);
      break;
    case MUSIC.PREVIOUS:
      await client.previous(uuid);
      break;
    case MUSIC.VOLUME:
      await client.setVolume(uuid, value);
      break;
    case MUSIC.MUTE:
      await client.setMute(uuid, value);
      break;
    case MUSIC.POSITION:
      // A write to position is a seek (contract capabilities/music.md).
      await client.seek(uuid, Number(value));
      break;
    case MUSIC.SHUFFLE:
      await client.setPlayMode(uuid, { shuffle: Number(value) });
      break;
    case MUSIC.REPEAT:
      await client.setPlayMode(uuid, { repeat: Number(value) });
      break;
    case MUSIC.PLAYBACK_STATE:
      // The core relays a playback_state write as 0 pause / 1 play / 2 stop.
      if (Number(value) === MUSIC_PLAYBACK_STATE.PLAYING) {
        await client.play(uuid);
      } else if (Number(value) === MUSIC_PLAYBACK_STATE.IDLE) {
        await client.stop(uuid);
      } else {
        await client.pause(uuid);
      }
      break;
    case MUSIC.PLAY_NOTIFICATION:
      // Not awaited by playNotification itself (see its doc comment) - this
      // call still resolves quickly, once the notification is dispatched.
      await client.playNotification(uuid, String(value));
      break;
    case TEXT.TEXT:
      await client.playUri(uuid, String(value));
      break;
    default:
      logger.debug(`Sonos: unsupported feature type ${feature.type}, ignoring.`);
      break;
  }
}

/**
 * Poll and publish the full now-playing snapshot of a device. Uses
 * publishNowPlaying, which diffs against the last snapshot and sends only the
 * changed values (the position only on a real change/seek), keeping well under
 * the host's 300 states/minute budget even with a 15s poll.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SonosClient} client - The Sonos client.
 * @param {object} device - The Gladys device being polled (onPoll payload).
 * @returns {Promise<void>} Resolves once published.
 * @example
 * await pollDevice(gladys, client, device);
 */
export async function pollDevice(gladys, client, device) {
  const uuid = sonosUuidFromDevice(device.external_id);
  const ids = gladys.externalIds('sonos', uuid);
  let state;
  try {
    state = await client.getState(uuid);
  } catch (e) {
    logger.debug(`Sonos: unable to poll ${device.name}: ${e.message}`);
    return;
  }
  const playbackState =
    TRANSPORT_STATE_TO_PLAYBACK[state.transportState] ?? MUSIC_PLAYBACK_STATE.IDLE;
  await gladys.publishNowPlaying(ids.device, {
    playback_state: playbackState,
    volume: state.volume,
    mute: state.mute,
    shuffle: state.shuffle,
    repeat: state.repeat,
    title: state.title,
    artist: state.artist,
    album: state.album,
    artwork_url: state.albumArtUrl,
    duration: state.duration,
    position: state.position,
  });
}

/**
 * Turn a SonosClient raw catalog item into a core MediaItem: the artwork URL
 * becomes a proxy key (the only step that needs the Gladys SDK instance), and
 * optional fields are set only when present so the core keeps them.
 * @param {object} gladys - The Gladys SDK instance (for artworkKey).
 * @param {object} raw - A raw item from SonosClient.browse/search/getQueue.
 * @returns {object} The MediaItem.
 */
function toMediaItem(gladys, raw) {
  const item = {
    id: raw.id,
    type: raw.type,
    title: raw.title,
    browsable: raw.browsable,
    playable: raw.playable,
  };
  if (raw.subtitle) {
    item.subtitle = raw.subtitle;
  }
  if (raw.duration !== null && raw.duration !== undefined) {
    item.duration = raw.duration;
  }
  if (raw.artworkUrl) {
    item.artwork_key = gladys.artworkKey(raw.artworkUrl);
  }
  return item;
}

/**
 * A raw item the core would drop anyway (no id or no title) is left out here
 * so it never reaches the player with a warning.
 * @param {object} raw - A raw catalog item.
 * @returns {boolean} True when the item is usable.
 */
function isUsableItem(raw) {
  return Boolean(raw.id) && Boolean(raw.title);
}

/**
 * Answer onMusicBrowse: the root lists the household's entry points (favorites,
 * playlists, radios) as folders; a non-null parentId lists that object's
 * children.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SonosClient} client - The Sonos client.
 * @param {object} device - The Gladys device (onMusicBrowse payload).
 * @param {object} params - `{ parentId, offset, limit }`.
 * @returns {Promise<{items: Array, total: number}>} The page of MediaItems.
 */
export async function musicBrowse(gladys, client, device, { parentId, offset, limit }) {
  if (parentId === null || parentId === undefined) {
    const items = CATALOG_ROOT.map((entry) => ({
      id: entry.id,
      type: 'folder',
      title: entry.label.en,
      browsable: true,
      playable: false,
    }));
    return { items, total: items.length };
  }
  const uuid = sonosUuidFromDevice(device.external_id);
  const page = await client.browse(uuid, parentId, offset, limit);
  return {
    items: page.items.filter(isUsableItem).map((raw) => toMediaItem(gladys, raw)),
    total: page.total,
  };
}

/**
 * Answer onMusicSearch (best-effort over favorites and playlists - see
 * SonosClient.search).
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SonosClient} client - The Sonos client.
 * @param {object} device - The Gladys device (onMusicSearch payload).
 * @param {object} params - `{ query, type, limit }`.
 * @returns {Promise<{items: Array}>} The matching MediaItems.
 */
export async function musicSearch(gladys, client, device, { query, type, limit }) {
  const uuid = sonosUuidFromDevice(device.external_id);
  const page = await client.search(uuid, query, type, limit);
  return { items: page.items.filter(isUsableItem).map((raw) => toMediaItem(gladys, raw)) };
}

/**
 * Answer onMusicPlay: start a MediaItem on the speaker (a scene's
 * "music.play-media" action, a click in the player).
 * @param {SonosClient} client - The Sonos client.
 * @param {object} device - The Gladys device (onMusicPlay payload).
 * @param {object} media - `{ id, type }` of this integration's own catalog.
 * @param {string} mode - replace | next | append.
 * @returns {Promise<void>} Resolves once dispatched.
 */
export async function musicPlay(client, device, media, mode) {
  const uuid = sonosUuidFromDevice(device.external_id);
  await client.playMedia(uuid, media.id, mode);
}

/**
 * Answer onMusicQueueGet.
 * @param {object} gladys - The Gladys SDK instance.
 * @param {SonosClient} client - The Sonos client.
 * @param {object} device - The Gladys device (onMusicQueueGet payload).
 * @param {object} params - `{ offset, limit }`.
 * @returns {Promise<{items: Array, currentIndex: number|null, total: number}>} The queue page.
 */
export async function musicQueueGet(gladys, client, device, { offset, limit }) {
  const uuid = sonosUuidFromDevice(device.external_id);
  const page = await client.getQueue(uuid, offset, limit);
  return {
    items: page.items.filter(isUsableItem).map((raw) => toMediaItem(gladys, raw)),
    currentIndex: page.currentIndex,
    total: page.total,
  };
}

/**
 * Answer onMusicQueuePlay: jump to the queue item at `index`.
 * @param {SonosClient} client - The Sonos client.
 * @param {object} device - The Gladys device (onMusicQueuePlay payload).
 * @param {number} index - The 0-based index in the full queue.
 * @returns {Promise<void>} Resolves once dispatched.
 */
export async function musicQueuePlay(client, device, index) {
  const uuid = sonosUuidFromDevice(device.external_id);
  await client.playQueueItem(uuid, index);
}
