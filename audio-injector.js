// Audio Injector - runs in page context (not content script sandbox)
// Provides multiple methods for volume control and audio type detection

(function () {
    'use strict';

    let currentVolume = 1.0;
    let currentMethod = 'both';

    // Audio detection state
    const audioState = {
        hasWebAudio: false,
        hasHTML5Audio: false,
        hasHTML5Video: false,
        webAudioContextCount: 0,
        html5AudioCount: 0,
        html5VideoCount: 0
    };

    // ==========================================
    // METHOD 1: Web Audio API - Capture & Route
    // ==========================================

    const audioContexts = new Set();
    const gainNodes = new Map(); // Map AudioContext -> GainNode
    const mediaSourceNodes = new Map(); // Map HTMLMediaElement -> MediaElementSourceNode

    // Store original constructors
    const OriginalAudioContext = window.AudioContext;
    const OriginalWebkitAudioContext = window.webkitAudioContext;

    // Create a shared AudioContext for HTML5 media boost
    let sharedContext = null;
    let sharedGain = null;

    function getSharedContext() {
        if (!sharedContext || sharedContext.state === 'closed') {
            const Ctx = OriginalAudioContext || OriginalWebkitAudioContext;
            if (Ctx) {
                sharedContext = new Ctx();
                sharedGain = sharedContext.createGain();
                sharedGain.connect(sharedContext.destination);
                sharedGain.gain.value = currentVolume;
            }
        }
        return { context: sharedContext, gain: sharedGain };
    }

    // Patch AudioContext to capture all new instances
    if (OriginalAudioContext) {
        window.AudioContext = function (...args) {
            const ctx = new OriginalAudioContext(...args);
            setupAudioContext(ctx);

            // Update detection state
            audioState.hasWebAudio = true;
            audioState.webAudioContextCount++;
            broadcastAudioState();

            return ctx;
        };
        window.AudioContext.prototype = OriginalAudioContext.prototype;
    }

    if (OriginalWebkitAudioContext) {
        window.webkitAudioContext = function (...args) {
            const ctx = new OriginalWebkitAudioContext(...args);
            setupAudioContext(ctx);

            // Update detection state
            audioState.hasWebAudio = true;
            audioState.webAudioContextCount++;
            broadcastAudioState();

            return ctx;
        };
        window.webkitAudioContext.prototype = OriginalWebkitAudioContext.prototype;
    }

    function setupAudioContext(ctx) {
        audioContexts.add(ctx);

        // Create a gain node for this context
        const gain = ctx.createGain();
        gain.gain.value = currentVolume;
        gainNodes.set(ctx, gain);

        // Store original destination
        const realDestination = ctx.destination;

        // Connect our gain to the real destination
        gain.connect(realDestination);

        ctx._realDestination = realDestination;
        ctx._volumeGain = gain;
    }

    // Override AudioNode.prototype.connect to intercept destination connections
    const OriginalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...args) {
        // Check if connecting to a destination node
        if (destination instanceof AudioDestinationNode) {
            // Find the gain node for this context
            const ctx = this.context;
            const gain = gainNodes.get(ctx);
            if (gain && this !== gain) {
                // Route through our gain node instead
                return OriginalConnect.call(this, gain, ...args);
            }
        }
        return OriginalConnect.call(this, destination, ...args);
    };

    // Update all Web Audio gain nodes
    function setWebAudioVolume(volume) {
        gainNodes.forEach((gain) => {
            if (gain && gain.gain) {
                gain.gain.value = volume;
            }
        });
        if (sharedGain) {
            sharedGain.gain.value = volume;
        }
    }

    // ==========================================
    // METHOD 2: HTML5 Media Element Control
    // ==========================================

    const processedMedia = new WeakSet();

    function processMediaElement(el) {
        if (processedMedia.has(el)) return;
        processedMedia.add(el);

        // Update detection state
        if (el.tagName === 'AUDIO') {
            audioState.hasHTML5Audio = true;
            audioState.html5AudioCount++;
        } else if (el.tagName === 'VIDEO') {
            audioState.hasHTML5Video = true;
            audioState.html5VideoCount++;
        }
        broadcastAudioState();

        // Store the original volume
        el._originalVolume = el.volume;
        el._volumeMultiplier = currentVolume;
    }

    function routeMediaThroughWebAudio(el) {
        try {
            // Check if already routed
            if (mediaSourceNodes.has(el)) {
                return true;
            }

            const { context, gain } = getSharedContext();
            if (!context) return false;

            // Resume context if suspended (autoplay policy)
            if (context.state === 'suspended') {
                context.resume();
            }

            // Create a source node from the media element
            const source = context.createMediaElementSource(el);
            mediaSourceNodes.set(el, source);

            // Connect to our gain node
            source.connect(gain);

            // Set element volume to max since gain handles it
            el.volume = 1;

            return true;
        } catch (e) {
            // Media element might already be connected or CORS issue
            console.log('[Volume Control] Cannot route media through Web Audio:', e.message);
            return false;
        }
    }

    function setHTML5Volume(volume) {
        const mediaElements = document.querySelectorAll('audio, video');

        mediaElements.forEach(el => {
            processMediaElement(el);

            if (mediaSourceNodes.has(el)) {
                // Already routed through Web Audio, gain node handles volume
                el.volume = 1;
            } else if (volume > 1) {
                // Try to route through Web Audio for boost
                if (!routeMediaThroughWebAudio(el)) {
                    // Fallback - can't boost, just set to max
                    el.volume = 1;
                }
            } else {
                // Simple volume (0-100%)
                el.volume = Math.min(1, Math.max(0, volume));
            }
        });
    }

    // ==========================================
    // Audio State Broadcasting
    // ==========================================

    function broadcastAudioState() {
        window.postMessage({
            type: 'VOLUME_CONTROL_AUDIO_STATE',
            audioState: { ...audioState }
        }, '*');
    }

    // ==========================================
    // Media Observer
    // ==========================================

    function setupMediaObserver() {
        // Process existing elements
        document.querySelectorAll('audio, video').forEach(el => {
            processMediaElement(el);
        });

        // Watch for new elements
        const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') {
                        processMediaElement(node);
                        if (currentMethod === 'html5' || currentMethod === 'both') {
                            setHTML5Volume(currentVolume);
                        }
                    }
                    // Check children
                    if (node.querySelectorAll) {
                        node.querySelectorAll('audio, video').forEach(el => {
                            processMediaElement(el);
                            if (currentMethod === 'html5' || currentMethod === 'both') {
                                setHTML5Volume(currentVolume);
                            }
                        });
                    }
                });
            });
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    }

    // ==========================================
    // Volume Control Interface
    // ==========================================

    function setVolume(volume, method) {
        currentVolume = volume;
        currentMethod = method;

        console.log(`[Volume Control] Setting volume to ${(volume * 100).toFixed(0)}% using ${method} method`);

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

        if (event.data?.type === 'VOLUME_CONTROL_GET_STATE') {
            broadcastAudioState();
        }
    });

    // Initialize
    setupMediaObserver();

    // Broadcast initial state
    broadcastAudioState();

    // Signal that injector is ready
    window.postMessage({ type: 'VOLUME_CONTROL_READY' }, '*');

    console.log('[Volume Control] Audio injector loaded and ready');
})();
