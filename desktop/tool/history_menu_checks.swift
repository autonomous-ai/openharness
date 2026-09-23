// Appended to production native source by check_swarm_titlebar.sh.
// Focused checks remain independent of unrelated menu fixtures.
private struct HistoryCheckFailure: Error { let message: String }
private var historyCheckCount = 0
private func checkHistory(_ value: @autoclosure () -> Bool, _ message: String) throws {
  guard value() else { throw HistoryCheckFailure(message: message) }
  historyCheckCount += 1
}
private final class HistoryCheckMessenger: NSObject, FlutterBinaryMessenger {
  var calls: [FlutterMethodCall] = []
  func send(onChannel channel: String, message: Data?) {
    if let message { calls.append(FlutterStandardMethodCodec.sharedInstance().decodeMethodCall(message)) }
  }
  func send(onChannel channel: String, message: Data?, binaryReply callback: FlutterBinaryReply?) {
    send(onChannel: channel, message: message)
    callback?(FlutterStandardMethodCodec.sharedInstance().encodeSuccessEnvelope(nil))
  }
  func setMessageHandlerOnChannel(_ channel: String, binaryMessageHandler handler: FlutterBinaryMessageHandler?) -> FlutterBinaryMessengerConnection { 1 }
  func cleanUpConnection(_ connection: FlutterBinaryMessengerConnection) {}
}
private extension SwarmTitlebar {
  func closeHistoryForCheck() {
    let delegate: NSMenuDelegate = self
    delegate.menuDidClose?(historyMenu)
  }
  func checkHistoryLifecycle(_ messenger: HistoryCheckMessenger) throws {
    let main = NSMenu()
    for title in ["Harness", "File", "Edit", "View", "Window", "Help"] {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.submenu = NSMenu(title: title)
      main.addItem(item)
    }
    NSApp.mainMenu = main
    configure()
    actionsEnabled = true
    canGoBack = true
    canGoForward = false
    canReopen = true
    let back = historyMenu.items[0]
    let forward = historyMenu.items[1]
    let reopen = historyMenu.items.first { $0.representedObject as? String == "reopen" }!
    let full = historyMenu.items.last!
    var recent: [[String: Any]] = (0..<64).map {
      ["id": "recent-\($0)", "title": "Task \($0)", "machineName": "Fixture", "current": $0 == 0]
    }
    var closed: [[String: Any]] = (0..<24).map {
      ["id": "closed-\($0)", "title": "Closed \($0)", "canReopen": true]
    }
    updateHistory(recent, closed: closed)
    recent[0]["title"] = "Latest title"
    updateHistory(recent, closed: closed)
    try checkHistory(historyMenu.items[0] === back && historyMenu.items[1] === forward && historyMenu.items.last === full,
      "Closed updates retain installed command items")
    try checkHistory(back.keyEquivalent == "[" && forward.keyEquivalent == "]" && full.keyEquivalent == "y",
      "Navigation and full-history shortcuts remain installed while closed")
    try checkHistory(validateMenuItem(back) && !validateMenuItem(forward) && validateMenuItem(reopen),
      "Command availability updates independently of row construction")
    try checkHistory(historyMenu.items.allSatisfy { $0.action != #selector(historyAction(_:)) },
      "Closed updates defer destination rows")
    menuWillOpen(historyMenu)
    let visits = historyMenu.items.filter { $0.action == #selector(historyAction(_:)) }
    let closures = historyMenu.items.filter { $0.action == #selector(closedHistoryAction(_:)) }
    try checkHistory(visits.count == 15 && closures.count == 10, "Opened sections keep their bounds")
    let latest = visits[0]
    try checkHistory(latest.title.hasPrefix("Latest title") && latest.state == .on, "Opening uses the latest coalesced state")
    let row = latest.view as! SwarmHistoryMenuRow
    try checkHistory(historyMenu.minimumWidth > 0 && row.bounds.width == historyMenu.minimumWidth,
      "Opening measures full-width native rows")
    let count = messenger.calls.count
    try checkHistory(row.accessibilityPerformPress() && messenger.calls.count == count + 1 && messenger.calls.last?.method == "historyDestination",
      "Accessible row activation dispatches the real destination")
    actionsEnabled = false
    menuWillOpen(historyMenu)
    try checkHistory(!latest.isEnabled && !row.accessibilityPerformPress(), "A modal disables row and accessibility activation")
    actionsEnabled = true
    menuWillOpen(historyMenu)
    try checkHistory(latest.isEnabled, "Closing the modal restores menu availability")
    recent[0]["title"] = "Changed while open"
    updateHistory(recent, closed: closed)
    try checkHistory(historyMenu.items.contains { $0.title.hasPrefix("Changed while open") }, "Open menus update immediately")
    closeHistoryForCheck()
    let retained = historyMenu.items.first { $0.action == #selector(historyAction(_:)) }!
    updateHistory(recent, closed: closed)
    menuWillOpen(historyMenu)
    try checkHistory(historyMenu.items.contains { $0 === retained }, "Unchanged reopening retains native rows")
    closeHistoryForCheck()
    closed[0]["canReopen"] = false
    updateHistory(recent, closed: closed)
    try checkHistory(!validateMenuItem(closures[0]), "Closed-model changes invalidate stale restore actions immediately")
    updateHistory([])
    try checkHistory(!validateMenuItem(retained), "Removed destinations cannot dispatch from stale rows")
    menuWillOpen(historyMenu)
    try checkHistory(historyMenu.item(withTitle: "No Recent Visits")?.isEnabled == false, "Empty history replaces stale rows")
    closeHistoryForCheck()
    setKeymap(HarnessNativeKeymap(["version": 1, "contexts": ["workspace": [], "terminal": [], "picker": [], "project": []]])!)
    updateHistory(recent)
    menuWillOpen(historyMenu)
    try checkHistory(historyMenu.items.allSatisfy { $0.keyEquivalent.isEmpty }, "Deferred rebuilding preserves effective shortcut unbindings")
    closeHistoryForCheck()
  }
}

private extension SwarmTitlebar {
  // Native component CPU cost only; the process is prohibited from displaying
  // windows. Same input and optimized Swift compilation on both revisions.
  func benchmarkHistoryUpdates() throws {
    let main = NSMenu()
    for title in ["Harness", "File", "Edit", "View", "Window", "Help"] {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.submenu = NSMenu(title: title)
      main.addItem(item)
    }
    NSApp.mainMenu = main
    configure()
    actionsEnabled = true
    var rows: [[String: Any]] = (0..<64).map { index in
      ["id": "agent-\(index)", "title": "Developer task \(index)",
       "machineName": "Fixture machine", "engine": "codex", "current": index == 0]
    }
    let closed: [[String: Any]] = (0..<24).map { index in
      ["id": "closed-\(index)", "title": "Closed task \(index)",
       "machineName": "Fixture machine", "engine": "claude", "canReopen": true]
    }
    var observations: [[String: Any]] = []
    for operation in ["closed_history_update", "update_then_open_history"] {
      for sample in -20..<200 {
        rows[0]["current"] = sample % 2 == 0
        rows[1]["current"] = sample % 2 != 0
        let began = DispatchTime.now().uptimeNanoseconds
        var updated: UInt64 = 0
        autoreleasepool {
          updateHistory(rows, closed: closed)
          updated = DispatchTime.now().uptimeNanoseconds
          if operation == "update_then_open_history" {
            menuWillOpen(historyMenu)
            let delegate: NSMenuDelegate = self
            delegate.menuDidClose?(historyMenu)
          }
        }
        observations.append(["operation": operation, "phase": sample < 0 ? "warmup" : "measured",
          "updateMicroseconds": Double(updated - began) / 1000,
          "totalMicroseconds": Double(DispatchTime.now().uptimeNanoseconds - began) / 1000])
      }
    }
    let result: [String: Any] = ["success": true, "kind": "optimized_swift_native_history_cpu",
      "boundary": "updateHistory and optional menuWillOpen including autorelease cleanup; excludes OS input, Flutter, display presentation",
      "historyEntries": 64, "closedEntries": 24, "measuredSamplesPerOperation": 200,
      "sourceRevision": ProcessInfo.processInfo.environment["HARNESS_PERF_REVISION"] ?? "unspecified",
      "observations": observations]
    let data = try JSONSerialization.data(withJSONObject: result, options: [.prettyPrinted, .sortedKeys])
    if let path = ProcessInfo.processInfo.environment["HARNESS_TITLEBAR_PERF_OUTPUT"] {
      try data.write(to: URL(fileURLWithPath: path), options: [.withoutOverwriting])
    } else {
      print(String(data: data, encoding: .utf8)!)
    }
  }
}

let historyCheckApp = NSApplication.shared
historyCheckApp.setActivationPolicy(.prohibited)
historyCheckApp.appearance = NSAppearance(named: .darkAqua)
let historyCheckWindow = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 700),
  styleMask: [.titled, .closable, .resizable], backing: .buffered, defer: false)
historyCheckWindow.isReleasedWhenClosed = false
private let historyCheckMessenger = HistoryCheckMessenger()
let historyCheckTitlebar = SwarmTitlebar(window: historyCheckWindow, messenger: historyCheckMessenger)
do {
  if CommandLine.arguments.contains("--history-performance") {
    try historyCheckTitlebar.benchmarkHistoryUpdates()
  } else {
    try historyCheckTitlebar.checkHistoryLifecycle(historyCheckMessenger)
    try checkHistory(!historyCheckWindow.isVisible, "Checks never display a window")
    print("History menu checks passed: \(historyCheckCount)")
  }
  historyCheckWindow.close()
} catch {
  fputs("History menu check failed: \(error)\n", stderr)
  exit(1)
}
