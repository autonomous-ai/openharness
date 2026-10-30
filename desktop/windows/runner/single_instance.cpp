#include "single_instance.h"

#include <sddl.h>

#include <cwchar>
#include <memory>
#include <utility>

namespace {

// The largest command line Windows passes, in bytes, with its terminator.
constexpr DWORD kMaxCommandLineBytes = 32768 * sizeof(wchar_t);

// The user's SID as text ("S-1-5-21-..."), or empty when the token cannot be
// read.
std::wstring CurrentUserSid() {
  HANDLE token = nullptr;
  if (!::OpenProcessToken(::GetCurrentProcess(), TOKEN_QUERY, &token)) {
    return std::wstring();
  }
  std::wstring sid;
  DWORD size = 0;
  ::GetTokenInformation(token, TokenUser, nullptr, 0, &size);
  if (size > 0) {
    auto buffer = std::make_unique<BYTE[]>(size);
    if (::GetTokenInformation(token, TokenUser, buffer.get(), size, &size)) {
      auto* user = reinterpret_cast<TOKEN_USER*>(buffer.get());
      wchar_t* text = nullptr;
      if (::ConvertSidToStringSidW(user->User.Sid, &text)) {
        sid = text;
        ::LocalFree(text);
      }
    }
  }
  ::CloseHandle(token);
  return sid;
}

}  // namespace

UINT HarnessQuitMessage() {
  static const UINT message = ::RegisterWindowMessageW(kHarnessQuitMessageName);
  return message;
}

bool IsHarnessQuitMessage(UINT message) {
  const UINT quit = HarnessQuitMessage();
  return quit != 0 && message == quit;
}

HarnessSingleInstance::~HarnessSingleInstance() {
  if (message_window_ != nullptr) {
    ::DestroyWindow(message_window_);
  }
  if (mutex_ != nullptr) {
    if (owns_mutex_) {
      ::ReleaseMutex(mutex_);
    }
    ::CloseHandle(mutex_);
  }
}

std::wstring HarnessSingleInstance::InstanceName() {
  const std::wstring sid = CurrentUserSid();
  if (sid.empty()) {
    return std::wstring();
  }
  std::wstring name = L"Local\\Harness-" + sid;
#ifdef _DEBUG
  name += L"-debug";
#endif
  const DWORD size =
      ::GetEnvironmentVariableW(L"HARNESS_DESKTOP_INSTANCE", nullptr, 0);
  if (size > 0) {
    std::wstring suffix(size, L'\0');
    const DWORD length = ::GetEnvironmentVariableW(
        L"HARNESS_DESKTOP_INSTANCE", suffix.data(), size);
    if (length == 0 || length >= size) {
      return std::wstring();
    }
    suffix.resize(length);
    name += L"-" + suffix;
  }
  return name;
}

HarnessSingleInstance::Role HarnessSingleInstance::Acquire(DWORD wait_ms) {
  const std::wstring name = InstanceName();
  if (name.empty()) {
    return Role::kGaveUp;
  }
  mutex_ = ::CreateMutexW(nullptr, TRUE, name.c_str());
  if (mutex_ == nullptr) {
    // Never start an uncoordinated second app if isolation cannot be set up.
    return Role::kGaveUp;
  }
  if (::GetLastError() != ERROR_ALREADY_EXISTS) {
    owns_mutex_ = true;
    return Role::kPrimary;
  }
  const ULONGLONG deadline = ::GetTickCount64() + wait_ms;
  for (;;) {
    HWND target =
        ::FindWindowExW(HWND_MESSAGE, nullptr, kWindowClass, name.c_str());
    if (target != nullptr && Forward(target) != Delivery::kRefused) {
      return Role::kForwarded;
    }
    // Still starting, or quitting. If it exits, its mutex is this launch's.
    const DWORD wait = ::WaitForSingleObject(mutex_, 100);
    if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) {
      owns_mutex_ = true;
      return Role::kPrimary;
    }
    if (wait == WAIT_FAILED) {
      return Role::kGaveUp;
    }
    if (::GetTickCount64() >= deadline) {
      return Role::kGaveUp;
    }
  }
}

