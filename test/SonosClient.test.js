import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  parseKnownIps,
  formatNowPlaying,
  parseDurationToSeconds,
  formatSeconds,
  absoluteArtworkUrl,
  upnpClassToMediaType,
  mapTrackToItem,
  isStreamUri,
  SonosClient,
} from '../src/SonosClient.js';

test('parseKnownIps splits on commas, newlines and whitespace', () => {
  assert.deepEqual(parseKnownIps('192.168.10.21, 192.168.10.22\n192.168.10.23'), [
    '192.168.10.21',
    '192.168.10.22',
    '192.168.10.23',
  ]);
});

test('parseKnownIps trims entries and drops empty ones', () => {
  assert.deepEqual(parseKnownIps('  192.168.10.21 ,,\n\n 192.168.10.22  '), [
    '192.168.10.21',
    '192.168.10.22',
  ]);
});

test('parseKnownIps returns an empty array for empty/undefined input', () => {
  assert.deepEqual(parseKnownIps(''), []);
  assert.deepEqual(parseKnownIps(undefined), []);
  assert.deepEqual(parseKnownIps(null), []);
});

test('formatNowPlaying joins artist and title', () => {
  assert.equal(
    formatNowPlaying({ Title: "L'aventurier", Artist: 'Indochine' }),
    "Indochine — L'aventurier",
  );
});

test('formatNowPlaying falls back to just the title when there is no artist', () => {
  assert.equal(formatNowPlaying({ Title: 'Some Stream' }), 'Some Stream');
});

test('formatNowPlaying returns an empty string for anything unusable', () => {
  assert.equal(formatNowPlaying(undefined), '');
  assert.equal(formatNowPlaying('NOT_IMPLEMENTED'), '');
  assert.equal(formatNowPlaying({}), '');
  assert.equal(formatNowPlaying(null), '');
});

// --- now-playing / catalog helpers -------------------------------------------

test('parseDurationToSeconds parses H:MM:SS and tolerates unknowns', () => {
  assert.equal(parseDurationToSeconds('0:03:12'), 192);
  assert.equal(parseDurationToSeconds('1:00:00'), 3600);
  assert.equal(parseDurationToSeconds('NOT_IMPLEMENTED'), 0);
  assert.equal(parseDurationToSeconds(''), 0);
  assert.equal(parseDurationToSeconds(undefined), 0);
  assert.equal(parseDurationToSeconds(150), 150);
});

test('formatSeconds renders the H:MM:SS Sonos Seek expects', () => {
  assert.equal(formatSeconds(192), '0:03:12');
  assert.equal(formatSeconds(3600), '1:00:00');
  assert.equal(formatSeconds(0), '0:00:00');
  assert.equal(formatSeconds(-5), '0:00:00');
});

test('absoluteArtworkUrl prefixes a relative path and keeps an absolute URL', () => {
  assert.equal(
    absoluteArtworkUrl('192.168.1.50', '/getaa?u=x'),
    'http://192.168.1.50:1400/getaa?u=x',
  );
  assert.equal(absoluteArtworkUrl('192.168.1.50', 'https://cdn/x.jpg'), 'https://cdn/x.jpg');
  assert.equal(absoluteArtworkUrl('192.168.1.50', ''), null);
  assert.equal(absoluteArtworkUrl('192.168.1.50', undefined), null);
});

test('upnpClassToMediaType maps the common DIDL classes', () => {
  assert.equal(upnpClassToMediaType('object.container.album.musicAlbum'), 'album');
  assert.equal(upnpClassToMediaType('object.container.playlistContainer'), 'playlist');
  assert.equal(upnpClassToMediaType('object.container.person.musicArtist'), 'artist');
  assert.equal(upnpClassToMediaType('object.item.audioItem.audioBroadcast'), 'radio');
  assert.equal(upnpClassToMediaType('object.container.storageFolder'), 'folder');
  assert.equal(upnpClassToMediaType('object.item.audioItem.musicTrack'), 'track');
  assert.equal(upnpClassToMediaType(undefined), 'track');
});

test('mapTrackToItem keeps a container ObjectID as id and a leaf URI as id', () => {
  const album = mapTrackToItem(
    {
      ItemId: 'A:ALBUM/Discovery',
      TrackUri: 'x-rincon-cpcontainer:album',
      Title: 'Discovery',
      Artist: 'Daft Punk',
      AlbumArtUri: '/getaa?u=a',
      UpnpClass: 'object.container.album.musicAlbum',
      Duration: '0:14:00',
    },
    '192.168.1.50',
  );
  assert.equal(album.id, 'A:ALBUM/Discovery'); // ObjectID -> browsable
  assert.equal(album.type, 'album');
  assert.equal(album.browsable, true);
  assert.equal(album.playable, true);
  assert.equal(album.duration, null); // a container carries no track duration
  assert.equal(album.artworkUrl, 'http://192.168.1.50:1400/getaa?u=a');

  const track = mapTrackToItem(
    {
      ItemId: 'Q:0/3',
      TrackUri: 'x-sonos-http:track.mp3',
      Title: 'One More Time',
      Artist: 'Daft Punk',
      UpnpClass: 'object.item.audioItem.musicTrack',
      Duration: '0:05:20',
    },
    '192.168.1.50',
  );
  assert.equal(track.id, 'x-sonos-http:track.mp3'); // leaf -> playable URI
  assert.equal(track.browsable, false);
  assert.equal(track.duration, 320);
});

test('isStreamUri flags radio/broadcast URIs, not queue items', () => {
  assert.equal(isStreamUri('x-sonosapi-stream:s2339?sid=333'), true);
  assert.equal(isStreamUri('x-rincon-mp3radio://http://stream'), true);
  assert.equal(isStreamUri('x-rincon-cpcontainer:1004206cspotify:album'), false);
  assert.equal(isStreamUri('x-rincon-playlist:RINCON_1#SQ:0'), false);
  assert.equal(isStreamUri('x-sonos-http:track.mp3'), false);
  assert.equal(isStreamUri(''), false);
});

test('freshDeviceFor throws for a uuid not seen in the last discovery', () => {
  const client = new SonosClient();
  assert.throws(() => client.freshDeviceFor('RINCON_UNKNOWN'), /currently unreachable/);
});

test('playNotification rejects for a uuid not seen in the last discovery', async () => {
  const client = new SonosClient();
  await assert.rejects(
    () => client.playNotification('RINCON_UNKNOWN', 'https://example.com/notification.mp3'),
    /currently unreachable/,
  );
});

test('playUri rejects for a uuid not seen in the last discovery', async () => {
  const client = new SonosClient();
  await assert.rejects(
    () => client.playUri('RINCON_UNKNOWN', 'spotify:playlist:abc'),
    /currently unreachable/,
  );
});

test('the new music commands reject for an unknown uuid', async () => {
  const client = new SonosClient();
  await assert.rejects(() => client.getState('RINCON_UNKNOWN'), /currently unreachable/);
  await assert.rejects(() => client.setMute('RINCON_UNKNOWN', 1), /currently unreachable/);
  await assert.rejects(() => client.getQueue('RINCON_UNKNOWN'), /currently unreachable/);
  await assert.rejects(() => client.browse('RINCON_UNKNOWN', 'FV:2'), /currently unreachable/);
  // playMedia resolves the uri first (a direct URI needs no lookup), then
  // fails when it tries to reach the speaker.
  await assert.rejects(
    () => client.playMedia('RINCON_UNKNOWN', 'x-rincon-cpcontainer:1', 'replace'),
    /currently unreachable/,
  );
});
