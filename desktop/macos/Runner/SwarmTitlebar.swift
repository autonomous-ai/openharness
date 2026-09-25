import Cocoa
import FlutterMacOS
import ImageIO

/// Real AppKit controls in the title bar, beside the system traffic lights.
/// https://developer.apple.com/documentation/appkit/nstitlebaraccessoryviewcontroller/layoutattribute
final class SwarmTitlebar: NSObject, NSMenuItemValidation, NSMenuDelegate {
  private weak var window: NSWindow?
  private let channel: FlutterMethodChannel
  private let accessory = NSTitlebarAccessoryViewController()
  private let strip = SwarmTabStrip(frame: NSRect(x: 0, y: 0, width: 900, height: 40))
  private var observers: [NSObjectProtocol] = []
  private var configured = false
  private var actionsEnabled = false
  private var canReopen = false
  private var canFind = false
  private var canClosePane = false
  private var paneActions: [String: Bool] = [:]
  private let historyMenu = NSMenu(title: "History")
  private var historyMenuNeedsRebuild = false
  private var historyMenuIsOpen = false
  private var canGoBack = false
  private var canGoForward = false
  private var history: [SwarmHistoryEntry] = []
  private var closedHistory: [SwarmHistoryEntry] = []
  private let historyIcons = SwarmHistoryIcons()
  private var machines: [SwarmMachineEntry] = []
  private var keymap: HarnessNativeKeymap?
  private var flutterKeyContext = "workspace"
  private var tabActionGeneration = 0

