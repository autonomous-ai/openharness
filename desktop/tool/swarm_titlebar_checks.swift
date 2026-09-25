
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

private extension NSView {
  func renderedBitmap() -> NSBitmapImageRep {
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
    return bitmap
  }
  func renderedPixels() -> Data {
    let bitmap = renderedBitmap()
    return Data(bytes: bitmap.bitmapData!, count: bitmap.bytesPerRow * bitmap.pixelsHigh)
  }
}

private extension SwarmContextButton {
  func checkThemeSymbolsAndCaps() throws {
    font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    textAlignment = .left
    nextBackground = nil
    let pointer = NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [],
      timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
    for ribbon in [false, true] {
      var segment: [String: Any] = ["text": "feature/日本語", "foreground": Int64(0xff11111b)]
      if ribbon { segment["background"] = Int64(0xfff9e2af) }
      var payload: [String: Any] = ["text": "feature/日本語", "interactive": true,
        "segmented": ribbon, "segments": [segment]]
      update(payload, enabled: true)
      let withoutSymbol = preferredWidth
      segment["branchSymbol"] = true
      payload["segments"] = [segment]
      update(payload, enabled: true)
      try checkTitlebar(abs(preferredWidth - withoutSymbol - cellWidth * 2) < 1,
        "Branch symbol reserves two cells in plain and segmented themes")
      frame = NSRect(x: 0, y: 0, width: preferredWidth, height: 28)
      let resting = renderedPixels()
      let width = preferredWidth
      mouseEntered(with: pointer)
      try checkTitlebar(renderedPixels() != resting && width == preferredWidth,
        "Branch symbol text becomes bold without moving the icon or click target")
      mouseExited(with: pointer)
      try checkTitlebar(accessibilityValue() as? String == "feature/日本語",
        "Decorative branch symbols leave the full accessible branch name intact")
      for narrow in [CGFloat(12), CGFloat(40), CGFloat(80)] {
        frame.size.width = narrow
        try checkTitlebar(!renderedPixels().isEmpty, "Icon-bearing status safely truncates at width \(narrow)")
      }
      guard ribbon else { continue }
      payload["roundedStart"] = true
      payload["roundedEnd"] = true
      payload["roundedSeparators"] = true
      update(payload, enabled: true)
      frame.size.width = preferredWidth
      let rounded = renderedBitmap()
      try checkTitlebar((rounded.colorAt(x: 0, y: 7)?.alphaComponent ?? 1) < 0.1 &&
        (rounded.colorAt(x: 4, y: 14)?.alphaComponent ?? 0) > 0.99,
        "Rounded palettes have a clear capsule corner and an opaque center")
      nextBackground = NSColor(srgbRed: 0.7, green: 0.5, blue: 0.8, alpha: 1)
      let joined = renderedBitmap()
      try checkTitlebar((joined.colorAt(x: 0, y: 7)?.alphaComponent ?? 1) < 0.1 &&
        (joined.colorAt(x: joined.pixelsWide - 1, y: 7)?.alphaComponent ?? 0) > 0.99,
        "A joined PR fills the tail without filling the leading rounded corner")
      nextBackground = nil
    }
  }
}

private extension SwarmTabButton {
  // `label` is private to the tab; a same-file extension reads what it draws.
  var drawnFont: NSFont? { label.attribute(.font, at: 0, effectiveRange: nil) as? NSFont }

