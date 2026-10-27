// -----------------------------------------------------------------------------
// Sonos integration constants.
// -----------------------------------------------------------------------------

import { DEVICE_POLL_FREQUENCIES } from '@gladysassistant/integration-sdk';

// Device type used to build the external ids: `ext:<selector>:sonos:<uuid>`.
export const DEVICE_TYPE = 'sonos';

// SSDP search target Sonos ZonePlayers answer to (mirrors the one used by
// @svrooij/sonos's own discovery, and by Gladys' native Sonos service).
export const SSDP_SEARCH_TARGET = 'urn:schemas-upnp-org:device:ZonePlayer:1';

// Default UPnP port of a Sonos ZonePlayer.
export const SONOS_PORT = 1400;

// Config keys DECLARED in the config_schema (typed by the user in the UI).
export const CONFIG_SCHEMA_KEYS = {
  // Newline/comma-separated list of known Sonos IP addresses: the fix for
  // installations where Gladys and the Sonos speakers sit on different
  // VLANs, so SSDP multicast (239.255.255.250:1900) never reaches them and
  // discovery silently returns nothing (a live, unresolved issue as of this
  // integration's design - see docs/en.md for the report it is based on).
  KNOWN_IPS: 'known_ips',
};

// How long a mediated SSDP scan listens for responses.
export const SSDP_SCAN_TIMEOUT_SECONDS = 5;

// Hard ceiling on one SonosManager initialization attempt (discovery or a
// known-IP topology seed): @svrooij/sonos's own SOAP calls have no built-in
// timeout, so an unreachable/unresponsive device would otherwise hang the
// whole scan forever instead of just failing that one attempt.
export const SONOS_INIT_TIMEOUT_MS = 8 * 1000;

// Same reasoning, for every SOAP call made AFTER discovery (play, pause,
// volume, play-uri, state poll): observed live against a real household
// where one speaker's SOAP endpoint hung indefinitely while every other
// speaker (including ones reached through it, via shared topology)
// responded normally - a single unresponsive unit must fail its own
// command, never hang the caller (Gladys' onSetValue/onPoll) forever.
export const SONOS_COMMAND_TIMEOUT_MS = 8 * 1000;

// Observed live: a Play() sent immediately after SwitchToQueue() sometimes
// leaves the speaker in PAUSED_PLAYBACK or TRANSITIONING (the transport
// source switch has not settled yet) even though neither call errors; 500ms
// was not enough, 3s reliably was in isolation, though it stayed
// intermittent end to end - see PLAY_URI_MAX_ATTEMPTS. This wait is cheaper
// and more honest than reporting success on a speaker not actually playing.
export const SWITCH_TO_QUEUE_SETTLE_MS = 3 * 1000;

// Enqueue+switch+play (playUri) proved intermittent even past the settle
// delay above: retrying the WHOLE sequence (not just Play()) is what
// reliably recovered live. Bounded to 2 full attempts.
export const PLAY_URI_MAX_ATTEMPTS = 2;

// Bounds playUri's background confirmation phase (confirmPlayUriStarted,
// not awaited by playUri itself - see its doc comment), generous enough for
// PLAY_URI_MAX_ATTEMPTS full retry sequences (each one enqueue + switch +
// play + the settle wait), so a legitimate retry is never cut short.
export const PLAY_URI_TIMEOUT_MS = PLAY_URI_MAX_ATTEMPTS * (SWITCH_TO_QUEUE_SETTLE_MS + 5 * 1000);

// How often the poll-driven state (playback state, volume) is refreshed.
// Must be one of the host's accepted DEVICE_POLL_FREQUENCIES (1s, 2s, 10s,
// 15s, 30s, 1min) or publishDiscoveredDevices is rejected (400); 15s keeps the
// now-playing position close to real time without hammering the speakers.
export const POLL_FREQUENCY_IN_MS = DEVICE_POLL_FREQUENCIES.EVERY_15_SECONDS;