HarnessSingleInstance::Delivery HarnessSingleInstance::Forward(HWND target) {
  DWORD process_id = 0;
  ::GetWindowThreadProcessId(target, &process_id);
  // This launch came from a click, so it may hand the foreground on.
  if (process_id != 0) {
    ::AllowSetForegroundWindow(process_id);
  }
  const wchar_t* command_line = ::GetCommandLineW();
  const size_t length = wcsnlen(command_line, 32767);
  COPYDATASTRUCT data = {};
  data.dwData = kHarnessCopyDataCommandLine;
  data.cbData = static_cast<DWORD>((length + 1) * sizeof(wchar_t));
  data.lpData = const_cast<wchar_t*>(command_line);
  DWORD_PTR answer = FALSE;
  ::SetLastError(ERROR_SUCCESS);
  if (::SendMessageTimeoutW(target, WM_COPYDATA, 0,
                            reinterpret_cast<LPARAM>(&data), SMTO_NORMAL,
                            10000, &answer) == 0) {
    // A send that timed out may still be read later, so it is never sent
    // again. Retry only a confirmed missing window; other failures do not
    // establish that the receiver did not read the message.
    const DWORD error = ::GetLastError();
    return error == ERROR_TIMEOUT ? Delivery::kUnknown
           : error == ERROR_INVALID_WINDOW_HANDLE ? Delivery::kRefused
                                                   : Delivery::kUnknown;
  }
  return answer == TRUE ? Delivery::kAccepted : Delivery::kRefused;
}

bool HarnessSingleInstance::Listen(HWND main_window,
                                  CommandLineHandler on_command_line,
                                  std::function<void()> on_quit) {
  main_window_ = main_window;
  on_command_line_ = std::move(on_command_line);
  on_quit_ = std::move(on_quit);
  WNDCLASSW window_class = {};
  window_class.lpfnWndProc = WndProc;
  window_class.hInstance = ::GetModuleHandleW(nullptr);
  window_class.lpszClassName = kWindowClass;
  if (::RegisterClassW(&window_class) == 0 &&
      ::GetLastError() != ERROR_CLASS_ALREADY_EXISTS) {
    return false;
  }
  const std::wstring name = InstanceName();
  if (name.empty()) {
    return false;
  }
  message_window_ = ::CreateWindowExW(
      0, kWindowClass, name.c_str(), 0, 0, 0, 0, 0, HWND_MESSAGE, nullptr,
      window_class.hInstance, this);
  return message_window_ != nullptr;
}

LRESULT CALLBACK HarnessSingleInstance::WndProc(HWND window, UINT message,
                                               WPARAM wparam,
                                               LPARAM lparam) noexcept {
  if (message == WM_NCCREATE) {
    auto* create = reinterpret_cast<CREATESTRUCTW*>(lparam);
    ::SetWindowLongPtrW(window, GWLP_USERDATA,
                       reinterpret_cast<LONG_PTR>(create->lpCreateParams));
  } else if (auto* that = reinterpret_cast<HarnessSingleInstance*>(
                 ::GetWindowLongPtrW(window, GWLP_USERDATA))) {
    if (message == WM_COPYDATA || IsHarnessQuitMessage(message)) {
      return that->HandleMessage(message, wparam, lparam);
    }
  }
  return ::DefWindowProcW(window, message, wparam, lparam);
}

