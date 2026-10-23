"""Exercise the real popup DOM in a disposable Firefox profile with mocked browser APIs.

Usage: python3 tests/popup-smoke.py [firefox-path] [screenshot-directory]
This checks UI behavior and layout; it does not verify real-site audio compatibility.
Only Python's standard library is required.
"""
import base64
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import io
import json
import os
from pathlib import Path
import shutil
import socket
import subprocess
import sys
import tempfile
import threading
import time
import wave

ROOT = Path(__file__).resolve().parents[1]
FIREFOX = sys.argv[1] if len(sys.argv) > 1 else os.environ.get('FIREFOX_BIN', shutil.which('firefox') or '/Applications/Firefox.app/Contents/MacOS/firefox')
SHOTS = Path(sys.argv[2] if len(sys.argv) > 2 else '/tmp/waveform-ui')


class Marionette:
    def __init__(self, port):
        self.sock = socket.create_connection(('127.0.0.1', port), timeout=3)
        self.sock.settimeout(30)
        self.sequence = 0
        self.read()

    def read(self):
        size = b''
        while not size.endswith(b':'):
            part = self.sock.recv(1)
            if not part:
                raise ConnectionError('Firefox closed its connection')
            size += part
        data = b''
        length = int(size[:-1])
        while len(data) < length:
            part = self.sock.recv(length - len(data))
            if not part:
                raise ConnectionError('Incomplete Firefox response')
            data += part
        return json.loads(data)

    def call(self, command, params=None):
        self.sequence += 1
        data = json.dumps([0, self.sequence, command, params or {}]).encode()
        self.sock.sendall(str(len(data)).encode() + b':' + data)
        response = self.read()
        if response[2]:
            raise RuntimeError(response[2])
        result = response[3]
        return result.get('value', result) if isinstance(result, dict) else result

    def script(self, script):
        return self.call('WebDriver:ExecuteScript', {'script': script, 'args': [], 'newSandbox': False, 'sandbox': None})

    def wait(self, expression):
        deadline = time.monotonic() + 8
        while time.monotonic() < deadline:
            if self.script('return !!(' + expression + ');'):
                return
            time.sleep(.03)
        raise AssertionError('Timed out: ' + expression)

    def click(self, selector):
        element = self.call('WebDriver:FindElement', {'using': 'css selector', 'value': selector})
        self.call('WebDriver:ElementClick', {'id': next(iter(element.values()))})

    def type(self, selector, text):
        element = self.call('WebDriver:FindElement', {'using': 'css selector', 'value': selector})
        self.call('WebDriver:ElementSendKeys', {'id': next(iter(element.values())), 'text': text})

    def shot(self, name, selector='.container'):
        self.script("for (const animation of document.getAnimations()) animation.finish();")
        element = self.call('WebDriver:FindElement', {'using': 'css selector', 'value': selector})
        data = self.call('WebDriver:TakeScreenshot', {'id': next(iter(element.values())), 'full': False})
        (SHOTS / (name + '.png')).write_bytes(base64.b64decode(data))


