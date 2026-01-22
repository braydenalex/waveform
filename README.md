# Waveform 🔊

A Firefox extension for per-tab audio volume control with advanced media detection.

I was really tired of seeing shady extensions that also didn't really seem to work fully. So I decided to make my own that is open source and works well. Feel free to fork and make your own version!

## Features

- **Per-Tab Volume Control**: Each tab has independent volume (0-1000%+)
- **Per-Domain Memory**: Optionally remember settings per website for new tabs
- **Multiple Control Methods**:
  - **Web Audio API**: For volume boost above 100%
  - **HTML5**: Standard volume control (0-100%)
  - **Both**: Automatically uses the best method
- **Media Detection**: Shows active audio/video sources on the page
- **Codec Detection**: Displays video (H.264, H.265, VP9, AV1) and audio (AAC, MP3, Opus) codecs
- **Stream Type Detection**: Identifies HLS, DASH, MP4, WebM, and other formats
- **Theme Support**: Light and dark modes
- **Accessibility Mode**: Larger text for better visibility

## Installation

### Firefox (Temporary)
1. Open `about:debugging#/runtime/this-firefox`
2. Click "Load Temporary Add-on"
3. Select `manifest.json` from this folder

## Usage

1. Click the Waveform icon in your toolbar
2. Adjust the volume slider
3. Select a control method if needed
4. Use quick buttons for common volume levels

### Settings
- **Max Volume**: Set the upper limit (200% - 10000%)
- **Remember Control Method**: Save your preferred method
    - **Both**: Automatically uses the best method
    - **Web Audio API**: For volume boost above 100%
    - **HTML5**: Standard volume control (0-100%)
- **Remember Volume**: Save volume per website
- **Theme**: Switch between light/dark mode
- **Accessibility Mode**: Enable larger fonts

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