  init(window: NSWindow, messenger: FlutterBinaryMessenger) {
    self.window = window
    channel = FlutterMethodChannel(name: "harness/swarm_tabs", binaryMessenger: messenger)
    super.init()
    strip.emit = { [weak self] method, args in
      guard let self else { return }
      self.sendTabAction(method, arguments: args)
    }
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { result(nil); return }
      switch call.method {
      case "configure":
        let state = call.arguments as? [String: Any] ?? [:]
        self.configure(palette: state["palette"] as? [String: Any])
        result(true)
      case "update":
        let state = call.arguments as? [String: Any] ?? [:]
        self.actionsEnabled = state["enabled"] as? Bool == true
        self.canReopen = state["canReopen"] as? Bool == true
        self.canFind = state["canFind"] as? Bool == true
        self.canClosePane = state["canClosePane"] as? Bool == true
        self.paneActions = state["paneActions"] as? [String: Bool] ?? [:]
        self.canGoBack = state["canGoBack"] as? Bool == true
        self.canGoForward = state["canGoForward"] as? Bool == true
        self.updateHistory(state["history"] as? [[String: Any]] ?? [], closed: state["closedHistory"] as? [[String: Any]] ?? [])
        self.strip.update(state)
        self.window?.backgroundColor = self.strip.palette.tabBar
        result(nil)
      case "machinesState":
        let state = call.arguments as? [String: Any] ?? [:]
        self.updateMachines(state["machines"] as? [[String: Any]] ?? [])
        result(nil)
      case "playAlert":
        // A named macOS system sound. Every Mac has these, so no audio asset ships with the app,
        // nothing has to be decoded, and the alert plays at whatever volume the person has set for
        // alerts rather than at one this app decided. An unknown name is silence, not a crash.
        let args = call.arguments as? [String: Any] ?? [:]
        if let name = args["sound"] as? String, let sound = NSSound(named: name) {
          sound.play()
        }
        result(nil)
      case "keymapState":
        guard let payload = call.arguments as? [String: Any],
              let map = HarnessNativeKeymap(payload) else {
          result(FlutterError(code: "INVALID_KEYMAP", message: "Invalid keyboard configuration", details: nil))
          return
        }
        self.setKeymap(map)
        result(nil)
      case "keymapContext":
        if let context = (call.arguments as? [String: Any])?["context"] as? String,
           HarnessNativeKeymap.contexts.contains(context) {
          self.flutterKeyContext = context
          self.syncMenuKeys()
        }
        result(nil)
      default: result(FlutterMethodNotImplemented)
      }
    }
    for name in [NSWindow.didResizeNotification, NSWindow.didEnterFullScreenNotification,
                 NSWindow.didExitFullScreenNotification] {
      observers.append(NotificationCenter.default.addObserver(forName: name, object: window, queue: .main) {
        [weak self] _ in self?.resize()
      })
    }

  }

  deinit {
    observers.forEach(NotificationCenter.default.removeObserver)
  }

  private func sendTabAction(_ method: String, arguments: Any?) {
    guard ["focusedModel", "focusedContext", "harnessControls", "machineControls", "modelControls", "select", "close", "new", "rename", "commands", "notifications", "store", "sessions", "models", "addAgent", "newAgent", "newTerminal", "cloneAgent", "restartAgent", "shareAgent", "toggleViewer", "toggleComposer", "movePaneToTab", "runLocalModel", "splitRight", "splitDown", "zoomPane", "pinPane", "machineDestination", "machineAgent", "manageMachines", "machineList"].contains(method) else {
      channel.invokeMethod(method, arguments: arguments)
      return
    }
    tabActionGeneration += 1
    let generation = tabActionGeneration
    // Keyboard/VoiceOver activation can leave a button as responder. Wait for
    // Flutter to apply the action before giving the next key to its content.
    channel.invokeMethod(method, arguments: arguments) { [weak self, weak responder = window?.firstResponder] result in
      guard let self, let window = self.window, generation == self.tabActionGeneration,
            !(result is FlutterError), result as? NSObject !== FlutterMethodNotImplemented,
            window.firstResponder === responder || window.firstResponder === window else { return }
      self.focusContent(in: window)
    }
  }

  func startQuickStart() {
    guard actionsEnabled else { return }
    sendTabAction("keymapCommand", arguments: ["command": "keyboard.quick_start"])
  }

  private func focusContent(in window: NSWindow) {
    guard let content = window.contentViewController?.view else { return }
    // Keep a text field/Flutter input that already took focus while Dart was
    // handling the action. The controller accepts ordinary keys, but Flutter's
    // view wrapper only forwards Command equivalents for its input view.
    if let current = window.firstResponder as? NSView,
       current.isDescendant(of: content) { return }
    func input(in view: NSView) -> NSView? {
      guard !view.isHidden else { return nil }
      if view.acceptsFirstResponder { return view }
      for child in view.subviews {
        if let target = input(in: child) { return target }
      }
      return nil
    }
    window.makeFirstResponder(input(in: content) ?? window.contentViewController)
  }

  private func setKeymap(_ map: HarnessNativeKeymap) {
    keymap = map
    // Mouse controls teach the effective shortcuts, including user remaps.
    strip.newButton.toolTip = "New Tab " + (map.hint(for: "swarm.new", context: "workspace") ?? "")
    if let main = NSApp.mainMenu, let window {
      let menu = main as? HarnessKeymapMenu ?? HarnessKeymapMenu.replacing(main)
      if NSApp.mainMenu !== menu { NSApp.mainMenu = menu }
      menu.update(map, window: window)
      menu.dispatchViewerCommand = { [weak self] command in
        guard let self, self.actionsEnabled else { return false }
        self.channel.invokeMethod("keymapCommand", arguments: ["command": command])
        return true
      }
    }
    syncMenuKeys()
  }

  private func syncMenuKeys() {
    guard let keymap, let main = NSApp.mainMenu else { return }
    keymap.applyMenuKeys(to: main, context: flutterKeyContext)
  }

  private func configure(palette: [String: Any]? = nil) {
    // Appearance is loaded before the workspace exists. Apply it before the
    // explicit show request, without inventing tabs or enabling their actions.
    if let palette {
      strip.updatePalette(palette)
      window?.backgroundColor = strip.palette.tabBar
    }
    guard let window, !configured else { return }
    configured = true
    NSWindow.allowsAutomaticWindowTabbing = false
    window.tabbingMode = .disallowed
    window.title = "Harness"
    window.titleVisibility = .hidden
    window.titlebarAppearsTransparent = true
    window.styleMask.remove(.fullSizeContentView)
    window.backgroundColor = strip.palette.tabBar
    // AppKit fixes a right accessory's height to the title bar. A taller view
    // alone is clipped. The compact unified toolbar keeps the traffic lights
    // and tabs in one 40pt row; unified adds 12pt of empty vertical space.
    let toolbar = NSToolbar(identifier: "harness.swarm.titlebar")
    toolbar.displayMode = .iconOnly
    toolbar.allowsUserCustomization = false
    window.toolbar = toolbar
    window.toolbarStyle = .unifiedCompact
    window.titlebarSeparatorStyle = .none
    accessory.layoutAttribute = .right
    accessory.view = strip
    window.addTitlebarAccessoryViewController(accessory)
    resize()
    installWorkspaceMenus()
    if let keymap { setKeymap(keymap) }
    // Toolbar controls must not become the window's initial input owner.
    focusContent(in: window)
  }

  private func resize() {
    guard let window else { return }
    // AppKit owns height; only width is configurable for a right accessory.
    let trafficLightEdge = window.standardWindowButton(.zoomButton).map {
      $0.convert($0.bounds, to: nil).maxX
    } ?? 69
    // 10 after the buttons, which is where a Mac app puts its first control:
    // the cluster ends at 69 on macOS 26, Safari's sidebar button and Chrome's
    // first tab both start around 79. This was `max(88, edge + 16)` while the
    // notifications bell still sat in front of the tabs; with the bell gone
    // that left the first tab at 88, a good ten points adrift of every other
    // window on the screen. The floor stays for a window with no buttons to
    // measure — the `?? 69` above is the same fallback read from the other end.
    let leading = max(76, trafficLightEdge + 10)
    strip.setFrameSize(NSSize(width: max(200, window.frame.width - leading), height: strip.frame.height))
    strip.needsLayout = true
  }

  private func installWorkspaceMenus() {
    guard let main = NSApp.mainMenu, main.item(withTitle: "History") == nil else { return }
    // The stock Flutter nib includes a disabled Preferences placeholder. Make
    // the app-menu command work, and give ⌘, a single native owner.
    if let appMenu = main.item(at: 0)?.submenu {
      let settings = appMenu.items.first(where: { $0.keyEquivalent == "," }) ??
        NSMenuItem(title: "Settings…", action: nil, keyEquivalent: ",")
      settings.title = "Settings…"
      settings.target = self
      settings.action = #selector(menuAction(_:))
      settings.representedObject = "settings"
      settings.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + "settings")
      settings.keyEquivalentModifierMask = [.command]
      if settings.menu == nil { appMenu.insertItem(settings, at: min(2, appMenu.numberOfItems)) }
      let customize = NSMenuItem(title: "Customize Harness", action: #selector(menuAction(_:)), keyEquivalent: "")
      customize.target = self
      customize.representedObject = "customize"
      customize.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + "customize")
      customize.image = NSImage(systemSymbolName: "paintpalette", accessibilityDescription: nil)
      appMenu.insertItem(customize, at: appMenu.index(of: settings))
    }
    func add(_ menu: NSMenu, _ title: String, _ key: String, _ action: String, _ modifiers: NSEvent.ModifierFlags = [.command]) {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
      item.keyEquivalentModifierMask = modifiers
      item.target = self
      item.representedObject = action
      item.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + action)
      let symbols = [
        "new": "plus.square", "newAgent": "plus", "addAgent": "arrow.up.right.square", "newTerminal": "terminal",
        "cloneAgent": "plus.square.on.square", "restartAgent": "arrow.clockwise",
        "shareAgent": "square.and.arrow.up",
        "renameActive": "pencil", "closeActive": "xmark",
        "splitRight": "rectangle.split.2x1", "splitDown": "rectangle.split.1x2",
        "zoomPane": "viewfinder", "movePaneToTab": "arrow.right.square", "closePane": "xmark",
        "commands": "command", "notifications": "bell",
      ]
      if let symbol = symbols[action] {
        item.image = NSImage(systemSymbolName: symbol, accessibilityDescription: title)
      }
      menu.addItem(item)
    }
    func install(_ menu: NSMenu, at index: Int) {
      let item = NSMenuItem(title: menu.title, action: nil, keyEquivalent: "")
      item.submenu = menu
      main.insertItem(item, at: index)
    }
    if let file = main.item(withTitle: "File") { main.removeItem(file) }
    let file = NSMenu(title: "File")
    // Three groups, most-used first: harnesses, then tabs, then panes. Plain titles, no trailing
    // ellipsis (owner, 2026-09-22). The Dart keymap decides every chord below — applyMenuKeys
    // rewrites each equivalent here from it. New Terminal (⇧⌘T) stays in the keymap, off the menu.
    add(file, "New Harness", "n", "newAgent")
    add(file, "Open Harness", "o", "addAgent")
    // ⌘⇧N: another agent like the focused pane's, fresh conversation (Dart: `agent.clone`).
    add(file, "Clone Harness", "n", "cloneAgent", [.command, .shift])
    // ⌘⇧E: the pane's harness starts again where it is (Dart: `agent.restart`).
    add(file, "Restart Harness", "e", "restartAgent", [.command, .shift])
    add(file, "Share Harness", "", "shareAgent")
    file.addItem(.separator())
    add(file, "New Tab", "t", "new")
    add(file, "Rename Tab", "r", "renameActive", [.command, .shift])
    add(file, "Close Tab", "w", "closeActive")
    file.addItem(.separator())
    add(file, "Split Right", "r", "splitRight")
    add(file, "Split Down", "d", "splitDown")
    add(file, "Zoom Pane", "", "zoomPane")
    add(file, "Move Pane to Tab", "m", "movePaneToTab", [.command, .shift])
    add(file, "Close Pane", "w", "closePane", [.command, .shift])
    install(file, at: 1)

    historyMenu.delegate = self
    rebuildHistoryMenu()
    install(historyMenu, at: main.items.firstIndex(where: { $0.title == "Window" }) ?? main.numberOfItems)

    // Native menu hints mirror Flutter; the shared picker owns all editing.
    if let edit = main.item(withTitle: "Edit")?.submenu {
      edit.addItem(.separator())
      add(edit, "Search Commands…", "p", "commands", [.command, .shift])
    }
    if let view = main.item(withTitle: "View")?.submenu {
      view.addItem(.separator())
      add(view, "Harnesses", "p", "sessions")
      add(view, "Harnesses Needing Input…", "i", "notifications", [.command, .shift])
      add(view, "Machines", "m", "machineList")
      add(view, "Models", "i", "models")
      add(view, "Machine Monitor", "", "manageMachines")
      view.addItem(.separator())
      add(view, "Toggle Viewer", "", "toggleViewer")
      add(view, "Toggle Message Composer", "", "toggleComposer")
    }
    installTerminalFindMenu(main)
  }

  func menuWillOpen(_ menu: NSMenu) {
    if menu === historyMenu {
      historyMenuIsOpen = true
      if historyMenuNeedsRebuild { rebuildHistoryMenu() }
    }
    syncMenuKeys()
    if menu === historyMenu {
      for item in menu.items {
        guard let row = item.view as? SwarmHistoryMenuRow else { continue }
        item.isEnabled = validateMenuItem(item)
        row.setAccessibilityEnabled(item.isEnabled)
        row.needsDisplay = true
      }
    }
  }

  func menuDidClose(_ menu: NSMenu) {
    if menu === historyMenu { historyMenuIsOpen = false }
  }

  private func updateMachines(_ rows: [[String: Any]]) {
    let entries = rows.prefix(128).compactMap(SwarmMachineEntry.init)
    guard entries != machines else { return }
    machines = entries
  }

  private func updateHistory(_ rows: [[String: Any]], closed: [[String: Any]] = []) {
    let entries = rows.prefix(64).compactMap(SwarmHistoryEntry.init)
    let closedEntries = closed.prefix(24).compactMap(SwarmHistoryEntry.init)
    guard entries != history || closedEntries != closedHistory else { return }
    history = entries
    closedHistory = closedEntries
    // Navigation updates the models immediately for action validation. Keep the
    // installed shortcut items, but defer hidden row construction and sizing.
    historyMenuNeedsRebuild = true
    if historyMenuIsOpen { rebuildHistoryMenu() }
  }

  private func rebuildHistoryMenu() {
    historyMenuNeedsRebuild = false
    historyMenu.removeAllItems()
    historyMenu.minimumWidth = 0
    let visited = Array(history.prefix(15))
    let closed = Array(closedHistory.prefix(10))
    let trailingEdge = SwarmMenuText.trailingEdge((closed + visited).map { ($0.menuName, $0.menuMachine) })
    func command(_ title: String, _ key: String, _ action: String) {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
      item.target = self
      item.representedObject = action
      item.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + action)
      item.keyEquivalentModifierMask = [.command]
      historyMenu.addItem(item)
    }
    command("Back", "[", "historyBack")
    command("Forward", "]", "historyForward")
    // No default chord: ⌘⇧T is New Terminal now. A person can give this one in keybindings.jsonc.
    let reopen = NSMenuItem(title: "Reopen Closed Tab or Pane", action: #selector(menuAction(_:)), keyEquivalent: "")
    reopen.target = self
    reopen.representedObject = "reopen"
    reopen.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + "reopen")
    historyMenu.addItem(reopen)
    historyMenu.addItem(.separator())
    appendHistorySection("Recently Closed", entries: closed, closed: true, trailingEdge: trailingEdge)
    historyMenu.addItem(.separator())
    appendHistorySection("Recently Visited", entries: visited, closed: false, trailingEdge: trailingEdge)
    historyMenu.addItem(.separator())
    command("Show Full History", "y", "showHistory")
    if let keymap { keymap.applyMenuKeys(to: historyMenu, context: flutterKeyContext) }
    let rowWidth = ceil(historyMenu.size.width * 1.2)
    historyMenu.minimumWidth = rowWidth
    for item in historyMenu.items {
      guard let id = item.representedObject as? String,
            let entry = (closed + visited).first(where: { $0.id == id }) else { continue }
      item.view = SwarmHistoryMenuRow(item: item, entry: entry, width: rowWidth)
    }
  }

  func menu(_ menu: NSMenu, willHighlight item: NSMenuItem?) {
    guard menu === historyMenu else { return }
    for row in menu.items {
      (row.view as? SwarmHistoryMenuRow)?.highlighted = row === item
    }
  }

  private func appendHistorySection(_ title: String, entries: [SwarmHistoryEntry], closed: Bool, trailingEdge: CGFloat) {
    if #available(macOS 14.0, *) {
      historyMenu.addItem(NSMenuItem.sectionHeader(title: title))
    } else {
      let label = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      label.isEnabled = false
      historyMenu.addItem(label)
    }
    for entry in entries {
      let title = entry.title.count > 76 ? String(entry.title.prefix(48)) + "…" + String(entry.title.suffix(24)) : entry.title
      let item = NSMenuItem(title: title, action: closed ? #selector(closedHistoryAction(_:)) : #selector(historyAction(_:)), keyEquivalent: "")
      item.attributedTitle = entry.menuTitle(trailingEdge: trailingEdge)
      item.target = self
      item.representedObject = entry.id
      item.state = entry.current ? .on : .off
      item.image = entry.swarm && !entry.store && entry.agentCount != 1
        ? SwarmIdentity.menuIcon
        : historyIcons.image(engine: entry.engine, asset: entry.iconAsset)
      historyMenu.addItem(item)
    }
    if entries.isEmpty {
      let item = NSMenuItem(title: closed ? "No Recently Closed Tabs or Panes" : "No Recent Visits", action: nil, keyEquivalent: "")
      item.isEnabled = false
      historyMenu.addItem(item)
    }
  }

  private func installTerminalFindMenu(_ main: NSMenu) {
    guard let edit = main.items.first(where: { $0.title == "Edit" })?.submenu,
          let find = edit.items.first(where: { $0.title == "Find" }) else { return }
    let menu = NSMenu(title: "Find")
    for (title, key, action, modifiers) in [
      ("Find in Terminal…", "f", "findTerminal", NSEvent.ModifierFlags.command),
      ("Find Next", "g", "findNext", NSEvent.ModifierFlags.command),
      ("Find Previous", "g", "findPrevious", NSEvent.ModifierFlags([.command, .shift])),
    ] {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
      item.keyEquivalentModifierMask = modifiers
      item.target = self
      item.representedObject = action
      item.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + action)
      menu.addItem(item)
    }
    // The template's find/replace actions target an unused text-editor handler.
    // Terminal output is searchable; replacement belongs to the running tool.
    find.submenu = menu
  }

  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool {
    if menuItem.action == #selector(machineAgentAction(_:)) {
      guard actionsEnabled, let target = menuItem.representedObject as? [String: String],
            let machine = machines.first(where: { $0.id == target["machineId"] }) else { return false }
      return machine.agents.contains(where: { $0.id == target["agentId"] && $0.canOpen })
    }
    let action = menuItem.representedObject as? String ?? ""
    if ["restartAgent", "shareAgent", "toggleViewer", "toggleComposer"].contains(action) {
      return actionsEnabled && paneActions[action] == true
    }
    if menuItem.action == #selector(machineAction(_:)) {
      return actionsEnabled && machines.contains(where: { $0.id == action })
    }
    if menuItem.action == #selector(machineDeleteAction(_:)) {
      return actionsEnabled && machines.contains(where: { $0.id == action && !$0.local })
    }
    if menuItem.action == #selector(runLocalModelAction(_:)) {
      return actionsEnabled && machines.contains(where: { $0.id == action })
    }
    if menuItem.action == #selector(historyAction(_:)) {
      return actionsEnabled && history.contains(where: { $0.id == action })
    }
    if menuItem.action == #selector(closedHistoryAction(_:)) {
      return actionsEnabled && closedHistory.contains(where: { $0.id == action && $0.canReopen })
    }
    return actionsEnabled && (action != "reopen" || canReopen) &&
      (action != "historyBack" || canGoBack) && (action != "historyForward" || canGoForward) &&
      (action != "closePane" || canClosePane) &&
      (!["findTerminal", "findNext", "findPrevious", "splitRight", "splitDown", "zoomPane", "pinPane", "movePaneToTab"].contains(action) || canFind)
  }

  @objc private func menuAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let action = sender.representedObject as? String else { return }
    sendTabAction(action, arguments: nil)
  }

  @objc private func machineAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let id = sender.representedObject as? String else { return }
    sendTabAction("machineDestination", arguments: ["id": id])
  }

  @objc private func runLocalModelAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let id = sender.representedObject as? String else { return }
    sendTabAction("runLocalModel", arguments: ["machineId": id])
  }

  @objc private func machineDeleteAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let id = sender.representedObject as? String else { return }
    sendTabAction("deleteMachine", arguments: ["id": id])
  }

  @objc private func machineAgentAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let target = sender.representedObject as? [String: String] else { return }
    sendTabAction("machineAgent", arguments: target)
  }

  @objc private func historyAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let id = sender.representedObject as? String else { return }
    channel.invokeMethod("historyDestination", arguments: ["id": id])
  }

  @objc private func closedHistoryAction(_ sender: NSMenuItem) {
    guard validateMenuItem(sender), let id = sender.representedObject as? String else { return }
    channel.invokeMethod("reopenHistory", arguments: ["id": id])
  }
}

