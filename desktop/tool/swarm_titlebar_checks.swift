
// Appended to SwarmTitlebar.swift by check_swarm_titlebar.sh. Same-file
// extensions can inspect private controls without exposing them in the app API.
private struct TitlebarCheckFailure: Error {
  let message: String
}

private var titlebarCheckCount = 0
private func checkTitlebar(_ condition: @autoclosure () -> Bool, _ message: String) throws {
  guard condition() else { throw TitlebarCheckFailure(message: message) }
  titlebarCheckCount += 1
}

private final class TitlebarMouseUpProbe: NSResponder {
  var mouseUps = 0
  override func mouseUp(with event: NSEvent) { mouseUps += 1 }
}

private extension NSButton {
  func renderedPixels() -> Data {
    let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
      pixelsWide: Int(bounds.width), pixelsHigh: Int(bounds.height),
      bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
      colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
    let count = bitmap.bytesPerRow * bitmap.pixelsHigh
    bitmap.bitmapData!.initialize(repeating: 0, count: count)
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
    draw(bounds)
    NSGraphicsContext.restoreGraphicsState()
    return Data(bytes: bitmap.bitmapData!, count: count)
  }
}

private extension SwarmSubscriptionView {
  // `icon` is private to the row view; a same-file extension reads it without widening the app API.
  var iconImage: NSImage? { icon.image }
  var iconTint: NSColor? { icon.contentTintColor }
}

private extension SwarmTabButton {
  // `label` is private to the tab; a same-file extension reads what it draws.
  var drawnFont: NSFont? { label.attribute(.font, at: 0, effectiveRange: nil) as? NSFont }

  func checkDoubleClickIsolation() throws {
    let parent = nextResponder
    let originalEmit = emit
    let probe = TitlebarMouseUpProbe()
    nextResponder = probe
    var actions: [String] = []
    emit = { method, _ in actions.append(method) }
    defer {
      nextResponder = parent
      emit = originalEmit
      actionsEnabled = true
    }
    func event(_ type: NSEvent.EventType, _ count: Int) -> NSEvent {
      NSEvent.mouseEvent(with: type, location: NSPoint(x: 60, y: 20),
        modifierFlags: [], timestamp: Double(count) / 10, windowNumber: 0,
        context: nil, eventNumber: count, clickCount: count, pressure: 1)!
    }
    selectButton.mouseDown(with: event(.leftMouseDown, 1))
    selectButton.mouseUp(with: event(.leftMouseUp, 1))
    selectButton.mouseDown(with: event(.leftMouseDown, 2))
    // Rename can open a modal before the second mouse-up arrives.
    actionsEnabled = false
    selectButton.mouseUp(with: event(.leftMouseUp, 2))
    mouseUp(with: event(.leftMouseUp, 2))
    try checkTitlebar(actions == ["select", "rename"], "A tab double-click selects and renames exactly once")
    try checkTitlebar(probe.mouseUps == 0,
      "Tab mouse-up events cannot reach the window's titlebar double-click handler")
    try checkTitlebar(!selectButton.mouseDownCanMoveWindow && !closeButton.mouseDownCanMoveWindow,
      "Tab action buttons opt out of automatic window movement")
  }

  func checkAccessibility(expectedName: String, active: Bool) throws {
    try checkTitlebar(accessibilityLabel() == expectedName, "Tab group name is available before paint")
    let children = accessibilityChildren()?.compactMap { $0 as? NSButton } ?? []
    try checkTitlebar(children.count == 2, "Selection and close are separate accessible buttons")
    try checkTitlebar(children[0].accessibilityLabel() == "Select \(expectedName)", "Selection button has current name")
    try checkTitlebar(children[0].accessibilityValue() as? String == (active ? "Selected" : ""), "Selection value is current")
    try checkTitlebar(children[1].accessibilityLabel() == "Close \(expectedName)", "Close button has current name")
  }

  func checkEnabled(_ enabled: Bool) throws {
    try checkTitlebar(selectButton.isEnabled == enabled, "Select button obeys modal state")
    try checkTitlebar(closeButton.isEnabled == enabled, "Close button obeys modal state")
    for item in menu?.items ?? [] {
      try checkTitlebar(validateMenuItem(item) == enabled, "Tab context menu obeys modal state")
    }
  }

  func checkCloseVisibility(_ visible: Bool) throws {
    try checkTitlebar(closeButton.showsGlyph == visible,
      "A tab reveals its close mark only for hover or keyboard focus")
    try checkTitlebar(closeButton.isHidden == compact,
      "Only compact icon-only tabs hide the close control")
    try checkTitlebar(closeButton.accessibilityLabel() == "Close \(name)",
      "The close action retains its accessible label")
  }

  func clickBothActions() {
    selectButton.performClick(nil)
    closeButton.performClick(nil)
  }
}

private extension SwarmTabStrip {
  func checkAgentIdentity() throws {
    func show(_ count: Int, engine: String? = nil) {
      var row: [String: Any] = ["id": "agent-tab", "name": "Login flow", "agentCount": count]
      if let engine { row["engine"] = engine }
      update(["tabs": [row], "activeId": "agent-tab", "enabled": true])
    }
    func marks() -> Bool { tabs[0].subviews.contains { $0 is NSImageView } }
    show(1, engine: "claude")
    let tab = tabs[0]
    try checkTitlebar(!marks(), "A tab of one harness is its name alone, without the engine's mark")
    show(2)
    try checkTitlebar(tabs[0] === tab && !marks(), "A tab of several harnesses is its name alone, and keeps the tab control")
    show(0)
    try checkTitlebar(tabs[0] === tab && !marks(), "An empty tab is its name alone")
  }

  func checkSharedTypography() throws {
    let menuFont = NSFont.menuFont(ofSize: 0)
    let system = NSFont.systemFont(ofSize: NSFont.systemFontSize)
    update(["tabs": [["id": "font-tab", "name": "Typography"]], "activeId": "font-tab", "enabled": true])
    let tab = tabs[0]
    try checkTitlebar(tab.labelFont.pointSize == system.pointSize && tab.labelFont.familyName == system.familyName,
      "A tab is named in the system face, like every other Mac window's tabs")
    update(["tabs": [["id": "font-tab", "name": "Typography"], ["id": "other-tab", "name": "Other"]],
      "activeId": "font-tab", "enabled": true])
    let selectedFont = tabs[0].drawnFont
    let restingFont = tabs[1].drawnFont
    try checkTitlebar(selectedFont != nil && selectedFont == restingFont,
      "The selected tab keeps the same weight; its fill and ink mark it")
    try checkTitlebar(storeButton.font?.pointSize == system.pointSize && storeButton.font?.familyName == system.familyName,
      "The Store action beside the tabs takes the same face")
    try checkTitlebar(tab.menu?.font.familyName == menuFont.familyName && tab.menu?.font.pointSize == menuFont.pointSize,
      "Native tab menu keeps the system menu font")
    let history = SwarmHistoryEntry(["id": "font", "title": "Project", "machineName": "Machine"])!
    let font = history.menuTitle().attribute(.font, at: 0, effectiveRange: nil) as! NSFont
    try checkTitlebar(font == menuFont, "Native history keeps the system menu font")
    let item = NSMenuItem()
    let row = SwarmHistoryMenuRow(item: item, entry: history, width: 400)
    try checkTitlebar(row.machineFrame.minY >= 0 && row.machineFrame.maxY <= row.bounds.height,
      "Native history text fits its row")
  }

  func checkStartupPalette(_ expected: SwarmNativePalette) throws {
    try checkTitlebar(palette == expected && newButton.contentTintColor == expected.accent && sessionsButton.contentTintColor == sessionsButton.iconTint,
      "Initial search and new-swarm colors use the saved palette")
    try checkTitlebar(tabs.isEmpty && !actionsEnabled && !newButton.isEnabled && !sessionsButton.isEnabled,
      "Initial palette setup does not create or enable workspace controls")
  }

  func checkWindowGeometry(_ window: NSWindow) throws {
    let stripFrame = convert(bounds, to: nil)
    let close = window.standardWindowButton(.closeButton)!
    let zoom = window.standardWindowButton(.zoomButton)!
    let closeFrame = close.convert(close.bounds, to: nil)
    let zoomFrame = zoom.convert(zoom.bounds, to: nil)
    let newFrame = newButton.convert(newButton.bounds, to: nil)
    try checkTitlebar(bounds.height >= 40, "Native title bar leaves room around the pill actions")
    for button in [storeButton] {
      let labelWidth = (button.title as NSString).size(withAttributes: [.font: button.font!]).width
      try checkTitlebar(button.frame.minY >= 6 && bounds.height - button.frame.maxY >= 6 && button.frame.width - labelWidth >= 32,
        "\(button.title) has vertical breathing room and readable horizontal padding")
    }
    // 10, which is where a Mac app starts its first control after the buttons: Safari's sidebar
    // toggle and Chrome's first tab both sit about there. It was 12 while the notifications bell
    // still led the strip.
    try checkTitlebar(stripFrame.minX >= zoomFrame.maxX + 10 && stripFrame.minX <= zoomFrame.maxX + 12,
      "Tab row starts a Mac-standard gap after the native traffic lights")
    try checkTitlebar(abs(newFrame.midY - closeFrame.midY) <= 1, "Tab controls align vertically with native traffic lights")
    try checkTitlebar(abs(stripFrame.minY - window.contentLayoutRect.maxY) <= 1, "Tab row meets content without a second toolbar row")
    try checkActiveVisible()
  }

  func checkActiveVisible() throws {
    guard let active = tabs.first(where: { $0.swarmId == activeId }) else {
      throw TitlebarCheckFailure(message: "Selected tab exists")
    }
    let visible = scroll.documentVisibleRect
    try checkTitlebar(active.frame.minX >= visible.minX - 1, "Selected tab's leading edge is visible after layout")
    try checkTitlebar(active.frame.maxX <= visible.maxX + 1, "Selected tab's trailing edge is visible after layout")
  }

