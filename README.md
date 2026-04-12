# libass-webos-legacy
A lightweight ASS subtitle rendering pipeline for legacy LG webOS browsers, built around libass with event-driven caching and performance-focused scheduling.

## Docker

### Build image

```bash
docker buildx build -t libass-webos-legacy . --no-cache --network=host
```

### Compile (DEV)

```bash
docker run --rm -it -v "$PWD:/work" libass-webos-legacy bash -lc "cmake -S . -B build -DPROFILE=dev && cmake --build build -j"
```

### Compile (PROD)

```bash
docker run --rm -it -v "$PWD:/work" libass-webos-legacy bash -lc "cmake -S . -B build -DPROFILE=prod && cmake --build build -j"
```
