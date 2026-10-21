#ifndef RUNNER_COMMUNITY_LINKS_H_
#define RUNNER_COMMUNITY_LINKS_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>

#include <memory>
#include <string>
#include <vector>

// `harness://` links for Dart, on `harness/community_links`: the channel and
// the two calls AppDelegate.swift and my_application.cc use.
//  - Dart -> native `ready` answers the links that arrived before it, and
//    every later link goes straight to Dart.
//  - Native -> Dart `open(<url>)`.
// A link starts with `harness://` and is at most 240 bytes. At most 20 wait
// for `ready`. They come from this launch's arguments and from later
// launches' command lines, which the single instance forwards.
class HarnessCommunityLinks {
 public:
  static HarnessCommunityLinks& Instance();

  void Attach(flutter::BinaryMessenger* messenger);
  void Detach();

  // One candidate link. Anything that is not a Harness link is ignored.
  void Deliver(const std::string& url);

  // This launch's own arguments (UTF-8, without the program).
  void DeliverArguments(const std::vector<std::string>& arguments);

  // A later launch's whole command line, as WM_COPYDATA carried it.
  void DeliverCommandLine(const std::wstring& command_line);

  static bool IsHarnessLink(const std::string& value);

 private:
  HarnessCommunityLinks() = default;

  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  std::vector<std::string> pending_;
  bool ready_ = false;
};

#endif  // RUNNER_COMMUNITY_LINKS_H_