def main():
    SHOTS.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix='waveform-popup-') as folder:
        folder = Path(folder)
        profile = folder / 'profile'
        profile.mkdir()
        with socket.socket() as sock:
            sock.bind(('127.0.0.1', 0))
            port = sock.getsockname()[1]
        prefs = {'marionette.port': port, 'browser.shell.checkDefaultBrowser': False,
                 'browser.startup.homepage_override.mstone': 'ignore', 'datareporting.policy.dataSubmissionEnabled': False}
        (profile / 'user.js').write_text('\n'.join(f'user_pref({json.dumps(k)}, {json.dumps(v)});' for k, v in prefs.items()))
        for file in ('popup.css', 'popup.js'):
            shutil.copy(ROOT / 'popup' / file, folder / file)
        version = json.loads((ROOT / 'manifest.json').read_text())['version']
        (folder / 'fixture.js').write_text((ROOT / 'tests/popup-fixture.js').read_text().replace('__VERSION__', version))
        html = (ROOT / 'popup/popup.html').read_text().replace('<script src="popup.js">', '<script src="fixture.js"></script><script src="popup.js">')
        (folder / 'popup.html').write_text(html)
        with (SHOTS / 'firefox.log').open('w') as log:
            process = subprocess.Popen([FIREFOX, '--headless', '--no-remote', '--profile', str(profile), '--marionette', '--remote-allow-system-access'], stdout=log, stderr=log)
            client = None
            try:
                deadline = time.monotonic() + 25
                while time.monotonic() < deadline:
                    try:
                        client = Marionette(port)
                        break
                    except OSError:
                        if process.poll() is not None:
                            raise RuntimeError('Firefox exited; see ' + str(SHOTS / 'firefox.log'))
                        time.sleep(.1)
                if client is None:
                    raise RuntimeError('Firefox did not start')
                client.call('WebDriver:NewSession', {'capabilities': {'alwaysMatch': {'acceptInsecureCerts': True}}})
                client.call('WebDriver:SetWindowRect', {'width': 520, 'height': 1100})
                client.call('WebDriver:Navigate', {'url': (folder / 'popup.html').as_uri()})
                client.wait("document.getElementById('domain').textContent === 'www.example.com'")
                run_checks(client)
                check_installed_extension(client)
            finally:
                if client:
                    client.sock.close()
                process.terminate()
                try:
                    process.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    process.kill()
                    process.wait()


