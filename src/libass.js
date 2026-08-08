import 'rvfc-legacy-polyfill'

import LRUCache from './LRUCache.js'
import { createLogger } from './logger.js'

const RE_D_MULTIPLE_T = /\\t\s*\([^)]*\)[^{]*\\t\s*\(/
const RE_D_KARAOKE = /\\k[fo]?\d/
const RE_D_ANIMATED_CLIP = /\\i?clip\s*\([^)]*\)[^{]*\\t/
const RE_C_TIME_ANIMATED = /\\t\s*\(|\\move\s*\(|\\fad[e]?\s*\(/
const RE_B_STATIC_OVERRIDE = /\\(pos|org|c|1c|2c|3c|4c|fs|b|i|u|s|an|fn|fscx|fscy|frx|fry|frz|blur|be|clip)/

const DEFAULT_CACHE_BYTES = 16 * 1024 * 1024
const DEFAULT_PREFETCH_FORWARD_MS = 15000
const DEFAULT_CLASS_C_SAMPLES_MIN = 3
const DEFAULT_CLASS_C_SAMPLES_MAX = 8
const DEFAULT_CLASS_C_MIN_INTERVAL_MS = 100

/** Render key used while no event is active; the frame is a plain clear. */
const EMPTY_RENDER_KEY = 'empty'
/** Stands in as the last drawn entry when the canvas was cleared. */
const EMPTY_ENTRY = { images: [], width: 0, height: 0, time: 0, bytes: 0 }
/** Precedence used to pick a class for a group holding several events. */
const CLASS_ORDER = { A: 0, B: 1, C: 2, D: 3 }

/**
 * Sort an event into A/B/C/D based on its override tags. Precedence is
 * D > C > B > A — the first D-marker seen wins over any lighter classification.
 *
 * - A: no override tags of interest.
 * - B: static overrides only (position, color, size, italics, etc.).
 * - C: time-driven animations (`\t`, `\move`, `\fad`).
 * - D: multiple `\t` chained, karaoke (`\k`/`\kf`/`\ko`), or animated clip.
 *
 * @param {String} text Event text including `{...}` override groups.
 * @param {String} effect The Effect column (empty for most dialogue events).
 * @returns {'A'|'B'|'C'|'D'}
 */
function classify (text, effect) {
    let cls = 'A'
    if (effect) {
        cls = 'B'
    }
    if (RE_B_STATIC_OVERRIDE.test(text)) {
        cls = 'B'
    }
    if (RE_C_TIME_ANIMATED.test(text)) {
        cls = 'C'
    }
    if (RE_D_MULTIPLE_T.test(text) || RE_D_KARAOKE.test(text) || RE_D_ANIMATED_CLIP.test(text)) {
        cls = 'D'
    }
    return cls
}

/**
 * Schedule `cb` for the next browser idle slot. Falls back to `setTimeout`
 * with a small fake deadline when the host has no `requestIdleCallback`.
 * @param {(deadline: IdleDeadline) => void} cb
 * @returns {Number} Opaque handle usable with {@link cancelIdle}.
 */
function requestIdle (cb) {
    let handle
    if (typeof requestIdleCallback === 'function') {
        handle = requestIdleCallback(cb, { timeout: 500 })
    } else {
        handle = setTimeout(() => cb({ timeRemaining: () => 5, didTimeout: false }), 16)
    }
    return handle
}

/**
 * @param {Number|null} handle
 */
function cancelIdle (handle) {
    if (handle != null) {
        if (typeof cancelIdleCallback === 'function') {
            cancelIdleCallback(handle)
        } else {
            clearTimeout(handle)
        }
    }
}

/**
 * One event of the parsed .ass script after classification, before grouping.
 * @typedef {Object} PlannedEvent
 * @property {'A'|'B'|'C'|'D'} type Complexity class assigned by {@link classify}.
 * @property {Number} start Start time in seconds.
 * @property {Number} end End time in seconds.
 */

/**
 * A run of events that share screen time. Overlapping events are merged into
 * one plan on purpose: the renderer snaps the clock to the plan's sample, so
 * keeping them apart would freeze the frame at the first member's start and
 * hide everything that joins later. The group's `samples` hold every instant
 * at which the set of visible events changes, both entries and exits.
 *
 * Groups are disjoint and ascending, which is what lets
 * {@link LibAss#_planForTime} walk them with a single cursor.
 *
 * @typedef {Object} EventPlan
 * @property {Number} index Position of the group in the plan list.
 * @property {'A'|'B'|'C'|'D'} type Highest class among the grouped events.
 * @property {Number} start Earliest start among the grouped events, in seconds.
 * @property {Number} end Latest end among the grouped events, in seconds.
 * @property {Array<Number>} samples Ascending timestamps (seconds) at which the group is rendered.
 */

/**
 * A cached render result. All coordinates are in canvas-pixels; the bitmap
 * is already in the final render resolution and can be blitted verbatim.
 * @typedef {Object} RenderEntry
 * @property {Array<{x:Number, y:Number, w:Number, h:Number, bitmap:ImageBitmap}>} images
 * @property {Number} width Canvas width at the moment of the render.
 * @property {Number} height Canvas height at the moment of the render.
 * @property {Number} time Time (seconds) requested to libass.
 * @property {Number} bytes Approximate memory footprint used by the LRU accounting.
 */

/**
 * A raw image node as returned by the worker before it is turned into an
 * {@link ImageBitmap}. Pixels are RGBA in row-major order.
 * @typedef {Object} WorkerRawImage
 * @property {Number} x
 * @property {Number} y
 * @property {Number} w
 * @property {Number} h
 * @property {Number} stride
 * @property {Number} color
 * @property {Uint8Array|ArrayBuffer} image
 */

/**
 * Raw render payload received from the worker.
 * @typedef {Object} WorkerRawRender
 * @property {Boolean} changed
 * @property {Number} width
 * @property {Number} height
 * @property {Number} time
 * @property {Number} duration
 * @property {Array<WorkerRawImage>} images
 */

/**
 * ASS event as exposed by libass (mirrors {@link ASS_Event} in the C bindings).
 * @typedef {Object} ASSEvent
 * @property {Number} Start Start time in centiseconds.
 * @property {Number} Duration Duration in centiseconds.
 * @property {Number} ReadOrder
 * @property {Number} Layer
 * @property {Number} Style Index into the styles table.
 * @property {Number} MarginL
 * @property {Number} MarginR
 * @property {Number} MarginV
 * @property {String} Name
 * @property {String} Text Includes override tags in curly braces.
 * @property {String} Effect
 */

/**
 * ASS style as exposed by libass (mirrors {@link ASS_Style} in the C bindings).
 * @typedef {Object} ASSStyle
 * @property {String} Name
 * @property {String} FontName
 * @property {Number} FontSize
 * @property {Number} PrimaryColour Packed RGBA.
 * @property {Number} SecondaryColour Packed RGBA.
 * @property {Number} OutlineColour Packed RGBA.
 * @property {Number} BackColour Packed RGBA.
 * @property {Number} Bold
 * @property {Number} Italic
 * @property {Number} Underline
 * @property {Number} StrikeOut
 * @property {Number} ScaleX
 * @property {Number} ScaleY
 * @property {Number} Spacing
 * @property {Number} Angle
 * @property {Number} BorderStyle
 * @property {Number} Outline
 * @property {Number} Shadow
 * @property {Number} Alignment
 * @property {Number} MarginL
 * @property {Number} MarginR
 * @property {Number} MarginV
 * @property {Number} Encoding
 * @property {Number} treat_fontname_as_pattern
 * @property {Number} Blur
 * @property {Number} Justify
 */

/**
 * Options accepted by {@link LibAss#load}.
 * @typedef {Object} LibAssOptions
 * @property {HTMLVideoElement} [video] Video element to bind rVFC and canvas overlay to.
 * @property {HTMLCanvasElement} [canvas] Explicit canvas to render into; if omitted and a video is provided, one is created and inserted after the video.
 * @property {String} [workerUrl='libass-worker.js'] URL of the worker script.
 * @property {String} [wasmUrl='libass.wasm'] URL of the wasm binary (modern target).
 * @property {String} [legacyWasmUrl] URL of the WASM2JS bundle (legacy target).
 * @property {String} [subContent] Initial .ass text to load.
 * @property {Array<Uint8Array>} [fonts] Extra fonts to register.
 * @property {String} [fallbackFont='liberation sans'] Family name to use when the .ass style references a missing font.
 * @property {Number} [timeOffset=0] Seconds added to every incoming media time.
 * @property {Boolean} [debug=false] Enable verbose logging via `console.debug`.
 * @property {Number} [libassMemoryLimit=0] libass bitmap-cache byte limit (0 = default).
 * @property {Number} [libassGlyphLimit=0] libass glyph-cache count limit (0 = default).
 * @property {Number} [maxCacheBytes] Byte budget for the JS-side render cache.
 * @property {Number} [prefetchForwardMs] Forward window in ms for idle-time prefetch.
 * @property {Number} [classCSamplesMin] Lower bound on samples generated for class C events.
 * @property {Number} [classCSamplesMax] Upper bound on samples generated for class C events.
 * @property {Number} [classCMinIntervalMs] Minimum ms between successive samples of a class C event.
 * @property {(error: Error|Event) => void} [onError] Called when the worker reports an error that is not tied to an outstanding call. If unset, the error is rethrown so it surfaces as an unhandled rejection / `window.onerror`.
 */

/**
 * @typedef {Object} CacheStats
 * @property {Number} size
 * @property {Number} bytes
 */

export default class LibAss {
    constructor () {
        this.debug = false
        /** @type {Number} */
        this.timeOffset = 0

        this._log = createLogger('main', () => this.debug)

        /** @type {((error: Error|Event) => void) | null} */
        this._onError = null

        /** @type {HTMLVideoElement} */
        this._video = null
        /** @type {HTMLCanvasElement} */
        this._canvas = null
        /** @type {HTMLDivElement} */
        this._canvasParent = null
        /** @type {CanvasRenderingContext2D} */
        this._ctx = null

        /** @type {Worker} */
        this._worker = null
        /** @type {Number} */
        this._reqId = 0
        /** @type {Map<Number, {resolve:Function, reject:Function}>} */
        this._pending = new Map()

        /** @type {Number} */
        this._currentTime = 0
        /** @type {String} */
        this._lastRenderKey = ''
        /** @type {RenderEntry|null} */
        this._lastRendered = null
        /** @type {Number|null} */
        this._rvfcHandle = null
        /** @type {Number} Ticket of the newest render; older ones stop drawing. */
        this._renderToken = 0
        /** @type {Boolean} */
        this._destroyed = false

        /** @type {Array<EventPlan>} */
        this._plans = []
        /** @type {Number} */
        this._planCursor = 0

        /** @type {LRUCache} */
        this._renderCache = null
        /** @type {Map<String, Promise<RenderEntry>>} Renders already in flight, by cache key. */
        this._inFlight = new Map()

        /** @type {Number} */
        this._cacheBytesBudget = DEFAULT_CACHE_BYTES
        /** @type {Number} */
        this._prefetchForwardMs = DEFAULT_PREFETCH_FORWARD_MS
        /** @type {Number} */
        this._classCSamplesMin = DEFAULT_CLASS_C_SAMPLES_MIN
        /** @type {Number} */
        this._classCSamplesMax = DEFAULT_CLASS_C_SAMPLES_MAX
        /** @type {Number} */
        this._classCMinIntervalMs = DEFAULT_CLASS_C_MIN_INTERVAL_MS

        /** @type {Array<{time:Number, planIndex:Number}>} */
        this._prefetchQueue = []
        /** @type {Number|null} */
        this._prefetchHandle = null

        this._boundResize = () => this.resize()
        this._boundRVFC = this._handleRVFC.bind(this)
        this._boundPause = this._handlePause.bind(this)
        this._boundSeeked = this._handleSeeked.bind(this)
        this._boundDrainPrefetch = this._drainPrefetch.bind(this)
    }

    /**
     * Boot the runtime. Spawns the worker, initializes libass, wires the video
     * (rVFC + pause/seeked), and, if `subContent` is provided, parses the track
     * and schedules the initial prefetch.
     * @param {LibAssOptions} options
     * @returns {Promise<void>}
     */
    async load (options) {
        if (!options) {
            throw new Error('No options provided')
        }

        this.debug = !!options.debug
        this._destroyed = false
        this.timeOffset = options.timeOffset || 0
        this._onError = typeof options.onError === 'function' ? options.onError : null
        this._log.info('loading')

        this._video = options.video || null
        this._canvas = options.canvas || null

        this._cacheBytesBudget = options.maxCacheBytes || DEFAULT_CACHE_BYTES
        this._prefetchForwardMs = options.prefetchForwardMs || DEFAULT_PREFETCH_FORWARD_MS
        this._classCSamplesMin = options.classCSamplesMin || DEFAULT_CLASS_C_SAMPLES_MIN
        this._classCSamplesMax = options.classCSamplesMax || DEFAULT_CLASS_C_SAMPLES_MAX
        this._classCMinIntervalMs = options.classCMinIntervalMs || DEFAULT_CLASS_C_MIN_INTERVAL_MS

        this._renderCache = new LRUCache({
            maxBytes: this._cacheBytesBudget,
            size: (value) => (value && value.bytes ? value.bytes : 1),
            onEviction: (_key, value) => this._closeEntry(value),
        })

        if (!this._canvas && this._video) {
            this._canvasParent = document.createElement('div')
            this._canvasParent.className = 'LibAss'
            this._canvasParent.style.position = 'relative'
            this._canvas = this._createCanvas()
            this._video.insertAdjacentElement('afterend', this._canvasParent)
        }

        if (!this._canvas) {
            throw new Error('You should give video or canvas in options.')
        }

        this._ctx = this._canvas.getContext('2d')
        if (!this._ctx) {
            throw new Error('Canvas rendering not supported')
        }

        this._worker = new Worker(options.workerUrl || 'libass-worker.js')
        this._worker.onmessage = this._handleWorkerMessage.bind(this)
        this._worker.onerror = this._handleWorkerError.bind(this)

        await this._callWorker('init', {
            width: this._canvas.width || 0,
            height: this._canvas.height || 0,
            debug: this.debug,
            subContent: options.subContent || null,
            fallbackFont: options.fallbackFont || 'liberation sans',
            fonts: options.fonts || [],
            wasmUrl: options.wasmUrl || 'libass.wasm',
            legacyWasmUrl: options.legacyWasmUrl || null,
            libassMemoryLimit: options.libassMemoryLimit || 0,
            libassGlyphLimit: options.libassGlyphLimit || 0,
        })

        if (this._video) {
            await this.setVideo(this._video)
        }

        if (options.subContent) {
            await this.buildPlans()
            this._schedulePrefetch(this._currentTimeSafe())
        }
        this._log.info('ready')
    }

    _createCanvas () {
        this._canvas = document.createElement('canvas')
        this._canvas.style.display = 'block'
        this._canvas.style.position = 'absolute'
        this._canvas.style.pointerEvents = 'none'
        this._canvasParent.appendChild(this._canvas)
        return this._canvas
    }

    _handleWorkerMessage (event) {
        const data = event.data
        const pending = this._pending.get(data.id)

        this._pending.delete(data.id)
        if (pending) {
            if (data.error) {
                const error = new Error(data.error)
                error.stack = data.stack || null
                pending.reject(error)
            } else {
                pending.resolve(data)
            }
        }
    }

    _handleWorkerError (error) {
        this._log.error('worker error', error && error.message ? error.message : error)
        const hadPending = this._pending.size > 0
        this._pending.forEach((pending) => {
            pending.reject(error)
        })
        this._pending.clear()
        if (this._onError) {
            this._onError(error)
        } else if (!hadPending) {
            throw error
        }
    }

    _callWorker (target, payload) {
        const id = ++this._reqId
        return new Promise((resolve, reject) => {
            this._pending.set(id, { resolve, reject })
            this._worker.postMessage(Object.assign({ id, target }, payload || {}))
        })
    }

    _currentTimeSafe () {
        return this._video ? this._video.currentTime + this.timeOffset : this._currentTime
    }

    /**
     * Attach (or replace) the video element the renderer follows. Registers
     * rVFC and `pause`/`seeked` listeners. Detaches any previous video.
     * @param {HTMLVideoElement} video
     * @returns {Promise<void>}
     */
    async setVideo (video) {
        this._detachVideoListeners()
        this._video = video

        // Move the auto-created canvas next to the new video. Needed when the
        // previous video was removed from DOM (React unmount) and we get a new
        // one via setNewContext; otherwise the overlay stays orphaned.
        if (this._canvasParent && video.parentNode &&
            this._canvasParent.previousElementSibling !== video) {
            video.insertAdjacentElement('afterend', this._canvasParent)
        }

        if (typeof video.requestVideoFrameCallback === 'function') {
            this._rvfcHandle = video.requestVideoFrameCallback(this._boundRVFC)
        }
        video.addEventListener('pause', this._boundPause)
        video.addEventListener('seeked', this._boundSeeked)
        video.addEventListener('resize', this._boundResize)
        video.addEventListener('loadedmetadata', this._boundResize)

        if (typeof ResizeObserver !== 'undefined') {
            if (!this._ro) {
                this._ro = new ResizeObserver(this._boundResize)
            }
            this._ro.observe(video)
        }

        if (video.videoWidth > 0) {
            await this.resize()
        }
    }

    async _handleRVFC (_now, metadata) {
        if (this._video) {
            const t = metadata
                ? metadata.mediaTime + this.timeOffset
                : this._video.currentTime + this.timeOffset
            try {
                await this.render(t)
            } catch (error) {
                this._onRenderError(error)
            }
            // Re-arm even after a failure. Bailing out here would drop the
            // callback for good and freeze the overlay on the last frame drawn.
            if (this._video && !this._destroyed &&
                typeof this._video.requestVideoFrameCallback === 'function') {
                this._rvfcHandle = this._video.requestVideoFrameCallback(this._boundRVFC)
            }
        }
    }

    /**
     * Forget the last drawn frame so the next callback renders again instead
     * of taking the failure as the current state.
     * @param {Error|Event} error
     */
    _onRenderError (error) {
        this._log.error('render failed', error && error.message ? error.message : error)
        this._lastRenderKey = ''
        this._lastRendered = null
    }

    /**
     * Start a render from a synchronous listener without leaving the rejection
     * unhandled.
     * @param {Number} time
     */
    _renderSafe (time) {
        this.render(time).catch(error => this._onRenderError(error))
    }

    _handlePause () {
        this._log.debug('pause')
        if (this._video) {
            this._renderSafe(this._currentTimeSafe())
        }
    }

    _handleSeeked () {
        this._log.debug('seeked', { time: this._currentTimeSafe() })
        this._planCursor = 0
        this._clearPrefetch()
        this._lastRenderKey = ''
        this._lastRendered = null
        if (this._video) {
            this._renderSafe(this._currentTimeSafe())
        }
    }

    /**
     * Recompute canvas geometry. If any dimension is missing, derives them from
     * the current video's aspect ratio. Invalidates the render cache.
     * @param {Number} [width]
     * @param {Number} [height]
     * @param {Number} [top]
     * @param {Number} [left]
     * @returns {Promise<void>}
     */
    async resize (width, height, top, left) {
        let w = width || 0
        let h = height || 0
        let t = top || 0
        let l = left || 0
        let applied = false

        if ((!w || !h) && this._video) {
            if (this._video.videoWidth > 0 && this._video.videoHeight > 0) {
                const pos = this._getVideoPosition()
                w = pos.width || 0
                h = pos.height || 0
                l = pos.x
                const gap = this._canvasParent
                    ? this._canvasParent.getBoundingClientRect().top - this._video.getBoundingClientRect().top
                    : 0
                t = pos.y - gap
                applied = w > 0 && h > 0
            }
        } else if (w && h) {
            applied = true
        }

        if (applied) {
            this._canvas.width = w
            this._canvas.height = h
            this._canvas.style.width = w + 'px'
            this._canvas.style.height = h + 'px'
            this._canvas.style.top = t + 'px'
            this._canvas.style.left = l + 'px'
            await this._callWorker('resize', { width: w, height: h })
            this.clearCache()
        }
    }

    _getVideoPosition (width, height) {
        let w = width || this._video.videoWidth
        let h = height || this._video.videoHeight

        const videoRatio = w / h
        const offsetWidth = this._video.offsetWidth || w
        const offsetHeight = this._video.offsetHeight || h
        const elementRatio = offsetWidth / offsetHeight

        w = offsetWidth
        h = offsetHeight

        if (elementRatio > videoRatio) {
            w = Math.floor(offsetHeight * videoRatio)
        } else {
            h = Math.floor(offsetWidth / videoRatio)
        }

        const x = (offsetWidth - w) / 2
        const y = (offsetHeight - h) / 2

        return { width: w, height: h, x, y }
    }

    /**
     * Swap the video element and/or the track content in one call. Convenient
     * when reusing an initialized instance across pages or episodes.
     * @param {Object} params
     * @param {HTMLVideoElement} [params.video]
     * @param {String} [params.subContent]
     * @returns {Promise<void>}
     */
    async setNewContext ({ video, subContent } = {}) {
        if (video) {
            await this.setVideo(video)
        }
        if (subContent != null) {
            await this.setTrack(subContent)
        }
    }

    /**
     * Replace the current .ass track. Triggers a fresh classification and prefetch.
     * @param {String} content Raw .ass file contents.
     * @returns {Promise<void>}
     */
    async setTrack (content) {
        await this._callWorker('setTrack', { content })
        await this.buildPlans()
        this._schedulePrefetch(this._currentTimeSafe())
    }

    /**
     * Drop the current track, invalidate all cached bitmaps and clear the canvas.
     * @returns {Promise<void>}
     */
    async removeTrack () {
        await this._callWorker('removeTrack')
        this._plans = []
        this._planCursor = 0
        this._clearPrefetch()
        this.clearCache()
        this._clearCanvas()
    }

    /**
     * Register an extra font in libass. Picked up automatically at the next render.
     * @param {String} name
     * @param {Uint8Array|ArrayBuffer} font
     * @returns {Promise<void>}
     */
    async addFont (name, font) {
        await this._callWorker('addFont', { name, font })
    }

    /**
     * List the family names of the fonts currently registered in libass.
     * @returns {Promise<{families: Array<String>}>}
     */
    async getFontFamilies () {
        return this._callWorker('getFontFamilies')
    }

    /**
     * Set the family used when a style references an unavailable font.
     * @param {String} font
     * @returns {Promise<void>}
     */
    async setDefaultFont (font) {
        await this._callWorker('setDefaultFont', { font })
    }

    /**
     * Append a new style to the track.
     * @param {ASSStyle} style
     * @returns {Promise<{index: Number}>}
     */
    async createStyle (style) {
        return this._callWorker('createStyle', { style })
    }

    /**
     * Snapshot of all styles in the track.
     * @returns {Promise<{styles: Array<ASSStyle>}>}
     */
    async getStyles () {
        return this._callWorker('getStyles')
    }

    /**
     * Overwrite an existing style in place. The next render picks up the change.
     * @param {Number} index
     * @param {ASSStyle} style
     * @returns {Promise<void>}
     */
    async setStyle (index, style) {
        await this._callWorker('setStyle', { index, style })
        this.clearCache()
    }

    /**
     * @param {Number} index
     * @returns {Promise<void>}
     */
    async removeStyle (index) {
        await this._callWorker('removeStyle', { index })
    }

    /**
     * Force the given style to override the per-event styles at render time.
     * @param {Number} index
     * @returns {Promise<void>}
     */
    async setStyleOverride (index) {
        await this._callWorker('setStyleOverride', { index })
    }

    /**
     * Undo a previous {@link LibAss#setStyleOverride}.
     * @returns {Promise<void>}
     */
    async removeStyleOverride () {
        await this._callWorker('removeStyleOverride')
    }

    /**
     * Append a new event to the track.
     * @param {ASSEvent} event
     * @returns {Promise<{index: Number}>}
     */
    async createEvent (event) {
        return this._callWorker('createEvent', { event })
    }

    /**
     * Snapshot of all events in the track.
     * @returns {Promise<{events: Array<ASSEvent>}>}
     */
    async getEvents () {
        return this._callWorker('getEvents')
    }

    /**
     * @param {Number} index
     * @returns {Promise<void>}
     */
    async removeEvent (index) {
        await this._callWorker('removeEvent', { index })
    }

    /**
     * Fetch the events from the worker, classify each into A/B/C/D, and build
     * their sampling schedules. Invalidates the current cache.
     * @returns {Promise<void>}
     */
    async buildPlans () {
        this._clearPrefetch()
        this.clearCache()
        const { events } = await this._callWorker('getEvents')
        this._plans = []
        this._planCursor = 0

        const breakdown = { A: 0, B: 0, C: 0, D: 0 }
        /** @type {Array<PlannedEvent>} */
        const entries = []
        for (let i = 0; i < events.length; i++) {
            const event = events[i]
            const start = (event.Start || 0) / 1000
            const duration = (event.Duration || 0) / 1000
            const type = classify(event.Text || '', event.Effect || '')
            breakdown[type]++
            entries.push({ type, start, end: start + duration })
        }
        // The cursor walk needs ascending starts. libass returns the events in
        // file order and nothing guarantees the track is sorted, so sort here.
        entries.sort((a, b) => a.start - b.start)
        this._plans = this._buildGroups(entries)

        const sample = this._plans.slice(0, 3).map(p => ({
            i: p.index, t: p.type, start: p.start, end: p.end, samples: p.samples.length,
        }))
        const last = this._plans.length > 0 ? this._plans[this._plans.length - 1] : null
        this._log.info('plans built', {
            total: events.length,
            groups: this._plans.length,
            ...breakdown,
            firstFew: sample,
            lastStart: last ? last.start : null,
            lastEnd: last ? last.end : null,
        })
    }

    /**
     * Merge events that share screen time into disjoint, ascending groups and
     * give each group its sample schedule.
     * @param {Array<PlannedEvent>} entries Events sorted by ascending `start`.
     * @returns {Array<EventPlan>}
     */
    _buildGroups (entries) {
        /** @type {Array<{start: Number, end: Number, members: Array<PlannedEvent>}>} */
        const groups = []
        for (let i = 0; i < entries.length; i++) {
            const entry = entries[i]
            const current = groups.length > 0 ? groups[groups.length - 1] : null
            // An event is on screen over [start, end), so touching bounds are
            // not an overlap and start a new group.
            if (current && entry.start < current.end) {
                current.members.push(entry)
                current.end = Math.max(current.end, entry.end)
            } else {
                groups.push({ start: entry.start, end: entry.end, members: [entry] })
            }
        }

        /** @type {Array<EventPlan>} */
        const plans = []
        for (let i = 0; i < groups.length; i++) {
            const group = groups[i]
            let type = 'A'
            for (let m = 0; m < group.members.length; m++) {
                if (CLASS_ORDER[group.members[m].type] > CLASS_ORDER[type]) {
                    type = group.members[m].type
                }
            }
            plans.push({
                index: i,
                type,
                start: group.start,
                end: group.end,
                samples: this._buildGroupSamples(group),
            })
        }
        return plans
    }

    /**
     * Every instant inside the group at which the visible set changes: each
     * member's start (an event appears) and end (an event leaves), plus the
     * intermediate steps of animated members. Times outside `[start, end)` are
     * dropped — the cursor has already left the group there, so they would
     * never be picked.
     *
     * A group holding one plain event collapses to `[start]`, which is exactly
     * what the renderer used before grouping existed.
     *
     * @param {{start: Number, end: Number, members: Array<PlannedEvent>}} group
     * @returns {Array<Number>}
     */
    _buildGroupSamples (group) {
        const seen = new Set()
        const samples = []
        const add = (value) => {
            const time = Math.round(value * 1000) / 1000
            if (time >= group.start && time < group.end && !seen.has(time)) {
                seen.add(time)
                samples.push(time)
            }
        }

        add(group.start)
        for (let i = 0; i < group.members.length; i++) {
            const member = group.members[i]
            add(member.start)
            add(member.end)
            if (member.type === 'C') {
                const steps = this._buildAnimatedSamples(member.start, member.end)
                for (let s = 0; s < steps.length; s++) {
                    add(steps[s])
                }
            }
        }
        // A zero-duration group leaves nothing inside [start, end). The cursor
        // never selects such a group, but an empty list would still reach
        // `_resolvePlannedTime` as `undefined` and travel into the C++ cast.
        if (samples.length === 0) {
            samples.push(group.start)
        }
        samples.sort((a, b) => a - b)
        return samples
    }

    /**
     * Evenly spaced render points for an animated (class C) event: at least
     * `_classCSamplesMin`, at most `_classCSamplesMax`, never closer together
     * than `_classCMinIntervalMs`. Both bounds are included.
     * @param {Number} start
     * @param {Number} end
     * @returns {Array<Number>}
     */
    _buildAnimatedSamples (start, end) {
        const out = []
        const durationMs = Math.max((end - start) * 1000, 0)
        const idealCount = Math.floor(durationMs / this._classCMinIntervalMs) + 1
        const count = Math.max(
            this._classCSamplesMin,
            Math.min(this._classCSamplesMax, idealCount)
        )
        if (count <= 1 || end <= start) {
            out.push(start)
        } else {
            const step = (end - start) / (count - 1)
            for (let i = 0; i < count; i++) {
                out.push(Math.round((start + step * i) * 1000) / 1000)
            }
        }
        return out
    }

    /**
     * @param {Number} time
     * @returns {EventPlan|null}
     */
    _planForTime (time) {
        while (this._planCursor > 0 && this._plans[this._planCursor - 1].end > time) {
            this._planCursor--
        }
        // `end <= time` because a group covers [start, end); at `end` sharp it
        // is already over and leaving it here avoids one stale frame.
        while (this._planCursor < this._plans.length &&
               this._plans[this._planCursor].end <= time) {
            this._planCursor++
        }
        let plan = null
        if (this._planCursor < this._plans.length) {
            const candidate = this._plans[this._planCursor]
            if (candidate.start <= time) {
                plan = candidate
            }
        }
        return plan
    }

    /**
     * Latest sample of the group at or before `time`. That sample is the last
     * instant the visible set changed, so rendering there yields the frame
     * `time` should be showing.
     * @param {Number} time
     * @param {EventPlan} plan
     * @returns {Number}
     */
    _resolvePlannedTime (time, plan) {
        let planned = plan.samples[0]
        for (let i = 0; i < plan.samples.length && plan.samples[i] <= time; i++) {
            planned = plan.samples[i]
        }
        return planned
    }

    _buildRenderCacheKey (time, planIndex) {
        return [
            planIndex != null ? planIndex : -1,
            Math.round(time * 1000),
            this._canvas.width,
            this._canvas.height,
        ].join(':')
    }

    async _renderAt (time) {
        return this._callWorker('render', { time, force: false })
    }

    async _toEntry (raw) {
        const images = []
        let bytes = 0
        const list = raw.images || []
        for (let i = 0; i < list.length; i++) {
            const img = list[i]
            if (img && img.image && img.w > 0 && img.h > 0) {
                const mask = img.image instanceof Uint8Array
                    ? img.image
                    : new Uint8Array(img.image)
                const color = (img.color || 0) >>> 0
                const r = (color >>> 24) & 0xFF
                const g = (color >>> 16) & 0xFF
                const b = (color >>> 8) & 0xFF
                const opacity = (255 - (color & 0xFF)) / 255
                const rgba = new Uint8ClampedArray(img.w * img.h * 4)
                if (opacity > 0) {
                    for (let y = 0; y < img.h; y++) {
                        const rowStart = y * img.stride
                        const outStart = y * img.w * 4
                        for (let x = 0; x < img.w; x++) {
                            const alphaByte = mask[rowStart + x]
                            if (alphaByte !== 0) {
                                const idx = outStart + x * 4
                                rgba[idx] = r
                                rgba[idx + 1] = g
                                rgba[idx + 2] = b
                                rgba[idx + 3] = Math.round(alphaByte * opacity)
                            }
                        }
                    }
                }
                const bitmap = await this._makeBitmap(rgba, img.w, img.h)
                images.push({ x: img.x, y: img.y, w: img.w, h: img.h, bitmap })
                bytes += img.w * img.h * 4
            }
        }
        this._log.debug('entry built', {
            time: raw.time,
            rawImages: list.length,
            bitmaps: images.length,
            bytes,
        })
        return {
            images,
            width: raw.width,
            height: raw.height,
            time: raw.time,
            bytes: bytes || 1,
        }
    }

    /**
     * Wrap an RGBA buffer in something `_drawRenderResult` can `drawImage`.
     * Modern path: `createImageBitmap(new ImageData(rgba, w, h))` — one hop,
     * GPU-backed on most engines. Legacy path (Chromium 38 on webOS 3 has no
     * `createImageBitmap`, and its `ImageData` constructor doesn't accept an
     * array): allocate the ImageData via `ctx.createImageData`, copy the
     * bytes in with `data.set`, `putImageData` onto a throwaway canvas, and
     * hand that canvas to `drawImage` (accepts HTMLCanvasElement).
     */
    async _makeBitmap (rgba, w, h) {
        let bitmap
        // #if process.env.JAS_TARGER === 'modern'
        bitmap = await createImageBitmap(new ImageData(rgba, w, h))
        // #endif
        // #if process.env.JAS_TARGER === 'legacy'
        const buf = document.createElement('canvas')
        buf.width = w
        buf.height = h
        const ctx = buf.getContext('2d')
        const imageData = ctx.createImageData(w, h)
        imageData.data.set(rgba)
        ctx.putImageData(imageData, 0, 0)
        bitmap = buf
        // #endif
        return bitmap
    }

    /**
     * Render `planned` and file it under `key`. Split out of
     * {@link LibAss#_ensureCached} so a single promise can be handed to every
     * caller waiting on the same key.
     * @param {String} key
     * @param {Number} planned
     * @returns {Promise<RenderEntry>}
     */
    async _renderEntry (key, planned) {
        const raw = await this._renderAt(planned)
        const entry = await this._toEntry(raw)
        this._renderCache.set(key, entry)
        return entry
    }

    async _ensureCached (planned, planIndex) {
        const key = this._buildRenderCacheKey(planned, planIndex)
        let entry = this._renderCache.get(key)
        if (!entry) {
            // The idle prefetch and the frame callback reach for the same key
            // routinely. Letting both through would render it twice, doubling
            // the worker load and stranding one of the two bitmap sets.
            let pending = this._inFlight.get(key)
            if (!pending) {
                pending = this._renderEntry(key, planned)
                this._inFlight.set(key, pending)
                // Drop the slot either way so a failed render can be retried.
                pending.catch(() => {}).then(() => this._inFlight.delete(key))
            }
            entry = await pending
        }
        return entry
    }

    /**
     * Render the subtitle for the given media time. Called by rVFC and by
     * `pause`/`seeked` handlers. Uses cache + level-2 shortcut for A/B/C
     * events and bypasses the pipeline entirely for D.
     * @param {Number} [time] Seconds; when omitted, uses the video's current time + `timeOffset`.
     * @returns {Promise<void>}
     */
    async render (time) {
        let t = time
        if (typeof t !== 'number' || !isFinite(t)) {
            t = this._currentTimeSafe()
        }
        this._currentTime = t

        if (!this._destroyed) {
            // Seek, pause and rVFC can all be in flight at once. Whoever draws
            // must check it is still the newest, or a slow stale render lands
            // last and sticks on screen as if it were current.
            const token = ++this._renderToken
            const plan = this._planForTime(t)

            if (plan && plan.type === 'D') {
                await this._renderLive(t, token)
            } else {
                await this._renderCached(t, plan, token)
            }
        }
    }

    async _renderLive (time, token) {
        this._log.debug('render live (D)', { time })
        const raw = await this._renderAt(time)
        const entry = await this._toEntry(raw)
        if (token === this._renderToken) {
            this._drawRenderResult(entry)
            this._lastRenderKey = ''
            this._lastRendered = null
        }
        this._closeEntry(entry)
    }

    async _renderCached (time, plan, token) {
        let planned = 0
        let key = EMPTY_RENDER_KEY
        if (plan) {
            planned = this._resolvePlannedTime(time, plan)
            key = this._buildRenderCacheKey(planned, plan.index)
        }

        if (key !== this._lastRenderKey || !this._lastRendered) {
            if (plan) {
                const hit = this._renderCache.has(key)
                this._log.debug(hit ? 'render hit' : 'render miss', {
                    time,
                    planIndex: plan.index,
                    type: plan.type,
                    planned,
                })
                const entry = await this._ensureCached(planned, plan.index)
                if (token === this._renderToken) {
                    this._drawRenderResult(entry)
                    this._lastRenderKey = key
                    this._lastRendered = entry
                    this._schedulePrefetch(time)
                }
            } else {
                // No group covers `time`, so nothing can be on screen. Clearing
                // here keeps the worker out of every gap between subtitles and
                // gives the gap a stable key instead of one per frame.
                this._log.debug('render empty', { time })
                this._clearCanvas()
                this._lastRenderKey = key
                this._lastRendered = EMPTY_ENTRY
            }
        }
    }

    _drawRenderResult (entry) {
        this._clearCanvas()
        let drawn = 0
        if (entry && entry.images && entry.images.length) {
            for (let i = 0; i < entry.images.length; i++) {
                const img = entry.images[i]
                if (img && img.bitmap) {
                    this._ctx.drawImage(img.bitmap, img.x, img.y)
                    drawn++
                }
            }
        }
        this._log.debug('draw', {
            drawn,
            canvas: `${this._canvas.width}x${this._canvas.height}`,
        })
    }

    _clearCanvas () {
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height)
    }

    _closeEntry (entry) {
        if (entry && entry.images) {
            for (let i = 0; i < entry.images.length; i++) {
                const img = entry.images[i]
                if (img && img.bitmap && typeof img.bitmap.close === 'function') {
                    img.bitmap.close()
                }
            }
        }
    }

    /**
     * Drop every cached render entry (bitmaps get `close()`d) and reset the
     * last-drawn key. Called on resize and internally on track changes.
     */
    clearCache () {
        this._renderCache.clear()
        // Renders still in flight belong to the geometry or the track being
        // dropped; new callers must not attach to them.
        this._inFlight.clear()
        this._lastRenderKey = ''
        this._lastRendered = null
    }

    /**
     * Current occupancy of the render cache.
     * @returns {CacheStats}
     */
    getCacheStats () {
        return {
            size: this._renderCache.size,
            bytes: this._renderCache.bytes,
        }
    }

    /**
     * Warm the cache with the next `count` cacheable samples from `fromTime`.
     * Resolves when those entries are in the cache, or when `timeoutMs` runs
     * out — whichever comes first. Meant to be awaited before starting
     * playback (initial load, seek) so the first sub doesn't miss.
     *
     * Samples, not events: a group of overlapping events renders once per
     * boundary, and those boundaries are what the first frames will ask for.
     * Non-cacheable (D) groups are skipped: they can't be pre-rendered, they
     * always run live at frame time. If there are fewer than `count` cacheable
     * samples left after `fromTime`, resolves with what could be gathered.
     *
     * Uses direct `_ensureCached` calls (worker burst) instead of the idle
     * prefetch queue — the caller is blocking playback, idle scheduling would
     * defeat the purpose.
     *
     * @param {Number} fromTime Seconds; falls back to current video time.
     * @param {Number} [count=3]
     * @param {Number} [timeoutMs=500]
     * @returns {Promise<void>}
     */
    async awaitNextCacheableEvents (fromTime, count, timeoutMs) {
        const n = count == null ? 3 : count
        const timeout = timeoutMs == null ? 500 : timeoutMs
        const t = (typeof fromTime === 'number' && isFinite(fromTime))
            ? fromTime
            : this._currentTimeSafe()
        let cursor = this._planCursor
        while (cursor > 0 && this._plans[cursor - 1].end > t) {
            cursor--
        }
        while (cursor < this._plans.length && this._plans[cursor].end <= t) {
            cursor++
        }
        // When a group is already open, start at the sample covering `t` so the
        // frame the caller is about to show is warmed too.
        const open = cursor < this._plans.length && this._plans[cursor].start <= t
        const from = open ? this._resolvePlannedTime(t, this._plans[cursor]) : t

        const targets = []
        while (cursor < this._plans.length && targets.length < n) {
            const plan = this._plans[cursor]
            if (plan.type !== 'D') {
                for (let s = 0; s < plan.samples.length && targets.length < n; s++) {
                    if (plan.samples[s] >= from) {
                        targets.push({ time: plan.samples[s], planIndex: plan.index })
                    }
                }
            }
            cursor++
        }
        if (targets.length > 0) {
            const jobs = targets.map(target => {
                const key = this._buildRenderCacheKey(target.time, target.planIndex)
                return this._renderCache.has(key)
                    ? Promise.resolve()
                    : this._ensureCached(target.time, target.planIndex).catch(() => {})
            })
            let timerId = null
            const timer = new Promise(resolve => {
                timerId = setTimeout(resolve, timeout)
            })
            await Promise.race([Promise.all(jobs), timer])
            if (timerId != null) {
                clearTimeout(timerId)
            }
        }
    }

    _schedulePrefetch (fromTime) {
        this._clearPrefetch()
        const windowEnd = fromTime + this._prefetchForwardMs / 1000
        let cursor = this._planCursor
        while (cursor < this._plans.length && this._plans[cursor].start <= windowEnd) {
            const plan = this._plans[cursor]
            if (plan.type !== 'D') {
                for (let s = 0; s < plan.samples.length; s++) {
                    const t = plan.samples[s]
                    if (t > fromTime && t <= windowEnd) {
                        this._prefetchQueue.push({ time: t, planIndex: plan.index })
                    }
                }
            }
            cursor++
        }
        if (this._prefetchQueue.length) {
            this._log.debug('prefetch scheduled', { queued: this._prefetchQueue.length, fromTime })
            this._prefetchHandle = requestIdle(this._boundDrainPrefetch)
        }
    }

    _clearPrefetch () {
        cancelIdle(this._prefetchHandle)
        this._prefetchHandle = null
        this._prefetchQueue = []
    }

    _drainPrefetch (deadline) {
        this._prefetchHandle = null
        if (this._prefetchQueue.length) {
            const budgetMs = deadline && typeof deadline.timeRemaining === 'function'
                ? deadline.timeRemaining()
                : 5
            if (budgetMs < 4) {
                this._prefetchHandle = requestIdle(this._boundDrainPrefetch)
            } else {
                this._processOnePrefetch()
            }
        }
    }

    _processOnePrefetch () {
        const task = this._prefetchQueue.shift()
        const key = this._buildRenderCacheKey(task.time, task.planIndex)
        const reschedule = () => {
            if (this._prefetchQueue.length && this._prefetchHandle == null) {
                this._prefetchHandle = requestIdle(this._boundDrainPrefetch)
            }
        }
        if (this._renderCache.has(key)) {
            reschedule()
        } else {
            this._ensureCached(task.time, task.planIndex)
                .catch(() => {})
                .then(reschedule)
        }
    }

    _detachVideoListeners () {
        if (this._video) {
            this._video.removeEventListener('pause', this._boundPause)
            this._video.removeEventListener('seeked', this._boundSeeked)
            this._video.removeEventListener('resize', this._boundResize)
            this._video.removeEventListener('loadedmetadata', this._boundResize)
            if (this._ro) {
                this._ro.unobserve(this._video)
            }
        }
    }

    /**
     * Tear down: cancel rVFC, detach video listeners, clear the prefetch queue
     * and cache, terminate the worker, remove the auto-created canvas.
     * @returns {Promise<void>}
     */
    async destroy () {
        this._log.info('destroy')
        this._destroyed = true
        if (this._video &&
            typeof this._video.cancelVideoFrameCallback === 'function' &&
            this._rvfcHandle != null) {
            this._video.cancelVideoFrameCallback(this._rvfcHandle)
        }

        this._detachVideoListeners()
        this._clearPrefetch()
        this.clearCache()

        if (this._worker) {
            try {
                await this._callWorker('destroy')
            } catch (_e) {
                // ignored
            }
            this._worker.terminate()
            this._worker = null
        }

        if (this._video && this._canvasParent && this._video.parentNode) {
            this._video.parentNode.removeChild(this._canvasParent)
        }
    }
}
