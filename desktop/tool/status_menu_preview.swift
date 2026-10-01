// Actual AppKit menu views with synthetic data, independent of account state.
// HARNESS_STATUS_MENU_PREVIEW_DIR=/tmp/harness-menu bash tool/check_swarm_titlebar.sh <flutter> --status-menu-preview
let app = NSApplication.shared
app.setActivationPolicy(.accessory)
app.finishLaunching()
let output = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HARNESS_STATUS_MENU_PREVIEW_DIR"] ?? "/tmp/harness-menu")
try FileManager.default.createDirectory(at: output, withIntermediateDirectories: true)
let timestamp = Date().timeIntervalSince1970 * 1000
func news(_ id: String, _ title: String, _ message: String, tab: String, machine: String, age: Double,
          label: String = "Ready for review") -> [String: Any] {
  ["machineId": machine, "agentId": id, "title": title, "message": message,
   "tabId": tab, "tabName": tab, "machineName": machine, "unread": true,
   "label": label, "activity": ["mark": label == "Needs input" ? "?" : "✓", "label": label, "working": false], "readToken": id, "receivedAt": timestamp - age * 1000]
}
let notifications = [
  news("hn", "hn", "Keep the shell running after detach?", tab: "TUI", machine: "M2", age: 10, label: "Needs input"),
  news("reconnect", "Fix session reconnects", "The reconnect fix is ready for you to try.", tab: "Desktop", machine: "office", age: 120),
  news("menu", "Notification menu", "Message previews and the Working section are ready for review.", tab: "Desktop", machine: "office", age: 300),
]
let working: [[String: Any]] = [
  ["machineId": "office", "agentId": "shortcuts", "title": "Refactor shortcuts", "tabName": "Desktop", "machineName": "office", "unread": false, "startedAt": timestamp - 120_000],
  ["machineId": "M2", "agentId": "resize", "title": "Fix Linux resize", "tabName": "Desktop", "machineName": "M2", "unread": false, "startedAt": timestamp - 480_000],
  ["machineId": "office", "agentId": "tests", "title": "Run integration tests", "tabName": "Tests", "machineName": "office", "unread": false, "startedAt": timestamp - 30_000],
]
let bindings: [[String: Any]] = [
  ["keys": ["cmd+n"], "command": "agent.new", "hint": "⌘N", "repeatable": false, "menuAction": "newAgent"],
  ["keys": ["cmd+o"], "command": "agent.open", "hint": "⌘O", "repeatable": false, "menuAction": "addAgent"],
]
let map = HarnessNativeKeymap(["version": 1, "contexts": ["workspace": bindings, "terminal": [], "picker": [], "project": []]])!

func render(_ name: String, dark: Bool, entries: [[String: Any]], work: [[String: Any]],
            highlight: Bool = false) {
  app.appearance = NSAppearance(named: dark ? .darkAqua : .aqua)
  let status = HarnessStatusMenu(installStatusItem: false, showWindow: {}, emit: { _, _ in })
  status.menu.appearance = app.appearance
  status.updateKeymap(map, context: "workspace")
  func styled(_ row: [String: Any], working: Bool = false) -> [String: Any] {
    var row = row
    var activity = row["activity"] as? [String: Any] ?? ["mark": "⠋", "label": "Working", "working": true]
    let mark = activity["mark"] as? String
    // Terminal status colors may come from a dark theme even in a light menu.
    // The native row adapts these same colors to its own effective appearance.
    activity["color"] = mark == "?" ? 0xffe5e510
      : working ? 0xff11a8cd : 0xff0dbc79
    row["activity"] = activity
    return row
  }
  status.update(["enabled": true, "statusMenuEntries": entries.map { styled($0) },
                 "statusMenuWorkingEntries": work.map { styled($0, working: true) }])
  var captured = false
  let timer = Timer(timeInterval: 0.2, repeats: false) { _ in
    if highlight {
      status.menu(status.menu, willHighlight: status.menu.items.first { $0.identifier?.rawValue == "openStatusHarness" })
    }
    let activeWindow = status.menu.items.compactMap { $0.view?.window }.first
    for window in app.windows where window === activeWindow {
      guard let view = window.contentView, window.frame.height > 100,
            let bitmap = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { continue }
      view.cacheDisplay(in: view.bounds, to: bitmap)
      let composed = NSBitmapImageRep(bitmapDataPlanes: nil,
        pixelsWide: bitmap.pixelsWide, pixelsHigh: bitmap.pixelsHigh,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
        colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
      composed.size = view.bounds.size
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: composed)
      // View caching has no window-server backdrop. Composite on a neutral
      // surface instead of presenting a fake transparency/blur screenshot.
      NSColor(calibratedWhite: dark ? 0.16 : 0.94, alpha: 1).setFill()
      view.bounds.fill()
      let cached = NSImage(size: view.bounds.size)
      cached.addRepresentation(bitmap)
      cached.draw(in: view.bounds, from: .zero, operation: .sourceOver, fraction: 1)
      NSGraphicsContext.restoreGraphicsState()
      try! composed.representation(using: .png, properties: [:])!.write(to: output.appendingPathComponent(name + ".png"))
      print("Rendered \(name): \(view.bounds.size)")
      captured = true
      break
    }
    status.menu.cancelTracking()
  }
  RunLoop.main.add(timer, forMode: .common)
  status.menu.popUp(positioning: nil, at: NSPoint(x: 100, y: 800), in: nil)
  precondition(captured, "The menu must produce an actual native view")
}

render("notification-overview-light", dark: false, entries: notifications, work: working)
render("notification-overview-dark", dark: true, entries: notifications, work: working)
let fullWorking = (0..<7).map { index -> [String: Any] in
  var row = working[index % working.count]
  row["agentId"] = "working-\(index)"
  row["title"] = "\(row["title"] as! String) \(index + 1)"
  return row
}
render("notification-overview-all-working", dark: false, entries: [], work: fullWorking)
render("notification-overview-empty", dark: false, entries: [], work: [])
let long = news("long", String(repeating: "Long session title ", count: 6),
                String(repeating: "A lengthy question that must wrap and then truncate without covering its time or status mark. ", count: 8),
                tab: "Desktop with an unusually long tab name", machine: "Office Mac with a long machine name", age: 180, label: "Needs input")
var offline = notifications[1]
offline["unavailable"] = "Offline"
render("notification-overview-long", dark: false, entries: [long, offline], work: working, highlight: true)
