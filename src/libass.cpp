#include <ass/ass.h>
#include <emscripten.h>
#include <emscripten/bind.h>

extern "C" int libass_dummy() {
    return 0;
}
