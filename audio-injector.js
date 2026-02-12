// Audio Injector 

(function () {
    'use strict';

    function getChannelToken() {
        const fromCurrentScript = document.currentScript
            && document.currentScript.dataset
            && document.currentScript.dataset.waveformChannel;
        if (fromCurrentScript) return fromCurrentScript;

        const fallbackScript = document.querySelector('script[data-waveform-channel][src*="audio-injector.js"]');
        if (fallbackScript && fallbackScript.dataset) {
            return fallbackScript.dataset.waveformChannel || null;
        }
        return null;
    }

    const channelToken = getChannelToken();

    if (!channelToken) {
        console.warn('[Waveform] Missing secure channel token; injector disabled');
        return;
    }

    const injectorEvents = {
        command: `waveform:command:${channelToken}`,
        state: `waveform:state:${channelToken}`,
        ready: `waveform:ready:${channelToken}`
    };

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

    const gainNodes = new Map();
    const mediaSourceNodes = new WeakMap();
    let html5ApplyTimer = null;
    let stateBroadcastTimer = null;

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

    function scheduleAudioStateUpdate() {
        if (stateBroadcastTimer !== null) return;
        stateBroadcastTimer = window.setTimeout(() => {
            stateBroadcastTimer = null;
            broadcastAudioState();
        }, 80);
    }

    function scheduleHTML5VolumeApply() {
        if (html5ApplyTimer !== null) return;
        html5ApplyTimer = window.setTimeout(() => {
            html5ApplyTimer = null;
            if (currentMethod === 'html5' || currentMethod === 'both') {
                setHTML5Volume(currentVolume);
            }
        }, 50);
    }

    if (OriginalAudioContext) {
        window.AudioContext = function (...args) {
            const ctx = new OriginalAudioContext(...args);
            setupAudioContext(ctx);
            scheduleAudioStateUpdate();

            return ctx;
        };
        window.AudioContext.prototype = OriginalAudioContext.prototype;
    }

    if (OriginalWebkitAudioContext) {
        window.webkitAudioContext = function (...args) {
            const ctx = new OriginalWebkitAudioContext(...args);
            setupAudioContext(ctx);
            scheduleAudioStateUpdate();

            return ctx;
        };
        window.webkitAudioContext.prototype = OriginalWebkitAudioContext.prototype;
    }

    function setupAudioContext(ctx) {
        const gain = ctx.createGain();
        gain.gain.value = currentVolume;
        gainNodes.set(ctx, gain);
        const realDestination = ctx.destination;

        gain.connect(realDestination);

        ctx._realDestination = realDestination;
        ctx._volumeGain = gain;

        const cleanup = () => {
            if (ctx.state === 'closed') {
                gainNodes.delete(ctx);
                ctx.removeEventListener('statechange', cleanup);
            }
        };
        ctx.addEventListener('statechange', cleanup);
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
        gainNodes.forEach((gain, ctx) => {
            if (!ctx || ctx.state === 'closed') {
                gainNodes.delete(ctx);
                return;
            }
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

        const onMediaChange = () => {
            scheduleAudioStateUpdate();
        };

        el.addEventListener('loadedmetadata', onMediaChange);
        el.addEventListener('loadeddata', onMediaChange);
        el.addEventListener('durationchange', onMediaChange);
        el.addEventListener('emptied', onMediaChange);
        el.addEventListener('error', onMediaChange);

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
        const foundCodecs = [];
        let streamType = null;

        const addCodec = (codecInfo) => {
            if (!codecInfo || codecsSet.has(codecInfo.codec)) return;
            codecsSet.add(codecInfo.codec);
            foundCodecs.push(codecInfo);
        };

        // Check source URL
        const src = el.currentSrc || el.src;
        if (src) {
            const detected = detectStreamType(src);
            if (detected) {
                streamType = detected;
            }
        }

        // Try to get codec from source elements
        const sources = el.querySelectorAll('source');
        sources.forEach(source => {
            const type = source.getAttribute('type');
            if (type) {
                const parsed = parseCodecFromMime(type);
                if (parsed) {
                    parsed.forEach(addCodec);
                }
            }

            // Also check source URL for stream type
            if (!streamType) {
                const srcUrl = source.getAttribute('src');
                if (srcUrl) {
                    const detected = detectStreamType(srcUrl);
                    if (detected) {
                        streamType = detected;
                    }
                }
            }
        });

        // Try to detect from MediaSource if available
        if (el.srcObject && el.srcObject instanceof MediaStream) {
            const tracks = el.srcObject.getTracks();
            tracks.forEach(track => {
                if (track.kind === 'video') {
                    if (!streamType) {
                        streamType = { type: 'Live', color: '#f44336' };
                    }
                }
            });
        }

        // Infer codecs from container if none found
        if (foundCodecs.length === 0 && src) {
            const urlLower = src.toLowerCase();

            // Common container/codec associations
            if (urlLower.includes('.mp4') || urlLower.includes('mp4')) {
                addCodec({ type: 'video', codec: 'H.264*', color: '#4da6ff' });
                addCodec({ type: 'audio', codec: 'AAC*', color: '#f39c12' });
            } else if (urlLower.includes('.webm')) {
                addCodec({ type: 'video', codec: 'VP9*', color: '#2ecc71' });
                addCodec({ type: 'audio', codec: 'Opus*', color: '#1abc9c' });
            } else if (urlLower.includes('.mp3')) {
                addCodec({ type: 'audio', codec: 'MP3', color: '#e67e22' });
            } else if (urlLower.includes('.m3u8')) {
                addCodec({ type: 'video', codec: 'H.264*', color: '#4da6ff' });
            }
        }

        return { streamType, codecs: foundCodecs };
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
            scheduleAudioStateUpdate();

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
                if (currentMethod === 'html5') {
                    // When in HTML5 mode, neutralized gain means element volume should apply.
                    el.volume = Math.min(1, Math.max(0, volume));
                } else {
                    el.volume = 1;
                }
            } else if (volume > 1 || currentMethod === 'webaudio') {
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

    function pruneClosedContexts() {
        gainNodes.forEach((gain, ctx) => {
            if (!ctx || ctx.state === 'closed') {
                gainNodes.delete(ctx);
            }
        });
    }

    function recomputeAudioState() {
        pruneClosedContexts();

        const hasSharedContext = !!(sharedContext && sharedContext.state !== 'closed');
        const nextState = {
            hasWebAudio: false,
            hasHTML5Audio: false,
            hasHTML5Video: false,
            webAudioContextCount: gainNodes.size + (hasSharedContext ? 1 : 0),
            html5AudioCount: 0,
            html5VideoCount: 0,
            detectedCodecs: [],
            streamType: null
        };

        nextState.hasWebAudio = nextState.webAudioContextCount > 0;

        const seenCodecs = new Set();
        document.querySelectorAll('audio, video').forEach(el => {
            processMediaElement(el);

            if (el.tagName === 'AUDIO') {
                nextState.hasHTML5Audio = true;
                nextState.html5AudioCount++;
            } else if (el.tagName === 'VIDEO') {
                nextState.hasHTML5Video = true;
                nextState.html5VideoCount++;
            }

            const info = detectMediaInfo(el);
            if (info.streamType && !nextState.streamType) {
                nextState.streamType = info.streamType;
            }

            info.codecs.forEach(codec => {
                if (seenCodecs.has(codec.codec)) return;
                seenCodecs.add(codec.codec);
                nextState.detectedCodecs.push(codec);
            });
        });

        return nextState;
    }

    function broadcastAudioState() {
        const next = recomputeAudioState();
        Object.assign(audioState, next);

        const payload = JSON.stringify({
            audioState: {
                ...audioState,
                detectedCodecs: [...audioState.detectedCodecs],
                streamType: audioState.streamType ? { ...audioState.streamType } : null
            }
        });
        window.dispatchEvent(new CustomEvent(injectorEvents.state, { detail: payload }));
    }

    // ==========================================
    // Media Observer
    // ==========================================

    function setupMediaObserver() {
        document.querySelectorAll('audio, video').forEach(el => {
            processMediaElement(el);
        });
        scheduleAudioStateUpdate();

        const observer = new MutationObserver((mutations) => {
            let hasMediaAddedOrChanged = false;
            let hasMediaRemoved = false;

            mutations.forEach(mutation => {
                if (mutation.type === 'attributes') {
                    const target = mutation.target;
                    if (target && target.matches) {
                        if (target.matches('audio, video')) {
                            processMediaElement(target);
                            hasMediaAddedOrChanged = true;
                        } else if (target.matches('source')) {
                            const mediaParent = target.closest('audio, video');
                            if (mediaParent) {
                                processMediaElement(mediaParent);
                                hasMediaAddedOrChanged = true;
                            }
                        }
                    }
                    return;
                }

                if (mutation.type === 'childList') {
                    mutation.addedNodes.forEach(node => {
                        if (!node || !node.nodeType) return;

                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.matches && node.matches('audio, video')) {
                                processMediaElement(node);
                                hasMediaAddedOrChanged = true;
                            }
                            if (node.querySelectorAll) {
                                const nestedMedia = node.querySelectorAll('audio, video');
                                if (nestedMedia.length > 0) {
                                    nestedMedia.forEach(el => processMediaElement(el));
                                    hasMediaAddedOrChanged = true;
                                }
                            }
                        }
                    });

                    mutation.removedNodes.forEach(node => {
                        if (!node || !node.nodeType) return;

                        if (node.nodeType === Node.ELEMENT_NODE) {
                            if (node.matches && node.matches('audio, video')) {
                                hasMediaRemoved = true;
                            } else if (node.querySelector && node.querySelector('audio, video')) {
                                hasMediaRemoved = true;
                            }
                        }
                    });
                }
            });

            if (hasMediaAddedOrChanged) {
                scheduleHTML5VolumeApply();
                scheduleAudioStateUpdate();
            } else if (hasMediaRemoved) {
                scheduleAudioStateUpdate();
            }
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['src', 'type']
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
            setHTML5Volume(volume);
            setWebAudioVolume(volume);
        } else if (method === 'html5') {
            // Neutralize prior Web Audio boosts when switching to HTML5-only control.
            setWebAudioVolume(1);
            setHTML5Volume(volume);
        } else {
            setWebAudioVolume(volume);
            setHTML5Volume(volume);
        }
    }

    // Listen for messages from content script

    window.addEventListener(injectorEvents.command, (event) => {
        let payload = event.detail;
        if (typeof payload === 'string') {
            try {
                payload = JSON.parse(payload);
            } catch {
                return;
            }
        }
        if (!payload || typeof payload !== 'object') return;

        if (payload.type === 'set-volume') {
            const volume = parseFloat(payload.volume);
            const method = String(payload.method || 'both');
            if (!Number.isNaN(volume)) {
                setVolume(volume, method);
            }
            return;
        }

        if (payload.type === 'set-persist') {
            persistVolume = !!payload.persist;
            console.log(`[Waveform] Persist volume: ${persistVolume}`);
            // Re-apply immediately if turned on
            if (persistVolume) {
                setVolume(currentVolume, currentMethod);
            }
            return;
        }

        if (payload.type === 'get-state') {
            broadcastAudioState();
        }
    });

    // Initialize
    setupMediaObserver();

    // Broadcast initial state
    broadcastAudioState();

    window.dispatchEvent(new CustomEvent(injectorEvents.ready));

    console.log('[Waveform] Audio injector loaded and ready');
})();