  func runChecks() throws {
    let rows = (0..<24).map { ["id": "swarm-\($0)", "name": "Swarm \($0)"] }
    var events: [String] = []
    emit = { method, _ in events.append(method) }
    func state(_ rows: [[String: String]], active: String, enabled: Bool = true) -> [String: Any] {
      ["tabs": rows, "activeId": active, "enabled": enabled, "attention": 2]
    }
    update(state(rows, active: "swarm-11"))
    try tabs[0].checkDoubleClickIsolation()
    let hover = NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [],
      timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
    func click(_ count: Int, at point: NSPoint, time: TimeInterval) -> NSEvent {
      NSEvent.mouseEvent(with: .leftMouseDown, location: point, modifierFlags: [],
        timestamp: time, windowNumber: 0, context: nil, eventNumber: count,
        clickCount: count, pressure: 1)!
    }
    try checkTitlebar(!ownsBackgroundDoubleClick(click(2, at: NSPoint(x: 40, y: 20), time: 1)),
      "A second click displaced from a closed tab cannot zoom the window")
    try checkTitlebar(!ownsBackgroundDoubleClick(click(1, at: NSPoint(x: 40, y: 20), time: 2)),
      "The first titlebar-background click starts a local sequence")
    try checkTitlebar(ownsBackgroundDoubleClick(click(2, at: NSPoint(x: 40, y: 20), time: 2.1)),
      "A double-click wholly on titlebar background still zooms the window")
    try checkTitlebar(tabs[0].showsDivider && tabs[1].showsDivider, "Idle neighboring tabs have separators")
    try tabs[1].checkCloseVisibility(false)
    tabs[1].mouseEntered(with: hover)
    try tabs[1].checkCloseVisibility(true)
    try tabs[0].checkCloseVisibility(false)
    try checkTitlebar(!tabs[0].showsDivider && !tabs[1].showsDivider, "Hover clears separators on both sides of the tab")
    tabs[1].mouseExited(with: hover)
    try tabs[1].checkCloseVisibility(false)
    try checkTitlebar(tabs[0].showsDivider && tabs[1].showsDivider, "Separators return when the pointer leaves")
    try checkTitlebar(!tabs[10].showsDivider && !tabs[11].showsDivider, "Selected tab remains joined without neighboring separators")
    try checkTitlebar(tabs.count == 24, "All overflow tabs exist")
    try checkTitlebar(newButton.isEnabled, "New Tab remains available with overflow tabs")
    for (index, tab) in tabs.enumerated() {
      try tab.checkAccessibility(expectedName: "Swarm \(index)", active: index == 11)
    }
    try checkActiveVisible()
    scroll.contentView.scroll(to: .zero)
    scroll.reflectScrolledClipView(scroll.contentView)
    let browsingOrigin = scroll.documentVisibleRect.origin
    var refreshed = state(rows, active: "swarm-11")
    var renamedRows = rows
    renamedRows[0]["name"] = "Background task renamed"
    refreshed["tabs"] = renamedRows
    update(refreshed)
    try checkTitlebar(scroll.documentVisibleRect.origin == browsingOrigin,
      "A background title update preserves the tabs the user scrolled to")
    refreshed["palette"] = ["workspace": Int64(0xff252d43)]
    update(refreshed)
    try checkTitlebar(scroll.documentVisibleRect.origin == browsingOrigin,
      "A palette update does not undo manual tab scrolling")
    update(state(rows, active: "swarm-23"))
    try checkActiveVisible()
    setFrameSize(NSSize(width: 320, height: 52))
    needsLayout = true
    layoutSubtreeIfNeeded()
    try checkActiveVisible()

    let original = tabs[0]
    let reversed = Array(rows.reversed())
    update(state(reversed, active: "swarm-0"))
    try checkTitlebar(tabs.last === original, "Reordering retains existing tab controls")
    try checkTitlebar(tabs.map(\.swarmId) == reversed.map { $0["id"]! }, "Tab order follows the saved Swarm order")
    let accessibleTabs = document.accessibilityChildren()?.compactMap { $0 as? SwarmTabButton } ?? []
    try checkTitlebar(accessibleTabs.map(\.swarmId) == tabs.map(\.swarmId), "Accessible tab order follows visual order after reordering")
    try checkActiveVisible()

    update(state([["id": "swarm-0", "name": "Renamed tab"]], active: "swarm-0"))
    try checkTitlebar(tabs.count == 1 && tabs[0] === original, "Closing tabs retains the surviving control")
    try original.checkAccessibility(expectedName: "Renamed tab", active: true)
    try checkTitlebar(newButton.isEnabled, "New Harness returns below capacity")
    var fullWithStarter = state(rows, active: "swarm-0")
    fullWithStarter["canOpenNewTab"] = true
    update(fullWithStarter)
    try checkTitlebar(newButton.isEnabled,
      "New Tab can reveal an existing starter at the tab limit")
    fullWithStarter["canOpenNewTab"] = false
    update(fullWithStarter)
    try checkTitlebar(newButton.isEnabled,
      "The retired canOpenNewTab capacity flag no longer disables New Tab")
    update(state([["id": "swarm-0", "name": "Renamed tab"]], active: "swarm-0"))
    try checkTitlebar(newButton.toolTip == "New Tab ⌘T" && storeButton.toolTip == "Harness Store ⌘S",
      "Titlebar actions expose their keyboard alternatives")
    try checkTitlebar(scroll.frame.minX == 0,
      "The tabs start beside the traffic lights without a separate bell")
    try checkTitlebar(scroll.frame.maxX <= newButton.frame.minX && newButton.frame.maxX <= storeButton.frame.minX,
      "New Tab follows the tabs while the Store stays on the right")
    try checkTitlebar(storeButton.title == "Harness Store" && storeButton.accessibilityLabel() == "Harness Store",
      "The Store action has a visible and accessible name")
    try checkTitlebar(newButton.frame.maxX < sessionsButton.frame.minX && sessionsButton.frame.maxX < storeButton.frame.minX && storeButton.frame.maxX <= bounds.width,
      "Harnesses sits to the left of the Store without overlapping its hit target")
    try checkTitlebar(sessionsButton.accessibilityLabel() == "Harnesses", "Harnesses has an accessible name")
    try checkTitlebar(!subviews.contains(where: { $0 is NSTextField }), "The titlebar has no competing text editor")
    events.removeAll()
    newButton.performClick(nil)
    sessionsButton.performClick(nil)
    storeButton.performClick(nil)
    try checkTitlebar(events == ["new", "sessions", "store"],
      "The tab, Harnesses and Store buttons dispatch once")
    try checkTitlebar(sessionsButton.attention > 0 && sessionsButton.toolTip?.contains("input") == true, "Harnesses represents pending agent attention")
    let originalAttention = sessionsButton.attention
    sessionsButton.attention = 0
    let quietPixels = sessionsButton.renderedPixels()
    try checkTitlebar(sessionsButton.attentionLabel == nil,
      "Running harnesses without questions have no notification badge")
    for count in [1, 6, 42, 100] {
      sessionsButton.attention = count
      let label = sessionsButton.attentionLabel!
      let width = (label as NSString).size(withAttributes: [.font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold)]).width
      let badge = sessionsButton.badgeFrame(textWidth: width)
      try checkTitlebar(sessionsButton.bounds.contains(badge) && badge.maxX == sessionsButton.bounds.maxX &&
        (sessionsButton.isFlipped ? badge.minY == sessionsButton.bounds.minY : badge.maxY == sessionsButton.bounds.maxY),
        "The attention badge stays in the top-right corner and fits at count \(count)")
      try checkTitlebar(sessionsButton.renderedPixels() != quietPixels,
        "Pending questions visibly add a count badge at \(count)")
    }
    try checkTitlebar(sessionsButton.attentionLabel == "99+", "Large attention counts stay compact")
    sessionsButton.attention = originalAttention
    let oldButton = newButton
    var themedState = state([["id": "swarm-0", "name": "Renamed tab"]], active: "swarm-0")
    themedState["palette"] = ["workspace": Int64(0xff252d43), "search": Int64(0xff262f46)]
    update(themedState)
    try checkTitlebar(newButton === oldButton && tabs[0] === original,
      "Palette changes retain native control identity")
    try checkTitlebar(newButton.contentTintColor == palette.accent && sessionsButton.contentTintColor == sessionsButton.iconTint,
      "Toolbar tools stay monochrome when the workspace palette changes")
    events.removeAll()
    try original.checkEnabled(true)
    original.clickBothActions()
    try checkTitlebar(events == ["select", "close"], "Native selection and close dispatch once each")

    let actionPixels = storeButton.renderedPixels()
    events.removeAll()
    update(state([["id": "swarm-0", "name": "Renamed tab"]], active: "swarm-0", enabled: false))
    try original.checkEnabled(false)
    try checkTitlebar(!newButton.isEnabled && !sessionsButton.isEnabled && !storeButton.isEnabled, "Titlebar actions disable with a modal")
    try checkTitlebar(actionPixels != storeButton.renderedPixels(),
      "The Store visibly dims when a workspace modal disables it")
    original.clickBothActions()
    newButton.performClick(nil)
    sessionsButton.performClick(nil)
    storeButton.performClick(nil)
    try checkTitlebar(events.isEmpty, "Disabled controls emit no actions")
    try checkDragOperations()
  }
}

