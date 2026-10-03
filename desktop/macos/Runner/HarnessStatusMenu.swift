import Cocoa
import CoreText

/// Unread conversations in the system menu bar. Dart owns the
/// unread ledger and navigation; AppKit only presents a snapshot and its receipts.
final class HarnessStatusMenu: NSObject, NSMenuDelegate {
  let menu = NSMenu(title: "Harness")
  private(set) var statusItem: NSStatusItem?
  private var entries: [[String: Any]] = []
  private var working: [[String: Any]] = []
  private var activityTimer: Timer?
  private var motionObserver: NSObjectProtocol?
  private var reduceMotion = false
  private var keymap: HarnessNativeKeymap?
  private var keyContext = "workspace"
  private var enabled = false
  private var workspaceAvailable = false
  private var tracking = false
  private var dirty = true
  private let showWindow: () -> Void
  private let emit: (String, Any?) -> Void

  init(installStatusItem: Bool = true, showWindow: @escaping () -> Void,
       emit: @escaping (String, Any?) -> Void) {
    self.showWindow = showWindow
    self.emit = emit
    super.init()
    menu.autoenablesItems = false
    menu.delegate = self
    motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) {
        [weak self] _ in self?.syncActivityAnimation()
      }
    if installStatusItem {
      let item = NSStatusBar.system.statusItem(withLength: NSStatusItem.variableLength)
      statusItem = item
      item.menu = menu
      item.button?.imagePosition = .imageOnly
      item.button?.setAccessibilityLabel("Harness notifications")
    }
    update([:])
  }

  deinit {
    activityTimer?.invalidate()
    if let motionObserver { NSWorkspace.shared.notificationCenter.removeObserver(motionObserver) }
    if let statusItem { NSStatusBar.system.removeStatusItem(statusItem) }
  }

  func update(_ state: [String: Any]) {
    let nextReduceMotion = state["reduceMotion"] as? Bool == true
    if reduceMotion != nextReduceMotion {
      reduceMotion = nextReduceMotion
      syncActivityAnimation()
    }
    let nextEnabled = state["enabled"] as? Bool == true
    let nextAvailable = state["statusMenuEntries"] != nil
    let nextEntries = (state["statusMenuEntries"] as? [[String: Any]] ?? [])
      .filter { $0["unread"] as? Bool == true }
    let nextWorking = state["statusMenuWorkingEntries"] as? [[String: Any]] ?? []
    guard dirty || enabled != nextEnabled || workspaceAvailable != nextAvailable ||
          !NSArray(array: entries).isEqual(to: nextEntries) ||
          !NSArray(array: working).isEqual(to: nextWorking) else { return }
    enabled = nextEnabled
    workspaceAvailable = nextAvailable
    entries = nextEntries
    working = nextAvailable ? nextWorking : []
    let count = entries.count
    statusItem?.button?.image = Self.badgeImage(logo: NSImage(named: "HarnessStatusIcon"),
                                              count: workspaceAvailable ? count : nil)
    statusItem?.button?.toolTip = workspaceAvailable ? "Harness · \(count) unread" : "Harness"
    statusItem?.button?.setAccessibilityValue("\(count) unread")
    dirty = true
    // Never move a conversation out from under the pointer. Stale actions are
    // revalidated against `entries`, even while the displayed menu stays still.
    if !tracking { rebuild() }
    syncActivityAnimation()
    if !workspaceAvailable { menu.cancelTracking() }
  }

  func menuNeedsUpdate(_ menu: NSMenu) {
    if menu === self.menu && !tracking && dirty { rebuild() }
  }

  func menuWillOpen(_ menu: NSMenu) {
    guard menu === self.menu else {
      for item in menu.items { (item.view as? HarnessStatusMenuRow)?.refreshTime() }
      return
    }
    if dirty { rebuild() }
    refreshTimes()
    tracking = true
    syncActivityAnimation()
  }

  func menuDidClose(_ menu: NSMenu) {
    guard menu === self.menu else { return }
    tracking = false
    syncActivityAnimation()
    // AppKit dispatches the selected item after closing. Rebuild on next open
    // or update so its receipt remains the snapshot the person selected.
  }

  func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
    for row in menu.items {
      (row.view as? HarnessStatusMenuRow)?.highlighted = row === item
    }
  }

  func updateKeymap(_ map: HarnessNativeKeymap, context: String) {
    keymap = map
    keyContext = context
    map.applyMenuKeys(to: menu, context: context)
  }

  private func refreshTimes() {
    for item in menu.items {
      (item.view as? HarnessStatusMenuRow)?.refreshTime()
      for child in item.submenu?.items ?? [] {
        (child.view as? HarnessStatusMenuRow)?.refreshTime()
      }
    }
  }

  private var activityRows: [HarnessStatusMenuRow] {
    menu.items.flatMap { [$0] + ($0.submenu?.items ?? []) }
      .compactMap { $0.view as? HarnessStatusMenuRow }
      .filter { $0.activity?.working == true }
  }

  private func syncActivityAnimation() {
    let moving = tracking && enabled && !reduceMotion &&
      !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && !activityRows.isEmpty
    guard moving else {
      activityTimer?.invalidate()
      activityTimer = nil
      for row in activityRows { row.activityFrame = 0 }
      return
    }
    for row in activityRows { row.activityFrame = harnessActivityFrame() }
    guard activityTimer == nil else { return }
    let next = (floor(Date().timeIntervalSince1970 * 10) + 1) / 10
    let timer = Timer(fire: Date(timeIntervalSince1970: next), interval: 0.1, repeats: true) { [weak self] _ in
      guard let self else { return }
      for row in self.activityRows where row.window?.isVisible == true && !row.isHiddenOrHasHiddenAncestor {
        row.activityFrame = harnessActivityFrame()
      }
    }
    activityTimer = timer
    // Tracking is itself foreground interaction, even when another app owns
    // the key window. Closing the menu stops this local clock.
    RunLoop.main.add(timer, forMode: .common)
  }

  private func rebuild() {
    dirty = false
    menu.removeAllItems()
    menu.minimumWidth = 360
    let clear = add("Mark all read", "clearStatusNotifications", enabled: enabled && !entries.isEmpty)
    clear.representedObject = entries
    clear.view = HarnessStatusMenuRow(item: clear, heading: "Ready", count: entries.count)
    if entries.isEmpty {
      let empty = NSMenuItem(title: workspaceAvailable ? "All caught up" : "Open Harness to get started",
                            action: nil, keyEquivalent: "")
      empty.isEnabled = false
      menu.addItem(empty)
    } else {
      for entry in entries.prefix(5) { addSession(entry, to: menu) }
      if entries.count > 5 {
        add("View all \(entries.count) notifications…", "notificationInbox", enabled: enabled)
      }
    }
    if workspaceAvailable && !working.isEmpty {
      menu.addItem(.separator())
      let heading = NSMenuItem(title: "Working (\(working.count))", action: nil, keyEquivalent: "")
      heading.identifier = NSUserInterfaceItemIdentifier("workingHeading")
      heading.isEnabled = false
      heading.view = HarnessStatusMenuRow(item: heading, heading: "Working", count: working.count)
      menu.addItem(heading)
      for entry in working { addSession(entry, to: menu) }
    }
    menu.addItem(.separator())
    add("New Harness…", HarnessKeymapMenu.actionPrefix + "newAgent", enabled: enabled)
    add("Open Harness…", HarnessKeymapMenu.actionPrefix + "sessions", enabled: enabled)
    menu.addItem(.separator())
    add("Show Harness", "openWindow")
    add("Quit", "quit")
    keymap?.applyMenuKeys(to: menu, context: keyContext)
  }

  @discardableResult private func addSession(_ entry: [String: Any], to destination: NSMenu) -> NSMenuItem {
    let title = entry["title"] as? String ?? "Unavailable harness"
    let item = NSMenuItem(title: compact(title), action: #selector(selected(_:)), keyEquivalent: "")
    item.identifier = NSUserInterfaceItemIdentifier("openStatusHarness")
    item.target = self
    item.isEnabled = enabled && entry["unavailable"] as? String == nil
    item.representedObject = entry
    item.view = HarnessStatusMenuRow(item: item, entry: entry)
    destination.addItem(item)
    return item
  }

  @discardableResult private func add(_ title: String, _ action: String, enabled: Bool = true) -> NSMenuItem {
    let item = NSMenuItem(title: title, action: #selector(selected(_:)), keyEquivalent: "")
    item.identifier = NSUserInterfaceItemIdentifier(action)
    item.target = self
    item.isEnabled = enabled
    menu.addItem(item)
    return item
  }

  @objc private func selected(_ item: NSMenuItem) {
    guard item.isEnabled, let identifier = item.identifier?.rawValue else { return }
    let action = identifier.hasPrefix(HarnessKeymapMenu.actionPrefix)
      ? String(identifier.dropFirst(HarnessKeymapMenu.actionPrefix.count)) : identifier
    switch action {
    case "openWindow": showWindow()
    case "quit": NSApp.terminate(nil)
    case "openStatusHarness":
      guard enabled, let receipt = item.representedObject as? [String: Any],
            (receipt["unread"] as? Bool == true ? entries : working).contains(where: {
              sameReceipt($0, receipt) && $0["unavailable"] as? String == nil
            }) else { return }
      // Dart opens the destination before revealing the window, so activating
      // the previously selected tab cannot acknowledge the wrong notification.
      emit(action, receipt)
    case "clearStatusNotifications":
      guard enabled, let receipts = item.representedObject as? [[String: Any]] else { return }
      emit(action, ["receipts": receipts])
    default:
      guard enabled else { return }
      showWindow()
      emit(action, nil)
    }
  }

  private func sameReceipt(_ current: [String: Any], _ displayed: [String: Any]) -> Bool {
    ["machineId", "agentId", "sessionId", "readToken", "questionId"].allSatisfy {
      current[$0] as? String == displayed[$0] as? String
    }
  }

  private func compact(_ text: String) -> String {
    let line = text.components(separatedBy: .newlines).joined(separator: " ")
    // Bound native title measurement too; the custom row keeps the full name
    // for drawing/VoiceOver without letting it widen the entire menu.
    var prefix = String(line.prefix(80))
    let font = NSFont.menuFont(ofSize: 0)
    while !prefix.isEmpty && (prefix as NSString).size(withAttributes: [.font: font]).width > 250 {
      prefix.removeLast()
    }
    return prefix == line ? line : prefix + "…"
  }

  /// A single template mask lets AppKit tint the logo and badge together for
  /// the menu bar's appearance and selection. Clear digits and a small halo
  /// keep the overlapping badge legible without painting a fixed background.
  private static func badgeImage(logo: NSImage?, count: Int?) -> NSImage {
    let label: String
    if let count, count > 0 {
      label = count > 99 ? "99+" : String(count)
    } else {
      label = ""
    }
    let image = NSImage(size: NSSize(width: 28, height: 22), flipped: false) { bounds in
      // Balance the portrait's fine cutouts against neighboring system symbols.
      logo?.draw(in: NSRect(x: label.isEmpty ? (bounds.width - 17) / 2 : 2, y: label.isEmpty ? 2.5 : 4,
                           width: 17, height: 17))
      if !label.isEmpty, let context = NSGraphicsContext.current?.cgContext {
        let badge = NSRect(x: bounds.maxX - 15, y: 0.5, width: 12.5, height: 12.5)
        context.saveGState()
        context.setBlendMode(.clear)
        context.fillEllipse(in: badge.insetBy(dx: -0.75, dy: -0.75))
        context.restoreGState()
        NSColor.black.setFill()
        NSBezierPath(ovalIn: badge).fill()
        let size: CGFloat = label.count == 1 ? 9.5 : label.count == 2 ? 8.5 : 6.5
        let text = NSAttributedString(string: label, attributes: [
          .font: NSFont.monospacedDigitSystemFont(ofSize: size, weight: .medium),
          .foregroundColor: NSColor.black,
        ])
        let line = CTLineCreateWithAttributedString(text)
        let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
        context.saveGState()
        context.setBlendMode(.destinationOut)
        context.textPosition = NSPoint(x: badge.midX - ink.midX, y: badge.midY - ink.midY)
        CTLineDraw(line, context)
        context.restoreGState()
      }
      return true
    }
    image.isTemplate = true
    image.accessibilityDescription = count.map { "\($0) unread" } ?? "Harness"
    return image
  }

}

/// Rich rows keep NSMenuItem's native keyboard/type-select actions, just like
/// the History menu. All clicks and VoiceOver presses use the same receipt.
private final class HarnessStatusMenuRow: NSView {
  private weak var item: NSMenuItem?
  private let entry: [String: Any]?
  private let heading: String?
  private let count: Int
  let activity: HarnessNativeActivity?
  private var time = ""
  var highlighted = false { didSet { needsDisplay = true } }
  var activityFrame = 0 {
    didSet { if oldValue != activityFrame { setNeedsDisplay(activityRect) } }
  }
  override var isFlipped: Bool { true }

  init(item: NSMenuItem, entry: [String: Any]? = nil, heading: String? = nil,
       count: Int = 0) {
    self.item = item
    self.entry = entry
    self.heading = heading
    self.count = count
    activity = HarnessNativeActivity(entry?["activity"] as? [String: Any])
    let unread = entry?["unread"] as? Bool == true
    let message = unread ? entry?["message"] as? String ?? "" : ""
    let measured = (message as NSString).boundingRect(with: NSSize(width: 304, height: 1000),
      options: [.usesLineFragmentOrigin], attributes: [.font: NSFont.systemFont(ofSize: 13)])
    let messageHeight = message.isEmpty ? 0 : min(32, ceil(measured.height)) + 4
    let height: CGFloat = entry == nil ? 32 : unread ? 34 + messageHeight : 28
    super.init(frame: NSRect(x: 0, y: 0, width: 360, height: height))
    autoresizingMask = [.width]
    setAccessibilityElement(true)
    setAccessibilityRole(heading != nil && !isClearControl ? .staticText : .menuItem)
    refreshTime()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    highlighted = false
    refreshTime()
  }

  func refreshTime() {
    time = ""
    if let entry {
      let unread = entry["unread"] as? Bool == true
      if let stamp = entry[unread ? "receivedAt" : "startedAt"] as? NSNumber {
        let age = max(0, Int(Date().timeIntervalSince1970 - stamp.doubleValue / 1000))
        if age < 60 { time = unread ? "now" : "\(age)s" }
        else if age < 3600 { time = "\(age / 60)m" }
        else if age < 86400 { time = "\(age / 3600)h" }
        else { time = "\(age / 86400)d" }
      }
    }
    updateAccessibility()
    needsDisplay = true
  }

  private var context: String {
    guard let entry else { return "" }
    return [entry["tabName"] as? String, entry["machineName"] as? String,
            entry["unavailable"] as? String].compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: " · ")
  }

  private func updateAccessibility() {
    guard let item else { return }
    let text: String
    if let entry {
      let age = time.isEmpty ? nil : entry["unread"] as? Bool == true
        ? (time == "now" ? time : "\(time) ago") : "\(time) elapsed"
      text = [entry["title"] as? String, activity?.label ?? entry["label"] as? String,
              entry["message"] as? String, context, age, entry["unread"] as? Bool == true ? "Unread" : nil]
        .compactMap { $0 }.filter { !$0.isEmpty }.joined(separator: ", ")
      toolTip = [text, entry["detail"] as? String].compactMap { $0 }.joined(separator: " · ")
    } else if isClearControl {
      text = "\(heading ?? "Ready") (\(count)), Mark all read"
      toolTip = "Mark all read. Pending questions stay unanswered."
    } else {
      text = item.title
      toolTip = nil
    }
    setAccessibilityLabel(text)
    setAccessibilityEnabled(item.isEnabled)
    item.setAccessibilityLabel(text)
    item.toolTip = toolTip
  }

  private var clearRect: NSRect {
    NSRect(x: bounds.width - 44, y: 0, width: 32, height: bounds.height)
  }

  private var isClearControl: Bool {
    item?.identifier?.rawValue == "clearStatusNotifications"
  }

  private var activityRect: NSRect {
    NSRect(x: 16, y: entry?["unread"] as? Bool == true ? 7 : 6, width: 16, height: 16)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard let item else { return }
    let selected = highlighted && item.isEnabled
    if selected {
      NSColor.selectedContentBackgroundColor.setFill()
      NSBezierPath(roundedRect: isClearControl
        ? clearRect.insetBy(dx: 2, dy: 2) : bounds.insetBy(dx: 4, dy: 1), xRadius: 5, yRadius: 5).fill()
    }
    let primary: NSColor = !item.isEnabled ? .disabledControlTextColor
      : selected ? .selectedMenuItemTextColor : .labelColor
    let secondary: NSColor = !item.isEnabled ? .disabledControlTextColor
      : selected ? .selectedMenuItemTextColor : .secondaryLabelColor
    if let heading {
      let font = NSFont.systemFont(ofSize: 12, weight: .semibold)
      let labelWidth = ceil((heading as NSString).size(withAttributes: [.font: font]).width)
      let headingInk = NSColor.secondaryLabelColor
      text(heading, x: 16, y: 8, width: labelWidth, height: 18,
           size: 12, weight: .semibold, color: headingInk)
      if count > 0 {
        text("\(count)", x: 16 + labelWidth + 7, y: 8, width: clearRect.minX - labelWidth - 27,
             height: 18, size: 12, color: headingInk)
      }
      if isClearControl && item.isEnabled {
        symbol("xmark", in: clearRect, color: secondary)
      }
      return
    }
    guard let entry else { return }
    let unread = entry["unread"] as? Bool == true
    let message = entry["message"] as? String ?? ""
    if let activity {
      HarnessNativeActivity.draw(activity.symbol(frame: activityFrame), in: activityRect,
        color: !item.isEnabled || selected ? primary : statusMenuActivityColor(activity.color, appearance: effectiveAppearance))
    }
    let titleY: CGFloat = unread ? 6 : 5
    let timeWidth = ceil((time as NSString).size(withAttributes: [.font: NSFont.systemFont(ofSize: 12)]).width)
    text(entry["title"] as? String ?? item.title, x: 40, y: titleY,
         width: bounds.width - 56 - (time.isEmpty ? 0 : timeWidth + 12), height: 19,
         weight: unread ? .semibold : .regular, color: primary)
    text(time, x: bounds.width - 16 - timeWidth, y: titleY + 2, width: timeWidth, height: 16,
         size: 12, color: secondary, alignment: .right)
    if unread && !message.isEmpty {
      text(message, x: 40, y: 26, width: bounds.width - 56, height: 32,
           color: primary, multiline: true)
    }
  }

  private func symbol(_ name: String, in rect: NSRect, color: NSColor) {
    guard let icon = HarnessControlSymbols.image(name)?.copy() as? NSImage else { return }
    icon.lockFocus()
    color.set()
    NSRect(origin: .zero, size: icon.size).fill(using: .sourceAtop)
    icon.unlockFocus()
    let scale = min(1, min(16 / icon.size.width, 16 / icon.size.height))
    let size = NSSize(width: icon.size.width * scale, height: icon.size.height * scale)
    icon.draw(in: NSRect(x: rect.midX - size.width / 2, y: rect.midY - size.height / 2,
                        width: size.width, height: size.height),
              from: .zero, operation: .sourceOver, fraction: 1, respectFlipped: true, hints: nil)
  }

  private func text(_ value: String, x: CGFloat, y: CGFloat, width: CGFloat, height: CGFloat,
                    size: CGFloat = 13, weight: NSFont.Weight = .regular, color: NSColor,
                    alignment: NSTextAlignment = .left, multiline: Bool = false) {
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = alignment
    paragraph.lineBreakMode = multiline ? .byWordWrapping : .byTruncatingTail
    let attributes: [NSAttributedString.Key: Any] = [
      .font: NSFont.systemFont(ofSize: size, weight: weight), .foregroundColor: color, .paragraphStyle: paragraph,
    ]
    (value as NSString).draw(with: NSRect(x: x, y: y, width: max(0, width), height: height),
      options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine], attributes: attributes)
  }

  override func resetCursorRects() {
    if item?.isEnabled == true {
      addCursorRect(isClearControl ? clearRect : bounds, cursor: .pointingHand)
    }
  }

  override func mouseUp(with event: NSEvent) {
    let point = convert(event.locationInWindow, from: nil)
    guard (isClearControl ? clearRect : bounds).contains(point) else { return }
    activate()
  }

  override func accessibilityPerformPress() -> Bool { activate() }
  @discardableResult private func activate() -> Bool {
    guard let item, item.isEnabled, let menu = item.menu else { return false }
    let index = menu.index(of: item)
    guard index >= 0 else { return false }
    menu.cancelTracking()
    menu.performActionForItem(at: index)
    return true
  }
}

