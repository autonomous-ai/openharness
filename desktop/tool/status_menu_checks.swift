// Appended to the production AppKit source by check_swarm_titlebar.sh --status-menu.
private struct StatusMenuFailure: Error { let message: String }
private var checks = 0
private func check(_ value: @autoclosure () -> Bool, _ message: String) throws {
  guard value() else { throw StatusMenuFailure(message: message) }
  checks += 1
}

private func renderedStatusPixels(_ image: NSImage) -> Data {
  let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
    pixelsWide: Int(image.size.width * 2), pixelsHigh: Int(image.size.height * 2),
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
    colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  bitmap.size = image.size
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  image.draw(in: NSRect(origin: .zero, size: image.size), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  return Data(bytes: bitmap.bitmapData!, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
}

private func fixture(_ agent: String, project: String = "autonomous-harness",
                     tabId: String? = "tab-build", tabName: String = "Build", machine: String = "office",
                     unread: Bool = true, token: String = "first", offline: Bool = false) -> [String: Any] {
  var row: [String: Any] = ["machineId": machine,
    "agentId": agent, "title": agent, "tabName": tabId == nil ? "Other sessions" : tabName, "unread": unread,
    "detail": "Office Mac · \(project)", "machineName": "Office Mac",
    "message": "The reconnect fix is ready for you to try.",
    "receivedAt": Date().timeIntervalSince1970 * 1000 - 120_000,
    "activity": ["mark": unread ? "✓" : "⠋", "label": unread ? "Finished · unread" : "Working",
                 "working": !unread, "color": Int64(0xff11a8cd)]]
  row["tabId"] = tabId
  if unread { row["readToken"] = token; row["label"] = "Finished" }
  if offline { row["unavailable"] = "Offline" }
  return row
}

private extension HarnessStatusMenu {
  func item(_ action: String) -> NSMenuItem {
    menu.items.first { $0.identifier?.rawValue == action ||
      $0.identifier?.rawValue == HarnessKeymapMenu.actionPrefix + action }!
  }
  func row(_ agent: String) -> NSMenuItem {
    menu.items.first { ($0.representedObject as? [String: Any])?["agentId"] as? String == agent }!
  }
  func click(_ item: NSMenuItem) { menu.performActionForItem(at: menu.index(of: item)) }

  func checkActivityLifecycle() throws {
    let running = fixture("Running", unread: false)
    update(["enabled": true, "statusMenuEntries": [], "statusMenuWorkingEntries": [running]])
    let view = row("Running").view as! HarnessStatusMenuRow
    try check(activityTimer == nil && view.activity?.mark == "⠋", "Closed menus have the shared Working mark and no clock")
    menuWillOpen(menu)
    if !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion {
      try check(activityTimer != nil, "Opening Working starts the native clock")
    }
    let rect = view.frame
    let label = view.accessibilityLabel()
    for frame in 0..<10 { view.activityFrame = frame }
    try check(view.frame == rect && view.accessibilityLabel() == label,
              "Animation leaves row geometry and accessibility announcements stable")
    update(["enabled": true, "reduceMotion": true, "statusMenuEntries": [], "statusMenuWorkingEntries": [running]])
    try check(activityTimer == nil && view.activityFrame == 0, "Reduce Motion stops an open menu's animation")
    menuDidClose(menu)
    update(["enabled": true, "statusMenuEntries": [], "statusMenuWorkingEntries": [running]])
    menuWillOpen(menu)
    menuDidClose(menu)
    try check(activityTimer == nil, "Closing the menu releases its clock")
    update([:])
  }
}

_ = NSApplication.shared
var emitted: [(String, Any?)] = []
var reveals = 0
let status = HarnessStatusMenu(installStatusItem: false, showWindow: { reveals += 1 },
                               emit: { emitted.append(($0, $1)) })
do {
  try status.checkActivityLifecycle()
  let yellow = NSColor(srgbRed: 0.9, green: 0.9, blue: 0.06, alpha: 1)
  let lightQuestion = statusMenuActivityColor(yellow, appearance: NSAppearance(named: .aqua)!).usingColorSpace(.sRGB)!
  let darkQuestion = statusMenuActivityColor(yellow, appearance: NSAppearance(named: .darkAqua)!).usingColorSpace(.sRGB)!
  try check(lightQuestion.redComponent < 0.4 && lightQuestion.greenComponent < 0.4 &&
            abs(darkQuestion.redComponent - yellow.redComponent) < 0.001,
            "The same question hue darkens on a light menu and stays bright on a dark menu")
  let monochrome = statusMenuActivityColor(.white, appearance: NSAppearance(named: .aqua)!).usingColorSpace(.sRGB)!
  try check(abs(monochrome.redComponent - monochrome.greenComponent) < 0.001 &&
            abs(monochrome.greenComponent - monochrome.blueComponent) < 0.001,
            "Adapting menu contrast preserves the monochrome preference")
  var rows = [fixture("General chat conversation"),
              fixture("DeepSeek model", project: "No Project", unread: false),
              fixture("Math addition inquiry", project: "No Project", tabId: nil, offline: true)]
  status.update(["enabled": true, "statusMenuEntries": rows])
  try check(status.menu.items.filter { $0.identifier?.rawValue == "openStatusHarness" }.count == 2,
            "One row per unread session")
  try check((status.row("General chat conversation").view?.frame.height ?? 0) >= 50 &&
            (status.row("General chat conversation").view?.frame.height ?? 0) <= 70 &&
            status.row("General chat conversation").view?.accessibilityLabel()?.contains("reconnect fix") == true,
            "Compact rows expose the actual message to accessibility")
  try check(status.item("clearStatusNotifications").view?.accessibilityLabel()?.contains("Ready (2)") == true &&
            !status.menu.items.contains { $0.title == "Build" }, "One notification section replaces tab headings")
  try check(!status.row("Math addition inquiry").isEnabled, "Offline conversations stay visible but disabled")
  try check(status.row("Math addition inquiry").toolTip?.contains("Offline") == true, "Unavailable state is explained")
  try check(!status.menu.items.contains { $0.title == "DeepSeek model" }, "Read conversations are absent from the notification menu")
  status.click(status.row("General chat conversation"))
  try check(emitted.last?.0 == "openStatusHarness" && reveals == 0, "Navigation is sent before revealing the window")
  status.click(status.item("newAgent"))
  status.click(status.item("addAgent"))
  try check(emitted.suffix(2).map { $0.0 } == ["newAgent", "addAgent"] && reveals == 2,
            "New and Open Harness reveal the window and reuse existing actions")
  try check(!status.menu.items.contains { $0.identifier?.rawValue == "settings" } &&
            status.item("quit").title == "Quit", "Settings is absent and the exit command is simply Quit")

  status.menuWillOpen(status.menu)
  let selected = status.row("General chat conversation")
  let before = emitted.count
  rows[0] = fixture("General chat conversation", token: "newer")
  rows.append(fixture("New result", project: "website", tabId: "tab-website", tabName: "Website"))
  status.update(["enabled": true, "statusMenuEntries": rows])
  try check(status.row("General chat conversation") === selected &&
            !status.menu.items.contains { $0.title == "New result" }, "Arrivals do not move open-menu rows")
  status.click(selected)
  try check(emitted.count == before, "A replaced notification cannot dispatch an old click")
  status.click(status.item("clearStatusNotifications"))
  let receipt = emitted.last?.1 as? [String: Any]
  let cleared = receipt?["receipts"] as? [[String: Any]]
  try check(emitted.last?.0 == "clearStatusNotifications" && cleared?.count == 2 &&
            cleared?.first?["readToken"] as? String == "first", "Clear sends only displayed receipts, never new arrivals")
  status.menuDidClose(status.menu)
  status.menuNeedsUpdate(status.menu)
  try check(status.menu.items.contains { $0.title == "New result" }, "The next opening shows new arrivals")

  status.menuWillOpen(status.menu)
  let originalLocation = status.row("General chat conversation")
  rows[0]["tabId"] = "tab-review"
  rows[0]["tabName"] = "Review"
  status.update(["enabled": true, "statusMenuEntries": rows])
  status.click(originalLocation)
  let originalReceipt = emitted.last?.1 as? [String: Any]
  try check(emitted.last?.0 == "openStatusHarness" && originalReceipt?["tabId"] as? String == "tab-build",
            "A current notification retains its displayed destination when tabs change")
  try check(status.row("General chat conversation").toolTip?.contains("Build") == true,
            "Tab context does not move under the pointer")
  status.menuDidClose(status.menu)
  status.menuNeedsUpdate(status.menu)
  try check(status.row("General chat conversation").toolTip?.contains("Review") == true,
            "The next opening reflects the new tab context")

  status.update(["enabled": false, "statusMenuEntries": rows])
  try check(!status.item("newAgent").isEnabled && !status.item("addAgent").isEnabled &&
            !status.item("clearStatusNotifications").isEnabled, "A modal disables workspace actions")
  status.click(status.item("openWindow"))
  try check(reveals == 3, "Show Harness remains available during a modal")
  status.update(["enabled": true, "statusMenuEntries": []])
  try check(status.menu.items.contains { $0.title == "All caught up" } &&
            !status.item("clearStatusNotifications").isEnabled &&
            !status.menu.items.contains { $0.identifier?.rawValue == "workingHeading" },
            "An empty inbox is explicit, cannot be cleared and has no empty Working section")
  let open = status.menu.items.first { $0.title == "Open Harness…" }!
  status.click(open)
  try check(emitted.last?.0 == "addAgent" && reveals == 4,
            "Open Harness reveals the window and opens the existing-session picker even with no notifications")
  let beforeShow = emitted.count
  status.click(status.menu.items.first { $0.title == "Show Harness" }!)
  try check(reveals == 5 && emitted.count == beforeShow,
            "Show Harness only reveals the app, without opening a picker")
  status.update([:])
  try check(!status.menu.items.contains { $0.identifier?.rawValue == "openStatusHarness" }, "Sign-out removes all conversation data")
  try check(status.item("openWindow").isEnabled && status.item("quit").isEnabled &&
            !status.item("addAgent").isEnabled,
            "The signed-out menu still offers Show and Quit, but cannot open the session picker")
  // Exercise the actual AppKit status button: the displayed number must agree
  // with the notification rows, with a bare icon after the last read.
  func checkCounter() throws {
    let assets = URL(fileURLWithPath: ProcessInfo.processInfo.environment["HARNESS_TITLEBAR_ASSETS"]!)
    let logo = NSImage(contentsOf: assets.deletingLastPathComponent().appendingPathComponent(
      "macos/Runner/Assets.xcassets/HarnessStatusIcon.imageset/HarnessStatusIcon.svg"))
    try check(logo != nil, "The menu bar template loads from the Harness artwork")
    logo?.setName("HarnessStatusIcon")
    let indicator = HarnessStatusMenu(showWindow: {}, emit: { _, _ in })
    indicator.update(["enabled": true, "statusMenuEntries": rows,
                      "statusMenuWorkingEntries": [fixture("Running", unread: false)]])
    try check(indicator.statusItem?.button?.title == "" &&
              indicator.statusItem?.button?.image?.accessibilityDescription == "3 unread" &&
              indicator.statusItem?.button?.image?.isTemplate == true &&
              indicator.statusItem?.button?.accessibilityValue() as? String == "3 unread",
              "The badge counts notifications only, never working sessions")
    let unreadPixels = renderedStatusPixels(indicator.statusItem!.button!.image!)
    indicator.update(["enabled": true, "statusMenuEntries": []])
    try check(indicator.statusItem?.button?.image?.accessibilityDescription == "0 unread" &&
              indicator.statusItem?.button?.toolTip == "Harness · 0 unread" &&
              indicator.statusItem?.button?.accessibilityValue() as? String == "0 unread",
              "An empty inbox keeps its exact count in the tooltip and accessibility value")
    let zeroPixels = renderedStatusPixels(indicator.statusItem!.button!.image!)
    let badgeSize = indicator.statusItem?.button?.image?.size
    indicator.update(["enabled": true, "statusMenuEntries": (0..<101).map { fixture("Task \($0)") }])
    try check(indicator.statusItem?.button?.image?.size == badgeSize &&
              indicator.statusItem?.button?.accessibilityValue() as? String == "101 unread",
              "Large counts keep the logo and badge footprint and expose the exact value to accessibility")
    indicator.update([:])
    try check(indicator.statusItem?.button?.image?.accessibilityDescription == "Harness",
              "Sign-out clears the account's counter")
    let plainPixels = renderedStatusPixels(indicator.statusItem!.button!.image!)
    try check(zeroPixels == plainPixels,
              "Zero notifications render only the plain icon, without a number or badge circle")
    try check(unreadPixels != plainPixels,
              "Unread notifications add a visible badge to the icon")
  }
  try checkCounter()
  status.update(["enabled": true, "statusMenuEntries": [
    fixture("API result", tabId: "tab-one", tabName: "Work"),
    fixture("Website result", project: "website", tabId: "tab-one", tabName: "Work", machine: "laptop"),
    fixture("Review result", tabId: "tab-two", tabName: "Work"),
    fixture("Background result", tabId: nil),
  ]])
  try check(status.menu.items.filter { $0.identifier?.rawValue == "openStatusHarness" }.map { $0.title } ==
            ["API result", "Website result", "Review result", "Background result"],
            "Notifications retain Dart's urgency and time order across tabs")
  try check(status.row("Website result").toolTip?.contains("website") == true,
            "Project context remains available in the row tooltip")

  var working = (0..<7).map { fixture("Working \($0)", unread: false) }
  status.update(["enabled": true, "statusMenuEntries": (0..<8).map { fixture("News \($0)") },
                 "statusMenuWorkingEntries": working])
  try check(status.menu.items.filter { $0.identifier?.rawValue == "openStatusHarness" && !$0.isHidden }.count == 12 &&
            status.item("notificationInbox").title == "View all 8 notifications…",
            "Every working session is inline, alongside the notification inbox route")
  let heading = status.item("workingHeading")
  try check(heading.title == "Working (7)" && !heading.isEnabled && heading.action == nil &&
            heading.view?.accessibilityRole() == .staticText && heading.view?.accessibilityLabel() == "Working (7)" &&
            heading.view?.accessibilityPerformPress() == false,
            "Working is a static heading, with no disclosure action or accessibility hint")
  try check(working.allSatisfy { !status.row($0["agentId"] as! String).isHidden } &&
            status.menu.items.allSatisfy { $0.submenu == nil } &&
            !status.menu.items.contains { ["toggleWorking", "moreWorking"].contains($0.identifier?.rawValue ?? "") },
            "All working rows are visible with no overflow menu")
  status.menuWillOpen(status.menu)
  let workingRow = status.row("Working 0")
  let beforeWorking = emitted.count
  working.removeFirst()
  status.update(["enabled": true, "statusMenuEntries": [fixture("Newer news")], "statusMenuWorkingEntries": working])
  status.click(workingRow)
  try check(emitted.count == beforeWorking, "A session that stopped working cannot dispatch a stale working click")
  try check(status.menu.items.contains { $0.title == "News 0" } &&
            !status.menu.items.contains { $0.title == "Newer news" },
            "Live updates preserve the open notification snapshot")
  let currentWorking = status.row("Working 1")
  try check(currentWorking.view?.accessibilityPerformPress() == true && emitted.last?.0 == "openStatusHarness" &&
            (emitted.last?.1 as? [String: Any])?["unread"] as? Bool == false,
            "Working rows navigate with a distinct non-notification receipt")
  status.menuDidClose(status.menu)
  status.menuNeedsUpdate(status.menu)
  status.update([:])
  try check(!status.menu.items.contains { $0.identifier?.rawValue == "workingHeading" },
            "Sign-out removes working data as well as unread messages")
  let bindings: [[String: Any]] = [
    ["keys": ["cmd+shift+k"], "command": "agent.open", "hint": "⇧⌘K", "repeatable": false, "menuAction": "addAgent"],
  ]
  let map = HarnessNativeKeymap(["version": 1, "contexts": ["workspace": bindings, "terminal": [], "picker": [], "project": []]])!
  status.updateKeymap(map, context: "workspace")
  status.update(["enabled": true, "statusMenuEntries": []])
  try check(status.item("addAgent").keyEquivalent == "k" &&
            status.item("addAgent").keyEquivalentModifierMask == [.command, .shift] &&
            status.item("newAgent").keyEquivalent.isEmpty,
            "Footer shortcuts follow remapping and unbinding, including after a rebuild")
  status.click(status.item("addAgent"))
  try check(emitted.last?.0 == "addAgent", "Keymap identifiers preserve the existing Open Harness action")
  print("Harness status menu passed \(checks) checks")
} catch {
  fputs("Harness status menu failed: \(error)\n", stderr)
  exit(1)
}
