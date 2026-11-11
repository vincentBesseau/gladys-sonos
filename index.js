// -----------------------------------------------------------------------------
// Entry point of the Sonos external integration.
//
// Role of this file: wire the Gladys SDK to the Sonos client and the device
// orchestration (src/devices.js). No cloud auth: Sonos speakers are
// controlled directly over the LAN, found either by a mediated SSDP scan
// (gladys.scanNetwork('ssdp', ...)) or from user-entered "known IPs" - the
// fix for installations where Gladys and the Sonos speakers sit on different
// VLANs, so SSDP multicast never reaches them (see docs/en.md).
// -----------------------------------------------------------------------------

import { GladysIntegration, logger } from '@gladysassistant/integration-sdk';
import { SonosClient, parseKnownIps } from './src/SonosClient.js';
import {
  CONFIG_SCHEMA_KEYS,
  SSDP_SCAN_TIMEOUT_SECONDS,
  DEFAULT_CATALOG_LANGUAGE,
} from './src/constants.js';
import {
  buildDiscoveredDevices,
  setDeviceValue,
  pollDevice,
  musicBrowse,
  musicSearch,
  musicPlay,
  musicQueueGet,
  musicQueuePlay,
} from './src/devices.js';

// Disable @svrooij/sonos' UPnP eventing entirely, before any discovery runs
// (the library reads these at subscribe time). An external-integration
// container is on a bridge network and can never receive a speaker's NOTIFY
// callbacks, so every SUBSCRIBE is dead weight - a listener, a callback URL
// the speakers cannot reach, and a 10-min renewal timer - and they leaked on
// every discovery. Any defined value disables it; keep a user-set override.
process.env.SONOS_DISABLE_EVENTS = process.env.SONOS_DISABLE_EVENTS ?? '1';
process.env.SONOS_DISABLE_LISTENER = process.env.SONOS_DISABLE_LISTENER ?? '1';

const gladys = new GladysIntegration();
const client = new SonosClient();

// Self-heal a stale speaker IP (a DHCP lease change): a command or poll
// failure schedules ONE background rediscovery, debounced, so the next cycle
// reaches the speaker at its new IP. Not awaited by the failing command -
// Gladys' fixed 5s command-ack window forbids a synchronous rescan, and the
// merged cache (SonosClient.discover) means the rescan never drops a speaker.
let lastRediscoveryAt = 0;
const REDISCOVERY_DEBOUNCE_MS = 30 * 1000;

/**
 * Whether an error looks like the speaker being unreachable (a stale IP, a
 * powered-off unit), the only kind worth a rediscovery.
 * @param {Error} error - The caught error.
 * @returns {boolean} True when a rediscovery might help.
 */
function isUnreachableError(error) {
  return /unreachable|did not respond|timed out|EHOSTUNREACH|ECONNREFUSED|ETIMEDOUT|ENETUNREACH|EHOSTDOWN/i.test(
    error?.message || '',
  );
}

/**
 * Schedule a single debounced background rediscovery.
 * @param {string} reason - Why a rediscovery was scheduled (for the log).
 * @returns {void}
 */
function scheduleRediscovery(reason) {
  const now = Date.now();
  if (now - lastRediscoveryAt < REDISCOVERY_DEBOUNCE_MS) {
    return;
  }
  lastRediscoveryAt = now;
  logger.info(`Sonos: scheduling a background rediscovery (${reason})`);
  discoverAndPublish().catch((e) =>
    logger.error(`Sonos: background rediscovery failed: ${e.message}`),
  );
}

// The catalog root-folder language, refreshed from the config on every
// discovery (startup, scan, config save) - onMusicBrowse gets no user locale.
let catalogLanguage = DEFAULT_CATALOG_LANGUAGE;

/**
 * Read the configuration: the known IPs, and (cached) the catalog language.
 * @returns {Promise<Array<string>>} The known IPs/hostnames.
 */
async function getKnownIps() {
  const config = (await gladys.getConfig()) || {};
  catalogLanguage = config[CONFIG_SCHEMA_KEYS.CATALOG_LANGUAGE] || DEFAULT_CATALOG_LANGUAGE;
  return parseKnownIps(config[CONFIG_SCHEMA_KEYS.KNOWN_IPS]);
}

/**
 * Reject with a timeout error if `promise` has not settled within `ms`, so a
 * call to the Gladys host API can never hang discovery forever.
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
 * Run a mediated SSDP scan for Sonos ZonePlayers, tolerating a scan failure
 * (e.g. rate-limited) by falling back to known IPs alone.
 * @returns {Promise<Array<string>>} The responders' IPs.
 */
async function scanSsdp() {
  logger.debug('Sonos: starting mediated SSDP scan...');
  try {
    const results = await withTimeout(
      gladys.scanNetwork('ssdp', { timeoutSeconds: SSDP_SCAN_TIMEOUT_SECONDS }),
      (SSDP_SCAN_TIMEOUT_SECONDS + 5) * 1000,
    );
    logger.debug(`Sonos: SSDP scan returned ${results.length} responder(s).`);
    return [...new Set(results.map((r) => r.source_ip))];
  } catch (e) {
    logger.debug(`Sonos: SSDP scan unavailable, relying on known IPs only: ${e.message}`);
    return [];
  }
}

