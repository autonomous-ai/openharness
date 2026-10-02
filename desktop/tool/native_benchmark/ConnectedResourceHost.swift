// Compiled only into a copied benchmark host. Never included in Runner.
private enum ConnectedResourceHost {
  static func validateEnvironment() {
    let env = ProcessInfo.processInfo.environment
    guard Bundle.main.bundleIdentifier == "ai.autonomous.harness.benchmark",
          let root = env["HARNESS_CONNECTED_ROOT"],
          root.hasPrefix("/private/tmp/harness-connected-"),
          URL(fileURLWithPath: root).deletingLastPathComponent().path == "/private/tmp",
          env["HOME"] == root + "/home",
          env["CFFIXED_USER_HOME"] == root + "/home",
          env["FLUTTER_TEST"] == nil else {
      fputs("Connected fixture requires its private launcher environment\n", stderr)
      exit(78)
    }
  }

  static func install(window: NSWindow, messenger: FlutterBinaryMessenger) {
    let bridge = FlutterMethodChannel(name: "harness/connected_resource_fixture", binaryMessenger: messenger)
    var focusLosses = 0
    // Observers live exactly as long as this isolated app.
    _ = NotificationCenter.default.addObserver(
      forName: NSWindow.didResignKeyNotification, object: window, queue: .main
    ) { _ in focusLosses += 1 }
    bridge.setMethodCallHandler { call, result in
      switch call.method {
      case "ready":
        window.setContentSize(NSSize(width: 1280, height: 800))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        result(["bundle": Bundle.main.bundleIdentifier!, "pid": ProcessInfo.processInfo.processIdentifier])
      case "captureState":
        result([
          "key": window.isKeyWindow, "active": NSApp.isActive,
          "visible": window.isVisible, "hidden": NSApp.isHidden,
          "focusLosses": focusLosses, "width": window.contentView?.bounds.width ?? 0,
          "height": window.contentView?.bounds.height ?? 0, "scale": window.backingScaleFactor,
        ])
      case "hide":
        NSApp.hide(nil)
        result(nil)
      case "show":
        NSApp.unhide(nil)
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        result(nil)
      case "finish":
        result(nil)
        DispatchQueue.main.async { NSApp.terminate(nil) }
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }
}
