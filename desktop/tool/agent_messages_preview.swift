// Agent Messages' tab states, drawn by the actual AppKit title bar and menus
// with synthetic tabs (docs/design/2026-10-10-agent-messages.md). The window is
// never shown; no Flutter, daemon, account or saved app data is involved.
// HARNESS_AGENT_MESSAGES_PREVIEW_DIR=<dir> bash tool/check_swarm_titlebar.sh <flutter> --agent-messages-preview
private final class PreviewMessenger: NSObject, FlutterBinaryMessenger {
  private var handlers: [String: FlutterBinaryMessageHandler] = [:]
  func send(onChannel channel: String, message: Data?) {}
  func send(onChannel channel: String, message: Data?, binaryReply callback: FlutterBinaryReply?) {
    callback?(FlutterStandardMethodCodec.sharedInstance().encodeSuccessEnvelope(nil))
  }
  func setMessageHandlerOnChannel(_ channel: String, binaryMessageHandler handler: FlutterBinaryMessageHandler?) -> FlutterBinaryMessengerConnection {
    handlers[channel] = handler
    return 1
  }
  func cleanUpConnection(_ connection: FlutterBinaryMessengerConnection) {}
  func receive(_ method: String, _ arguments: [String: Any]) {
    let message = FlutterStandardMethodCodec.sharedInstance().encode(
      FlutterMethodCall(methodName: method, arguments: arguments))
    handlers["harness/swarm_tabs"]!(message) { _ in }
  }
}

private extension SwarmTitlebar {
  var previewStrip: SwarmTabStrip { strip }
}

private extension SwarmTabStrip {
  var previewTabs: [SwarmTabButton] { tabs }
}

private extension SwarmTabButton {
  var previewMenu: NSMenu? { menu }
  func previewPointOnMessages() { messagesButton.mouseEntered(with: previewHover) }
}

private let previewHover = NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [],
  timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!

private struct PreviewTab {
  let id: String
  var messages: Bool?
  var flowing = false
  var activity: ((Bool) -> [String: Any])? = nil
}

private let previewOutput = URL(fileURLWithPath:
  ProcessInfo.processInfo.environment["HARNESS_AGENT_MESSAGES_PREVIEW_DIR"] ?? "/tmp/harness-agent-messages")
private let previewApp = NSApplication.shared
previewApp.setActivationPolicy(.accessory)
previewApp.finishLaunching()
try! FileManager.default.createDirectory(at: previewOutput, withIntermediateDirectories: true)

// A stock app menu bar, as Flutter's nib provides, for the title bar to fill in.
let previewMainMenu = NSMenu(title: "Main")
for title in ["Harness", "File", "Edit", "View", "Window", "Help"] {
  let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
  item.submenu = NSMenu(title: title)
  previewMainMenu.addItem(item)
}
previewApp.mainMenu = previewMainMenu

// HarnessPalette.graphite (the default) and HarnessPalette.paper.
private let previewPalettes: [(String, [String: Any])] = [
  ("dark", ["tabBar": Int64(0xff1c1c1c), "workspace": Int64(0xff282828), "search": Int64(0xff2c2c2c),
            "accent": Int64(0xffbdcbdc), "foreground": Int64(0xfff5f5f5), "dark": Int64(1)]),
  ("light", ["tabBar": Int64(0xffeeeeec), "workspace": Int64(0xffe6e6e3), "search": Int64(0xffe2e2df),
             "accent": Int64(0xff3d5a8a), "foreground": Int64(0xff1f1f1d), "dark": Int64(0)]),
]
// Status marks take the pane's terminal colors; these are a dark and a light terminal's.
private func mark(_ glyph: String, _ label: String, dark: Int64, light: Int64) -> (Bool) -> [String: Any] {
  { isDark in ["mark": glyph, "label": label, "working": glyph == "⠋", "color": isDark ? dark : light] }
}
// darkTerminalTheme and lightTerminalTheme (lib/terminal/terminal_theme.dart).
private let working = mark("⠋", "Working", dark: 0xff11a8cd, light: 0xff1b7c83)
private let needsInput = mark("?", "Needs your input", dark: 0xffe5e510, light: 0xff4d2d00)
private let ready = mark("✓", "Finished · unread", dark: 0xff0dbc79, light: 0xff116329)
// AppPalette.accentOnSurface: AppDesktop.focusDark, and the accent in light.
private func messagesInk(_ dark: Bool) -> Int64 { dark ? 0xff8ba9ff : 0xff2f5bea }