/**
 * Discover the Sonos household and publish it.
 * @returns {Promise<void>} Resolves when published.
 */
async function discoverAndPublish() {
  logger.debug('Sonos: discoverAndPublish starting...');
  const knownIps = await getKnownIps();
  logger.debug(`Sonos: known IPs = ${JSON.stringify(knownIps)}`);
  const ssdpIps = await scanSsdp();
  try {
    logger.debug('Sonos: building discovered devices...');
    const devices = await buildDiscoveredDevices(gladys, client, knownIps, ssdpIps);
    logger.debug(`Sonos: ${devices.length} device(s) built, publishing...`);
    await gladys.publishDiscoveredDevices(devices);
    await gladys.setConnectionStatus(devices.length > 0).catch(() => {});
    if (devices.length === 0) {
      logger.info(
        'Sonos: no speaker found (SSDP + known IPs). Check "Known IPs" in the configuration.',
      );
    }
  } catch (e) {
    logger.error(`Sonos: unable to publish devices: ${e.message}`);
    await gladys
      .setConnectionStatus(false, {
        en: `Sonos error: ${e.message}`,
        fr: `Erreur Sonos : ${e.message}`,
      })
      .catch(() => {});
  }
}

// --- Discovery: the user asks for the list of devices ------------------------
gladys.onScanRequest(async () => {
  logger.info('onScanRequest -> discovering Sonos speakers');
  await discoverAndPublish();
});

// --- Command: the user acts on a controllable feature -------------------------
gladys.onSetValue(async (device, feature, value) => {
  logger.info(`onSetValue <- ${feature.external_id} = ${value}`);
  try {
    await setDeviceValue(client, feature, value);
    logger.debug(`onSetValue -> ${feature.external_id} succeeded`);
  } catch (e) {
    logger.error(`onSetValue -> ${feature.external_id} failed: ${e.message}`);
    if (isUnreachableError(e)) {
      scheduleRediscovery('command failed, speaker unreachable');
    }
    throw e;
  }
});

// --- Poll: Gladys asks for the current state of a device ---------------------
gladys.onPoll(async (device) => {
  const ok = await pollDevice(gladys, client, device);
  if (!ok) {
    scheduleRediscovery('poll failed, speaker unreachable');
  }
});

// --- Music player: on-demand catalog, search, queue and play -----------------
// Declared in the manifest (`music`), answered on demand - nothing is stored.
// The artwork bytes are served by the SDK's default handler, which fetches the
// LAN album-art URL recorded by gladys.artworkKey (publishNowPlaying and
// toMediaItem record them); no onMusicGetArtwork handler is registered because
// Sonos serves images small enough as is.
gladys.onMusicBrowse(async (device, params) => {
  logger.debug(`onMusicBrowse <- parentId=${params.parentId}`);
  return musicBrowse(gladys, client, device, params, catalogLanguage);
});

gladys.onMusicSearch(async (device, params) => {
  logger.debug(`onMusicSearch <- "${params.query}"`);
  return musicSearch(gladys, client, device, params);
});

gladys.onMusicPlay(async (device, media, mode) => {
  logger.info(`onMusicPlay <- ${media.id} (${mode})`);
  await musicPlay(client, device, media, mode);
});

gladys.onMusicQueueGet(async (device, params) => {
  logger.debug('onMusicQueueGet');
  return musicQueueGet(gladys, client, device, params);
});

gladys.onMusicQueuePlay(async (device, index) => {
  logger.info(`onMusicQueuePlay <- index=${index}`);
  await musicQueuePlay(client, device, index);
});

// --- Manifest action: refresh the Sonos household now -------------------------
gladys.onAction('scan_now', async () => {
  logger.info('Action scan_now -> discovering Sonos speakers');
  await discoverAndPublish();
  const count = client.devicesByUuid.size;
  return {
    en: `Scan complete: ${count} Sonos speaker(s) found.`,
    fr: `Scan terminé : ${count} enceinte(s) Sonos trouvée(s).`,
  };
});

// --- Configuration updated by the user (e.g. known IPs changed) --------------
gladys.onConfigUpdated(async () => {
  logger.info('onConfigUpdated -> rediscovering with the updated configuration');
  await discoverAndPublish().catch((e) =>
    logger.error(`Re-discovery after config update failed: ${e.message}`),
  );
});

// --- Connection lifecycle ----------------------------------------------------
gladys.on('connected', async () => {
  await discoverAndPublish();
});

// --- Startup -----------------------------------------------------------------
logger.info('Starting the Sonos integration...');
gladys.connect().catch((err) => {
  logger.error('Initial connection failed', err);
  process.exit(1);
});
