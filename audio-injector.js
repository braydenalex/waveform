// Audio Injector 

(function () {
    'use strict';

    let currentVolume = 1.0;
    let currentMethod = 'both';
    let persistVolume = false;

    const audioState = {
        hasWebAudio: false,
        hasHTML5Audio: false,
        hasHTML5Video: false,
        webAudioContextCount: 0,
        html5AudioCount: 0,
        html5VideoCount: 0,
        // Codec detection
        detectedCodecs: [],
        streamType: null  // 'hls', 'dash', 'direct', etc.
    };

    // ==========================================
    // METHOD 1: Web Audio API - Capture & Route
    // ==========================================

    const audioContexts = new Set();
    const gainNodes = new Map();
    const mediaSourceNodes = new Map();

    const OriginalAudioContext = window.AudioContext;
    const OriginalWebkitAudioContext = window.webkitAudioContext;

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

    if (OriginalAudioContext) {
        window.AudioContext = function (...args) {
            const ctx = new OriginalAudioContext(...args);
            setupAudioContext(ctx);

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

            audioState.hasWebAudio = true;
            audioState.webAudioContextCount++;
            broadcastAudioState();

            return ctx;
        };
        window.webkitAudioContext.prototype = OriginalWebkitAudioContext.prototype;
    }

    function setupAudioContext(ctx) {
        audioContexts.add(ctx);

        const gain = ctx.createGain();
        gain.gain.value = currentVolume;
        gainNodes.set(ctx, gain);
        const realDestination = ctx.destination;

        gain.connect(realDestination);

        ctx._realDestination = realDestination;
        ctx._volumeGain = gain;
    }

    const OriginalConnect = AudioNode.prototype.connect;
    AudioNode.prototype.connect = function (destination, ...args) {
        if (destination instanceof AudioDestinationNode) {
            const ctx = this.context;
            const gain = gainNodes.get(ctx);
            if (gain && this !== gain) {
                return OriginalConnect.call(this, gain, ...args);
            }
        }
        return OriginalConnect.call(this, destination, ...args);
    };

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

        if (el.tagName === 'AUDIO') {
            audioState.hasHTML5Audio = true;
            audioState.html5AudioCount++;
        } else if (el.tagName === 'VIDEO') {
            audioState.hasHTML5Video = true;
            audioState.html5VideoCount++;
        }

        // Detect codecs and stream type
        detectMediaInfo(el);

        el.addEventListener('loadedmetadata', () => detectMediaInfo(el));
        el.addEventListener('loadeddata', () => detectMediaInfo(el));

        // Persistence listeners
        const applyPersistence = () => {
            if (persistVolume) {
                if (currentMethod === 'html5' || currentMethod === 'both') {
                    if (Math.abs(el.volume - currentVolume) > 0.01 && currentVolume <= 1) {
                        el.volume = currentVolume;
                    }
                }
                if (currentMethod === 'webaudio' || currentMethod === 'both') {
                    if (currentVolume > 1) {
                        routeMediaThroughWebAudio(el);
                    }
                }
            }
        };

        el.addEventListener('loadeddata', applyPersistence);
        el.addEventListener('durationchange', applyPersistence);
        el.addEventListener('play', applyPersistence);

        broadcastAudioState();
    }

    // ==========================================
    // CODEC DETECTION
    // ==========================================

    const VIDEO_CODECS = [
        { name: 'H.264', color: '#4da6ff', patterns: ['avc1', 'h264', 'mp4v'] },
        { name: 'H.265/HEVC', color: '#9b59b6', patterns: ['hev1', 'hvc1', 'h265', 'hevc'] },
        { name: 'VP9', color: '#2ecc71', patterns: ['vp9', 'vp09'] },
        { name: 'VP8', color: '#27ae60', patterns: ['vp8'] },
        { name: 'AV1', color: '#e74c3c', patterns: ['av01', 'av1'] }
    ];

    const AUDIO_CODECS = [
        { name: 'AAC', color: '#f39c12', patterns: ['mp4a', 'aac'] },
        { name: 'MP3', color: '#e67e22', patterns: ['mp3', 'mpeg'], exclude: ['mp4'] },
        { name: 'Opus', color: '#1abc9c', patterns: ['opus'] },
        { name: 'Vorbis', color: '#16a085', patterns: ['vorbis'] },
        { name: 'FLAC', color: '#3498db', patterns: ['flac'] },
        { name: 'Dolby', color: '#8e44ad', patterns: ['ac-3', 'ec-3', 'ac3'] }
    ];

    const STREAM_TYPES = [
        { type: 'HLS', color: '#e91e63', patterns: ['.m3u8', 'm3u8'] },
        { type: 'DASH', color: '#673ab7', patterns: ['.mpd', 'dash'] },
        { type: 'MP4', color: '#607d8b', patterns: ['.mp4'] },
        { type: 'WebM', color: '#009688', patterns: ['.webm'] },
        { type: 'MP3', color: '#e67e22', patterns: ['.mp3'] },
        { type: 'OGG', color: '#795548', patterns: ['.ogg', '.oga'] },
        { type: 'FLAC', color: '#3498db', patterns: ['.flac'] },
        { type: 'WAV', color: '#9e9e9e', patterns: ['.wav'] },
        { type: 'Blob/MSE', color: '#ff5722', patterns: ['blob:'] }
    ];

    function parseCodecFromMime(mimeType) {
        if (!mimeType) return null;

        const codecs = [];
        const mime = mimeType.toLowerCase();

        const check = (def) => {
            const match = def.patterns.some(p => mime.includes(p));
            if (match && (!def.exclude || !def.exclude.some(e => mime.includes(e)))) {
                return true;
            }
            return false;
        };

        VIDEO_CODECS.forEach(def => {
            if (check(def)) codecs.push({ type: 'video', codec: def.name, color: def.color });
        });

        AUDIO_CODECS.forEach(def => {
            if (check(def)) codecs.push({ type: 'audio', codec: def.name, color: def.color });
        });

        return codecs;
    }

    function detectStreamType(url) {
        if (!url) return null;
        const urlLower = url.toLowerCase();

        for (const def of STREAM_TYPES) {
            if (def.patterns.some(p => urlLower.includes(p))) {
                return { type: def.type, color: def.color };
            }
        }

        return { type: 'Stream', color: '#607d8b' };
    }

    // Detect media info from element
    function detectMediaInfo(el) {
        const codecsSet = new Set();
        let foundCodecs = [];

        // Check source URL
        const src = el.currentSrc || el.src;
        if (src) {
            const streamType = detectStreamType(src);
            if (streamType) {
                audioState.streamType = streamType;
            }
        }

        // Try to get codec from source elements
        const sources = el.querySelectorAll('source');
        sources.forEach(source => {
            const type = source.getAttribute('type');
            if (type) {
                const parsed = parseCodecFromMime(type);
                if (parsed) {
                    parsed.forEach(c => {
                        if (!codecsSet.has(c.codec)) {
                            codecsSet.add(c.codec);
                            foundCodecs.push(c);
                        }
                    });
                }
            }

            // Also check source URL for stream type
            const srcUrl = source.getAttribute('src');
            if (srcUrl && !audioState.streamType) {
                const streamType = detectStreamType(srcUrl);
                if (streamType) {
                    audioState.streamType = streamType;
                }
            }
        });

        // Try to detect from MediaSource if available
        if (el.srcObject && el.srcObject instanceof MediaStream) {
            const tracks = el.srcObject.getTracks();
            tracks.forEach(track => {
                if (track.kind === 'video') {
                    if (!audioState.streamType) {
                        audioState.streamType = { type: 'Live', color: '#f44336' };
                    }
                }
            });
        }

        // Infer codecs from container if none found
        if (foundCodecs.length === 0 && src) {
            const urlLower = src.toLowerCase();

            // Common container/codec associations
            if (urlLower.includes('.mp4') || urlLower.includes('mp4')) {
                foundCodecs.push({ type: 'video', codec: 'H.264*', color: '#4da6ff' });
                foundCodecs.push({ type: 'audio', codec: 'AAC*', color: '#f39c12' });
            } else if (urlLower.includes('.webm')) {
                foundCodecs.push({ type: 'video', codec: 'VP9*', color: '#2ecc71' });
                foundCodecs.push({ type: 'audio', codec: 'Opus*', color: '#1abc9c' });
            } else if (urlLower.includes('.mp3')) {
                foundCodecs.push({ type: 'audio', codec: 'MP3', color: '#e67e22' });
            } else if (urlLower.includes('.m3u8')) {
                foundCodecs.push({ type: 'video', codec: 'H.264*', color: '#4da6ff' });
            }
        }

        if (foundCodecs.length > 0) {
            foundCodecs.forEach(c => {
                const exists = audioState.detectedCodecs.some(existing => existing.codec === c.codec);
                if (!exists) {
                    audioState.detectedCodecs.push(c);
                }
            });
            broadcastAudioState();
        }
    }

    function routeMediaThroughWebAudio(el) {
        try {
            if (mediaSourceNodes.has(el)) {
                return true;
            }

            const { context, gain } = getSharedContext();
            if (!context) return false;

            // Resume context if suspended (autoplay policy)
            if (context.state === 'suspended') {
                context.resume();
            }

            const source = context.createMediaElementSource(el);
            mediaSourceNodes.set(el, source);

            source.connect(gain);

            el.volume = 1;

            return true;
        } catch (e) {
            console.log('[Waveform] Cannot route media through Web Audio:', e.message);
            return false;
        }
    }

    function setHTML5Volume(volume) {
        const mediaElements = document.querySelectorAll('audio, video');

        mediaElements.forEach(el => {
            processMediaElement(el);

            if (mediaSourceNodes.has(el)) {
                el.volume = 1;
            } else if (volume > 1) {
                if (!routeMediaThroughWebAudio(el)) {
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
        document.querySelectorAll('audio, video').forEach(el => {
            processMediaElement(el);
        });

        const observer = new MutationObserver((mutations) => {
            mutations.forEach(mutation => {
                mutation.addedNodes.forEach(node => {
                    if (node.nodeName === 'AUDIO' || node.nodeName === 'VIDEO') {
                        processMediaElement(node);
                        if (currentMethod === 'html5' || currentMethod === 'both') {
                            setHTML5Volume(currentVolume);
                        }
                    }
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
        if (typeof volume !== 'number' || !isFinite(volume)) {
            console.warn('[Waveform] Invalid volume value');
            return;
        }
        volume = Math.max(0, Math.min(100, volume));

        const validMethods = ['webaudio', 'html5', 'both'];
        if (!validMethods.includes(method)) {
            method = 'both';
        }

        currentVolume = volume;
        currentMethod = method;

        console.log(`[Waveform] Volume: ${(volume * 100).toFixed(0)}%, Method: ${method}`);

        if (method === 'webaudio') {
            setWebAudioVolume(volume);
        } else if (method === 'html5') {
            setHTML5Volume(volume);
        } else {
            setWebAudioVolume(volume);
            setHTML5Volume(volume);
        }
    }

    // Listen for messages from content script

    window.addEventListener('message', (event) => {
        if (event.source !== window) return;

        if (!event.data || typeof event.data !== 'object') return;

        if (event.data.type === 'VOLUME_CONTROL_SET') {
            const volume = parseFloat(event.data.volume);
            const method = String(event.data.method || 'both');
            if (!isNaN(volume)) {
                setVolume(volume, method);
            }
        }

        if (event.data.type === 'VOLUME_CONTROL_SET_PERSIST') {
            persistVolume = !!event.data.persist;
            console.log(`[Waveform] Persist volume: ${persistVolume}`);
            // Re-apply immediately if turned on
            if (persistVolume) {
                setVolume(currentVolume, currentMethod);
            }
        }

        if (event.data.type === 'VOLUME_CONTROL_GET_STATE') {
            broadcastAudioState();
        }
    });

    // Initialize
    setupMediaObserver();

    // Broadcast initial state
    broadcastAudioState();

    window.postMessage({ type: 'VOLUME_CONTROL_READY' }, '*');

    console.log('[Waveform] Audio injector loaded and ready');
})();