private func previewWindow(width: CGFloat, palette: [String: Any], tabs: [PreviewTab], active: String,
                           activeMessages: Bool?) -> (NSWindow, SwarmTitlebar) {
  let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: width, height: 200),
    styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
  window.isReleasedWhenClosed = false
  window.contentView = NSView(frame: NSRect(x: 0, y: 0, width: width, height: 200))
  let messenger = PreviewMessenger()
  let titlebar = SwarmTitlebar(window: window, messenger: messenger, installStatusItem: false)
  messenger.receive("configure", ["palette": palette])
  let rows: [[String: Any]] = tabs.map { tab in
    var row: [String: Any] = ["id": tab.id, "name": tab.id, "label": tab.id]
    if let messages = tab.messages {
      row["agentMessages"] = messages
      row["agentMessagesFlowing"] = tab.flowing
    }
    if let activity = tab.activity { row["activity"] = activity(palette["dark"] as? Int64 == 1) }
    return row
  }
  var state: [String: Any] = ["enabled": true, "activeId": active, "tabs": rows, "palette": palette,
    "footerCovered": true, "agentMessagesInk": messagesInk(palette["dark"] as? Int64 == 1)]
  if let activeMessages { state["activeAgentMessages"] = activeMessages }
  messenger.receive("update", state)
  window.layoutIfNeeded()
  return (window, titlebar)
}

private func capture(_ window: NSWindow, _ name: String, height: CGFloat = 40, width: CGFloat? = nil) {
  let frame = window.contentView!.superview!
  frame.layoutSubtreeIfNeeded()
  let rect = NSRect(x: 0, y: frame.bounds.height - height, width: width ?? frame.bounds.width, height: height)
  let bitmap = frame.bitmapImageRepForCachingDisplay(in: rect)!
  frame.cacheDisplay(in: rect, to: bitmap)
  try! bitmap.representation(using: .png, properties: [:])!
    .write(to: previewOutput.appendingPathComponent(name + ".png"))
  print("Rendered \(name): \(Int(rect.width))x\(Int(rect.height))pt")
}

/// A menu as AppKit pops it: shown for a moment at a screen corner and drawn
/// from its own window, then dismissed. Nothing is chosen.
private func captureMenu(_ menu: NSMenu, _ name: String, dark: Bool) {
  previewApp.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
  menu.appearance = previewApp.appearance
  let before = Set(previewApp.windows.map(ObjectIdentifier.init))
  var captured = false
  let timer = Timer(timeInterval: 0.25, repeats: false) { _ in
    defer { menu.cancelTracking() }
    for window in previewApp.windows where !before.contains(ObjectIdentifier(window)) {
      guard let view = window.contentView, window.frame.height > 40,
            let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
      view.cacheDisplay(in: view.bounds, to: bitmap)
      let composed = NSBitmapImageRep(bitmapDataPlanes: nil,
        pixelsWide: bitmap.pixelsWide, pixelsHigh: bitmap.pixelsHigh,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
      composed.size = view.bounds.size
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: composed)
      // View caching has no window-server backdrop; compose on a neutral surface.
      NSColor(calibratedWhite: dark ? 0.16 : 0.94, alpha: 1).setFill()
      view.bounds.fill()
      let cached = NSImage(size: view.bounds.size)
      cached.addRepresentation(bitmap)
      cached.draw(in: view.bounds, from: .zero, operation: .sourceOver, fraction: 1)
      NSGraphicsContext.restoreGraphicsState()
      try! composed.representation(using: .png, properties: [:])!
        .write(to: previewOutput.appendingPathComponent(name + ".png"))
      print("Rendered \(name): \(view.bounds.size)")
      captured = true
      break
    }
  }
  RunLoop.main.add(timer, forMode: .common)
  menu.popUp(positioning: nil, at: NSPoint(x: 40, y: 900), in: nil)
  if !captured { print("No menu window for \(name)") }
}

