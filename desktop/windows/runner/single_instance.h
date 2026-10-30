#ifndef RUNNER_SINGLE_INSTANCE_H_
#define RUNNER_SINGLE_INSTANCE_H_

#include <windows.h>

#include <functional>
#include <string>

// WM_HARNESS_QUIT: the registered message that makes the running app quit,
// as the tray's Quit does, hidden to the tray or not. Registered, not a WM_APP
// value, so it means the same in every process and no other program's private
// message can be read as it. `Harness.exe` (pty/src/desktop/win.rs,
// QUIT_MESSAGE) posts it to the main window (class FLUTTER_RUNNER_WIN32_WINDOW)
// of each process running from `<install>\app\*\harness-desktop.exe`;
// `harness-desktop.exe --quit` posts it to the single-instance window. Part of
// the launcher's contract: the name never changes.
constexpr wchar_t kHarnessQuitMessageName[] = L"Autonomous.Harness.Quit";

// The registered WM_HARNESS_QUIT, or 0 when it could not be registered.
UINT HarnessQuitMessage();

// Whether |message| is WM_HARNESS_QUIT. Never true when it is not registered,
// so WM_NULL is never read as a quit.
bool IsHarnessQuitMessage(UINT message);

// COPYDATASTRUCT::dwData of a forwarded command line: "HRNS".
constexpr ULONG_PTR kHarnessCopyDataCommandLine = 0x48524E53;

// One Harness per user and session.
//
// The first launch takes the mutex `Local\Harness-<user SID>` and, once its
// main window exists, creates a message-only window titled with the same name.
// A later launch finds that window, hands it its whole command line with
// WM_COPYDATA and exits. A launch that finds the mutex held but no window yet
// (the first is still starting) looks again every 100 ms, up to a bound. If
// the first exits meanwhile, it takes the mutex and becomes the app itself.
//
// Delivery is at most once. A command line is sent again only when the
// running app refused it (it is quitting) or its window had gone.
class HarnessSingleInstance {
 public:
  enum class Role {
    kPrimary,    // This process is the app.
    kForwarded,  // The running app has this launch's command line: exit.
    kGaveUp,     // The running app never showed its window: exit.
  };

  // Runs on the platform thread for each later launch's command line. False
  // refuses it, and that launch waits to become the app itself.
  using CommandLineHandler = std::function<bool(const std::wstring&)>;

  static constexpr wchar_t kWindowClass[] = L"HarnessSingleInstance";

  HarnessSingleInstance() = default;
  ~HarnessSingleInstance();

  HarnessSingleInstance(const HarnessSingleInstance&) = delete;
  HarnessSingleInstance& operator=(const HarnessSingleInstance&) = delete;

  // Takes the instance, or forwards this launch to the one that has it,
  // waiting up to |wait_ms| for that one to create its window.
  Role Acquire(DWORD wait_ms = 15000);

  // Creates the window later launches find. Call once |main_window| exists.
  bool Listen(HWND main_window, CommandLineHandler on_command_line,
              std::function<void()> on_quit);

  // Asks the running app to quit and waits up to |wait_ms| for it to exit.
  // True when no Harness is left running for this user.
  static bool NotifyQuit(DWORD wait_ms = 10000);

  // `Local\Harness-<SID>`, then `-debug` in a debug build (so `flutter run`
  // never forwards to the installed app), then `-<HARNESS_DESKTOP_INSTANCE>`
  // when that variable is set (tests).
  // Empty if the user identity or test suffix could not be read safely.
  static std::wstring InstanceName();

  // Shows |window| (restored if minimised, shown if hidden to the tray) and
  // puts it in front.
  static void BringToFront(HWND window);

 private:
  enum class Delivery { kAccepted, kRefused, kUnknown };

  static Delivery Forward(HWND target);
  static LRESULT CALLBACK WndProc(HWND window, UINT message, WPARAM wparam,
                                  LPARAM lparam) noexcept;
  LRESULT HandleMessage(UINT message, WPARAM wparam, LPARAM lparam);

  HANDLE mutex_ = nullptr;
  bool owns_mutex_ = false;
  HWND message_window_ = nullptr;
  HWND main_window_ = nullptr;
  CommandLineHandler on_command_line_;
  std::function<void()> on_quit_;
};

#endif  // RUNNER_SINGLE_INSTANCE_H_
