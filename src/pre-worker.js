/* eslint-disable no-unused-vars */
/* global err:writable updateMemoryViews:writable wasmMemory */

// Route stderr writes that come from libass through console.debug so the
// startup banner ([ass] libass API version..., 'can't find selected font
// provider', etc.) stops spamming the browser console. Non-libass errors
// keep going to console.error.
err = text => {
    if (typeof text === 'string' && text.startsWith('[ass]')) {
        console.debug(text)
    } else {
        console.error(text)
    }
}

// With -s MINIMAL_RUNTIME=1 emscripten strips the memory views from the
// exported Module object. Hook the internal updateMemoryViews so that we
// republish HEAPU8 on `self` after every allocation/grow. Worker code reads
// self.HEAPU8 directly.
updateMemoryViews = (_super => {
    return () => {
        _super()
        self.wasmMemory = wasmMemory
        self.HEAPU8 = new Uint8Array(wasmMemory.buffer)
    }
})(updateMemoryViews)
