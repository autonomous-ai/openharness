#ifndef RUNNER_TRAY_H_
#define RUNNER_TRAY_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <windows.h>

#include <functional>
#include <memory>
#include <string>

// Harness in the notification area, on `harness/status_menu` (Windows only).
//
// Its menu shows what HarnessStatusMenu.swift shows: the unread rows (at most
// five), "All caught up" or "Open Harness to get started", the working rows,
// then Open Harness and Quit. Dart owns the rows and what a choice does. This
// side only presents a snapshot and hands the chosen row back.
//  - Dart -> native: `update({entries, workingEntries, workspaceAvailable})`,
//    `quit`.
//  - Native -> Dart: `selected(<row>)`, `openApp`, `hidden`.
class HarnessTray {
 public:
  HarnessTray(flutter::BinaryMessenger* messenger, HWND window,
              std::function<void()> request_quit);
  ~HarnessTray();

  HarnessTray(const HarnessTray&) = delete;
  HarnessTray& operator=(const HarnessTray&) = delete;

  // The tray's own messages on the main window. True when handled.
  bool HandleMessage(UINT message, WPARAM wparam, LPARAM lparam,
                     LRESULT* result);

  // Checks Explorer still has the icon immediately before the close button
  // hides the window. If not, closing must leave through Flutter instead.
  bool installed();

  // The close button just hid the window. Dart shows the one-time notice.
  void OnHidden();

 private:
  void Install();
  void RefreshIcon();
  void Update(const flutter::EncodableMap& state);
  void ShowMenu(int x, int y);
  void ShowApp();
  void Select(const flutter::EncodableValue& row);
  std::wstring Tooltip() const;

  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  HWND window_;
  std::function<void()> request_quit_;
  UINT taskbar_created_;
  HICON icon_ = nullptr;
  bool installed_ = false;
  bool workspace_available_ = false;
  flutter::EncodableList entries_;
  flutter::EncodableList working_;
};

#endif  // RUNNER_TRAY_H_
