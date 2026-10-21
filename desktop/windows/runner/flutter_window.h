#ifndef RUNNER_FLUTTER_WINDOW_H_
#define RUNNER_FLUTTER_WINDOW_H_

#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>

#include <memory>
#include <string>

#include "win32_window.h"
#include "notifications.h"
#include "tray.h"
#include "clipboard_image.h"
#include "fonts.h"

// A window that hosts a Flutter view, and the Harness features the runner
// adds. Each feature's channel is registered in OnCreate.
class FlutterWindow : public Win32Window {
 public:
  // Creates a new FlutterWindow hosting a Flutter view running |project|.
  explicit FlutterWindow(const flutter::DartProject& project);
  virtual ~FlutterWindow();

  // Quits for real: past the close button's hide-to-tray, through Flutter's
  // own exit request (so `didRequestAppExit` saves the layout), and after 5 s
  // without it if Dart never answers.
  void RequestQuit();

  // Whether a quit has begun.
  bool quitting() const { return quitting_; }

  // A later launch's command line, handed over by the single instance. False
  // once quitting, so that launch waits and starts the app afresh.
  bool AcceptCommandLine(const std::wstring& command_line);

 protected:
  // Win32Window:
  bool OnCreate() override;
  void OnDestroy() override;
  LRESULT MessageHandler(HWND window, UINT const message, WPARAM const wparam,
                         LPARAM const lparam) noexcept override;

 private:
  // The project to run.
  flutter::DartProject project_;

  // The Flutter instance hosted by this window.
  std::unique_ptr<flutter::FlutterViewController> flutter_controller_;
  std::unique_ptr<HarnessNotifications> notifications_;
  std::shared_ptr<HarnessTray> tray_;
  std::unique_ptr<HarnessClipboardImage> clipboard_image_;
  std::shared_ptr<HarnessFonts> fonts_;

  bool quitting_ = false;
};

#endif  // RUNNER_FLUTTER_WINDOW_H_
