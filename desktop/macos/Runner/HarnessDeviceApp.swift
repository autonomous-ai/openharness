import Cocoa
import FlutterMacOS

/// Tells Dart where macOS knows the Harness menu-bar app to be, and whether it runs, so Desktop can offer it.
///
/// It filters nothing: LaunchServices also lists copies in the Trash and on mounted disk images, and Dart decides
/// which of them count (`device_app_probe.dart`), where a test pull request CI runs checks that rule. Pull request
/// CI builds no macOS app, so a rule here would go untested.
enum HarnessDeviceApp {
  static let bundleIdentifier = "ai.autonomous.harness.device"

  private static var channel: FlutterMethodChannel?

  /// Sets up `harness/device_app` and keeps the channel.
  static func install(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "harness/device_app", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "lookup" else {
        result(FlutterMethodNotImplemented)
        return
      }
      result([
        "paths": NSWorkspace.shared.urlsForApplications(withBundleIdentifier: bundleIdentifier).map(\.path),
        "running": !NSRunningApplication.runningApplications(withBundleIdentifier: bundleIdentifier).isEmpty,
      ])
    }
    Self.channel = channel
  }
}