private enum SwarmIdentity {
  // Same four separate tiles as widgets/swarm_icon.dart.
  static let menuIcon = NSImage(systemSymbolName: "square.grid.2x2", accessibilityDescription: nil)
}

private struct SwarmMachineEntry: Equatable {
  let id: String
  let name: String
  let status: String
  let presence: String
  let linkRequired: Bool
  let local: Bool
  let agentCount: Int?
  let agents: [SwarmMachineAgent]
  let shared: Bool
  let ownerName: String
  init?(_ row: [String: Any]) {
    guard let id = row["id"] as? String, !id.isEmpty,
          let name = row["name"] as? String, !name.isEmpty else { return nil }
    self.id = id
    self.name = String(name.prefix(128))
    status = String((row["status"] as? String ?? "").prefix(80))
    presence = String((row["presence"] as? String ?? "").prefix(80))
    linkRequired = row["linkRequired"] as? Bool == true
    shared = row["shared"] as? Bool == true
    ownerName = String((row["ownerName"] as? String ?? "").prefix(100))
    local = row["local"] as? Bool == true
    agentCount = (row["agentCount"] as? Int).map { max(0, $0) }
    agents = (row["agents"] as? [[String: Any]] ?? []).prefix(512).compactMap(SwarmMachineAgent.init)
  }
}

private struct SwarmMachineAgent: Equatable {
  let id: String
  let title: String
  let engine: String?
  let iconAsset: String?
  let canOpen: Bool
  /// Its conversation is saved but nothing is running: choosing it resumes rather than attaches.
  let stopped: Bool
  init?(_ row: [String: Any]) {
    guard let id = row["id"] as? String, !id.isEmpty,
          let title = row["title"] as? String, !title.isEmpty else { return nil }
    self.id = id
    self.title = String(title.prefix(160)).replacingOccurrences(of: "\n", with: " ")
    engine = row["engine"] as? String
    iconAsset = row["iconAsset"] as? String
    canOpen = row["canOpen"] as? Bool == true
    stopped = row["stopped"] as? Bool == true
  }
}

/// A History row uses the full menu width; shortcut columns belong to commands.
/// Native item titles/actions still own type-select, validation and activation.
private final class SwarmHistoryMenuRow: NSView {
  private weak var item: NSMenuItem?
  private let entry: SwarmHistoryEntry
  var highlighted = false { didSet { needsDisplay = true } }
  var machineFrame: NSRect {
    let width = ceil(SwarmMenuText.width(entry.menuMachine))
    let font = NSFont.menuFont(ofSize: 0)
    let height = ceil(font.ascender - font.descender + font.leading)
    return NSRect(x: bounds.width - 18 - width, y: (bounds.height - height) / 2, width: width, height: height)
  }

