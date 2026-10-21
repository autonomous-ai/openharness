#include <flutter/dart_project.h>
#include <flutter/flutter_view_controller.h>
#include <windows.h>
#include <shobjidl_core.h>

#include <algorithm>
#include <string>
#include <vector>

#include "community_links.h"
#include "flutter_window.h"
#include "single_instance.h"
#include "utils.h"

int APIENTRY wWinMain(_In_ HINSTANCE instance, _In_opt_ HINSTANCE prev,
                      _In_ wchar_t *command_line, _In_ int show_command) {
  // Before any window: the taskbar groups by it, under a pinned shortcut,
  // and toasts post under it.
  ::SetCurrentProcessExplicitAppUserModelID(L"Autonomous.Harness");

  std::vector<std::string> command_line_arguments =
      GetCommandLineArguments();

  // The race fixture and direct callers can quit this user's app. The launcher
  // instead posts the registered quit message to each installed main window.
  if (std::find(command_line_arguments.begin(), command_line_arguments.end(),
                "--quit") != command_line_arguments.end()) {
    return HarnessSingleInstance::NotifyQuit() ? EXIT_SUCCESS : EXIT_FAILURE;
  }

  // One Harness per user: a later launch hands its command line over and
  // exits here, before it has a window of its own.
  HarnessSingleInstance single_instance;
  switch (single_instance.Acquire()) {
    case HarnessSingleInstance::Role::kPrimary:
      break;
    case HarnessSingleInstance::Role::kForwarded:
      return EXIT_SUCCESS;
    case HarnessSingleInstance::Role::kGaveUp:
      return EXIT_FAILURE;
  }

  // Attach to console when present (e.g., 'flutter run') or create a
  // new console when running with a debugger.
  if (!::AttachConsole(ATTACH_PARENT_PROCESS) && ::IsDebuggerPresent()) {
    CreateAndAttachConsole();
  }

  // Initialize COM, so that it is available for use in the library and/or
  // plugins.
  ::CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);

  flutter::DartProject project(L"data");

  // A link on this launch's own command line (a click while Harness was
  // closed) waits for Dart's `ready`.
  HarnessCommunityLinks::Instance().DeliverArguments(command_line_arguments);
  project.set_dart_entrypoint_arguments(std::move(command_line_arguments));

  FlutterWindow window(project);
  Win32Window::Point origin(10, 10);
  Win32Window::Size size(1280, 720);
  if (!window.Create(L"Harness", origin, size)) {
    return EXIT_FAILURE;
  }
  window.SetQuitOnClose(true);

  if (!single_instance.Listen(
      window.GetHandle(),
      [&window](const std::wstring& line) {
        return window.AcceptCommandLine(line);
      },
      [&window]() { window.RequestQuit(); })) {
    return EXIT_FAILURE;
  }

  ::MSG msg;
  while (::GetMessage(&msg, nullptr, 0, 0)) {
    ::TranslateMessage(&msg);
    ::DispatchMessage(&msg);
  }

  ::CoUninitialize();
  return EXIT_SUCCESS;
}
