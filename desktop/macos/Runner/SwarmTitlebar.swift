import Cocoa
import FlutterMacOS
import ImageIO

/// The native counterpart of AppIcons: regular monochrome system outlines.
/// Controls share one optical size; hover changes ink, never the silhouette.
enum HarnessControlSymbols {
  static let size: CGFloat = 16
  static let configuration = NSImage.SymbolConfiguration(pointSize: size, weight: .regular)
  static func image(_ name: String, description: String? = nil) -> NSImage? {
    NSImage(systemSymbolName: name, accessibilityDescription: description)?
      .withSymbolConfiguration(configuration)
  }
}

/// Real AppKit controls in the title bar, beside the system traffic lights.
/// https://developer.apple.com/documentation/appkit/nstitlebaraccessoryviewcontroller/layoutattribute
final class SwarmTitlebar: NSObject, NSMenuItemValidation, NSMenuDelegate {
  private weak var window: NSWindow?
  private let channel: FlutterMethodChannel
  private let accessory = NSTitlebarAccessoryViewController()
  private let strip = SwarmTabStrip(frame: NSRect(x: 0, y: 0, width: 900, height: 40))
  private var statusMenu: HarnessStatusMenu?
  private var statusBarHeight: NSLayoutConstraint?
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

  init(window: NSWindow, messenger: FlutterBinaryMessenger, installStatusItem: Bool = true) {
    self.window = window
    channel = FlutterMethodChannel(name: "harness/swarm_tabs", binaryMessenger: messenger)
    super.init()
    statusMenu = HarnessStatusMenu(installStatusItem: installStatusItem, showWindow: { [weak window] in
      NSApp.activate(ignoringOtherApps: true)
      if window?.isMiniaturized == true { window?.deminiaturize(nil) }
      window?.makeKeyAndOrderFront(nil)
    }, emit: { [weak self] method, args in
      self?.sendTabAction(method, arguments: args)
    })
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
        self.statusMenu?.update(state)
        self.statusBarHeight?.constant = self.strip.preferredStatusBarHeight
        self.window?.backgroundColor = self.strip.palette.tabBar
        result(nil)
      case "machinesState":
        let state = call.arguments as? [String: Any] ?? [:]
        self.updateMachines(state["machines"] as? [[String: Any]] ?? [])
        result(nil)
      case "daemonState":
        // The paired daemon's face and voice. Repaints the slot (and the voice line) only.
        self.strip.updateDaemon(call.arguments as? [String: Any] ?? [:])
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
    guard ["daemon", "subscriptions", "focusedContext", "harnessControls", "resourceMonitor", "machineControls", "modelControls", "select", "close", "new", "rename", "commands", "notifications", "notificationInbox", "openStatusHarness", "store", "devices", "sessions", "models", "addAgent", "newAgent", "newTerminal", "cloneAgent", "restartAgent", "shareAgent", "toggleViewer", "toggleComposer", "movePaneToTab", "runLocalModel", "splitRight", "splitDown", "zoomPane", "pinPane", "machineDestination", "machineAgent", "manageMachines", "machineList"].contains(method) else {
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
       current.isDescendant(of: content),
       !current.isDescendant(of: strip.statusBar) { return }
    func input(in view: NSView) -> NSView? {
      guard !view.isHidden, view !== strip.statusBar else { return nil }
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
    strip.newButton.toolTip = ["New Tab", map.hint(for: "swarm.new", context: "workspace")]
      .compactMap { $0 }.joined(separator: " · ")
    strip.newButton.setAccessibilityHelp(strip.newButton.toolTip)
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
    statusMenu?.updateKeymap(keymap, context: flutterKeyContext)
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
    if let content = window.contentView {
      let footer = strip.statusBar
      footer.translatesAutoresizingMaskIntoConstraints = false
      content.addSubview(footer)
      let height = footer.heightAnchor.constraint(equalToConstant: strip.preferredStatusBarHeight)
      statusBarHeight = height
      NSLayoutConstraint.activate([
        footer.leadingAnchor.constraint(equalTo: content.leadingAnchor),
        footer.trailingAnchor.constraint(equalTo: content.trailingAnchor),
        footer.bottomAnchor.constraint(equalTo: content.bottomAnchor),
        height,
      ])
    }
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
      // In Settings…'s group, at the top of the menu (HarnessAppMenu.arrange
      // sets the order): pairing a phone is a setting of this computer, not a
      // workspace action. Same channel and same keymap hook
      // as Settings (`app.add_phone` in keymap_commands.dart), so a binding a
      // person gives it shows here. Dart owns the dialog (add_phone_dialog.dart).
      let addPhone = NSMenuItem(title: "Add Phone…", action: #selector(menuAction(_:)), keyEquivalent: "")
      addPhone.target = self
      addPhone.representedObject = "addPhone"
      addPhone.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + "addPhone")
      addPhone.image = HarnessControlSymbols.image("iphone")
      appMenu.insertItem(addPhone, at: appMenu.index(of: settings) + 1)
      let customize = NSMenuItem(title: "Customize Harness", action: #selector(menuAction(_:)), keyEquivalent: "")
      customize.target = self
      customize.representedObject = "customize"
      customize.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + "customize")
      customize.image = HarnessControlSymbols.image("paintpalette")
      appMenu.insertItem(customize, at: appMenu.index(of: settings))
      HarnessAppMenu.arrange()
    }
    func add(_ menu: NSMenu, _ title: String, _ key: String, _ action: String, _ modifiers: NSEvent.ModifierFlags = [.command]) {
      let item = NSMenuItem(title: title, action: #selector(menuAction(_:)), keyEquivalent: key)
      item.keyEquivalentModifierMask = modifiers
      item.target = self
      item.representedObject = action
      item.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + action)
      let symbols = [
        "new": "plus.square", "newAgent": "plus", "sessions": "arrow.up.right.square", "addAgent": "folder", "newTerminal": "terminal",
        "cloneAgent": "plus.square.on.square", "restartAgent": "arrow.clockwise",
        "shareAgent": "square.and.arrow.up",
        "renameActive": "pencil", "closeActive": "xmark",
        "splitRight": "rectangle.split.2x1", "splitDown": "rectangle.split.1x2",
        "zoomPane": "viewfinder", "movePaneToTab": "arrow.right.square", "closePane": "xmark",
        "commands": "command", "notifications": "bell",
      ]
      if let symbol = symbols[action] {
        item.image = HarnessControlSymbols.image(symbol, description: title)
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
    add(file, "Open Harness", "p", "sessions")
    add(file, "Open Project", "o", "addAgent")
    // ⌘⇧N: another agent like the focused pane's, fresh conversation (Dart: `agent.clone`).
    add(file, "Clone Harness", "n", "cloneAgent", [.command, .shift])
    // ⌘⇧E: the pane's harness starts again where it is (Dart: `agent.restart`).
    add(file, "Restart Harness", "e", "restartAgent", [.command, .shift])
    add(file, "Share Harness", "s", "shareAgent", [.command, .shift])
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
    command("Show Full History", "", "showHistory")
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
  static let menuIcon = HarnessControlSymbols.image("square.grid.2x2")
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
      let mark = HarnessControlSymbols.image("checkmark")!
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
      || asset == "assets/devices/harness-mark.png"
      || asset.hasPrefix("assets/engine-icons/") && asset.hasSuffix(".png")
      || pullRequestAssets.contains(asset))
  }

  static let pullRequestAssets: Set<String> = ["git-merge", "git-pull-request",
    "git-pull-request-closed", "git-pull-request-draft"].reduce(into: []) {
      $0.insert("assets/octicons/\($1).svg")
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
  let foreground: NSColor
  /// A dark palette. AppKit's own surfaces follow `NSApp.appearance`, which
  /// [SwarmTitlebarStrip.updatePalette] sets from this.
  let dark: Bool

  // Mirrors AppPalette.textPrimary; navigation follows its surface, while the
  // footer continues to honor the selected terminal/status foreground.
  var navigationForeground: NSColor {
    let color = tabBar.usingColorSpace(.sRGB) ?? tabBar
    let light = color.redComponent * 0.2126 + color.greenComponent * 0.7152 + color.blueComponent * 0.0722 > 0.5
    return light ? NSColor(srgbRed: 26 / 255, green: 26 / 255, blue: 24 / 255, alpha: 1)
      : NSColor(white: 245 / 255, alpha: 1)
  }

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
    foreground = color("foreground", 0xfff5f5f5)
    dark = (values["dark"] as? Int64).map { $0 != 0 } ?? true
  }
}

/// Generic native icon controls retain their rounded hover wells.
private class SwarmIconButton: NSButton {
  private var hoverTracking: NSTrackingArea?
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
    // AppKit owns a separate tracking area for tooltips. Replacing all areas
    // leaves the tooltip string intact but prevents it from ever appearing.
    if let hoverTracking { removeTrackingArea(hoverTracking) }
    let area = NSTrackingArea(rect: .zero,
      options: [.mouseEnteredAndExited, .activeAlways, .inVisibleRect], owner: self)
    addTrackingArea(area)
    hoverTracking = area
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
    // `labelColor`, not white: it is white under a dark palette and black under
    // a light one (`NSApp.appearance`, set in `updatePalette`).
    if state == .on && isEnabled {
      NSColor.labelColor.withAlphaComponent(0.08).setFill()
      NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7).fill()
    }
    if showsHoverFill && isEnabled && (hovered || hasKeyboardFocus || isHighlighted) {
      NSColor.labelColor.withAlphaComponent(isHighlighted ? 0.10 : 0.05).setFill()
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

private let workspaceBarGroupSeparator = "   "
private let workspaceBarSpacing = try! NSRegularExpression(pattern: " {3}| ")

/// Plain toolbar icons emphasize the glyph without a button well.
private class SwarmPlainIconButton: SwarmIconButton {
  var foreground = NSColor.white { didSet { needsDisplay = true } }
  var restingOpacity: CGFloat = 0.75 { didSet { needsDisplay = true } }
  var highContrastRestingOpacity: CGFloat? { didSet { needsDisplay = true } }

  override func draw(_ dirtyRect: NSRect) {
    let emphasized = isEnabled && (hovered || hasKeyboardFocus || isHighlighted)
    // Draw only the glyph: AppKit can paint a hover bezel even on a borderless
    // NSButton. Emphasis belongs to the glyph, never a background around it.
    if let symbol = image?.withSymbolConfiguration(symbolConfiguration ?? HarnessControlSymbols.configuration) {
      let rect = NSRect(x: (bounds.width - symbol.size.width) / 2,
        y: (bounds.height - symbol.size.height) / 2,
        width: symbol.size.width, height: symbol.size.height)
      NSGraphicsContext.current?.cgContext.beginTransparencyLayer(auxiliaryInfo: nil)
      symbol.draw(in: rect)
      let quietOpacity = NSWorkspace.shared.accessibilityDisplayShouldIncreaseContrast
        ? highContrastRestingOpacity ?? restingOpacity : restingOpacity
      foreground.withAlphaComponent(isEnabled ? (emphasized ? 1 : quietOpacity) : 0.28).setFill()
      rect.fill(using: .sourceIn)
      NSGraphicsContext.current?.cgContext.endTransparencyLayer()
    }
  }
}

/// A quiet filled pill, with the Store's colorful mark as its focal point.
/// Drawing the content keeps the same spacing across AppKit button styles.
private final class SwarmStoreButton: SwarmIconButton {
  var markSize: CGFloat = 16
  var palette = SwarmNativePalette() { didSet { needsDisplay = true } }
  var preferredWidth: CGFloat {
    ceil(workspaceBarTextWidth(title,
      font: font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular))) + 48
  }

  override func draw(_ dirtyRect: NSRect) {
    let shape = NSBezierPath(roundedRect: bounds.insetBy(dx: 0.5, dy: 0.5),
      xRadius: bounds.height / 2, yRadius: bounds.height / 2)
    palette.workspace.setFill()
    shape.fill()
    let alpha: CGFloat = !isEnabled ? 0.04 : isHighlighted ? 0.24 : hovered ? 0.18 : 0.10
    palette.accent.withAlphaComponent(alpha).setFill()
    shape.fill()
    palette.accent.withAlphaComponent(hasKeyboardFocus && isEnabled ? 0.85 : 0.12).setStroke()
    shape.lineWidth = hasKeyboardFocus && isEnabled ? 1.5 : 1
    shape.stroke()
    let iconRect = NSRect(x: 12, y: (bounds.height - markSize) / 2, width: markSize, height: markSize)
    image?.draw(in: iconRect,
      from: .zero, operation: .sourceOver, fraction: isEnabled ? 1 : 0.45,
      respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    let attributes: [NSAttributedString.Key: Any] = [
      .paragraphStyle: paragraph,
      .font: font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular),
      .foregroundColor: palette.accent.withAlphaComponent(isEnabled ? 1 : 0.45),
    ]
    let text = title as NSString
    let height = text.size(withAttributes: attributes).height
    let textX = 20 + markSize
    text.draw(in: NSRect(x: textX, y: (bounds.height - height) / 2,
      width: max(0, bounds.width - textX - 12), height: height), withAttributes: attributes)
  }
}

/// Flat primary action; Dart supplies the same colors and text as Flutter.
private final class SwarmShareButton: SwarmIconButton {
  var background = NSColor.clear { didSet { needsDisplay = true } }
  var foreground = NSColor.white { didSet { needsDisplay = true } }
  var preferredWidth: CGFloat {
    let regularFont = font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    let cell = ("m" as NSString).size(withAttributes: [.font: regularFont]).width
    return ceil(workspaceBarTextWidth(title, font: regularFont) + cell * 2)
  }

  override func draw(_ dirtyRect: NSRect) {
    background.setFill()
    bounds.fill()
    let regularFont = font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    let emphasized = isEnabled && (hovered || hasKeyboardFocus || isHighlighted)
    let line = NSAttributedString(string: title, attributes: [
      .font: emphasized ? workspaceBarEmphasisFont(regularFont) : regularFont,
      .foregroundColor: foreground,
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

/// A daemon glyph is at most eight printable ASCII cells. Anything else draws nothing.
private func validDaemonGlyph(_ value: String?) -> String? {
  validDaemonText(value, cells: 8)
}

/// Printable ASCII of at most [cells] cells, or nothing: the slot's ten cells
/// (the glyph centred on its base sprite, a gutter each side, a shiny `*`).
private func validDaemonText(_ value: String?, cells: Int) -> String? {
  guard let value, value.unicodeScalars.count <= cells,
        value.unicodeScalars.allSatisfy({ $0.value >= 0x20 && $0.value <= 0x7e }) else { return nil }
  return value
}

/// Only generated, bundled slot frames may reach AppKit. No URLs, paths supplied
/// by a daemon, or full-size hover portraits are decoded by this small control.
private final class SwarmDaemonArt {
  // Generated from each idle pose, shared with Flutter. Keep anchors fixed
  // throughout animation so breathing and jumps don't get centered away.
  private lazy var centers: [String: [Double]] = {
    guard let url = assetURL("assets/daemon-art/alignment.json"),
      let data = try? Data(contentsOf: url), data.count <= 16384,
      let values = try? JSONDecoder().decode([String: [Double]].self, from: data),
      values.count <= 64,
      values.values.allSatisfy({ $0.count == 4 && $0.enumerated().allSatisfy {
        $0.element.isFinite && (0...($0.offset < 2 ? 64.0 : 350.0)).contains($0.element)
      } }) else { return [:] }
    return values
  }()

  func center(asset: String?) -> NSPoint {
    guard let asset, Self.opens(asset) else { return NSPoint(x: 0.5, y: 0.5) }
    let name = asset.components(separatedBy: "/").last ?? ""
    let key = name.components(separatedBy: "_").prefix(2).joined(separator: "_")
    guard let center = centers[key] else { return NSPoint(x: 0.5, y: 0.5) }
    return NSPoint(x: center[0] / 64, y: center[1] / 64)
  }

  static func opens(_ asset: String) -> Bool {
    let prefix = "assets/daemon-art/slot/"
    guard asset.utf8.count <= 160, asset.hasPrefix(prefix), asset.hasSuffix(".png") else { return false }
    let stem = asset.dropFirst(prefix.count).dropLast(4)
    return !stem.isEmpty && stem.unicodeScalars.allSatisfy {
      (0x30...0x39).contains($0.value) || (0x41...0x5a).contains($0.value) ||
        (0x61...0x7a).contains($0.value) || $0.value == 0x5f || $0.value == 0x2d
    }
  }

  private let cache = NSCache<NSString, NSImage>()
  private var missing: Set<String> = []
  private let assetURL: (String) -> URL?

  init(assetURL: @escaping (String) -> URL? = { asset in
    let framework = Bundle.main.privateFrameworksURL?.appendingPathComponent("App.framework")
    let bundle = framework.flatMap { Bundle(url: $0) }
      ?? Bundle(identifier: "io.flutter.flutter.app") ?? Bundle.main
    return bundle.resourceURL?.appendingPathComponent("flutter_assets").appendingPathComponent(asset)
  }) {
    self.assetURL = assetURL
    cache.countLimit = 128
    cache.totalCostLimit = 2 * 1024 * 1024
  }

  private lazy var palettes: [String: [[[Int]]]] = {
    guard let url = assetURL("assets/daemon-art/styles.json"), let data = try? Data(contentsOf: url), data.count < 32768,
      let object = try? JSONSerialization.jsonObject(with: data) as? [String: [String: Any]] else { return [:] }
    return object.compactMapValues { $0["palettes"] as? [[[Int]]] }
  }()

  private func frame(_ asset: String) -> CGImage? {
    guard Self.opens(asset), let url=assetURL(asset), let source=CGImageSourceCreateWithURL(url as CFURL,nil) else { return nil }
    return CGImageSourceCreateThumbnailAtIndex(source,0,[
      kCGImageSourceCreateThumbnailFromImageAlways:true,kCGImageSourceCreateThumbnailWithTransform:true,
      kCGImageSourceThumbnailMaxPixelSize:64,kCGImageSourceShouldCacheImmediately:true] as CFDictionary)
  }

  private func rgba(_ image: CGImage) -> [UInt8]? {
    var bytes=[UInt8](repeating:0,count:image.width*image.height*4)
    let valid=bytes.withUnsafeMutableBytes { memory -> Bool in
      guard let context=CGContext(data:memory.baseAddress,width:image.width,height:image.height,bitsPerComponent:8,
        bytesPerRow:image.width*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,
        bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue) else { return false }
      context.draw(image,in:CGRect(x:0,y:0,width:image.width,height:image.height));return true
    }
    return valid ? bytes : nil
  }

  func image(asset: String?, style: [String: Any]? = nil) -> NSImage? {
    guard let asset,Self.opens(asset) else { return nil }
    let colour=style?["colour"] as? Int ?? -1, mark=style?["mark"] as? Int ?? 0
    let validColour=(-1...5).contains(colour) ? colour : -1, validMark=(0...4).contains(mark) ? mark : 0
    let key="\(asset):\(validColour):\(validMark)"
    guard !missing.contains(key) else { return nil }
    if let image=cache.object(forKey:key as NSString) { return image }
    guard var decoded=frame(asset) else { if missing.count<128 { missing.insert(key) };return nil }
    let species=asset.components(separatedBy:"/").last?.components(separatedBy:"_").first ?? ""
    if (validColour>=0 || validMark>0), let table=palettes[species],
      let material=frame(asset.replacingOccurrences(of:".png",with:"_material.png")),
      let marks=frame(asset.replacingOccurrences(of:".png",with:"_marks.png")),
      material.width==decoded.width,material.height==decoded.height,marks.width==decoded.width,marks.height==decoded.height,
      var pixels=rgba(decoded),let m=rgba(material),let k=rgba(marks) {
      let palette=validColour>=0 && validColour<table.count ? table[validColour] : nil
      for at in stride(from:0,to:pixels.count,by:4) {
        let alpha=Int(pixels[at+3]),shade=Int(m[at]),weight=Int(m[at+1])
        let marking=validMark==1 ? Int(m[at+2]) : validMark>=2 ? Int(k[at+validMark-2]) : 0
        for channel in 0..<3 {
          var value=alpha>0 ? min(255,Int(pixels[at+channel])*255/alpha) : 0
          if let palette,palette.count==2,palette[0].count==3,palette[1].count==3 {
            let dark=palette[0][channel],light=palette[1][channel]
            value=max(0,min(255,(value*(255-weight)+dark*weight+(light-dark)*shade+127)/255))
          }
          value=value*(255-marking*100/255)/255
          pixels[at+channel]=UInt8((value*alpha+127)/255)
        }
      }
      let transformed=pixels.withUnsafeMutableBytes { memory -> CGImage? in
        let context=CGContext(data:memory.baseAddress,width:decoded.width,height:decoded.height,bitsPerComponent:8,
          bytesPerRow:decoded.width*4,space:CGColorSpace(name:CGColorSpace.sRGB)!,
          bitmapInfo:CGImageAlphaInfo.premultipliedLast.rawValue | CGBitmapInfo.byteOrder32Big.rawValue)
        return context?.makeImage()
      }
      if let transformed { decoded=transformed }
    }
    let scale=32/CGFloat(max(decoded.width,decoded.height))
    let image=NSImage(cgImage:decoded,size:NSSize(width:CGFloat(decoded.width)*scale,height:CGFloat(decoded.height)*scale))
    cache.setObject(image,forKey:key as NSString,cost:decoded.bytesPerRow*decoded.height)
    return image
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
  fileprivate static var statusIcons = SwarmHistoryIcons()
  var onField: ((String, Int) -> Void)?
  fileprivate private(set) var fieldButtons: [SwarmContextButton] = []
  private var field: String?
  private var paneId: Int?

  var foreground = NSColor.white
  private var text = ""
  var textAlignment: NSTextAlignment = .right
  var contentPadding: CGFloat = 0
  var trailingContentPadding: CGFloat?
  var valueGapCells: CGFloat?
  var groupGapCells: CGFloat?
  private var detail: String?
  private var iconAsset: String?
  private var iconEngine: String?
  private var iconColor = NSColor.white
  private var iconSize: CGFloat { iconEngine == nil ? textFont.pointSize : textFont.pointSize * 14 / 13 }
  private var iconWidth: CGFloat { iconAsset == nil && iconEngine == nil ? 0 : iconSize + cellWidth }
  private var overflowButton: SwarmContextButton?
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
  private func spacingAdjustments(_ value: String) -> [(NSRange, CGFloat)] {
    guard valueGapCells != nil || groupGapCells != nil else { return [] }
    return workspaceBarSpacing.matches(in: value, range: NSRange(value.startIndex..., in: value)).map { match in
      let length = CGFloat(match.range.length)
      let cells = match.range.length == workspaceBarGroupSeparator.count ? groupGapCells : valueGapCells
      return (match.range, cellWidth * ((cells ?? length) - length))
    }
  }
  private var naturalWidths: [CGFloat] {
    segments.enumerated().map { index, segment in
      workspaceBarTextWidth(segment.text, font: textFont) + (segment.branchSymbol ? cellWidth * 2 : 0)
        + spacingAdjustments(segment.text).reduce(0) { $0 + $1.1 }
        + (index == 0 ? iconWidth : 0)
    }
  }
  var preferredWidth: CGFloat {
    if !fieldButtons.isEmpty { return fieldButtons.reduce(0) { $0 + $1.preferredWidth } }
    return ceil(naturalWidths.reduce(0, +) + contentPadding + (trailingContentPadding ?? contentPadding)
      + (segmented ? CGFloat(segments.count) * cellWidth * 3 : 0))
  }

  func update(_ context: [String: Any]?, enabled: Bool) {
    text = context?["text"] as? String ?? ""
    iconEngine = (context?["iconEngine"] as? String).flatMap { ["claude", "codex"].contains($0) ? $0 : nil }
    let asset = context?["iconAsset"] as? String
    iconAsset = asset.flatMap {
      SwarmHistoryIcons.pullRequestAssets.contains($0) || (iconEngine != nil && SwarmHistoryIcons.opens($0)) ? $0 : nil
    }
    iconColor = statusColor(context?["iconColor"], fallback: foreground)
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
      button.contentPadding = context?["paddedFields"] as? Bool == true ? contentPadding : 0
      button.update(values, enabled: enabled)
      button.setAccessibilityLabel(values["detail"] as? String ?? values["text"] as? String)
    }
    setAccessibilityChildren(fields.isEmpty ? nil : fieldButtons.filter { $0.field != nil })
    field = context?["field"] as? String
    paneId = context?["paneId"] as? Int
    if context?["overflowFields"] as? Bool == true {
      if overflowButton == nil {
        let button = SwarmContextButton()
        button.isBordered = false
        button.target = self
        button.action = #selector(openOverflow)
        overflowButton = button
        addSubview(button)
      }
      overflowButton?.font = font
      overflowButton?.foreground = foreground
      overflowButton?.contentPadding = contentPadding
    } else {
      overflowButton?.removeFromSuperview()
      overflowButton = nil
    }
    actionURL = context?["url"] as? String
    detail = context?["detail"] as? String
    updateTooltip()
    isEnabled = enabled && context?["interactive"] as? Bool == true
    setAccessibilityValue(context?["label"] as? String ?? text)
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

  @objc private func openOverflow() {
    guard isEnabled else { return }
    onField?("", 0)
  }

  override func layout() {
    super.layout()
    updateTooltip()
    guard !fieldButtons.isEmpty else { return }
    let natural = fieldButtons.map { $0.preferredWidth }
    if let overflowButton {
      var count = fieldButtons.count
      var occupied = natural.reduce(0, +)
      func overflowWidth(_ hidden: Int) -> CGFloat {
        hidden == 0 ? 0 : ceil(workspaceBarTextWidth("+\(hidden)", font: textFont) + contentPadding * 2)
      }
      while count > 0 && occupied + overflowWidth(fieldButtons.count - count) > bounds.width {
        count -= 1
        occupied -= natural[count]
      }
      var x: CGFloat = 0
      for (index, button) in fieldButtons.enumerated() {
        button.isHidden = index >= count
        button.setAccessibilityHidden(button.isHidden)
        button.frame = NSRect(x: x, y: 0, width: button.isHidden ? 0 : natural[index], height: bounds.height)
        if !button.isHidden { x += natural[index] }
      }
      let hidden = fieldButtons.count - count
      overflowButton.isHidden = hidden == 0
      let label = "\(hidden) more subscriptions"
      overflowButton.update(["text": "+\(hidden)", "label": label,
        "detail": fieldButtons.dropFirst(count).compactMap { $0.detail }.joined(separator: "\n\n"),
        "interactive": true, "segments": [["text": "+\(hidden)"]]], enabled: isEnabled)
      overflowButton.setAccessibilityLabel(label)
      overflowButton.frame = NSRect(x: x, y: 0, width: min(overflowWidth(hidden), max(0, bounds.width - x)), height: bounds.height)
      setAccessibilityChildren(fieldButtons.filter { !$0.isHidden } + (hidden == 0 ? [] : [overflowButton]))
      return
    }
    var widths = natural
    var excess = max(0, widths.reduce(0, +) - bounds.width)
    for (index, button) in fieldButtons.enumerated() where button.field == "branch" {
      let reduction = min(excess, max(0, widths[index] - cellWidth * 12))
      widths[index] -= reduction
      excess -= reduction
    }
    if widths.reduce(0, +) > bounds.width {
      let capped = widths
      var low: CGFloat = 0, high = capped.max() ?? 0
      for _ in 0..<24 {
        let cap = (low + high) / 2
        if capped.reduce(0, { $0 + min($1, cap) }) > bounds.width { high = cap }
        else { low = cap }
      }
      widths = capped.map { min($0, low) }
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
    paragraph.lineBreakMode = field == "branch" ? .byTruncatingMiddle : .byTruncatingTail
    paragraph.alignment = alignment
    let line = NSMutableAttributedString(string: value, attributes: [
      .font: isEnabled && (hovered || hasKeyboardFocus || isHighlighted)
        ? workspaceBarEmphasisFont(textFont) : textFont,
      .foregroundColor: color, .paragraphStyle: paragraph,
    ])
    for (range, adjustment) in spacingAdjustments(value) where adjustment != 0 {
      line.addAttribute(.kern, value: adjustment / CGFloat(range.length), range: range)
    }
    return line
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
  private func drawPullRequestIcon(x: CGFloat, color: NSColor) {
    guard iconAsset != nil || iconEngine != nil else { return }
    let size = iconSize
    let rect = NSRect(x: x, y: (bounds.height - size) / 2, width: size, height: size)
    let image = Self.statusIcons.image(engine: iconEngine, asset: iconAsset, pointSize: size)
    if iconEngine != nil && iconEngine != "claude" {
      image.draw(in: rect)
      return
    }
    // Preserve the SVG at the current backing scale; tint only this layer.
    NSGraphicsContext.current?.cgContext.beginTransparencyLayer(auxiliaryInfo: nil)
    image.draw(in: rect)
    color.setFill()
    rect.fill(using: .sourceIn)
    NSGraphicsContext.current?.cgContext.endTransparencyLayer()
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
      let trailingInset = min(trailingContentPadding ?? contentPadding, bounds.width - inset)
      drawPullRequestIcon(x: inset, color: iconColor)
      line.draw(in: NSRect(x: inset + iconWidth, y: (bounds.height - line.size().height) / 2,
        width: max(0, bounds.width - inset - trailingInset - iconWidth), height: line.size().height))
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
      let leadingIconWidth = index == 0 ? iconWidth : 0
      if leadingIconWidth > 0 { drawPullRequestIcon(x: x + inset, color: segment.foreground) }
      let line = attributed(segment.text, segment.foreground)
      line.draw(in: NSRect(x: x + inset + symbolWidth + leadingIconWidth, y: (bounds.height - line.size().height) / 2,
        width: max(0, widths[index] - symbolWidth - leadingIconWidth), height: line.size().height))
      x += width
    }
  }
}

/// A fixed footer companion slot. Bundled artwork and legacy ASCII share the
/// same footprint; changing a frame or growth stage never moves adjacent tabs.
private final class SwarmSymbolButton: SwarmIconButton {
  var glyph = ""
  /// The ten cells as Flutter drew them: the glyph centred on its version's base
  /// sprite (so a baton never moves the face) and a shiny `*` in the left gutter.
  var cells = ""
  let columns = 8
  /// A hatch in flight or its reveal running: drawn at full ink, not clickable.
  var busy = false
  var foreground = NSColor.white
  /// The grue on a light theme: a black patch behind its eight cells.
  var patch: NSColor?
  var art: NSImage?
  var artCenter = NSPoint(x: 0.5, y: 0.5)
  /// The pointer arrived: "I see you". Never moves keyboard focus.
  var onEnter: (() -> Void)?
  var onExit: (() -> Void)?
  private var textFont: NSFont { font ?? NSFont.monospacedSystemFont(ofSize: 13, weight: .regular) }
  private var cellWidth: CGFloat { ceil(workspaceBarTextWidth("m", font: textFont)) }
  var preferredWidth: CGFloat { 44 }

  override func mouseEntered(with event: NSEvent) {
    super.mouseEntered(with: event)
    if !isHidden { onEnter?() }
  }

  override func mouseExited(with event: NSEvent) {
    super.mouseExited(with: event)
    onExit?()
  }

  override func draw(_ dirtyRect: NSRect) {
    if let art {
      let maximum = min(32, min(bounds.width - 8, bounds.height - 4))
      guard maximum > 0 else { return }
      let scale = maximum / max(art.size.width, art.size.height)
      let size = NSSize(width: art.size.width * scale, height: art.size.height * scale)
      NSGraphicsContext.saveGraphicsState()
      NSGraphicsContext.current?.imageInterpolation = .high
      let yCenter = isFlipped ? artCenter.y : 1 - artCenter.y
      art.draw(in: NSRect(x: bounds.midX - size.width * artCenter.x, y: bounds.midY - size.height * yCenter,
        width: size.width, height: size.height), from: .zero, operation: .sourceOver,
        fraction: isEnabled || busy ? 1 : 0.35, respectFlipped: true, hints: nil)
      if isEnabled && hasKeyboardFocus {
        NSColor.keyboardFocusIndicatorColor.setStroke()
        let ring = NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 4, yRadius: 4)
        ring.lineWidth = 2
        ring.stroke()
      }
      NSGraphicsContext.restoreGraphicsState()
      return
    }
    guard !glyph.isEmpty || !cells.isEmpty else { return }
    // Species without illustrated artwork retain their complete, safe ASCII
    // face, scaled into the same fixed slot rather than clipped at either edge.
    let slotWidth = cellWidth * CGFloat(columns + 2)
    let scale = min(1, max(0, bounds.width - 8) / slotWidth)
    guard scale > 0, let context = NSGraphicsContext.current?.cgContext else { return }
    NSGraphicsContext.saveGraphicsState()
    defer { NSGraphicsContext.restoreGraphicsState() }
    context.translateBy(x: bounds.midX, y: bounds.midY)
    context.scaleBy(x: scale, y: scale)
    let ink = isEnabled || busy ? foreground : foreground.withAlphaComponent(0.35)
    let active = isEnabled && (hovered || hasKeyboardFocus || isHighlighted)
    let drawFont = active ? workspaceBarEmphasisFont(textFont) : textFont
    let attributes: [NSAttributedString.Key: Any] = [.font: drawFont, .foregroundColor: ink, .ligature: 0]
    guard !cells.isEmpty else {
      let size = (glyph as NSString).size(withAttributes: attributes)
      (glyph as NSString).draw(at: NSPoint(x: -size.width / 2, y: -size.height / 2),
        withAttributes: attributes)
      return
    }
    let slotX = -slotWidth / 2
    let height = (cells as NSString).size(withAttributes: attributes).height
    if let patch {
      patch.setFill()
      NSRect(x: slotX + cellWidth, y: -height / 2, width: cellWidth * CGFloat(columns), height: height).fill()
    }
    (cells as NSString).draw(at: NSPoint(x: slotX, y: -height / 2), withAttributes: attributes)
  }
}

/// The daemon's one line, where the status line's context sits: tmux's message
/// line, yellow for what needs you and the bar's own dimmer ink for a reply.
/// Right-aligned in the bar font, truncated rather than wrapped. A line from the
/// pair brain is drawn exactly as sent, its keys first (`[y/n/g] ...`); each
/// offered key in that bracket is clickable, and a click answers without taking
/// focus. Until the line is armed (the window drew it, and what its keys do, a
/// moment ago) its keys other than `g` are drawn faint and take no click.
private final class SwarmVoiceLabel: NSView {
  var text = "" { didSet { if text != oldValue { needsDisplay = true; setAccessibilityLabel(text) } } }
  var actions: [(key: String, label: String)] = [] { didSet { needsDisplay = true } }
  var armed = true { didSet { if armed != oldValue { needsDisplay = true } } }
  /// Offered keys that are not armed yet: where they are in `text`.
  private(set) var arming: [(key: String, range: NSRange)] = []
  var color = NSColor.systemYellow { didSet { needsDisplay = true } }
  var font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular) { didSet { needsDisplay = true } }
  var onAction: ((String) -> Void)?
  private(set) var actionRects: [(key: String, rect: NSRect)] = []

  override init(frame: NSRect) {
    super.init(frame: frame)
    setAccessibilityElement(true)
    setAccessibilityRole(.staticText)
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }
  override var mouseDownCanMoveWindow: Bool { actionRects.isEmpty }
  override var acceptsFirstResponder: Bool { false }
  override func acceptsFirstMouse(for event: NSEvent?) -> Bool { true }
  override func hitTest(_ point: NSPoint) -> NSView? {
    let local = convert(point, from: superview)
    return actionRects.contains(where: { $0.rect.contains(local) }) ? self : nil
  }
  override func mouseDown(with event: NSEvent) {
    answer(at: convert(event.locationInWindow, from: nil))
  }
  /// The answer drawn at a point of this view, if any.
  func answer(at local: NSPoint) {
    if let hit = actionRects.first(where: { $0.rect.contains(local) }) { onAction?(hit.key) }
  }

  private func attributed(_ string: String) -> NSAttributedString {
    NSAttributedString(string: string, attributes: [.font: font, .foregroundColor: color, .ligature: 0])
  }

  /// The line is drawn exactly as the brain sent it, right-aligned, keys first
  /// (`[y/n/g] api@office: npm test`); it truncates at its tail, so the keys
  /// always show. Each offered key inside that leading bracket is clickable.
  /// Returns the line's rect.
  private func layoutActions() -> NSRect {
    let lineWidth = min(ceil(attributed(text).size().width), bounds.width)
    let x0 = bounds.width - lineWidth
    var rects: [(key: String, rect: NSRect)] = []
    var faint: [(key: String, range: NSRange)] = []
    let offered = Set(actions.map { $0.key })
    if !offered.isEmpty, text.hasPrefix("["), let close = text.firstIndex(of: "]") {
      let inside = text[text.index(after: text.startIndex)..<close]
      var index = 1
      for part in inside.split(separator: "/", omittingEmptySubsequences: false) {
        let key = String(part)
        if offered.contains(key) && !armed && key != "g" {
          faint.append((key, NSRange(location: index, length: key.count)))
        } else if offered.contains(key) {
          let before = ceil(attributed(String(text.prefix(index))).size().width)
          let width = ceil(attributed(key).size().width)
          if before + width <= lineWidth {
            rects.append((key, NSRect(x: x0 + before, y: 0, width: width, height: bounds.height)))
          }
        }
        index += key.count + 1
      }
    }
    actionRects = rects
    arming = faint
    return NSRect(x: x0, y: 0, width: lineWidth, height: bounds.height)
  }

  override func draw(_ dirtyRect: NSRect) {
    guard !text.isEmpty, bounds.width > 0 else { actionRects = []; return }
    let lineRect = layoutActions()
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .right
    paragraph.lineBreakMode = .byTruncatingTail
    let line = NSMutableAttributedString(string: text, attributes: [
      .font: font, .foregroundColor: color, .ligature: 0, .paragraphStyle: paragraph,
    ])
    for key in arming {
      line.addAttribute(.foregroundColor, value: color.withAlphaComponent(color.alphaComponent * 0.4), range: key.range)
    }
    let height = ceil(line.size().height)
    line.draw(with: NSRect(x: lineRect.minX, y: (bounds.height - height) / 2, width: lineRect.width, height: height),
      options: [.usesLineFragmentOrigin, .truncatesLastVisibleLine])
    // Offered keys are underlined, like the Flutter status line draws them.
    color.setFill()
    for hit in actionRects {
      NSRect(x: hit.rect.minX, y: (bounds.height - height) / 2 + 1, width: hit.rect.width, height: 1).fill()
    }
  }
}

/// Mirrors hn and Dart's ten-frame, 100ms Braille clock. The channel sends only
/// activity changes; animation never pushes workspace snapshots through Flutter.
private let harnessActivityFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]
func harnessActivityFrame(at date: Date = Date()) -> Int {
  Int(date.timeIntervalSince1970 * 1000) / 100 % harnessActivityFrames.count
}

/// Shared by native tabs and notification rows. These are Harness's activity
/// glyphs, not a second set of SF Symbols. Keep the tab's original geometry.
struct HarnessNativeActivity: Equatable {
  let mark: String
  let label: String
  let working: Bool
  let color: NSColor

  init?(_ payload: [String: Any]?) {
    guard let payload, let mark = payload["mark"] as? String,
          let label = payload["label"] as? String else { return nil }
    self.mark = mark
    self.label = label
    working = payload["working"] as? Bool == true
    color = statusColor(payload["color"], fallback: .labelColor)
  }

  func symbol(frame: Int) -> String { working ? harnessActivityFrames[frame] : mark }

  static func draw(_ mark: String, in rect: NSRect, color: NSColor) {
    let font = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
    let paused = mark == "||"
    let marker = NSAttributedString(string: mark,
      attributes: [.font: paused ? NSFontManager.shared.convert(font, toSize: font.pointSize * 0.65) : font,
        .kern: paused ? -font.pointSize * 0.15 : 0, .foregroundColor: color])
    marker.draw(at: NSPoint(x: rect.midX - marker.size().width / 2,
                           y: rect.midY - marker.size().height / 2))
  }
}

private final class SwarmStatusBar: NSView {
  var onLayout: (() -> Void)?
  override var mouseDownCanMoveWindow: Bool { false }
  override func layout() { super.layout(); onLayout?() }
}

private final class SwarmTabStrip: NSView {
  private(set) var palette = SwarmNativePalette()
  fileprivate let statusBar = SwarmStatusBar(frame: NSRect(x: 0, y: 0, width: 900, height: 28))
  // Same gutter as kWorkspaceInset in Flutter. It belongs to the footer's
  // centering area rather than only above it, leaving equal top/bottom space.
  var preferredStatusBarHeight: CGFloat { workspaceBarControlHeight(barFont) + 9.5 }
  var emit: ((String, Any?) -> Void)?
  private let scroll = SwarmStripScrollView()
  private let document = NSView()
  fileprivate let newButton = SwarmPlainIconButton()
  fileprivate let contextButton = SwarmContextButton()
  fileprivate let subscriptionUsageButton = SwarmContextButton()
  fileprivate let harnessMonitorButton = SwarmContextButton()
  fileprivate let machinesButton = SwarmContextButton()
  fileprivate let modelsButton = SwarmContextButton()
  fileprivate let machineResourcesLabel = SwarmContextButton()
  private var machineResourcesState: [String: Any]?
  private var subscriptionUsageState: [String: Any]?
  fileprivate let pullRequestButton = SwarmContextButton()
  fileprivate let shareButton = SwarmShareButton()
  fileprivate let searchButton = SwarmPlainIconButton()
  fileprivate let storeButton = SwarmStoreButton()
  fileprivate let devicesButton = SwarmStoreButton()
  private var shareTarget: [String: Any]?
  private var barFont = NSFont.monospacedSystemFont(ofSize: 13, weight: .regular)
  private var resourceValueGapCells: CGFloat = 0.75
  private var resourceGroupGapCells: CGFloat = 2
  private let navigationFont = NSFont.systemFont(ofSize: 13, weight: .regular)
  fileprivate let daemonButton = SwarmSymbolButton()
  private var daemonArt = SwarmDaemonArt()
  private var daemonHovering = false
  fileprivate let voiceLabel = SwarmVoiceLabel()
  // What the status line holds, apart from whether the daemon's voice covers it.
  private var hasSubscriptionUsage = false
  private var hasPullRequest = false
  private(set) var voiceActive = false
  private var terminalForeground = NSColor(white: 0.85, alpha: 1)
  private var tabs: [SwarmTabButton] = []
  private var activeId = ""
  private var revealActiveAfterLayout = false
  private var tabOrderChanged = false
  private var actionsEnabled = false
  private var reduceMotion = false
  private var activityTimer: Timer?
  private var activityObservers: [NSObjectProtocol] = []
  private var motionObserver: NSObjectProtocol?
  private var modifierMonitor: Any?
  private var shortcutHintsVisible = false
  private var lastBackgroundClick: (time: TimeInterval, point: NSPoint)?
  // Dragging is explicit below. AppKit must not also start a titlebar gesture.
  override var mouseDownCanMoveWindow: Bool { false }

  override init(frame: NSRect) {
    super.init(frame: frame)
    statusBar.isHidden = true
    statusBar.onLayout = { [weak self] in self?.layoutStatusBar() }
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
    newButton.toolTip = "New Tab"
    newButton.image = HarnessControlSymbols.image("plus")
    newButton.title = ""
    newButton.imagePosition = .imageOnly
    contextButton.isBordered = false
    contextButton.alignment = .right
    contextButton.target = self
    contextButton.setAccessibilityLabel("Focused pane")
    contextButton.onField = { [weak self] field, paneId in
      guard let self, self.actionsEnabled else { return }
      self.emit?("focusedContext", ["field": field, "paneId": paneId])
    }
    statusBar.addSubview(contextButton)
    subscriptionUsageButton.isBordered = false
    subscriptionUsageButton.textAlignment = .center
    subscriptionUsageButton.target = self
    subscriptionUsageButton.action = #selector(openSubscriptions)
    subscriptionUsageButton.setAccessibilityLabel("Remaining subscription allowance")
    subscriptionUsageButton.onField = { [weak self] id, _ in
      guard let self, self.actionsEnabled else { return }
      self.emit?("subscriptions", id.isEmpty ? nil : ["id": id])
    }
    subscriptionUsageButton.isHidden = true
    statusBar.addSubview(subscriptionUsageButton)
    harnessMonitorButton.isBordered = false
    harnessMonitorButton.textAlignment = .center
    harnessMonitorButton.target = self
    harnessMonitorButton.action = #selector(openHarnessMonitor)
    harnessMonitorButton.setAccessibilityLabel("Harness Monitor")
    harnessMonitorButton.isHidden = true
    statusBar.addSubview(harnessMonitorButton)
    for (button, label, action) in [
      (machinesButton, "Machines", #selector(openFooterMachines)),
      (modelsButton, "Local models", #selector(openFooterModels))
    ] {
      button.isBordered = false
      button.textAlignment = .center
      button.target = self
      button.action = action
      button.setAccessibilityLabel(label)
      button.isHidden = true
      statusBar.addSubview(button)
    }
    machineResourcesLabel.isBordered = false
    machineResourcesLabel.textAlignment = .left
    machineResourcesLabel.target = self
    machineResourcesLabel.action = #selector(openHarnessMonitor)
    machineResourcesLabel.setAccessibilityRole(.button)
    machineResourcesLabel.setAccessibilityLabel("Harness resources — Open Harness Monitor")
    machineResourcesLabel.isHidden = true
    statusBar.addSubview(machineResourcesLabel)
    pullRequestButton.isBordered = false
    pullRequestButton.target = self
    pullRequestButton.action = #selector(openFocusedPullRequest)
    pullRequestButton.setAccessibilityLabel("Open pull request on GitHub")
    pullRequestButton.isHidden = true
    statusBar.addSubview(pullRequestButton)
    voiceLabel.isHidden = true
    voiceLabel.onAction = { [weak self] key in
      guard let self, self.actionsEnabled, !self.voiceLabel.isHidden else { return }
      // The plain channel path: an answer never moves keyboard focus.
      self.emit?("daemonAnswer", ["key": key])
    }
    statusBar.addSubview(voiceLabel)
    daemonButton.isBordered = false
    daemonButton.title = ""
    daemonButton.isHidden = true
    daemonButton.isEnabled = false
    daemonButton.target = self
    daemonButton.action = #selector(openDaemon)
    daemonButton.onEnter = { [weak self] in
      guard let self, self.actionsEnabled, !self.daemonButton.isHidden else { return }
      guard self.window == nil || NSApp.isActive else { return }
      self.emit?("daemonLook", nil)
      self.setDaemonHover(true)
    }
    daemonButton.onExit = { [weak self] in self?.setDaemonHover(false) }
    statusBar.addSubview(daemonButton)
    searchButton.isBordered = false
    searchButton.focusRingType = .none
    searchButton.title = ""
    searchButton.image = HarnessControlSymbols.image("magnifyingglass")
    searchButton.imagePosition = .imageOnly
    searchButton.isEnabled = false
    searchButton.target = self
    searchButton.action = #selector(openSearch)
    searchButton.setAccessibilityLabel("Open Harness")
    addSubview(searchButton)
    devicesButton.isBordered = false
    devicesButton.title = "Devices"
    devicesButton.font = navigationFont
    devicesButton.palette = palette
    devicesButton.markSize = 20
    devicesButton.image = SwarmHistoryIcons().image(engine: "devices",
      asset: "assets/devices/harness-mark.png", pointSize: devicesButton.markSize)
    devicesButton.isEnabled = false
    devicesButton.isHidden = true
    devicesButton.focusRingType = .none
    devicesButton.target = self
    devicesButton.action = #selector(openDevices)
    devicesButton.toolTip = "Manage Harness devices"
    devicesButton.setAccessibilityLabel("Devices")
    addSubview(devicesButton)
    storeButton.isBordered = false
    storeButton.title = "Harness Store"
    storeButton.font = navigationFont
    storeButton.palette = palette
    storeButton.image = SwarmHistoryIcons().image(engine: "store", asset: "assets/store/polymath.png")
    storeButton.isEnabled = false
    storeButton.focusRingType = .none
    storeButton.target = self
    storeButton.action = #selector(openStore)
    storeButton.setAccessibilityLabel("Harness Store")
    addSubview(storeButton)
    shareButton.isBordered = false
    shareButton.title = "[ Share ]"
    shareButton.target = self
    shareButton.action = #selector(shareFocusedAgent)
    shareButton.isEnabled = false
    shareButton.isHidden = true
    shareButton.setAccessibilityLabel("Share")
    statusBar.addSubview(shareButton)
    // Flutter owns its content view's accessibility children. Expose the
    // native footer through our native chrome tree while keeping its geometry
    // attached to the content bottom.
    statusBar.setAccessibilityElement(true)
    statusBar.setAccessibilityRole(.group)
    statusBar.setAccessibilityLabel("Focused pane status")
    statusBar.setAccessibilityParent(self)
    setAccessibilityChildren([scroll, newButton, searchButton, storeButton, statusBar])
    statusBar.setAccessibilityChildren([harnessMonitorButton, machinesButton, modelsButton, machineResourcesLabel, subscriptionUsageButton, daemonButton, shareButton, voiceLabel, contextButton, pullRequestButton])
    registerForDraggedTypes([swarmPasteboardType])
    scroll.contentView.postsBoundsChangedNotifications = true
    for name in [NSApplication.didBecomeActiveNotification, NSApplication.didResignActiveNotification,
                 NSWindow.didChangeOcclusionStateNotification, NSWindow.didResignKeyNotification,
                 NSView.boundsDidChangeNotification] {
      let object: AnyObject? = name == NSView.boundsDidChangeNotification ? scroll.contentView : nil
      activityObservers.append(NotificationCenter.default.addObserver(forName: name, object: object, queue: .main) {
        [weak self] notification in
        guard let self else { return }
        if notification.name == NSApplication.didResignActiveNotification ||
           (notification.name == NSWindow.didResignKeyNotification && notification.object as? NSWindow === self.window) {
          self.setDaemonHover(false)
        }
        self.syncActivityAnimation()
      })
    }
    motionObserver = NSWorkspace.shared.notificationCenter.addObserver(
      forName: NSWorkspace.accessibilityDisplayOptionsDidChangeNotification, object: nil, queue: .main) {
        [weak self] _ in self?.syncActivityAnimation()
      }
    // Observe only; Flutter/AppKit keep ownership of every shortcut and IME event.
    modifierMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      guard let self, let window = self.window,
            event.window === window || (event.window == nil && window.isKeyWindow) else { return event }
      self.setShortcutHintsVisible(event.modifierFlags.contains(.command))
      return event
    }
    for name in [NSApplication.didResignActiveNotification, NSWindow.didResignKeyNotification] {
      activityObservers.append(NotificationCenter.default.addObserver(forName: name, object: nil, queue: .main) {
        [weak self] notification in
        guard let self else { return }
        if name == NSApplication.didResignActiveNotification || notification.object as? NSWindow === self.window {
          self.setShortcutHintsVisible(false)
        }
      })
    }
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  deinit {
    activityTimer?.invalidate()
    daemonRevealTimer?.invalidate()
    activityObservers.forEach(NotificationCenter.default.removeObserver)
    if let motionObserver { NSWorkspace.shared.notificationCenter.removeObserver(motionObserver) }
    if let modifierMonitor { NSEvent.removeMonitor(modifierMonitor) }
  }

  override func viewDidMoveToWindow() {
    super.viewDidMoveToWindow()
    if window == nil { setDaemonHover(false) }
    syncActivityAnimation()
    setShortcutHintsVisible(window?.isKeyWindow == true && NSEvent.modifierFlags.contains(.command))
  }

  private func setShortcutHintsVisible(_ visible: Bool) {
    shortcutHintsVisible = visible
    for tab in tabs { tab.showsShortcutHint = visible && actionsEnabled }
  }

  private var visibleWorkingTabs: [SwarmTabButton] {
    tabs.filter { $0.activity?.working == true && scroll.documentVisibleRect.intersects($0.frame) }
  }

  private func syncActivityAnimation() {
    if isHiddenOrHasHiddenAncestor || (window != nil &&
       (!NSApp.isActive || window?.occlusionState.contains(.visible) != true)) {
      setDaemonHover(false)
    }
    let moving = actionsEnabled && !reduceMotion &&
      !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion && NSApp.isActive &&
      window?.occlusionState.contains(.visible) == true && !isHiddenOrHasHiddenAncestor &&
      !visibleWorkingTabs.isEmpty
    guard moving else {
      activityTimer?.invalidate()
      activityTimer = nil
      for tab in tabs { tab.activityFrame = 0 }
      return
    }
    for tab in visibleWorkingTabs { tab.activityFrame = harnessActivityFrame() }
    guard activityTimer == nil else { return }
    let next = (floor(Date().timeIntervalSince1970 * 10) + 1) / 10
    let timer = Timer(fire: Date(timeIntervalSince1970: next), interval: 0.1, repeats: true) { [weak self] _ in
      guard let self else { return }
      for tab in self.visibleWorkingTabs { tab.activityFrame = harnessActivityFrame() }
    }
    activityTimer = timer
    RunLoop.main.add(timer, forMode: .common)
  }

  func updatePalette(_ values: [String: Any]) {
    let nextPalette = SwarmNativePalette(values)
    guard nextPalette != palette else { return }
    palette = nextPalette
    // Menus, the About panel, the traffic lights and every system color below
    // (`labelColor` in the hover wells) follow the app's appearance, not the
    // Flutter theme, so a light palette has to say so here.
    NSApp.appearance = NSAppearance(named: palette.dark ? .darkAqua : .aqua)
    storeButton.palette = palette
    newButton.contentTintColor = palette.accent
    devicesButton.palette = palette
    newButton.foreground = palette.navigationForeground
    for tab in tabs {
      tab.palette = palette
      tab.foreground = palette.navigationForeground
    }
    needsDisplay = true
  }


  func update(_ state: [String: Any]) {
    // Workspace teardown clears its controls without changing appearance.
    if let palette = state["palette"] as? [String: Any] { updatePalette(palette) }
    actionsEnabled = state["enabled"] as? Bool == true
    // The footer is a sibling above Flutter. Let Flutter's modal backdrop
    // cover this area too, including hit testing and accessibility.
    statusBar.isHidden = (state["tabs"] as? [Any])?.isEmpty != false || state["footerCovered"] as? Bool == true
    let passiveFooter = state["footerPassive"] as? Bool == true
    statusBar.setAccessibilityHidden(passiveFooter || statusBar.isHidden)
    devicesButton.isHidden = state["devicesVisible"] as? Bool != true
    devicesButton.setAccessibilityHidden(devicesButton.isHidden)
    setAccessibilityChildren(
      [scroll, newButton, searchButton] +
      (devicesButton.isHidden ? [] : [devicesButton]) + [storeButton] +
      (statusBar.isHidden || passiveFooter ? [] : [statusBar]))
    reduceMotion = state["reduceMotion"] as? Bool == true
    if let style = state["barStyle"] as? [String: Any] {
      let size = CGFloat(min(36, max(8, (style["size"] as? NSNumber)?.doubleValue ?? 13)))
      let families = [style["family"] as? String].compactMap { $0 } + (style["fallback"] as? [String] ?? [])
      barFont = families.lazy.compactMap { NSFont(name: $0, size: size) }.first
        ?? NSFont.monospacedSystemFont(ofSize: size, weight: .regular)
      terminalForeground = statusColor(style["foreground"], fallback: terminalForeground)
      resourceValueGapCells = CGFloat(max(0.5, (style["valueGapCells"] as? NSNumber)?.doubleValue ?? 0.75))
      resourceGroupGapCells = CGFloat(max(2, (style["groupGapCells"] as? NSNumber)?.doubleValue ?? 2))
    }
    for control in [newButton] {
      control.font = navigationFont
      control.foreground = palette.navigationForeground
      control.isEnabled = actionsEnabled
    }
    storeButton.font = navigationFont
    storeButton.isEnabled = actionsEnabled
    devicesButton.isEnabled = actionsEnabled && !devicesButton.isHidden
    searchButton.foreground = palette.navigationForeground
    searchButton.isEnabled = actionsEnabled
    searchButton.toolTip = state["searchTooltip"] as? String ?? "Open Harness"
    searchButton.setAccessibilityHelp(searchButton.toolTip)
    storeButton.toolTip = state["storeTooltip"] as? String ?? "Explore Harness Store"
    storeButton.setAccessibilityHelp(storeButton.toolTip)
    subscriptionUsageButton.font = barFont
    subscriptionUsageButton.foreground = terminalForeground
    subscriptionUsageButton.contentPadding = ("m" as NSString).size(withAttributes: [.font: barFont]).width
    subscriptionUsageButton.valueGapCells = resourceValueGapCells
    subscriptionUsageButton.groupGapCells = resourceGroupGapCells
    subscriptionUsageState = state["subscriptionUsage"] as? [String: Any]
    subscriptionUsageButton.update(subscriptionUsageState, enabled: actionsEnabled)
    hasSubscriptionUsage = subscriptionUsageState != nil
    harnessMonitorButton.font = barFont
    harnessMonitorButton.foreground = terminalForeground
    harnessMonitorButton.contentPadding = ("m" as NSString).size(withAttributes: [.font: barFont]).width
    harnessMonitorButton.valueGapCells = resourceValueGapCells
    harnessMonitorButton.update(state["harnessMonitor"] as? [String: Any], enabled: actionsEnabled)
    harnessMonitorButton.isHidden = state["harnessMonitor"] == nil
    for (button, key) in [(machinesButton, "footerMachines"), (modelsButton, "footerModels")] {
      button.font = barFont
      button.foreground = terminalForeground
      button.contentPadding = harnessMonitorButton.contentPadding
      button.valueGapCells = resourceValueGapCells
      button.update(state[key] as? [String: Any], enabled: actionsEnabled)
      button.isHidden = state[key] == nil
    }
    machineResourcesState = state["machineResources"] as? [String: Any]
    machineResourcesLabel.font = barFont
    machineResourcesLabel.foreground = terminalForeground
    machineResourcesLabel.contentPadding = harnessMonitorButton.contentPadding
    machineResourcesLabel.valueGapCells = resourceValueGapCells
    machineResourcesLabel.groupGapCells = resourceGroupGapCells
    machineResourcesLabel.update(machineResourcesState, enabled: actionsEnabled)
    machineResourcesLabel.isHidden = machineResourcesState == nil
    contextButton.font = barFont
    contextButton.foreground = terminalForeground
    contextButton.update(state["focusedContext"] as? [String: Any], enabled: actionsEnabled)
    pullRequestButton.font = barFont
    pullRequestButton.foreground = terminalForeground
    pullRequestButton.update(state["pullRequest"] as? [String: Any], enabled: actionsEnabled)
    shareTarget = state["shareAction"] as? [String: Any]
    shareButton.isHidden = shareTarget == nil
    shareButton.font = barFont
    shareButton.title = shareTarget?["text"] as? String ?? "[ Share ]"
    shareButton.isEnabled = actionsEnabled && shareTarget?["enabled"] as? Bool == true
    shareButton.background = statusColor(shareTarget?["background"], fallback: .clear)
    shareButton.foreground = statusColor(shareTarget?["foreground"], fallback: terminalForeground)
    shareButton.toolTip = shareTarget?["tooltip"] as? String
    shareButton.setAccessibilityLabel(shareTarget?["label"] as? String ?? "Share")
    shareButton.setAccessibilityHelp(shareButton.toolTip)
    hasPullRequest = state["pullRequest"] != nil
    daemonButton.font = barFont
    daemonButton.foreground = terminalForeground
    voiceLabel.font = barFont
    updateDaemon(state["daemon"] as? [String: Any] ?? [:])
    let rows = state["tabs"] as? [[String: Any]] ?? []
    let nextActiveId = state["activeId"] as? String ?? ""
    // A closed tab left the keyboard on the strip (Dart's `tabStripFocused`):
    // the selected tab is drawn focused, and Return goes into it. The keys stay
    // with Flutter, so every shortcut keeps working while the strip holds them.
    let tabsFocused = state["tabsFocused"] as? Bool == true
    revealActiveAfterLayout = revealActiveAfterLayout || nextActiveId != activeId
    activeId = nextActiveId
    let ids = rows.compactMap { $0["id"] as? String }
    let previousOrder = tabs.map(\.swarmId)
    tabOrderChanged = tabOrderChanged || ids != previousOrder
    for tab in tabs where !ids.contains(tab.swarmId) { tab.removeFromSuperview() }
    let previous = Dictionary(uniqueKeysWithValues: tabs.map { ($0.swarmId, $0) })
    tabs = rows.enumerated().compactMap { index, row in
      guard let id = row["id"] as? String else { return nil }
      let tab = previous[id] ?? SwarmTabButton(id: id)
      tab.palette = palette
      tab.name = row["name"] as? String ?? "New Tab"
      let displayLabel = row["label"] as? String ?? tab.name
      // Older Dart payloads generated an index prefix. The explicit hint key
      // marks the new clean-label payload, including a custom title like "1: Plan".
      tab.displayLabel = row["label"] != nil && !row.keys.contains("shortcutHint")
        ? displayLabel.replacingOccurrences(of: #"^\d+:"#, with: "", options: .regularExpression)
        : displayLabel
      tab.shortcutHint = row.keys.contains("shortcutHint")
        ? row["shortcutHint"] as? String : (index < 9 ? "⌘\(index + 1)" : nil)
      tab.showsShortcutHint = shortcutHintsVisible && actionsEnabled
      tab.foreground = palette.navigationForeground
      tab.selected = id == activeId
      tab.keyboardFocus = tabsFocused && id == activeId
      tab.actionsEnabled = actionsEnabled
      tab.attention = (row["attention"] as? Int ?? 0) > 0
      tab.activity = HarnessNativeActivity(row["activity"] as? [String: Any])
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
    needsDisplay = true
    needsLayout = true
    layoutSubtreeIfNeeded()
    syncActivityAnimation()
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

  /// Whether the slot may take its space now; tests replace it. By default:
  /// no mouse button is held and the pointer is off this strip, so tabs never
  /// move under a click.
  var daemonMayAppear: (() -> Bool)?
  /// The state that shows the slot, held until [daemonMayAppear] says yes.
  private(set) var pendingDaemon: [String: Any]?
  private var daemonRevealTimer: Timer?

  private func daemonCanAppear() -> Bool {
    if let gate = daemonMayAppear { return gate() }
    guard NSEvent.pressedMouseButtons == 0 else { return false }
    guard let window else { return true }
    return !statusBar.bounds.contains(statusBar.convert(window.mouseLocationOutsideOfEventStream, from: nil))
  }

  private func setDaemonHover(_ hovered: Bool) {
    guard hovered != daemonHovering else { return }
    daemonHovering = hovered
    emit?("daemonHover", ["hovered": hovered])
  }

  /// Try the held state again; the timer stops once it is shown or withdrawn.
  func retryPendingDaemon() {
    guard let pending = pendingDaemon else {
      daemonRevealTimer?.invalidate()
      daemonRevealTimer = nil
      return
    }
    if daemonCanAppear() {
      daemonRevealTimer?.invalidate()
      daemonRevealTimer = nil
      pendingDaemon = nil
      updateDaemon(pending)
    }
  }

  /// The daemon's face, tooltip and voice. A mood or voice change repaints the
  /// slot and the voice line only; layout runs only when the slot appears or goes.
  /// A hidden slot takes no space at all. It appears at the first quiet moment
  /// (see [daemonMayAppear]); until then the bar stays exactly as it was.
  func updateDaemon(_ state: [String: Any]) {
    let wasHidden = daemonButton.isHidden
    let wanted = state["visible"] as? Bool == true
    if wanted && wasHidden && !daemonCanAppear() {
      pendingDaemon = state
      if daemonRevealTimer == nil {
        daemonRevealTimer = Timer.scheduledTimer(withTimeInterval: 0.25, repeats: true) { [weak self] _ in
          self?.retryPendingDaemon()
        }
      }
      return
    }
    pendingDaemon = nil
    daemonRevealTimer?.invalidate()
    daemonRevealTimer = nil
    daemonButton.isHidden = !wanted
    if !wanted || !actionsEnabled { setDaemonHover(false) }
    daemonButton.busy = state["busy"] as? Bool == true
    daemonButton.isEnabled = actionsEnabled && !daemonButton.isHidden && !daemonButton.busy
    daemonButton.state = state["open"] as? Bool == true ? .on : .off
    daemonButton.glyph = validDaemonGlyph(state["glyph"] as? String) ?? ""
    daemonButton.cells = validDaemonText(state["cell"] as? String, cells: daemonButton.columns + 2) ?? ""
    daemonButton.art = wanted ? daemonArt.image(asset: state["art"] as? String, style: state["artStyle"] as? [String: Any]) : nil
    daemonButton.artCenter = daemonArt.center(asset: state["art"] as? String)
    daemonButton.foreground = statusColor(state["foreground"], fallback: terminalForeground)
    daemonButton.patch = state["patch"] is NSNumber ? statusColor(state["patch"], fallback: .black) : nil
    let label = state["label"] as? String ?? "Daemon"
    let detail = state["detail"] as? String ?? ""
    daemonButton.toolTip = state["tooltip"] as? String ?? (detail.isEmpty ? label : label + "\n" + detail)
    daemonButton.setAccessibilityLabel(label)
    daemonButton.setAccessibilityValue("\(daemonButton.state == .on ? "Expanded" : "Collapsed"), \(detail)")
    daemonButton.needsDisplay = true
    let voice = daemonButton.isHidden ? "" : (state["voice"] as? String ?? "")
    voiceLabel.color = statusColor(state["voiceColor"], fallback: .systemYellow)
    voiceLabel.text = voice
    voiceLabel.actions = voice.isEmpty ? [] : (state["voiceActions"] as? [[String: Any]] ?? []).compactMap { row in
      guard let key = row["key"] as? String, let label = row["label"] as? String,
            validDaemonGlyph(key) != nil, !key.isEmpty, key.count <= 2 else { return nil }
      return (key: key, label: String(label.prefix(24)))
    }
    voiceLabel.armed = state["voiceArmed"] as? Bool ?? true
    voiceActive = !voice.isEmpty
    applyStatusVisibility()
    // The slot always keeps 44 points; layout runs only when it appears or goes.
    if wasHidden != daemonButton.isHidden {
      needsLayout = true
      needsDisplay = true
      layoutSubtreeIfNeeded()
    }
  }

  /// While the daemon speaks, its line replaces the status (tmux's message line).
  /// Hidden flags only: frames stay where layout put them.
  private func applyStatusVisibility() {
    voiceLabel.isHidden = !voiceActive
    contextButton.isHidden = voiceActive
    subscriptionUsageButton.isHidden = !hasSubscriptionUsage
    pullRequestButton.isHidden = !hasPullRequest || voiceActive
    voiceLabel.needsDisplay = true
  }

  override func layout() {
    super.layout()
    let active = tabs.first(where: { $0.swarmId == activeId })
    let activeWasVisible = active.map { scroll.documentVisibleRect.intersects($0.frame) } ?? false
    let previousScrollSize = scroll.frame.size
    let previousDocumentSize = document.frame.size
    let cell: CGFloat = 8
    let trailing: CGFloat = 12 // AppDesktop.tabBarTrailingInset.
    let toolHeight: CGFloat = 32
    let capsuleHeight: CGFloat = 28 // AppControl.heightSmall.
    let storeWidth = min(storeButton.preferredWidth,
      max(0, bounds.width - cell * 14))
    storeButton.frame = NSRect(x: bounds.width - trailing - storeWidth,
      y: (bounds.height - capsuleHeight) / 2, width: storeWidth, height: capsuleHeight)
    let iconWidth = cell * 4
    let devicesWidth = devicesButton.isHidden ? 0 : devicesButton.preferredWidth
    devicesButton.frame = NSRect(x: storeButton.frame.minX - devicesWidth - 8,
      y: (bounds.height - capsuleHeight) / 2, width: devicesWidth, height: capsuleHeight)
    let searchEdge = devicesButton.isHidden ? storeButton.frame.minX : devicesButton.frame.minX
    searchButton.frame = NSRect(x: searchEdge - iconWidth - 8,
      y: (bounds.height - toolHeight) / 2, width: iconWidth, height: toolHeight)
    // Only navigation actions share the tab row. Context has the full footer.
    let tabBudget = max(0, searchButton.frame.minX - cell * 6)
    let tabWidth = min(tabBudget, max(SwarmTabButton.minimumLayoutWidth,
      min(SwarmTabButton.maximumLayoutWidth, floor(tabBudget / CGFloat(max(1, tabs.count))))))
    let widths = Array(repeating: tabWidth, count: tabs.count)
    let total = widths.reduce(0, +)
    let occupied = min(total, tabBudget)
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
      width: 32, height: toolHeight)
    if statusBar.superview == nil {
      statusBar.setFrameSize(NSSize(width: bounds.width, height: preferredStatusBarHeight))
    }
    layoutStatusBar()
    let geometryChanged = scroll.frame.size != previousScrollSize || document.frame.size != previousDocumentSize
    if let active, revealActiveAfterLayout || (activeWasVisible && (geometryChanged || tabOrderChanged)) {
      document.scrollToVisible(active.frame)
    }
    revealActiveAfterLayout = false
    tabOrderChanged = false
    syncActivityAnimation()
  }
  private func layoutStatusBar() {
    let cell = ceil(("m" as NSString).size(withAttributes: [.font: barFont]).width)
    // Each adjacent control already supplies one padded character cell.
    let resourceGap = ("m" as NSString).size(withAttributes: [.font: barFont]).width * (resourceGroupGapCells - 2)
    let height = workspaceBarControlHeight(barFont)
    let y = (statusBar.bounds.height - height) / 2
    let available = max(0, statusBar.bounds.width - cell * 2)
    let daemonWidth = daemonButton.isHidden ? 0 : min(daemonButton.preferredWidth, available * 0.5)
    let countsVisible = !machinesButton.isHidden || !modelsButton.isHidden
    let showsUsage = hasSubscriptionUsage && (countsVisible || harnessMonitorButton.isHidden || statusBar.bounds.width >= 1050)
    // The fixed companion slot already has an optical gutter around its art.
    subscriptionUsageButton.trailingContentPadding = daemonWidth > 0 ? 0 : nil
    machineResourcesLabel.trailingContentPadding = daemonWidth > 0 && !showsUsage ? 0 : nil
    let shareWidth = shareButton.isHidden ? 0 : min(shareButton.preferredWidth, available * 0.3)
    let usageBudget = max(0, available - daemonWidth - shareWidth - cell * 4 - resourceGap * 2)
    let inventory = [harnessMonitorButton, machinesButton, modelsButton]
    let countTotal = inventory.filter { !$0.isHidden }.reduce(CGFloat(0)) { $0 + $1.preferredWidth }
    let countScale = min(1, usageBudget * (countsVisible ? 0.8 : 0.4) / max(1, countTotal))
    let monitorWidth = harnessMonitorButton.isHidden ? 0 : harnessMonitorButton.preferredWidth * countScale
    let hardwareBudget = usageBudget * 0.52
    if var resource = machineResourcesState {
      for key in ["segments", "noStorageSegments", "compactSegments", "minimalSegments"] {
        guard let segments = machineResourcesState?[key] else { continue }
        resource["segments"] = segments
        machineResourcesLabel.update(resource, enabled: actionsEnabled)
        if machineResourcesLabel.preferredWidth <= hardwareBudget { break }
      }
    }
    let hardwareWidth = machineResourcesLabel.isHidden ? 0 : min(machineResourcesLabel.preferredWidth, hardwareBudget)
    harnessMonitorButton.frame = NSRect(x: cell, y: y, width: monitorWidth, height: height)
    let machinesWidth = machinesButton.isHidden ? 0 : machinesButton.preferredWidth * countScale
    let modelsWidth = modelsButton.isHidden ? 0 : modelsButton.preferredWidth * countScale
    machinesButton.frame = NSRect(x: harnessMonitorButton.frame.maxX, y: y, width: machinesWidth, height: height)
    modelsButton.frame = NSRect(x: machinesButton.frame.maxX, y: y, width: modelsWidth, height: height)
    let usageWidth = showsUsage
      ? min(subscriptionUsageButton.preferredWidth, countsVisible
          ? max(0, usageBudget - countTotal * countScale)
          : usageBudget * (monitorWidth == 0 ? 0.45 : 0.22)) : 0
    subscriptionUsageButton.isHidden = usageWidth == 0
    machineResourcesLabel.frame = NSRect(x: modelsButton.frame.maxX + (monitorWidth > 0 && hardwareWidth > 0 ? resourceGap : 0),
      y: y, width: hardwareWidth, height: height)
    subscriptionUsageButton.frame = NSRect(x: machineResourcesLabel.frame.maxX + (usageWidth > 0 && (monitorWidth > 0 || hardwareWidth > 0) ? resourceGap : 0),
      y: y, width: usageWidth, height: height)
    let daemonLeft = subscriptionUsageButton.frame.maxX + (daemonWidth > 0 ? resourceGap : (usageWidth > 0 ? cell * 2 : 0))
    daemonButton.frame = NSRect(x: daemonLeft, y: y, width: daemonWidth, height: height)
    let shareLeft = daemonButton.frame.maxX + (daemonWidth > 0 ? cell : 0)
    shareButton.frame = NSRect(x: shareLeft, y: y, width: shareWidth, height: height)
    let contextLeft = shareButton.frame.maxX + (shareWidth > 0 || daemonWidth > 0 ? cell * 2 : 0)
    let statusWidth = max(0, statusBar.bounds.width - cell - contextLeft)
    voiceLabel.frame = NSRect(x: contextLeft, y: y, width: statusWidth, height: height)
    let prWidth = hasPullRequest ? min(pullRequestButton.preferredWidth, statusWidth * 0.3) : 0
    let joined = contextButton.isSegmented && pullRequestButton.isSegmented && prWidth > 0
    let prGap = prWidth > 0 && !joined ? cell : 0
    let contextWidth = min(contextButton.preferredWidth, max(0, statusWidth - prWidth - prGap))
    let contextX = statusBar.bounds.width - cell - prWidth - prGap - contextWidth
    contextButton.frame = NSRect(x: contextX, y: y, width: contextWidth, height: height)
    pullRequestButton.frame = NSRect(x: contextButton.frame.maxX + prGap,
      y: y, width: prWidth, height: height)
    contextButton.nextBackground = joined && pullRequestButton.drawsSegments
      ? pullRequestButton.firstBackground : nil
    // The footer has a different parent from the titlebar. Lay out its field
    // links after allocating their row, including offscreen render fixtures.
    contextButton.layoutSubtreeIfNeeded()
    pullRequestButton.layoutSubtreeIfNeeded()
    subscriptionUsageButton.layoutSubtreeIfNeeded()
    harnessMonitorButton.layoutSubtreeIfNeeded()
    machinesButton.layoutSubtreeIfNeeded()
    modelsButton.layoutSubtreeIfNeeded()
    machineResourcesLabel.layoutSubtreeIfNeeded()
  }
  override func draw(_ dirtyRect: NSRect) {
    // A fine rule joins the active tab's outward shoulders to the workspace.
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
  @objc private func openSubscriptions() {
    guard actionsEnabled, subscriptionUsageButton.isEnabled else { return }
    emit?("subscriptions", nil)
  }
  @objc private func openHarnessMonitor() {
    guard actionsEnabled, harnessMonitorButton.isEnabled else { return }
    emit?("resourceMonitor", nil)
  }
  @objc private func openFooterMachines() {
    guard actionsEnabled, machinesButton.isEnabled else { return }
    emit?("machineControls", nil)
  }
  @objc private func openFooterModels() {
    guard actionsEnabled, modelsButton.isEnabled else { return }
    emit?("runLocalModel", nil)
  }
  @objc private func openDaemon() {
    setDaemonHover(false)
    if actionsEnabled && daemonButton.isEnabled { emit?("daemon", nil) }
  }
  @objc private func openSearch() {
    if actionsEnabled && searchButton.isEnabled { emit?("sessions", nil) }
  }
  @objc private func openStore() {
    if actionsEnabled && storeButton.isEnabled { emit?("store", nil) }
  }

  @objc private func openDevices() {
    if actionsEnabled && devicesButton.isEnabled && !devicesButton.isHidden { emit?("devices", nil) }
  }
  @objc private func openFocusedPullRequest() {
    if actionsEnabled && pullRequestButton.isEnabled, let url = pullRequestButton.actionURL {
      emit?("focusedPullRequest", ["url": url])
    }
  }
  @objc private func shareFocusedAgent() {
    guard actionsEnabled, shareButton.isEnabled,
          let paneId = shareTarget?["paneId"] as? Int,
          let machineId = shareTarget?["machineId"] as? String,
          let agentId = shareTarget?["agentId"] as? String else { return }
    emit?("shareAgent", ["paneId": paneId, "machineId": machineId, "agentId": agentId])
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
  // Mirrors AppDesktop.tabMinWidth/tabMaxWidth. Labels never size the tabs.
  static let minimumLayoutWidth: CGFloat = 128
  static let maximumLayoutWidth: CGFloat = 256
  // Mirrors AppDesktop.tabRadius/tabShoulder in desktop-design-system.md.
  private static let upperRadius: CGFloat = 10
  private static let shoulder: CGFloat = 8
  private static let topInset: CGFloat = 6
  // Mirror AppDesktop.tabCloseInset: keep the 32pt hover target inside the
  // curved tab body, with equal space reserved around the centered title.
  private static let trailingInset: CGFloat = 8
  private static let accessorySide: CGFloat = 32
  private static let contentInset: CGFloat = trailingInset + accessorySide
  private static let gap: CGFloat = 6
  private static let activityWidth: CGFloat = 16

  var palette = SwarmNativePalette() {
    didSet { if palette != oldValue { needsDisplay = true } }
  }
  let swarmId: String
  var name = "New Tab" { didSet { if name != oldValue { invalidateLabel(); updateAccessibility() } } }
  var displayLabel = "New Tab" { didSet { if displayLabel != oldValue { invalidateLabel() } } }
  var shortcutHint: String? { didSet { if shortcutHint != oldValue { invalidateLabel(); updateAccessibility() } } }
  var showsShortcutHint = false {
    didSet { if showsShortcutHint != oldValue { needsLayout = true; needsDisplay = true } }
  }
  var foreground = NSColor(white: 0.85, alpha: 1) {
    didSet {
      if foreground != oldValue { invalidateLabel() }
      closeButton.foreground = foreground
    }
  }
  private var indicatorWidth: CGFloat {
    min(72, max(activityLabel == nil ? 0 : Self.activityWidth, shortcutLayout?.size.width ?? 0))
  }
  private var reservedIndicatorSpace: CGFloat { indicatorWidth == 0 ? 0 : indicatorWidth + Self.gap }
  private var activitySpace: CGFloat {
    (activityMark?.isEmpty ?? true) && !displaysShortcut ? 0 : reservedIndicatorSpace
  }
  private var naturalTitleWidth: CGFloat { max(labelLayout.size.width, emphasizedLabelLayout.size.width) }
  var minimumWidth: CGFloat { Self.contentInset * 2 + reservedIndicatorSpace + 16 }
  var preferredWidth: CGFloat { Self.maximumLayoutWidth }
  var selected = false { didSet { if selected != oldValue { invalidateLabel(); updateAccessibility() } } }
  var attention = false { didSet { if attention != oldValue { invalidateLabel(); updateAccessibility() } } }
  var activity: HarnessNativeActivity? {
    didSet { if activity != oldValue { invalidateLabel(); updateAccessibility() } }
  }
  var activityFrame = 0 {
    didSet { if activityFrame != oldValue, activity?.working == true { setNeedsDisplay(activityRect) } }
  }
  // Keep the old question payload useful for an older Flutter fixture/runner.
  private var activityLabel: String? { activity?.label ?? (attention ? "Needs your input" : nil) }
  private var activityMark: String? {
    if let activity { return activity.symbol(frame: activityFrame) }
    return attention ? "?" : nil
  }
  private var titleRect: NSRect {
    let width = min(naturalTitleWidth, max(0, bounds.width - Self.contentInset * 2 - activitySpace))
    return NSRect(x: (bounds.width - width - activitySpace) / 2, y: 0,
      width: width, height: bounds.height)
  }
  private var indicatorRect: NSRect {
    if bounds.width < minimumWidth {
      let width = min(indicatorWidth, max(0, bounds.width - 16))
      return NSRect(x: bounds.midX - width / 2, y: 0, width: width, height: bounds.height)
    }
    return NSRect(x: titleRect.maxX + Self.gap, y: 0, width: indicatorWidth, height: bounds.height)
  }
  private var activityRect: NSRect {
    if bounds.width < minimumWidth {
      return NSRect(x: bounds.midX - Self.activityWidth / 2, y: 0, width: Self.activityWidth, height: bounds.height)
    }
    return NSRect(x: indicatorRect.midX - Self.activityWidth / 2,
      y: 0, width: Self.activityWidth, height: bounds.height)
  }
  /// The strip holds the keyboard on this tab; Flutter still owns the keys.
  var keyboardFocus = false { didSet { if keyboardFocus != oldValue { needsDisplay = true; updateAccessibility() } } }
  var showsDivider = false { didSet { if showsDivider != oldValue { needsDisplay = true } } }
  var contentCenterY: CGFloat = 20
  var emit: ((String, Any?) -> Void)?
  var hoverChanged: (() -> Void)?
  var isHovered: Bool { hovered && actionsEnabled }
  private let selectButton = SwarmSelectButton()
  private let closeButton = SwarmPlainIconButton()
  /// Whether the middle button went down on THIS tab — see otherMouseUp.
  private var middleDown = false
  /// Tab navigation stays in system UI type, independent of terminal/status preferences.
  var labelFont = NSFont.systemFont(ofSize: 13, weight: .regular) {
    didSet { if oldValue != labelFont { invalidateLabel() } }
  }
  // Animation only changes the activity mark. Keep the three bounded text
  // measurements with their attributed strings until label inputs change;
  // AppKit's size() otherwise repeats text layout throughout each dirty-rect
  // calculation and paint, even while Command hints are not being displayed.
  private struct MeasuredLabel {
    let text: NSAttributedString
    let size: NSSize
    init(_ text: NSAttributedString) {
      self.text = text
      size = text.size()
    }
  }
  private var cachedLabel: MeasuredLabel?
  private var cachedEmphasizedLabel: MeasuredLabel?
  private var cachedShortcutLabel: MeasuredLabel?
  var actionsEnabled = true {
    didSet {
      selectButton.isEnabled = actionsEnabled
      closeButton.isEnabled = actionsEnabled
      updateAccessoryVisibility()
      needsDisplay = true
    }
  }
  private var downPoint = NSPoint.zero
  private var lastSelectionClick: (time: TimeInterval, point: NSPoint)?
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
    closeButton.title = ""
    closeButton.isBordered = false
    closeButton.image = HarnessControlSymbols.image("xmark")
    // Match the small visible cross of the pane's 12pt Lucide close mark.
    closeButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 8, weight: .regular)
    closeButton.restingOpacity = 0.45
    closeButton.highContrastRestingOpacity = 0.7
    closeButton.imagePosition = .imageOnly
    closeButton.foreground = foreground
    closeButton.target = self
    closeButton.action = #selector(closeSwarm)
    closeButton.isHidden = true
    addSubview(closeButton)
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
    closeButton.frame = NSRect(x: max(0, bounds.width - Self.trailingInset - Self.accessorySide),
      y: contentCenterY - Self.accessorySide / 2, width: min(Self.accessorySide, bounds.width), height: Self.accessorySide)
    let fullName = name.trimmingCharacters(in: .whitespacesAndNewlines)
    var hints: [String] = []
    if naturalTitleWidth > titleRect.width { hints.append(displayLabel) }
    if !fullName.isEmpty && fullName != displayLabel { hints.append(name) }
    if let activityLabel { hints.append(activityLabel) }
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
    updateAccessoryVisibility()
    needsDisplay = true
    hoverChanged?()
  }
  private var displaysShortcut: Bool { actionsEnabled && showsShortcutHint && shortcutHint?.isEmpty == false }
  private func updateAccessoryVisibility() {
    closeButton.isHidden = !isHovered
  }
  private func invalidateLabel() {
    cachedLabel = nil
    cachedEmphasizedLabel = nil
    cachedShortcutLabel = nil
    updateAccessoryVisibility()
    needsDisplay = true
    needsLayout = true
  }
  private var label: NSAttributedString { labelLayout.text }
  private var emphasizedLabel: NSAttributedString { emphasizedLabelLayout.text }
  private var shortcutLabel: NSAttributedString? { shortcutLayout?.text }
  private var labelLayout: MeasuredLabel {
    if let cachedLabel { return cachedLabel }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    paragraph.alignment = .center
    let label = MeasuredLabel(NSAttributedString(string: displayLabel,
      attributes: [.font: labelFont,
        .foregroundColor: foreground, .paragraphStyle: paragraph]))
    cachedLabel = label
    return label
  }
  private var emphasizedLabelLayout: MeasuredLabel {
    if let cachedEmphasizedLabel { return cachedEmphasizedLabel }
    let emphasized = NSMutableAttributedString(attributedString: label)
    emphasized.addAttribute(.font, value: NSFont.systemFont(ofSize: labelFont.pointSize, weight: .medium),
      range: NSRange(location: 0, length: emphasized.length))
    let measured = MeasuredLabel(emphasized)
    cachedEmphasizedLabel = measured
    return measured
  }
  private var shortcutLayout: MeasuredLabel? {
    guard let shortcutHint, !shortcutHint.isEmpty else { return nil }
    if let cachedShortcutLabel { return cachedShortcutLabel }
    let paragraph = NSMutableParagraphStyle()
    paragraph.alignment = .center
    paragraph.lineBreakMode = .byTruncatingTail
    let measured = MeasuredLabel(NSAttributedString(string: shortcutHint, attributes: [
      .font: NSFont.systemFont(ofSize: 12, weight: .regular),
      .foregroundColor: foreground.withAlphaComponent(0.75), .paragraphStyle: paragraph]))
    cachedShortcutLabel = measured
    return measured
  }
  private var tabShape: NSBezierPath {
    let path = NSBezierPath()
    let top = max(0, bounds.maxY - Self.topInset)
    let shoulder = min(Self.shoulder, bounds.width / 4, top / 3)
    let radius = min(Self.upperRadius, max(0, bounds.width / 2 - shoulder), max(0, (top - shoulder) / 2))
    let left = bounds.minX + shoulder, right = bounds.maxX - shoulder
    let k: CGFloat = 0.55228475
    path.move(to: NSPoint(x: bounds.minX, y: 0))
    path.curve(to: NSPoint(x: left, y: shoulder),
      controlPoint1: NSPoint(x: bounds.minX + shoulder * k, y: 0),
      controlPoint2: NSPoint(x: left, y: shoulder * (1 - k)))
    path.line(to: NSPoint(x: left, y: top - radius))
    path.curve(to: NSPoint(x: left + radius, y: top),
      controlPoint1: NSPoint(x: left, y: top - radius * (1 - k)),
      controlPoint2: NSPoint(x: left + radius * (1 - k), y: top))
    path.line(to: NSPoint(x: right - radius, y: top))
    path.curve(to: NSPoint(x: right, y: top - radius),
      controlPoint1: NSPoint(x: right - radius * (1 - k), y: top),
      controlPoint2: NSPoint(x: right, y: top - radius * (1 - k)))
    path.line(to: NSPoint(x: right, y: shoulder))
    path.curve(to: NSPoint(x: bounds.maxX, y: 0),
      controlPoint1: NSPoint(x: right, y: shoulder * (1 - k)),
      controlPoint2: NSPoint(x: bounds.maxX - shoulder * k, y: 0))
    path.close()
    return path
  }
  override func draw(_ dirtyRect: NSRect) {
    if selected {
      palette.workspace.setFill()
      tabShape.fill()
    } else if isHovered || (actionsEnabled && selectButton.isHighlighted) {
      foreground.withAlphaComponent(selectButton.isHighlighted ? 0.08 : 0.04).setFill()
      tabShape.fill()
    }
    if showsDivider {
      foreground.withAlphaComponent(0.16).setFill()
      NSRect(x: bounds.maxX - 0.5, y: 10, width: 1, height: max(0, bounds.height - 20)).fill()
    }
    if actionsEnabled && (keyboardFocus || selectButton.hasKeyboardFocus) {
      NSColor.controlAccentColor.setStroke()
      let focus = NSBezierPath(roundedRect: NSRect(x: Self.shoulder + 2, y: 3,
        width: max(0, bounds.width - 2 * (Self.shoulder + 2)), height: max(0, bounds.height - Self.topInset - 6)),
        xRadius: Self.upperRadius - 2, yRadius: Self.upperRadius - 2)
      focus.lineWidth = 1.5
      focus.stroke()
    }
    let text = selected ? emphasizedLabelLayout : labelLayout
    if bounds.width >= minimumWidth {
      text.text.draw(in: NSRect(x: titleRect.minX, y: contentCenterY - text.size.height / 2,
        width: titleRect.width, height: text.size.height))
    }
    if !displaysShortcut, let activityMark {
      NSGraphicsContext.saveGraphicsState()
      bounds.clip()
      HarnessNativeActivity.draw(activityMark,
        in: NSRect(x: activityRect.minX, y: contentCenterY - 8, width: activityRect.width, height: 16),
        color: activity?.color ?? .systemOrange)
      NSGraphicsContext.restoreGraphicsState()
    }
    if displaysShortcut, let shortcut = shortcutLayout {
      shortcut.text.draw(in: NSRect(x: indicatorRect.minX, y: contentCenterY - shortcut.size.height / 2,
        width: indicatorRect.width, height: shortcut.size.height))
    }
  }
  // Overflowed tabs might not be drawn. Their names and selection still need
  // to be available to VoiceOver and automation before they scroll into view.
  private func updateAccessibility() {
    setAccessibilityLabel(name)
    selectButton.setAccessibilityLabel("Select \(name)")
    closeButton.setAccessibilityLabel("Close \(name)")
    closeButton.toolTip = "Close Tab"
    selectButton.setAccessibilityValue(selected ? "Selected" : "")
    let help = [activityLabel,
      keyboardFocus ? "Keyboard is on the tabs. Press Return to type in this tab." : nil].compactMap { $0 }
    selectButton.setAccessibilityHelp(help.isEmpty ? nil : help.joined(separator: ". "))
  }
  func validateMenuItem(_ menuItem: NSMenuItem) -> Bool { actionsEnabled }
  override func mouseDown(with event: NSEvent) {
    guard actionsEnabled else { return }
    downPoint = event.locationInWindow
    let first = lastSelectionClick
    lastSelectionClick = event.clickCount == 1
      ? (event.timestamp, event.locationInWindow) : nil
    // AppKit's click count can span different controls, especially after a
    // close shifts the next tab under the pointer. Rename only when this tab
    // owned the first press as well.
    if event.clickCount == 2, let first,
       event.timestamp - first.time <= NSEvent.doubleClickInterval,
       hypot(event.locationInWindow.x - first.point.x,
             event.locationInWindow.y - first.point.y) <= 4 {
      renameSwarm()
    } else {
      emit?("select", ["id": swarmId])
    }
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
  override func accessibilityChildren() -> [Any]? {
    closeButton.isHidden ? [selectButton] : [selectButton, closeButton]
  }
  @objc private func selectSwarm() { if actionsEnabled { emit?("select", ["id": swarmId]) } }
  @objc private func closeSwarm() { if actionsEnabled { emit?("close", ["id": swarmId]) } }
  @objc private func renameSwarm() { if actionsEnabled { emit?("rename", ["id": swarmId]) } }
}

/// The full tab remains a selection/drag target; the hover close button sits
/// above its trailing slot. Native menu actions and Command-W remain available.
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