  init(item: NSMenuItem, entry: SwarmHistoryEntry, width: CGFloat) {
    self.item = item
    self.entry = entry
    super.init(frame: NSRect(x: 0, y: 0, width: width, height: 24))
    autoresizingMask = [.width]
    setAccessibilityElement(true)
    setAccessibilityRole(.menuItem)
    setAccessibilityLabel([entry.title, entry.machineName].filter { !$0.isEmpty }.joined(separator: ", "))
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    highlighted = false
    setAccessibilityEnabled(item?.isEnabled == true)
    needsDisplay = true
  }
  override func draw(_ dirtyRect: NSRect) {
    guard let item else { return }
    let selected = highlighted && item.isEnabled
    if selected {
      NSColor.selectedContentBackgroundColor.setFill()
      NSBezierPath(roundedRect: bounds.insetBy(dx: 4, dy: 0), xRadius: 5, yRadius: 5).fill()
    }
    let color = !item.isEnabled ? NSColor.disabledControlTextColor
      : selected ? .selectedMenuItemTextColor : .labelColor
    let attributes: [NSAttributedString.Key: Any] = [.font: NSFont.menuFont(ofSize: 0), .foregroundColor: color]
    if item.state == .on {
      let mark = NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)!
      let tinted = mark.copy() as! NSImage
      tinted.lockFocus()
      color.set()
      NSRect(origin: .zero, size: tinted.size).fill(using: .sourceAtop)
      tinted.unlockFocus()
      tinted.draw(in: NSRect(x: 7, y: 5, width: 13, height: 13))
    }
    if let icon = item.image {
      if icon.isTemplate, let tinted = icon.copy() as? NSImage {
        tinted.lockFocus()
        color.set()
        NSRect(origin: .zero, size: tinted.size).fill(using: .sourceAtop)
        tinted.unlockFocus()
        tinted.draw(in: NSRect(x: 25, y: 4, width: 16, height: 16))
      } else {
        icon.draw(in: NSRect(x: 25, y: 4, width: 16, height: 16))
      }
    }
    let right = entry.menuMachine.isEmpty ? bounds.width - 18 : machineFrame.minX - 20
    let name = SwarmMenuText.fitted(entry.title, width: max(0, right - 48))
    (name as NSString).draw(at: NSPoint(x: 48, y: machineFrame.minY), withAttributes: attributes)
    (entry.menuMachine as NSString).draw(at: machineFrame.origin, withAttributes: attributes)
  }
  override func mouseUp(with event: NSEvent) {
    guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
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

/// Keep native menu columns aligned without reserving a fixed, empty span.
private enum SwarmMenuText {
  static func width(_ text: String) -> CGFloat {
    (text as NSString).size(withAttributes: [.font: NSFont.menuFont(ofSize: 0)]).width
  }

  static func fitted(_ text: String, width limit: CGFloat) -> String {
    var value = text.replacingOccurrences(of: "\t", with: " ").replacingOccurrences(of: "\n", with: " ")
    if width(value) <= limit { return value }
    while !value.isEmpty && width(value + "…") > limit { value.removeLast() }
    return value + "…"
  }

  static func trailingEdge(_ rows: [(String, String)]) -> CGFloat {
    let leading = rows.map { width($0.0) }.max() ?? 0
    let paired = rows.filter { !$0.1.isEmpty }
    let pairedLeading = paired.map { width($0.0) }.max() ?? 0
    let trailing = paired.map { width($0.1) }.max() ?? 0
    return ceil(max(leading, pairedLeading + (trailing > 0 ? 18 + trailing : 0)))
  }
}

private struct SwarmHistoryEntry: Equatable {
  let id: String
  let title: String
  let detail: String
  let machineName: String
  let swarm: Bool
  /// The Harness Store's tab: no agents, but not an empty group either.
  let store: Bool
  let agentCount: Int?
  let current: Bool
  let engine: String?
  let iconAsset: String?
  let canReopen: Bool
  var menuName: String { SwarmMenuText.fitted(title, width: machineName.isEmpty ? 330 : 250) }
  var menuMachine: String { SwarmMenuText.fitted(machineName, width: 140) }

  func menuTitle(trailingEdge: CGFloat? = nil) -> NSAttributedString {
    let font = NSFont.menuFont(ofSize: 0)
    let name = menuName
    let machine = menuMachine
    let paragraph = NSMutableParagraphStyle()
    paragraph.tabStops = [NSTextTab(textAlignment: .right,
      location: trailingEdge ?? SwarmMenuText.trailingEdge([(name, machine)]))]
    return NSAttributedString(string: machine.isEmpty ? name : name + "\t" + machine,
      attributes: [.font: font, .paragraphStyle: paragraph])
  }

  init?(_ row: [String: Any]) {
    guard let id = row["id"] as? String, let title = row["title"] as? String else { return nil }
    self.id = id
    self.title = title
    detail = row["detail"] as? String ?? ""
    machineName = row["machineName"] as? String ?? ""
    swarm = row["swarm"] as? Bool == true
    store = row["store"] as? Bool == true
    agentCount = row["agentCount"] as? Int
    current = row["current"] as? Bool == true
    engine = (row["engine"] as? String)?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased()
    iconAsset = row["iconAsset"] as? String
    canReopen = row["canReopen"] as? Bool == true
  }
}

/// Reuse the same bundled engine artwork as pane headers. Each menu mark is
/// decoded once at twice its display size, rather than retaining a full-size bitmap
/// or reopening assets on every history/focus update.
private final class SwarmHistoryIcons {
  /// The Flutter assets this opens: engine and harness artwork, and the app
  /// polymath mark the Harness Store wears (`kStoreMarkAsset` in
  /// lib/store/store_mark.dart). Any other path draws the engine's initial,
  /// which is how the store tab once read "S".
  static func opens(_ asset: String) -> Bool {
    !asset.contains("..") && (asset == "assets/app_icon.png" || asset == "assets/harnesses.png" || asset == "assets/machines.svg" || asset == "assets/models.svg" || asset == "assets/harnesses.svg" || asset == "assets/models.png" || asset == "assets/store/polymath.png"
      || asset.hasPrefix("assets/engine-icons/") && asset.hasSuffix(".png"))
  }

  private let cache = NSCache<NSString, NSImage>()
  private let assetURL: (String) -> URL?

  init(assetURL: @escaping (String) -> URL? = { asset in
    // Flutter ships desktop assets inside App.framework, not the runner bundle.
    let framework = Bundle.main.privateFrameworksURL?.appendingPathComponent("App.framework")
    let bundle = framework.flatMap { Bundle(url: $0) }
      ?? Bundle(identifier: "io.flutter.flutter.app")
      ?? Bundle.main
    return bundle.resourceURL?.appendingPathComponent("flutter_assets").appendingPathComponent(asset)
  }) {
    self.assetURL = assetURL
    cache.countLimit = 32
  }

  func image(engine: String?, asset: String?, pointSize: CGFloat = 16) -> NSImage {
    let id = engine?.trimmingCharacters(in: .whitespacesAndNewlines).lowercased() ?? ""
    let key = "\(id):\(asset ?? ""):\(pointSize)" as NSString
    if let image = cache.object(forKey: key) { return image }
    let size = NSSize(width: pointSize, height: pointSize)
    let image: NSImage
    if let asset, SwarmHistoryIcons.opens(asset), asset.hasSuffix(".svg"), let url = assetURL(asset),
       let vector = NSImage(contentsOf: url) {
      // Preserve the SVG representation so AppKit redraws sharply at any scale.
      vector.size = size
      vector.isTemplate = true
      image = vector
    } else if let asset, SwarmHistoryIcons.opens(asset),
       let url = assetURL(asset),
       let source = CGImageSourceCreateWithURL(url as CFURL, nil),
       let thumbnail = CGImageSourceCreateThumbnailAtIndex(source, 0, [
         kCGImageSourceCreateThumbnailFromImageAlways: true,
         kCGImageSourceCreateThumbnailWithTransform: true,
         kCGImageSourceThumbnailMaxPixelSize: Int(ceil(pointSize * 2)),
         kCGImageSourceShouldCacheImmediately: true,
       ] as CFDictionary) {
      let bitmap = NSImage(cgImage: thumbnail, size: .zero)
      let scale = pointSize / CGFloat(max(thumbnail.width, thumbnail.height))
      let width = CGFloat(thumbnail.width) * scale
      let height = CGFloat(thumbnail.height) * scale
      image = NSImage(size: size, flipped: false) { _ in
        bitmap.draw(in: NSRect(x: (pointSize - width) / 2, y: (pointSize - height) / 2, width: width, height: height))
        return true
      }
    } else if id == "store", let appIcon = NSApp.applicationIconImage {
      // The bundled copy did not load; the Dock's icon is the same mark.
      image = NSImage(size: size, flipped: false) { _ in
        appIcon.draw(in: NSRect(origin: .zero, size: size))
        return true
      }
    } else if id == "claude" {
      // Same four round strokes, proportions and orange as EngineMark.
      image = NSImage(size: size, flipped: false) { _ in
        NSColor(srgbRed: 204.0 / 255, green: 124.0 / 255, blue: 94.0 / 255, alpha: 1).setStroke()
        let path = NSBezierPath()
        path.lineWidth = pointSize * 0.098
        path.lineCapStyle = .round
        for i in 0..<4 {
          let angle = CGFloat(i) * .pi / 4
          let dx = pointSize * 0.39 * cos(angle), dy = pointSize * 0.39 * sin(angle)
          path.move(to: NSPoint(x: pointSize / 2 - dx, y: pointSize / 2 - dy))
          path.line(to: NSPoint(x: pointSize / 2 + dx, y: pointSize / 2 + dy))
        }
        path.stroke()
        return true
      }
    } else {
      image = NSImage(size: size, flipped: false) { _ in
        // A harness id is `owner/name`: its initial is the name's, not the owner's — every
        // `autonomous/…` harness without artwork used to read "A".
        let name = id.split(separator: "/").last.map(String.init) ?? id
        let initial = String(name.first ?? "A").uppercased() as NSString
        let attributes: [NSAttributedString.Key: Any] = [
          // Raster artwork for a fallback icon, not a UI text label.
          .font: NSFont.monospacedSystemFont(ofSize: pointSize * 11 / 16, weight: .bold),
          .foregroundColor: NSColor.black,
        ]
        let bounds = initial.size(withAttributes: attributes)
        initial.draw(at: NSPoint(x: (pointSize - bounds.width) / 2, y: (pointSize - bounds.height) / 2), withAttributes: attributes)
        return true
      }
      image.isTemplate = true
    }
    cache.setObject(image, forKey: key)
    return image
  }
}

private let swarmPasteboardType = NSPasteboard.PasteboardType("ai.autonomous.harness.v2.swarm")
/// Dart's palette is authoritative. These defaults match Graphite before its
/// first snapshot arrives; every window retains its own resolved colors.
private struct SwarmNativePalette: Equatable {
  let tabBar: NSColor
  let workspace: NSColor
  let search: NSColor
  let accent: NSColor

  init(_ values: [String: Any] = [:]) {
    func color(_ name: String, _ fallback: UInt32) -> NSColor {
      let supplied = values[name] as? Int64
      let valid = supplied.map { $0 >= 0 && $0 <= Int64(UInt32.max) && ($0 >> 24) == 255 } ?? false
      let argb = valid ? UInt32(supplied!) : fallback
      return NSColor(srgbRed: CGFloat((argb >> 16) & 255) / 255,
        green: CGFloat((argb >> 8) & 255) / 255, blue: CGFloat(argb & 255) / 255, alpha: 1)
    }
    tabBar = color("tabBar", 0xff1c1c1c)
    workspace = color("workspace", 0xff282828)
    search = color("search", 0xff2c2c2c)
    accent = color("accent", 0xffbdcbdc)
  }
}

/// Generic native icon controls retain their rounded hover wells.
private class SwarmIconButton: NSButton {
  private(set) var hovered = false
  private(set) var hasKeyboardFocus = false
  var showsHoverFill: Bool { true }
  override var acceptsFirstResponder: Bool { isEnabled }
  override var mouseDownCanMoveWindow: Bool { false }
  override var isEnabled: Bool {
    didSet {
      needsDisplay = true
      window?.invalidateCursorRects(for: self)
    }
  }

  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    trackingAreas.forEach(removeTrackingArea)
    addTrackingArea(NSTrackingArea(rect: .zero,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self))
  }
  override func mouseEntered(with event: NSEvent) { hovered = true; needsDisplay = true }
  override func mouseExited(with event: NSEvent) { hovered = false; needsDisplay = true }
  override func resetCursorRects() {
    super.resetCursorRects()
    if isEnabled { addCursorRect(bounds, cursor: .pointingHand) }
  }
  override func becomeFirstResponder() -> Bool {
    guard super.becomeFirstResponder() else { return false }
    hasKeyboardFocus = true
    needsDisplay = true
    return true
  }
  override func resignFirstResponder() -> Bool {
    guard super.resignFirstResponder() else { return false }
    hasKeyboardFocus = false
    needsDisplay = true
    return true
  }
  override func draw(_ dirtyRect: NSRect) {
    if state == .on && isEnabled {
      NSColor.white.withAlphaComponent(0.08).setFill()
      NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7).fill()
    }
    if showsHoverFill && isEnabled && (hovered || hasKeyboardFocus || isHighlighted) {
      NSColor.white.withAlphaComponent(isHighlighted ? 0.10 : 0.05).setFill()
      NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7).fill()
    }
    super.draw(dirtyRect)
  }
}

