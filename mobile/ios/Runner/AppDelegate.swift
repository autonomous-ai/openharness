import Flutter
import UIKit

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    DeviceNameChannel.register(with: engineBridge.pluginRegistry)
    ClipboardImageChannel.register(with: engineBridge.pluginRegistry)
  }
}

/// `harness/clipboard_image` — the image on the clipboard, as PNG bytes (Dart:
/// `lib/clipboard/native_clipboard.dart`). Flutter's own clipboard reads `text/plain` only, so a
/// screenshot or a "Copy" from Photos was invisible to Paste. The same channel the desktop runners
/// answer; only `readImagePng` is implemented here, since nothing on the phone writes an image.
enum ClipboardImageChannel {
  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "HarnessClipboardImage")?.messenger() else { return }
    let channel = FlutterMethodChannel(name: "harness/clipboard_image", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "readImagePng" else { result(FlutterMethodNotImplemented); return }
      // `hasImages` answers without the system's paste prompt, so an empty clipboard never asks.
      let pasteboard = UIPasteboard.general
      guard pasteboard.hasImages else { result(nil); return }
      // An existing PNG is passed through untouched; anything else (a JPEG or HEIC from Photos) is
      // re-encoded, which for a full-size photo is slow enough to keep off the main thread.
      if let png = pasteboard.data(forPasteboardType: "public.png") {
        result(FlutterStandardTypedData(bytes: png))
        return
      }
      // From here an image IS on the clipboard, so a failure answers EMPTY bytes rather than nil:
      // Dart then says the image is unreadable instead of that there is nothing to paste.
      let unreadable = FlutterStandardTypedData(bytes: Data())
      guard let image = pasteboard.image else { result(unreadable); return }
      DispatchQueue.global(qos: .userInitiated).async {
        let png = image.pngData()
        DispatchQueue.main.async {
          result(png.map { FlutterStandardTypedData(bytes: $0) } ?? unreadable)
        }
      }
    }
  }
}

/// `harness/device_name` — what this phone is called, for the far side's "took control" banner
/// (Dart: `lib/core/device_name.dart`). `name` is the user's own name for the device where iOS still
/// hands it out (before iOS 16, or with Apple's user-assigned-device-name entitlement); otherwise it
/// is the generic "iPhone" and Dart falls back to the model, read off the hardware code.
enum DeviceNameChannel {
  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "HarnessDeviceName")?.messenger() else { return }
    let channel = FlutterMethodChannel(name: "harness/device_name", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "describe" else { result(FlutterMethodNotImplemented); return }
      result([
        "name": UIDevice.current.name,
        "model": UIDevice.current.model,
        "modelCode": modelCode(),
        "manufacturer": "Apple",
      ])
    }
  }

  /// "iPhone16,1" — the hardware identifier; on the simulator, the device it is pretending to be.
  private static func modelCode() -> String {
    if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty {
      return simulated
    }
    var systemInfo = utsname()
    uname(&systemInfo)
    return withUnsafePointer(to: &systemInfo.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(validatingCString: $0) ?? "" }
    }
  }
}
