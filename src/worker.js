
let LibassModuleFactory = {}
// #if process.env.JAS_TARGER === 'modern'
import _LibassModuleFactory from 'wasm'
LibassModuleFactory = _LibassModuleFactory
// #endif

const state = {
    module: null,
    libass: null,

    width: 0,
    height: 0,

    ready: false,
    destroyed: false,

    debug: false,

    currentTime: 0,
    lastCurrentTimeReceivedAt: 0,

    fallbackFont: '',
    trackContent: '',
    fonts: []
}

function nowMs () {
    return Date.now()
}

function ensureReady () {
    if (!state.ready || !state.libass || state.destroyed) {
        throw new Error('Worker is not ready')
    }
}

/**
 * @TODO agregar soporte para quitar animcaciones complejas
 */
async function init (data) {
    state.width = data.width || 0
    state.height = data.height || 0
    state.debug = !!data.debug
    state.fallbackFont = data.fallbackFont || ''
    state.trackContent = data.subContent || ''
    state.fonts = Array.isArray(data.fonts) ? data.fonts.slice() : []

    const module = await LibassModuleFactory({ wasm: data.wasmBinary })

    state.module = module
    state.libass = new module.LibassBridge(
        state.width,
        state.height,
        state.fallbackFont,
        false
    )

    if (state.trackContent) {
        state.libass.createTrackMem(state.trackContent)
    }

    if (data.libassMemoryLimit > 0 || data.libassGlyphLimit > 0) {
        state.libass.setMemoryLimits(data.libassGlyphLimit || 0, data.libassMemoryLimit || 0)
    }

    state.ready = true
    state.destroyed = false

    for (let i = 0; i < state.fonts.length; i++) {
        await addFont({ font: state.fonts[i], name: 'font-' + i })
    }

    state.lastCurrentTimeReceivedAt = nowMs()
}

function render ({ time, force }) {
    ensureReady()

    const startedAt = state.debug ? performance.now() : 0
    const head = state.libass.renderImage(time, force ? 1 : 0)
    const changed = !!force || state.libass.getLastChange() !== 0
    const images = []

    if (changed && head) {
        let node = head

        while (node) {
            const size = node.stride * node.h
            const copy = new Uint8Array(size)

            copy.set(state.module.HEAPU8.subarray(node.image, node.image + size))

            images.push({
                x: node.x,
                y: node.y,
                w: node.w,
                h: node.h,
                stride: node.stride,
                color: node.color,
                image: copy
            })

            node = node.next
        }
    }

    if (head) {
        state.libass.freeRenderResult(head)
    }

    return {
        changed,
        width: state.width,
        height: state.height,
        time,
        duration: state.debug ? performance.now() - startedAt : 0,
        images
    }
}


function resize ({ width, height, force }) {
    ensureReady()

    if (width == null || height == null) {
        throw new Error('Invalid canvas size specified')
    }

    state.width = width
    state.height = height
    state.libass.resizeCanvas(state.width, state.height)

    let out
    if (force) {
        out = render({ time: state.currentTime, force: true })
    }
    return out
}

function destroy () {
    if (state.libass) {
        state.libass.quitLibrary()
    }

    state.libass = null
    state.module = null
    state.ready = false
    state.destroyed = true
}

async function addFont ({ name, font }) {
    ensureReady()

    const uint8 = font instanceof Uint8Array ? font : new Uint8Array(font)
    const ptr = state.module._malloc(uint8.byteLength)

    state.module.HEAPU8.set(uint8, ptr)
    state.libass.addFont(name, ptr, uint8.byteLength)
    state.libass.reloadFonts()
}

function setTrack ({ content }) {
    ensureReady()

    state.trackContent = content
    state.libass.createTrackMem(state.trackContent)
}

function removeTrack () {
    ensureReady()
    state.trackContent = ''
    state.libass.removeTrack()
}

function setDefaultFont ({ font }) {
    ensureReady()
    state.fallbackFont = font
    state.libass.setDefaultFont(state.fallbackFont)
}

