import 'rvfc-legacy-polyfill'

let EventTargetBase = EventTarget
// #if process.env.JAS_TARGER === 'legacy'
import { EventTarget as EventTargetShim } from 'event-target-shim'
EventTargetBase = EventTargetShim
// #endif

import LRUCache from './LRUCache.js'

export default class LibAss extends EventTargetBase {
    /**
     * @param {Object} options
     * @param {HTMLVideoElement} [options.video]
     * @param {HTMLCanvasElement} [options.canvas]
     * @param {'js'|'wasm'} [options.blendMode='js']
     * @param {String} [options.workerUrl='jassub-worker.js']
     * @param {String} [options.wasmUrl='jassub.wasm']
     * @param {String} [options.subUrl]
     * @param {String} [options.subContent]
     * @param {String[]|Uint8Array[]} [options.fonts]
     * @param {Object} [options.availableFonts={'liberation sans': './default.woff2'}]
     * @param {String} [options.fallbackFont='liberation sans']
     * @param {Number} [options.timeOffset=0]
     * @param {Boolean} [options.debug=false]
     * @param {Number} [options.prescaleFactor=1.0]
     * @param {Number} [options.prescaleHeightLimit=1080]
     * @param {Number} [options.maxRenderHeight=0]
     * @param {Boolean} [options.dropAllAnimations=false]
     * @param {Boolean} [options.dropAllBlur=false]
     * @param {Number} [options.libassMemoryLimit=0]
     * @param {Number} [options.libassGlyphLimit=0]
     * @param {Number} [options.maxCacheSize=200]
     * @param {Number} [options.maxCacheBytes=0]
     */
    constructor(options) {
        super()

        if (!options) {
            throw new Error('No options provided')
        }

        this._destroyed = false
        this._ready = false

        this.debug = !!options.debug
        this.timeOffset = options.timeOffset || 0

        this.blendMode = options.blendMode || 'js'
        this.workerUrl = options.workerUrl || 'jassub-worker.js'
        this.wasmUrl = options.wasmUrl || 'jassub.wasm'

        this.prescaleFactor = options.prescaleFactor || 1.0
        this.prescaleHeightLimit = options.prescaleHeightLimit || 1080
        this.maxRenderHeight = options.maxRenderHeight || 0

        this.dropAllAnimations = !!options.dropAllAnimations
        this.dropAllBlur = !!options.dropAllBlur

        this.libassMemoryLimit = options.libassMemoryLimit || 0
        this.libassGlyphLimit = options.libassGlyphLimit || 0

        this._playbackRate = 1
        this._currentTime = 0
        this._lastRenderTime = -1
        this._lastRenderKey = ''
        this._rvfcHandle = null

        this._video = null
        this._videoWidth = 0
        this._videoHeight = 0

        this._canvas = options.canvas || null
        this._canvasParent = null

        if (!this._canvas && options.video) {
            this._video = options.video
            this._canvasParent = document.createElement('div')
            this._canvasParent.className = 'LibAss'
            this._canvasParent.style.position = 'relative'
            this._canvas = this._createCanvas()
            this._video.insertAdjacentElement('afterend', this._canvasParent)
        } else if (this._canvas) {
            this._video = options.video || null
        } else {
            throw new Error('You should give video or canvas in options.')
        }

        this._ctx = this._canvas.getContext('2d')
        if (!this._ctx) {
            throw new Error('Canvas rendering not supported')
        }

        this._bufferCanvas = document.createElement('canvas')
        this._bufferCtx = this._bufferCanvas.getContext('2d')
        if (!this._bufferCtx) {
            throw new Error('Canvas rendering not supported')
        }

        this._events = []

        this._boundResize = this.resize.bind(this)
        this._boundSetRate = this.setRate.bind(this)
        this._boundRVFC = this._handleRVFC.bind(this)

        this._renderCache = new LRUCache({
            maxSize: options.maxCacheSize || 200,
            maxBytes: options.maxCacheBytes || 0,
            size: function (value) {
                return value && value.bytes ? value.bytes : 1
            },
            onEviction: function (_key, value) {
                if (value && value.image && typeof value.image.close === 'function') {
                    value.image.close()
                }
            }
        })

        if (options.fonts && options.fonts.length) {
            for (var i = 0; i < options.fonts.length; i++) {
                this.addFont(options.fonts[i])
            }
        }

        if (this._video) {
            this.setVideo(this._video)
        }

        if (options.subContent) {
            this.setTrack(options.subContent)
        } else if (options.subUrl) {
            this.setTrackByUrl(options.subUrl)
        }

        this._ready = true
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

    async setNewContext (context) {
        if (this._destroyed) {
            throw new Error('Instance destroyed')
        }

        if (context.video && context.video !== this._video) {
            if (this._canvasParent) {
                context.video.insertAdjacentElement('afterend', this._canvasParent)
            }
            this._videoWidth = 0
            this._videoHeight = 0
            this.setVideo(context.video)
        }

        if (typeof context.subContent === 'string') {
            this.setTrack(context.subContent)
        }
    }

    setVideo (video) {
        if (!(video instanceof HTMLVideoElement)) {
            throw new Error('Video element invalid!')
        }

        this._removeListeners()
        this._video = video

        if (typeof video.requestVideoFrameCallback === 'function') {
            this._rvfcHandle = video.requestVideoFrameCallback(this._boundRVFC)
        }

        video.addEventListener('ratechange', this._boundSetRate, false)

        if (typeof ResizeObserver !== 'undefined') {
            if (!this._ro) {
                this._ro = new ResizeObserver(this._boundResize)
            }
            this._ro.observe(video)
        }

        if (video.videoWidth > 0) {
            this.resize()
        }
    }

    _handleRVFC (_now, metadata) {
        if (this._destroyed || !this._video) {
            return
        }

        if (metadata) {
            if (metadata.width !== this._videoWidth || metadata.height !== this._videoHeight) {
                this._videoWidth = metadata.width
                this._videoHeight = metadata.height
                this.resize()
            }

            this.render(metadata.mediaTime + this.timeOffset)
        } else {
            this.render(this._video.currentTime + this.timeOffset)
        }

        this._rvfcHandle = this._video.requestVideoFrameCallback(this._boundRVFC)
    }

    resize (width, height, top, left) {
        if (!width || !height) {
            if (!this._video) {
                return
            }

            var videoSize = this._getVideoPosition()
            var renderSize

            if (this._videoWidth) {
                var widthRatio = this._video.videoWidth / this._videoWidth
                var heightRatio = this._video.videoHeight / this._videoHeight
                renderSize = this._computeCanvasSize(
                    (videoSize.width || 0) / widthRatio,
                    (videoSize.height || 0) / heightRatio
                )
            } else {
                renderSize = this._computeCanvasSize(videoSize.width || 0, videoSize.height || 0)
            }

            width = renderSize.width
            height = renderSize.height

            if (this._canvasParent) {
                top = videoSize.y - (this._canvasParent.getBoundingClientRect().top - this._video.getBoundingClientRect().top)
                left = videoSize.x
            } else {
                top = 0
                left = 0
            }

            this._canvas.style.width = videoSize.width + 'px'
            this._canvas.style.height = videoSize.height + 'px'
        }

        this._canvas.style.top = (top || 0) + 'px'
        this._canvas.style.left = (left || 0) + 'px'

        if (this._canvas.width !== width) {
            this._canvas.width = width
        }
        if (this._canvas.height !== height) {
            this._canvas.height = height
        }
    }

    _getVideoPosition (width, height) {
        width = width || this._video.videoWidth
        height = height || this._video.videoHeight

        var videoRatio = width / height
        var offsetWidth = this._video.offsetWidth
        var offsetHeight = this._video.offsetHeight
        var elementRatio = offsetWidth / offsetHeight

        width = offsetWidth
        height = offsetHeight

        if (elementRatio > videoRatio) {
            width = Math.floor(offsetHeight * videoRatio)
        } else {
            height = Math.floor(offsetWidth / videoRatio)
        }

        var x = (offsetWidth - width) / 2
        var y = (offsetHeight - height) / 2

        return { width: width, height: height, x: x, y: y }
    }

    _computeCanvasSize (width, height) {
        var scalefactor = this.prescaleFactor <= 0 ? 1.0 : this.prescaleFactor
        var ratio = self.devicePixelRatio || 1

        if (height <= 0 || width <= 0) {
            width = 0
            height = 0
        } else {
            var sgn = scalefactor < 1 ? -1 : 1
            var newH = height * ratio

            if (sgn * newH * scalefactor <= sgn * this.prescaleHeightLimit) {
                newH *= scalefactor
            } else if (sgn * newH < sgn * this.prescaleHeightLimit) {
                newH = this.prescaleHeightLimit
            }

            if (this.maxRenderHeight > 0 && newH > this.maxRenderHeight) {
                newH = this.maxRenderHeight
            }

            width *= newH / height
            height = newH
        }

        return { width: width, height: height }
    }

    runBenchmark () {
        return {
            classification: this._classification,
            cache: this.getCacheStats(),
            events: this._events.length,
            styles: this._styles.length
        }
    }

    setTrackByUrl (url) {
        this._track = { type: 'url', value: url }
        this._trackMeta = { source: 'url', url: url }
        this._invalidateTrackState()
        this._classifyTrack()
    }

    setTrack (content) {
        this._track = { type: 'content', value: content }
        this._trackMeta = {
            source: 'content',
            length: content ? content.length : 0
        }
        this._invalidateTrackState()
        this._classifyTrack()
    }

    freeTrack () {
        this._track = null
        this._trackMeta = null
        this._events = []
        this._styles = []
        this._styleOverride = null
        this._classification = null
        this.clearCache()
        this._clearCanvas()
    }

    setRate (rate) {
        if (typeof rate === 'number' && isFinite(rate)) {
            this._playbackRate = rate
        } else if (this._video) {
            this._playbackRate = this._video.playbackRate || 1
        }
    }

    setCurrentTime (currentTime, rate) {
        if (typeof currentTime === 'number' && isFinite(currentTime)) {
            this._currentTime = currentTime
        }
        if (typeof rate === 'number' && isFinite(rate)) {
            this._playbackRate = rate
        }
    }

    render (time) {
        if (this._destroyed) {
            return null
        }

        if (typeof time !== 'number' || !isFinite(time)) {
            time = this._video ? this._video.currentTime + this.timeOffset : this._currentTime
        }

        this._currentTime = time

        var width = this._canvas.width
        var height = this._canvas.height
        var key = this._buildRenderCacheKey(time, width, height)

        if (this._lastRenderKey === key) {
            return this._renderCache.peek(key) || null
        }

        var cached = this._renderCache.get(key)
        if (cached) {
            this._drawRenderResult(cached)
            this._lastRenderKey = key
            this._lastRenderTime = time
            return cached
        }

        var result = this._renderAtTime(time, width, height)
        this._drawRenderResult(result)
        this._renderCache.set(key, result)
        this._lastRenderKey = key
        this._lastRenderTime = time

        return result
    }

    renderAt (time) {
        return this.render(time)
    }

    preloadRange (start, end, step) {
        if (typeof step !== 'number' || step <= 0) {
            step = 1 / 12
        }

        for (var t = start; t <= end; t += step) {
            this.render(t)
        }
    }

    createEvent (event) {
        var normalized = this._normalizeEvent(event)
        normalized._index = this._events.length
        this._events.push(normalized)
        this._invalidateRenderCache()
    }

    setEvent (event, index) {
        if (index < 0 || index >= this._events.length) {
            return
        }

        var normalized = this._normalizeEvent(event)
        normalized._index = index
        this._events[index] = normalized
        this._invalidateRenderCache()
    }

    removeEvent (index) {
        if (index < 0 || index >= this._events.length) {
            return
        }

        this._events.splice(index, 1)
        this._reindexEvents()
        this._invalidateRenderCache()
    }

    removeAllEvents () {
        this._events = []
        this._invalidateRenderCache()
    }

    getEvents (callback) {
        var events = this._cloneArray(this._events)
        if (typeof callback === 'function') {
            callback(null, events)
        }
        return events
    }

    setStyleOverride (style) {
        this._styleOverride = this._normalizeStyle(style)
        this._invalidateRenderCache()
    }

    styleOverride (style) {
        this.setStyleOverride(style)
    }

    disableStyleOverride () {
        this._styleOverride = null
        this._invalidateRenderCache()
    }

    createStyle (style) {
        this._styles.push(this._normalizeStyle(style))
        this._invalidateRenderCache()
    }

    setStyle (style, index) {
        if (index < 0 || index >= this._styles.length) {
            return
        }

        this._styles[index] = this._normalizeStyle(style)
        this._invalidateRenderCache()
    }

    removeStyle (index) {
        if (index < 0 || index >= this._styles.length) {
            return
        }

        this._styles.splice(index, 1)
        this._invalidateRenderCache()
    }

    removeAllStyles () {
        this._styles = []
        this._invalidateRenderCache()
    }

    getStyles (callback) {
        var styles = this._cloneArray(this._styles)
        if (typeof callback === 'function') {
            callback(null, styles)
        }
        return styles
    }

    addFont (font) {
        this._fonts.push(font)
    }

    setDefaultFont (font) {
        this._fallbackFont = font
        this._invalidateRenderCache()
    }

    classifyTrack () {
        return this._classifyTrack()
    }

    getTrackInfo () {
        return {
            track: this._trackMeta,
            classification: this._classification,
            events: this._events.length,
            styles: this._styles.length,
            fonts: this._fonts.length,
            fallbackFont: this._fallbackFont
        }
    }

    clearCache () {
        this._renderCache.clear()
        this._lastRenderKey = ''
        this._lastRenderTime = -1
    }

    getCacheStats () {
        return {
            size: this._renderCache.size,
            bytes: this._renderCache.bytes
        }
    }

    _invalidateTrackState () {
        this._events = []
        this._styles = []
        this._styleOverride = null
        this.clearCache()
    }

    _invalidateRenderCache () {
        this.clearCache()
    }

    _classifyTrack () {
        var value = this._track && this._track.value ? this._track.value : ''
        var flags = {
            hasAnimations: /\\t\s*\(/.test(value),
            hasBlur: /\\blur\d+|\\be\d+/i.test(value),
            hasPositioning: /\\pos\s*\(|\\move\s*\(|\\org\s*\(/.test(value),
            hasVector: /\\p\d+/.test(value),
            hasManyEvents: this._events.length > 200
        }

        var level = 'light'
        if (flags.hasVector || flags.hasAnimations || flags.hasBlur || flags.hasManyEvents) {
            level = 'heavy'
        } else if (flags.hasPositioning) {
            level = 'medium'
        }

        this._classification = {
            level: level,
            flags: flags
        }

        return this._classification
    }

    _normalizeEvent (event) {
        event = event || {}

        return {
            Start: event.Start || 0,
            Duration: event.Duration || 0,
            Style: event.Style || 'Default',
            Name: event.Name || '',
            MarginL: event.MarginL || 0,
            MarginR: event.MarginR || 0,
            MarginV: event.MarginV || 0,
            Effect: event.Effect || '',
            Text: event.Text || '',
            ReadOrder: event.ReadOrder || 0,
            Layer: event.Layer || 0,
            _index: typeof event._index === 'number' ? event._index : -1
        }
    }

    _normalizeStyle (style) {
        style = style || {}

        return {
            Name: style.Name || 'Default',
            FontName: style.FontName || this._fallbackFont,
            FontSize: style.FontSize || 16,
            PrimaryColour: style.PrimaryColour || 0x00ffffff,
            SecondaryColour: style.SecondaryColour || 0x00ffffff,
            OutlineColour: style.OutlineColour || 0x00000000,
            BackColour: style.BackColour || 0x00000000,
            Bold: style.Bold || 0,
            Italic: style.Italic || 0,
            Underline: style.Underline || 0,
            StrikeOut: style.StrikeOut || 0,
            ScaleX: style.ScaleX || 100,
            ScaleY: style.ScaleY || 100,
            Spacing: style.Spacing || 0,
            Angle: style.Angle || 0,
            BorderStyle: style.BorderStyle || 1,
            Outline: style.Outline || 0,
            Shadow: style.Shadow || 0,
            Alignment: style.Alignment || 2,
            MarginL: style.MarginL || 0,
            MarginR: style.MarginR || 0,
            MarginV: style.MarginV || 0,
            Encoding: style.Encoding || 0,
            treat_fontname_as_pattern: style.treat_fontname_as_pattern || 0,
            Blur: style.Blur || 0,
            Justify: style.Justify || 0
        }
    }

    _reindexEvents () {
        for (var i = 0; i < this._events.length; i++) {
            this._events[i]._index = i
        }
    }

    _buildRenderCacheKey (time, width, height) {
        var timeBucket = Math.round(time * 1000)
        var classification = this._classification ? this._classification.level : 'none'
        return [
            timeBucket,
            width,
            height,
            this._events.length,
            this._styles.length,
            classification,
            this.blendMode,
            this.dropAllAnimations ? 1 : 0,
            this.dropAllBlur ? 1 : 0,
            this._styleOverride ? 1 : 0
        ].join(':')
    }

    _renderAtTime (time, width, height) {
        var activeEvents = this._getActiveEvents(time)

        return {
            time: time,
            width: width,
            height: height,
            images: [],
            events: activeEvents,
            bytes: activeEvents.length || 1
        }
    }

    _getActiveEvents (time) {
        var active = []

        for (var i = 0; i < this._events.length; i++) {
            var event = this._events[i]
            var start = event.Start / 100
            var end = start + (event.Duration / 100)

            if (time >= start && time <= end) {
                active.push(event)
            }
        }

        return active
    }

    _drawRenderResult (result) {
        this._clearCanvas()

        if (this.debug && result && result.events) {
            for (var i = 0; i < result.events.length; i++) {
                var event = result.events[i]
                if (event && event.Text) {
                    console.log('[render]', result.time, event.Text)
                }
            }
        }
    }

    _clearCanvas () {
        this._ctx.clearRect(0, 0, this._canvas.width, this._canvas.height)
    }

    _cloneArray (arr) {
        return JSON.parse(JSON.stringify(arr))
    }

    _removeListeners () {
        if (this._video) {
            if (this._ro) {
                this._ro.unobserve(this._video)
            }
            this._video.removeEventListener('ratechange', this._boundSetRate)
        }
    }

    destroy () {
        this._destroyed = true

        if (this._video && typeof this._video.cancelVideoFrameCallback === 'function' && this._rvfcHandle != null) {
            this._video.cancelVideoFrameCallback(this._rvfcHandle)
        }

        this._removeListeners()
        this.clearCache()

        if (this._video && this._canvasParent) {
            this._video.parentNode && this._video.parentNode.removeChild(this._canvasParent)
        }
    }
}