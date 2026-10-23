# Waveform 🔊

A Firefox extension for per-tab audio volume control with advanced media detection.

I was really tired of seeing shady extensions that also didn't really seem to work fully. So I decided to make my own that is open source and works well. Feel free to fork and make your own version!


## Features

- **No Data Collection**: No data is collected by this extension

- **Per-Tab Volume Control**: Each tab has independent volume (0-1000%+)
- **Per-Domain Memory**: Optionally remember settings per website for new tabs
- **Multiple Control Methods**:
  - **Auto**: Uses ordinary volume control; boosts compatible players safely
  - **Standard (HTML5)**: Ordinary volume control (0–100%)
  - **Boost (Web Audio)**: Audio processing for compatible players
- **Media Detection**: Shows active audio/video sources on the page
- **Detached Players**: Finds audio created outside the DOM, including autoplay
  players, because the injector runs before any page script
- **Codec Detection**: Displays video (H.264, H.265, VP9, AV1) and audio (AAC, MP3, Opus) codecs
- **Stream Type Detection**: Identifies HLS, DASH, MP4, WebM, and other formats
- **Theme Support**: Follows your system theme, or pick light or dark
- **Accessibility Mode**: Larger text for better visibility

## Installation

### Firefox Add-ons (Recommended)
[![Get the Add-on](https://img.shields.io/badge/Firefox-Get%20Add--on-orange?logo=firefox)](https://addons.mozilla.org/firefox/addon/waveform/)

Install directly from the Firefox Add-ons store for automatic updates.

### Manual Installation
1. Download the latest `.xpi` from [GitHub Releases](https://github.com/braydenalex/waveform/releases)
2. Open Firefox and go to `about:addons`
3. Click the gear icon → "Install Add-on From File"
4. Select the downloaded `.xpi` file

## Usage

1. Click the Waveform icon in your toolbar
2. Turn on the switch at the top right to enable Waveform for the current website
3. Drag the slider, type an exact percentage, or use the − / + buttons. The middle of
   the slider is 100%; the right half covers boost levels up to your maximum
4. Use the presets (50, 100, 200, 400) for common levels; the speaker button mutes and
   restores your previous level
5. Leave the method on **Auto**, or select **Standard** or **Boost**
6. Read the one-line status under the presets; the large number is your requested level
7. Click the bar-chart button for **Media details**: source counts, stream format, codecs,
   applied volume, and boost support

### Settings
- **Max Volume**: Set the upper limit (200% - 10000%)
- **Remember Control Method**: Save your preferred method per website
- **Remember Volume**: Save volume per website
- **Keep volume between videos**: Reapply volume when a player resets it
- **Theme**: System (follows Firefox and your OS), Light, or Dark
- **Larger text**: Enable larger fonts and controls

Open settings with the gear button. Changes save automatically; use the back arrow
or Escape to return to the controls. **Reset all saved sites** clears site preferences
after confirmation while keeping global settings.

## Playback compatibility and recovery

Waveform prioritizes keeping the original player working. HTML5 mode only changes
ordinary volume (0–100%) and never attaches a player to Web Audio. Auto and Boost
modes apply the same compatibility checks before attaching media for boost.

Loaded, unprotected same-origin blob/MediaSource players and MediaStreams with live
audio tracks support boost, including live streams with an infinite duration.
Direct HTTP(S) media requires a successful CORS-mode load that Waveform observed.
A same-origin HTTP(S) URL alone is insufficient: it can redirect to another origin.
Protected media and sources with unverified cross-origin access use ordinary volume
control. Waveform never changes the source or `crossOrigin` attribute to force
compatibility. Site-owned Web Audio graphs can still be controlled without
attaching their media again.

The large volume number is the **requested** setting. The status reports the applied
volume, a 100% limit, mixed player support, or a pending playback interaction.
Videos with no audio track retain their technical details but do not count as a
working audio route. Reported element volume also reflects later site volume and
mute changes.

If playback becomes silent, click **Restore site audio**. Waveform stops enforcing
volume, restores volume changes it still owns, and remembers site controls for that
website. If **Reload page** appears, click it to clear a media route that cannot be
reversed in place. The site-control preference is saved before reloading; no browser
restart is part of this recovery flow. Waveform does not unmute a player that the
site or user muted. Turn **Enable Waveform** back on to control volume here again.

Bandcamp, Spotify, Dailymotion, YouTube, and YouTube TV are not claimed fully
compatible. Discovery covers `Audio()` and `play()`, and the injector starts before
any page script, so players the site creates early are seen as well. Protected
playback remains outside new boost routing because Firefox has a reported
[encrypted-media playback failure when attaching Web Audio](https://bugzilla.mozilla.org/show_bug.cgi?id=1950502).
The popup distinguishes protected audio from a player that is still loading, a
video without audio, or a source whose cross-origin access cannot be verified.
See [validation and release checklist](tests/README.md) for verified fixtures and
outstanding real-site checks. No additional permissions or telemetry are used.

## Development

Node.js 22 or later and `zip` build the extension. UI tests also require Python 3
and a current Firefox installation. No npm or Python dependencies are required.

```sh
npm run check
npm test
# Or specify a Firefox binary and screenshot destination:
python3 tests/popup-smoke.py /path/to/firefox /tmp/waveform-ui
npm run package
```

The Firefox runner checks the popup against deterministic state fixtures, then
temporarily installs the extension and verifies volume, mute, and recovery against
a local media element. It uses a disposable profile and writes screenshots to
`/tmp/waveform-ui` by default. See [test coverage](tests/README.md) for scope and
remaining playback checks. The archive in `dist/` contains only runtime files,
icons, and the license. Pull requests and tagged releases must pass the regression checks.

## Keyboard Shortcuts (in popup)
- `↑`/`→`: Increase volume by 5%
- `↓`/`←`: Decrease volume by 5%
- `M`: Toggle mute

Arrow keys inside a slider, number field, or settings menu keep their native
behavior. Press Enter to apply a typed volume or Escape to cancel the edit.

## Technical Details

| File | Purpose |
|------|---------|
| `audio-injector.js` | Page-world content script: intercepts Web Audio API and controls HTML5 media |
| `content.js` | Bridge to the injector over a private `MessagePort` handed over before page scripts run |
| `background.js` | Handles storage and tab info; validates all state reported by pages |
| `popup/` | Extension UI |

## Permissions

- `activeTab`: Access current tab for volume control
- `storage`: Save user preferences

## Privacy and security

Waveform collects no data and asks for no permissions beyond the two above.
Since 1.4.0:

- **Private page bridge.** The injector runs as a page-world content script before
  any page script and hands the content script a private `MessagePort`. Pages
  can no longer read or forge Waveform's messages, even by replacing built-in
  functions, and the extension no longer adds `moz-extension://` script tags or
  exposes a web-accessible file.
- **Validated page reports.** The background accepts only known fields, types, and
  sizes from frame reports, so a page or an ad iframe cannot break the popup.
- **Site preferences stay with the site.** Only the top page or a same-origin frame
  can save "use site controls" for a website. Third-party iframes can hand control
  back for the current tab only.

Known limitation: because the injector runs in the page, a site can still detect
that Waveform is installed (for example, from error stack traces). Moving those
hooks out of the page is planned for a later release.

## License

GPLv3
