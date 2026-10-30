#include "single_instance.h"

#include <array>
#include <cstdio>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

namespace {

constexpr DWORD kScenarioMs = 25000;
constexpr DWORD kQuitBudgetMs = 4000;
constexpr DWORD kConsumedMs = 2000;
constexpr DWORD kSchedulingToleranceMs = 750;
constexpr DWORD kAcquireBudgetMs = 250;

void Require(bool condition, const char* message) {
  if (!condition) throw std::runtime_error(message);
}

void Trace(const char* message) {
  std::printf("[%lu @ %llu] %s\n", ::GetCurrentProcessId(), ::GetTickCount64(),
              message);
  std::fflush(stdout);
}

class Handle {
 public:
  explicit Handle(HANDLE value = nullptr) : value_(value) {}
  ~Handle() {
    if (value_ != nullptr) ::CloseHandle(value_);
  }
  Handle(const Handle&) = delete;
  Handle& operator=(const Handle&) = delete;
  Handle(Handle&& other) noexcept
      : value_(std::exchange(other.value_, nullptr)) {}
  Handle& operator=(Handle&& other) noexcept {
    if (value_ != nullptr) ::CloseHandle(value_);
    value_ = std::exchange(other.value_, nullptr);
    return *this;
  }
  HANDLE get() const { return value_; }

 private:
  HANDLE value_;
};

class Deadline {
 public:
  Deadline() : end_(::GetTickCount64() + kScenarioMs) {}
  DWORD remaining() const {
    const ULONGLONG now = ::GetTickCount64();
    return now < end_ ? static_cast<DWORD>(end_ - now) : 0;
  }

 private:
  ULONGLONG end_;
};

enum Event {
  kAReady,
  kBAttempt,
  kRefused,
  kAQuit,
  kReleaseA,
  kBReady,
  kBQuit,
  kStop,
  kQTrue,
  kQFalse,
  kForwarded,
  kDelivered,
  kEventCount
};

class Events {
 public:
  Events(const std::wstring& token, bool create) {
    for (int i = 0; i < kEventCount; ++i) {
      const std::wstring name =
          L"Local\\HarnessInstanceTest-" + token + L"-" + std::to_wstring(i);
      handles_[i] =
          Handle(create ? ::CreateEventW(nullptr, TRUE, FALSE, name.c_str())
                        : ::OpenEventW(EVENT_MODIFY_STATE | SYNCHRONIZE, FALSE,
                                       name.c_str()));
      const DWORD error = ::GetLastError();
      Require(handles_[i].get() != nullptr, "Cannot open owned test event");
      Require(!create || error != ERROR_ALREADY_EXISTS,
              "Test event collision; refusing to reuse another invocation");
    }
  }
  HANDLE get(Event event) const { return handles_[event].get(); }
  void signal(Event event) const {
    Require(::SetEvent(get(event)) != FALSE, "Cannot signal test event");
  }
  bool set(Event event) const {
    return ::WaitForSingleObject(get(event), 0) == WAIT_OBJECT_0;
  }
  void wait(Event event, const Deadline& deadline, const char* failure) const {
    Require(::WaitForSingleObject(get(event), deadline.remaining()) ==
                WAIT_OBJECT_0,
            failure);
  }

 private:
  std::array<Handle, kEventCount> handles_;
};

// A private kill-on-close job contains only suspended children created here.
// Even CTest's outer timeout closes this handle and cannot orphan those
// children.
class ChildJob {
 public:
  ChildJob() : handle_(::CreateJobObjectW(nullptr, nullptr)) {
    Require(handle_.get() != nullptr, "Cannot create child job");
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits = {};
    limits.BasicLimitInformation.LimitFlags =
        JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    Require(::SetInformationJobObject(handle_.get(),
                                      JobObjectExtendedLimitInformation,
                                      &limits, sizeof(limits)) != FALSE,
            "Cannot configure child job");
  }
  HANDLE get() const { return handle_.get(); }