// Match WorkspaceBarControl in Flutter, including the pane model selector.
private func workspaceBarControlHeight(_ font: NSFont) -> CGFloat {
  max(28, ceil(font.pointSize * 1.2))
}

private func workspaceBarEmphasisFont(_ font: NSFont) -> NSFont {
  NSFontManager.shared.convert(font, toHaveTrait: .boldFontMask)
}

private func workspaceBarTextWidth(_ text: String, font: NSFont) -> CGFloat {
  max((text as NSString).size(withAttributes: [.font: font]).width,
    (text as NSString).size(withAttributes: [.font: workspaceBarEmphasisFont(font)]).width)
}

/// Terminal symbols with a shared text baseline and a visible hover/focus cue.
private final class SwarmStatusSymbolButton: SwarmIconButton {
  var foreground = NSColor(white: 0.85, alpha: 1) { didSet { needsDisplay = true } }

  override func draw(_ dirtyRect: NSRect) {
    let active = isEnabled && (hovered || hasKeyboardFocus || isHighlighted)
    let regularFont = font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    let line = NSAttributedString(string: title, attributes: [
      .font: active ? workspaceBarEmphasisFont(regularFont) : regularFont,
      .foregroundColor: foreground.withAlphaComponent(isEnabled ? 0.75 : 0.28),
    ])
    let size = line.size()
    line.draw(in: NSRect(x: (bounds.width - size.width) / 2,
      y: (bounds.height - size.height) / 2, width: size.width, height: size.height))
  }
}

private final class SwarmStripScrollView: NSScrollView {
  override func scrollWheel(with event: NSEvent) {
    let dx = event.scrollingDeltaX, dy = event.scrollingDeltaY
    guard abs(dy) > abs(dx), let document = documentView,
          document.frame.width > contentView.bounds.width + 0.5 else {
      super.scrollWheel(with: event)
      return
    }
    var origin = contentView.bounds.origin
    let step = event.hasPreciseScrollingDeltas ? dy : dy * 18
    origin.x = min(max(0, origin.x - step), document.frame.width - contentView.bounds.width)
    contentView.scroll(to: origin)
    reflectScrolledClipView(contentView)
  }
}

private func statusColor(_ value: Any?, fallback: NSColor) -> NSColor {
  guard let number = value as? NSNumber else { return fallback }
  let argb = number.uint32Value
  return NSColor(srgbRed: CGFloat((argb >> 16) & 255) / 255,
    green: CGFloat((argb >> 8) & 255) / 255, blue: CGFloat(argb & 255) / 255,
    alpha: CGFloat((argb >> 24) & 255) / 255)
}

private struct SwarmStatusSegment {
  let text: String
  let foreground: NSColor
  let background: NSColor?
  let branchSymbol: Bool
}

/// Same one-cell branch drawing as Flutter; no private-use font glyphs.
private func drawStatusBranch(in rect: NSRect, color: NSColor) {
  let left = rect.minX + rect.width * 0.25, right = rect.minX + rect.width * 0.8
  let top = rect.minY + rect.height * 0.85, bottom = rect.minY + rect.height * 0.15
  let radius = rect.width * 0.16
  let path = NSBezierPath()
  path.lineWidth = rect.width * 0.14
  path.lineCapStyle = .round
  path.move(to: NSPoint(x: left, y: top - radius))
  path.line(to: NSPoint(x: left, y: bottom + radius))
  path.move(to: NSPoint(x: right, y: top - radius))
  path.curve(to: NSPoint(x: left, y: bottom + radius),
    controlPoint1: NSPoint(x: right, y: rect.midY), controlPoint2: NSPoint(x: left, y: rect.midY))
  for center in [NSPoint(x: left, y: top), NSPoint(x: right, y: top), NSPoint(x: left, y: bottom)] {
    path.appendOval(in: NSRect(x: center.x - radius, y: center.y - radius,
      width: radius * 2, height: radius * 2))
  }
  color.setStroke()
  path.stroke()
}

/// Dart sends the same resolved segments that Flutter uses for its previews.
/// Shapes are drawn in cells; no Powerline/Nerd Font installation is needed.
private final class SwarmContextButton: SwarmIconButton {
  var onField: ((String, Int) -> Void)?
  fileprivate private(set) var fieldButtons: [SwarmContextButton] = []
  private var field: String?
  private var paneId: Int?