def run_checks(c):
    checks = 0

    def check(expression, label):
        nonlocal checks
        assert c.script('return !!(' + expression + ');'), label
        checks += 1
        print('PASS:', label, flush=True)

    def idle():
        c.wait("!document.getElementById('restoreAudioBtn').disabled")

    def layout(label):
        check("document.querySelector('.container').scrollWidth <= document.body.clientWidth", label + ' has no horizontal overflow')

    def prefer_dark(dark):
        # Emulates the OS/browser color preference that the System theme follows.
        c.call('Marionette:SetContext', {'value': 'chrome'})
        c.script(f"Services.prefs.setIntPref('layout.css.prefers-color-scheme.content-override', {0 if dark else 1});")
        c.call('Marionette:SetContext', {'value': 'content'})

    # Start from a light preference so screenshots don't depend on the host's theme.
    prefer_dark(False)
    c.wait("getComputedStyle(document.body).backgroundColor === 'rgb(245, 247, 251)'")
    check("!document.getElementById('waveformEnabled').checked && document.getElementById('volumeSlider').disabled", 'site control is the default, with volume disabled')
    check("document.getElementById('themeSelect').value === 'system' && document.documentElement.dataset.theme === 'system'", 'System is the default theme')
    check("document.getElementById('version').textContent === 'v' + " + json.dumps(json.loads((ROOT / 'manifest.json').read_text())['version']), 'version label matches the manifest')
    c.shot('site-controls')
    c.click('#waveformEnabled')
    idle()
    check("fixture.settings.nativeVolumeControl === false && !document.getElementById('volumeSlider').disabled", 'positive switch enables Waveform using the existing setting')
    c.click('[data-volume="200"]')
    idle()
    check("fixture.settings.volume === 200 && document.getElementById('statusTitle').textContent === 'Applied volume: 200%'", 'presets report the applied volume')
    c.shot('light')
    layout('main panel')
    check("document.querySelector('.container').getBoundingClientRect().height <= 340", 'compact controls stay under 340px tall')
    prefer_dark(True)
    c.wait("getComputedStyle(document.body).backgroundColor === 'rgb(17, 25, 35)'")
    check("document.documentElement.dataset.theme === 'system'", 'System theme follows a dark browser preference')
    c.shot('system-dark')
    prefer_dark(False)
    c.wait("getComputedStyle(document.body).backgroundColor === 'rgb(245, 247, 251)'")
    c.click('#muteBtn')
    idle()
    check("fixture.settings.volume === 0 && document.getElementById('muteLabel').textContent === 'Unmute'", 'mute button exposes the unmute action')
    c.click('#muteBtn')
    idle()
    check('fixture.settings.volume === 200', 'unmute restores the previous level')
    c.click('#decreaseVolume')
    idle()
    check('fixture.settings.volume === 195', 'step buttons adjust by five percent')
    c.script("document.getElementById('volumeValue').focus(); document.getElementById('volumeValue').select();")
    c.type('#volumeValue', '275\ue007')
    idle()
    check('fixture.settings.volume === 275', 'real keyboard entry commits with Enter')
    c.script("document.getElementById('volumeValue').focus(); document.getElementById('volumeValue').select();")
    c.type('#volumeValue', '400\ue00c')
    idle()
    check("fixture.settings.volume === 275 && document.getElementById('volumeValue').value === '275'", 'Escape cancels an unfinished volume edit')
    c.script("const input = document.getElementById('volumeValue'); input.focus(); input.value = '288'; input.dispatchEvent(new Event('change', {bubbles:true})); input.blur();")
    idle()
    check('fixture.settings.volume === 288', 'typing an exact volume applies it')
    c.script("const input = document.getElementById('volumeValue'); input.focus(); input.value = ''; input.dispatchEvent(new Event('change')); input.blur();")
    check("document.getElementById('volumeValue').value === '288' && fixture.settings.volume === 288", 'empty numeric edits preserve the current volume')
    c.script("const input = document.getElementById('volumeValue'); input.focus(); input.value = '99999'; input.dispatchEvent(new Event('change')); input.blur();")
    idle()
    check('fixture.settings.volume === 1000', 'exact volume is clamped to the configured maximum')
    check("document.getElementById('volumeSlider').value === '1000'", 'maximum volume sits at the end of the slider')
    c.script("const s = document.getElementById('volumeSlider'); s.value = '500'; s.dispatchEvent(new Event('input'));")
    idle()
    check('fixture.settings.volume === 100', 'the middle of the slider is 100%')
    c.script("const s = document.getElementById('volumeSlider'); s.value = '750'; s.dispatchEvent(new Event('input'));")
    idle()
    check("fixture.settings.volume === 315 && Math.abs(document.getElementById('volumeSlider').value - 750) <= 2", 'boost range uses a rounded log scale')
    c.click('#btnHTML5')
    idle()
    check("fixture.settings.method === 'html5' && fixture.settings.volume === 100 && document.getElementById('volumeValue').max === '100' && document.getElementById('maxLabel').textContent === '100%' && document.getElementById('midLabel').hidden && document.querySelector('[data-volume=\"200\"]').disabled", 'Standard mode caps volume and disables the boost preset')
    c.script("fixture.messages.length = 0; document.getElementById('volumeSlider').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowLeft', bubbles:true, cancelable:true}));")
    idle()
    check("fixture.messages.length === 1 && fixture.settings.volume === 95", 'slider arrow keys apply exactly one 5% step')
    c.script("document.getElementById('volumeSlider').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowRight', bubbles:true, cancelable:true}));")
    idle()
    check('fixture.settings.volume === 100', 'slider arrow keys step back up')
    c.type('#volumeSlider', 'm')
    idle()
    check('fixture.settings.volume === 0', 'mute shortcut works while the slider has focus')
    c.type('#volumeSlider', 'm')
    idle()
    check('fixture.settings.volume === 100', 'mute shortcut restores volume while the slider has focus')
    c.click('#btnWebAudio')
    idle()
    check("fixture.settings.method === 'webaudio'", 'Boost selects the existing Web Audio method')
    c.click('#btnBoth')
    idle()
    c.script("fixture.delayNext = true; document.querySelector('[data-volume=\"50\"]').click();")
    c.wait('fixture.release')
    c.click('[data-volume="200"]')
    check("document.getElementById('volumeValue').value === '200'", 'latest requested volume remains visible during pending changes')
    c.script('fixture.release();')
    idle()
    check('fixture.settings.volume === 200', 'rapid requests finish at the latest value')
    c.script("fixture.emit({effectiveVolume: 50}, {volume: 50}, 99);")
    check("document.getElementById('volumeValue').value === '200'", 'unrelated tab updates are ignored')

    c.script("fixture.emit({boostAvailable:false, effectiveMethod:'html5', effectiveVolume:100, failureReason:'protected-media'}, {volume:535});")
    check("document.getElementById('statusTitle').textContent === 'Volume limited to 100%' && document.getElementById('effectiveVolume').textContent === '100%'", 'unsupported boost is never shown as applied')
    c.script("fixture.emit({effectiveVolume:0});")
    check("document.getElementById('effectiveVolume').textContent === '0%'", 'limited players still report a known muted volume')
    c.script("fixture.emit({effectiveVolume:535});")
    check("document.getElementById('effectiveVolume').textContent === '100% maximum'", 'an unverified boost is not presented as an applied statistic')
    c.script("fixture.emit({effectiveVolume:100});")
    c.shot('limited')
    c.click('#detailsToggle')
    check("!document.getElementById('detailsPanel').hidden && document.getElementById('mainPanel').hidden && document.activeElement.id === 'detailsBackBtn'", 'media details opens as its own view')
    check("document.getElementById('videoCodecs').textContent === 'VP9' && document.getElementById('audioCodecs').textContent === 'Opus' && document.getElementById('contextCount').textContent === '1' && document.getElementById('videoCount').textContent === '2' && document.getElementById('audioCount').textContent === '1'", 'all codec and element statistics are available')
    c.shot('media-details')
    c.script("fixture.emit({streamType:{type:'An exceptionally long streaming format name'}, detectedCodecs:[{type:'video',codec:'<img src=x onerror=alert(1)>AV1 H.265 VP9'},{type:'audio',codec:'Opus AAC FLAC MPEG-4 audio'}]});")
    layout('long media details')
    check("!document.getElementById('videoCodecs').querySelector('img')", 'codec labels are rendered as text')
    c.click('#detailsBackBtn')
    check("document.getElementById('detailsPanel').hidden && document.activeElement.id === 'detailsToggle'", 'leaving media details returns focus to its button')
    c.script("fixture.emit({failureReason:'interaction-required'});")
    check("document.getElementById('statusTitle').textContent === 'Click play to resume'", 'pending interaction has a clear status')
    c.script("fixture.emit({failureReason:null, mediaCount:0});")
    check("document.getElementById('statusTitle').textContent === 'No media detected'", 'empty player state has a clear next step')
    c.script("fixture.emit({ready:false, mediaCount:3, reloadRequired:true, failureReason:'protected-media'});")
    check("!document.getElementById('reloadPageBtn').hidden && document.getElementById('statusTitle').textContent === 'Reload needed'", 'recovery remains available even when a frame is not ready')
    c.script("fixture.emit({ready:true});")
    c.shot('recovery')
    c.click('#restoreAudioBtn')
    idle()
    check("fixture.storage['www.example.com'].nativeVolumeControl && !document.getElementById('waveformEnabled').checked", 'restore returns control to the site and saves that preference')
    c.click('#reloadPageBtn')
    idle()
    check("fixture.messages.at(-1).type === 'reloadPage'", 'reload only sends a request when clicked')

    c.click('#settingsToggle')
    check("!document.getElementById('settingsPanel').hidden && document.getElementById('mainPanel').hidden && document.activeElement.id === 'backBtn'", 'settings navigation moves focus and hides playback controls')
    c.shot('settings-light')
    for control in ('rememberMethod', 'rememberVolume', 'persistVolume'):
        c.click('#' + control)
    c.script("const select=document.getElementById('maxVolumeSelect'); select.value='10000'; select.dispatchEvent(new Event('change'));")
    c.wait("fixture.storage._globalSettings?.maxVolume === 10000")
    check("fixture.storage._globalSettings.rememberVolume && fixture.storage._globalSettings.persistVolume && !fixture.storage._globalSettings.rememberMethod", 'playback preferences save together')
    c.script("const select=document.getElementById('themeSelect'); select.value='dark'; select.dispatchEvent(new Event('change'));")
    c.wait("fixture.storage._globalSettings?.theme === 'dark'")
    check("document.documentElement.dataset.theme === 'dark'", 'theme updates immediately and is saved')
    c.shot('settings-dark')
    c.click('#accessibilityMode')
    c.wait('fixture.storage._globalSettings?.accessibilityMode')
    layout('large-text settings')
    c.shot('settings-large')
    c.script("document.getElementById('maxVolumeSelect').dispatchEvent(new KeyboardEvent('keydown', {key:'ArrowDown',bubbles:true}));")
    check("fixture.settings.volume === 535", 'settings arrow keys cannot change playback volume')
    c.script("document.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}));")
    check("document.getElementById('settingsPanel').hidden && document.activeElement.id === 'settingsToggle'", 'Escape returns focus to settings button')
    c.script("fixture.emit({boostAvailable:true, effectiveVolume:10000, effectiveMethod:'webaudio', reloadRequired:false, failureReason:null,streamType:{type:'DASH'}},{volume:10000,nativeVolumeControl:false});")
    c.shot('large-volume')
    layout('large-text maximum volume')
    check("document.getElementById('volumeValue').scrollWidth <= document.getElementById('volumeValue').clientWidth", 'five-digit volume fits its input')
    c.script("fixture.failNext = true;")
    c.click('[data-volume="50"]')
    idle()
    check("document.getElementById('statusTitle').textContent === 'Couldn’t apply changes'", 'request errors are visible without claiming success')
    c.click('[data-volume="100"]')
    idle()
    check("document.getElementById('statusTitle').textContent === 'Applied volume: 100%'", 'a subsequent successful request clears the error')
    c.click('#settingsToggle')
    c.click('#accessibilityMode')
    c.script("fixture.storage['saved.example'] = {volume:200};")
    c.click('#resetBtn')
    c.call('WebDriver:DismissAlert')
    check("fixture.storage['saved.example'].volume === 200", 'canceling a site reset preserves saved settings')
    c.click('#resetBtn')
    c.call('WebDriver:AcceptAlert')
    c.wait("!fixture.storage['saved.example']")
    check("fixture.storage._globalSettings.theme === 'dark' && document.getElementById('settingsFeedback').textContent.includes('Saved sites reset')", 'confirmed reset preserves global preferences and reports completion')
    c.click('#backBtn')
    c.shot('dark')
    check('fixture.errors.length === 0', 'no script errors or unhandled rejections')
    print(f'{checks} popup checks passed. Screenshots: {SHOTS}', flush=True)