 private:
  Handle handle_;
};

class Child {
 public:
  Child(const ChildJob& job, const std::wstring& executable,
        const std::wstring& scenario, const std::wstring& token,
        const wchar_t* role) {
    std::wstring command = L"\"" + executable + L"\" --child " + scenario +
                           L" " + token + L" " + role;
    STARTUPINFOW startup = {};
    startup.cb = sizeof(startup);
    PROCESS_INFORMATION info = {};
    Require(::CreateProcessW(executable.c_str(), command.data(), nullptr,
                             nullptr, FALSE, CREATE_SUSPENDED, nullptr, nullptr,
                             &startup, &info) != FALSE,
            "Cannot start owned child");
    process_ = Handle(info.hProcess);
    Handle thread(info.hThread);
    // A failed constructor must also reclaim the still-suspended process.
    if (!::AssignProcessToJobObject(job.get(), process_.get()) ||
        ::ResumeThread(thread.get()) == static_cast<DWORD>(-1)) {
      ::TerminateProcess(process_.get(), 90);
      ::WaitForSingleObject(process_.get(), 1000);
      throw std::runtime_error("Cannot contain/resume owned child");
    }
  }
  ~Child() {
    if (process_.get() != nullptr && alive()) {
      Trace("CLEANUP: terminating retained child handle (never test success)");
      ::TerminateProcess(process_.get(), 91);
      ::WaitForSingleObject(process_.get(), 1000);
    }
  }
  bool alive() const {
    return ::WaitForSingleObject(process_.get(), 0) == WAIT_TIMEOUT;
  }
  void clean_exit(const Deadline& deadline, const char* failure) const {
    Require(::WaitForSingleObject(process_.get(), deadline.remaining()) ==
                WAIT_OBJECT_0,
            failure);
    DWORD code = 99;
    Require(::GetExitCodeProcess(process_.get(), &code) != FALSE && code == 0,
            failure);
  }