// Map a @svrooij/sonos AVTransport state to the core's MUSIC_PLAYBACK_STATE
// (imported from the SDK: PAUSED 0, PLAYING 1, IDLE 2, BUFFERING 3). Anything
// unmapped (NO_MEDIA_PRESENT, STOPPED on some firmwares...) is reported IDLE.
export const TRANSPORT_STATE_TO_PLAYBACK = {
  PLAYING: 1,
  TRANSITIONING: 3,
  PAUSED_PLAYBACK: 0,
  STOPPED: 2,
  NO_MEDIA_PRESENT: 2,
};

// Sonos AVTransport PlayMode <-> (shuffle, repeat) of the MUSIC category.
// repeat uses the core's MUSIC_REPEAT_MODE (OFF 0, ALL 1, ONE 2). Sonos'
// "SHUFFLE" means shuffle + repeat-all, "SHUFFLE_NOREPEAT" shuffle only.
export const PLAY_MODE_TO_STATE = {
  NORMAL: { shuffle: 0, repeat: 0 },
  REPEAT_ALL: { shuffle: 0, repeat: 1 },
  REPEAT_ONE: { shuffle: 0, repeat: 2 },
  SHUFFLE_NOREPEAT: { shuffle: 1, repeat: 0 },
  SHUFFLE: { shuffle: 1, repeat: 1 },
  SHUFFLE_REPEAT_ONE: { shuffle: 1, repeat: 2 },
};

// (shuffle 0/1, repeat 0/1/2) -> the Sonos PlayMode to set. Keyed
// `${shuffle}:${repeat}` so a single write recomputes the whole mode from the
// other axis's last known value (Sonos has no independent shuffle/repeat set).
export const STATE_TO_PLAY_MODE = {
  '0:0': 'NORMAL',
  '0:1': 'REPEAT_ALL',
  '0:2': 'REPEAT_ONE',
  '1:0': 'SHUFFLE_NOREPEAT',
  '1:1': 'SHUFFLE',
  '1:2': 'SHUFFLE_REPEAT_ONE',
};

// Entry points shown at the root of the on-demand catalog (onMusicBrowse with
// parentId === null). Each `id` is a Sonos ContentDirectory ObjectID browsed
// for its children; these three are present on every household, with no music
// library share required (unlike `A:` objects).
export const CATALOG_ROOT = [
  { id: 'FV:2', label: { en: 'Sonos favorites', fr: 'Favoris Sonos' } },
  { id: 'SQ:', label: { en: 'Sonos playlists', fr: 'Playlists Sonos' } },
  { id: 'R:0/0', label: { en: 'Radio stations', fr: 'Radios' } },
];

// Largest page @svrooij/sonos' ContentDirectory Browse returns in one call,
// and the ceiling the core keeps per music answer anyway (100 MediaItems).
export const MUSIC_BROWSE_PAGE_SIZE = 100;

// Play Notification: matches Gladys' native Sonos service's own hardcoded
// values (server/services/sonos/lib/sonos.setValue.js), for the same "talk
// on a speaker" scene UX regardless of which of the two integrations a
// device belongs to.
//
// One real difference from native, that these constants cannot fix: native
// runs inside Gladys core (host-networked), so it receives the speaker's own
// UPnP "playback stopped" event and @svrooij/sonos's PlayNotification()
// reverts as soon as that fires. This integration runs in its own container
// (see convertToGladysDevice.js's should_poll comment: no UPnP eventing
// reaches it), so that event never arrives and PlayNotification always falls
// back to its `timeout` - the announcement's revert is not tied to how long
// the actual audio lasts, only to this fixed duration.
export const PLAY_NOTIFICATION_VOLUME_DEFAULT = 45;
export const PLAY_NOTIFICATION_TIMEOUT_SECONDS = 20;
export const PLAY_NOTIFICATION_DELAY_MS = 700;

// PlayNotification() can run the full PLAY_NOTIFICATION_TIMEOUT_SECONDS
// before reverting (see above) plus its own SOAP round trips: comfortably
// longer than SONOS_COMMAND_TIMEOUT_MS, which stays right for every other
// command.
export const PLAY_NOTIFICATION_COMMAND_TIMEOUT_MS = (PLAY_NOTIFICATION_TIMEOUT_SECONDS + 10) * 1000;