private extension SwarmTabStrip {
  func checkTabKeyboardFocus(_ window: NSWindow, messenger: TitlebarCheckMessenger) throws {
    update(["enabled": true, "activeId": "keyboard-23",
      "tabs": (0..<24).map { ["id": "keyboard-\($0)", "name": "Keyboard \($0)"] }])
    let tab = tabs[0]
    let buttons = tab.accessibilityChildren()!.compactMap { $0 as? NSButton }
    for button in buttons {
      try checkTitlebar(window.makeFirstResponder(button), "An enabled tab action accepts keyboard focus")
      try tab.checkCloseVisibility(true)
      try checkTitlebar(scroll.documentVisibleRect.contains(tab.frame),
        "Keyboard focus reveals the entire overflowed tab and close control")
      try checkTitlebar(activeId == "keyboard-23", "Focusing a tab control does not activate its swarm")
      let before = messenger.calls.count
      messenger.holdReplies = true
      button.performClick(nil)
      try checkTitlebar(window.firstResponder === button,
        "Typing stays out of the old workspace until the tab action is acknowledged")
      messenger.finishNextReply()
      try checkTitlebar(window.firstResponder === window.contentInput,
        "Activating a tab action returns the next key to Flutter content")
      try window.checkContentCommand()
      try tab.checkCloseVisibility(false)
      try checkTitlebar(messenger.calls.count == before + 1, "Each native tab activation sends one action")
    }
    tab.attention = true
    try checkTitlebar(buttons[0].accessibilityHelp()?.contains("needing input") == true,
      "The attention dot has an accessible description")
    tab.attention = false
    try checkTitlebar(buttons[0].accessibilityHelp() == nil, "Resolved attention clears its accessible description")
    try checkTitlebar(window.makeFirstResponder(buttons[0]), "Rename starts from an actual focused control")
    let rename = tab.menu!.items.first!
    NSApp.sendAction(rename.action!, to: rename.target, from: rename)
    messenger.finishNextReply()
    try checkTitlebar(window.firstResponder === window.contentInput && messenger.calls.last?.method == "rename",
      "Renaming gives the Flutter form native keyboard ownership")
    let stale = tab
    update(["enabled": true, "activeId": "survivor", "tabs": [["id": "survivor", "name": "Survivor"]]])
    let beforeStale = messenger.calls.count
    stale.clickBothActions()
    try checkTitlebar(messenger.calls.count == beforeStale, "A removed tab's retained controls cannot dispatch actions")
    let unfocusedNew = newButton.renderedPixels()
    try checkTitlebar(window.makeFirstResponder(newButton), "New swarm accepts keyboard focus")
    try checkTitlebar(newButton.hasKeyboardFocus && newButton.renderedPixels() != unfocusedNew,
      "Keyboard focus gives the new-tab icon the same visible background as hover")
    newButton.performClick(nil)
    messenger.finishNextReply()
    try checkTitlebar(window.firstResponder === window.contentInput && messenger.calls.last?.method == "new",
      "New swarm returns keyboard ownership to the workspace")
    let current = tabs[0].accessibilityChildren()!.first as! NSButton
    window.makeFirstResponder(current)
    current.performClick(nil)
    window.makeFirstResponder(newButton)
    newButton.performClick(nil)
    messenger.finishNextReply()
    try checkTitlebar(window.firstResponder === newButton,
      "A delayed tab reply cannot steal focus from a newer search action")
    messenger.finishNextReply()
    try checkTitlebar(window.firstResponder === window.contentInput,
      "The search button hands the next keystroke to the shared Flutter picker")
    window.makeFirstResponder(current)
    current.performClick(nil)
    current.performClick(nil)
    messenger.finishNextReply()
    try checkTitlebar(window.firstResponder === current, "An older tab action cannot release a newer action's focus")
    messenger.finishNextReply()
    try checkTitlebar(window.firstResponder === window.contentInput,
      "The latest acknowledged tab action restores content focus")
    for (button, method) in [(sessionsButton, "sessions"), (machinesButton, "machineList")] {
      window.makeFirstResponder(button)
      let before = messenger.calls.count
      button.performClick(nil)
      try checkTitlebar(messenger.calls.count == before + 1 && messenger.calls.last?.method == method,
        "The toolbar action dispatches once")
      try checkTitlebar(window.firstResponder === button,
        "The toolbar waits for Flutter's destination focus tree")
      messenger.finishNextReply()
      try checkTitlebar(window.firstResponder === window.contentInput,
        "Harnesses returns keyboard ownership to Flutter")
    }
    messenger.holdReplies = false
  }
}

private final class TitlebarCheckDrag: NSObject, NSDraggingInfo {
  var draggingDestinationWindow: NSWindow?
  var draggingSourceOperationMask: NSDragOperation = .move
  var draggingLocation = NSPoint.zero
  var draggedImageLocation = NSPoint.zero
  var draggedImage: NSImage? { nil }
  let draggingPasteboard = NSPasteboard.withUniqueName()
  var draggingSource: Any?
  var draggingSequenceNumber: Int { 1 }
  var draggingFormation: NSDraggingFormation = .none
  var animatesToDestination = false
  var numberOfValidItemsForDrop = 1
  var springLoadingHighlight: NSSpringLoadingHighlight { .none }
  func slideDraggedImage(to screenPoint: NSPoint) {}
  override func namesOfPromisedFilesDropped(atDestination dropDestination: URL) -> [String]? { nil }
  func resetSpringLoading() {}
  func enumerateDraggingItems(options: NSDraggingItemEnumerationOptions, for view: NSView?, classes: [AnyClass],
    searchOptions: [NSPasteboard.ReadingOptionKey: Any], using block: (NSDraggingItem, Int, UnsafeMutablePointer<ObjCBool>) -> Void) {}
  deinit { draggingPasteboard.releaseGlobally() }
}

private extension SwarmTabStrip {
  func checkDragOperations() throws {
    setFrameSize(NSSize(width: 900, height: 52))
    let rows = (0..<4).map { ["id": "drag-\($0)", "name": "Drag \($0)"] }
    update(["tabs": rows, "activeId": "drag-0", "enabled": true])
    var moves: [[String: Any]] = []
    emit = { method, args in if method == "reorder", let args = args as? [String: Any] { moves.append(args) } }
    let info = TitlebarCheckDrag()
    info.draggingSource = tabs[0]
    info.draggingPasteboard.setString("drag-0", forType: swarmPasteboardType)
    info.draggingLocation = document.convert(NSPoint(x: tabs[2].frame.midX + 1, y: 20), to: nil)
    try checkTitlebar(draggingEntered(info) == .move && draggingUpdated(info) == .move,
      "An owned tab can move within the visible tab area")
    try checkTitlebar(performDragOperation(info) && moves.last?["index"] as? Int == 2,
      "Moving right accounts for removing the source tab first")
    moves.removeAll()
    info.draggingLocation = document.convert(NSPoint(x: tabs[0].frame.midX - 1, y: 20), to: nil)
    try checkTitlebar(performDragOperation(info) && moves.isEmpty, "Dropping in place performs no redundant reorder")
    info.draggingSource = tabs[3]
    info.draggingPasteboard.setString("drag-3", forType: swarmPasteboardType)
    try checkTitlebar(performDragOperation(info) && moves.last?["index"] as? Int == 0,
      "Moving left preserves the requested first position")
    moves.removeAll()
    func rejected(_ reason: String) throws {
      try checkTitlebar(draggingEntered(info).isEmpty && draggingUpdated(info).isEmpty && !performDragOperation(info), reason)
      try checkTitlebar(moves.isEmpty, "Rejected drag emits no reorder")
    }
    info.draggingLocation = convert(NSPoint(x: newButton.frame.midX, y: 20), to: nil)
    try rejected("Search is not a tab drop target")
    info.draggingLocation = document.convert(NSPoint(x: tabs[0].frame.midX, y: 20), to: nil)
    info.draggingSource = SwarmTabButton(id: "drag-3")
    try rejected("A foreign tab with a matching ID cannot reorder this strip")
    info.draggingSource = tabs[3]
    info.draggingSourceOperationMask = .copy
    try rejected("A copy-only source is not advertised as movable")
    info.draggingSourceOperationMask = .move
    info.draggingPasteboard.setString("drag-0", forType: swarmPasteboardType)
    try rejected("The pasteboard identity must match the actual dragged tab")
    info.draggingPasteboard.setString("drag-3", forType: swarmPasteboardType)
    update(["tabs": rows, "activeId": "drag-0", "enabled": false])
    try rejected("A modal rejects a pending tab drop")
    update(["tabs": Array(rows.prefix(3)), "activeId": "drag-0", "enabled": true])
    try rejected("A removed source cannot finish its pending drag")
  }
}

// No engine, account, terminal or transport is involved in native layout.
private final class TitlebarCheckMessenger: NSObject, FlutterBinaryMessenger {
  var calls: [FlutterMethodCall] = []
  private var handlers: [String: FlutterBinaryMessageHandler] = [:]
  var holdReplies = false
  var replies: [FlutterBinaryReply] = []
  func finishNextReply() {
    replies.removeFirst()(FlutterStandardMethodCodec.sharedInstance().encodeSuccessEnvelope(nil))
  }
  func send(onChannel channel: String, message: Data?) {
    if let message { calls.append(FlutterStandardMethodCodec.sharedInstance().decodeMethodCall(message)) }
  }
  func send(onChannel channel: String, message: Data?, binaryReply callback: FlutterBinaryReply?) {
    send(onChannel: channel, message: message)
    if let callback {
      if holdReplies { replies.append(callback) }
      else { callback(FlutterStandardMethodCodec.sharedInstance().encodeSuccessEnvelope(nil)) }
    }
  }
  func setMessageHandlerOnChannel(_ channel: String, binaryMessageHandler handler: FlutterBinaryMessageHandler?) -> FlutterBinaryMessengerConnection {
    handlers[channel] = handler
    return 1
  }
  func receive(_ method: String, arguments: [String: Any]) throws -> Data? {
    guard let handler = handlers["harness/swarm_tabs"] else {
      throw TitlebarCheckFailure(message: "Native channel handler is installed")
    }
    var reply: Data?
    let message = FlutterStandardMethodCodec.sharedInstance().encode(
      FlutterMethodCall(methodName: method, arguments: arguments))
    handler(message) { reply = $0 }
    return reply
  }
  func cleanUpConnection(_ connection: FlutterBinaryMessengerConnection) {}
}

