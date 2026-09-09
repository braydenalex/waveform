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
        ready: `waveform:ready:${channelToken}`,
        media: `waveform:media:${channelToken}`,
        nativeTouched: `waveform:native-volume-touched:${channelToken}`
    };

    let currentVolume = 1.0;
    let currentMethod = 'both';
    let persistVolume = false;
    let nativeVolumeControl = true;
    let lastNativeTouchTs = 0;

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

    const pageContexts = new Map();
    const mediaRecords = new WeakMap();
    const trackedMedia = new Set();
    const siteMediaContexts = new WeakMap();
    let html5ApplyTimer = null;
    let stateBroadcastTimer = null;
    let settingsRevision = -1;
    let sharedContext = null;
    let resumePending = null;
    let contextFailure = null;
    let resumeTimer = null;

    const OriginalAudioContext = window.AudioContext || window.webkitAudioContext;
    const OriginalConnect = window.AudioNode?.prototype.connect;
    const OriginalDisconnect = window.AudioNode?.prototype.disconnect;
    const OriginalCreateSource = OriginalAudioContext?.prototype.createMediaElementSource;

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
            applyCurrentVolumeStrategy();
        }, 50);
    }

    function pageGraphEnabled() {
        return !nativeVolumeControl && currentMethod !== 'html5';
    }

    function trackContext(ctx) {
        if (ctx === sharedContext || ctx.state === 'closed') return null;
        if (pageContexts.has(ctx)) return pageContexts.get(ctx);
        const record = { gain: null, edges: new Map() };
        pageContexts.set(ctx, record);
        const onState = () => {
            if (ctx.state === 'closed') {
                pageContexts.delete(ctx);
                ctx.removeEventListener('statechange', onState);
            }
            scheduleAudioStateUpdate();
        };
        ctx.addEventListener('statechange', onState);
        scheduleAudioStateUpdate();
        return record;
    }

    function contextGain(ctx, record) {
        if (!record.gain) {
            const gain = ctx.createGain();
            gain.channelCount = ctx.destination.channelCount;
            gain.channelCountMode = 'explicit';
            gain.gain.value = pageGraphEnabled() ? currentVolume : 1;
            OriginalConnect.call(gain, ctx.destination);
            record.gain = gain;
        }
        return record.gain;
    }

    // Record only destination edges. All other graph operations use native APIs.
    // Use the same physical destination for connect AND every disconnect overload.
    if (OriginalConnect && OriginalDisconnect) {
        window.AudioNode.prototype.connect = function (destination, ...args) {
            const ctx = this.context;
            if (destination !== ctx.destination || ctx === sharedContext) {
                return OriginalConnect.call(this, destination, ...args);
            }
            const record = trackContext(ctx);
            if (!record || this === record.gain) {
                return OriginalConnect.call(this, destination, ...args);
            }
            const redirected = pageGraphEnabled();
            const physical = redirected ? contextGain(ctx, record) : destination;
            OriginalConnect.call(this, physical, ...args);
            const output = Number(args[0] ?? 0) >>> 0;
            const input = Number(args[1] ?? 0) >>> 0;
            const edges = record.edges.get(this) || [];
            if (!edges.some(edge => edge.output === output && edge.input === input)) {
                edges.push({ output, input, redirected });
                record.edges.set(this, edges);
            }
            if (this.mediaElement) siteMediaContexts.set(this.mediaElement, ctx);
            scheduleAudioStateUpdate();
            return destination;
        };
        window.AudioNode.prototype.disconnect = function (...args) {
            const ctx = this.context;
            const record = pageContexts.get(ctx);
            const edges = record?.edges.get(this);
            if (!edges) return OriginalDisconnect.apply(this, args);
            const destination = args[0];
            const destinationOverload = destination instanceof window.AudioNode;
            const physicalArgs = [...args];
            if (destination === ctx.destination && edges[0].redirected) {
                physicalArgs[0] = record.gain;
            }
            // Native validation must succeed before changing our bookkeeping.
            const result = OriginalDisconnect.apply(this, physicalArgs);
            let remaining = edges;
            if (!args.length) remaining = [];
            else if (!destinationOverload && !(window.AudioParam && destination instanceof window.AudioParam)) {
                const output = Number(destination) >>> 0;
                remaining = edges.filter(edge => edge.output !== output);
            } else if (destination === ctx.destination) {
                remaining = edges.filter(edge =>
                    (args.length > 1 && edge.output !== (Number(args[1]) >>> 0)) ||
                    (args.length > 2 && edge.input !== (Number(args[2]) >>> 0)));
            }
            if (remaining.length) record.edges.set(this, remaining);
            else record.edges.delete(this);
            scheduleAudioStateUpdate();
            return result;
        };
    }

    // Preserve native construction, subclassing, static members, and call errors.
    for (const name of ['AudioContext', 'webkitAudioContext']) {
        const Original = window[name];
        if (!Original) continue;
        window[name] = new Proxy(Original, {
            construct(target, args, newTarget) {
                const ctx = Reflect.construct(target, args, newTarget);
                trackContext(ctx);
                return ctx;
            }
        });
    }
    if (OriginalCreateSource) {
        OriginalAudioContext.prototype.createMediaElementSource = function (el) {
            const source = OriginalCreateSource.call(this, el);
            if (this !== sharedContext) siteMediaContexts.set(el, this);
            return source;
        };
    }

    function updatePageGraphs() {
        pageContexts.forEach((record, ctx) => {
            if (ctx.state === 'closed') return;
            const redirected = pageGraphEnabled();
            record.failure = null;
            if (record.gain) record.gain.gain.value = redirected ? currentVolume : 1;
            record.edges.forEach((edges, node) => {
                for (const edge of edges) {
                    if (edge.redirected === redirected) continue;
                    const oldTarget = edge.redirected ? record.gain : ctx.destination;
                    const newTarget = redirected ? contextGain(ctx, record) : ctx.destination;
                    try {
                        OriginalConnect.call(node, newTarget, edge.output, edge.input);
                        OriginalDisconnect.call(node, oldTarget, edge.output, edge.input);
                        edge.redirected = redirected;
                    } catch {
                        // Leave the original path intact if rewiring fails.
                        try { OriginalDisconnect.call(node, newTarget, edge.output, edge.input); } catch {}
                        record.failure = 'graph-unavailable';
                    }
                }
            });
        });
    }

    function getSharedContext() {
        if (!OriginalAudioContext || !OriginalCreateSource) return null;
        // An element cannot be attached again after its context is closed.
        if (sharedContext) return sharedContext;
        sharedContext = new OriginalAudioContext();
        sharedContext.addEventListener('statechange', () => {
            if (sharedContext.state === 'running') contextFailure = null;
            if (sharedContext.state === 'closed') contextFailure = 'context-closed';
            scheduleHTML5VolumeApply();
            scheduleAudioStateUpdate();
        });
        return sharedContext;
    }

    function resumeSharedContext(userGesture = false) {
        const ctx = sharedContext;
        if (!ctx || ctx.state === 'running') return Promise.resolve(true);
        if (ctx.state === 'closed') {
            contextFailure = 'context-closed';
            return Promise.resolve(false);
        }
        if (resumePending && !userGesture) return resumePending;
        contextFailure = 'interaction-required';
        scheduleAudioStateUpdate();
        // A blocked resume can remain pending indefinitely. Report it immediately;
        // attach nothing until it actually resolves and the context is running.
        let resumed;
        try { resumed = ctx.resume(); } catch (error) { resumed = Promise.reject(error); }
        const pending = Promise.resolve(resumed).then(() => {
            contextFailure = ctx.state === 'running' ? null : 'interaction-required';
            return ctx.state === 'running';
        }, () => {
            contextFailure = 'resume-failed';
            return false;
        }).finally(() => {
            if (resumePending === pending) resumePending = null;
            scheduleAudioStateUpdate();
        });
        resumePending = pending;
        return pending;
    }

    function sourceKey(el) {
        return `${el.currentSrc || el.src || ''}|${el.crossOrigin ?? 'no-cors'}`;
    }

    function writeElementVolume(el, volume) {
        const record = processMediaElement(el);
        const next = Math.min(1, Math.max(0, volume));
        if (el.volume === next) return;
        if (record.lastWrite === null || el.volume !== record.lastWrite) record.originalVolume = el.volume;
        record.lastWrite = next;
        el.volume = next;
    }

    function restoreElementVolume(el, record) {
        if (record.lastWrite !== null && el.volume === record.lastWrite) {
            el.volume = record.originalVolume;
        }
        record.lastWrite = null;
    }

    function processMediaElement(el) {
        if (mediaRecords.has(el)) { trackedMedia.add(el); return mediaRecords.get(el); }
        const record = {
            originalVolume: el.volume, lastWrite: null, source: null, gain: null,
            pending: false, failedKey: null, failure: null, reloadRequired: false,
            encrypted: !!el.mediaKeys, loadCors: null, loadKey: null, corsVerified: false
        };
        mediaRecords.set(el, record);
        trackedMedia.add(el);
        const onLoadStart = () => {
            record.loadCors = el.crossOrigin;
            record.loadKey = el.currentSrc || el.src;
            record.corsVerified = false;
            record.encrypted = !!el.mediaKeys;
            record.failedKey = null;
            record.failure = null;
        };
        el.addEventListener('loadstart', onLoadStart);
        el.addEventListener('encrypted', () => {
            record.encrypted = true;
            scheduleHTML5VolumeApply();
        });
        el.addEventListener('loadeddata', () => {
            record.corsVerified = record.loadCors !== null && record.loadCors === el.crossOrigin &&
                record.loadKey === (el.currentSrc || el.src);
        });
        for (const event of ['loadedmetadata', 'loadeddata', 'durationchange', 'emptied', 'error', 'play', 'playing', 'pause', 'ended']) {
            el.addEventListener(event, () => {
                if (event === 'emptied') {
                    record.corsVerified = false;
                    record.failedKey = null;
                }
                if (event === 'play' || event === 'playing') {
                    trackedMedia.add(el);
                    recoverContext();
                }
                // Route health is always maintained, independently of persistence.
                if (event === 'play' || event === 'playing' || record.source || persistVolume || record.pending || currentVolume > 1) scheduleHTML5VolumeApply();
                scheduleAudioStateUpdate();
            });
        }
        el.addEventListener('volumechange', () => {
            if (record.lastWrite !== null && el.volume !== record.lastWrite) {
                record.originalVolume = el.volume;
                record.lastWrite = null;
            }
            scheduleAudioStateUpdate();
        });
        return record;
    }

    // Audio created with new Audio(), or played inside a shadow tree, need not
    // appear in document.querySelectorAll(). Preserve native play's exact return
    // value and errors, then register the element without changing its source.
    function observePlayer(el, playing = false) {
        try {
            processMediaElement(el);
            if (playing) applyMedia(el);
            scheduleAudioStateUpdate();
        } catch { /* Discovery must not change the site's API behavior. */ }
        return el;
    }
    const OriginalPlay = window.HTMLMediaElement?.prototype.play;
    if (OriginalPlay) {
        window.HTMLMediaElement.prototype.play = function (...args) {
            const result = Reflect.apply(OriginalPlay, this, args);
            observePlayer(this, true);
            return result;
        };
    }
    if (window.Audio) {
        window.Audio = new Proxy(window.Audio, {
            construct(target, args, newTarget) {
                return observePlayer(Reflect.construct(target, args, newTarget));
            },
            apply(target, receiver, args) {
                return observePlayer(Reflect.apply(target, receiver, args));
            }
        });
    }
    window.addEventListener(injectorEvents.media, event => {
        const element = event.detail?.element;
        if (window.HTMLMediaElement && element instanceof window.HTMLMediaElement) {
            observePlayer(element, !element.paused);
        }
    });

    function hasNoAudioTrack(el) {
        // Firefox exposes whether a loaded video actually contains audio. A
        // canvas/cover animation must not stand in for a separate music player.
        return el.tagName === 'VIDEO' && el.readyState >= 1 && el.mozHasAudio === false;
    }

    function routeEligibility(el, record) {
        if (!OriginalAudioContext || !OriginalCreateSource) return 'web-audio-unavailable';
        if (hasNoAudioTrack(el)) return 'no-audio-track';
        if (record.encrypted || el.mediaKeys) return 'protected-media';
        if (el.readyState < 2 || el.error) return 'media-not-ready';
        if (el.srcObject) {
            // A MediaStream already supplied to the page does not perform a
            // cross-origin media URL fetch. Duration/currentSrc do not describe it.
            if (typeof MediaStream !== 'undefined' && el.srcObject instanceof MediaStream) {
                return el.srcObject.getAudioTracks().some(track => track.readyState === 'live')
                    ? null : 'media-not-ready';
            }
            return 'stream-unverified';
        }
        if (!el.currentSrc) return 'media-not-ready';
        let url;
        try { url = new URL(el.currentSrc, location.href); } catch { return 'source-unverified'; }
        if (url.protocol === 'blob:') {
            // Same-origin object URLs include MediaSource/HLS/DASH playback.
            // Their origin is established locally, independently of crossorigin.
            const pageOrigin = new URL(location.href).origin;
            return pageOrigin !== 'null' && url.origin === pageOrigin ? null : 'cors-unverified';
        }
        if (!['http:', 'https:'].includes(url.protocol)) return 'source-unverified';
        // Live duration is not a security signal. Direct media still needs a
        // verified CORS load because even a same-origin URL can redirect.
        if (!record.corsVerified) return 'cors-unverified';
        return null;
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

    async function routeMediaThroughWebAudio(el, record) {
        if (record.source || record.pending || record.failedKey === sourceKey(el)) return;
        const failure = routeEligibility(el, record);
        if (failure) { record.failure = failure; return; }
        const key = sourceKey(el);
        const revision = settingsRevision;
        record.pending = true;
        try {
            const ctx = getSharedContext();
            if (!ctx || !(await resumeSharedContext())) return;
            if (nativeVolumeControl || currentMethod === 'html5' ||
                (currentMethod === 'both' && currentVolume <= 1) ||
                revision !== settingsRevision || key !== sourceKey(el) || routeEligibility(el, record)) return;
            record.gain = ctx.createGain();
            record.gain.gain.value = currentVolume;
            // Build the output path first; attachment is the irreversible step.
            OriginalConnect.call(record.gain, ctx.destination);
            record.source = OriginalCreateSource.call(ctx, el);
            OriginalConnect.call(record.source, record.gain);
            record.failure = null;
            writeElementVolume(el, 1);
        } catch {
            record.failedKey = key;
            record.failure = 'routing-failed';
            record.reloadRequired = !!record.source;
            if (!record.source && record.gain) {
                OriginalDisconnect.call(record.gain);
                record.gain = null;
            }
        } finally {
            record.pending = false;
            // Reconcile settings changed while resume was pending, without looping
            // on failures or automatically retrying rejected resume promises.
            if (revision !== settingsRevision && !record.failure) scheduleHTML5VolumeApply();
            scheduleAudioStateUpdate();
        }
    }

    function recoverContext(userGesture = false) {
        if (!sharedContext || sharedContext.state === 'running') return;
        if (resumeTimer !== null && !userGesture) return;
        resumeTimer = window.setTimeout(() => { resumeTimer = null; }, 250);
        resumeSharedContext(userGesture).then(running => {
            if (running) scheduleHTML5VolumeApply();
        });
    }

    function applyMedia(el) {
        const record = processMediaElement(el);
        const eligibility = routeEligibility(el, record);
        if (!record.source && record.failedKey !== sourceKey(el)) record.failure = null;
        if (record.source) {
            if (sharedContext.state === 'closed') {
                record.failure = 'context-closed';
                record.reloadRequired = true;
            } else if (eligibility && !['media-not-ready', 'no-audio-track'].includes(eligibility)) {
                record.failure = eligibility;
                record.reloadRequired = true;
            }
            if (record.reloadRequired) record.gain.gain.value = 1;
        }
        if (nativeVolumeControl || hasNoAudioTrack(el)) {
            if (record.gain) record.gain.gain.value = 1;
            restoreElementVolume(el, record);
            return;
        }
        const useGraph = currentMethod !== 'html5' && (currentMethod === 'webaudio' || currentVolume > 1);
        const siteContext = siteMediaContexts.get(el);
        if (siteContext) {
            // The site already owns this media source. Do not attach it a second
            // time or attenuate both its element and the context destination.
            writeElementVolume(el, pageGraphEnabled() && pageContexts.get(siteContext)?.edges.size ? 1 : Math.min(1, currentVolume));
            return;
        }
        if (record.source && useGraph && !record.reloadRequired) {
            record.gain.gain.value = currentVolume;
            writeElementVolume(el, 1);
        } else {
            if (record.gain) record.gain.gain.value = 1;
            writeElementVolume(el, Math.min(1, currentVolume));
            if (useGraph && !record.reloadRequired && !record.source && !contextFailure) {
                void routeMediaThroughWebAudio(el, record);
            }
        }
    }

    function currentMedia() {
        document.querySelectorAll('audio, video').forEach(processMediaElement);
        for (const el of trackedMedia) {
            const record = mediaRecords.get(el);
            if (!el.isConnected && el.paused) {
                restoreElementVolume(el, record);
                if (record.gain) record.gain.gain.value = 1;
                trackedMedia.delete(el);
            }
        }
        return [...trackedMedia];
    }

    function recomputeAudioState() {
        const states = [];
        const nextState = {
            hasWebAudio: pageContexts.size > 0,
            hasHTML5Audio: false, hasHTML5Video: false,
            webAudioContextCount: pageContexts.size,
            html5AudioCount: 0, html5VideoCount: 0,
            detectedCodecs: [], streamType: null,
            ready: true, effectiveMethod: nativeVolumeControl ? 'site' : 'html5',
            boostAvailable: false, failureReason: null, reloadRequired: false,
            requestedVolume: currentVolume * 100, effectiveVolume: null
        };
        const seenCodecs = new Set();
        currentMedia().forEach(el => {
            const record = processMediaElement(el);
            if (el.tagName === 'AUDIO') nextState.html5AudioCount++;
            else nextState.html5VideoCount++;
            const info = detectMediaInfo(el);
            if (info.streamType && !nextState.streamType) nextState.streamType = info.streamType;
            info.codecs.forEach(codec => {
                if (!seenCodecs.has(codec.codec)) {
                    seenCodecs.add(codec.codec);
                    nextState.detectedCodecs.push(codec);
                }
            });
            const siteContext = siteMediaContexts.get(el);
            const siteGraph = siteContext && pageContexts.get(siteContext)?.edges.size > 0;
            if (hasNoAudioTrack(el) && !record.reloadRequired) return;
            const failure = record.failure || routeEligibility(el, record);
            const graph = (record.source && !record.reloadRequired && sharedContext.state === 'running') ||
                (siteGraph && siteContext.state === 'running' && pageGraphEnabled());
            const method = nativeVolumeControl ? 'site' : graph && currentMethod !== 'html5' &&
                (siteGraph || currentMethod === 'webaudio' || currentVolume > 1) ? 'webaudio' : 'html5';
            states.push({
                loaded: el.readyState >= 2 || !!record.source || !!siteGraph,
                method, boost: !record.reloadRequired && (!!siteGraph || !failure),
                failure: record.reloadRequired ? record.failure : (!nativeVolumeControl && record.pending) ||
                    (record.source && sharedContext.state !== 'running') ? contextFailure || 'interaction-required' : failure,
                reload: record.reloadRequired,
                volume: record.reloadRequired || (record.source && sharedContext.state !== 'running') ? null :
                    method === 'site' ? null : el.muted ? 0 :
                        el.volume * 100 * (method === 'webaudio' ? record.gain?.gain.value ?? currentVolume : 1)
            });
        });
        pageContexts.forEach((record, ctx) => {
            if (!record.edges.size) return;
            states.push({ loaded: true, method: nativeVolumeControl || currentMethod === 'html5' ? 'site' : 'webaudio',
                boost: !record.failure, failure: record.failure ||
                    (ctx.state !== 'running' ? 'site-context-suspended' : null), reload: !!record.failure,
                volume: nativeVolumeControl || currentMethod === 'html5' || ctx.state !== 'running' ? null : currentVolume * 100 });
        });
        nextState.hasHTML5Audio = nextState.html5AudioCount > 0;
        nextState.hasHTML5Video = nextState.html5VideoCount > 0;
        nextState.hasWebAudio ||= !!sharedContext;
        nextState.webAudioContextCount += sharedContext ? 1 : 0;
        // Players often keep empty video elements for ads or the next item.
        // Keep their detection counts, but report capability for loaded players.
        const loaded = states.filter(state => state.loaded);
        const playback = loaded.length ? loaded : states;
        nextState.playbackCount = loaded.length;
        nextState.controllableMediaCount = states.length;
        const methods = new Set(playback.map(state => state.method));
        nextState.effectiveMethod = methods.size > 1 ? 'mixed' : playback[0]?.method || 'site';
        nextState.boostAvailable = playback.length > 0 && playback.every(state => state.boost);
        nextState.reloadRequired = states.some(state => state.reload);
        nextState.failureReason = states.find(state => state.reload)?.failure ||
            playback.find(state => ['interaction-required', 'resume-failed'].includes(state.failure))?.failure ||
            playback.find(state => state.failure)?.failure ||
            (!nativeVolumeControl && currentMethod !== 'html5' ? contextFailure : null) ||
            (!states.length && (nextState.html5AudioCount || nextState.html5VideoCount) ? 'no-audio-track' : null);
        const volumes = new Set(playback.map(state => state.volume));
        nextState.effectiveVolume = volumes.size === 1 ? playback[0]?.volume ?? null : null;
        nextState.mediaCount = nextState.html5AudioCount + nextState.html5VideoCount +
            [...pageContexts.values()].filter(record => record.edges.size > 0).length;
        return nextState;
    }

    function broadcastAudioState() {
        Object.assign(audioState, recomputeAudioState());
        window.dispatchEvent(new CustomEvent(injectorEvents.state, {
            detail: JSON.stringify({ audioState })
        }));
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
            attributeFilter: ['src', 'type', 'crossorigin']
        });
    }

    // ==========================================
    // Native Site Volume Detection
    // ==========================================

    const VOLUME_HINT_ATTRIBUTES = [
        'aria-label',
        'aria-valuetext',
        'title',
        'name',
        'id',
        'class',
        'data-testid',
        'data-title',
        'data-tooltip'
    ];
    const VOLUME_HINT_RE = /\b(volume|audio|sound|mute|speaker|loud)\b/i;
    const KNOWN_VOLUME_SELECTOR = '.ytp-volume-slider, .ytp-volume-slider-handle, .ytp-volume-panel, .ytp-volume-area, .ytp-mute-button';

    function elementHasVolumeHint(el) {
        if (!el || typeof el.getAttribute !== 'function') return false;
        for (const attr of VOLUME_HINT_ATTRIBUTES) {
            const value = el.getAttribute(attr);
            if (value && VOLUME_HINT_RE.test(String(value))) {
                return true;
            }
        }
        return false;
    }

    function isLikelyVolumeControlTarget(target) {
        if (!(target instanceof Element)) return false;

        if (target.closest(KNOWN_VOLUME_SELECTOR)) {
            return true;
        }

        const control = target.closest('input[type="range"], [role="slider"], button');
        if (!control) return false;

        if (elementHasVolumeHint(control)) {
            return true;
        }

        const hintedParent = control.closest(
            '[class*="volume"], [id*="volume"], [aria-label*="volume" i], [title*="volume" i], [name*="volume" i], [data-testid*="volume" i]'
        );
        return !!hintedParent;
    }

    function onPotentialNativeVolumeTouch(event) {
        if (nativeVolumeControl || !event || !event.isTrusted) {
            return;
        }
        if (!isLikelyVolumeControlTarget(event.target)) {
            return;
        }

        const now = Date.now();
        if (now - lastNativeTouchTs < 250) {
            return;
        }
        lastNativeTouchTs = now;

        nativeVolumeControl = true;
        applyCurrentVolumeStrategy();
        window.dispatchEvent(new CustomEvent(injectorEvents.nativeTouched));
    }

    function setupNativeVolumeTouchDetector() {
        const opts = { capture: true, passive: true };
        document.addEventListener('pointerdown', onPotentialNativeVolumeTouch, opts);
        document.addEventListener('mousedown', onPotentialNativeVolumeTouch, opts);
        document.addEventListener('touchstart', onPotentialNativeVolumeTouch, opts);
        document.addEventListener('input', onPotentialNativeVolumeTouch, true);
        document.addEventListener('change', onPotentialNativeVolumeTouch, true);
    }

    // ==========================================
    // Volume Control Interface
    // ==========================================

    function applyCurrentVolumeStrategy() {
        updatePageGraphs();
        currentMedia().forEach(applyMedia);
        scheduleAudioStateUpdate();
    }

    window.addEventListener(injectorEvents.command, event => {
        let payload;
        try { payload = JSON.parse(event.detail); } catch { return; }
        if (payload?.type === 'get-state') {
            broadcastAudioState();
            return;
        }
        if (payload?.type !== 'apply-settings' || !Number.isInteger(payload.revision) ||
            payload.revision <= settingsRevision) return;
        const settings = payload.settings;
        if (!settings || !Number.isFinite(settings.volume)) return;
        settingsRevision = payload.revision;
        currentVolume = Math.max(0, Math.min(100, settings.volume / 100));
        currentMethod = ['webaudio', 'html5', 'both'].includes(settings.method) ? settings.method : 'both';
        nativeVolumeControl = settings.nativeVolumeControl !== false;
        persistVolume = !!settings.persistVolume;
        applyCurrentVolumeStrategy();
        recoverContext();
    });

    function initialize() {
        setupMediaObserver();
        setupNativeVolumeTouchDetector();
        window.addEventListener('pageshow', () => {
            recoverContext();
            scheduleHTML5VolumeApply();
        });
        for (const event of ['pointerdown', 'keydown', 'touchend']) {
            document.addEventListener(event, event => {
                if (event.isTrusted) recoverContext(true);
            }, { capture: true, passive: true });
        }
        broadcastAudioState();
        window.dispatchEvent(new CustomEvent(injectorEvents.ready));
    }
    if (document.documentElement) initialize();
    else document.addEventListener('DOMContentLoaded', initialize, { once: true });
})();
