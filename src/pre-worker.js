/* eslint-disable no-unused-vars */
/* global out err updateMemoryViews wasmMemory */

out = text => {
    console.log(text)
}

err = text => {
    console.error(text)
}

updateMemoryViews = (_super => {
    return () => {
        _super()
        self.wasmMemory = wasmMemory
        self.HEAPU8 = new Uint8Array(wasmMemory.buffer)
        self.HEAPU8C = new Uint8ClampedArray(wasmMemory.buffer)
    }
})(updateMemoryViews)

if (WebAssembly && WebAssembly.instantiateStreaming) {
    delete WebAssembly.instantiateStreaming
}
