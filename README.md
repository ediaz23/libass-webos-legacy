# libass-webos-legacy

A lightweight ASS subtitle rendering pipeline for legacy LG webOS browsers, built around libass with event-driven caching and performance-focused scheduling.

## Build

The project ships **two targets** because webOS spans two very different Chromium versions:

| Target | Chromium | webOS  | Emscripten SDK    |
| ------ | -------- | ------ | ----------------- |
| modern | 68       | 4 / 5+ | `emsdk:4.0.13`    |
| legacy | 38       | 3      | `emsdk:3.1.73`    |

Each target needs a different Emscripten toolchain, so a **separate Docker image** is built for each. The `Dockerfile` accepts an `EMSDK_VERSION` build-arg to select the SDK without editing the file between builds.

### `build.sh`

Everything (Docker image → WASM compile → webpack bundle) is driven by a single script:

```bash
./build.sh [modern|legacy|all] [full|quick]
```

Defaults: `all full`.

| Target   | Effect                                                                     |
| -------- | -------------------------------------------------------------------------- |
| `modern` | Modern target only.                                                        |
| `legacy` | Legacy target only.                                                        |
| `all`    | Both, sequentially.                                                        |

| Mode    | Effect                                                                                        |
| ------- | --------------------------------------------------------------------------------------------- |
| `full`  | Rebuild the Docker image with `--no-cache`, then `make clean-libs && make <target>` + webpack.|
| `quick` | Reuse the existing image (build it if missing), skip `clean-libs`, then `make <target>` + webpack. |

Examples:

```bash
./build.sh                    # both targets, from scratch
./build.sh all quick          # both targets, reuse existing images and C libs
./build.sh modern             # modern only, from scratch
./build.sh legacy quick       # legacy only, incremental
```

Artifacts:

- `build/js/{modern,legacy}/worker.{min,debug}.js` — raw emcc output.
- `dist/{modern,legacy}/` — webpack bundles ready to publish.

### Manual invocation

If you need to bypass the script, the underlying steps are:

```bash
# Modern (Chrome 68)
docker buildx build -t libass-webos-legacy \
    --build-arg EMSDK_VERSION=4.0.13 \
    --no-cache --network=host .
docker run --rm -v "$PWD:/work" libass-webos-legacy \
    bash -lc "make clean-libs && make modern"

# Legacy (Chrome 38)
docker buildx build -t libass-webos-legacy-old \
    --build-arg EMSDK_VERSION=3.1.73 \
    --no-cache --network=host .
docker run --rm -v "$PWD:/work" libass-webos-legacy-old \
    bash -lc "make clean-libs && make legacy"

# JS bundle
npm install
npm run webpack                # or webpack-modern / webpack-legacy
```

`make clean-libs` is needed before switching between targets because the two toolchains produce incompatible object files. Use `make clean` for a full reset (deletes both `build/` and the emitted JS).

## Layout

- `src/` — C++ bindings and JS runtime (`libass.cpp`, `libass.js`, `worker.js`, `LRUCache.js`).
- `lib/` — vendored C dependencies (libass, freetype, harfbuzz, fribidi, brotli).
- `webpack/{common,modern,legacy}/` — bundler configs, one config pair per target.
- `build/` — CMake output (owned by the Docker container).
- `dist/{modern,legacy}/` — final JS bundles produced by webpack.
- `docs/` — design documents.
