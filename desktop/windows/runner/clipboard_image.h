#ifndef RUNNER_CLIPBOARD_IMAGE_H_
#define RUNNER_CLIPBOARD_IMAGE_H_

#include <flutter/binary_messenger.h>
#include <flutter/encodable_value.h>
#include <flutter/method_channel.h>
#include <windows.h>

#include <memory>

// The clipboard's picture and its copied files, on `harness/clipboard_image`:
// the calls MainFlutterWindow.swift and my_application.cc answer. Flutter's
// own Clipboard only sees text.
//  - `readImagePng`: the picture as PNG bytes, or null. The registered `PNG`
//    format as it was put there, else a DIB encoded with WIC.
//  - `writeImagePng(bytes)`: the picture back as `PNG` and CF_DIBV5. This is
//    the local half of image drag-drop.
//  - `readFilePaths`: the paths of a CF_HDROP (files copied in Explorer).
class HarnessClipboardImage {
 public:
  HarnessClipboardImage(flutter::BinaryMessenger* messenger, HWND owner);
  ~HarnessClipboardImage();

  HarnessClipboardImage(const HarnessClipboardImage&) = delete;
  HarnessClipboardImage& operator=(const HarnessClipboardImage&) = delete;

 private:
  std::unique_ptr<flutter::MethodChannel<flutter::EncodableValue>> channel_;
  HWND owner_;
};

#endif  // RUNNER_CLIPBOARD_IMAGE_H_
