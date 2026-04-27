import 'rvfc-legacy-polyfill'

let EventTargetBase = EventTarget
// #if process.env.JAS_TARGER === 'legacy'
import { EventTarget as EventTargetShim } from 'event-target-shim'
EventTargetBase = EventTargetShim
// #endif

import LRUCache from './LRUCache.js'

/**
 * 
 */

export default class LibAss extends EventTargetBase {
    constructor() {
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

        /** @type {HTMLCanvasElement} */
        this._bufferCanvas = document.createElement('canvas')
        /** @type {CanvasRenderingContext2D} */
        this._bufferCtx = this._bufferCanvas.getContext('2d')
        if (!this._bufferCtx) {
            throw new Error('Canvas rendering not supported')
        }

        /** @type {Worker} */
        this._worker = null
        /** @type {Number} */
        this._reqId = 0
        this._pending = new Map()

        /** @type {Number} */
        this._currentTime = 0
        /** @type {String} */
        this._lastRenderKey = ''
        /** @type {Object} */
        this._lastRendered = null
        /** @type {number} */
        this._rvfcHandle = null

        this._plans = []

        /** @type {LRUCache} */
        this._renderCache = null
        /** @type {Function} */
        this._boundResize = this.resize.bind(this)
        /** @type {Function} */
        this._boundRVFC = this._handleRVFC.bind(this)
    }

