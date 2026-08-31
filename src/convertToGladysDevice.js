// -----------------------------------------------------------------------------
// Convert a Sonos device (from SonosClient.discover()) to a Gladys device.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { POLL_FREQUENCY_IN_MS } from './constants.js';

/**
 * Build a Gladys device from a Sonos device.
 * @param {object} gladys - The Gladys SDK instance (for externalIds).
 * @param {object} sonosDevice - A Sonos device ({ uuid, name, host }).
 * @returns {object} The Gladys device, with prefixed external ids.
 * @example
 * convertToGladysDevice(gladys, { uuid: 'RINCON_XXX', name: 'Salon', host: '192.168.1.50' });
 */
export function convertToGladysDevice(gladys, sonosDevice) {
  const ids = gladys.externalIds('sonos', sonosDevice.uuid);
  return {
    name: sonosDevice.name,
    external_id: ids.device,
    // Polled (see src/devices.js onPoll): this integration cannot receive
    // Sonos' UPnP eventing callbacks (the container is not reachable from the
    // Sonos LAN, unlike Gladys' native, host-networked Sonos service).
    // should_poll defaults to false in the core: omitting it means Gladys
    // never actually schedules onPoll for this device (poll_frequency alone
    // is not enough), and - observed live - re-publishing such a device
    // later crashes device.create with "Cannot read properties of undefined
    // (reading 'findIndex')" while it tries to clean up a poll-frequency
    // bucket that was consequently never created.
    should_poll: true,
    poll_frequency: POLL_FREQUENCY_IN_MS,
    features: [
      {
        name: `${sonosDevice.name} - Play`,
        external_id: ids.feature('play'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.PLAY,
        min: 0,
        max: 1,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${sonosDevice.name} - Pause`,
        external_id: ids.feature('pause'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.PAUSE,
        min: 0,
        max: 1,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${sonosDevice.name} - Previous`,
        external_id: ids.feature('previous'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.PREVIOUS,
        min: 0,
        max: 1,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${sonosDevice.name} - Next`,
        external_id: ids.feature('next'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.NEXT,
        min: 0,
        max: 1,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${sonosDevice.name} - Volume`,
        external_id: ids.feature('volume'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.VOLUME,
        min: 0,
        max: 100,
        keep_history: false,
        read_only: false,
        has_feedback: false,
      },
      {
        name: `${sonosDevice.name} - Playback state`,
        external_id: ids.feature('playback-state'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: DEVICE_FEATURE_TYPES.MUSIC.PLAYBACK_STATE,
        min: 0,
        max: 1,
        keep_history: false,
        read_only: true,
        has_feedback: false,
      },
      {
        name: `${sonosDevice.name} - Play URI`,
        external_id: ids.feature('play-uri'),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        // Same NOT NULL DB constraint as every other feature (see
        // gladys-spotify's "Contenu Spotify" for the same note): meaningless
        // here, min/max are not used for a free-text feature either.
        min: 0,
        max: 1,
        read_only: false,
        has_feedback: false,
        keep_history: false,
      },
      {
        name: `${sonosDevice.name} - Now playing`,
        external_id: ids.feature('now-playing'),
        category: DEVICE_FEATURE_CATEGORIES.TEXT,
        type: DEVICE_FEATURE_TYPES.TEXT.TEXT,
        min: 0,
        max: 1,
        read_only: true,
        has_feedback: false,
        keep_history: false,
      },
    ],
  };
}