private extension SwarmTitlebar {
  func checkKeymapRuntime(_ fixture: [String: [String: Any]], messenger: TitlebarCheckMessenger) throws {
    guard let window, let defaults = HarnessNativeKeymap(fixture["defaults"]!),
          let changed = HarnessNativeKeymap(fixture["changed"]!) else {
      throw TitlebarCheckFailure(message: "Exported runtime keymaps exist")
    }
    let original = NSApp.mainMenu!
    let edit = original.item(withTitle: "Edit")!.submenu!
    let agent = original.item(withTitle: "File")!.submenu!
    let newSwarm = agent.items.first(where: { $0.representedObject as? String == "new" })!
    let addHarness = agent.items.first(where: { $0.representedObject as? String == "addAgent" })!
    let nativeCopy = NSMenuItem(title: "Copy", action: #selector(NSText.copy(_:)), keyEquivalent: "c")
    edit.addItem(nativeCopy)
    setKeymap(defaults)
    let main = NSApp.mainMenu as! HarnessKeymapMenu
    try checkTitlebar(main !== original && main.item(withTitle: "Edit")?.submenu === edit,
      "The main-menu dispatcher retains the actual Edit submenu and its targets")
    try checkTitlebar(newSwarm.keyEquivalent == "t" && newSwarm.toolTip == nil,
      "Native shortcuts display in the menu without duplicate hover hints")
    try checkTitlebar(addHarness.keyEquivalent == "o" && addHarness.keyEquivalentModifierMask == [.command],
      "The exported keymap keeps Open Harness on Command-O")
    for (action, key) in [("splitRight", "r"), ("splitDown", "d")] {
      let split = agent.items.first(where: { $0.representedObject as? String == action })!
      try checkTitlebar(split.keyEquivalent == key && split.keyEquivalentModifierMask == [.command],
        "The exported keymap preserves the native \(action) shortcut")
    }
    setKeymap(changed)
    try checkTitlebar(NSApp.mainMenu === main && newSwarm.keyEquivalent == "o",
      "Hot reload updates the existing menu to the remapped key")
    try checkTitlebar(nativeCopy.keyEquivalent == "c" && nativeCopy.action == #selector(NSText.copy(_:)),
      "Standard native editing remains intact")
    // The inherited default is still first; a sequence is not falsely shown
    // as a second one-stroke accelerator in AppKit's shortcut column.
    let onlySequence = HarnessNativeKeymap(["version": 1, "contexts": Dictionary(uniqueKeysWithValues:
      HarnessNativeKeymap.contexts.map { ($0, [["keys": ["cmd+k", "n"], "command": "swarm.new",
        "hint": "⌘K N", "repeatable": false, "menuAction": "new"]]) })])!
    setKeymap(onlySequence)
    try checkTitlebar(newSwarm.keyEquivalent.isEmpty && newSwarm.toolTip == nil,
      "Sequences add no hover hints or misleading first-key menu shortcut")
    setKeymap(HarnessNativeKeymap(["version": 1, "contexts": ["workspace": [], "terminal": [], "picker": [], "project": []]])!)
    try checkTitlebar(newSwarm.keyEquivalent.isEmpty && newSwarm.toolTip == nil,
      "Unbinding clears the old native shortcut and hint")
    rebuildHistoryMenu()
    try checkTitlebar(historyMenu.items.allSatisfy { $0.keyEquivalent.isEmpty },
      "Rebuilt History rows retain effective unbindings")
    setKeymap(changed)
    actionsEnabled = true
    func event(_ text: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
      NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
        timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: text,
        charactersIgnoringModifiers: text, isARepeat: false, keyCode: code)!
    }
    let open = event("o", 31, .command)
    let oldOpen = event("t", 17, .command)
    try checkTitlebar(main.defersToInput(open) && !main.defersToInput(oldOpen),
      "The menu yields the remapped search shortcut to Flutter")
    try checkTitlebar(!main.performKeyEquivalent(with: open), "Menu equivalents defer before input dispatch")
    setKeymap(defaults)
    try checkTitlebar(strip.newButton.toolTip == "New Tab ⌘T", "Keymap reload restores the current New Tab hint")
    try checkTitlebar(strip.newButton.accessibilityLabel() == "New Tab", "The plus announces New Tab")
    try checkTitlebar(main.defersToInput(event("n", 45, .command)) && main.defersToInput(event("t", 17, .command)),
      "Command-N and Command-T reach creation and New Tab")
    try checkTitlebar(main.defersToInput(event("p", 35, .command)), "Command-P reaches commands")
    try checkTitlebar(!main.defersToInput(event("p", 35, [.command, .shift])), "Command-Shift-P is unbound")
    try checkTitlebar(main.defersToInput(event("o", 31, .command)), "Command-O reaches Open Harness")
    try checkTitlebar(strip.machinesButton.toolTip == "Machines ⌘M", "Machines advertises its effective shortcut")
    try checkTitlebar(main.defersToInput(event("m", 46, .command)) &&
      !main.performKeyEquivalent(with: event("m", 46, .command)),
      "Command-M reaches Flutter exactly once instead of invoking a native window action")
    try checkTitlebar(!main.defersToInput(event("u", 32, .command)), "Command-U is no longer claimed")
    flutterKeyContext = "picker"
    syncMenuKeys()
    try checkTitlebar(!main.performKeyEquivalent(with: event("\u{f701}", 125)), "Result arrows are owned by the shared picker")
    try checkTitlebar(!main.defersToInput(event("a", 0, .command)), "Standard select-all retains native text-editing dispatch")
  }

