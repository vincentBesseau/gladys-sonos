// -----------------------------------------------------------------------------
// Sonos local control client, wrapping @svrooij/sonos.
//
// Discovery strategy (the reason this integration exists alongside Gladys'
// native Sonos service): a Sonos household shares its FULL topology (every
// room, whatever its IP) from any single reachable member's
// ZoneGroupTopology service - SonosManager.InitializeFromDevice(oneKnownIp)
// exploits exactly that. So when SSDP multicast cannot cross a VLAN boundary
// (the integration exists to fix this - see docs/en.md), ONE user-entered
// "known IP" is normally enough to recover every room, not just that one
// speaker; call InitializeWithDiscovery() too so a plain single-LAN
// household needs no configuration at all. Both results are merged and
// deduplicated by uuid.
//
// No UPnP eventing: an external integration container is not reachable from
// the Sonos speakers' own NOTIFY callbacks (unlike the native service, which
// runs on the host network). State is polled instead (see src/devices.js).
// -----------------------------------------------------------------------------

import { SonosManager, SonosDevice } from '@svrooij/sonos';
import { logger } from '@gladysassistant/integration-sdk';

import {
  SONOS_PORT,
  SONOS_INIT_TIMEOUT_MS,
  SONOS_COMMAND_TIMEOUT_MS,
  SWITCH_TO_QUEUE_SETTLE_MS,
  PLAY_URI_MAX_ATTEMPTS,
  PLAY_URI_TIMEOUT_MS,
  PLAY_NOTIFICATION_VOLUME_DEFAULT,
  PLAY_NOTIFICATION_TIMEOUT_SECONDS,
  PLAY_NOTIFICATION_DELAY_MS,
  PLAY_NOTIFICATION_COMMAND_TIMEOUT_MS,
  PLAY_MODE_TO_STATE,
  STATE_TO_PLAY_MODE,
  MUSIC_BROWSE_PAGE_SIZE,
} from './constants.js';

/**
 * Reject with a timeout error if `promise` has not settled within `ms`.
 * @param {Promise} promise - The promise to bound.
 * @param {number} ms - The timeout, in milliseconds.
 * @returns {Promise} A promise that resolves/rejects like `promise`, or
 *   rejects with a timeout error first.
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/**
 * Build a "Now playing" display string from the raw TrackMetaData
 * @svrooij/sonos's GetPositionInfo() returns. That field is either an
 * already-parsed DIDL object ({ Title, Artist, ... }), the literal string
 * `'NOT_IMPLEMENTED'`, or empty when nothing is queued - never throw on
 * whichever of these actually comes back.
 * @param {object|string|undefined} trackMetaData - The raw TrackMetaData.
 * @returns {string} `"Artist — Title"`, just the title, or '' if unknown.
 * @example
 * formatNowPlaying({ Title: "L'aventurier", Artist: 'Indochine' });
 * // "Indochine — L'aventurier"
 */
export function formatNowPlaying(trackMetaData) {
  if (!trackMetaData || typeof trackMetaData !== 'object') {
    return '';
  }
  const { Title: title, Artist: artist } = trackMetaData;
  if (!title) {
    return '';
  }
  return artist ? `${artist} — ${title}` : title;
}

/**
 * Parse a Sonos duration/position string (`H:MM:SS`, `HH:MM:SS`) into whole
 * seconds. Sonos also returns `'NOT_IMPLEMENTED'` or `''` for live streams and
 * sources without a timeline - both read as 0.
 * @param {string|number|undefined} value - The raw TrackDuration/RelTime.
 * @returns {number} The duration in seconds (0 when unknown).
 * @example
 * parseDurationToSeconds('0:03:12'); // 192
 */
export function parseDurationToSeconds(value) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }
  if (typeof value !== 'string' || !/^\d+:\d{1,2}:\d{1,2}$/.test(value.trim())) {
    return 0;
  }
  return value
    .trim()
    .split(':')
    .reduce((total, part) => total * 60 + Number(part), 0);
}