LRESULT HarnessSingleInstance::HandleMessage(UINT message, WPARAM,
                                            LPARAM lparam) {
  if (IsHarnessQuitMessage(message)) {
    if (on_quit_) {
      on_quit_();
    }
    return 0;
  }
  const auto* data = reinterpret_cast<const COPYDATASTRUCT*>(lparam);
  if (data == nullptr || data->dwData != kHarnessCopyDataCommandLine ||
      data->lpData == nullptr || data->cbData < sizeof(wchar_t) ||
      data->cbData > kMaxCommandLineBytes ||
      data->cbData % sizeof(wchar_t) != 0) {
    return FALSE;
  }
  const auto* text = static_cast<const wchar_t*>(data->lpData);
  if (text[data->cbData / sizeof(wchar_t) - 1] != L'\0') {
    return FALSE;
  }
  const std::wstring command_line(
      text, wcsnlen(text, data->cbData / sizeof(wchar_t)));
  if (!on_command_line_ || !on_command_line_(command_line)) {
    return FALSE;
  }
  BringToFront(main_window_);
  return TRUE;
}

void HarnessSingleInstance::BringToFront(HWND window) {
  if (window == nullptr) {
    return;
  }
  ::ShowWindow(window, ::IsIconic(window) ? SW_RESTORE : SW_SHOW);
  ::SetForegroundWindow(window);
}

bool HarnessSingleInstance::NotifyQuit(DWORD wait_ms) {
  const std::wstring name = InstanceName();
  if (name.empty()) {
    return false;
  }
  // The mutex exists before the message window. A missing window alone does
  // not mean the app has exited: it may still be starting or tearing down.
  HANDLE mutex = ::OpenMutexW(SYNCHRONIZE | MUTEX_MODIFY_STATE, FALSE,
                              name.c_str());
  if (mutex == nullptr) {
    return ::GetLastError() == ERROR_FILE_NOT_FOUND;
  }
  const ULONGLONG deadline = ::GetTickCount64() + wait_ms;
  bool exited = false;
  for (;;) {
    const DWORD state = ::WaitForSingleObject(mutex, 0);
    if (state == WAIT_OBJECT_0 || state == WAIT_ABANDONED) {
      ::ReleaseMutex(mutex);
      exited = true;
      break;
    }
    if (state == WAIT_FAILED) {
      break;
    }
    if (::GetTickCount64() >= deadline) {
      break;
    }
    HWND target =
        ::FindWindowExW(HWND_MESSAGE, nullptr, kWindowClass, name.c_str());
    if (target != nullptr) {
      DWORD process_id = 0;
      ::GetWindowThreadProcessId(target, &process_id);
      const UINT quit = HarnessQuitMessage();
      HANDLE process = process_id == 0
                           ? nullptr
                           : ::OpenProcess(SYNCHRONIZE, FALSE, process_id);
      if (quit == 0) {
        if (process != nullptr) {
          ::CloseHandle(process);
        }
        break;
      }
      if (process != nullptr && ::PostMessageW(target, quit, 0, 0)) {
        const ULONGLONG now = ::GetTickCount64();
        const DWORD remaining =
            now >= deadline ? 0 : static_cast<DWORD>(deadline - now);
        const bool process_exited =
            ::WaitForSingleObject(process, remaining) == WAIT_OBJECT_0;
        ::CloseHandle(process);
        if (!process_exited) {
          break;
        }
        // A waiting launch may already own the mutex after this PID exits.
        // Recheck the instance, and quit any successor within the same bound.
        continue;
      }
      if (process != nullptr) {
        ::CloseHandle(process);
      }
      // If its window disappeared, wait for the mutex instead of reporting
      // success while its owning process is still shutting down.
      if (::IsWindow(target)) {
        break;
      }
    }
    const ULONGLONG now = ::GetTickCount64();
    if (now >= deadline) {
      break;
    }
    const DWORD remaining = static_cast<DWORD>(deadline - now);
    const DWORD wait =
        ::WaitForSingleObject(mutex, remaining < 100 ? remaining : 100);
    if (wait == WAIT_OBJECT_0 || wait == WAIT_ABANDONED) {
      ::ReleaseMutex(mutex);
      exited = true;
      break;
    }
    if (wait == WAIT_FAILED) {
      break;
    }
  }
  ::CloseHandle(mutex);
  return exited;
}