  var foreground = NSColor.white
  private var text = ""
  var textAlignment: NSTextAlignment = .right
  var contentPadding: CGFloat = 0
  private var detail: String?
  private var segments: [SwarmStatusSegment] = []
  private var segmented = false
  private var roundedSeparators = false
  private var roundedStart = false
  private var roundedEnd = false
  var nextBackground: NSColor? { didSet { needsDisplay = true; needsLayout = true } }
  var isSegmented: Bool { segmented && !segments.isEmpty }
  var firstBackground: NSColor? { segments.first?.background }
  var drawsSegments: Bool { isSegmented && bounds.width >= CGFloat(segments.count) * cellWidth * 4 }
  fileprivate var actionURL: String?
  private var textFont: NSFont { font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular) }
  private var cellWidth: CGFloat { ("m" as NSString).size(withAttributes: [.font: textFont]).width }
  private var naturalWidths: [CGFloat] {
    segments.map { workspaceBarTextWidth($0.text, font: textFont) + ($0.branchSymbol ? cellWidth * 2 : 0) }
  }
  var preferredWidth: CGFloat {
    if !fieldButtons.isEmpty { return fieldButtons.reduce(0) { $0 + $1.preferredWidth } }
    return ceil(naturalWidths.reduce(0, +) + contentPadding * 2 + (segmented ? CGFloat(segments.count) * cellWidth * 3 : 0))
  }

  func update(_ context: [String: Any]?, enabled: Bool) {
    text = context?["text"] as? String ?? ""
    segmented = context?["segmented"] as? Bool == true
    roundedSeparators = context?["roundedSeparators"] as? Bool == true
    roundedStart = context?["roundedStart"] as? Bool == true
    roundedEnd = context?["roundedEnd"] as? Bool == true
    segments = (context?["segments"] as? [[String: Any]] ?? []).compactMap { part in
      guard let text = part["text"] as? String else { return nil }
      return SwarmStatusSegment(text: text,
        foreground: statusColor(part["foreground"], fallback: foreground),
        background: part["background"] == nil ? nil : statusColor(part["background"], fallback: foreground),
        branchSymbol: part["branchSymbol"] as? Bool == true)
    }
    let fields = context?["fields"] as? [[String: Any]] ?? []
    while fieldButtons.count > fields.count { fieldButtons.removeLast().removeFromSuperview() }
    while fieldButtons.count < fields.count {
      let button = SwarmContextButton()
      button.isBordered = false
      button.target = self
      button.action = #selector(openField(_:))
      fieldButtons.append(button)
      addSubview(button)
    }
    for (button, values) in zip(fieldButtons, fields) {
      button.font = font
      button.textAlignment = .left
      button.foreground = foreground
      button.update(values, enabled: enabled)
      button.setAccessibilityLabel(values["detail"] as? String ?? values["text"] as? String)
    }
    setAccessibilityChildren(fields.isEmpty ? nil : fieldButtons.filter { $0.field != nil })
    field = context?["field"] as? String
    paneId = context?["paneId"] as? Int
    actionURL = context?["url"] as? String
    detail = context?["detail"] as? String
    updateTooltip()
    isEnabled = enabled && context?["interactive"] as? Bool == true
    setAccessibilityValue(text)
    setAccessibilityHelp(toolTip)
    needsDisplay = true
    needsLayout = true
  }

  private func updateTooltip() {
    guard fieldButtons.isEmpty else { toolTip = nil; return }
    let extra = detail?.trimmingCharacters(in: .whitespacesAndNewlines) ?? ""
    let hints = [
      preferredWidth > bounds.width && !text.isEmpty ? text : nil,
      !extra.isEmpty && extra != text ? extra : nil,
    ].compactMap { $0 }
    toolTip = hints.isEmpty ? nil : hints.joined(separator: "\n")
    setAccessibilityHelp(toolTip)
  }

  @objc private func openField(_ sender: SwarmContextButton) {
    guard fieldButtons.contains(where: { $0 === sender }), sender.isEnabled,
          let field = sender.field, let paneId = sender.paneId else { return }
    onField?(field, paneId)
  }

  override func layout() {
    super.layout()
    updateTooltip()
    guard !fieldButtons.isEmpty else { return }
    let natural = fieldButtons.map { $0.preferredWidth }
    var widths = natural
    if natural.reduce(0, +) > bounds.width {
      var low: CGFloat = 0, high = natural.max() ?? 0
      for _ in 0..<24 {
        let cap = (low + high) / 2
        if natural.reduce(0, { $0 + min($1, cap) }) > bounds.width { high = cap }
        else { low = cap }
      }
      widths = natural.map { min($0, low) }
    }
    var x: CGFloat = 0
    for (index, button) in fieldButtons.enumerated() {
      button.frame = NSRect(x: x, y: 0, width: widths[index], height: bounds.height)
      let next = index + 1 < fieldButtons.count ? fieldButtons[index + 1] : nil
      button.nextBackground = next?.firstBackground ?? (index == fieldButtons.count - 1 ? nextBackground : nil)
      x += widths[index]
    }
  }

  override var mouseDownCanMoveWindow: Bool { false }
  private func attributed(_ value: String, _ color: NSColor, alignment: NSTextAlignment = .left) -> NSAttributedString {
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    paragraph.alignment = alignment
    return NSAttributedString(string: value, attributes: [
      .font: isEnabled && (hovered || hasKeyboardFocus || isHighlighted)
        ? workspaceBarEmphasisFont(textFont) : textFont,
      .foregroundColor: color, .paragraphStyle: paragraph,
    ])
  }
  private func branchAttachment(_ color: NSColor) -> NSAttributedString {
    let width = cellWidth, height = textFont.pointSize * 0.84
    let image = NSImage(size: NSSize(width: width * 2, height: height), flipped: false) { _ in
      drawStatusBranch(in: NSRect(x: 0, y: 0, width: width, height: height), color: color)
      return true
    }
    let attachment = NSTextAttachment()
    attachment.image = image
    attachment.bounds = NSRect(x: 0, y: -1, width: width * 2, height: height)
    return NSAttributedString(attachment: attachment)
  }
  override func draw(_ dirtyRect: NSRect) {
    guard fieldButtons.isEmpty, bounds.width > 0, !segments.isEmpty else { return }
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    bounds.clip()
    if !drawsSegments {
      let line = NSMutableAttributedString(string: "")
      if segmented {
        line.append(attributed(text, foreground, alignment: textAlignment))
      } else {
        for segment in segments {
          if segment.branchSymbol { line.append(branchAttachment(segment.foreground)) }
          line.append(attributed(segment.text, segment.foreground, alignment: textAlignment))
        }
      }
      let inset = min(contentPadding, bounds.width / 2)
      line.draw(in: NSRect(x: inset, y: (bounds.height - line.size().height) / 2,
        width: max(0, bounds.width - inset * 2), height: line.size().height))
      return
    }
    let natural = naturalWidths
    let available = max(0, bounds.width - CGFloat(segments.count) * cellWidth * 3)
    var widths = natural
    if natural.reduce(0, +) > available {
      var low: CGFloat = 0, high = natural.max() ?? 0
      for _ in 0..<24 {
        let cap = (low + high) / 2
        if natural.reduce(0, { $0 + min($1, cap) }) > available { high = cap }
        else { low = cap }
      }
      widths = natural.map { min($0, low) }
    }
    let height = ceil(textFont.pointSize * 1.2)
    let bottom = (bounds.height - height) / 2
    var x = max(0, bounds.width - widths.reduce(0, +) - CGFloat(segments.count) * cellWidth * 3)
    // Separate click targets still form one painted ribbon. Cover fractional
    // leading/trailing slack too, so cell rounding cannot reveal a dark seam.
    if !roundedStart {
      (segments[0].background ?? foreground).setFill()
      NSRect(x: 0, y: bottom, width: x + cellWidth, height: height).fill()
    }
    if let nextBackground {
      nextBackground.setFill()
      NSRect(x: bounds.width - cellWidth, y: bottom, width: cellWidth, height: height).fill()
    }
    for (index, segment) in segments.enumerated() {
      let inset = cellWidth * (index == 0 ? 1 : 2)
      let width = widths[index] + inset + cellWidth
      if index == segments.count - 1, let nextBackground {
        nextBackground.setFill()
        NSRect(x: x + width, y: bottom, width: cellWidth, height: height).fill()
      }
      let shape = NSBezierPath()
      let roundStart = roundedStart && index == 0
      let roundRight = roundedSeparators || (roundedEnd && index == segments.count - 1 && nextBackground == nil)
      let end = x + width, top = bottom + height, middle = bottom + height / 2
      shape.move(to: NSPoint(x: x + (roundStart ? cellWidth : 0), y: bottom))
      shape.line(to: NSPoint(x: x + width, y: bottom))
      if roundRight {
        shape.curve(to: NSPoint(x: end + cellWidth, y: middle),
          controlPoint1: NSPoint(x: end + cellWidth * 0.55, y: bottom),
          controlPoint2: NSPoint(x: end + cellWidth, y: bottom + height * 0.225))
        shape.curve(to: NSPoint(x: end, y: top),
          controlPoint1: NSPoint(x: end + cellWidth, y: bottom + height * 0.775),
          controlPoint2: NSPoint(x: end + cellWidth * 0.55, y: top))
      } else {
        shape.line(to: NSPoint(x: end + cellWidth, y: middle))
        shape.line(to: NSPoint(x: end, y: top))
      }
      shape.line(to: NSPoint(x: x + (roundStart ? cellWidth : 0), y: top))
      if roundStart {
        shape.curve(to: NSPoint(x: x, y: middle),
          controlPoint1: NSPoint(x: x + cellWidth * 0.45, y: top),
          controlPoint2: NSPoint(x: x, y: bottom + height * 0.775))
        shape.curve(to: NSPoint(x: x + cellWidth, y: bottom),
          controlPoint1: NSPoint(x: x, y: bottom + height * 0.225),
          controlPoint2: NSPoint(x: x + cellWidth * 0.45, y: bottom))
      } else if index > 0 && roundedSeparators {
        shape.curve(to: NSPoint(x: x + cellWidth, y: middle),
          controlPoint1: NSPoint(x: x + cellWidth * 0.55, y: top),
          controlPoint2: NSPoint(x: x + cellWidth, y: bottom + height * 0.775))
        shape.curve(to: NSPoint(x: x, y: bottom),
          controlPoint1: NSPoint(x: x + cellWidth, y: bottom + height * 0.225),
          controlPoint2: NSPoint(x: x + cellWidth * 0.55, y: bottom))
      } else {
        shape.line(to: NSPoint(x: x + (index == 0 ? 0 : cellWidth), y: middle))
      }
      shape.close()
      (segment.background ?? foreground).setFill()
      shape.fill()
      let symbolWidth = segment.branchSymbol && widths[index] >= cellWidth * 3 ? cellWidth * 2 : 0
      if symbolWidth > 0 {
        drawStatusBranch(in: NSRect(x: x + inset, y: bottom + height * 0.15,
          width: cellWidth, height: height * 0.7), color: segment.foreground)
      }
      let line = attributed(segment.text, segment.foreground)
      line.draw(in: NSRect(x: x + inset + symbolWidth, y: (bounds.height - line.size().height) / 2,
        width: max(0, widths[index] - symbolWidth), height: line.size().height))
      x += width
    }
  }
}

private final class SwarmTabStrip: NSView {
  private(set) var palette = SwarmNativePalette()
  var emit: ((String, Any?) -> Void)?
  private let scroll = SwarmStripScrollView()
  private let document = NSView()
  fileprivate let newButton = SwarmStatusSymbolButton()
  fileprivate let contextButton = SwarmContextButton()
  fileprivate let focusedModelButton = SwarmContextButton()
  private var focusedModelTarget: [String: Any]?
  fileprivate let pullRequestButton = SwarmContextButton()
  private var barFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
  private var terminalForeground = NSColor(white: 0.85, alpha: 1)
  private var tabs: [SwarmTabButton] = []
  private var activeId = ""
  private var revealActiveAfterLayout = false
  private var tabOrderChanged = false
  private var actionsEnabled = false
  private var lastBackgroundClick: (time: TimeInterval, point: NSPoint)?
  // Dragging is explicit below. AppKit must not also start a titlebar gesture.
  override var mouseDownCanMoveWindow: Bool { false }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    scroll.drawsBackground = false
    scroll.hasHorizontalScroller = false
    scroll.hasVerticalScroller = false
    scroll.documentView = document
    addSubview(scroll)
    newButton.isBordered = false
    newButton.target = self
    newButton.action = #selector(newSwarm)
    addSubview(newButton)
    newButton.setAccessibilityLabel("New Tab")
    newButton.isEnabled = false
    newButton.toolTip = "New Tab ⌘T"
    newButton.image = nil
    newButton.title = "+"
    newButton.imagePosition = .noImage
    contextButton.isBordered = false
    contextButton.alignment = .right
    contextButton.target = self
    contextButton.setAccessibilityLabel("Focused pane")
    contextButton.onField = { [weak self] field, paneId in
      guard let self, self.actionsEnabled else { return }
      self.emit?("focusedContext", ["field": field, "paneId": paneId])
    }
    addSubview(contextButton)
    focusedModelButton.isBordered = false
    focusedModelButton.textAlignment = .center
    focusedModelButton.target = self
    focusedModelButton.action = #selector(openFocusedModel)
    focusedModelButton.setAccessibilityLabel("Switch focused pane model")
    focusedModelButton.isHidden = true
    addSubview(focusedModelButton)
    pullRequestButton.isBordered = false
    pullRequestButton.target = self
    pullRequestButton.action = #selector(openFocusedPullRequest)
    pullRequestButton.setAccessibilityLabel("Open pull request on GitHub")
    pullRequestButton.isHidden = true
    addSubview(pullRequestButton)
    setAccessibilityChildren([scroll, newButton, focusedModelButton, contextButton, pullRequestButton])
    registerForDraggedTypes([swarmPasteboardType])
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func updatePalette(_ values: [String: Any]) {
    let nextPalette = SwarmNativePalette(values)
    guard nextPalette != palette else { return }
    palette = nextPalette
    newButton.contentTintColor = palette.accent
    for tab in tabs { tab.palette = palette }
    needsDisplay = true
  }


