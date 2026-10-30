#ifndef RUNNER_FONTS_H_
#define RUNNER_FONTS_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <windows.h>

#include <deque>
#include <memory>

// Installed families on `harness/fonts`: `listFonts` answers [{family, mono}].
// Enumeration stays off the platform thread. Only this instance owns Flutter
// replies; workers retain native data only, even after the window closes.
class HarnessFonts : public std::enable_shared_from_this<HarnessFonts> {
 public:
  HarnessFonts(flutter::BinaryMessenger* messenger, HWND window);
  ~HarnessFonts();

  HarnessFonts(const HarnessFonts&) = delete;
  HarnessFonts& operator=(const HarnessFonts&) = delete;

  // Install the handler after shared ownership exists.
  void Start();
  // Cancel enumeration and finish/release replies before engine destruction.
  void Shutdown();
  bool HandleMessage(UINT message, WPARAM wparam);

 private:
  struct Job;
  using Reply = std::unique_ptr<flutter::MethodResult<flutter::EncodableValue>>;

  void ListFonts(Reply result);
  static void Enumerate(const std::shared_ptr<Job>& job);

  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  HWND window_;
  UINT_PTR timer_ = 0;
  bool detached_ = false;
  std::shared_ptr<Job> job_;
  std::deque<Reply> pending_;
};

#endif  // RUNNER_FONTS_H_