/// The terminal palette can be dark while the system menu is light (or vice
/// versa). Keep its status hues, with enough contrast for these small glyphs
/// on the menu's translucent surface. Monochrome colors stay monochrome.
private func statusMenuActivityColor(_ color: NSColor, appearance: NSAppearance) -> NSColor {
  guard let source = color.usingColorSpace(.sRGB) else { return .labelColor }
  let dark = appearance.bestMatch(from: [.darkAqua, .aqua]) == .darkAqua
  let background = NSColor(srgbRed: dark ? 0.16 : 0.72, green: dark ? 0.16 : 0.72,
                           blue: dark ? 0.16 : 0.72, alpha: 1)
  func luminance(_ color: NSColor) -> CGFloat {
    func linear(_ c: CGFloat) -> CGFloat { c <= 0.04045 ? c / 12.92 : pow((c + 0.055) / 1.055, 2.4) }
    return 0.2126 * linear(color.redComponent) + 0.7152 * linear(color.greenComponent) + 0.0722 * linear(color.blueComponent)
  }
  let base = luminance(background)
  let target: CGFloat = dark ? 1 : 0
  for step in 0...20 {
    let amount = CGFloat(step) / 20
    let ink = NSColor(srgbRed: source.redComponent * (1 - amount) + target * amount,
                      green: source.greenComponent * (1 - amount) + target * amount,
                      blue: source.blueComponent * (1 - amount) + target * amount, alpha: 1)
    let light = luminance(ink)
    if (max(light, base) + 0.05) / (min(light, base) + 0.05) >= 4.5 { return ink }
  }
  return dark ? .white : .black
}