def check_installed_extension(c):
    # A local, silent WAV provides a genuine media element without third-party sites.
    wav_data = io.BytesIO()
    with wave.open(wav_data, 'wb') as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(8000)
        audio.writeframes(b'\0\0' * 8000)
    source = base64.b64encode(wav_data.getvalue()).decode()
    # A hostile page script: it replaces the built-ins a page-world bridge could
    # use, records anything mentioning Waveform, and offers a fake bridge port.
    probe = """<script>
    window.__probe = { leaks: [], ports: 0, hijacked: 0,
        dom: !!document.querySelector('script[src^="moz-extension:"], [data-waveform-channel]') };
    const note = value => { try { if (/waveform/i.test(String(value))) __probe.leaks.push(String(value).slice(0, 80)); } catch {} };
    const OriginalCustomEvent = window.CustomEvent;
    window.CustomEvent = function (type, init) { note(type); return new OriginalCustomEvent(type, init); };
    const originalDispatch = EventTarget.prototype.dispatchEvent;
    EventTarget.prototype.dispatchEvent = function (event) { note(event.type); return originalDispatch.call(this, event); };
    const originalPost = MessagePort.prototype.postMessage;
    MessagePort.prototype.postMessage = function (data, ...rest) { note(data); return originalPost.call(this, data, ...rest); };
    const originalStringify = JSON.stringify;
    JSON.stringify = function (...args) { const text = originalStringify.apply(this, args); note(text); return text; };
    window.addEventListener('message', event => { if (event.ports.length) __probe.ports++; }, true);
    const fake = new MessageChannel();
    fake.port1.onmessage = () => { __probe.hijacked++; };
    window.postMessage('waveform:bridge:v1', '*', [fake.port2]);
    </script>"""
    page = f'<!doctype html><title>Waveform UI fixture</title>{probe}<audio id="player" controls preload="auto" src="data:audio/wav;base64,{source}"></audio>'.encode()

    class Handler(BaseHTTPRequestHandler):
        def do_GET(self):
            self.send_response(200)
            self.send_header('Content-Type', 'text/html')
            self.end_headers()
            self.wfile.write(page)

        def log_message(self, *_):
            pass

    server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
    threading.Thread(target=server.serve_forever, daemon=True).start()
    try:
        c.call('Addon:Install', {'path': str(ROOT), 'temporary': True})
        c.call('Marionette:SetContext', {'value': 'chrome'})
        uuid = c.script("return JSON.parse(Services.prefs.getStringPref('extensions.webextensions.uuids'))['waveform@brayden.dev'];")
        c.call('Marionette:SetContext', {'value': 'content'})
        target_url = f'http://127.0.0.1:{server.server_port}/'
        c.call('WebDriver:Navigate', {'url': target_url})
        c.wait("document.getElementById('player').readyState >= 2")
        target_handle = c.call('WebDriver:GetWindowHandle')
        popup_handle = c.call('WebDriver:NewWindow', {'type': 'tab'})['handle']
        c.call('WebDriver:SwitchToWindow', {'handle': popup_handle})
        c.call('WebDriver:Navigate', {'url': f'moz-extension://{uuid}/popup/popup.html'})
        # The real popup is normally outside the tab strip. Keep the fixture active
        # while Marionette inspects the popup's separate browsing context.
        c.script("browser.tabs.query({}).then(tabs => browser.tabs.update(tabs.find(tab => tab.url === " + json.dumps(target_url) + ").id, {active:true})).then(() => init());")
        c.wait("document.getElementById('domain').textContent === '127.0.0.1'")
        c.wait("document.getElementById('audioCount').textContent === '1'")
        c.script("document.getElementById('waveformEnabled').click();")
        c.wait("!document.getElementById('restoreAudioBtn').disabled")
        c.script("document.querySelector('[data-volume=\"50\"]').click();")
        c.wait("document.getElementById('statusTitle').textContent === 'Applied volume: 50%'")
        c.shot('installed-extension')
        c.call('WebDriver:SwitchToWindow', {'handle': target_handle})
        c.wait("document.getElementById('player').volume === .5")
        c.call('WebDriver:SwitchToWindow', {'handle': popup_handle})
        c.script("document.getElementById('muteBtn').click();")
        c.wait("document.getElementById('statusTitle').textContent === 'Applied volume: 0%'")
        c.call('WebDriver:SwitchToWindow', {'handle': target_handle})
        c.wait("document.getElementById('player').volume === 0")
        c.call('WebDriver:SwitchToWindow', {'handle': popup_handle})
        c.script("document.getElementById('restoreAudioBtn').click();")
        c.wait("!document.getElementById('waveformEnabled').checked && !document.getElementById('restoreAudioBtn').disabled")
        c.call('WebDriver:SwitchToWindow', {'handle': target_handle})
        c.wait("document.getElementById('player').volume === 1")
        probe_result = c.script("return window.__probe;")
        if probe_result['leaks'] or probe_result['hijacked'] or probe_result['dom'] or probe_result['ports'] > 1:
            raise AssertionError('Page script observed the Waveform bridge: ' + json.dumps(probe_result))
        print('PASS: page scripts cannot observe, hijack, or find the Waveform bridge', flush=True)
        c.call('WebDriver:Refresh')
        c.wait("document.getElementById('player').readyState >= 2")
        c.call('WebDriver:SwitchToWindow', {'handle': popup_handle})
        c.script("browser.tabs.query({}).then(tabs => browser.tabs.update(tabs.find(tab => tab.url === " + json.dumps(target_url) + ").id, {active:true})).then(() => init());")
        c.wait("document.getElementById('domain').textContent === '127.0.0.1' && !document.getElementById('waveformEnabled').checked")
        print('PASS: installed extension controls real element volume, mutes, restores, and remembers site controls after reload', flush=True)
    finally:
        server.shutdown()
        server.server_close()


if __name__ == '__main__':
    main()
