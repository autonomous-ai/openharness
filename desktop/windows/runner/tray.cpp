#include "tray.h"

#include <flutter/standard_method_codec.h>
#include <shellapi.h>
#include <windowsx.h>

#include <algorithm>
#include <cstdint>
#include <utility>

#include "resource.h"
#include "single_instance.h"
#include "utils.h"

namespace {

constexpr UINT kTrayCallbackMessage = WM_APP + 0x52;
constexpr UINT kTrayIconId = 1;
constexpr UINT kEntryCommand = 1000;
constexpr UINT kWorkingCommand = 2000;
constexpr UINT kOpenCommand = 1;
constexpr UINT kQuitCommand = 2;
constexpr size_t kMaxEntries = 5;

const flutter::EncodableValue* Field(const flutter::EncodableMap& map,
                                     const char* key) {
  auto entry = map.find(flutter::EncodableValue(key));
  return entry == map.end() ? nullptr : &entry->second;
}

std::string StringField(const flutter::EncodableMap& map, const char* key) {
  const auto* value = Field(map, key);
  const auto* text = value == nullptr ? nullptr : std::get_if<std::string>(value);
  return text == nullptr ? std::string() : *text;
}

bool BoolField(const flutter::EncodableMap& map, const char* key) {
  const auto* value = Field(map, key);
  const auto* flag = value == nullptr ? nullptr : std::get_if<bool>(value);
  return flag != nullptr && *flag;
}

// Milliseconds since the epoch. Dart sends a small int as int32 and a large
// one as int64.
int64_t TimeField(const flutter::EncodableMap& map, const char* key) {
  const auto* value = Field(map, key);
  if (value == nullptr) {
    return 0;
  }
  if (const auto* wide = std::get_if<int64_t>(value)) {
    return *wide;
  }
  if (const auto* narrow = std::get_if<int32_t>(value)) {
    return *narrow;
  }
  return 0;
}

const flutter::EncodableList* ListField(const flutter::EncodableMap& map,
                                        const char* key) {
  const auto* value = Field(map, key);
  return value == nullptr ? nullptr : std::get_if<flutter::EncodableList>(value);
}

// "now", "42s", "5m", "3h", "2d": HarnessStatusMenuRow.refreshTime's labels.
std::wstring Age(int64_t stamp_ms, bool unread) {
  if (stamp_ms <= 0) {
    return std::wstring();
  }
  FILETIME file_time;
  ::GetSystemTimeAsFileTime(&file_time);
  ULARGE_INTEGER now;
  now.LowPart = file_time.dwLowDateTime;
  now.HighPart = file_time.dwHighDateTime;
  // FILETIME counts 100 ns from 1601; the Unix epoch is 11644473600 s later.
  const int64_t now_ms =
      static_cast<int64_t>(now.QuadPart / 10000ULL) - 11644473600000LL;
  const int64_t age = std::max<int64_t>(0, (now_ms - stamp_ms) / 1000);
  if (age < 60) {
    return unread ? std::wstring(L"now") : std::to_wstring(age) + L"s";
  }
  if (age < 3600) {
    return std::to_wstring(age / 60) + L"m";
  }
  if (age < 86400) {
    return std::to_wstring(age / 3600) + L"h";
  }
  return std::to_wstring(age / 86400) + L"d";
}

// One line, at most 60 characters, with no `&` read as a mnemonic.
std::wstring MenuText(const std::string& utf8) {
  std::wstring text = Utf16FromUtf8(utf8);
  for (auto& c : text) {
    if (c == L'\r' || c == L'\n' || c == L'\t') {
      c = L' ';
    }
  }
  if (text.size() > 60) {
    size_t cut = 59;
    // Never split a surrogate pair.
    if (text[cut - 1] >= 0xD800 && text[cut - 1] <= 0xDBFF) {
      cut--;
    }
    text = text.substr(0, cut) + L"…";
  }
  std::wstring escaped;
  escaped.reserve(text.size());
  for (wchar_t c : text) {
    if (c == L'&') {
      escaped += L'&';
    }
    escaped += c;
  }
  return escaped;
}

void AppendRow(HMENU menu, UINT_PTR command, const flutter::EncodableValue& row,
               bool unread) {
  const auto* entry = std::get_if<flutter::EncodableMap>(&row);
  if (entry == nullptr) {
    return;
  }
  std::string title = StringField(*entry, "title");
  if (title.empty()) {
    title = "Unavailable harness";
  }
  std::wstring label = MenuText(title);
  const std::wstring age =
      Age(TimeField(*entry, unread ? "receivedAt" : "startedAt"), unread);
  if (!age.empty()) {
    label += L"\t" + age;
  }
  const auto* unavailable = Field(*entry, "unavailable");
  const bool greyed =
      unavailable != nullptr && std::get_if<std::string>(unavailable) != nullptr;
  const UINT flags = greyed ? (MF_STRING | MF_GRAYED) : MF_STRING;
  ::AppendMenuW(menu, flags, command, label.c_str());
}

void AppendHeading(HMENU menu, const std::wstring& text) {
  ::AppendMenuW(menu, MF_STRING | MF_GRAYED, 0, text.c_str());
}

}  // namespace

