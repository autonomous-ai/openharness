#include "fonts.h"

#include <flutter/standard_method_codec.h>

#include <atomic>
#include <map>
#include <string>
#include <system_error>
#include <thread>
#include <utility>

#include "utils.h"

namespace {

// Separate from RequestQuit's 0x4851 timer. Exists only while a job is active.
constexpr UINT_PTR kFontsTimer = 0x4853;
constexpr UINT kFontsPollMs = 50;

struct Family {
  bool mono = false;
  bool symbol = false;
};
using Families = std::map<std::wstring, Family>;

flutter::EncodableValue Encode(const Families& families) {
  flutter::EncodableList list;
  for (const auto& [name, family] : families) {
    list.emplace_back(flutter::EncodableMap{
        {flutter::EncodableValue("family"),
         flutter::EncodableValue(Utf8FromUtf16(name.c_str()))},
        {flutter::EncodableValue("mono"),
         flutter::EncodableValue(family.mono && !family.symbol)},
    });
  }
  return flutter::EncodableValue(std::move(list));
}

}  // namespace

// The worker alone writes families/failed, then publishes them with done's
// release store. The platform thread never locks or waits for enumeration.
struct HarnessFonts::Job {
  std::atomic<bool> cancelled{false};
  std::atomic<bool> done{false};
  Families families;
  bool failed = false;
};

HarnessFonts::HarnessFonts(flutter::BinaryMessenger* messenger, HWND window)
    : window_(window) {
  channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      messenger, "harness/fonts", &flutter::StandardMethodCodec::GetInstance());
}

void HarnessFonts::Start() {
  const std::weak_ptr<HarnessFonts> weak = shared_from_this();
  channel_->SetMethodCallHandler([weak](const auto& call, auto result) {
    const auto fonts = weak.lock();
    if (!fonts || fonts->detached_) {
      return;
    }
    if (call.method_name() != "listFonts") {
      result->NotImplemented();
      return;
    }
    fonts->ListFonts(std::move(result));
  });
}

HarnessFonts::~HarnessFonts() {
  Shutdown();
}

void HarnessFonts::Shutdown() {
  if (detached_) {
    return;
  }
  detached_ = true;
  channel_->SetMethodCallHandler(nullptr);
  channel_.reset();
  if (timer_ != 0) {
    ::KillTimer(window_, timer_);
    timer_ = 0;
  }
  if (job_) {
    job_->cancelled.store(true, std::memory_order_relaxed);
    job_.reset();
  }
  // Keep every unsent reply instance-owned until consumed. Error/Success send
  // directly through Flutter's response API; neither pumps a Win32 message loop.
  while (!pending_.empty()) {
    auto result = std::move(pending_.front());
    pending_.pop_front();
    result->Error("CANCELLED", "font enumeration cancelled");
    result.reset();
  }
}

void HarnessFonts::ListFonts(Reply result) {
  if (job_) {
    pending_.push_back(std::move(result));
    return;
  }
  timer_ = ::SetTimer(window_, kFontsTimer, kFontsPollMs, nullptr);
  if (timer_ == 0) {
    result->Error("UNAVAILABLE", "could not schedule font enumeration");
    return;
  }
  job_ = std::make_shared<Job>();
  pending_.push_back(std::move(result));
  try {
    // No HWND, owner, channel or reply is captured by the worker.
    std::thread([job = job_]() { Enumerate(job); }).detach();
  } catch (const std::system_error&) {
    ::KillTimer(window_, timer_);
    timer_ = 0;
    job_.reset();
    auto answer = std::move(pending_.front());
    pending_.pop_front();
    answer->Error("UNAVAILABLE", "could not start font enumeration");
  }
}

void HarnessFonts::Enumerate(const std::shared_ptr<Job>& job) {
  HDC dc = ::GetDC(nullptr);
  if (dc == nullptr) {
    job->failed = true;
  } else {
    LOGFONTW query = {};
    query.lfCharSet = DEFAULT_CHARSET;
    ::EnumFontFamiliesExW(
        dc, &query,
        [](const LOGFONTW* font, const TEXTMETRICW*, DWORD type,
           LPARAM param) -> int {
          auto* enumeration = reinterpret_cast<Job*>(param);
          if (enumeration->cancelled.load(std::memory_order_relaxed)) {
            return 0;
          }
          // Flutter cannot draw bitmap (.fon) faces. @ is vertical CJK;
          // dotted families are hidden, as on the other desktop runners.
          const wchar_t first = font->lfFaceName[0];
          if ((type & RASTER_FONTTYPE) != 0 || first == L'\0' ||
              first == L'@' || first == L'.') {
            return 1;
          }
          Family& family = enumeration->families[font->lfFaceName];
          family.symbol = family.symbol || font->lfCharSet == SYMBOL_CHARSET;
          family.mono =
              family.mono || (font->lfPitchAndFamily & 0x3) == FIXED_PITCH;
          return 1;
        },
        reinterpret_cast<LPARAM>(job.get()), 0);
    ::ReleaseDC(nullptr, dc);
  }
  job->done.store(true, std::memory_order_release);
}

bool HarnessFonts::HandleMessage(UINT message, WPARAM wparam) {
  if (message != WM_TIMER || timer_ == 0 || wparam != timer_) {
    return false;
  }
  if (!job_ || !job_->done.load(std::memory_order_acquire)) {
    return true;
  }
  const auto job = std::move(job_);
  ::KillTimer(window_, timer_);
  timer_ = 0;
  const auto answer = Encode(job->families);
  const size_t count = pending_.size();
  for (size_t i = 0; i < count && !detached_; i++) {
    auto result = std::move(pending_.front());
    pending_.pop_front();
    if (job->failed) {
      result->Error("UNAVAILABLE", "could not enumerate installed fonts");
    } else {
      result->Success(answer);
    }
    result.reset();
  }
  return true;
}