 private:
  Handle process_;
};

// Dispatch real Windows messages, including cross-process WM_COPYDATA sends.
template <typename Done>
void PumpUntil(Done done, const Deadline& deadline) {
  while (!done()) {
    const DWORD remaining = deadline.remaining();
    Require(remaining > 0, "Child message pump exceeded scenario deadline");
    Require(::MsgWaitForMultipleObjectsEx(
                0, nullptr, remaining < 20 ? remaining : 20, QS_ALLINPUT,
                MWMO_INPUTAVAILABLE) != WAIT_FAILED,
            "Message wait failed");
    MSG message;
    while (::PeekMessageW(&message, nullptr, 0, 0, PM_REMOVE)) {
      ::TranslateMessage(&message);
      ::DispatchMessageW(&message);
    }
  }
}

int OwnerA(const std::wstring& scenario, const Events& events,
           const Deadline& deadline) {
  bool quit = false;
  int deliveries = 0;
  {
    HarnessSingleInstance instance;
    Require(instance.Acquire() == HarnessSingleInstance::Role::kPrimary,
            "A did not acquire primary ownership");
    if (scenario == L"never-listens") {
      Trace("A owns mutex and will not Listen during B Acquire budget");
      events.signal(kAReady);
      events.wait(kStop, deadline,
                  "Parent never released non-listening owner A");
      return 0;
    }
    if (scenario == L"delayed-listen") {
      Trace("A owns mutex; Listen is held at event barrier");
      events.signal(kAReady);
      events.wait(kReleaseA, deadline, "Parent never released delayed Listen");
    }
    Require(instance.Listen(
                nullptr,
                [&](const std::wstring&) {
                  if (scenario == L"delayed-listen") {
                    ++deliveries;
                    ::SetEvent(events.get(kDelivered));
                    return true;
                  }
                  ::SetEvent(events.get(kRefused));
                  return false;
                },
                [&] {
                  quit = true;
                  ::SetEvent(events.get(kAQuit));
                }),
            "A could not create production message window");
    if (scenario != L"delayed-listen") events.signal(kAReady);
    PumpUntil([&] { return quit || events.set(kStop); }, deadline);
    if (scenario == L"delayed-listen") {
      Require(deliveries == 1,
              "Delayed Listen must receive exactly one launch");
      return 0;
    }
    Require(quit, "A stopped without its real quit callback");
    Trace("A quit callback returned; Q selected A");
    if (scenario == L"deadline") {
      // Keep refusing B's synchronous forwards while consuming Q's budget.
      // A blocked window thread would test SendMessageTimeout instead.
      PumpUntil([&] { return events.set(kReleaseA); }, deadline);
    }
  }  // Destroy the real window and release the mutex, after callback returned.
  Trace("A released instance scope but remains alive until B listens");
  events.wait(kBReady, deadline, "Successor B never acquired and listened");
  Trace("A observed B ownership/listener before exiting");
  return 0;
}

int OwnerB(const std::wstring& scenario, const Events& events,
           const Deadline& deadline) {
  HarnessSingleInstance instance;
  Trace("B entering production Acquire");
  events.signal(kBAttempt);
  if (scenario == L"never-listens") {
    const ULONGLONG started = ::GetTickCount64();
    const auto role = instance.Acquire(kAcquireBudgetMs);
    const ULONGLONG elapsed = ::GetTickCount64() - started;
    std::printf("Acquire without listener role=%d elapsed=%llu ms\n",
                static_cast<int>(role), elapsed);
    std::fflush(stdout);
    Require(role == HarnessSingleInstance::Role::kGaveUp,
            "Missing listener must neither forward nor start a second primary");
    Require(elapsed >= kAcquireBudgetMs - 25 && elapsed <= 1000,
            "Missing listener did not wait for the bounded Acquire budget");
    return 0;
  }
  const auto role = instance.Acquire();
  if (scenario == L"delayed-listen") {
    Require(role == HarnessSingleInstance::Role::kForwarded,
            "Delayed Listen started a second primary or lost the launch");
    events.signal(kForwarded);
    return 0;
  }
  Require(role == HarnessSingleInstance::Role::kPrimary,
          "B never acquired successor ownership");
  bool quit = false;
  Require(instance.Listen(
              nullptr, [](const std::wstring&) { return false; },
              [&] {
                quit = true;
                ::SetEvent(events.get(kBQuit));
              }),
          "B could not create production message window");
  Trace("B owns mutex and has production listener");
  events.signal(kBReady);
  PumpUntil([&] { return quit || events.set(kStop); }, deadline);
  Require(quit, "B stopped without its real quit callback");
  if (scenario == L"deadline") {
    Trace("B received quit; retaining ownership beyond Q original deadline");
    events.wait(kStop, deadline, "Parent never released deadline owner B");
  }
  return 0;
}

int Quitter(const std::wstring& scenario, const Events& events) {
  const ULONGLONG started = ::GetTickCount64();
  const bool result = scenario == L"deadline"
                          ? HarnessSingleInstance::NotifyQuit(kQuitBudgetMs)
                          : HarnessSingleInstance::NotifyQuit();
  const ULONGLONG elapsed = ::GetTickCount64() - started;
  std::printf("NotifyQuit result=%s elapsed=%llu ms\n",
              result ? "true" : "false", elapsed);
  std::fflush(stdout);
  events.signal(result ? kQTrue : kQFalse);
  if (scenario == L"deadline") {
    Require(!result, "NotifyQuit reported success while B still owns instance");
    Require(elapsed >= kQuitBudgetMs - 100 &&
                elapsed <= kQuitBudgetMs + kSchedulingToleranceMs,
            "NotifyQuit did not keep the original timeout budget");
  } else {
    Require(result, "NotifyQuit did not finish successor shutdown");
  }
  return 0;
}

void VerifyMutexAvailable() {
  HarnessSingleInstance probe;
  Require(probe.Acquire(0) == HarnessSingleInstance::Role::kPrimary,
          "Instance mutex is still owned after clean child exits");
}

void Scenario(const std::wstring& scenario, const std::wstring& executable) {
  const Deadline deadline;
  LARGE_INTEGER counter;
  Require(::QueryPerformanceCounter(&counter) != FALSE,
          "Cannot allocate invocation identity");
  const std::wstring token = std::to_wstring(::GetCurrentProcessId()) + L"-" +
                             std::to_wstring(counter.QuadPart);
  Require(::SetEnvironmentVariableW(L"HARNESS_DESKTOP_INSTANCE",
                                    (L"native-regression-" + token).c_str()) !=
              FALSE,
          "Cannot isolate production instance identity");
  const Events events(token, true);
  const ChildJob job;
  // Catch inside the scope of child owners: emit the failure before cleanup.
  std::unique_ptr<Child> a, b, q;
  try {
    a = std::make_unique<Child>(job, executable, scenario, token, L"a");
    events.wait(kAReady, deadline, "Fixture startup: A never ready");
    b = std::make_unique<Child>(job, executable, scenario, token, L"b");
    if (scenario == L"never-listens") {
      b->clean_exit(deadline,
                    "B missing-listener role or timeout assertion failed");
      Require(a->alive(), "A did not retain ownership throughout B timeout");
      events.signal(kStop);
      a->clean_exit(deadline, "Non-listening owner A did not exit cleanly");
    } else if (scenario == L"delayed-listen") {
      // This marker is the call boundary, not proof of Acquire's internal wait.
      // The never-listens case separately checks that real missing-window wait.
      events.wait(kBAttempt, deadline,
                  "Fixture startup: B never attempted Acquire");
      Require(a->alive() && b->alive(), "Fixture owner or later launch died");
      events.signal(kReleaseA);
      b->clean_exit(deadline, "Later launch did not forward and exit cleanly");
      Require(events.set(kForwarded) && events.set(kDelivered),
              "Missing forwarded role or actual command-line callback");
      events.signal(kStop);
      a->clean_exit(deadline, "A failed exactly-once delivery assertion");
    } else {
      // The callback proves B actually reached A's real listener via Acquire.
      events.wait(kRefused, deadline,
                  "Fixture startup: A never refused B launch");
      q = std::make_unique<Child>(job, executable, scenario, token, L"q");
      events.wait(kAQuit, deadline, "Fixture startup: Q never selected A");
      if (scenario == L"deadline") {
        const ULONGLONG held = ::GetTickCount64();
        Require(::WaitForSingleObject(events.get(kStop), kConsumedMs) ==
                    WAIT_TIMEOUT,
                "Deadline hold unexpectedly interrupted");
        Require(::GetTickCount64() - held >= kConsumedMs && a->alive(),
                "A did not consume the first part of Q timeout alive");
        events.signal(kReleaseA);
      }
      events.wait(kBReady, deadline,
                  "Fixture startup: B never owned and listened");
      a->clean_exit(deadline, "A did not exit cleanly after B listened");
      q->clean_exit(deadline, "Q result or elapsed deadline assertion failed");
      if (scenario == L"deadline") {
        Require(
            events.set(kQFalse) && events.set(kBQuit) && b->alive(),
            "Deadline regression: expected Qfalse with B quit but still alive");
        events.signal(
            kStop);  // Release only after Q result and liveness checked.
      } else {
        Require(events.set(kQTrue), "Q did not report successful quit");
        Require(
            events.set(kBQuit),
            "SUCCESSOR REGRESSION: Q returned without B quit callback/exit");
      }
      b->clean_exit(deadline, "Successor B did not exit cleanly after quit");
    }
    VerifyMutexAvailable();
    Require(deadline.remaining() > 0, "Scenario exceeded its outer deadline");
    Trace(
        "PASS: clean exits, expected callbacks/result, final mutex available");
  } catch (const std::exception& error) {
    std::fprintf(stderr, "FAIL before cleanup: %s\n", error.what());
    std::fflush(stderr);
    throw;
  }
}

bool ValidScenario(const std::wstring& scenario) {
  return scenario == L"successor" || scenario == L"deadline" ||
         scenario == L"delayed-listen" || scenario == L"never-listens";
}

}  // namespace

