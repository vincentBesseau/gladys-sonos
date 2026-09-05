# Sonos

Control your Sonos speakers directly over your local network: play, pause,
previous/next track, volume, and play any content URI (a Spotify playlist or
track, a radio stream...) sent to it - typically from a Gladys scene.

## Why this integration, alongside Gladys' native Sonos service

- **VLAN-safe discovery.** The native Sonos service only finds speakers
  through SSDP multicast (`239.255.255.250:1900`), which most routers do not
  forward across VLANs/subnets - a live, unresolved limitation as of this
  writing. This integration adds a **Known IPs** field: one reachable Sonos
  speaker's IP is enough, because Sonos speakers already know every room in
  the household and share that layout with whichever one you ask.
- **Play any content URI.** Each device gets a "Play URI" feature: send it a
  URI (e.g. `spotify:playlist:...`) and it starts playing there. Combine it
  with an integration that lists content (playlists, recently played
  tracks...) through a Gladys scene: read the selected value, write it to
  "Play URI".
- **Play Notification.** Each device also gets a "Play Notification" feature,
  for a scene's "talk on a speaker" action: it briefly interrupts what is
  playing to announce a URI (a generated TTS file, a notification sound...),
  then reverts - see the Limitations section for how this differs from the
  native Sonos service.

## Configuration

1. Open the integration's **Configuration** tab.
2. If your Sonos speakers are reachable from Gladys without any special
   network setup, leave **Known IPs** empty and run a scan - automatic (SSDP)
   discovery is enough.
3. If Gladys and your Sonos speakers are on different VLANs/subnets, fill in
   **one** speaker's IP address in **Known IPs**, save, then run a scan (the
   **Scan for Sonos speakers** action, or the Discovery tab). That single IP
   is enough to recover every room.

## Bridging content from another integration

A device's "Play URI" feature accepts any string value through its normal
`text` command - no special wiring needed. In a Gladys scene: read the state
of the content-listing feature you want to play from (its trigger condition),
then add an action that sets this device's "Play URI" feature to that same
value.

## Limitations

- Local network control only: no cloud account, nothing works if the speaker
  is unreachable at the IP address Gladys currently has for it.
- No real-time push updates (playing/paused, volume): state is polled
  periodically, so the dashboard can lag a few seconds behind reality.
- Group/stereo-pair topology is read once per scan; a device grouped after
  the last scan is controlled directly rather than through its group's
  coordinator.
- Playing a URI (`spotify:...`, etc.) requires the target speaker to already
  support that content source natively (e.g. Spotify linked as a service
  inside the Sonos app) - this integration does not manage that account link,
  it only sends the URI over the local network.
- A "Play Notification" always runs for a fixed duration (~20s) before
  reverting to whatever was playing before, even if the announcement itself
  is shorter. Gladys' native Sonos service can revert as soon as the speaker
  reports the announcement finished playing; this integration runs in its
  own container, which a Sonos speaker's local network can never reach to
  deliver that same signal, so it always waits out the fixed duration
  instead.
