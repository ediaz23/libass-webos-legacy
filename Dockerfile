# 4.0.13 -> chrome 55
# 3.1.73 -> chrome 38
FROM emscripten/emsdk:4.0.13

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
