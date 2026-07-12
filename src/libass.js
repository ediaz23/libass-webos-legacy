import 'rvfc-legacy-polyfill'

let EventTargetBase = EventTarget
// #if process.env.JAS_TARGER === 'legacy'
import { EventTarget as EventTargetShim } from 'event-target-shim'
EventTargetBase = EventTargetShim
// #endif

import LRUCache from './LRUCache.js'

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

function requestIdle (cb) {
    let handle
    if (typeof requestIdleCallback === 'function') {
        handle = requestIdleCallback(cb, { timeout: 500 })
    } else {
        handle = setTimeout(() => cb({ timeRemaining: () => 5, didTimeout: false }), 16)
    }
    return handle
}

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
 * @typedef {Object} EventPlan
 * @property {Number} index
 * @property {'A'|'B'|'C'|'D'} type
 * @property {Number} start
 * @property {Number} end
 * @property {Array<Number>} samples
 */

/**
 * @typedef {Object} RenderEntry
 * @property {Array<{x:Number, y:Number, w:Number, h:Number, bitmap:ImageBitmap}>} images
 * @property {Number} width
 * @property {Number} height
 * @property {Number} time
 * @property {Number} bytes
 */

export default class LibAss extends EventTargetBase {
    constructor () {
        super()

        this.debug = false
        /** @type {Number} */
        this.timeOffset = 0

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

        /** @type {Array<EventPlan>} */
        this._plans = []
        /** @type {Number} */
        this._planCursor = 0

        /** @type {LRUCache} */
        this._renderCache = null

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

        this._boundResize = this.resize.bind(this)
        this._boundRVFC = this._handleRVFC.bind(this)
        this._boundPause = this._handlePause.bind(this)
        this._boundSeeked = this._handleSeeked.bind(this)
        this._boundDrainPrefetch = this._drainPrefetch.bind(this)
    }

    /**
     * @param {Object} options
     * @param {HTMLVideoElement} [options.video]
     * @param {HTMLCanvasElement} [options.canvas]
     * @param {String} [options.workerUrl='libass-worker.js']
     * @param {String} [options.wasmUrl='libass.wasm']
     * @param {String} [options.legacyWasmUrl]
     * @param {String} [options.subContent]
     * @param {Array<Uint8Array>} [options.fonts]
     * @param {String} [options.fallbackFont='']
     * @param {Number} [options.timeOffset=0]
     * @param {Boolean} [options.debug=false]
     * @param {Number} [options.libassMemoryLimit=0]
     * @param {Number} [options.libassGlyphLimit=0]
     * @param {Number} [options.maxCacheBytes]
     * @param {Number} [options.prefetchForwardMs]
     * @param {Number} [options.classCSamplesMin]
     * @param {Number} [options.classCSamplesMax]
     * @param {Number} [options.classCMinIntervalMs]
     */
    async load (options) {
        if (!options) {
            throw new Error('No options provided')
        }

        this.debug = !!options.debug
        this.timeOffset = options.timeOffset || 0

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
            fallbackFont: options.fallbackFont || '',
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
        this.dispatchEvent(new CustomEvent('ready'))
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
        this._pending.forEach((pending) => {
            pending.reject(error)
        })
        this._pending.clear()
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
     * @param {HTMLVideoElement} video
     */
    async setVideo (video) {
        this._detachVideoListeners()
        this._video = video

        if (typeof video.requestVideoFrameCallback === 'function') {
            this._rvfcHandle = video.requestVideoFrameCallback(this._boundRVFC)
        }
        video.addEventListener('pause', this._boundPause)
        video.addEventListener('seeked', this._boundSeeked)

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
            await this.render(t)
            this._rvfcHandle = this._video.requestVideoFrameCallback(this._boundRVFC)
        }
    }

    _handlePause () {
        if (this._video) {
            this.render(this._currentTimeSafe())
        }
    }

    _handleSeeked () {
        this._planCursor = 0
        this._clearPrefetch()
        this._lastRenderKey = ''
        this._lastRendered = null
        if (this._video) {
            this.render(this._currentTimeSafe())
        }
    }

    async resize (width, height, top, left) {
        const rect = this._resolveResizeRect(width, height, top, left)
        if (rect) {
            this._canvas.style.top = (rect.top || 0) + 'px'
            this._canvas.style.left = (rect.left || 0) + 'px'
            if (this._canvas.width !== rect.width) {
                this._canvas.width = rect.width
            }
            if (this._canvas.height !== rect.height) {
                this._canvas.height = rect.height
            }
            await this._callWorker('resize', { width: this._canvas.width, height: this._canvas.height })
            this.clearCache()
        }
    }

    _resolveResizeRect (width, height, top, left) {
        let rect = null
        if (width && height) {
            rect = { width, height, top: top || 0, left: left || 0 }
        } else if (this._video) {
            const pos = this._getVideoPosition()
            rect = {
                width: pos.width || 0,
                height: pos.height || 0,
                top: pos.y,
                left: pos.x,
            }
        }
        return rect
    }

