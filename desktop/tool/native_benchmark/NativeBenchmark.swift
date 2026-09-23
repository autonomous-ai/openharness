// AppKit input driver compiled ONLY into the isolated benchmark copy.
// prepare.py appends this to that copy's MainFlutterWindow.swift; production
// Runner sources and the user's V2 bundle never contain this channel.
private enum NativeBenchmark {
  private static var channel: FlutterMethodChannel?
  private static var focusLosses = 0
  private static var focusObserver: NSObjectProtocol?

  static func install(window: NSWindow, messenger: FlutterBinaryMessenger) {
    guard Bundle.main.bundleIdentifier == "ai.autonomous.harness.benchmark",
          ProcessInfo.processInfo.environment["HARNESS_NATIVE_BENCHMARK"] == "1",
          ProcessInfo.processInfo.environment["FLUTTER_TEST"] == "1" else {
      return
    }
    let bridge = FlutterMethodChannel(name: "harness/isolated_benchmark", binaryMessenger: messenger)
    channel = bridge
    bridge.setMethodCallHandler { call, result in
      switch call.method {
      case "ready":
        window.setContentSize(NSSize(width: 1280, height: 800))
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        result([
          "bundle": Bundle.main.bundleIdentifier!,
          "width": window.contentView?.bounds.width ?? 0,
          "height": window.contentView?.bounds.height ?? 0,
          "scale": window.backingScaleFactor,
          "maximumFramesPerSecond": window.screen?.maximumFramesPerSecond ?? 0,
          "os": ProcessInfo.processInfo.operatingSystemVersionString,
        ])
      case "begin":
        guard window.isKeyWindow, NSApp.isActive else {
          result(FlutterError(code: "inactive", message: "Benchmark window must be active and key", details: [
            "key": window.isKeyWindow,
            "active": NSApp.isActive,
            "visible": window.isVisible,
          ]))
          return
        }
        // Match the production titlebar's responder. The Flutter controller
        // accepts keyboard focus; its wrapper NSView may reject it.
        guard let controller = window.contentViewController as? FlutterViewController,
              window.makeFirstResponder(controller) else {
          result(FlutterError(code: "focus", message: "Flutter controller must own initial focus", details: nil))
          return
        }
        // Once, after the synthetic UI is mounted. Never reset native or Dart
        // focus between observations: navigation must perform its own handoff.
        result(String(describing: type(of: window.firstResponder!)))
      case "captureState":
        if focusObserver == nil {
          focusObserver = NotificationCenter.default.addObserver(
            forName: NSWindow.didResignKeyNotification, object: window, queue: .main
          ) { _ in focusLosses += 1 }
        }
        result([
          "key": window.isKeyWindow,
          "active": NSApp.isActive,
          "visible": window.isVisible,
          "focusLosses": focusLosses,
        ])
      case "key":
        guard window.isKeyWindow, NSApp.isActive,
              let args = call.arguments as? [String: Any],
              let operation = args["operation"] as? String else {
          result(FlutterError(code: "inactive", message: "Benchmark window must own focus", details: nil))
          return
        }
        let code: UInt16
        let characters: String
        let unmodified: String
        let flags: NSEvent.ModifierFlags
        switch operation {
        case "typing":
          code = 7; characters = "x"; unmodified = "x"; flags = []
        case "focus":
          guard let index = args["index"] as? Int, (1...4).contains(index) else {
            result(FlutterError(code: "invalid", message: "Invalid pane index", details: nil))
            return
          }
          code = [18, 19, 20, 21][index - 1]
          characters = String(index); unmodified = characters
          // AppKit carries both aggregate and device-side modifier bits.
          // NX_DEVICELCMDKEYMASK = 0x8; Flutter tracks the device-side bits.
          flags = [.command, NSEvent.ModifierFlags(rawValue: 0x8)]
        case "tab":
          code = 30; characters = "}"; unmodified = "]"
          // NX_DEVICELSHIFTKEYMASK = 0x2.
          flags = [.command, .shift, NSEvent.ModifierFlags(rawValue: 0xa)]
        default:
          result(FlutterError(code: "invalid", message: "Unknown benchmark operation", details: nil))
          return
        }
        let started = Int64(Date().timeIntervalSince1970 * 1_000_000)
        let timestamp = ProcessInfo.processInfo.systemUptime
        var events: [(NSEvent.EventType, UInt16, NSEvent.ModifierFlags, String, String)] = []
        let commandFlags: NSEvent.ModifierFlags = [.command, NSEvent.ModifierFlags(rawValue: 0x8)]
        if flags.contains(.command) { events.append((.flagsChanged, 55, commandFlags, "", "")) }
        if flags.contains(.shift) { events.append((.flagsChanged, 56, flags, "", "")) }
        events.append((.keyDown, code, flags, characters, unmodified))
        events.append((.keyUp, code, flags, characters, unmodified))
        if flags.contains(.shift) { events.append((.flagsChanged, 56, commandFlags, "", "")) }
        if flags.contains(.command) { events.append((.flagsChanged, 55, [], "", "")) }
        for (type, keyCode, modifiers, text, plainText) in events {
          guard let event = NSEvent.keyEvent(
            with: type, location: .zero, modifierFlags: modifiers,
            timestamp: timestamp, windowNumber: window.windowNumber,
            context: nil, characters: text,
            charactersIgnoringModifiers: plainText, isARepeat: false,
            keyCode: keyCode
          ) else {
            result(FlutterError(code: "event", message: "Could not construct native event", details: nil))
            return
          }
          // Only this fixture's application queue/window receives these events.
          NSApp.postEvent(event, atStart: false)
        }
        result([
          "queuedWallMicros": started,
          "responder": window.firstResponder.map { String(describing: type(of: $0)) } ?? "none",
        ])
      case "finish":
        result(nil)
        DispatchQueue.main.async { NSApp.terminate(nil) }
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }
}