/**
 * Format whole seconds as the `H:MM:SS` string Sonos' Seek (REL_TIME) expects.
 * @param {number} seconds - A non-negative number of seconds.
 * @returns {string} The `H:MM:SS` representation.
 * @example
 * formatSeconds(192); // '0:03:12'
 */
export function formatSeconds(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return `${h}:${pad(m)}:${pad(s)}`;
}

/**
 * Turn a Sonos album-art reference into an absolute URL the integration's
 * container can fetch (the artwork proxy records it, see src/devices.js). Sonos
 * returns a path relative to the speaker (`/getaa?...`); an already-absolute
 * `http(s)` URL is kept, anything else (no artwork) becomes null.
 * @param {string} host - The speaker host the track was read from.
 * @param {string|undefined} uri - The raw AlbumArtUri.
 * @returns {string|null} The absolute URL, or null when there is no artwork.
 * @example
 * absoluteArtworkUrl('192.168.1.50', '/getaa?u=x&v=1'); // 'http://192.168.1.50:1400/getaa?u=x&v=1'
 */
export function absoluteArtworkUrl(host, uri) {
  if (typeof uri !== 'string' || uri.length === 0) {
    return null;
  }
  if (/^https?:\/\//i.test(uri)) {
    return uri;
  }
  if (uri.startsWith('/')) {
    return `http://${host}:${SONOS_PORT}${uri}`;
  }
  return null;
}

/**
 * Map a DIDL-Lite UPnP class to one of the core's MUSIC_MEDIA_TYPES. An
 * unknown or missing class is read as a plain track - the most permissive
 * "playable leaf" default.
 * @param {string|undefined} upnpClass - The item's UpnpClass.
 * @returns {string} One of track|album|artist|playlist|radio|folder.
 * @example
 * upnpClassToMediaType('object.container.album.musicAlbum'); // 'album'
 */
export function upnpClassToMediaType(upnpClass) {
  const value = String(upnpClass || '').toLowerCase();
  if (value.includes('musicartist')) {
    return 'artist';
  }
  if (value.includes('album')) {
    return 'album';
  }
  if (value.includes('playlist')) {
    return 'playlist';
  }
  if (value.includes('audiobroadcast') || value.includes('radio')) {
    return 'radio';
  }
  if (value.includes('container')) {
    return 'folder';
  }
  return 'track';
}

/**
 * Whether a DIDL-Lite UPnP class denotes a browsable container.
 * @param {string|undefined} upnpClass - The item's UpnpClass.
 * @returns {boolean} True for a container.
 */
function isContainer(upnpClass) {
  return String(upnpClass || '')
    .toLowerCase()
    .includes('container');
}

/**
 * Whether a MediaItem id is already a Sonos transport URI (vs a
 * ContentDirectory ObjectID that must be resolved through BrowseMetadata
 * first). ObjectIDs look like `FV:2/12`, `SQ:3` or `A:ALBUM/...`: no scheme.
 * @param {string} id - The MediaItem id.
 * @returns {boolean} True when it can be enqueued directly.
 */
function looksLikeUri(id) {
  return /:\/\//.test(id) || /^(x-|https?:|spotify:|mp3radio:)/i.test(id);
}

/**
 * Turn a parsed @svrooij/sonos Track into the raw catalog item the music
 * handlers map to a MediaItem (the artwork key is added in src/devices.js,
 * where the Gladys SDK instance lives). A container keeps its ObjectID as id
 * (so it can be browsed into); a leaf keeps its transport URI (so it can be
 * played without a metadata round trip).
 * @param {object} track - A Track from a Browse/queue result.
 * @param {string} host - The speaker host it was read from (for artwork URLs).
 * @returns {object} `{ id, type, title, subtitle, duration, artworkUrl, browsable, playable }`.
 */