    _getVideoPosition (width, height) {
        let w = width || this._video.videoWidth
        let h = height || this._video.videoHeight

        const videoRatio = w / h
        const offsetWidth = this._video.offsetWidth
        const offsetHeight = this._video.offsetHeight
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

    async setTrack (content) {
        await this._callWorker('setTrack', { content })
        await this.buildPlans()
        this._schedulePrefetch(this._currentTimeSafe())
        this.dispatchEvent(new CustomEvent('ready'))
    }

    async removeTrack () {
        await this._callWorker('removeTrack')
        this._plans = []
        this._planCursor = 0
        this._clearPrefetch()
        this.clearCache()
        this._clearCanvas()
    }

    async addFont (name, font) {
        await this._callWorker('addFont', { name, font })
    }

    async setDefaultFont (font) {
        await this._callWorker('setDefaultFont', { font })
    }

    async createStyle (style) {
        return this._callWorker('createStyle', { style })
    }

    async getStyles () {
        return this._callWorker('getStyles')
    }

    async removeStyle (index) {
        await this._callWorker('removeStyle', { index })
    }

    async setStyleOverride (index) {
        await this._callWorker('setStyleOverride', { index })
    }

    async removeStyleOverride () {
        await this._callWorker('removeStyleOverride')
    }

    async createEvent (event) {
        return this._callWorker('createEvent', { event })
    }

    async getEvents () {
        return this._callWorker('getEvents')
    }

    async removeEvent (index) {
        await this._callWorker('removeEvent', { index })
    }

    async buildPlans () {
        this._clearPrefetch()
        this.clearCache()
        const { events } = await this._callWorker('getEvents')
        this._plans = []
        this._planCursor = 0

        for (let i = 0; i < events.length; i++) {
            const event = events[i]
            const start = (event.Start || 0) / 100
            const duration = (event.Duration || 0) / 100
            const end = start + duration
            const text = event.Text || ''
            const effect = event.Effect || ''
            const type = classify(text, effect)

            this._plans.push({
                index: i,
                type,
                start,
                end,
                samples: this._buildSamples(type, start, end),
            })
        }
    }

    _buildSamples (type, start, end) {
        const out = []
        if (type === 'C') {
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
        } else {
            out.push(start)
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
        while (this._planCursor < this._plans.length &&
               this._plans[this._planCursor].end < time) {
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

    _resolvePlannedTime (time, plan) {
        let planned = Math.round(time * 1000) / 1000
        if (plan) {
            let candidate = plan.samples[0]
            for (let i = 0; i < plan.samples.length && plan.samples[i] <= time; i++) {
                candidate = plan.samples[i]
            }
            planned = candidate
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
            if (img && img.image) {
                const pixels = img.image instanceof Uint8Array
                    ? img.image
                    : new Uint8Array(img.image)
                const clamped = new Uint8ClampedArray(
                    pixels.buffer, pixels.byteOffset, pixels.byteLength
                )
                const bitmap = await createImageBitmap(new ImageData(clamped, img.w, img.h))
                images.push({ x: img.x, y: img.y, w: img.w, h: img.h, bitmap })
                bytes += img.w * img.h * 4
            }
        }
        return {
            images,
            width: raw.width,
            height: raw.height,
            time: raw.time,
            bytes: bytes || 1,
        }
    }

    async _ensureCached (planned, planIndex) {
        const key = this._buildRenderCacheKey(planned, planIndex)
        let entry = this._renderCache.get(key)
        if (!entry) {
            const raw = await this._renderAt(planned)
            entry = await this._toEntry(raw)
            this._renderCache.set(key, entry)
        }
        return entry
    }

    async render (time) {
        let t = time
        if (typeof t !== 'number' || !isFinite(t)) {
            t = this._currentTimeSafe()
        }
        this._currentTime = t

        const plan = this._planForTime(t)

        if (plan && plan.type === 'D') {
            await this._renderLive(t)
        } else {
            await this._renderCached(t, plan)
        }
    }

    async _renderLive (time) {
        const raw = await this._renderAt(time)
        const entry = await this._toEntry(raw)
        this._drawRenderResult(entry)
        this._closeEntry(entry)
        this._lastRenderKey = ''
        this._lastRendered = null
    }

    async _renderCached (time, plan) {
        const planned = this._resolvePlannedTime(time, plan)
        const planIndex = plan ? plan.index : -1
        const key = this._buildRenderCacheKey(planned, planIndex)

        if (key !== this._lastRenderKey || !this._lastRendered) {
            const entry = await this._ensureCached(planned, planIndex)
            this._drawRenderResult(entry)
            this._lastRenderKey = key
            this._lastRendered = entry
            this._schedulePrefetch(time)
        }
    }

    _drawRenderResult (entry) {
        this._clearCanvas()
        if (entry && entry.images && entry.images.length) {
            for (let i = 0; i < entry.images.length; i++) {
                const img = entry.images[i]
                if (img && img.bitmap) {
                    this._ctx.drawImage(img.bitmap, img.x, img.y)
                }
            }
        }
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

    clearCache () {
        this._renderCache.clear()
        this._lastRenderKey = ''
        this._lastRendered = null
    }

    getCacheStats () {
        return {
            size: this._renderCache.size,
            bytes: this._renderCache.bytes,
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
            if (this._ro) {
                this._ro.unobserve(this._video)
            }
        }
    }

    async destroy () {
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
        this.dispatchEvent(new CustomEvent('destroy'))
    }
}
