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
   * Read the current playback state, volume and now-playing title of a device.
   * @param {string} uuid - The Sonos device uuid.
   * @returns {Promise<{transportState: string, volume: number, nowPlaying: string}>} The raw state.
   */
  async getState(uuid) {
    return this.runCommand(uuid, async (device) => {
      const [transportInfo, volumeInfo, positionInfo] = await Promise.all([
        device.Coordinator.AVTransportService.GetTransportInfo(),
        device.RenderingControlService.GetVolume({ InstanceID: 0, Channel: 'Master' }),
        device.Coordinator.AVTransportService.GetPositionInfo(),
      ]);
      return {
        transportState: transportInfo.CurrentTransportState,
        volume: volumeInfo.CurrentVolume,
        nowPlaying: formatNowPlaying(positionInfo.TrackMetaData),
      };
    });
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
