# Waveform 🔊

A Firefox extension for per-tab audio volume control with advanced media detection.

I was really tired of seeing shady extensions that also didn't really seem to work fully. So I decided to make my own that is open source and works well. Feel free to fork and make your own version!


## Features

- **No Data Collection**: No data is collected by this extension

- **Per-Tab Volume Control**: Each tab has independent volume (0-1000%+)
- **Per-Domain Memory**: Optionally remember settings per website for new tabs
- **Multiple Control Methods**:
  - **Web Audio API**: For volume boost above 100%
  - **HTML5**: Standard volume control (0-100%)
  - **Both**: Uses ordinary volume control; boosts compatible players safely
- **Media Detection**: Shows active audio/video sources on the page
- **Detached Players**: Finds audio created outside the DOM, including autoplay
  players created before the main injector is ready
- **Codec Detection**: Displays video (H.264, H.265, VP9, AV1) and audio (AAC, MP3, Opus) codecs
- **Stream Type Detection**: Identifies HLS, DASH, MP4, WebM, and other formats
- **Theme Support**: Light and dark modes
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
2. Adjust the volume slider
3. Turn off **Use Site Volume Controls** to let Waveform override the player
4. Select a control method and use quick buttons for common volume levels
5. Check the status below the media badges for the volume actually applied

### Settings
- **Max Volume**: Set the upper limit (200% - 10000%)
- **Remember Control Method**: Save your preferred method
    - **Both**: Uses ordinary volume control; boosts compatible players safely
    - **Web Audio API**: For volume boost above 100%
    - **HTML5**: Standard volume control (0-100%)
- **Remember Volume**: Save volume per website
- **Theme**: Switch between light/dark mode
- **Accessibility Mode**: Enable larger fonts

## Playback compatibility and recovery

Waveform prioritizes keeping the original player working. HTML5 mode only changes
ordinary volume (0–100%) and never attaches a player to Web Audio. Both and Web
Audio modes apply the same compatibility checks before attaching media for boost.

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
Videos with no audio track retain their technical badges but do not count as a
working audio route. Reported element volume also reflects later site volume and
mute changes.

If playback becomes silent, click **Restore site audio**. Waveform stops enforcing
volume, restores volume changes it still owns, and remembers site controls for that
website. If **Reload page** appears, click it to clear a media route that cannot be
reversed in place. The site-control preference is saved before reloading; no browser
restart is part of this recovery flow. Waveform does not unmute a player that the
site or user muted. Re-enable override by turning off **Use Site Volume Controls**.

Bandcamp, Spotify, Dailymotion, YouTube, and YouTube TV are not claimed fully
compatible. Discovery now covers `Audio()`, DOM media factories, and `play()`, but
players created before the content script starts may still be missed. Protected
playback remains outside new boost routing because Firefox has a reported
[encrypted-media playback failure when attaching Web Audio](https://bugzilla.mozilla.org/show_bug.cgi?id=1950502).
The popup distinguishes protected audio from a player that is still loading, a
video without audio, or a source whose cross-origin access cannot be verified.
See [validation and release checklist](tests/README.md) for verified fixtures and
outstanding real-site checks. No additional permissions or telemetry are used.

## Development

Node.js 22 or later and the `zip` command are sufficient; no npm dependencies are required.

```sh
npm run check
npm test
npm run fixtures
# In a second terminal; defaults to the macOS Firefox installation:
python3 tests/firefox-smoke.py /path/to/firefox
npm run package
```

The Firefox runner uses a disposable profile, local fixtures, and a temporary
extension install. The archive in `dist/` contains only runtime files, icons, and
the license. Pull requests and tagged releases must pass the regression checks.

## Keyboard Shortcuts (in popup)
- `↑`/`→`: Increase volume by 5%
- `↓`/`←`: Decrease volume by 5%
- `M`: Toggle mute

## Technical Details

| File | Purpose |
|------|---------|
| `audio-injector.js` | Intercepts Web Audio API and controls HTML5 media |
| `content.js` | Bridge between popup and page context |
| `background.js` | Handles storage and tab info |
| `popup/` | Extension UI |

## Permissions

- `activeTab`: Access current tab for volume control
- `storage`: Save user preferences

## License

GPLv3
