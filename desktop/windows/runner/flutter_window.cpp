#include "flutter_window.h"

#include <optional>
#include <utility>

#include "flutter/generated_plugin_registrant.h"
#include "community_links.h"
#include "single_instance.h"

namespace {

// RequestQuit's deadline for Flutter's exit request.
constexpr UINT_PTR kQuitTimer = 0x4851;
constexpr UINT kQuitTimeoutMs = 5000;

}  // namespace

FlutterWindow::FlutterWindow(const flutter::DartProject& project)
    : project_(project) {}

FlutterWindow::~FlutterWindow() {}

void FlutterWindow::RequestQuit() {
  if (quitting_) {
    return;
  }
  quitting_ = true;
  const auto tray = tray_;
  if (tray) {
    tray->BeginQuit();
  }
  HWND window = GetHandle();
  if (window == nullptr) {
    ::PostQuitMessage(0);
    return;
  }
  if (::SetTimer(window, kQuitTimer, kQuitTimeoutMs, nullptr) == 0 ||
      !::PostMessageW(window, WM_CLOSE, 0, 0)) {
    ::DestroyWindow(window);
  }
}

bool FlutterWindow::AcceptCommandLine(const std::wstring& command_line) {
  if (quitting_) {
    return false;
  }
  HarnessCommunityLinks::Instance().DeliverCommandLine(command_line);
  return true;
}

bool FlutterWindow::OnCreate() {
  if (!Win32Window::OnCreate()) {
    return false;
  }

  RECT frame = GetClientArea();

  // The size here must match the window dimensions to avoid unnecessary surface
  // creation / destruction in the startup path.
  flutter_controller_ = std::make_unique<flutter::FlutterViewController>(
      frame.right - frame.left, frame.bottom - frame.top, project_);
  // Ensure that basic setup of the controller was successful.
  if (!flutter_controller_->engine() || !flutter_controller_->view()) {
    return false;
  }
  RegisterPlugins(flutter_controller_->engine());
  flutter::BinaryMessenger* messenger =
      flutter_controller_->engine()->messenger();
  HarnessCommunityLinks::Instance().Attach(messenger);
  notifications_ = std::make_unique<HarnessNotifications>(messenger);
  const auto tray = std::make_shared<HarnessTray>(
      messenger, GetHandle(), [this]() { RequestQuit(); });
  tray_ = tray;
  tray->Start();
  // Failed icon installation can reveal the window and reenter destruction.
  if (!flutter_controller_) {
    return false;
  }
  clipboard_image_ =
      std::make_unique<HarnessClipboardImage>(messenger, GetHandle());
  fonts_ = std::make_shared<HarnessFonts>(messenger, GetHandle());
  fonts_->Start();
  SetChildContent(flutter_controller_->view()->GetNativeWindow());

  flutter_controller_->engine()->SetNextFrameCallback([&]() {
    this->Show();
  });

  // Flutter can complete the first frame before the "show window" callback is
  // registered. The following call ensures a frame is pending to ensure the
  // window is shown. It is a no-op if the first frame hasn't completed yet.
  flutter_controller_->ForceRedraw();

  return true;
}

void FlutterWindow::OnDestroy() {
  // A popup or channel callback may retain the native receiver until unwind;
  // detach its messenger now, before destroying the Flutter engine.
  const auto tray = std::move(tray_);
  if (tray) {
    tray->Shutdown();
  }
  const auto fonts = std::move(fonts_);
  if (fonts) {
    fonts->Shutdown();
  }
  clipboard_image_ = nullptr;
  // Every feature's channel goes before the engine its messenger belongs to.
  HarnessCommunityLinks::Instance().Detach();
  notifications_ = nullptr;
  if (flutter_controller_) {
    flutter_controller_ = nullptr;
  }

  Win32Window::OnDestroy();
}

LRESULT
FlutterWindow::MessageHandler(HWND hwnd, UINT const message,
                              WPARAM const wparam,
                              LPARAM const lparam) noexcept {
  // WM_HARNESS_QUIT (single_instance.h): Harness.exe asks the app to quit
  // through its main window, before an uninstall or an install over it.
  if (IsHarnessQuitMessage(message)) {
    RequestQuit();
    return 0;
  }

  // TrackPopupMenuEx can dispatch WM_DESTROY in a nested message loop.
  // Lease the receiver through the entire call, even if OnDestroy clears tray_.
  const auto tray = tray_;
  if (tray) {
    LRESULT tray_result = 0;
    if (tray->HandleMessage(message, wparam, lparam, &tray_result)) {
      return tray_result;
    }
  }

  // Decide before Flutter and window_manager see WM_CLOSE. A real Quit has
  // already set quitting_, so Flutter still saves the layout on its exit path.
  // Without a usable tray, closing must never leave an inaccessible window.
  if (message == WM_CLOSE && !quitting_ && tray && tray->installed()) {
    ::ShowWindow(hwnd, SW_HIDE);
    tray->OnHidden();
    return 0;
  }

  // The availability check's recovery may have reentered OnDestroy.
  if (GetHandle() == nullptr) {
    return 0;
  }

  const auto fonts = fonts_;
  if (fonts && fonts->HandleMessage(message, wparam)) {
    return 0;
  }

  if (message == WM_TIMER && wparam == kQuitTimer) {
    // Flutter did not finish its exit in time: leave without it.
    ::KillTimer(hwnd, kQuitTimer);
    ::DestroyWindow(hwnd);
    return 0;
  }

  // Give Flutter, including plugins, an opportunity to handle window messages.
  if (flutter_controller_) {
    std::optional<LRESULT> result =
        flutter_controller_->HandleTopLevelWindowProc(hwnd, message, wparam,
                                                      lparam);
    if (result) {
      return *result;
    }
  }

  switch (message) {
    case WM_FONTCHANGE:
      flutter_controller_->engine()->ReloadSystemFonts();
      break;
  }

  return Win32Window::MessageHandler(hwnd, message, wparam, lparam);
}