  func checkHoverStyleAndTooltips() throws {
    frame = NSRect(x: 0, y: 0, width: 160, height: 40)
    contentCenterY = 20
    name = "office"
    displayLabel = "2:office"
    layoutSubtreeIfNeeded()
    try checkTitlebar(toolTip == nil, "A fully visible tab name has no repeating tooltip")
    displayLabel = "2:code"
    layoutSubtreeIfNeeded()
    try checkTitlebar(toolTip == "office", "A different underlying tab name remains available")
    name = "code"
    layoutSubtreeIfNeeded()
    try checkTitlebar(toolTip == nil, "Renaming a tab clears a redundant tooltip immediately")
    name = "a-very-long-project-name"
    displayLabel = "2:\(name)"
    layoutSubtreeIfNeeded()
    try checkTitlebar(toolTip == displayLabel, "An ellipsized tab reveals its full label")
    frame.size.width = 400
    needsLayout = true
    layoutSubtreeIfNeeded()
    try checkTitlebar(toolTip == nil, "Widening a tab removes a now-redundant tooltip")

    let symbol = SwarmStatusSymbolButton(frame: NSRect(x: 0, y: 0, width: 32, height: 28))
    symbol.title = "+"
    let hover = NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [],
      timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
    let symbolResting = symbol.renderedPixels()
    symbol.mouseEntered(with: hover)
    try checkTitlebar(symbol.renderedPixels() != symbolResting &&
      symbol.renderedBitmap().colorAt(x: 1, y: 1)!.alphaComponent == 0,
      "Symbols become bold on hover without adding a background")
    let width = preferredWidth
    let resting = renderedPixels()
    mouseEntered(with: hover)
    let hovered = renderedBitmap()
    let filledRows = (0..<hovered.pixelsHigh).filter { hovered.colorAt(x: 1, y: $0)!.alphaComponent > 0 }
    try checkTitlebar(filledRows.isEmpty && renderedPixels() != resting,
      "Tabs become bold on hover without adding a background")
    try checkTitlebar(preferredWidth == width &&
      NSFontManager.shared.traits(of: emphasizedLabel.attribute(.font, at: 0, effectiveRange: nil) as! NSFont).contains(.boldFontMask),
      "Hover uses a bold font while preserving the tab width")
    mouseExited(with: hover)
    selectButton.highlight(true)
    try checkTitlebar(renderedPixels() != resting, "Pressing a tab uses the same visible highlight")
    selectButton.highlight(false)
    actionsEnabled = false
    mouseEntered(with: hover)
    try checkTitlebar(renderedPixels() == resting, "Disabled tabs never show an actionable hover")
    actionsEnabled = true
    selected = true
    let active = renderedBitmap()
    let selectedRows = (0..<active.pixelsHigh).filter { active.colorAt(x: 1, y: $0)!.alphaComponent > 0 }
    try checkTitlebar(selectedRows.count == Int(bounds.height) && active.colorAt(x: 1, y: 20)!.alphaComponent == 1,
      "Selected tabs fill the full bar height")
    mouseExited(with: hover)
    for argb in [Int64(0xff282828), Int64(0xfff0f2f5)] {
      palette = SwarmNativePalette(["workspace": argb])
      let background = palette.workspace
      let pixel = renderedBitmap().colorAt(x: 1, y: 1)!.usingColorSpace(.sRGB)!
      try checkTitlebar(abs(pixel.redComponent - background.redComponent) < 0.01 &&
        abs(pixel.greenComponent - background.greenComponent) < 0.01 &&
        abs(pixel.blueComponent - background.blueComponent) < 0.01,
        "Active tabs join the workspace color in light and dark palettes")
    }
  }

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
    try checkTitlebar(!selectButton.mouseDownCanMoveWindow,
      "Tab action buttons opt out of automatic window movement")
  }

  func checkAccessibility(expectedName: String, active: Bool) throws {
    try checkTitlebar(accessibilityLabel() == expectedName, "Tab group name is available before paint")
    let children = accessibilityChildren()?.compactMap { $0 as? NSButton } ?? []
    try checkTitlebar(children.count == 1, "A tab exposes one full-width selection button")
    try checkTitlebar(children[0].accessibilityLabel() == "Select \(expectedName)", "Selection button has current name")
    try checkTitlebar(children[0].accessibilityValue() as? String == (active ? "Selected" : ""), "Selection value is current")
  }

  func checkEnabled(_ enabled: Bool) throws {
    try checkTitlebar(selectButton.isEnabled == enabled, "Select button obeys modal state")
    for item in menu?.items ?? [] {
      try checkTitlebar(validateMenuItem(item) == enabled, "Tab context menu obeys modal state")
    }
  }

  func checkCenteredLabel() throws {
    let paragraph = label.attribute(.paragraphStyle, at: 0, effectiveRange: nil) as? NSParagraphStyle
    try checkTitlebar(paragraph?.alignment == .center, "The tab label is centered")
    try checkTitlebar(selectButton.frame == bounds, "Selection spans the whole tab without a close slot")
    try checkTitlebar(subviews.count == 1, "Hover and keyboard focus never add a close button")
  }

  func clickBothActions() {
    selectButton.performClick(nil)
    closeSwarm()
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
    update(["tabs": [["id": "font-tab", "name": "Typography", "label": "1:code"],
                    ["id": "other", "name": "Other", "label": "2:blender"]],
            "activeId": "font-tab", "enabled": true,
            "barStyle": ["family": ".AppleSystemUIFontMonospaced", "size": 13.0,
                              "foreground": Int64(0xffd0d0d0), "selection": Int64(0xff444444)]])
    try checkTitlebar(tabs[0].labelFont == NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
      "Numbered tabs use 13 pt SF Mono regular")
    try checkTitlebar(tabs[0].drawnFont == tabs[1].drawnFont && contextButton.font == tabs[0].labelFont,
      "Active tabs, inactive tabs, and pane context share one font")
    for control in [newButton] {
      try checkTitlebar(control.font == contextButton.font && control.frame.midY == contextButton.frame.midY,
        "Status symbols share the terminal font and centered text baseline")
    }
    try checkTitlebar(tabs[0].frame.width < tabs[1].frame.width,
      "Each tab occupies its own text width and fixed cell gutters")
    try checkTitlebar(tabs[0].menu?.font == menuFont, "Native context menus retain the system menu font")

  }

  func checkStartupPalette(_ expected: SwarmNativePalette) throws {
    try checkTitlebar(palette == expected, "Startup uses the saved workspace palette")
    try checkTitlebar(tabs.isEmpty && !actionsEnabled && !newButton.isEnabled,
      "Palette setup does not create or enable workspace controls")
  }
  func checkWindowGeometry(_ window: NSWindow) throws {
    let stripFrame = convert(bounds, to: nil)
    let close = window.standardWindowButton(.closeButton)!
    let zoom = window.standardWindowButton(.zoomButton)!
    let closeFrame = close.convert(close.bounds, to: nil)
    let zoomFrame = zoom.convert(zoom.bounds, to: nil)
    let newFrame = newButton.convert(newButton.bounds, to: nil)
    try checkTitlebar(bounds.height >= 40, "Native title bar leaves room around the pill actions")
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
    let rows = (0..<24).map { ["id": "swarm-\($0)", "name": "Swarm \($0)", "label": "\($0 + 1):code"] }
    var events: [String] = []
    emit = { method, _ in events.append(method) }
    func state(_ rows: [[String: String]], active: String, enabled: Bool = true) -> [String: Any] {
      ["tabs": rows, "activeId": active, "enabled": enabled,
       "focusedContext": ["text": "OpenAI  M2:~/code/harness  (main)",
                          "segments": [["text": "OpenAI  M2:~/code/harness  (main)", "foreground": Int64(0xffdddddd)]],
                          "detail": "Full project context", "interactive": false]]
    }
    var prState = state(rows, active: "swarm-11")
    prState["pullRequest"] = ["text": "#298 Merged", "segmented": true,
      "segments": [["text": "#298 Merged", "foreground": Int64(0xffeeeeee), "background": Int64(0xffbc3fbc)]],
      "url": "https://github.com/acme/repo/pull/298", "interactive": true]
    update(prState)
    try checkTitlebar(!pullRequestButton.isHidden && pullRequestButton.isEnabled,
      "A focused PR has a separate enabled action")
    try checkTitlebar(contextButton.frame.maxX < pullRequestButton.frame.minX &&
      pullRequestButton.frame.maxX <= bounds.width, "Plain context keeps a space before its PR action")
    prState["focusedContext"] = ["text": "OpenAI M2  app  main", "segmented": true,
      "segments": [
        ["text": "OpenAI M2", "foreground": Int64(0xffeeeeee), "background": Int64(0xff000000)],
        ["text": "app", "foreground": Int64(0xffeeeeee), "background": Int64(0xff3465a4)],
        ["text": "main", "foreground": Int64(0xff000000), "background": Int64(0xff4e9a06)],
      ], "interactive": false]
    let originalSize = frame.size
    for width in [CGFloat(520), CGFloat(1280)] {
      setFrameSize(NSSize(width: width, height: originalSize.height))
      update(prState)
      try checkTitlebar(abs(contextButton.frame.maxX - pullRequestButton.frame.minX) < 0.01,
        "Powerline context and PR are adjacent at width \(width)")
      try checkTitlebar(contextButton.nextBackground == pullRequestButton.firstBackground,
        "The closing arrow joins into the PR background")
      try checkTitlebar(newButton.frame.maxX < contextButton.frame.minX &&
        pullRequestButton.frame.maxX <= bounds.width, "Joined status stays clear of tabs and window edges")
    }
    setFrameSize(originalSize)
    update(prState)
    let mergedPixels = pullRequestButton.renderedPixels()
    let mergedBitmap = pullRequestButton.renderedBitmap()
    let prFrame = pullRequestButton.frame
    let prWidth = pullRequestButton.preferredWidth
    try checkTitlebar(!mergedPixels.isEmpty && pullRequestButton.accessibilityValue() as? String == "#298 Merged",
      "Segmented PR renders and exposes its full state")
    pullRequestButton.performClick(nil)
    try checkTitlebar(events.last == "focusedPullRequest", "PR opens its own action rather than the model picker")
    let pointer = NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [],
      timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
    pullRequestButton.mouseEntered(with: pointer)
    try checkTitlebar(pullRequestButton.renderedPixels() != mergedPixels, "A PR uses the same bold hover cue")
    let mergedHover = pullRequestButton.renderedBitmap()
    try checkTitlebar((0..<mergedBitmap.pixelsWide).allSatisfy {
      mergedBitmap.colorAt(x: $0, y: 1) == mergedHover.colorAt(x: $0, y: 1)
    }, "PR hover leaves the space around the ribbon untouched")
    try checkTitlebar(mergedBitmap.colorAt(x: 1, y: 14) == mergedHover.colorAt(x: 1, y: 14) &&
      pullRequestButton.frame == prFrame && pullRequestButton.preferredWidth == prWidth,
      "PR hover preserves the segment background and geometry")
    pullRequestButton.mouseExited(with: pointer)
    let join = SwarmContextButton(frame: NSRect(x: 0, y: 0, width: 100, height: 28))
    join.font = contextButton.font
    join.update(["text": "main", "segmented": true, "interactive": true,
      "segments": [["text": "main", "foreground": Int64(0xff000000), "background": Int64(0xff4e9a06)]]], enabled: true)
    join.setFrameSize(NSSize(width: join.preferredWidth + 0.5, height: 28))
    join.nextBackground = pullRequestButton.firstBackground
    let pixels = join.renderedBitmap()
    try checkTitlebar((pixels.colorAt(x: 0, y: 14)?.alphaComponent ?? 0) > 0.99,
      "Fractional segment padding never leaves a vertical seam before its text")
    let tail = pixels.colorAt(x: pixels.pixelsWide - 1, y: 19)?.usingColorSpace(.sRGB)
    let expectedJoin = pullRequestButton.firstBackground?.usingColorSpace(.sRGB)
    try checkTitlebar(tail != nil && expectedJoin != nil && tail!.alphaComponent > 0.99 &&
      abs(tail!.redComponent - expectedJoin!.redComponent) < 0.02 &&
      abs(tail!.greenComponent - expectedJoin!.greenComponent) < 0.02 &&
      abs(tail!.blueComponent - expectedJoin!.blueComponent) < 0.02,
      "The last arrow paints through to the adjacent PR background without a dark divider")
    try join.checkThemeSymbolsAndCaps()
    let contextFields: [[String: Any]] = ["machine", "project", "branch"].map { field in
      ["text": field, "field": field, "paneId": 7, "interactive": true,
       "detail": "Find harnesses: \(field)",
       "segments": [["text": field, "foreground": Int64(0xffdddddd)]]]
    }
    var linked = prState
    linked["focusedContext"] = ["text": "machine project branch", "fields": contextFields]
    var clickedFields: [(String, Int)] = []
    emit = { method, args in
      if method == "focusedContext", let args = args as? [String: Any],
         let field = args["field"] as? String, let pane = args["paneId"] as? Int {
        clickedFields.append((field, pane))
      }
    }
    update(linked)
    try checkTitlebar(contextButton.fieldButtons.count == 3, "Context fields have separate native controls")
    for control in contextButton.fieldButtons {
      let before = control.renderedPixels()
      control.mouseEntered(with: pointer)
      try checkTitlebar(control.renderedPixels() != before, "Each context field emphasizes its own text")
      control.mouseExited(with: pointer)
      control.performClick(nil)
      try checkTitlebar(control.toolTip?.hasPrefix("Find harnesses") == true, "Context tooltip explains navigation")
      try checkTitlebar(contextButton.hitTest(contextButton.convert(NSPoint(x: control.frame.midX, y: control.frame.midY), to: contextButton.superview)) === control, "Context child is clickable inside its informational parent")
    }
    try checkTitlebar(clickedFields.map { $0.0 } == ["machine", "project", "branch"] &&
      clickedFields.allSatisfy { $0.1 == 7 }, "Each context action preserves field and pane identity")
    linked["focusedModel"] = ["text": "Fable", "paneId": 7, "agentId": "a0", "interactive": true,
      "detail": "Switch model · Subscription or local models",
      "segments": [["text": "Fable", "foreground": Int64(0xffdddddd)]]]
    var modelClicks: [(Int, String)] = []
    emit = { method, args in
      if method == "focusedModel", let args = args as? [String: Any],
         let pane = args["paneId"] as? Int, let agent = args["agentId"] as? String {
        modelClicks.append((pane, agent))
      }
    }
    update(linked)
    try checkTitlebar(!focusedModelButton.isHidden && focusedModelButton.isEnabled,
      "Focused model has its own enabled status control")
    try checkTitlebar(focusedModelButton.frame.maxX < contextButton.frame.minX &&
      focusedModelButton.frame.height == newButton.frame.height,
      "Model sits before machine/repo with the shared control height")
    try checkTitlebar(focusedModelButton.toolTip == "Switch model · Subscription or local models",
      "Model hint explains switching without repeating the visible name")
    let modelResting = focusedModelButton.renderedPixels()
    focusedModelButton.mouseEntered(with: pointer)
    try checkTitlebar(focusedModelButton.renderedPixels() != modelResting &&
      focusedModelButton.renderedBitmap().colorAt(x: 1, y: 1)!.alphaComponent == 0,
      "Model uses bold hover feedback without a background well")
    focusedModelButton.mouseExited(with: pointer)
    focusedModelButton.performClick(nil)
    try checkTitlebar(modelClicks.count == 1 && modelClicks[0].0 == 7 && modelClicks[0].1 == "a0",
      "Model actions carry the focused pane and agent identity")
    linked["enabled"] = false
    update(linked)
    focusedModelButton.performClick(nil)
    try checkTitlebar(!focusedModelButton.isEnabled && modelClicks.count == 1,
      "Disabled model controls cannot switch a harness")
    linked["enabled"] = false
    update(linked)
    for control in contextButton.fieldButtons {
      try checkTitlebar(!control.isEnabled, "Modal state disables each context link")
      control.performClick(nil)
    }
    try checkTitlebar(clickedFields.count == 3, "Disabled context links cannot dispatch")
    emit = { method, _ in events.append(method) }

    prState["enabled"] = false
    update(prState)
    try checkTitlebar(!pullRequestButton.isEnabled, "A modal disables the PR action")
    update(state(rows, active: "swarm-11"))
    try checkTitlebar(pullRequestButton.actionURL == nil && pullRequestButton.accessibilityValue() as? String == "",
      "Changing to a pane without a PR clears the old link and state")
    try checkTitlebar(contextButton.nextBackground == nil, "A missing PR clears the joined background")
    try checkTitlebar(contextButton.fieldButtons.isEmpty, "Leaving a context clears its former link controls")
    try tabs[0].checkDoubleClickIsolation()
    try checkTitlebar(tabs.count == 24 && newButton.isEnabled, "All overflow tabs and New Tab remain available")
    try checkTitlebar(scroll.frame.maxX <= newButton.frame.minX &&
      newButton.frame.maxX < contextButton.frame.minX, "Tabs are left of the right-aligned focused context")
    try checkTitlebar(tabs[0].frame.width < 120 && tabs[0].displayLabel == "1:code",
      "Short numbered labels use text-sized widths")
    try checkTitlebar(subviews.count == 5 && pullRequestButton.isHidden && focusedModelButton.isHidden,
      "Context links fill the bar; standalone search and management controls are absent")
    let controls = [newButton]
    for (control, symbol) in zip(controls, ["+"]) {
      try checkTitlebar(control.image == nil && control.title == symbol && !control.isBordered,
        "Management controls are plain terminal text without a resting button well")
      try checkTitlebar(control.frame.height >= 28 && control.frame.width > workspaceBarTextWidth(symbol, font: barFont),
        "The new-tab control keeps the shared click height and padding around its text")
      try checkTitlebar(control.accessibilityLabel() == "New Tab" && control.toolTip?.contains("New Tab") == true,
        "Every symbol explains its action through a tooltip and accessible name")
      let resting = control.renderedPixels()
      let event = NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [],
        timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
      control.mouseEntered(with: event)
      try checkTitlebar(control.renderedPixels() != resting, "Hover visibly marks a clickable symbol")
      control.mouseExited(with: event)
      try checkTitlebar(control.renderedPixels() == resting, "Leaving the symbol restores its plain appearance")
      control.highlight(true)
      try checkTitlebar(control.renderedPixels() != resting, "Pressing a symbol gives visual feedback")
      control.highlight(false)
    }
    for (left, right) in zip(controls, controls.dropFirst()) {
      try checkTitlebar(right.frame.midX - left.frame.midX == left.frame.width,
        "Symbols are equally spaced without hidden gaps")
    }
    try checkTitlebar(contextButton.accessibilityValue() as? String == "OpenAI  M2:~/code/harness  (main)",
      "The full focused context is accessible")
    for (index, tab) in tabs.enumerated() {
      try tab.checkAccessibility(expectedName: "Swarm \(index)", active: index == 11)
    }
    try checkActiveVisible()
    let hover = NSEvent.mouseEvent(with: .mouseMoved, location: .zero, modifierFlags: [],
      timestamp: 0, windowNumber: 0, context: nil, eventNumber: 0, clickCount: 0, pressure: 0)!
    tabs[1].mouseEntered(with: hover)
    try tabs[1].checkCenteredLabel()
    tabs[1].mouseExited(with: hover)
    try tabs[1].checkCenteredLabel()
    scroll.contentView.scroll(to: .zero)
    scroll.reflectScrolledClipView(scroll.contentView)
    let browsingOrigin = scroll.documentVisibleRect.origin
    update(state(rows, active: "swarm-11"))
    try checkTitlebar(scroll.documentVisibleRect.origin == browsingOrigin,
      "Background updates preserve deliberate tab scrolling")
    update(state(rows, active: "swarm-23"))
    try checkActiveVisible()
    setFrameSize(NSSize(width: 320, height: 52))
    needsLayout = true
    layoutSubtreeIfNeeded()
    try checkActiveVisible()
    try checkTitlebar(newButton.frame.maxX < contextButton.frame.minX &&
      contextButton.frame.maxX <= bounds.width, "Narrow windows have no overlapping controls")
    let original = tabs[0]
    let reversed = Array(rows.reversed())
    update(state(reversed, active: "swarm-0"))
    try checkTitlebar(tabs.last === original, "Reordering keeps existing native tab controls")
    let accessibleTabs = document.accessibilityChildren()?.compactMap { $0 as? SwarmTabButton } ?? []
    try checkTitlebar(accessibleTabs.map(\.swarmId) == tabs.map(\.swarmId), "Accessible order follows visual order")
    try checkActiveVisible()
    update(state([["id": "swarm-0", "name": "Custom name", "label": "1:blender"]], active: "swarm-0"))
    try checkTitlebar(tabs[0] === original && original.displayLabel == "1:blender",
      "Type changes update the existing tab without renaming its saved workspace")
    try original.checkAccessibility(expectedName: "Custom name", active: true)
    try checkTitlebar(newButton.toolTip == "New Tab ⌘T", "New Tab retains its keyboard hint")
    events.removeAll()
    contextButton.performClick(nil)
    newButton.performClick(nil)
    original.clickBothActions()
    try checkTitlebar(events == ["new", "select", "close"], "Visible controls dispatch their actions once")
    events.removeAll()
    update(state(rows, active: "swarm-0", enabled: false))
    try checkTitlebar(!contextButton.isEnabled && !newButton.isEnabled,
      "Modal state disables status-bar actions")
    try original.checkEnabled(false)
    contextButton.performClick(nil)
    newButton.performClick(nil)
    original.clickBothActions()
    try checkTitlebar(events.isEmpty, "Disabled controls cannot act behind a modal")
    update(["tabs": rows, "activeId": "swarm-0", "enabled": true])
    try checkTitlebar(contextButton.accessibilityValue() as? String == "" && !contextButton.isEnabled,
      "An empty tab clears the previous pane's context and model action")
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
      try tab.checkCenteredLabel()
      try checkTitlebar(scroll.documentVisibleRect.contains(tab.frame),
        "Keyboard focus reveals the entire overflowed tab")
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
      try tab.checkCenteredLabel()
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
      "Keyboard focus gives the new-tab symbol the same bold emphasis as hover")
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
    try rejected("New Tab is not a tab drop target")
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
    let models = original.item(withTitle: "View")!.submenu!.items.first { $0.representedObject as? String == "models" }!
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
    try checkTitlebar(models.keyEquivalent == "i" && models.keyEquivalentModifierMask == [.command],
      "The exported keymap gives View Models the same Command-I shortcut")
    let remappedModels = HarnessNativeKeymap(["version": 1, "contexts": Dictionary(uniqueKeysWithValues:
      HarnessNativeKeymap.contexts.map { ($0, [["keys": ["cmd+u"], "command": "models.list",
        "hint": "⌘U", "repeatable": false, "menuAction": "models"]]) })])!
    setKeymap(remappedModels)
    try checkTitlebar(models.keyEquivalent == "u",
      "Remapping Models updates the View menu")
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
    try checkTitlebar(models.keyEquivalent.isEmpty,
      "Unbinding Models clears its View menu shortcut")
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
    try checkTitlebar(main.defersToInput(event("p", 35, .command)), "Command-P reaches Open Harness")
    try checkTitlebar(main.defersToInput(event("p", 35, [.command, .shift])), "Command-Shift-P reaches commands")
    try checkTitlebar(main.defersToInput(event("o", 31, .command)), "Command-O reaches the project picker")
    try checkTitlebar(!main.defersToInput(event(";", 41, .command)) &&
      !main.performKeyEquivalent(with: event(";", 41, .command)),
      "Command-semicolon no longer opens Models")
    try checkTitlebar(main.defersToInput(event("i", 34, .command)) &&
      !main.performKeyEquivalent(with: event("i", 34, .command)),
      "Command-I reaches Flutter exactly once")
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
    // Cmd-O opens projects; Cmd-P opens search through the exported default keymap.
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
    try checkTitlebar(main.items.map(\.title) == ["Harness", "File", "Edit", "View", "History", "Window", "Help"], "Models and Machines live in the toolbar and View menu")
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
    try checkTitlebar(agent.items.map { $0.isSeparatorItem ? "separator" : ($0.representedObject as? String ?? "") } == ["newAgent", "addAgent", "cloneAgent", "restartAgent", "shareAgent", "separator", "new", "renameActive", "closeActive", "separator", "splitRight", "splitDown", "zoomPane", "movePaneToTab", "closePane"], "File groups harness, tab and pane actions, harnesses first")
    for (action, title, menu) in [
      ("restartAgent", "Restart Harness", agent),
      ("shareAgent", "Share Harness", agent),
      ("toggleViewer", "Toggle Viewer", main.item(withTitle: "View")!.submenu!),
      ("toggleComposer", "Toggle Message Composer", main.item(withTitle: "View")!.submenu!),
    ] {
      let item = menu.items.first { $0.representedObject as? String == action }!
      try checkTitlebar(item.title == title, "\(title) has the right destination")
      actionsEnabled = true
      paneActions[action] = false
      try checkTitlebar(!validateMenuItem(item), "\(title) is unavailable without an eligible focused pane")
      paneActions[action] = true
      try checkTitlebar(validateMenuItem(item), "\(title) is enabled for the focused pane")
      menuAction(item)
      try checkTitlebar(messenger.calls.last?.method == action, "\(title) dispatches to Flutter")
      actionsEnabled = false
      try checkTitlebar(!validateMenuItem(item), "\(title) respects modal state")
    }
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
    let closeTabShortcut = agent.items.first { $0.representedObject as? String == "closeActive" }!
    let closePaneShortcut = agent.items.first { $0.representedObject as? String == "closePane" }!
    try checkTitlebar(closeTabShortcut.keyEquivalent == "w" && closeTabShortcut.keyEquivalentModifierMask == [.command], "Close Tab defaults to Command-W")
    try checkTitlebar(closePaneShortcut.keyEquivalent == "w" && closePaneShortcut.keyEquivalentModifierMask == [.command, .shift], "Close Pane defaults to Command-Shift-W")
    let commands = edit.submenu!.items.first(where: { $0.representedObject as? String == "commands" })!
    try checkTitlebar(commands.keyEquivalent == "p" && commands.keyEquivalentModifierMask == [.command, .shift], "Command search keeps its native menu owner")
    let harnesses = main.item(withTitle: "View")!.submenu!.items.first { $0.representedObject as? String == "sessions" }!
    try checkTitlebar(harnesses.keyEquivalent == "p" && harnesses.keyEquivalentModifierMask == [.command],
      "Command-P keeps harness search; commands use Command-Shift-P")
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
    actionsEnabled = true
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
    try checkTitlebar(main.item(withTitle: "Models") == nil,
      "Models has no duplicate top-level menu")
    let openModels = menu.items.first(where: { $0.representedObject as? String == "models" })!
    try checkTitlebar(openModels.title == "Models" && openModels.submenu == nil,
      "View offers one direct Models command")
    try checkTitlebar(openModels.keyEquivalent == "i" && openModels.keyEquivalentModifierMask == [.command],
      "View Models advertises Command-I")
    try checkTitlebar(openModels.target === self && openModels.action == #selector(menuAction(_:)),
      "View Models dispatches the same action as the toolbar")
    try checkTitlebar(openModels.identifier?.rawValue == HarnessKeymapMenu.actionPrefix + "models",
      "View Models retains its keymap identity")
    installWorkspaceMenus()
    try checkTitlebar(menu.items.filter { $0.representedObject as? String == "models" }.count == 1,
      "Repeated setup keeps a single Models command")
    for rows in [machineRows, [machineRows[0]], []] {
      _ = try messenger.receive("machinesState", arguments: ["machines": rows])
      try checkTitlebar(menu.items.first(where: { $0.representedObject as? String == "models" }) === openModels,
        "Machine updates retain the same Models command")
    }
    let menuCalls = messenger.calls.count
    menuAction(openModels)
    try checkTitlebar(messenger.calls.count == menuCalls + 1 && messenger.calls.last?.method == "models",
      "View Models opens the shared panel exactly once")
    let modelCalls = messenger.calls.count
    _ = try messenger.receive("update", arguments: ["enabled": false])
    menuAction(openModels)
    try checkTitlebar(messenger.calls.count == modelCalls && !validateMenuItem(openModels),
      "The Models menu cannot dispatch behind a modal")
    actionsEnabled = true

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
  for button in [SwarmIconButton()] {
    button.frame = NSRect(x: 0, y: 0, width: 28, height: 28)
    button.image = NSImage(systemSymbolName: "plus", accessibilityDescription: nil)
    button.isBordered = false
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
  try SwarmTabButton(id: "hover-fixture").checkHoverStyleAndTooltips()
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
