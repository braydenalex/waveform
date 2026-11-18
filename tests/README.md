# Popup validation

Run `npm test` with Python 3 and Firefox installed, or specify the binary:

```sh
python3 tests/popup-smoke.py /path/to/firefox /tmp/waveform-ui
```

The runner uses a fresh temporary Firefox profile and removes it on completion.
It never opens a signed-in browser profile. `FIREFOX_BIN` can also select a binary;
otherwise the runner checks PATH and the standard macOS Firefox location.
On Linux CI, the workflow supplies a virtual PulseAudio output so Firefox can
advance real media playback and process the Web Audio test signal.

The popup fixtures check site-control switching, all three methods, exact volume
entry and bounds, presets, mute restoration, queued updates, unrelated tab isolation,
settings persistence, focus navigation, error recovery, protected/limited/pending/
empty player states, the per-site reset, and mixer volume, mute, and focus. Layout checks and screenshots cover
light, dark, the System theme under a dark browser preference, larger text,
long codec labels, media details, the tab mixer, and maximum volume. Slider checks cover
the 100% midpoint, the rounded log scale for boost levels, and one 5% step per arrow key.

A second pass temporarily installs the extension and opens a local WAV fixture.
It verifies element volume, unmuting after reopening Waveform, and restoring site
controls across a reload. With quiet generated tones, it measures PCM after the
Web Audio gain node and verifies the gain at 400% and after lowering Maximum
volume to 200%. It also checks a compatible source change, return to unity gain,
and recovery via reload after an unsupported source change. It verifies the
loading, playing, and paused states against real media, then adjusts and mutes
a second audible tab and verifies that forgetting a site clears only its settings.
The test uses a loopback server and Firefox's Marionette port.
It verifies live browser appearance changes in the installed popup and checks the
Spanish interface and English fallback through the popup fixtures.
The fixture page also includes a hostile script that replaces `CustomEvent`,
`dispatchEvent`, `MessagePort.postMessage`, and `JSON.stringify`, offers a fake
bridge port, and looks for extension script tags. The pass fails if that script
sees anything from Waveform.

`npm run test:background` (Node only, no browser) runs `background.js` with stubbed
WebExtension APIs. It checks that malformed or oversized frame reports cannot break
the popup, and that only the top page or a same-origin frame can save site controls.
It also checks that the maximum applies at tab startup and across open tabs, and
that the pre-mute level stays with the tab even when the background page restarts.

Tests and fixtures are excluded from the extension package by its file allowlist.

The signal check measures audio before it reaches the output device. Real sites
still need separate compatibility and playback checks.
Before release, manually check current Firefox and ESR with Dailymotion reloads,
YouTube and YouTube TV live streams, Spotify, and Bandcamp. Include pause/resume,
reconnects, saved volume, popup reopening, repeated reloads, and recovery. Record
results and limitations; protected playback is not claimed to support boosting.