HarnessTray::HarnessTray(flutter::BinaryMessenger* messenger, HWND window,
                         std::function<void()> request_quit)
    : window_(window),
      request_quit_(std::move(request_quit)),
      taskbar_created_(::RegisterWindowMessageW(L"TaskbarCreated")) {
  icon_ = static_cast<HICON>(::LoadImageW(
      ::GetModuleHandleW(nullptr), MAKEINTRESOURCEW(IDI_APP_ICON), IMAGE_ICON,
      ::GetSystemMetrics(SM_CXSMICON), ::GetSystemMetrics(SM_CYSMICON),
      LR_DEFAULTCOLOR));
  channel_ = std::make_shared<flutter::MethodChannel<flutter::EncodableValue>>(
      messenger, "harness/status_menu",
      &flutter::StandardMethodCodec::GetInstance());
}

void HarnessTray::Start() {
  if (quitting_) {
    return;
  }
  const std::weak_ptr<HarnessTray> weak = shared_from_this();
  channel_->SetMethodCallHandler([weak](const auto& call, auto result) {
    const auto tray = weak.lock();
    if (!tray || tray->detached_) {
      // Shutdown already retired the messenger: do not send a late response.
      return;
    }
    if (call.method_name() == "update") {
      const auto* state = std::get_if<flutter::EncodableMap>(call.arguments());
      const bool update = state != nullptr && !tray->quitting_;
      if (update) {
        tray->Update(*state);
      }
      // Payload mutation is pure. Finish the reply before icon recovery can
      // reveal the window and reenter OnDestroy through native activation.
      result->Success();
      result.reset();
      if (update && !tray->quitting_) {
        tray->RefreshIcon();
      }
      return;
    }
    if (call.method_name() == "quit") {
      // RequestQuit can synchronously destroy the window and clear this field.
      const auto request_quit = tray->request_quit_;
      result->Success();
      result.reset();
      if (!tray->quitting_ && request_quit) {
        request_quit();
      }
      return;
    }
    result->NotImplemented();
  });
  Install();
}

HarnessTray::~HarnessTray() {
  Shutdown();
}

void HarnessTray::BeginQuit() {
  if (quitting_) {
    return;
  }
  quitting_ = true;
  if (menu_active_) {
    // TrackPopupMenuEx owns the HMENU until its nested loop returns.
    ::EndMenu();
  }
}

void HarnessTray::Shutdown() {
  if (detached_) {
    return;
  }
  detached_ = true;
  BeginQuit();
  const auto channel = std::move(channel_);
  if (channel) {
    channel->SetMethodCallHandler(nullptr);
  }
  const HWND window = std::exchange(window_, nullptr);
  if (std::exchange(installed_, false)) {
    NOTIFYICONDATAW data = {};
    data.cbSize = sizeof(data);
    data.hWnd = window;
    data.uID = kTrayIconId;
    ::Shell_NotifyIconW(NIM_DELETE, &data);
  }
  if (const HICON icon = std::exchange(icon_, nullptr)) {
    ::DestroyIcon(icon);
  }
  request_quit_ = {};
}