int wmain(int argc, wchar_t** argv) {
  try {
    Require(argc >= 3 && ValidScenario(argv[2]), "Invalid fixed test scenario");
    const std::wstring scenario = argv[2];
    if (argc == 3 && std::wstring(argv[1]) == L"--scenario") {
      std::array<wchar_t, 32768> executable = {};
      const DWORD length = ::GetModuleFileNameW(
          nullptr, executable.data(), static_cast<DWORD>(executable.size()));
      Require(length > 0 && length < executable.size(),
              "Cannot locate test exe");
      Scenario(scenario, executable.data());
      return 0;
    }
    Require(argc == 5 && std::wstring(argv[1]) == L"--child",
            "Expected parent or fixed child role");
    const std::wstring token = argv[3];
    const std::wstring expected = L"native-regression-" + token;
    std::array<wchar_t, 256> suffix = {};
    const DWORD length =
        ::GetEnvironmentVariableW(L"HARNESS_DESKTOP_INSTANCE", suffix.data(),
                                  static_cast<DWORD>(suffix.size()));
    Require(length > 0 && length < suffix.size() && expected == suffix.data(),
            "Refusing child without the parent-owned isolated instance suffix");
    const Events events(token, false);
    const Deadline deadline;
    const std::wstring role = argv[4];
    if (role == L"a") return OwnerA(scenario, events, deadline);
    if (role == L"b") return OwnerB(scenario, events, deadline);
    if (role == L"q" && (scenario == L"successor" || scenario == L"deadline")) {
      return Quitter(scenario, events);
    }
    throw std::runtime_error("Invalid fixed child role");
  } catch (const std::exception& error) {
    std::fprintf(stderr, "FAIL: %s (Win32 error %lu)\n", error.what(),
                 ::GetLastError());
    return 1;
  }
}
