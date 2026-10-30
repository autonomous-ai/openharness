#ifndef RUNNER_NOTIFICATIONS_H_
#define RUNNER_NOTIFICATIONS_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>

#include <memory>
#include <string>

// An agent's news as a Windows toast, on `harness/notifications`: the calls
// HarnessNotifications.swift answers (`authorize`, `show`, `withdraw`), with
// its answers (`granted`, `denied`, `unavailable`, `unknown`).
//
// Dart decides whether and when to post. Toasts post under the AUMID
// `Autonomous.Harness`, which the Start Menu shortcut carries (C4). Without
// it Windows refuses a post. `authorize` can answer `unknown` before the first
// toast registers the AUMID; `show` attempts that post. A toast's click is
// its `harness://notification/...` link (activationType="protocol"). It
// arrives through the single instance and `harness/community_links` like any
// other link, so no COM activator is needed.
class HarnessNotifications {
 public:
  explicit HarnessNotifications(flutter::BinaryMessenger* messenger);
  ~HarnessNotifications();

 private:
  static std::string Authorize();
  static std::string Show(const std::wstring& tag, const std::wstring& title,
                          const std::wstring& body,
                          const std::wstring& launch);
  static void Withdraw(const std::wstring& tag);

  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
};

#endif  // RUNNER_NOTIFICATIONS_H_
