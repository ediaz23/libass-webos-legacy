#include <ass/ass.h>
#include <emscripten/bind.h>

#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <string>

struct RenderResult {
    int x = 0;
    int y = 0;
    int w = 0;
    int h = 0;
    int stride = 0;
    uint32_t color = 0;
    uintptr_t image = 0;
    RenderResult* next = nullptr;
};

static RenderResult* getNext(RenderResult& r) {
    return r.next;
}

static uintptr_t getImage(RenderResult& r) {
    return r.image;
}

class LibassBridge {
public:
    LibassBridge(int width, int height, std::string defaultFont, bool useMargins)
        : library_(nullptr),
          renderer_(nullptr),
          track_(nullptr),
          renderHead_(nullptr),
          width_(width),
          height_(height),
          lastChange_(0) {
        library_ = ass_library_init();
        if (!library_) return;

        renderer_ = ass_renderer_init(library_);
        if (!renderer_) return;

        ass_set_frame_size(renderer_, width_, height_);
        ass_set_storage_size(renderer_, width_, height_);
        ass_set_use_margins(renderer_, useMargins ? 1 : 0);

        const char* font = defaultFont.empty() ? nullptr : defaultFont.c_str();
        ass_set_fonts(renderer_, font, "sans-serif", 1, nullptr, 1);
    }

    ~LibassBridge() {
        quitLibrary();
    }

    bool isReady() const {
        return library_ != nullptr && renderer_ != nullptr;
    }

    bool createTrackMem(const std::string& assText) {
        removeTrack();

        if (!library_) return false;
        if (assText.empty()) return false;

        track_ = ass_read_memory(
            library_,
            const_cast<char*>(assText.data()),
            static_cast<size_t>(assText.size()),
            nullptr
        );

        return track_ != nullptr;
    }

    void removeTrack() {
        clearRenderResult();

        if (track_) {
            ass_free_track(track_);
            track_ = nullptr;
        }
    }

    void resizeCanvas(int width, int height) {
        width_ = width;
        height_ = height;

        if (renderer_) {
            ass_set_frame_size(renderer_, width_, height_);
            ass_set_storage_size(renderer_, width_, height_);
        }
    }

    void setStorageSize(int width, int height) {
        if (renderer_) {
            ass_set_storage_size(renderer_, width, height);
        }
    }

    void setMargin(int top, int bottom, int left, int right) {
        if (renderer_) {
            ass_set_margins(renderer_, top, bottom, left, right);
            ass_set_use_margins(renderer_, 1);
        }
    }

    void setDefaultFont(const std::string& defaultFont) {
        if (!renderer_) return;

        const char* font = defaultFont.empty() ? nullptr : defaultFont.c_str();
        ass_set_fonts(renderer_, font, "sans-serif", 1, nullptr, 1);
    }

    bool addFont(const std::string& name, uintptr_t dataPtr, int dataSize) {
        if (!library_ || dataPtr == 0 || dataSize <= 0) return false;

        ass_add_font(
            library_,
            name.c_str(),
            reinterpret_cast<char*>(dataPtr),
            dataSize
        );

        return true;
    }

    void reloadFonts() {
        if (renderer_) {
            ass_fonts_update(renderer_);
        }
    }

    int getEventCount() const {
        return track_ ? track_->n_events : 0;
    }

    int allocEvent() {
        return ass_alloc_event(track);
    }

    void removeEvent(int eid) {
        ass_free_event(track, eid);
    }
    
    int getStyleCount() const {
        return track_ ? track_->n_styles : 0;
    }

    int allocStyle() {
        return ass_alloc_style(track);
    }

    void removeStyle(int sid) {
        ass_free_event(track, sid);
    }

    void removeAllEvents() {
        ass_flush_events(track);
    }

    void setMemoryLimits(int glyph_limit, int bitmap_cache_limit) {
        ass_set_cache_limits(ass_renderer, glyph_limit, bitmap_cache_limit);
    }
    
    int getLastChange() const {
        return lastChange_;
    }

    ASS_Event* getEvent(int index) {
        if (!track_ || index < 0 || index >= track_->n_events) return nullptr;
        return &track_->events[index];
    }

    ASS_Style* getStyle(int index) {
        if (!track_ || index < 0 || index >= track_->n_styles) return nullptr;
        return &track_->styles[index];
    }
    
    void setStyleOverride(ASS_Style* style) {
        if (!renderer_ || !style) return;

        ass_set_selective_style_override_enabled(
            renderer_,
            ASS_OVERRIDE_BIT_STYLE | ASS_OVERRIDE_BIT_SELECTIVE_FONT_SCALE
        );
        ass_set_selective_style_override(renderer_, style);
        ass_set_font_scale(renderer_, 0.3);
    }