  func update(_ state: [String: Any]) {
    // Workspace teardown clears its controls without changing appearance.
    if let palette = state["palette"] as? [String: Any] { updatePalette(palette) }
    actionsEnabled = state["enabled"] as? Bool == true
    if let style = state["barStyle"] as? [String: Any] {
      let size = CGFloat(min(36, max(8, (style["size"] as? NSNumber)?.doubleValue ?? 13)))
      let families = [style["family"] as? String].compactMap { $0 } + (style["fallback"] as? [String] ?? [])
      barFont = families.lazy.compactMap { NSFont(name: $0, size: size) }.first
        ?? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
      terminalForeground = statusColor(style["foreground"], fallback: terminalForeground)
    }
    for control in [newButton] {
      control.font = barFont
      control.foreground = terminalForeground
      control.isEnabled = actionsEnabled
    }
    focusedModelButton.font = barFont
    focusedModelButton.foreground = terminalForeground
    focusedModelButton.contentPadding = ("m" as NSString).size(withAttributes: [.font: barFont]).width
    focusedModelTarget = state["focusedModel"] as? [String: Any]
    focusedModelButton.update(focusedModelTarget, enabled: actionsEnabled)
    focusedModelButton.isHidden = focusedModelTarget == nil
    contextButton.font = barFont
    contextButton.foreground = terminalForeground
    contextButton.update(state["focusedContext"] as? [String: Any], enabled: actionsEnabled)
    pullRequestButton.font = barFont
    pullRequestButton.foreground = terminalForeground
    pullRequestButton.update(state["pullRequest"] as? [String: Any], enabled: actionsEnabled)
    pullRequestButton.isHidden = state["pullRequest"] == nil
    let rows = state["tabs"] as? [[String: Any]] ?? []
    let nextActiveId = state["activeId"] as? String ?? ""
    revealActiveAfterLayout = revealActiveAfterLayout || nextActiveId != activeId
    activeId = nextActiveId
    let ids = rows.compactMap { $0["id"] as? String }
    let previousOrder = tabs.map(\.swarmId)
    tabOrderChanged = tabOrderChanged || ids != previousOrder
    for tab in tabs where !ids.contains(tab.swarmId) { tab.removeFromSuperview() }
    let previous = Dictionary(uniqueKeysWithValues: tabs.map { ($0.swarmId, $0) })
    tabs = rows.compactMap { row in
      guard let id = row["id"] as? String else { return nil }
      let tab = previous[id] ?? SwarmTabButton(id: id)
      tab.palette = palette
      tab.name = row["name"] as? String ?? "New Tab"
      tab.displayLabel = row["label"] as? String ?? tab.name
      tab.labelFont = barFont
      tab.foreground = terminalForeground
      tab.selected = id == activeId
      tab.actionsEnabled = actionsEnabled
      tab.attention = (row["attention"] as? Int ?? 0) > 0
      tab.emit = { [weak self, weak tab] method, args in
        guard let self, let tab, self.actionsEnabled,
              self.tabs.contains(where: { $0 === tab }) else { return }
        self.emit?(method, args)
      }
      tab.hoverChanged = { [weak self] in self?.updateDividers() }
      if tab.superview == nil { document.addSubview(tab) }
      tab.needsDisplay = true
      return tab
    }
    updateDividers()
    // Moving frames alone leaves AppKit's child traversal in insertion order.
    document.setAccessibilityChildren(tabs)
    newButton.isEnabled = actionsEnabled
    needsLayout = true
    layoutSubtreeIfNeeded()
    if ids != previousOrder {
      NSAccessibility.post(element: document, notification: .layoutChanged)
    }
  }

  private func updateDividers() {
    for (index, tab) in tabs.enumerated() {
      let next = index + 1 < tabs.count ? tabs[index + 1] : nil
      tab.showsDivider = !tab.selected && !tab.isHovered && next != nil &&
        next?.selected == false && next?.isHovered == false
    }
  }

  override func layout() {
    super.layout()
    let active = tabs.first(where: { $0.swarmId == activeId })
    let activeWasVisible = active.map { scroll.documentVisibleRect.intersects($0.frame) } ?? false
    let previousScrollSize = scroll.frame.size
    let previousDocumentSize = document.frame.size
    let cell = ceil(("m" as NSString).size(withAttributes: [.font: barFont]).width)
    let trailing = cell
    let toolHeight = workspaceBarControlHeight(barFont)
    let statusRight = bounds.width - trailing
    // Compact windows keep a scrolling tab list; context never overlaps it.
    let available = max(0, bounds.width - cell * 7)
    let widths = tabs.map { min($0.preferredWidth, available * 0.45) }
    let total = widths.reduce(0, +)
    let occupied = min(total, available * 0.45)
    let scrollX = cell
    scroll.frame = NSRect(x: scrollX, y: 0, width: occupied, height: bounds.height)
    document.frame = NSRect(x: 0, y: 0, width: max(occupied, total), height: bounds.height)
    var x: CGFloat = 0
    for (tab, width) in zip(tabs, widths) {
      tab.frame = NSRect(x: x, y: 0, width: width, height: bounds.height)
      tab.contentCenterY = bounds.midY
      x += width
    }
    newButton.frame = NSRect(x: scroll.frame.maxX, y: (bounds.height - toolHeight) / 2,
      width: cell * 3, height: toolHeight)
    let statusWidth = max(0, statusRight - newButton.frame.maxX - cell * 2)
    let prWidth = pullRequestButton.isHidden ? 0 : min(pullRequestButton.preferredWidth, statusWidth * 0.45)
    let joined = contextButton.isSegmented && pullRequestButton.isSegmented && prWidth > 0
    let prGap = prWidth > 0 && !joined ? cell : 0
    pullRequestButton.frame = NSRect(x: statusRight - prWidth, y: (bounds.height - toolHeight) / 2,
      width: prWidth, height: toolHeight)
    let remaining = max(0, statusWidth - prWidth - prGap)
    let modelWidth = focusedModelButton.isHidden ? 0 : min(focusedModelButton.preferredWidth, remaining * 0.35)
    let modelGap = modelWidth > 0 ? min(cell, remaining - modelWidth) : 0
    let contextWidth = min(contextButton.preferredWidth, max(0, remaining - modelWidth - modelGap))
    contextButton.frame = NSRect(x: statusRight - prWidth - prGap - contextWidth, y: (bounds.height - toolHeight) / 2,
      width: contextWidth, height: toolHeight)
    focusedModelButton.frame = NSRect(x: contextButton.frame.minX - modelGap - modelWidth,
      y: (bounds.height - toolHeight) / 2, width: modelWidth, height: toolHeight)
    contextButton.nextBackground = joined && pullRequestButton.drawsSegments
      ? pullRequestButton.firstBackground : nil
    let geometryChanged = scroll.frame.size != previousScrollSize || document.frame.size != previousDocumentSize
    if let active, revealActiveAfterLayout || (activeWasVisible && (geometryChanged || tabOrderChanged)) {
      document.scrollToVisible(active.frame)
    }
    revealActiveAfterLayout = false
    tabOrderChanged = false
  }
  override func draw(_ dirtyRect: NSRect) {
    // A fine rule joins the flat tabs to the workspace.
    palette.workspace.setFill()
    NSRect(x: 0, y: 0, width: bounds.width, height: 1).fill()

  }
  override func mouseDown(with event: NSEvent) {
    if ownsBackgroundDoubleClick(event) { window?.performZoom(nil) }
    else if event.clickCount == 1 { window?.performDrag(with: event) }
  }
  // Own the release as well as the press. Forwarding it lets AppKit zoom a
  // second time on mouse-up, immediately restoring the previous window size.
  override func mouseUp(with event: NSEvent) {}
  fileprivate func ownsBackgroundDoubleClick(_ event: NSEvent) -> Bool {
    if event.clickCount == 1 {
      lastBackgroundClick = (event.timestamp, event.locationInWindow)
      return false
    }
    guard event.clickCount == 2, let first = lastBackgroundClick else {
      lastBackgroundClick = nil
      return false
    }
    lastBackgroundClick = nil
    return event.timestamp - first.time <= NSEvent.doubleClickInterval &&
      hypot(event.locationInWindow.x - first.point.x,
            event.locationInWindow.y - first.point.y) <= 4
  }
  @objc private func openFocusedModel() {
    guard actionsEnabled, focusedModelButton.isEnabled,
          let paneId = focusedModelTarget?["paneId"] as? Int,
          let agentId = focusedModelTarget?["agentId"] as? String else { return }
    emit?("focusedModel", ["paneId": paneId, "agentId": agentId])
  }
  @objc private func openFocusedPullRequest() {
    if actionsEnabled && pullRequestButton.isEnabled, let url = pullRequestButton.actionURL {
      emit?("focusedPullRequest", ["url": url])
    }
  }
  @objc private func newSwarm() {
    if actionsEnabled && newButton.isEnabled { emit?("new", nil) }
  }
  private func draggedTab(_ sender: NSDraggingInfo) -> SwarmTabButton? {
    guard actionsEnabled, sender.draggingSourceOperationMask.contains(.move),
          let source = sender.draggingSource as? SwarmTabButton,
          tabs.contains(where: { $0 === source }),
          sender.draggingPasteboard.string(forType: swarmPasteboardType) == source.swarmId,
          scroll.frame.contains(convert(sender.draggingLocation, from: nil)) else { return nil }
    return source
  }
  override func draggingEntered(_ sender: NSDraggingInfo) -> NSDragOperation { draggedTab(sender) == nil ? [] : .move }
  override func draggingUpdated(_ sender: NSDraggingInfo) -> NSDragOperation { draggedTab(sender) == nil ? [] : .move }
  override func performDragOperation(_ sender: NSDraggingInfo) -> Bool {
    guard let source = draggedTab(sender), let old = tabs.firstIndex(where: { $0 === source }) else { return false }
    let point = document.convert(sender.draggingLocation, from: nil)
    let index = tabs.firstIndex(where: { point.x < $0.frame.midX }) ?? tabs.count
    let destination = max(0, index > old ? index - 1 : index)
    if destination != old { emit?("reorder", ["id": source.swarmId, "index": destination]) }
    return true
  }
}