export function mapTrackToItem(track, host) {
  const container = isContainer(track.UpnpClass);
  const type = upnpClassToMediaType(track.UpnpClass);
  const id = container ? track.ItemId || track.TrackUri : track.TrackUri || track.ItemId;
  const durationSeconds = parseDurationToSeconds(track.Duration);
  return {
    id: id || '',
    type,
    title: track.Title || '',
    subtitle: track.Artist || track.Album || '',
    duration: !container && durationSeconds > 0 ? durationSeconds : null,
    artworkUrl: absoluteArtworkUrl(host, track.AlbumArtUri),
    browsable: container,
    // A storage folder is only a shelf; everything else (album, playlist,
    // radio, track, favorite) can be started directly.
    playable: type !== 'folder',
  };
}

/**
 * Parse a user-entered "known IPs" config value into a list of trimmed,
 * non-empty entries (newline, comma or whitespace separated).
 * @param {string} rawValue - The raw config_schema field value.
 * @returns {Array<string>} The known IPs/hostnames, in the order given.
 * @example
 * parseKnownIps('192.168.10.21, 192.168.10.22\n192.168.10.23'); // 3 entries
 */
export function parseKnownIps(rawValue) {
  return String(rawValue || '')
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

export class SonosClient {
  constructor() {
    // uuid -> SonosDevice (from the last successful discover() call).
    this.devicesByUuid = new Map();
  }

  /**
   * Discover the Sonos household: merge a discovery-based scan with a
   * topology lookup seeded from each configured known IP, until one seed
   * succeeds (trying every one only helps when the household itself is
   * split, which does not happen in practice, but costs nothing to attempt).
   * @param {Array<string>} knownIps - User-configured known IPs/hostnames.
   * @param {Array<string>} [ssdpIps] - IPs from a mediated SSDP scan, tried
   *   as additional topology seeds (works even where discovery already
   *   partially reaches the household, and is a no-op otherwise).
   * @returns {Promise<Array>} The discovered Sonos devices ({ uuid, name, host }).
   */
  async discover(knownIps, ssdpIps = []) {
    const seeds = [...new Set([...knownIps, ...ssdpIps])];
    const foundByUuid = new Map();

    const tryManager = async (init) => {
      const manager = new SonosManager();
      try {
        await withTimeout(init(manager), SONOS_INIT_TIMEOUT_MS);
      } catch (e) {
        logger.debug(`Sonos: discovery attempt failed: ${e.message}`);
        return;
      }
      for (const device of manager.Devices) {
        foundByUuid.set(device.uuid, device);
      }
    };

    // A plain single-LAN household needs no configuration: try discovery
    // first, regardless of whether known IPs are also configured.
    await tryManager((manager) => manager.InitializeWithDiscovery(10));

    // Each known IP is tried as a topology seed too, even if discovery
    // already found devices: it is the only way to reach a household split
    // across a VLAN boundary discovery cannot cross. A handful of extra
    // round trips on a background scan is a fine price for that coverage.
    for (const ip of seeds) {
      await tryManager((manager) => manager.InitializeFromDevice(ip, SONOS_PORT));
    }

    this.devicesByUuid = foundByUuid;
    return [...foundByUuid.values()].map((device) => ({
      uuid: device.uuid,
      name: device.name,
      host: device.host,
    }));
  }

  /**
   * Get the live SonosDevice instance for a uuid (from the last discover()).
   * @param {string} uuid - The Sonos device uuid.
   * @returns {object} The @svrooij/sonos SonosDevice instance.
   * @throws {Error} If the device was not seen in the last discovery.
   */
  deviceFor(uuid) {
    const device = this.devicesByUuid.get(uuid);
    if (!device) {
      throw new Error('This Sonos speaker is currently unreachable: run a scan and try again.');
    }
    return device;
  }

  /**
   * A FRESH, standalone SonosDevice for a uuid - not the instance discover()
   * built (which SonosManager wires into its own group/event tracking).
   * Needed by playUri and playNotification: see playUri's doc comment for
   * why a manager-tracked instance was observed to behave unreliably for a
   * multi-call command sequence.
   * @param {string} uuid - The Sonos device uuid.
   * @returns {object} A new, standalone @svrooij/sonos SonosDevice instance.
   * @throws {Error} If the device was not seen in the last discovery.
   */
  freshDeviceFor(uuid) {
    const discoveredDevice = this.deviceFor(uuid);
    return new SonosDevice(discoveredDevice.host, discoveredDevice.port, discoveredDevice.uuid);
  }

  /**
   * Run one command against a device's SOAP endpoint, bounded by a timeout:
   * a single unresponsive speaker fails its own command instead of hanging
   * the caller forever (observed live - see SONOS_COMMAND_TIMEOUT_MS's doc
   * comment).
   * @param {string} uuid - The Sonos device uuid.
   * @param {Function} action - Called with the live SonosDevice instance.
   * @param {number} [timeoutMs] - Overrides SONOS_COMMAND_TIMEOUT_MS.
   * @returns {Promise<*>} Whatever `action` resolves to.
   * @throws {Error} If the device is unknown, or the command times out/fails.
   */
  async runCommand(uuid, action, timeoutMs = SONOS_COMMAND_TIMEOUT_MS) {
    const device = this.deviceFor(uuid);
    try {
      return await withTimeout(action(device), timeoutMs);
    } catch (e) {
      throw new Error(`Sonos speaker "${device.name}" did not respond: ${e.message}`, { cause: e });
    }
  }

  /**
   * Play on a device (resumes the current queue/context).
   * @param {string} uuid - The Sonos device uuid.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async play(uuid) {
    await this.runCommand(uuid, (device) => device.Play());
  }

  /**
   * Pause a device.
   * @param {string} uuid - The Sonos device uuid.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async pause(uuid) {
    await this.runCommand(uuid, (device) => device.Pause());
  }

  /**
   * Skip to the next track on a device.
   * @param {string} uuid - The Sonos device uuid.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async next(uuid) {
    await this.runCommand(uuid, (device) => device.Next());
  }

  /**
   * Skip to the previous track on a device.
   * @param {string} uuid - The Sonos device uuid.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async previous(uuid) {
    await this.runCommand(uuid, (device) => device.Previous());
  }

  /**
   * Set the volume of a device.
   * @param {string} uuid - The Sonos device uuid.
   * @param {number} volumePercent - The volume, 0-100.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async setVolume(uuid, volumePercent) {
    await this.runCommand(uuid, (device) => device.SetVolume(Math.round(Number(volumePercent))));
  }

  /**
   * Load and start playing an arbitrary content URI (Spotify, a stream...).
   *
   * A cloud-service container URI (a Spotify playlist/album, `x-rincon-
   * cpcontainer:...`) is REJECTED by Sonos with UPnP error 714 ("Illegal
   * MIME-Type") when set directly as the transport's CurrentURI - confirmed
   * live, including with a verbatim URI/token copied from one of this
   * household's own working Sonos favorites, ruling out a metadata mistake.
   * The working sequence (also confirmed live, and matching the SoCo/Home
   * Assistant community's documented fix for the same error) is to enqueue
   * the content, then point the transport at the LOCAL queue instead:
   *   1. AddUriToQueue(uri, 1, true) - insert at the front, play next;
   *   2. SwitchToQueue() - point CurrentURI at `x-rincon-queue:<uuid>#0`;
   *   3. Play().
   * Metadata (including the Spotify service token) is guessed by
   * @svrooij/sonos itself from the URI shape.
   *
   * Confirming playback actually started, and retrying the whole sequence
   * if the speaker was left paused (observed live - see
   * confirmPlayUriStarted), is NOT awaited here: even a single settle wait
   * (SWITCH_TO_QUEUE_SETTLE_MS) routinely pushes past Gladys core's fixed,
   * non-overridable 5s command-ack window for a device command
   * (externalIntegration.sendCommand.js's COMMAND_TIMEOUT_MS) - a command
   * that is actually working must never look like a failed/timed-out one.
   * @param {string} uuid - The Sonos device uuid.
   * @param {string} uri - The content URI (e.g. `spotify:playlist:...`).
   * @returns {Promise<void>} Resolves once the content is queued and the
   *   transport pointed at it (not once playback is confirmed - see above).
   */
  async playUri(uuid, uri) {
    // A FRESH, standalone SonosDevice for the actual command (see
    // freshDeviceFor's doc comment) - observed live: back-to-back
    // AddUriToQueue + SwitchToQueue + Play on the manager-tracked instance
    // intermittently left the speaker in PAUSED_PLAYBACK with no error,
    // while the exact same sequence on a fresh instance succeeded every
    // time in isolation.
    const device = this.freshDeviceFor(uuid);
    try {
      await withTimeout(
        (async () => {
          await device.AddUriToQueue(uri, 1, true);
          await device.SwitchToQueue();
          await device.Play();
        })(),
        SONOS_COMMAND_TIMEOUT_MS,
      );
    } catch (e) {
      throw new Error(`Sonos speaker "${device.name}" did not respond: ${e.message}`, { cause: e });
    }
    withTimeout(this.confirmPlayUriStarted(device, uri), PLAY_URI_TIMEOUT_MS).catch((e) => {
      logger.debug(`Sonos: playUri confirmation failed on ${device.name}: ${e.message}`);
    });
  }

  /**
   * Confirm a playUri() dispatch actually started playback, retrying the
   * whole enqueue+switch+play sequence (bounded, PLAY_URI_MAX_ATTEMPTS) if
   * the speaker was left paused - observed live: intermittent, a settle
   * wait after SwitchToQueue()+Play() is not always enough on the first
   * try. Not awaited by playUri - see its doc comment for why.
   * @param {object} device - The fresh SonosDevice playUri already dispatched to.
   * @param {string} uri - The content URI, replayed on a retry.
   * @returns {Promise<void>} Resolves once confirmed, or the attempt ceiling is hit.
   */
  async confirmPlayUriStarted(device, uri) {
    let lastState = null;
    for (let attempt = 1; attempt <= PLAY_URI_MAX_ATTEMPTS; attempt += 1) {
      await new Promise((resolve) => setTimeout(resolve, SWITCH_TO_QUEUE_SETTLE_MS));
      ({ CurrentTransportState: lastState } = await device.AVTransportService.GetTransportInfo());
      if (lastState === 'PLAYING' || lastState === 'TRANSITIONING') {
        return;
      }
      if (attempt < PLAY_URI_MAX_ATTEMPTS) {
        logger.debug(
          `Sonos: playUri left ${device.name} ${lastState}, retrying (attempt ${attempt + 1}).`,
        );
        await device.AddUriToQueue(uri, 1, true);
        await device.SwitchToQueue();
        await device.Play();
      }
    }
    // The playback-state feature (polled independently) will still reflect
    // the true outcome; this is the only place that can explain why.
    logger.warn(
      `Sonos: content queued on ${device.name} but playback did not start (still ${lastState}).`,
    );
  }

  /**
   * Read the full now-playing snapshot of a device: transport state, volume,
   * mute, shuffle/repeat (from the coordinator's PlayMode) and the current
   * track's title/artist/album/artwork/duration/position. Playback-related
   * values are read from the group coordinator (the speaker that actually
   * drives the stream), volume/mute from the speaker itself (per-room).
   * @param {string} uuid - The Sonos device uuid.
   * @returns {Promise<object>} `{ transportState, volume, mute, shuffle, repeat,
   *   title, artist, album, albumArtUrl, duration, position }`.
   */
  async getState(uuid) {
    return this.runCommand(uuid, async (device) => {
      const coordinator = device.Coordinator;
      const [transportInfo, volumeInfo, muteInfo, positionInfo, transportSettings] =
        await Promise.all([
          coordinator.AVTransportService.GetTransportInfo(),
          device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' }),
          device.RenderingControlService.GetMute({ InstanceID: 0, Channel: 'Master' }),
          coordinator.AVTransportService.GetPositionInfo(),
          coordinator.AVTransportService.GetTransportSettings(),
        ]);
      const meta =
        positionInfo.TrackMetaData && typeof positionInfo.TrackMetaData === 'object'
          ? positionInfo.TrackMetaData
          : {};
      const mode = PLAY_MODE_TO_STATE[transportSettings.PlayMode] || { shuffle: 0, repeat: 0 };
      return {
        transportState: transportInfo.CurrentTransportState,
        volume: volumeInfo.CurrentVolume,
        mute: muteInfo.CurrentMute ? 1 : 0,
        shuffle: mode.shuffle,
        repeat: mode.repeat,
        title: meta.Title || '',
        artist: meta.Artist || '',
        album: meta.Album || '',
        albumArtUrl: absoluteArtworkUrl(device.host, meta.AlbumArtUri),
        duration: parseDurationToSeconds(positionInfo.TrackDuration),
        position: parseDurationToSeconds(positionInfo.RelTime),
      };
    });
  }

  /**
   * Stop playback on a device (the "stop" leg of a playback_state write).
   * @param {string} uuid - The Sonos device uuid.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async stop(uuid) {
    await this.runCommand(uuid, (device) => device.Stop());
  }

  /**
   * Mute or unmute a device (independent of its volume level).
   * @param {string} uuid - The Sonos device uuid.
   * @param {boolean|number} muted - Truthy to mute.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async setMute(uuid, muted) {
    await this.runCommand(uuid, (device) =>
      device.RenderingControlService.SetMute({
        InstanceID: 0,
        Channel: 'Master',
        DesiredMute: Boolean(Number(muted)),
      }),
    );
  }

  /**
   * Seek to an absolute position within the current track.
   * @param {string} uuid - The Sonos device uuid.
   * @param {number} seconds - The target position, in seconds.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async seek(uuid, seconds) {
    await this.runCommand(uuid, (device) => device.SeekPosition(formatSeconds(seconds)));
  }

  /**
   * Change ONE axis of the coordinator's play mode (shuffle or repeat),
   * preserving the other. Sonos has a single combined PlayMode, so the current
   * one is read, the given axis overridden, and the resulting mode written.
   * @param {string} uuid - The Sonos device uuid.
   * @param {{shuffle?: number, repeat?: number}} axis - The axis to change.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async setPlayMode(uuid, axis) {
    await this.runCommand(uuid, async (device) => {
      const coordinator = device.Coordinator;
      const current = await coordinator.AVTransportService.GetTransportSettings();
      const state = PLAY_MODE_TO_STATE[current.PlayMode] || { shuffle: 0, repeat: 0 };
      const shuffle = axis.shuffle !== undefined ? Number(axis.shuffle) : state.shuffle;
      const repeat = axis.repeat !== undefined ? Number(axis.repeat) : state.repeat;
      const newPlayMode = STATE_TO_PLAY_MODE[`${shuffle}:${repeat}`] || 'NORMAL';
      await coordinator.AVTransportService.SetPlayMode({ InstanceID: 0, NewPlayMode: newPlayMode });
    });
  }

  /**
   * Browse a page of a ContentDirectory object's children (favorites, a
   * playlist, an album...) and return the raw catalog items.
   * @param {string} uuid - The Sonos device uuid.
   * @param {string} objectId - The ContentDirectory ObjectID to list.
   * @param {number} [offset] - The first child index (0-based).
   * @param {number} [limit] - How many children to return.
   * @returns {Promise<{items: Array<object>, total: number}>} The page and the
   *   full child count.
   */
  async browse(uuid, objectId, offset = 0, limit = MUSIC_BROWSE_PAGE_SIZE) {
    return this.runCommand(uuid, async (device) => {
      const response = await device.ContentDirectoryService.BrowseParsed({
        ObjectID: objectId,
        BrowseFlag: 'BrowseDirectChildren',
        Filter: '*',
        StartingIndex: offset,
        RequestedCount: limit,
        SortCriteria: '',
      });
      const tracks = Array.isArray(response.Result) ? response.Result : [];
      return {
        items: tracks.map((track) => mapTrackToItem(track, device.host)),
        total: Number(response.TotalMatches) || tracks.length,
      };
    });
  }

  /**
   * Best-effort catalog search: Sonos exposes no cross-service text search
   * locally, so this lists the household's favorites and Sonos playlists and
   * keeps the items whose title or subtitle matches `query` (optionally
   * filtered by media type). Enough for "play my <favorite>" from a scene or
   * the player's search box, without a music-library share.
   * @param {string} uuid - The Sonos device uuid.
   * @param {string} query - The search text.
   * @param {string|null} [type] - A MUSIC_MEDIA_TYPES filter, or null.
   * @param {number} [limit] - Maximum number of items to return.
   * @returns {Promise<{items: Array<object>}>} The matching items.
   */
  async search(uuid, query, type = null, limit = MUSIC_BROWSE_PAGE_SIZE) {
    const needle = String(query || '')
      .trim()
      .toLowerCase();
    if (needle.length === 0) {
      return { items: [] };
    }
    const sources = ['FV:2', 'SQ:'];
    const seen = new Set();
    const items = [];
    for (const objectId of sources) {
      let page;
      try {
        page = await this.browse(uuid, objectId, 0, MUSIC_BROWSE_PAGE_SIZE);
      } catch (e) {
        logger.debug(`Sonos: search could not read ${objectId}: ${e.message}`);
        continue;
      }
      for (const item of page.items) {
        const haystack = `${item.title} ${item.subtitle}`.toLowerCase();
        if (
          !seen.has(item.id) &&
          haystack.includes(needle) &&
          (type === null || type === undefined || item.type === type)
        ) {
          seen.add(item.id);
          items.push(item);
          if (items.length >= limit) {
            return { items };
          }
        }
      }
    }
    return { items };
  }

  /**
   * Read a page of the current playback queue, with the index of the track
   * playing now (null when the queue is empty or nothing is loaded).
   * @param {string} uuid - The Sonos device uuid.
   * @param {number} [offset] - The first queue index (0-based).
   * @param {number} [limit] - How many entries to return.
   * @returns {Promise<{items: Array<object>, currentIndex: number|null, total: number}>} The page.
   */
  async getQueue(uuid, offset = 0, limit = MUSIC_BROWSE_PAGE_SIZE) {
    return this.runCommand(uuid, async (device) => {
      const [response, positionInfo] = await Promise.all([
        device.ContentDirectoryService.BrowseParsed({
          ObjectID: 'Q:0',
          BrowseFlag: 'BrowseDirectChildren',
          Filter: '*',
          StartingIndex: offset,
          RequestedCount: limit,
          SortCriteria: '',
        }),
        device.Coordinator.AVTransportService.GetPositionInfo(),
      ]);
      const tracks = Array.isArray(response.Result) ? response.Result : [];
      // GetPositionInfo.Track is the 1-based position in the queue; 0 means
      // nothing is loaded from the queue.
      const currentIndex = positionInfo.Track > 0 ? positionInfo.Track - 1 : null;
      return {
        items: tracks.map((track) => mapTrackToItem(track, device.host)),
        currentIndex,
        total: Number(response.TotalMatches) || tracks.length,
      };
    });
  }

  /**
   * Jump to a track in the current queue by its (0-based) index and play it.
   * @param {string} uuid - The Sonos device uuid.
   * @param {number} index - The 0-based queue index.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async playQueueItem(uuid, index) {
    await this.runCommand(uuid, async (device) => {
      // SeekTrack is 1-based; it jumps without necessarily resuming, so Play()
      // after it guarantees the chosen track actually starts.
      await device.SeekTrack(Number(index) + 1);
      await device.Play();
    });
  }

  /**
   * Resolve a MediaItem id to a playable Sonos transport URI: an id that is
   * already a URI is returned as is, a ContentDirectory ObjectID (an album, a
   * playlist chosen to play as a whole) is turned into its resource URI
   * through a BrowseMetadata lookup.
   * @param {string} uuid - The Sonos device uuid.
   * @param {string} id - The MediaItem id.
   * @returns {Promise<string>} The transport URI to enqueue.
   * @throws {Error} When the object has no playable resource.
   */
  async resolveToUri(uuid, id) {
    if (looksLikeUri(id)) {
      return id;
    }
    return this.runCommand(uuid, async (device) => {
      const response = await device.ContentDirectoryService.BrowseParsed({
        ObjectID: id,
        BrowseFlag: 'BrowseMetadata',
        Filter: '*',
        StartingIndex: 0,
        RequestedCount: 1,
        SortCriteria: '',
      });
      const [item] = Array.isArray(response.Result) ? response.Result : [];
      if (!item || !item.TrackUri) {
        throw new Error(`no playable resource for "${id}"`);
      }
      return item.TrackUri;
    });
  }

  /**
   * Remove every track from the queue (used before a `replace` play).
   * @param {string} uuid - The Sonos device uuid.
   * @returns {Promise<void>} Resolves when the command is sent.
   */
  async clearQueue(uuid) {
    await this.runCommand(uuid, (device) =>
      device.AVTransportService.RemoveAllTracksFromQueue({ InstanceID: 0 }),
    );
  }

  /**
   * Play a catalog MediaItem by id (a scene's "play a playlist" action, a
   * click in the player). `replace` clears the queue and starts the content
   * now (reusing playUri's enqueue+switch+play sequence, the only one that
   * survives a cloud-service container - see playUri); `next`/`append` only
   * add it to the queue.
   * @param {string} uuid - The Sonos device uuid.
   * @param {string} id - The MediaItem id (a URI or a ContentDirectory ObjectID).
   * @param {string} [mode] - replace | next | append.
   * @returns {Promise<void>} Resolves once the command is dispatched.
   */
  async playMedia(uuid, id, mode = 'replace') {
    const uri = await this.resolveToUri(uuid, id);
    if (mode === 'next' || mode === 'append') {
      await this.runCommand(uuid, (device) => device.AddUriToQueue(uri, 0, mode === 'next'));
      return;
    }
    await this.clearQueue(uuid).catch((e) =>
      logger.debug(`Sonos: could not clear queue before replace: ${e.message}`),
    );
    await this.playUri(uuid, uri);
  }

  /**
   * Interrupt whatever a device is playing to announce a URI (a TTS file, a
   * notification sound...), then revert back - @svrooij/sonos's own
   * PlayNotification(), matching Gladys' native Sonos service's parameters
   * (see PLAY_NOTIFICATION_* in constants.js) for the same "talk on a
   * speaker" scene UX regardless of which integration a device belongs to.
   *
   * Not awaited by callers on purpose (see setDeviceValue in devices.js):
   * PlayNotification() normally only reverts once it sees the speaker's own
   * "playback stopped" UPnP event - which this integration's container can
   * never receive (see convertToGladysDevice.js's should_poll comment), so
   * it always falls back to the fixed PLAY_NOTIFICATION_TIMEOUT_SECONDS
   * instead. That alone routinely exceeds Gladys core's fixed, non-
   * overridable 5s command-ack window for a device command
   * (externalIntegration.sendCommand.js's COMMAND_TIMEOUT_MS) - a real
   * command taking that long must not look like a failed/timed-out one.
   * @param {string} uuid - The Sonos device uuid.
   * @param {string} trackUri - URI of the audio to announce.
   * @returns {Promise<void>} Resolves once the notification is dispatched
   *   (not once it has finished playing - see above).
   */
  async playNotification(uuid, trackUri) {
    const device = this.freshDeviceFor(uuid);
    withTimeout(
      device.PlayNotification({
        trackUri,
        onlyWhenPlaying: false,
        volume: PLAY_NOTIFICATION_VOLUME_DEFAULT,
        timeout: PLAY_NOTIFICATION_TIMEOUT_SECONDS,
        delayMs: PLAY_NOTIFICATION_DELAY_MS,
      }),
      PLAY_NOTIFICATION_COMMAND_TIMEOUT_MS,
    ).catch((e) => {
      logger.error(`Sonos: notification failed on ${device.name || uuid}: ${e.message}`);
    });
  }
}
