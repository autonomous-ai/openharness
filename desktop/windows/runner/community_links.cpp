#include "community_links.h"

#include <flutter/standard_method_codec.h>
#include <windows.h>
#include <shellapi.h>

#include <string.h>

#include "utils.h"

namespace {

constexpr size_t kMaxLinkLength = 240;
constexpr size_t kMaxPending = 20;
constexpr char kScheme[] = "harness://";

}  // namespace

HarnessCommunityLinks& HarnessCommunityLinks::Instance() {
  static HarnessCommunityLinks links;
  return links;
}

bool HarnessCommunityLinks::IsHarnessLink(const std::string& value) {
  const size_t scheme = sizeof(kScheme) - 1;
  return value.size() > scheme && value.size() <= kMaxLinkLength &&
         _strnicmp(value.c_str(), kScheme, scheme) == 0;
}

void HarnessCommunityLinks::Attach(flutter::BinaryMessenger* messenger) {
  channel_ = std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
      messenger, "harness/community_links",
      &flutter::StandardMethodCodec::GetInstance());
  channel_->SetMethodCallHandler([this](const auto& call, auto result) {
    if (call.method_name() != "ready") {
      result->NotImplemented();
      return;
    }
    ready_ = true;
    flutter::EncodableList links;
    for (const auto& link : pending_) {
      links.emplace_back(link);
    }
    pending_.clear();
    result->Success(flutter::EncodableValue(std::move(links)));
  });
}

void HarnessCommunityLinks::Detach() {
  if (channel_) {
    channel_->SetMethodCallHandler(nullptr);
  }
  channel_.reset();
  ready_ = false;
}

void HarnessCommunityLinks::Deliver(const std::string& url) {
  if (!IsHarnessLink(url)) {
    return;
  }
  if (ready_ && channel_) {
    channel_->InvokeMethod("open", std::make_unique<flutter::EncodableValue>(url));
  } else if (pending_.size() < kMaxPending) {
    pending_.push_back(url);
  }
}

void HarnessCommunityLinks::DeliverArguments(
    const std::vector<std::string>& arguments) {
  for (const auto& argument : arguments) {
    Deliver(argument);
  }
}

void HarnessCommunityLinks::DeliverCommandLine(
    const std::wstring& command_line) {
  int count = 0;
  wchar_t** argv = ::CommandLineToArgvW(command_line.c_str(), &count);
  if (argv == nullptr) {
    return;
  }
  // argv[0] is the program.
  for (int i = 1; i < count; i++) {
    Deliver(Utf8FromUtf16(argv[i]));
  }
  ::LocalFree(argv);
}
