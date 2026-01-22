// Audio Injector - runs in page context (not content script sandbox)
// Provides two methods for volume control

(function () {
    'use strict';

    let currentVolume = 1.0;
    let currentMethod = 'webaudio';

    // ==========================================
    // METHOD 1: Web Audio API GainNode Injection
    // ==========================================

    const gainNodes = new Set();
    const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;

    if (OriginalAudioContext) {
        // Create patched AudioContext class
        class PatchedAudioContext extends OriginalAudioContext {
            constructor(...args) {
                super(...args);

                // Create a master gain node for volume control
                this._volumeGain = super.createGain();
                this._volumeGain.connect(super.destination);
                this._volumeGain.gain.value = currentVolume;

                gainNodes.add(this._volumeGain);
            }

            // Override destination to return our gain node
            get destination() {
                return this._volumeGain;
            }

            // Clean up when context is closed
            close() {
                gainNodes.delete(this._volumeGain);
                return super.close();
            }
        }

        // Replace global AudioContext
        window.AudioContext = PatchedAudioContext;
        if (window.webkitAudioContext) {
            window.webkitAudioContext = PatchedAudioContext;
        }
    }

    // Update all gain nodes
    function setWebAudioVolume(volume) {
        gainNodes.forEach(gain => {
            gain.gain.value = volume;
        });
    }

    // ==========================================
    // METHOD 2: HTML5 Media Element Control
    // ==========================================

    let html5BaseVolumes = new WeakMap();

    function setHTML5Volume(volume) {
        const mediaElements = document.querySelectorAll('audio, video');

        mediaElements.forEach(el => {
            // Store original volume if not already stored
            if (!html5BaseVolumes.has(el)) {
                html5BaseVolumes.set(el, el.volume);
            }

            // HTML5 volume is capped at 1.0
            const baseVolume = html5BaseVolumes.get(el) || 1;
            el.volume = Math.min(1, Math.max(0, baseVolume * volume));
        });
    }

    // Watch for dynamically added media elements
    const observer = new MutationObserver((mutations) => {
        if (currentMethod === 'html5') {
            setHTML5Volume(currentVolume);
        }
    });

    observer.observe(document.documentElement, {
        childList: true,
        subtree: true
    });

    // ==========================================
    // Volume Control Interface
    // ==========================================

    function setVolume(volume, method) {
        currentVolume = volume;
        currentMethod = method;

        if (method === 'webaudio') {
            setWebAudioVolume(volume);
        } else if (method === 'html5') {
            setHTML5Volume(volume);
        } else {
            // 'both' - apply both methods
            setWebAudioVolume(volume);
            setHTML5Volume(volume);
        }
    }

    // Listen for messages from content script
    window.addEventListener('message', (event) => {
        if (event.data?.type === 'VOLUME_CONTROL_SET') {
            setVolume(event.data.volume, event.data.method);
        }
    });

    // Signal that injector is ready
    window.postMessage({ type: 'VOLUME_CONTROL_READY' }, '*');

    console.log('[Volume Control] Audio injector loaded');
})();
