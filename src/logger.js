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

/**
 * @param {String} scope Short label shown after the shared prefix.
 * @param {() => Boolean} isDebug Called on every `debug()` invocation.
 * @returns {Logger}
 */
export function createLogger (scope, isDebug) {
    const label = PREFIX + ' ' + scope
    return {
        info: function (...args) {
            console.log(label, ...args)
        },
        warn: function (...args) {
            console.warn(label, ...args)
        },
        error: function (...args) {
            console.error(label, ...args)
        },
        debug: function (...args) {
            if (isDebug()) {
                console.debug(label, ...args)
            }
        },
    }
}
