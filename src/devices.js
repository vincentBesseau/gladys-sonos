// -----------------------------------------------------------------------------
// Device orchestration: discovery, commands and the polled playback state.
//
// External ids are `ext:<selector>:sonos:<uuid>:<featureKey>`; the Sonos
// device uuid is the segment right before the feature key (or the last
// segment of the device external_id). A Sonos uuid has no ':', so a split is
// safe (RINCON_XXXXXXXXXXXXXXXXX01400, no colon ever appears in it).
// -----------------------------------------------------------------------------

import { logger, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';

import { convertToGladysDevice } from './convertToGladysDevice.js';
import { MUSIC_PLAYBACK_STATE, PLAYING_TRANSPORT_STATES } from './constants.js';

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
    case DEVICE_FEATURE_TYPES.MUSIC.PLAY:
      await client.play(uuid);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.PAUSE:
      await client.pause(uuid);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.NEXT:
      await client.next(uuid);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.PREVIOUS:
      await client.previous(uuid);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.VOLUME:
      await client.setVolume(uuid, value);
      break;
    case DEVICE_FEATURE_TYPES.MUSIC.PLAY_NOTIFICATION:
      // Not awaited by playNotification itself (see its doc comment) - this
      // call still resolves quickly, once the notification is dispatched.
      await client.playNotification(uuid, String(value));
      break;
    case DEVICE_FEATURE_TYPES.TEXT.TEXT:
      await client.playUri(uuid, String(value));
      break;
    default:
      logger.debug(`Sonos: unsupported feature type ${feature.type}, ignoring.`);
      break;
  }
}

/**
 * Poll and publish the playback-state and volume of a device.
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
  const playbackState = PLAYING_TRANSPORT_STATES.includes(state.transportState)
    ? MUSIC_PLAYBACK_STATE.PLAYING
    : MUSIC_PLAYBACK_STATE.PAUSED;
  await gladys.publishStates([
    { device_feature_external_id: ids.feature('playback-state'), state: playbackState },
    { device_feature_external_id: ids.feature('volume'), state: state.volume },
    { device_feature_external_id: ids.feature('now-playing'), text: state.nowPlaying },
  ]);
}