    /**
     * @param {Object} options
     * @param {HTMLVideoElement} [options.video]
     * @param {HTMLCanvasElement} [options.canvas]
     * @param {String} [options.workerUrl='libass-worker.js']
     * @param {String} [options.wasmUrl='libass.wasm']
     * @param {String} [options.subContent]
     * @param {Array<Uint8Array>} [options.fonts]
     * @param {String} [options.fallbackFont='liberation sans']
     * @param {Number} [options.timeOffset=0]
     * @param {Boolean} [options.debug=false]
     * @param {Boolean} [options.dropAllAnimations=false]
     * @param {Boolean} [options.dropAllBlur=false]
     * @param {Number} [options.libassMemoryLimit=0]
     * @param {Number} [options.libassGlyphLimit=0]
     * @param {Number} [options.maxCacheSize=200]
     * @param {Number} [options.maxCacheBytes=0]
     */
    async load (options) {
        if (!options) {
            throw new Error('No options provided')
        }

        this.debug = !!options.debug
        this.timeOffset = options.timeOffset || 0

        this._video = options.video || null
        this._canvas = options.canvas || null

        this._renderCache = new LRUCache({
            maxSize: options.maxCacheSize || 300,
            maxBytes: options.maxCacheBytes || 0,
            size: function (value) {
                return value && value.bytes ? value.bytes : 1
            }
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
            libassMemoryLimit: options.libassMemoryLimit || 0,
            libassGlyphLimit: options.libassGlyphLimit || 0,
        })

        if (this._video) {
            await this.setVideo(this._video)
        }

        if (options.subContent) {
            await this.buildPlans()
            await this._warmInitialBuffer()
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

    /**
     * @param {HTMLVideoElement} video 
     */
    async setVideo (video) {
        this._removeListeners()
        this._video = video

        if (typeof video.requestVideoFrameCallback === 'function') {
            this._rvfcHandle = video.requestVideoFrameCallback(this._boundRVFC)
        }

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
            await this.render(
                metadata ? metadata.mediaTime + this.timeOffset : this._video.currentTime + this.timeOffset
            )
            this._rvfcHandle = this._video.requestVideoFrameCallback(this._boundRVFC)
        }
    }

    async resize (width, height, top, left) {
        if (!width || !height) {
            if (!this._video) {
                return
            }

            const rect = this._getVideoPosition()
            width = rect.width || 0
            height = rect.height || 0
            top = rect.y
            left = rect.x
        }

        this._canvas.style.top = (top || 0) + 'px'
        this._canvas.style.left = (left || 0) + 'px'

        if (this._canvas.width !== width) {
            this._canvas.width = width
        }

        if (this._canvas.height !== height) {
            this._canvas.height = height
        }

        await this._callWorker('resize', { width: this._canvas.width, height: this._canvas.height })

        this.clearCache()
    }

    _getVideoPosition (width, height) {
        width = width || this._video.videoWidth
        height = height || this._video.videoHeight

        const videoRatio = width / height
        const offsetWidth = this._video.offsetWidth
        const offsetHeight = this._video.offsetHeight
        const elementRatio = offsetWidth / offsetHeight

        width = offsetWidth
        height = offsetHeight

        if (elementRatio > videoRatio) {
            width = Math.floor(offsetHeight * videoRatio)
        } else {
            height = Math.floor(offsetWidth / videoRatio)
        }

        const x = (offsetWidth - width) / 2
        const y = (offsetHeight - height) / 2

        return { width, height, x, y }
    }

    async setTrack (content) {
        await this._callWorker('setTrack', { content })
        await this.buildPlans()
        await this._warmInitialBuffer()
        this.dispatchEvent(new CustomEvent('ready'))
    }

    async removeTrack () {
        await this._callWorker('removeTrack')
        this._plans = []
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
        return await this._callWorker('getStyles')
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
        return await this._callWorker('createEvent', { event })
    }

    async getEvents () {
        return await this._callWorker('getEvents')
    }

    async removeEvent (index) {
        await this._callWorker('removeEvent', { index })
    }

    async buildPlans () {
        this.clearCache()
        const { events } = await this._callWorker('getEvents')
        this._plans = []

        for (let i = 0; i < events.length; i++) {
            const event = events[i]
            const start = (event.Start || 0) / 100
            const duration = (event.Duration || 0) / 100
            const end = start + duration
            const text = event.Text || ''
            const effect = event.Effect || ''

            const hasPosition = /\\pos\s*\(|\\move\s*\(|\\org\s*\(/.test(text)
            const heavy = /\\t\s*\(|\\p\d+|\\blur\d+|\\be\d+|\\k\d+|\\K\d+|\\kf\d+|\\ko\d+/.test(text) || !!effect

            let type = 1
            if (heavy) {
                type = 3
            } else if (hasPosition) {
                type = 2
            }

            this._plans.push({ type, start, end, samples: this._buildSamples(type, start, end) })
        }
    }

    _buildSamples (type, start, end) {
        const out = []
        if (type === 1) {
            out.push(start)
        } else {
            // generate samples
            // type=2 between 3 and 6 samples
            // type=3 between 6 and 16 samples
            const duration = Math.max(end - start, 0)
            const count = type === 2
                ? Math.max(3, Math.min(6, Math.ceil(duration * 2)))
                : Math.max(6, Math.min(16, Math.ceil(duration * 6)))

            if (count <= 1 || end <= start) {
                out.push(start)
            } else {
                const step = (end - start) / (count - 1)

                for (let i = 0; i < count; i++) {
                    out.push(Math.round((start + (step * i)) * 1000) / 1000)
                }
            }
        }

        return out
    }

    _resolvePlannedTime (time) {
        let planned = Math.round(time * 1000) / 1000

        for (let i = 0; i < this._plans.length; i++) {
            const plan = this._plans[i]

            if (time < plan.start || time > plan.end) {
                continue
            }

            let candidate = plan.samples[0]

            for (let j = 0; j < plan.samples.length; j++) {
                if (plan.samples[j] <= time) {
                    candidate = plan.samples[j]
                } else {
                    break
                }
            }

            if (candidate > planned) {
                planned = candidate
            }
        }

        return planned
    }

    _buildRenderCacheKey (time) {
        return [
            Math.round(time * 1000),
            this._canvas.width,
            this._canvas.height,
        ].join(':')
    }

    async _renderAt (time, force) {
        const res = await this._callWorker('render', { time, force: !!force })

        let bytes = 0
        const images = res.images || []

        for (let i = 0; i < images.length; i++) {
            bytes += images[i].image ? images[i].image.byteLength || 0 : 0
        }

        return {
            changed: !!res.changed,
            time: res.time,
            width: res.width,
            height: res.height,
            duration: res.duration,
            images,
            bytes: bytes || 1
        }
    }

    async _ensureCached (time) {
        const key = this._buildRenderCacheKey(time)
        const cached = this._renderCache.get(key)

        if (cached) {
            return cached
        }

        const rendered = await this._renderAt(time, false)
        this._renderCache.set(key, rendered)
        return rendered
    }

    async _warmInitialBuffer () {
        const current = this._video ? this._video.currentTime + this.timeOffset : 0
        const targets = []

        for (let i = 0; i < this._plans.length && targets.length < 12; i++) {
            const samples = this._plans[i].samples
            for (let j = 0; j < samples.length && targets.length < 12; j++) {
                if (samples[j] >= current) {
                    targets.push(samples[j])
                }
            }
        }

        for (let i = 0; i < targets.length; i++) {
            await this._ensureCached(targets[i])
        }
    }

    async _preloadAhead (time) {
        const targets = [time]
        let count = 0

        for (let i = 0; i < this._plans.length && count < 8; i++) {
            const samples = this._plans[i].samples
            for (let j = 0; j < samples.length && count < 8; j++) {
                if (samples[j] > time) {
                    targets.push(samples[j])
                    count += 1
                }
            }
        }

        for (let i = 0; i < targets.length; i++) {
            await this._ensureCached(targets[i])
        }
    }

    async render (time) {
        if (typeof time !== 'number' || !isFinite(time)) {
            time = this._video ? this._video.currentTime + this.timeOffset : this._currentTime
        }

        this._currentTime = time

        const plannedTime = this._resolvePlannedTime(time)
        const key = this._buildRenderCacheKey(plannedTime)
        let result
        if (this._lastRenderKey === key && this._lastRendered) {
            this._drawRenderResult(this._lastRendered)
            result = this._lastRendered
        } else {
            result = this._renderCache.get(key)
            if (!result) {
                const wasPlaying = !!(this._video && !this._video.paused)

                if (wasPlaying) {
                    this.dispatchEvent(new CustomEvent('loading'))
                }

                await this._preloadAhead(plannedTime)
                result = this._renderCache.get(key)

                if (!result) {
                    result = await this._ensureCached(plannedTime)
                }

                if (wasPlaying) {
                    this.dispatchEvent(new CustomEvent('ready'))
                }
            }

            this._drawRenderResult(result)
            this._lastRenderKey = key
            this._lastRendered = result
        }

        return result
    }

    _drawRenderResult (result) {
        this._clearCanvas()

        if (!result || !result.images || !result.images.length) {
            return
        }

        for (let i = 0; i < result.images.length; i++) {
            const image = result.images[i]

            if (!image || !image.image) {
                continue
            }

            const pixels = image.image instanceof Uint8Array
                ? image.image
                : new Uint8Array(image.image)

            this._bufferCanvas.width = image.w
            this._bufferCanvas.height = image.h

            this._bufferCtx.putImageData(
                new ImageData(
                    new Uint8ClampedArray(
                        pixels.buffer,
                        pixels.byteOffset,
                        pixels.byteLength
                    ),
                    image.w,
                    image.h
                ),
                0,
                0
            )

            this._ctx.drawImage(this._bufferCanvas, image.x, image.y)
        }
    }

    _clearCanvas () {
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height)
    }

    clearCache () {
        this._renderCache.clear()
        this._lastRenderKey = ''
        this._lastRendered = null
    }

    getCacheStats () {
        return {
            size: this._renderCache.size,
            bytes: this._renderCache.bytes
        }
    }

    _removeListeners () {
        if (this._video && this._ro) {
            this._ro.unobserve(this._video)
        }
    }

    async destroy () {
        if (this._video && typeof this._video.cancelVideoFrameCallback === 'function' && this._rvfcHandle != null) {
            this._video.cancelVideoFrameCallback(this._rvfcHandle)
        }

        this._removeListeners()
        this.clearCache()

        if (this._worker) {
            try {
                await this._callWorker('destroy')
            } catch (_e) {
                // nada
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