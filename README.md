# gladys-sonos

[![Latest version](https://img.shields.io/github/v/tag/vincentBesseau/gladys-sonos?label=version)](https://github.com/vincentBesseau/gladys-sonos/tags)
[![CI](https://github.com/vincentBesseau/gladys-sonos/actions/workflows/ci.yml/badge.svg)](https://github.com/vincentBesseau/gladys-sonos/actions/workflows/ci.yml)
[![Docker pulls](https://ghcr-badge.elias.eu.org/shield/vincentBesseau/gladys-sonos/gladys-sonos)](https://github.com/vincentBesseau/gladys-sonos/pkgs/container/gladys-sonos)
[![License: Apache-2.0](https://img.shields.io/badge/license-Apache--2.0-blue)](https://www.apache.org/licenses/LICENSE-2.0)
[![Gladys](https://img.shields.io/badge/gladys-%3E%3D4.86.0-6f42c1)](https://gladysassistant.com)

External [Gladys Assistant](https://gladysassistant.com) integration to control **Sonos** speakers directly over the local network, alongside Gladys' native Sonos service — see [`docs/en.md`](./docs/en.md) for why.

Built on the [Gladys integration SDK](https://github.com/GladysAssistant/integration-sdk-js), from the [official template](https://github.com/GladysAssistant/integration-template-js). Sonos control itself is [`@svrooij/sonos`](https://sonos.svrooij.io/) — the same library Gladys' native Sonos service already depends on.

## What it does

| Feature                        | Notes                                                                                                                                                                  |
| ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Play / Pause / Previous / Next | Transport control                                                                                                                                                      |
| Volume                         | 0-100                                                                                                                                                                  |
| Playback state                 | Read-only, polled                                                                                                                                                      |
| **Play URI**                   | Free-text command: plays any content URI (`spotify:playlist:...`, a stream...) on that device                                                                          |
| **Known IPs**                  | Manual fallback when SSDP discovery cannot cross a VLAN/subnet boundary — one reachable speaker's IP is enough to recover the whole household (it shares its topology) |

No cloud account: everything happens over the LAN.

## Architecture

```
index.js                     SDK wiring: handlers, manifest actions
src/SonosClient.js           @svrooij/sonos wrapper: discovery (SSDP + known IPs), transport control, play-uri, polled state
src/devices.js                discovery / setValue / poll orchestration
src/convertToGladysDevice.js  Sonos device -> Gladys device/feature conversion
src/constants.js             SSDP search target, config keys, timings
```

## Local development

```bash
npm install
GLADYS_HOST_API_URL="http://localhost:1443" \
GLADYS_INTEGRATION_TOKEN="<token>" \
GLADYS_INTEGRATION_SELECTOR="sonos" \
npm start
```

```bash
npm test          # unit tests (node --test)
npm run lint      # eslint
npm run format    # prettier
```

## License

Apache-2.0