std::wstring HarnessTray::Tooltip() const {
  return workspace_available_
             ? L"Harness · " + std::to_wstring(entries_.size()) + L" unread"
             : std::wstring(L"Harness");
}

void HarnessTray::Install() {
  if (quitting_) {
    return;
  }
  NOTIFYICONDATAW data = {};
  data.cbSize = sizeof(data);
  data.hWnd = window_;
  data.uID = kTrayIconId;
  data.uFlags = NIF_ICON | NIF_MESSAGE | NIF_TIP | NIF_SHOWTIP;
  data.uCallbackMessage = kTrayCallbackMessage;
  data.hIcon = icon_;
  wcsncpy_s(data.szTip, Tooltip().c_str(), _TRUNCATE);
  installed_ = icon_ != nullptr && ::Shell_NotifyIconW(NIM_ADD, &data) != FALSE;
  if (installed_) {
    data.uVersion = NOTIFYICON_VERSION_4;
    if (!::Shell_NotifyIconW(NIM_SETVERSION, &data)) {
      // Without version 4 the callback has a different shape, so this icon
      // cannot reliably bring the window back. Remove the partial install.
      ::Shell_NotifyIconW(NIM_DELETE, &data);
      installed_ = false;
    }
  }
  if (!installed_ && !::IsWindowVisible(window_)) {
    HarnessSingleInstance::BringToFront(window_);
  }
}

void HarnessTray::Update(const flutter::EncodableMap& state) {
  workspace_available_ = BoolField(state, "workspaceAvailable");
  entries_.clear();
  if (const auto* rows = ListField(state, "entries")) {
    for (const auto& row : *rows) {
      const auto* entry = std::get_if<flutter::EncodableMap>(&row);
      if (entry != nullptr && BoolField(*entry, "unread")) {
        entries_.push_back(row);
      }
    }
  }
  working_.clear();
  if (workspace_available_) {
    if (const auto* rows = ListField(state, "workingEntries")) {
      working_ = *rows;
    }
  }
}

bool HarnessTray::installed() {
  RefreshIcon();
  return !quitting_ && installed_;
}

void HarnessTray::RefreshIcon() {
  if (!quitting_ && installed_) {
    NOTIFYICONDATAW data = {};
    data.cbSize = sizeof(data);
    data.hWnd = window_;
    data.uID = kTrayIconId;
    data.uFlags = NIF_TIP | NIF_SHOWTIP;
    wcsncpy_s(data.szTip, Tooltip().c_str(), _TRUNCATE);
    if (!::Shell_NotifyIconW(NIM_MODIFY, &data)) {
      // Explorer may have gone away before TaskbarCreated reaches us.
      installed_ = false;
      ::Shell_NotifyIconW(NIM_DELETE, &data);
      if (!::IsWindowVisible(window_)) {
        HarnessSingleInstance::BringToFront(window_);
      }
    }
  }
}

bool HarnessTray::HandleMessage(UINT message, WPARAM wparam, LPARAM lparam,
                                LRESULT* result) {
  if (quitting_) {
    return false;
  }
  if (taskbar_created_ != 0 && message == taskbar_created_) {
    // Explorer restarted and forgot every icon.
    installed_ = false;
    Install();
    *result = 0;
    return true;
  }
  if (message != kTrayCallbackMessage) {
    return false;
  }
  switch (LOWORD(lparam)) {
    case NIN_SELECT:
    case NIN_KEYSELECT:
      ShowApp();
      break;
    case WM_CONTEXTMENU:
      ShowMenu(GET_X_LPARAM(wparam), GET_Y_LPARAM(wparam));
      break;
    default:
      break;
  }
  *result = 0;
  return true;
}

