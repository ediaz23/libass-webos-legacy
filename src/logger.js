const PREFIX = '[libass]'

/**
 * Minimal leveled logger. `info` / `warn` / `error` always emit; `debug` is
 * gated by the `isDebug` callback so the flag can flip at runtime without
 * recreating the logger.
 * @typedef {Object} Logger
 * @property {(...args: any[]) => void} info
 * @property {(...args: any[]) => void} warn
 * @property {(...args: any[]) => void} error
 * @property {(...args: any[]) => void} debug
 */

function toPrintable (value) {
    let out = value
    if (value && typeof value === 'object') {
        try {
            out = JSON.stringify(value)
        } catch (_e) {
            out = String(value)
        }
    }
    return out
}

function formatArgs (args) {
    const out = []
    for (let i = 0; i < args.length; i++) {
        out.push(toPrintable(args[i]))
    }
    return out
}

/**
 * @param {String} scope Short label shown after the shared prefix.
 * @param {() => Boolean} isDebug Called on every `debug()` invocation.
 * @returns {Logger}
 */
export function createLogger (scope, isDebug) {
    const label = PREFIX + ' ' + scope
    return {
        info: function (...args) {
            console.log(label, ...formatArgs(args))
        },
        warn: function (...args) {
            console.warn(label, ...formatArgs(args))
        },
        error: function (...args) {
            console.error(label, ...formatArgs(args))
        },
        debug: function (...args) {
            if (isDebug()) {
                console.debug(label, ...formatArgs(args))
            }
        },
    }
}
