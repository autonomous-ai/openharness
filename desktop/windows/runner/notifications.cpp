#include "notifications.h"

#include <flutter/standard_method_codec.h>
#include <windows.h>

#pragma warning(push, 3)
#include <winrt/Windows.Data.Xml.Dom.h>
#include <winrt/Windows.Foundation.h>
#include <winrt/Windows.UI.Notifications.h>
#pragma warning(pop)

#include "utils.h"

namespace {

using winrt::Windows::Data::Xml::Dom::XmlDocument;
using winrt::Windows::UI::Notifications::NotificationSetting;
using winrt::Windows::UI::Notifications::ToastNotification;
using winrt::Windows::UI::Notifications::ToastNotificationManager;

constexpr wchar_t kAppUserModelId[] = L"Autonomous.Harness";
constexpr wchar_t kGroup[] = L"harness";
constexpr wchar_t kBareLink[] = L"harness://notification";
constexpr char kLinkPrefix[] = "harness://notification";

const std::string* StringArgument(const flutter::EncodableMap* arguments,
                                  const char* key) {
  if (arguments == nullptr) {
    return nullptr;
  }
  auto entry = arguments->find(flutter::EncodableValue(key));
  if (entry == arguments->end()) {
    return nullptr;
  }
  return std::get_if<std::string>(&entry->second);
}

// Text for the toast's XML. Control characters an agent's message may carry
// are dropped, because XML 1.0 cannot hold them.
std::wstring EscapeXml(const std::wstring& text) {
  std::wstring escaped;
  escaped.reserve(text.size());
  for (wchar_t c : text) {
    switch (c) {
      case L'&':
        escaped += L"&amp;";
        break;
      case L'<':
        escaped += L"&lt;";
        break;
      case L'>':
        escaped += L"&gt;";
        break;
      case L'"':
        escaped += L"&quot;";
        break;
      case L'\'':
        escaped += L"&apos;";
        break;
      default:
        if (c >= 0x20 || c == L'\t' || c == L'\n' || c == L'\r') {
          escaped += c;
        }
    }
  }
  return escaped;
}

// The click's link as Dart built it, or the bare one, which only opens Harness.
std::wstring LaunchLink(const std::string* launch) {
  const std::string prefix = kLinkPrefix;
  if (launch == nullptr || launch->size() > 240 ||
      launch->compare(0, prefix.size(), prefix) != 0) {
    return kBareLink;
  }
  return Utf16FromUtf8(*launch);
}

}  // namespace

HarnessNotifications::HarnessNotifications(flutter::BinaryMessenger* messenger)
    : channel_(std::make_unique<flutter::MethodChannel<flutter::EncodableValue>>(
          messenger, "harness/notifications",
          &flutter::StandardMethodCodec::GetInstance())) {
  channel_->SetMethodCallHandler([](const auto& call, auto result) {
    const std::string& method = call.method_name();
    const auto* arguments = std::get_if<flutter::EncodableMap>(call.arguments());
    if (method == "authorize") {
      result->Success(flutter::EncodableValue(Authorize()));
      return;
    }
    const std::string* tag = StringArgument(arguments, "tag");
    const bool tag_ok = tag != nullptr && !tag->empty() && tag->size() <= 64;
    if (method == "show") {
      const std::string* title = StringArgument(arguments, "title");
      const std::string* body = StringArgument(arguments, "body");
      if (!tag_ok || title == nullptr || body == nullptr) {
        result->Error("INVALID_NOTIFICATION", "Missing tag, title or body");
        return;
      }
      result->Success(flutter::EncodableValue(
          Show(Utf16FromUtf8(*tag), Utf16FromUtf8(*title),
               Utf16FromUtf8(*body),
               LaunchLink(StringArgument(arguments, "launch")))));
      return;
    }
    if (method == "withdraw") {
      if (tag_ok) {
        Withdraw(Utf16FromUtf8(*tag));
      }
      result->Success();
      return;
    }
    result->NotImplemented();
  });
}

HarnessNotifications::~HarnessNotifications() {
  channel_->SetMethodCallHandler(nullptr);
}

std::string HarnessNotifications::Authorize() {
  try {
    switch (ToastNotificationManager::CreateToastNotifier(kAppUserModelId)
                .Setting()) {
      case NotificationSetting::Enabled:
        return "granted";
      case NotificationSetting::DisabledForApplication:
      case NotificationSetting::DisabledForUser:
      case NotificationSetting::DisabledByGroupPolicy:
        return "denied";
      default:
        return "unavailable";
    }
  } catch (const winrt::hresult_error& error) {
    // Windows can report no setting until the first toast registers this AUMID.
    // Do not stop that first post: Show() will tell us whether it works.
    if (error.code().value == HRESULT_FROM_WIN32(ERROR_NOT_FOUND)) {
      return "unknown";
    }
    return "unavailable";
  } catch (...) {
    return "unavailable";
  }
}

std::string HarnessNotifications::Show(const std::wstring& tag,
                                       const std::wstring& title,
                                       const std::wstring& body,
                                       const std::wstring& launch) {
  const std::string answer = Authorize();
  if (answer == "denied" || answer == "unavailable") {
    return answer;
  }
  try {
    XmlDocument document;
    document.LoadXml(
        L"<toast activationType=\"protocol\" launch=\"" + EscapeXml(launch) +
        L"\"><visual><binding template=\"ToastGeneric\">"
        L"<text hint-maxLines=\"1\">" +
        EscapeXml(title) + L"</text><text>" + EscapeXml(body) +
        L"</text></binding></visual></toast>");
    ToastNotification toast(document);
    // The same tag replaces what is already there: one entry per agent.
    toast.Tag(tag);
    toast.Group(kGroup);
    ToastNotificationManager::CreateToastNotifier(kAppUserModelId).Show(toast);
    return "granted";
  } catch (...) {
    // This one toast, not the channel: "unknown" keeps the next alert trying.
    return "unknown";
  }
}

void HarnessNotifications::Withdraw(const std::wstring& tag) {
  try {
    ToastNotificationManager::History().Remove(tag, kGroup, kAppUserModelId);
  } catch (...) {
    // Already gone, or never shown.
  }
}