    void removeStyleOverride() {
        if (!renderer_) return;

        ass_set_selective_style_override_enabled(renderer_, 0);
        ass_set_selective_style_override(renderer_, nullptr);
        ass_set_font_scale(renderer_, 1.0);
    }
    
    RenderResult* renderImage(long long timeMs) {
        clearRenderResult();

        if (!renderer_ || !track_) return nullptr;

        ASS_Image* img = ass_render_frame(renderer_, track_, static_cast<long long>(timeMs), &lastChange_);
        if (!img) return nullptr;

        RenderResult* head = nullptr;
        RenderResult* tail = nullptr;

        for (ASS_Image* cur = img; cur; cur = cur->next) {
            RenderResult* node = new RenderResult();
            node->x = cur->dst_x;
            node->y = cur->dst_y;
            node->w = cur->w;
            node->h = cur->h;
            node->stride = cur->stride;
            node->color = cur->color;

            const size_t bytes = static_cast<size_t>(cur->stride) * static_cast<size_t>(cur->h);
            if (cur->bitmap && bytes > 0) {
                unsigned char* copy = static_cast<unsigned char*>(std::malloc(bytes));
                if (copy) {
                    std::memcpy(copy, cur->bitmap, bytes);
                    node->image = reinterpret_cast<uintptr_t>(copy);
                }
            }

            if (!head) {
                head = node;
                tail = node;
            } else {
                tail->next = node;
                tail = node;
            }
        }

        renderHead_ = head;
        return renderHead_;
    }

    void freeRenderResult(RenderResult* head) {
        RenderResult* cur = head;

        while (cur) {
            RenderResult* next = cur->next;

            if (cur->image) {
                std::free(reinterpret_cast<void*>(cur->image));
                cur->image = 0;
            }

            delete cur;
            cur = next;
        }

        if (head == renderHead_) {
            renderHead_ = nullptr;
        }
    }

    void quitLibrary() {
        clearRenderResult();

        if (track_) {
            ass_free_track(track_);
            track_ = nullptr;
        }

        if (renderer_) {
            ass_renderer_done(renderer_);
            renderer_ = nullptr;
        }

        if (library_) {
            ass_library_done(library_);
            library_ = nullptr;
        }
    }

private:
    void clearRenderResult() {
        if (renderHead_) {
            freeRenderResult(renderHead_);
            renderHead_ = nullptr;
        }
    }

private:
    ASS_Library* library_;
    ASS_Renderer* renderer_;
    ASS_Track* track_;
    RenderResult* renderHead_;
    int width_;
    int height_;
    int lastChange_;
};

static std::string safeStr(const char* s) {
    return s ? std::string(s) : std::string();
}

static void replaceCString(char*& target, const std::string& value) {
    if (target) {
        std::free(target);
        target = nullptr;
    }

    char* copy = static_cast<char*>(std::malloc(value.size() + 1));
    if (!copy) return;

    std::memcpy(copy, value.c_str(), value.size() + 1);
    target = copy;
}

// ===== ASS_Style helpers =====
static std::string getStyleName(const ASS_Style& s) {
    return safeStr(s.Name);
}

static void setStyleName(ASS_Style& s, const std::string& value) {
    replaceCString(s.Name, value);
}

static std::string getFontName(const ASS_Style& s) {
    return safeStr(s.FontName);
}

static void setFontName(ASS_Style& s, const std::string& value) {
    replaceCString(s.FontName, value);
}

// ===== ASS_Event helpers =====
static long long getStart(const ASS_Event& e) {
    return e.Start;
}

static void setStart(ASS_Event& e, long long value) {
    e.Start = static_cast<int>(value);
}

static long long getDuration(const ASS_Event& e) {
    return e.Duration;
}

static void setDuration(ASS_Event& e, long long value) {
    e.Duration = static_cast<int>(value);
}

static std::string getEventName(const ASS_Event& e) {
    return safeStr(e.Name);
}

static void setEventName(ASS_Event& e, const std::string& value) {
    replaceCString(e.Name, value);
}

static std::string getEffect(const ASS_Event& e) {
    return safeStr(e.Effect);
}

static void setEffect(ASS_Event& e, const std::string& value) {
    replaceCString(e.Effect, value);
}

static std::string getText(const ASS_Event& e) {
    return safeStr(e.Text);
}

static void setText(ASS_Event& e, const std::string& value) {
    replaceCString(e.Text, value);
}