private let lampTabs: [PreviewTab] = [
  PreviewTab(id: "lamp", messages: true, activity: working),
  PreviewTab(id: "desktop", messages: true, activity: ready),
  PreviewTab(id: "website", messages: false, activity: needsInput),
  PreviewTab(id: "notes", messages: false),
]

for (theme, palette) in previewPalettes {
  let dark = theme == "dark"
  func scene(_ name: String, tabs: [PreviewTab] = lampTabs, width: CGFloat = 1280, crop: CGFloat? = nil,
             after: (SwarmTabStrip) -> Void = { _ in }, _ act: (SwarmTabStrip) -> Void = { _ in }) {
    let (window, titlebar) = previewWindow(width: width, palette: palette, tabs: tabs, active: "lamp",
      activeMessages: tabs.first?.messages)
    act(titlebar.previewStrip)
    titlebar.previewStrip.layoutSubtreeIfNeeded()
    window.contentView!.superview!.layoutSubtreeIfNeeded()
    // A hidden window's strip holds its animation at frame 0 on layout.
    after(titlebar.previewStrip)
    capture(window, "\(name)-\(theme)", width: crop)
    window.close()
  }
  var messaging = lampTabs
  messaging[0].flowing = true
  scene("01-rest-quiet")
  // The status slot's two frames: 💬, then mirrored half a second later.
  scene("02-rest-messaging", tabs: messaging)
  scene("02b-rest-messaging-next-frame", tabs: messaging, after: { $0.previewTabs[0].activityFrame = 5 })
  // The animation, frame by frame, for the review page to play: messaging's
  // two sides, then the working spinner's ten frames.
  for frame in [0, 5] {
    scene("anim-messaging-\(frame)", tabs: messaging, crop: 600,
      after: { $0.previewTabs[0].activityFrame = frame })
  }
  for frame in 0..<10 {
    scene("anim-working-\(frame)", crop: 600, after: { $0.previewTabs[0].activityFrame = frame })
  }
  scene("03-hover-off") { $0.previewTabs[2].mouseEntered(with: previewHover) }
  scene("04-hover-on-quiet") { $0.previewTabs[1].mouseEntered(with: previewHover) }
  scene("05-hover-on-messaging", tabs: messaging) { $0.previewTabs[0].mouseEntered(with: previewHover) }
  scene("06-pointer-on-arrows-off") {
    $0.previewTabs[2].mouseEntered(with: previewHover)
    $0.previewTabs[2].previewPointOnMessages()
  }
  let crowded = (1...9).map { index in
    PreviewTab(id: ["lamp", "desktop", "website", "notes", "cli", "backend", "phone", "docs", "infra"][index - 1],
      messages: index % 3 != 0, flowing: index == 1, activity: index % 2 == 0 ? working : nil)
  }
  scene("08-crowded-rest", tabs: crowded, width: 1280)
  scene("09-crowded-hover", tabs: crowded, width: 1280) { $0.previewTabs[1].mouseEntered(with: previewHover) }

  let (window, titlebar) = previewWindow(width: 1280, palette: palette, tabs: messaging, active: "lamp",
    activeMessages: true)
  let tabs = titlebar.previewStrip.previewTabs
  captureMenu(tabs[0].previewMenu!, "10-tab-menu-on-\(theme)", dark: dark)
  captureMenu(tabs[2].previewMenu!, "11-tab-menu-off-\(theme)", dark: dark)
  if let file = previewApp.mainMenu?.item(withTitle: "File")?.submenu {
    captureMenu(file, "12-file-menu-\(theme)", dark: dark)
  }
  window.close()
}
