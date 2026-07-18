# 4.0.13 -> supports chrome >= 55 (modern target: webOS 4/5, Chromium 68)
# 3.1.50 -> supports chrome >= 55 no generate ??= operator
# 3.1.40 -> supports chrome >= 38 (legacy target: webOS 3,   Chromium 38)
ARG EMSDK_VERSION=4.0.13
FROM emscripten/emsdk:${EMSDK_VERSION}

RUN apt-get update

RUN apt-get install -y --no-install-recommends \
    python3 python3-pip \
    cmake \
    ninja-build \
    pkg-config \
    sudo \
    passwd

RUN rm -rf /var/lib/apt/lists/*

RUN pip3 install -U meson --no-cache-dir

WORKDIR /work

RUN echo 'emscripten:123456' | chpasswd

CMD ["bash"]
