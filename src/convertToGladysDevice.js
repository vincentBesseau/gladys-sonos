// -----------------------------------------------------------------------------
// Convert a Sonos device (from SonosClient.discover()) to a Gladys device.
//
// The speaker is published as a Gladys 5.3 "music player": the historical
// commands (play/pause/next/previous/volume/play_notification) PLUS the
// now-playing states of the `music` category (title, artist, album, artwork,
// duration, position, shuffle, repeat, mute, playback_state), fed on each
// poll through gladys.publishNowPlaying (see src/devices.js). The catalog,
// the queue and search are declared in the manifest (`music`) and answered on
// demand by the onMusic* handlers in index.js.
//
// Feature keys are the SDK's own `music` TYPE strings on purpose: that makes a
// feature's external_id exactly `${deviceExternalId}:${type}`, which is the
// default convention publishNowPlaying publishes to - no featureExternalIds
// mapping to keep in sync.
// -----------------------------------------------------------------------------

import { DEVICE_FEATURE_CATEGORIES, DEVICE_FEATURE_TYPES } from '@gladysassistant/integration-sdk';
import { POLL_FREQUENCY_IN_MS } from './constants.js';

const { MUSIC } = DEVICE_FEATURE_TYPES;

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

  // A momentary command (play, next...): nothing to read back, so neither
  // read-only nor fed with feedback.
  const command = (type, label, max = 1) => ({
    name: `${sonosDevice.name} - ${label}`,
    external_id: ids.feature(type),
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type,
    min: 0,
    max,
    keep_history: false,
    read_only: false,
    has_feedback: false,
  });

  // A read-only now-playing state (title, duration...): published by the
  // player, never written from Gladys.
  const sensor = (type, label, max = 1) => ({
    name: `${sonosDevice.name} - ${label}`,
    external_id: ids.feature(type),
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type,
    min: 0,
    max,
    keep_history: false,
    read_only: true,
    has_feedback: false,
  });

  // A writable now-playing state (volume, mute, position...): the player is
  // the source of truth, so has_feedback is true - the core stores nothing on
  // a write and shows the value the player confirms on the next poll (contract
  // capabilities/music.md).
  const writable = (type, label, max = 1) => ({
    name: `${sonosDevice.name} - ${label}`,
    external_id: ids.feature(type),
    category: DEVICE_FEATURE_CATEGORIES.MUSIC,
    type,
    min: 0,
    max,
    keep_history: false,
    read_only: false,
    has_feedback: true,
  });

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
      command(MUSIC.PLAY, 'Play'),
      command(MUSIC.PAUSE, 'Pause'),
      command(MUSIC.PREVIOUS, 'Previous'),
      command(MUSIC.NEXT, 'Next'),
      writable(MUSIC.VOLUME, 'Volume', 100),
      writable(MUSIC.MUTE, 'Mute'),
      // Relayed by the core as pause/play/stop on a write (0/1/2); reported as
      // PAUSED 0, PLAYING 1, IDLE 2 or BUFFERING 3.
      writable(MUSIC.PLAYBACK_STATE, 'Playback state', 3),
      sensor(MUSIC.TITLE, 'Title'),
      sensor(MUSIC.ARTIST, 'Artist'),
      sensor(MUSIC.ALBUM, 'Album'),
      // An image KEY served by the artwork proxy (publishNowPlaying derives it
      // from the album-art URL), never a URL.
      sensor(MUSIC.ARTWORK, 'Artwork'),
      // Seconds. 0 duration = unknown or a live stream.
      sensor(MUSIC.DURATION, 'Duration', 86400),
      // Seconds; writing it seeks within the current track.
      writable(MUSIC.POSITION, 'Position', 86400),
      writable(MUSIC.SHUFFLE, 'Shuffle'),
      // MUSIC_REPEAT_MODE: OFF 0, ALL 1, ONE 2.
      writable(MUSIC.REPEAT, 'Repeat', 2),
      {
        name: `${sonosDevice.name} - Play Notification`,
        external_id: ids.feature('play-notification'),
        category: DEVICE_FEATURE_CATEGORIES.MUSIC,
        type: MUSIC.PLAY_NOTIFICATION,
        // Matches Gladys' native Sonos service's own declaration for this
        // feature: min/max carry no meaning for a URI value, 1/1 is its
        // existing placeholder (same NOT NULL DB constraint noted on Play URI
        // below, just a different arbitrary pair).
        min: 1,
        max: 1,
        keep_history: false,
        read_only: false,
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
    ],
  };
}
