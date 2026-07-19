/* global updateMemoryViews:writable wasmMemory */

/** worker fix */
// eslint-disable-next-line no-unused-vars
function assert(c, m) {
    if (!c) {
        throw m
    }
}

// eslint-disable-next-line no-unused-vars
let asm = null;

// Emscripten does not export the memory views on the Module object by
// default (HEAPU8 stays as a closure-local var). Hook the internal
// updateMemoryViews so worker code can read `self.HEAPU8` regardless.
updateMemoryViews = (_super => {
    return () => {
        _super()
        self.wasmMemory = wasmMemory
        self.HEAPU8 = new Uint8Array(wasmMemory.buffer)
    }
})(updateMemoryViews)

// TV bug
if (WebAssembly && WebAssembly.instantiateStreaming) {
    delete WebAssembly.instantiateStreaming;
}