private final class SwarmTabButton: NSView, NSDraggingSource, NSMenuItemValidation {
  var palette = SwarmNativePalette() {
    didSet { if palette != oldValue { needsDisplay = true } }
  }
  let swarmId: String
  var name = "New Tab" { didSet { if name != oldValue { invalidateLabel(); updateAccessibility() } } }
  var displayLabel = "New Tab" { didSet { if displayLabel != oldValue { invalidateLabel() } } }
  var foreground = NSColor(white: 0.85, alpha: 1) { didSet { if foreground != oldValue { invalidateLabel() } } }
  private var cellWidth: CGFloat { ceil(("m" as NSString).size(withAttributes: [.font: labelFont]).width) }
  var preferredWidth: CGFloat { min(cellWidth * 24, ceil(max(label.size().width, emphasizedLabel.size().width) / cellWidth) * cellWidth + cellWidth * 2) }
  var selected = false { didSet { if selected != oldValue { invalidateLabel(); updateAccessibility() } } }
  var attention = false { didSet { if attention != oldValue { needsDisplay = true; updateAccessibility() } } }
  var showsDivider = false { didSet { if showsDivider != oldValue { needsDisplay = true } } }
  var contentCenterY: CGFloat = 20
  var emit: ((String, Any?) -> Void)?
  var hoverChanged: (() -> Void)?
  var isHovered: Bool { hovered && actionsEnabled }
  private let selectButton = SwarmSelectButton()
  /// Whether the middle button went down on THIS tab — see otherMouseUp.
  private var middleDown = false
  /// Status text and numbered tabs share the compact workspace face.
  var labelFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular) {
    didSet { if oldValue != labelFont { invalidateLabel() } }
  }
  private var cachedLabel: NSAttributedString?
  private var cachedEmphasizedLabel: NSAttributedString?
  var actionsEnabled = true {
    didSet {
      selectButton.isEnabled = actionsEnabled
      needsDisplay = true
    }
  }
  private var downPoint = NSPoint.zero
  private var hovered = false
  private var hoverTracking: NSTrackingArea?
  override var acceptsFirstResponder: Bool { false }
  override var mouseDownCanMoveWindow: Bool { false }

  init(id: String) {
    swarmId = id
    super.init(frame: .zero)
    setAccessibilityElement(true)
    setAccessibilityRole(.group)
    selectButton.owner = self
    selectButton.title = ""
    selectButton.isBordered = false
    selectButton.target = self
    selectButton.action = #selector(selectSwarm)
    addSubview(selectButton)
    let menu = NSMenu()
    for (title, action) in [("Rename Tab…", #selector(renameSwarm)), ("Close Tab", #selector(closeSwarm))] {
      let item = NSMenuItem(title: title, action: action, keyEquivalent: "")
      item.target = self
      menu.addItem(item)
    }
    self.menu = menu
    updateAccessibility()
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override func layout() {
    super.layout()
    selectButton.frame = bounds
    let visibleName = displayLabel.replacingOccurrences(of: #"^\d+:"#, with: "", options: .regularExpression)
      .trimmingCharacters(in: .whitespacesAndNewlines)
    let fullName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    var hints: [String] = []
    if max(label.size().width, emphasizedLabel.size().width) > max(0, bounds.width - cellWidth * 2) { hints.append(displayLabel) }
    if !fullName.isEmpty && fullName != visibleName && fullName != displayLabel { hints.append(name) }
    toolTip = hints.isEmpty ? nil : hints.joined(separator: "\n")
  }
  override func updateTrackingAreas() {
    super.updateTrackingAreas()
    if let hoverTracking { removeTrackingArea(hoverTracking) }
    let area = NSTrackingArea(rect: .zero, options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect],
      owner: self, userInfo: nil)
    addTrackingArea(area)
    hoverTracking = area
  }
  override func mouseEntered(with event: NSEvent) { setHovered(true) }
  override func mouseExited(with event: NSEvent) { setHovered(false) }
  private func setHovered(_ value: Bool) {
    guard hovered != value else { return }
    hovered = value
    needsDisplay = true
    hoverChanged?()
  }
  private func invalidateLabel() {
    cachedLabel = nil
    cachedEmphasizedLabel = nil
    needsDisplay = true
    needsLayout = true
  }
  private var label: NSAttributedString {
    if let cachedLabel { return cachedLabel }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    paragraph.alignment = .center
    let label = NSAttributedString(string: displayLabel,
      attributes: [.font: labelFont,
        .foregroundColor: foreground, .paragraphStyle: paragraph])
    cachedLabel = label
    return label
  }
  private var emphasizedLabel: NSAttributedString {
    if let cachedEmphasizedLabel { return cachedEmphasizedLabel }
    let emphasized = NSMutableAttributedString(attributedString: label)
    emphasized.addAttribute(.font, value: workspaceBarEmphasisFont(labelFont),
      range: NSRange(location: 0, length: emphasized.length))
    cachedEmphasizedLabel = emphasized
    return emphasized
  }
  override func draw(_ dirtyRect: NSRect) {
    let active = actionsEnabled && (hovered || selectButton.hasKeyboardFocus || selectButton.isHighlighted)
    let text = active ? emphasizedLabel : label
    if selected {
      palette.workspace.setFill()
      bounds.fill()
    }
    text.draw(in: NSRect(x: cellWidth, y: contentCenterY - text.size().height / 2,
      width: max(0, bounds.width - cellWidth * 2), height: text.size().height))
    if attention {
      let marker = NSAttributedString(string: "!", attributes: [.font: labelFont, .foregroundColor: NSColor.systemOrange])
      marker.draw(at: NSPoint(x: 0, y: contentCenterY - marker.size().height / 2))
    }
  }
  // Overflowed tabs might not be drawn. Their names and selection still need
  // to be available to VoiceOver and automation before they scroll into view.
  private func updateAccessibility() {
    setAccessibilityLabel(name)
    selectButton.setAccessibilityLabel("Select \(name)")
    selectButton.setAccessibilityValue(selected ? "Selected" : "")
    selectButton.setAccessibilityHelp(attention ? "Contains agents needing input" : nil)
  }
  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { actionsEnabled }
  override func mouseDown(with event: NSEvent) {
    guard actionsEnabled else { return }
    downPoint = event.locationInWindow
    if event.clickCount == 2 { renameSwarm() }
    else { emit?("select", ["id": swarmId]) }
  }
  // The tab owns the full click sequence, including clicks on its padding.
  // Forwarding mouseUp lets AppKit also treat a rename as a titlebar zoom.
  override func mouseUp(with event: NSEvent) {}
  // Middle-click closes the tab, as it does in every browser and in Ghostty —
  // the one gesture people arrive with and find missing here. On the UP, and
  // only when it went down on this same tab: a press that slid off is a press
  // that changed its mind, and a tab that vanished under the button would be a
  // click nobody could take back.
  override func otherMouseDown(with event: NSEvent) {
    middleDown = actionsEnabled && event.buttonNumber == 2
  }
  override func otherMouseUp(with event: NSEvent) {
    defer { middleDown = false }
    guard middleDown, event.buttonNumber == 2, actionsEnabled else { return }
    guard bounds.contains(convert(event.locationInWindow, from: nil)) else { return }
    emit?("close", ["id": swarmId])
  }
  override func mouseDragged(with event: NSEvent) {
    guard actionsEnabled else { return }
    if hypot(event.locationInWindow.x - downPoint.x, event.locationInWindow.y - downPoint.y) < 5 { return }
    let item = NSPasteboardItem()
    item.setString(swarmId, forType: swarmPasteboardType)
    let dragging = NSDraggingItem(pasteboardWriter: item)
    let snapshot = NSImage(size: bounds.size)
    snapshot.lockFocus()
    draw(bounds)
    snapshot.unlockFocus()
    dragging.setDraggingFrame(bounds, contents: snapshot)
    beginDraggingSession(with: [dragging], event: event, source: self)
  }
  func draggingSession(_ session: NSDraggingSession, sourceOperationMaskFor context: NSDraggingContext) -> NSDragOperation { .move }
  override func accessibilityChildren() -> [Any]? { [selectButton] }
  @objc private func selectSwarm() { if actionsEnabled { emit?("select", ["id": swarmId]) } }
  @objc private func closeSwarm() { if actionsEnabled { emit?("close", ["id": swarmId]) } }
  @objc private func renameSwarm() { if actionsEnabled { emit?("rename", ["id": swarmId]) } }
}

/// One keyboard-accessible selection target. Closing stays in the native menu
/// and Command-W, leaving the label centered across the whole tab.
private class SwarmTabActionButton: SwarmIconButton {
  weak var owner: SwarmTabButton?
  override var showsHoverFill: Bool { false }
  override func highlight(_ flag: Bool) {
    super.highlight(flag)
    owner?.needsDisplay = true
  }
  override func becomeFirstResponder() -> Bool {
    guard super.becomeFirstResponder() else { return false }
    owner?.needsDisplay = true
    if let owner { owner.scrollToVisible(owner.bounds) }
    return true
  }
  override func resignFirstResponder() -> Bool {
    guard super.resignFirstResponder() else { return false }
    owner?.needsDisplay = true
    return true
  }
}

private final class SwarmSelectButton: SwarmTabActionButton {
  override func mouseDown(with event: NSEvent) {
    guard isEnabled else { return }
    highlight(true)
    owner?.mouseDown(with: event)
  }
  override func mouseUp(with event: NSEvent) { highlight(false) }
  override func mouseDragged(with event: NSEvent) {
    guard isEnabled else { return }
    highlight(false)
    owner?.mouseDragged(with: event)
  }
}
