const PREFIX = '[libass]'

/**
 * @param {String} scope
 * @param {() => Boolean} isDebug
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
