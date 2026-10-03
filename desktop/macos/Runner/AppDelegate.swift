import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  override init() {
    super.init()
    // AppKit reads this app-scoped preference in milliseconds. Registering a
    // default keeps native help tags while respecting an explicit user override.
    UserDefaults.standard.register(defaults: ["NSInitialToolTipDelay": 500])
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }
}