  func checkViewerShortcutRuntime(_ defaults: HarnessNativeKeymap, messenger: TitlebarCheckMessenger) throws {
    guard let window else { throw TitlebarCheckFailure(message: "Native viewer test window exists") }
    let originalMenu = NSApp.mainMenu
    let originalKeymap = keymap
    let originalContext = flutterKeyContext
    let originalEnabled = actionsEnabled
    NSApp.mainMenu = NSMenu(title: "Isolated viewer shortcut test")
    defer {
      keymap = originalKeymap
      flutterKeyContext = originalContext
      actionsEnabled = originalEnabled
      NSApp.mainMenu = originalMenu
    }
    actionsEnabled = true
    // Orchestrator has no default chord now. Exercise an explicit user binding;
    // Cmd-P belongs to New Pane and is covered by the exported default keymap.
    let viewerMap = HarnessNativeKeymap(["version": 1, "contexts": [
      "workspace": [["keys": ["cmd+y"], "command": "project.orchestrate", "hint": "⌘Y", "repeatable": false]],
      "terminal": [], "picker": [], "project": [],
    ]])!
    setKeymap(viewerMap)
    let main = NSApp.mainMenu as! HarnessKeymapMenu
    func event(_ text: String, _ code: UInt16, _ flags: NSEvent.ModifierFlags = []) -> NSEvent {
      NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: flags,
        timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: text,
        charactersIgnoringModifiers: text, isARepeat: false, keyCode: code)!
    }
    // Exercise the actual native responder walk, not just the keymap lookup.
    // No navigation, windows shown, app state, or external services are involved.
    let web = WKWebView(frame: NSRect(x: 0, y: 0, width: 320, height: 200))
    let webInput = TitlebarCheckInputView(frame: web.bounds)
    web.addSubview(webInput)
    window.contentViewController!.view.addSubview(web)
    defer { web.removeFromSuperview(); window.makeFirstResponder(window.contentInput) }
    try checkTitlebar(window.makeFirstResponder(webInput), "A native viewer descendant can own test focus")
    flutterKeyContext = "workspace"
    setKeymap(viewerMap)
    let beforeViewer = messenger.calls.count
    try checkTitlebar(main.performKeyEquivalent(with: event("y", 16, .command)),
      "The custom Orchestrator shortcut is consumed by the focused native viewer bridge")
    try checkTitlebar(messenger.calls.count == beforeViewer + 1 && messenger.calls.last?.method == "keymapCommand" &&
      (messenger.calls.last?.arguments as? [String: String])?["command"] == "project.orchestrate",
      "The native viewer dispatches exactly one Orchestrator command to Flutter")
    let repeated = NSEvent.keyEvent(with: .keyDown, location: .zero, modifierFlags: .command,
      timestamp: 0, windowNumber: window.windowNumber, context: nil, characters: "y",
      charactersIgnoringModifiers: "y", isARepeat: true, keyCode: 16)!
    try checkTitlebar(main.performKeyEquivalent(with: repeated) && messenger.calls.count == beforeViewer + 1,
      "Holding the shortcut never launches repeated projects")
    _ = main.performKeyEquivalent(with: event("b", 11, .command))
    try checkTitlebar(messenger.calls.count == beforeViewer + 1, "The viewer bridge does not hijack Command-B")
    actionsEnabled = false
    _ = main.performKeyEquivalent(with: event("y", 16, .command))
    try checkTitlebar(messenger.calls.count == beforeViewer + 1, "Modal state blocks native viewer launch dispatch")
    actionsEnabled = true
    let remapped = HarnessNativeKeymap(["version": 1, "contexts": [
      "workspace": [["keys": ["cmd+x"], "command": "project.orchestrate", "hint": "⌘X", "repeatable": false]],
      "terminal": [], "picker": [], "project": [],
    ]])!
    setKeymap(remapped)
    _ = main.performKeyEquivalent(with: event("y", 16, .command))
    try checkTitlebar(messenger.calls.count == beforeViewer + 1, "The old viewer shortcut stays unbound after remapping")
    try checkTitlebar(main.performKeyEquivalent(with: event("x", 7, .command)) && messenger.calls.count == beforeViewer + 2,
      "The viewer bridge follows the actual remapped two-key shortcut")
    setKeymap(HarnessNativeKeymap(["version": 1, "contexts": ["workspace": [], "terminal": [], "picker": [], "project": []]])!)
    _ = main.performKeyEquivalent(with: event("x", 7, .command))
    try checkTitlebar(messenger.calls.count == beforeViewer + 2, "Unbinding disables viewer launch dispatch")
    setKeymap(defaults)
  }

  func checkNativeContainer(messenger: TitlebarCheckMessenger) throws {
    guard let window else { throw TitlebarCheckFailure(message: "Native test window exists") }
    let main = NSMenu()
    let appItem = NSMenuItem(title: "Harness", action: nil, keyEquivalent: "")
    appItem.submenu = NSMenu(title: "Harness")
    appItem.submenu?.addItem(NSMenuItem(title: "Preferences…", action: nil, keyEquivalent: ","))
    main.addItem(appItem)
    let edit = NSMenuItem(title: "Edit", action: nil, keyEquivalent: "")
    edit.submenu = NSMenu(title: "Edit")
    let find = NSMenuItem(title: "Find", action: nil, keyEquivalent: "")
    find.submenu = NSMenu(title: "Find")
    find.submenu?.addItem(NSMenuItem(title: "Find and Replace…", action: nil, keyEquivalent: "f"))
    edit.submenu?.addItem(find)
    main.addItem(edit)
    for title in ["View", "Window", "Help"] {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.submenu = NSMenu(title: title)
      main.addItem(item)
    }
    NSApp.mainMenu = main
    let startupColors: [String: Any] = [
      "tabBar": Int64(0xff1b2720), "workspace": Int64(0xff2b3b31),
      "search": Int64(0xff293a31), "accent": Int64(0xffb4d8be),
    ]
    let reply = try messenger.receive("configure", arguments: ["palette": startupColors])
    try checkTitlebar(reply == FlutterStandardMethodCodec.sharedInstance().encodeSuccessEnvelope(true),
      "Native configure acknowledges the initial palette synchronously")
    let startupPalette = SwarmNativePalette(startupColors)
    try checkTitlebar(strip.palette == startupPalette && window.backgroundColor == startupPalette.tabBar,
      "The saved palette reaches native chrome before any workspace update")
    try strip.checkStartupPalette(startupPalette)
    configure()
    try checkTitlebar(strip.palette == startupPalette && window.titlebarAccessoryViewControllers.count == 1,
      "Repeated configuration preserves the saved palette and one titlebar accessory")
    _ = try messenger.receive("update", arguments: [
      "tabs": [["id": "startup-check", "name": "Synthetic swarm"]],
      "activeId": "startup-check", "enabled": true, "palette": startupColors,
    ])
    // SwarmScreen.dispose sends this when sign-in or setup takes its place.
    _ = try messenger.receive("update", arguments: ["tabs": [], "enabled": false])
    try checkTitlebar(window.backgroundColor == startupPalette.tabBar,
      "Leaving the workspace preserves the saved native background")
    try strip.checkStartupPalette(startupPalette)
    try window.checkContentCommand()
    try checkTitlebar(window.firstResponder === window.contentInput,
      "Adding toolbar buttons does not take initial keyboard focus from the workspace")
    try checkTitlebar(main.items.map(\.title) == ["Harness", "File", "Edit", "View", "History", "Models", "Window", "Help"], "Machines lives in the toolbar and View menu")
    let settings = appItem.submenu!.items.first { $0.representedObject as? String == "settings" }!
    try checkTitlebar(settings.title == "Settings…" && settings.representedObject as? String == "settings", "Settings stays in the application menu")
    let agent = main.item(withTitle: "File")!.submenu!
    let addHarness = agent.items.first(where: { $0.representedObject as? String == "addAgent" })!
    try checkTitlebar(addHarness.title == "Open Harness" && addHarness.keyEquivalent == "o" && addHarness.keyEquivalentModifierMask == [.command],
      "Open Harness advertises Command-O")
    try checkTitlebar(!agent.items.contains { $0.representedObject as? String == "newTerminal" },
      "New Terminal stays off the File menu; its chord lives in the keymap")
    let historyMenu = main.item(withTitle: "History")!.submenu!
    try checkTitlebar(agent.items.contains { $0.title == "Clone Harness" && $0.representedObject as? String == "cloneAgent" }, "Clone Harness preserves its action")
    try checkTitlebar(agent.items.map { $0.isSeparatorItem ? "separator" : ($0.representedObject as? String ?? "") } == ["newAgent", "addAgent", "cloneAgent", "restartAgent", "separator", "new", "renameActive", "closeActive", "separator", "splitRight", "splitDown", "zoomPane", "movePaneToTab", "closePane"], "File groups harness, tab and pane actions, harnesses first")
    try checkTitlebar(agent.items.first?.title == "New Harness" && agent.items.first?.keyEquivalent == "n" && agent.items.first?.keyEquivalentModifierMask == [.command],
      "New Harness leads File on Command-N")
    for (action, title, key) in [("splitRight", "Split Right", "r"), ("splitDown", "Split Down", "d")] {
      let split = agent.items.first(where: { $0.representedObject as? String == action })!
      try checkTitlebar(split.title == title && split.keyEquivalent == key && split.keyEquivalentModifierMask == [.command],
        "\(title) advertises its directional split shortcut")
      actionsEnabled = true
      canFind = false
      try checkTitlebar(!validateMenuItem(split), "\(title) needs a focused pane")
      canFind = true
      try checkTitlebar(validateMenuItem(split), "\(title) is available with a focused pane")
      menuAction(split)
      try checkTitlebar(messenger.calls.last?.method == action, "\(title) reaches the Flutter split picker")
    }
    try checkTitlebar(agent.items.filter { !$0.isSeparatorItem }.allSatisfy { $0.image != nil && $0.toolTip == nil },
      "Every File action has a native icon and no hover hint")
    try checkTitlebar(agent.items.contains { $0.title == "Rename Tab" && $0.representedObject as? String == "renameActive" }, "Rename Tab preserves its command")
    let movePane = agent.items.first(where: { $0.representedObject as? String == "movePaneToTab" })!
    try checkTitlebar(movePane.title == "Move Pane to Tab" && movePane.keyEquivalent == "m" && movePane.keyEquivalentModifierMask == [.command, .shift],
      "Move Pane to Tab advertises Command-Shift-M")
    actionsEnabled = true
    canFind = false
    try checkTitlebar(!validateMenuItem(movePane), "Move Pane to Tab needs a focused pane")
    canFind = true
    try checkTitlebar(validateMenuItem(movePane), "Move Pane to Tab is available with a focused pane")
    try checkTitlebar(agent.items.contains { $0.title == "Close Tab" && $0.representedObject as? String == "closeActive" }, "Close Tab preserves its command")
    let commands = edit.submenu!.items.first(where: { $0.representedObject as? String == "commands" })!
    try checkTitlebar(commands.keyEquivalent == "p" && commands.keyEquivalentModifierMask == [.command], "Command search keeps its native menu owner")
    try checkTitlebar(edit.submenu!.items.allSatisfy { $0.representedObject as? String != "jump" }, "Edit has no Navigate action")
    try checkTitlebar(agent.items.contains { $0.title == "New Tab" && $0.keyEquivalent == "t" && $0.representedObject as? String == "new" }, "New Tab opens the chooser with Command-T")
    let reopen = historyMenu.items.first(where: { $0.representedObject as? String == "reopen" })!
    actionsEnabled = true
    canReopen = false
    try checkTitlebar(!validateMenuItem(reopen), "Closed-Swarm recovery is disabled with an empty history")
    canReopen = true
    try checkTitlebar(validateMenuItem(reopen), "Closed-Swarm recovery becomes available")
    let closePane = agent.items.first(where: { $0.representedObject as? String == "closePane" })!
    canClosePane = false
    try checkTitlebar(!validateMenuItem(closePane), "Remove Agent is disabled in New swarm")
    canClosePane = true
    try checkTitlebar(validateMenuItem(closePane), "Remove Agent is enabled for a focused pane")
    let create = agent.items.first(where: { $0.representedObject as? String == "new" })!
    try checkTitlebar(validateMenuItem(create), "Native New Tab remains available without the retired tab capacity")
    let machineRows: [[String: Any]] = [
      ["id": "office", "name": "iMac – Office", "status": "Online", "presence": "Online", "local": true, "agentCount": 2,
       "agents": [["id": "one", "title": "App work", "engine": "codex", "canOpen": true],
                  ["id": "two", "title": "Unavailable session", "canOpen": false]]],
      ["id": "home", "name": "iMac – Home", "status": "Offline", "presence": "Offline", "local": false, "agentCount": 0],
    ]
    _ = try messenger.receive("machinesState", arguments: ["machines": machineRows])
    let machineMenu = main.item(withTitle: "View")!.submenu!
    let manager = machineMenu.items.first { $0.representedObject as? String == "machineList" }!
    let manage = machineMenu.items.first { $0.representedObject as? String == "manageMachines" }!
    try checkTitlebar(manager.title == "Machines" && manager.keyEquivalent == "m" &&
      manager.keyEquivalentModifierMask == [.command], "View exposes Machines on Command-M")
    try checkTitlebar(main.item(withTitle: "Machines") == nil, "The old Machines menu is replaced")
    menuAction(manage)
    try checkTitlebar(messenger.calls.last?.method == "manageMachines", "Machine Monitor remains available in View")
    menuAction(manager)
    try checkTitlebar(messenger.calls.last?.method == "machineList", "Machines opens the Flutter panel")
    _ = try messenger.receive("update", arguments: [
      "tabs": [["id": "navigation-check", "name": "Another tab"]],
      "activeId": "navigation-check", "enabled": true, "machinesOpen": true,
    ])
    try checkTitlebar(strip.machinesButton.state == .on && strip.machinesButton.isEnabled,
      "The Machines toolbar reflects the open panel")
    try checkTitlebar(strip.machinesButton.frame.maxX < strip.modelsButton.frame.minX &&
      strip.modelsButton.frame.maxX < strip.sessionsButton.frame.minX,
      "Machines, Models, and Harnesses occupy adjacent ordered slots")
    let beforeMachine = messenger.calls.count
    strip.machinesButton.performClick(nil)
    try checkTitlebar(messenger.calls.count == beforeMachine + 1 && messenger.calls.last?.method == "machineList",
      "The Machines toolbar toggles the same panel as the menu")
    _ = try messenger.receive("update", arguments: ["enabled": false, "machinesOpen": false])
    try checkTitlebar(!strip.machinesButton.isEnabled && strip.machinesButton.state == .off,
      "Modal state disables Machines and a closed panel clears the selection")
    strip.machinesButton.performClick(nil)
    menuAction(manager)
    try checkTitlebar(messenger.calls.count == beforeMachine + 1 && !validateMenuItem(manager),
      "Neither entry point dispatches behind a modal")
    actionsEnabled = true
    _ = try messenger.receive("machinesState", arguments: ["machines": []])
    _ = try messenger.receive("update", arguments: [
      "enabled": true, "machineNotices": 2, "modelNotices": 101, "unread": 3,
    ])
    try checkTitlebar(strip.machinesButton.attentionLabel == "2" &&
      strip.modelsButton.attentionLabel == "99+" && strip.sessionsButton.attentionLabel == "3",
      "The three tools share the same bounded notification badge")
    try checkTitlebar([strip.machinesButton, strip.modelsButton, strip.sessionsButton].allSatisfy {
      $0.iconTint == NSColor(white: 0.96, alpha: 1)
    }, "All three icons brighten when they have news")
    try checkTitlebar(strip.machinesButton.badgeFrame(textWidth: 8) ==
      strip.modelsButton.badgeFrame(textWidth: 8) &&
      strip.modelsButton.badgeFrame(textWidth: 8) == strip.sessionsButton.badgeFrame(textWidth: 8),
      "Badges align consistently on the three equal-size buttons")
    try checkTitlebar((strip.machinesButton.accessibilityValue() as? String)?.contains("2 new computers") == true &&
      (strip.modelsButton.accessibilityValue() as? String)?.contains("101 models ready") == true,
      "Machine and model notifications are available to assistive technology")
    for (step, button) in [("harnesses", strip.sessionsButton as SwarmNoticeButton),
                           ("machines", strip.machinesButton as SwarmNoticeButton),
                           ("models", strip.modelsButton as SwarmNoticeButton)] {
      _ = try messenger.receive("update", arguments: [
        "enabled": true, "onboarding": step, "machineNotices": 2,
        "modelNotices": 101, "unread": 3,
      ])
      try checkTitlebar(button.onboarding &&
        [strip.machinesButton, strip.modelsButton, strip.sessionsButton].filter { $0.onboarding }.count == 1,
        "Only the current onboarding step gets a dot")
      try checkTitlebar((button.accessibilityValue() as? String)?.contains("Suggested next step") == true,
        "The onboarding dot has an accessible purpose")
      try checkTitlebar(strip.machinesButton.attentionLabel == "2" &&
        strip.modelsButton.attentionLabel == "99+" && strip.sessionsButton.attentionLabel == "3",
        "Onboarding never inflates or replaces notification counts")
    }
    _ = try messenger.receive("update", arguments: ["enabled": true])
    try checkTitlebar([strip.machinesButton, strip.modelsButton, strip.sessionsButton].allSatisfy { !$0.onboarding },
      "Acknowledging onboarding removes the dot")
    try checkTitlebar(strip.machinesButton.attentionLabel == nil && strip.modelsButton.attentionLabel == nil,
      "Acknowledged machine and model news removes the badge")
    try checkTitlebar(strip.machinesButton.iconTint == NSColor(white: 0.60, alpha: 1) &&
      strip.modelsButton.iconTint == NSColor(white: 0.60, alpha: 1),
      "Acknowledged icons return to muted gray")
    var recentRows: [[String: Any]] = (0..<20).map { index -> [String: Any] in
      ["id": "agent:\(index)", "title": "Agent \(index) — Machine",
       "detail": "Project \(index)", "machineName": "M2", "current": index == 0,
       "engine": index == 0 ? "claude" : "codex"]
    }
    recentRows.append(["id": "swarm:recent", "title": "Recent Swarm", "swarm": true])
    let closedRows: [[String: Any]] = (0..<14).map {
      ["id": "closed-\($0)", "title": "Closed Swarm \($0)", "detail": "3 agents", "swarm": true, "canReopen": true]
    }
    updateHistory(recentRows, closed: closedRows)
    menuWillOpen(historyMenu)
    let recentItems = historyMenu.items.filter { $0.action == #selector(historyAction(_:)) }
    let closedItems = historyMenu.items.filter { $0.action == #selector(closedHistoryAction(_:)) }
    try checkTitlebar(recentItems.count == 15 && closedItems.count == 10, "Chrome-style direct History sections remain bounded")
    try checkTitlebar(historyMenu.items.filter { !$0.isSeparatorItem }.prefix(2).map(\.title) == ["Back", "Forward"], "History begins with Back and Forward")
    try checkTitlebar(historyMenu.items.last?.title == "Show Full History" && historyMenu.items.last?.keyEquivalent == "y", "Full History uses Command-Y")
    try checkTitlebar(historyMenu.items.allSatisfy { $0.submenu == nil }, "Recent work is available without nested menus")
    let recent = recentItems[0]
    let closed = closedItems[0]
    try checkTitlebar(historyMenu.size.width < 504 && historyMenu.minimumWidth > 0, "History adds twenty percent reading room")
    let recentView = recent.view as! SwarmHistoryMenuRow
    try checkTitlebar(recentView.machineFrame.maxX == recentView.bounds.width - 18,
      "History machine names align at the right edge beyond the command shortcut column")
    menu(historyMenu, willHighlight: recent)
    try checkTitlebar(recentView.highlighted, "Keyboard and mouse menu highlight reaches the full History row")
    let historyCallCount = messenger.calls.count
    try checkTitlebar(recentView.accessibilityPerformPress() && messenger.calls.count == historyCallCount + 1 &&
      messenger.calls.last?.method == "historyDestination", "The full-width History row opens the same native destination")
    actionsEnabled = false
    menuWillOpen(historyMenu)
    try checkTitlebar(!recent.isEnabled && !recentView.accessibilityPerformPress(),
      "A modal disables full-width History rows and their accessibility action")
    actionsEnabled = true
    menuWillOpen(historyMenu)
    try checkTitlebar(recent.isEnabled, "History rows become available again after the modal closes")
    try checkTitlebar(recent.image?.size == NSSize(width: 16, height: 16) && recent.image?.isTemplate == false,
      "History uses the colored Claude mark at native menu size")
    try checkTitlebar(recent.state == .on && recent.toolTip == nil, "History adds no hover hints")
    updateHistory(recentRows, closed: closedRows)
    try checkTitlebar(historyMenu.items.contains(where: { $0 === recent }), "Unchanged history retains native menu items")
    try checkTitlebar(validateMenuItem(closed), "A specific closed Swarm can be restored")
    canReopen = false
    try checkTitlebar(validateMenuItem(closed), "A chosen closure uses its own capacity, independently of the latest closure")
    var unavailableRows = closedRows
    unavailableRows[0]["canReopen"] = false
    updateHistory(recentRows, closed: unavailableRows)
    try checkTitlebar(!validateMenuItem(closed), "Specific restore respects its destination capacity")
    updateHistory(recentRows, closed: closedRows)
    canReopen = true
    let back = historyMenu.items[0]
    let forward = historyMenu.items[1]
    canGoBack = false
    canGoForward = true
    try checkTitlebar(!validateMenuItem(back) && validateMenuItem(forward), "Back and Forward have independent navigation availability")
    try checkTitlebar(validateMenuItem(recent), "Recent navigation is available in the shell")
    actionsEnabled = false
    try checkTitlebar(!validateMenuItem(recent) && !validateMenuItem(commands) && !validateMenuItem(settings), "History, commands and Settings cannot act behind a modal")
    for item in agent.items where !item.isSeparatorItem {
      try checkTitlebar(!validateMenuItem(item), "Workspace commands cannot act behind a modal")
    }
    actionsEnabled = true
    let iconRows: [[String: Any]] = [
      ["id": "single-harness", "title": "Architecture", "swarm": true,
       "agentCount": 1, "engine": "claude"],
      ["id": "group-harness", "title": "Project", "swarm": true,
       "agentCount": 2],
    ]
    updateHistory(iconRows, closed: iconRows)
    let singleItems = historyMenu.items.filter { $0.representedObject as? String == "single-harness" }
    let groupItems = historyMenu.items.filter { $0.representedObject as? String == "group-harness" }
    try checkTitlebar(singleItems.count == 2 && singleItems.allSatisfy {
      $0.image === historyIcons.image(engine: "claude", asset: nil)
    }, "Recently visited and closed single-agent agents show their agent icon")
    try checkTitlebar(groupItems.count == 2 && groupItems.allSatisfy {
      $0.image === SwarmIdentity.menuIcon
    }, "Multiple-agent agents retain the group icon")
    updateHistory([])
    try checkTitlebar(!validateMenuItem(recent), "A stale recent menu item cannot dispatch after its view disappears")
    try checkTitlebar(!validateMenuItem(closed), "A stale closed entry cannot restore another Swarm")
    try checkTitlebar(historyMenu.items.first(where: { $0.title == "No Recent Visits" })?.isEnabled == false, "An empty history is an inert placeholder")
    guard let menu = main.items.first(where: { $0.title == "View" })?.submenu,
          let attention = menu.items.first(where: { $0.representedObject as? String == "notifications" }) else {
      throw TitlebarCheckFailure(message: "View menu exposes agents needing input")
    }
    try checkTitlebar(attention.title == "Harnesses Needing Input…", "Native command names its destination")
    try checkTitlebar(attention.keyEquivalent == "i" && attention.keyEquivalentModifierMask == [.command, .shift], "Native attention shortcut matches Flutter")
    try checkTitlebar(attention.target === self && attention.action == #selector(menuAction(_:)), "Native attention command uses the guarded channel handler")
    actionsEnabled = false
    try checkTitlebar(!validateMenuItem(attention), "Native attention shortcut is disabled behind a modal")
    actionsEnabled = true
    try checkTitlebar(validateMenuItem(attention), "Native attention shortcut returns when the modal closes")
    try checkTitlebar(main.items.compactMap(\.submenu).flatMap(\.items).allSatisfy {
      !["Next Swarm", "Previous Swarm"].contains($0.title)
    }, "Next and Previous Swarm have no redundant menu rows")
    let modelRows: [[String: Any]] = [
      ["title": "Anthropic", "account": "aabbcc", "status": "12% remaining", "engine": "claude",
       "details": ["Limiting window: Session", "Session — 12% remaining · resets in 2h"]],
      ["title": "OpenAI", "status": "Not signed in", "engine": "codex",
       "details": ["Sign in to Codex to see usage"]],
    ]
    updateModels(modelRows, current: nil)
    let models = main.item(withTitle: "Models")!.submenu!
    try checkTitlebar(models.items.filter { !$0.isSeparatorItem }.map(\.title) == [
      "Subscriptions", "Anthropic, aabbcc, 12% remaining", "OpenAI, Not signed in",
      "On this Mac", "Open Models…"
    ], "Models carries the two sections with something behind them, ending on the row that starts a model")
    try checkTitlebar(models.items.filter(\.isSeparatorItem).count == 2,
      "Two native separators: after the subscriptions, and before the row that manages models")
    for gone in ["API", "OpenRouter", "fal.ai", "Add Model"] {
      try checkTitlebar(models.item(withTitle: gone) == nil,
        "\(gone) is gone — it named nothing this app can reach or do")
    }
    let openModels = models.items.last!
    try checkTitlebar(openModels.title == "Open Models…" && openModels.submenu == nil,
      "The Models menu opens the shared overview")
    try checkTitlebar(openModels.target === self && openModels.action == #selector(menuAction(_:))
      && openModels.representedObject as? String == "models",
      "The menu dispatches the same Models action as the toolbar")
    try checkTitlebar(openModels.identifier?.rawValue == HarnessKeymapMenu.actionPrefix + "models",
      "The Models overview is identified for the keymap")
    for rows in [machineRows, [machineRows[0]], []] {
      _ = try messenger.receive("machinesState", arguments: ["machines": rows])
      let item = main.item(withTitle: "Models")!.submenu!.items.last!
      try checkTitlebar(item.title == "Open Models…" && item.submenu == nil
        && item.representedObject as? String == "models",
        "Any number of machines still opens the same Models overview")
    }
    _ = try messenger.receive("update", arguments: ["enabled": true, "modelsOpen": true])
    try checkTitlebar(strip.modelsButton.state == .on && strip.modelsButton.isEnabled
      && strip.modelsButton.accessibilityValue() as? String == "Expanded",
      "Models exposes the same active state as the other toolbar panels")
    let modelCalls = messenger.calls.count
    strip.modelsButton.performClick(nil)
    try checkTitlebar(messenger.calls.count == modelCalls + 1 && messenger.calls.last?.method == "models",
      "The Models toolbar opens its overview")
    _ = try messenger.receive("update", arguments: ["enabled": false, "modelsOpen": false])
    strip.modelsButton.performClick(nil)
    menuAction(openModels)
    try checkTitlebar(!strip.modelsButton.isEnabled && strip.modelsButton.state == .off
      && messenger.calls.count == modelCalls + 1 && !validateMenuItem(openModels),
      "Neither Models entry point dispatches behind a modal")
    actionsEnabled = true

    // The Local section is DATA, not two hardcoded names. A menu naming a model nobody serves is
    // worse than one admitting it has none, which is what the empty case above asserts.
    updateModels(modelRows, current: nil, local: [
      ["id": "Qwen3.6-35B-A3B-UD-Q5_K_XL", "node": "macbook-m1max"],
      ["id": "DeepSeek-V4-Flash", "node": ""],
    ])
    let served = main.item(withTitle: "Models")!.submenu!
    try checkTitlebar(served.item(withTitle: "Qwen3.6-35B-A3B-UD-Q5_K_XL, macbook-m1max") != nil,
      "a served model names the machine answering it")
    try checkTitlebar(served.item(withTitle: "DeepSeek-V4-Flash") != nil,
      "a model with no node named is listed on its own")
    try checkTitlebar(served.items.last?.title == "Open Models…"
      && served.items[served.items.count - 2].isSeparatorItem
      && served.items.filter(\.isSeparatorItem).count == 2,
      "the manager row sits under its own rule, after the Local data rows")

    // A local row is built by the same view as a subscription row, which is what makes the two
    // sections read as one menu. A plain disabled NSMenuItem greys its whole title, so a served
    // model looked unavailable beside the accounts above it.
    let localRows = served.items.compactMap { $0.view as? SwarmSubscriptionView }.suffix(2)
    try checkTitlebar(localRows.count == 2, "Local models render as rows, not as greyed labels")
    try checkTitlebar(localRows.first?.identity.stringValue == "Qwen3.6-35B-A3B-UD-Q5_K_XL"
      && localRows.first?.balance.stringValue == "macbook-m1max",
      "the model id takes the left column and its node the trailing one, as usage does above")
    try checkTitlebar(localRows.last?.balance.stringValue.isEmpty == true,
      "a model with no node leaves the trailing column empty rather than inventing one")
    // The mark went when the Models menu was reworked: a local row now carries the id and its
    // node alone, and the icon column stays empty rather than inventing a brand for it.
    try checkTitlebar(localRows.allSatisfy { $0.iconImage == nil },
      "a local model is named without a brand mark")
    let subscriptionWidth = served.items.compactMap { $0.view as? SwarmSubscriptionView }.first!.bounds.width
    try checkTitlebar(localRows.allSatisfy { $0.bounds.width == subscriptionWidth },
      "both sections share one width, so the trailing column does not step at the section break")
    try checkTitlebar(localRows.allSatisfy { $0.identity.frame.minX == served.items.compactMap({ $0.view as? SwarmSubscriptionView }).first!.identity.frame.minX },
      "local and subscription titles start in the same column")
    updateModels(modelRows, current: nil)
    try checkTitlebar(models.item(withTitle: "No models being served") == nil,
      "an empty Local says nothing — the run row is the answer, not a sentence")
    let subscription = models.items.first(where: { $0.view is SwarmSubscriptionView })!
    let row = subscription.view as! SwarmSubscriptionView
    try checkTitlebar(subscription.submenu == nil && subscription.action == nil && !subscription.isEnabled,
      "Subscription balances have no arrow or fake action")
    // The account is elided on the way in — "···aabbcc" — so the row says which account without
    // printing an id nobody reads in full.
    try checkTitlebar(row.identity.stringValue == "Anthropic  ···aabbcc" && row.balance.stringValue == "12% remaining",
      "Provider and account are on the left; usage is a separate right column")
    // The meter sits between the two columns on a metered row, and the tick keeps its own column
    // on the right whether or not this row wears one — so the balance ends short of the rim.
    try checkTitlebar(row.identity.frame.maxX + 12 <= row.balance.frame.minX
      && row.balance.frame.maxX == row.bounds.width - 34,
      "Account and balance have a clear gap, and the balance clears the reserved tick column")
    try checkTitlebar(row.identity.frame.midY == row.balance.frame.midY,
      "Both columns share a vertical center")
    try checkTitlebar(row.accessibilityLabel() == subscription.title,
      "VoiceOver can read the provider, account and remaining usage together")
    let secondRow = models.items.compactMap { $0.view as? SwarmSubscriptionView }.last!
    for view in [row, secondRow] {
      let cell = view.balance.cell!
      let drawing = cell.drawingRect(forBounds: view.balance.bounds)
      let glyphWidth = (view.balance.stringValue as NSString).size(withAttributes: [.font: view.balance.font!]).width
      try checkTitlebar(view.bounds.width >= 352 && view.bounds.width < 440 && drawing.width >= glyphWidth,
        "Remaining usage and sign-in status have enough actual text-cell width to display in full")
    }
    try checkTitlebar(secondRow.balance.frame.maxX == row.balance.frame.maxX,
      "Different balances align on their right edges")
    updateModels(modelRows, current: nil)
    try checkTitlebar(models.items.contains(where: { $0 === subscription }),
      "Unchanged subscription data reuses native menu items")
    updateModels([], current: nil)
    try checkTitlebar(models.items.allSatisfy { !$0.title.contains("12%") && $0.submenu == nil },
      "Signing out clears cached native account readings")
    let findItems = find.submenu?.items ?? []
    try checkTitlebar(findItems.map(\.title) == ["Find in Terminal…", "Find Next", "Find Previous"], "Find replaces the unused editor actions with terminal commands")
    try checkTitlebar(findItems.map(\.keyEquivalent) == ["f", "g", "g"], "Native find shortcuts match Flutter")
    try checkTitlebar(findItems.last?.keyEquivalentModifierMask == [.command, .shift], "Previous match uses Shift-Command-G")
    for item in findItems {
      canFind = false
      try checkTitlebar(!validateMenuItem(item), "Find is disabled without a focused terminal")
      canFind = true
      try checkTitlebar(validateMenuItem(item), "Find is enabled for a focused terminal")
      actionsEnabled = false
      try checkTitlebar(!validateMenuItem(item), "Find cannot run behind a modal")
      actionsEnabled = true
      try checkTitlebar(item.target === self && item.action == #selector(menuAction(_:)), "Find uses the guarded channel handler")
    }
    strip.update([
      "enabled": true, "activeId": "swarm-11",
      "tabs": (0..<12).map { ["id": "swarm-\($0)", "name": "Swarm \($0)"] },
    ])
    for width in [880.0, 1280.0, 1920.0] {
      window.setContentSize(NSSize(width: width, height: 700))
      window.contentView?.superview?.layoutSubtreeIfNeeded()
      resize()
      window.contentView?.superview?.layoutSubtreeIfNeeded()
      strip.layoutSubtreeIfNeeded()
      try strip.checkWindowGeometry(window)
    }
    try strip.checkTabKeyboardFocus(window, messenger: messenger)
    let editor = TitlebarCheckInputView()
    window.contentViewController!.view.addSubview(editor)
    window.makeFirstResponder(editor)
    messenger.holdReplies = true
    sendTabAction("new", arguments: nil)
    messenger.finishNextReply()
    try checkTitlebar(window.firstResponder === editor,
      "An acknowledged menu action preserves an already focused content editor")
    messenger.holdReplies = false
    editor.removeFromSuperview()
    try checkTitlebar(!window.isVisible, "Native layout check never displays its window")
  }
}

private final class TitlebarCheckContentController: NSViewController {
  override var acceptsFirstResponder: Bool { true }
}

private final class TitlebarCheckInputView: NSView {
  var keys: [UInt16] = []
  override var acceptsFirstResponder: Bool { true }
  override func keyDown(with event: NSEvent) { keys.append(event.keyCode) }
}

/// Flutter's wrapper dispatches key equivalents only when its input view owns
/// focus. A bare accepting controller lets ordinary keys through but misses
/// that condition, so test the wrapper/input relationship as well as focus.
private final class TitlebarCheckContentView: NSView {
  let input = TitlebarCheckInputView()
  override init(frame: NSRect) {
    super.init(frame: frame)
    input.frame = bounds
    input.autoresizingMask = [.width, .height]
    addSubview(input)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func performKeyEquivalent(with event: NSEvent) -> Bool {
    guard window?.firstResponder === input else { return false }
    input.keyDown(with: event)
    return true
  }
}

private extension NSWindow {
  var contentInput: TitlebarCheckInputView {
    (contentViewController!.view as! TitlebarCheckContentView).input
  }
  func checkContentCommand() throws {
    let count = contentInput.keys.count
    let event = NSEvent.keyEvent(with: .keyDown, location: .zero,
      modifierFlags: .command, timestamp: 1, windowNumber: windowNumber,
      context: nil, characters: "n", charactersIgnoringModifiers: "n",
      isARepeat: false, keyCode: 45)!
    try checkTitlebar(performKeyEquivalent(with: event),
      "The content wrapper accepts Command-N after native focus handoff")
    try checkTitlebar(contentInput.keys.count == count + 1 && contentInput.keys.last == 45,
      "Command-N reaches content exactly once")
  }
}

let titlebarCheckApp = NSApplication.shared
titlebarCheckApp.setActivationPolicy(.prohibited)
titlebarCheckApp.appearance = NSAppearance(named: .darkAqua)
do {
  let paletteValues: [String: Any] = [
    "tabBar": Int64(0xff1b2030), "workspace": Int64(0xff252d43),
    "search": Int64(0xff262f46), "accent": Int64(0xffb1c7f5),
  ]
  let palette = SwarmNativePalette(paletteValues)
  let searchColor = palette.search.usingColorSpace(.sRGB)!
  try checkTitlebar(abs(searchColor.redComponent - 38.0 / 255) < 0.0001 && abs(searchColor.blueComponent - 70.0 / 255) < 0.0001,
    "Native search uses the exact palette channels supplied by Flutter")
  try checkTitlebar(SwarmNativePalette(["search": -1, "tabBar": "invalid"]) == SwarmNativePalette(),
    "Malformed palette data retains readable native defaults")
  let historyRow = SwarmHistoryEntry([
    "id": "agent", "title": "Build a toy", "machineName": "MacBook Pro M2", "engine": "codex",
  ])!
  let label = historyRow.menuTitle()
  try checkTitlebar(label.string == "Build a toy\tMacBook Pro M2", "Agent and machine occupy separate native menu columns")
  let paragraph = label.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as! NSParagraphStyle
  try checkTitlebar(paragraph.tabStops.count == 1 && paragraph.tabStops[0].alignment == .right && paragraph.tabStops[0].location < 300,
    "Machine labels use a compact right-aligned column sized to the text")
  let longRow = SwarmHistoryEntry(["id": "long", "title": String(repeating: "Long title ", count: 100), "machineName": "Mac"])!
  try checkTitlebar(longRow.menuTitle().string.contains("…\tMac") && longRow.menuTitle().size().width < 380,
    "Long titles truncate before the machine column without widening the menu")
  let swarmRow = SwarmHistoryEntry(["id": "swarm", "title": "My swarm", "swarm": true])!
  try checkTitlebar(swarmRow.menuTitle().string == "My swarm", "Empty swarm rows have no invented machine label")
  let sharedSwarm = SwarmHistoryEntry(["id": "shared", "title": "Workshop", "swarm": true, "machineName": "2 machines"])!
  try checkTitlebar(sharedSwarm.menuTitle().string == "Workshop\t2 machines", "Swarm machine counts use the same trailing column as agent machines")
  for button in [SwarmIconButton(), SwarmSessionsButton(), SwarmCloseButton()] {
    button.frame = NSRect(x: 0, y: 0, width: 28, height: 28)
    button.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)
    button.isBordered = false
    (button as? SwarmCloseButton)?.showsGlyph = true
    let rest = button.renderedPixels()
    let hover = NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [],
      timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
    button.mouseEntered(with: hover)
    try checkTitlebar(button.renderedPixels() != rest, "Native icon buttons draw a hover background")
    button.mouseExited(with: hover)
    try checkTitlebar(button.renderedPixels() == rest, "Native icon backgrounds clear when the pointer leaves")
    button.isEnabled = false
    let disabled = button.renderedPixels()
    button.mouseEntered(with: hover)
    try checkTitlebar(button.renderedPixels() == disabled, "Disabled native icons do not highlight")
  }
  var assetReads = 0
  let icons = SwarmHistoryIcons(assetURL: { asset in
    assetReads += 1
    guard let root = ProcessInfo.processInfo.environment["HARNESS_TITLEBAR_ASSETS"] else { return nil }
    return URL(fileURLWithPath: root).appendingPathComponent(String(asset.dropFirst("assets/".count)))
  })
  for engine in ["codex", "grok", "cursor", "opencode"] {
    let asset = "assets/engine-icons/\(engine).png"
    let icon = icons.image(engine: engine, asset: asset)
    try checkTitlebar(icon.size == NSSize(width: 16, height: 16) && !icon.isTemplate, "\(engine) uses its colored bundled mark")
    try checkTitlebar(icons.image(engine: engine, asset: asset) === icon, "Repeated \(engine) history reuses its decoded icon")
  }
  try checkTitlebar(assetReads == 4, "Native history loads each bundled mark only once")
  for name in ["machines", "models", "harnesses"] {
    let icon = icons.image(engine: name, asset: "assets/\(name).svg", pointSize: 20)
    try checkTitlebar(icon.size == NSSize(width: 20, height: 20) && icon.isTemplate,
      "\(name) uses a monochrome toolbar SVG")
    try checkTitlebar(!icon.representations.isEmpty &&
      icon.representations.allSatisfy { !($0 is NSBitmapImageRep) },
      "The native \(name) icon retains a vector representation")
    try checkTitlebar(icons.image(engine: name, asset: "assets/\(name).svg", pointSize: 20) === icon,
      "\(name) reuses its loaded SVG")
  }
  let unknown = icons.image(engine: "custom", asset: nil)
  try checkTitlebar(unknown.isTemplate && unknown.size == NSSize(width: 16, height: 16), "Unknown engines have a native-size adaptive initial")
  let strip = SwarmTabStrip(frame: NSRect(x: 0, y: 0, width: 900, height: 52))
  try strip.runChecks()
  try strip.checkAgentIdentity()
  try strip.checkSharedTypography()
  try checkTitlebar(titlebarCheckApp.windows.isEmpty, "Checks never open an application window")
  if CommandLine.arguments.contains("--window-layout") {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1280, height: 700),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.isReleasedWhenClosed = false
    let content = TitlebarCheckContentController()
    content.view = TitlebarCheckContentView(frame: NSRect(x: 0, y: 0, width: 1280, height: 700))
    window.contentViewController = content
    let messenger = TitlebarCheckMessenger()
    let titlebar = SwarmTitlebar(window: window, messenger: messenger)
    if let path = ProcessInfo.processInfo.environment["HARNESS_TITLEBAR_KEYMAP_FIXTURE"] {
      let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: [String: Any]]
      let before = titlebarCheckCount
      try titlebar.checkViewerShortcutRuntime(HarnessNativeKeymap(fixture["defaults"]!)!, messenger: messenger)
      print("Native Orchestrator viewer dispatch: \(titlebarCheckCount - before) checks passed with a focused WKWebView descendant; no window displayed.")
    }
    try titlebar.checkNativeContainer(messenger: messenger)
    if let path = ProcessInfo.processInfo.environment["HARNESS_TITLEBAR_KEYMAP_FIXTURE"] {
      let fixture = try JSONSerialization.jsonObject(with: Data(contentsOf: URL(fileURLWithPath: path))) as! [String: [String: Any]]
      try titlebar.checkKeymapRuntime(fixture, messenger: messenger)
    }
    window.close()
    print("AppKit Swarm titlebar: \(titlebarCheckCount) checks passed, including native window layout; no windows displayed.")
  } else {
    print("AppKit Swarm titlebar: \(titlebarCheckCount) checks passed; no windows opened.")
  }
} catch {
  let message = (error as? TitlebarCheckFailure)?.message ?? String(describing: error)
  FileHandle.standardError.write(Data("AppKit Swarm titlebar failed: \(message)\n".utf8))
  exit(1)
}