void HarnessTray::ShowMenu(int x, int y) {
  if (quitting_ || menu_active_) {
    return;
  }
  // The rows as they are now. A choice answers with this snapshot's row, and
  // Dart checks that it is still current (statusMenuReceiptIsCurrent).
  const flutter::EncodableList entries = entries_;
  const flutter::EncodableList working = working_;
  HMENU menu = ::CreatePopupMenu();
  if (menu == nullptr) {
    return;
  }
  if (entries.empty()) {
    AppendHeading(menu, workspace_available_ ? L"All caught up"
                                             : L"Open Harness to get started");
  } else {
    AppendHeading(menu, L"Ready (" + std::to_wstring(entries.size()) + L")");
    for (size_t i = 0; i < entries.size() && i < kMaxEntries; i++) {
      AppendRow(menu, static_cast<UINT_PTR>(kEntryCommand + i), entries[i], true);
    }
    if (entries.size() > kMaxEntries) {
      AppendHeading(menu, std::to_wstring(entries.size() - kMaxEntries) + L" more");
    }
  }
  if (workspace_available_ && !working.empty()) {
    ::AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
    AppendHeading(menu, L"Working (" + std::to_wstring(working.size()) + L")");
    for (size_t i = 0; i < working.size(); i++) {
      AppendRow(menu, static_cast<UINT_PTR>(kWorkingCommand + i), working[i],
                false);
    }
  }
  ::AppendMenuW(menu, MF_SEPARATOR, 0, nullptr);
  ::AppendMenuW(menu, MF_STRING, kOpenCommand, L"Open Harness");
  ::AppendMenuW(menu, MF_STRING, kQuitCommand, L"Quit");
  ::SetMenuDefaultItem(menu, kOpenCommand, FALSE);
  // A tray menu closes on a click elsewhere only if its owner is in front.
  ::SetForegroundWindow(window_);
  if (quitting_) {
    ::DestroyMenu(menu);
    return;
  }
  const UINT align = ::GetSystemMetrics(SM_MENUDROPALIGNMENT) != 0
                         ? TPM_RIGHTALIGN
                         : TPM_LEFTALIGN;
  menu_active_ = true;
  const UINT command = static_cast<UINT>(::TrackPopupMenuEx(
      menu, TPM_RETURNCMD | TPM_NONOTIFY | TPM_RIGHTBUTTON | TPM_BOTTOMALIGN |
                align,
      x, y, window_, nullptr));
  menu_active_ = false;
  ::DestroyMenu(menu);
  // OnDestroy may already have detached the channel and cleared the HWND.
  // The dispatch's lease keeps only this inert receiver alive until return.
  if (quitting_) {
    return;
  }
  ::PostMessageW(window_, WM_NULL, 0, 0);
  if (command == kOpenCommand) {
    ShowApp();
  } else if (command == kQuitCommand) {
    const auto request_quit = request_quit_;
    if (request_quit) {
      request_quit();
    }
  } else if (command >= kEntryCommand &&
             static_cast<size_t>(command - kEntryCommand) <
                 std::min(entries.size(), kMaxEntries)) {
    Select(entries[command - kEntryCommand]);
  } else if (command >= kWorkingCommand &&
             static_cast<size_t>(command - kWorkingCommand) < working.size()) {
    Select(working[command - kWorkingCommand]);
  }
}

void HarnessTray::ShowApp() {
  if (quitting_) {
    return;
  }
  HarnessSingleInstance::BringToFront(window_);
  if (quitting_) {
    return;
  }
  const auto channel = channel_;
  if (channel) {
    channel->InvokeMethod("openApp", nullptr);
  }
}

void HarnessTray::Select(const flutter::EncodableValue& row) {
  // Dart opens the destination, then reveals the window: activating the tab
  // shown before cannot acknowledge the wrong notification.
  if (quitting_) {
    return;
  }
  const auto channel = channel_;
  if (channel) {
    channel->InvokeMethod("selected",
                          std::make_unique<flutter::EncodableValue>(row));
  }
}

void HarnessTray::OnHidden() {
  if (quitting_) {
    return;
  }
  const auto channel = channel_;
  if (channel) {
    channel->InvokeMethod("hidden", nullptr);
  }
}
