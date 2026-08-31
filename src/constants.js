// -----------------------------------------------------------------------------
// Sonos integration constants.
// -----------------------------------------------------------------------------

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

// Generous enough for PLAY_URI_MAX_ATTEMPTS full sequences (each one enqueue
// + switch + play + the settle wait), so the outer timeout in runCommand
// never cuts a legitimate retry short.
export const PLAY_URI_TIMEOUT_MS = PLAY_URI_MAX_ATTEMPTS * (SWITCH_TO_QUEUE_SETTLE_MS + 5 * 1000);

// How often the poll-driven state (playback state, volume) is refreshed.
export const POLL_FREQUENCY_IN_MS = 15 * 1000;

// Gladys MUSIC playback-state values (mirror of the core's MUSIC_PLAYBACK_STATE).
export const MUSIC_PLAYBACK_STATE = {
  PAUSED: 0,
  PLAYING: 1,
};

// @svrooij/sonos TransportState values that count as "playing" for the
// playback-state feature; everything else (STOPPED, PAUSED_PLAYBACK,
// TRANSITIONING...) is reported as paused.
export const PLAYING_TRANSPORT_STATES = ['PLAYING'];