function createStyle ({ style: input }) {
    ensureReady()

    const index = state.libass.allocStyle()
    const style = state.libass.getStyle(index)

    Object.keys(input).forEach((key) => {
        style[key] = input[key]
    })
    return { index }
}


function getStyles () {
    ensureReady()

    const count = state.libass.getStyleCount()
    const styles = []

    for (let i = 0; i < count; i++) {
        const style = state.libass.getStyle(i)

        styles.push({
            Name: style.Name,
            FontName: style.FontName,
            FontSize: style.FontSize,
            PrimaryColour: style.PrimaryColour,
            SecondaryColour: style.SecondaryColour,
            OutlineColour: style.OutlineColour,
            BackColour: style.BackColour,
            Bold: style.Bold,
            Italic: style.Italic,
            Underline: style.Underline,
            StrikeOut: style.StrikeOut,
            ScaleX: style.ScaleX,
            ScaleY: style.ScaleY,
            Spacing: style.Spacing,
            Angle: style.Angle,
            BorderStyle: style.BorderStyle,
            Outline: style.Outline,
            Shadow: style.Shadow,
            Alignment: style.Alignment,
            MarginL: style.MarginL,
            MarginR: style.MarginR,
            MarginV: style.MarginV,
            Encoding: style.Encoding,
            treat_fontname_as_pattern: style.treat_fontname_as_pattern,
            Blur: style.Blur,
            Justify: style.Justify
        })
    }

    return { styles }
}

function setStyle ({ index, style: input }) {
    ensureReady()
    const style = state.libass.getStyle(index)
    Object.keys(input).forEach(key => {
        style[key] = input[key]
    })
}

function removeStyle ({ index }) {
    ensureReady()
    state.libass.removeStyle(index)
}

function setStyleOverride ({ index }) {
    ensureReady()
    const style = state.libass.getStyle(index)
    state.libass.setStyleOverride(style)
}

function removeStyleOverride () {
    ensureReady()
    state.libass.removeStyleOverride()
}

function createEvent ({ event: input }) {
    ensureReady()

    const index = state.libass.allocEvent()
    const event = state.libass.getEvent(index)

    Object.keys(input).forEach(key => {
        event[key] = input[key]
    })
    return { index }
}

function getEvents () {
    ensureReady()

    const count = state.libass.getEventCount()
    const events = []

    for (let i = 0; i < count; i++) {
        const event = state.libass.getEvent(i)

        events.push({
            Start: event.Start,
            Duration: event.Duration,
            ReadOrder: event.ReadOrder,
            Layer: event.Layer,
            Style: event.Style,
            MarginL: event.MarginL,
            MarginR: event.MarginR,
            MarginV: event.MarginV,
            Name: event.Name,
            Text: event.Text,
            Effect: event.Effect
        })
    }

    return { events }
}

function setEvent ({ index, event: input }) {
    ensureReady()
    const event = state.libass.getEvent(index)
    Object.keys(input).forEach(key => {
        event[key] = input[key]
    })
}

function removeEvent ({ index }) {
    ensureReady()
    state.libass.removeEvent(index)
}


const handlers = {
    init,
    destroy,
    resize,
    render,
    // tracks
    setTrack,
    removeTrack,
    // fonts
    addFont,
    setDefaultFont,
    // styles
    createStyle,
    getStyles,
    setStyle,
    removeStyle,
    // style override
    setStyleOverride,
    removeStyleOverride,
    // events
    createEvent,
    getEvents,
    setEvent,
    removeEvent,
}

self.onmessage = (event) => {
    const data = event.data
    const handler = handlers[data.target]
    const res = {
        id: data.id,
        target: data.target,
        error: null,
        stack: null,
    }

    try {
        if (!handler) {
            throw new Error('Unknown event target ' + data.target)
        }
        Promise.resolve(
            handler(data)
        ).then(result => {
            Object.assign(res, (result || {}))
        }).catch(error => {
            res.error = error?.message || String(error)
            res.stack = error?.stack || null
        }).finally(() => postMessage(res))
    } catch (error) {
        res.error = error?.message || String(error)
        res.stack = error?.stack || null
        postMessage(res)
    }
}