EMSCRIPTEN_BINDINGS(LIBASS_BRIDGE) {
    emscripten::class_<RenderResult>("RenderResult")
        .property("x", &RenderResult::x)
        .property("y", &RenderResult::y)
        .property("w", &RenderResult::w)
        .property("h", &RenderResult::h)
        .property("stride", &RenderResult::stride)
        .property("color", &RenderResult::color)
        .property("next", &getNext, emscripten::allow_raw_pointers())
        .property("image", &getImage);

    emscripten::class_<ASS_Style>("ASS_Style")
        .property("Name", &getStyleName, &setStyleName)
        .property("FontName", &getFontName, &setFontName)
        .property("FontSize", &ASS_Style::FontSize)
        .property("PrimaryColour", &ASS_Style::PrimaryColour)
        .property("SecondaryColour", &ASS_Style::SecondaryColour)
        .property("OutlineColour", &ASS_Style::OutlineColour)
        .property("BackColour", &ASS_Style::BackColour)
        .property("Bold", &ASS_Style::Bold)
        .property("Italic", &ASS_Style::Italic)
        .property("Underline", &ASS_Style::Underline)
        .property("StrikeOut", &ASS_Style::StrikeOut)
        .property("ScaleX", &ASS_Style::ScaleX)
        .property("ScaleY", &ASS_Style::ScaleY)
        .property("Spacing", &ASS_Style::Spacing)
        .property("Angle", &ASS_Style::Angle)
        .property("BorderStyle", &ASS_Style::BorderStyle)
        .property("Outline", &ASS_Style::Outline)
        .property("Shadow", &ASS_Style::Shadow)
        .property("Alignment", &ASS_Style::Alignment)
        .property("MarginL", &ASS_Style::MarginL)
        .property("MarginR", &ASS_Style::MarginR)
        .property("MarginV", &ASS_Style::MarginV)
        .property("Encoding", &ASS_Style::Encoding)
        .property("treat_fontname_as_pattern", &ASS_Style::treat_fontname_as_pattern)
        .property("Blur", &ASS_Style::Blur)
        .property("Justify", &ASS_Style::Justify);

    emscripten::class_<ASS_Event>("ASS_Event")
        .property("Start", &getStart, &setStart)
        .property("Duration", &getDuration, &setDuration)
        .property("Name", &getEventName, &setEventName)
        .property("Effect", &getEffect, &setEffect)
        .property("Text", &getText, &setText)
        .property("ReadOrder", &ASS_Event::ReadOrder)
        .property("Layer", &ASS_Event::Layer)
        .property("Style", &ASS_Event::Style)
        .property("MarginL", &ASS_Event::MarginL)
        .property("MarginR", &ASS_Event::MarginR)
        .property("MarginV", &ASS_Event::MarginV);
        
        emscripten::class_<LibassBridge>("LibassBridge")
            .constructor<int, int, std::string, bool>()
            // state and life cicle
            .function("isReady", &LibassBridge::isReady)
            .function("getLastChange", &LibassBridge::getLastChange)
            .function("quitLibrary", &LibassBridge::quitLibrary)
            // fonts
            .function("addFont", &LibassBridge::addFont)
            .function("reloadFonts", &LibassBridge::reloadFonts)
            .function("setDefaultFont", &LibassBridge::setDefaultFont)
            // track / memory
            .function("createTrackMem", &LibassBridge::createTrackMem)
            .function("removeTrack", &LibassBridge::removeTrack)
            .function("setMemoryLimits", &LibassBridge::setMemoryLimits)
            .function("setStorageSize", &LibassBridge::setStorageSize)
            // events
            .function("allocEvent", &LibassBridge::allocEvent)
            .function("getEvent", &LibassBridge::getEvent, emscripten::allow_raw_pointers())
            .function("getEventCount", &LibassBridge::getEventCount)
            .function("removeEvent", &LibassBridge::removeEvent)
            .function("removeAllEvents", &LibassBridge::removeAllEvents)
            // styles
            .function("allocStyle", &LibassBridge::allocStyle)
            .function("getStyle", &LibassBridge::getStyle, emscripten::allow_raw_pointers())
            .function("getStyleCount", &LibassBridge::getStyleCount)
            .function("setStyleOverride", &LibassBridge::setStyleOverride, emscripten::allow_raw_pointers())
            .function("removeStyle", &LibassBridge::removeStyle)
            .function("removeStyleOverride", &LibassBridge::removeStyleOverride)
            // render / canvas
            .function("renderImage", &LibassBridge::renderImage, emscripten::allow_raw_pointers())
            .function("freeRenderResult", &LibassBridge::freeRenderResult, emscripten::allow_raw_pointers())
            .function("resizeCanvas", &LibassBridge::resizeCanvas)
            .function("setMargin", &LibassBridge::setMargin);
        
}
