# Popup validation

Run `npm test` with Python 3 and Firefox installed, or specify the binary:

```sh
python3 tests/popup-smoke.py /path/to/firefox /tmp/waveform-ui
```

The runner uses a fresh temporary Firefox profile and removes it on completion.
It never opens a signed-in browser profile. `FIREFOX_BIN` can also select a binary;
otherwise the runner checks PATH and the standard macOS Firefox location.

The popup fixtures check site-control switching, all three methods, exact volume
entry and bounds, presets, mute restoration, queued updates, unrelated tab isolation,
settings persistence, focus navigation, error recovery, protected/limited/pending/
empty player states, and every media statistic. Layout checks and screenshots cover
light, dark, the System theme under a dark browser preference, larger text,
long codec labels, the media details view, and maximum volume. Slider checks cover
the 100% midpoint, the rounded log scale for boost levels, and one 5% step per arrow key.

A second pass temporarily installs the actual extension and opens a local silent
WAV fixture. It verifies that 50% and Mute change the media element's volume,
Restore site audio returns it to its original level, and site-control preferences
survive reloading. The test uses a loopback server and Firefox's Marionette port.
The fixture page also includes a hostile script that replaces `CustomEvent`,
`dispatchEvent`, `MessagePort.postMessage`, and `JSON.stringify`, offers a fake
bridge port, and looks for extension script tags. The pass fails if that script
sees anything from Waveform.

`npm run test:background` (Node only, no browser) runs `background.js` with stubbed
WebExtension APIs. It checks that malformed or oversized frame reports cannot break
the popup, and that only the top page or a same-origin frame can save site controls.

Tests and fixtures are excluded from the extension package by its file allowlist.

These checks verify the redesigned popup and basic extension integration. They do
not prove audible output, boost compatibility, or playback reliability on real sites.
Before release, manually check current Firefox and ESR with Dailymotion reloads,
YouTube and YouTube TV live streams, Spotify, and Bandcamp. Include pause/resume,
reconnects, saved volume, popup reopening, repeated reloads, and recovery. Record
results and limitations; protected playback is not claimed to support boosting.
