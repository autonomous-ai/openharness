import Cocoa
import FlutterMacOS

@main
class AppDelegate: FlutterAppDelegate {
  private static var communityChannel: FlutterMethodChannel?
  private static var pendingLinks: [String] = []
  private static var linksReady = false

  static func installCommunityLinks(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: "harness/community_links", binaryMessenger: messenger)
    communityChannel = channel
    channel.setMethodCallHandler { call, result in
      guard call.method == "ready" else { result(FlutterMethodNotImplemented); return }
      linksReady = true
      let pending = pendingLinks
      pendingLinks.removeAll()
      result(pending)
    }
  }

  override func application(_ application: NSApplication, open urls: [URL]) {
    for url in urls where url.scheme == "harness" && url.absoluteString.count <= 240 {
      if Self.linksReady {
        Self.communityChannel?.invokeMethod("open", arguments: url.absoluteString)
      } else if Self.pendingLinks.count < 20 {
        Self.pendingLinks.append(url.absoluteString)
      }
    }
    mainFlutterWindow?.makeKeyAndOrderFront(nil)
    application.activate(ignoringOtherApps: true)
  }
  override init() {
    super.init()
    // AppKit reads this app-scoped preference in milliseconds. Registering a
    // default keeps native help tags while respecting an explicit user override.
    UserDefaults.standard.register(defaults: ["NSInitialToolTipDelay": 500])
  }

  // Hidden or covered, Harness would be App Napped: its timers stall for minutes, the daemon drops
  // its idle local socket and the Swarm tabs empty. This keeps it awake but still lets the Mac sleep.
  // FlutterAppDelegate implements neither callback, so there is no super to call.
  private(set) var appNapActivity: NSObjectProtocol?

  override func applicationDidFinishLaunching(_ notification: Notification) {
    appNapActivity = ProcessInfo.processInfo.beginActivity(
      options: .userInitiatedAllowingIdleSystemSleep, reason: "Keep agents and Swarm updates live while hidden")
  }

  override func applicationWillTerminate(_ notification: Notification) {
    if let activity = appNapActivity { ProcessInfo.processInfo.endActivity(activity) }
    appNapActivity = nil
  }

  override func applicationShouldTerminateAfterLastWindowClosed(_ sender: NSApplication) -> Bool {
    return true
  }

  override func applicationSupportsSecureRestorableState(_ app: NSApplication) -> Bool {
    return true
  }
}
