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
  private let historyMenu = NSMenu(title: "History")
  private var historyMenuNeedsRebuild = false
  private var historyMenuIsOpen = false
  private var canGoBack = false
  private var canGoForward = false
  private var history: [SwarmHistoryEntry] = []
  private var closedHistory: [SwarmHistoryEntry] = []
  private let historyIcons = SwarmHistoryIcons()
  private let modelsMenu = NSMenu(title: "Models")
  private var machines: [SwarmMachineEntry] = []
  private var subscriptions: [SwarmSubscriptionEntry] = []
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
      case "sessionsAnchor":
        guard let content = self.window?.contentViewController?.view else { result(nil); return }
        let rect = self.strip.sessionsButton.convert(self.strip.sessionsButton.bounds, to: content)
        result([
          "x": rect.midX,
          "y": content.isFlipped ? rect.midY : content.bounds.height - rect.midY,
          "reduceMotion": NSWorkspace.shared.accessibilityDisplayShouldReduceMotion,
        ])
      case "sessionMinimized":
        self.strip.sessionsButton.receiveSession()
        result(nil)
      case "modelsState":
        let state = call.arguments as? [String: Any] ?? [:]
        self.updateModels(
          state["subscriptions"] as? [[String: Any]] ?? [],
          current: state["currentEngine"] as? String,
          local: state["local"] as? [[String: Any]] ?? [],
          sections: state["sections"] as? [[String: Any]] ?? []
        )
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
    guard ["select", "close", "new", "rename", "commands", "notifications", "store", "sessions", "models", "addAgent", "newAgent", "newTerminal", "cloneAgent", "restartAgent", "movePaneToTab", "runLocalModel", "splitRight", "splitDown", "zoomPane", "pinPane", "machineDestination", "machineAgent", "manageMachines", "machineList"].contains(method) else {
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
    strip.machinesButton.toolTip = "Machines " + (map.hint(for: "machines.list", context: "workspace") ?? "")
    strip.storeButton.toolTip = "Harness Store " + (map.hint(for: "app.store", context: "workspace") ?? "")
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
    guard let main = NSApp.mainMenu, main.item(withTitle: "Models") == nil else { return }
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
      add(edit, "Search Commands…", "p", "commands")
    }
    if let view = main.item(withTitle: "View")?.submenu {
      view.addItem(.separator())
      add(view, "Harnesses Needing Input…", "i", "notifications", [.command, .shift])
      add(view, "Machines", "m", "machineList")
      add(view, "Machine Monitor", "", "manageMachines")
    }
    modelsMenu.autoenablesItems = false
    modelsMenu.delegate = self
    rebuildModelsMenu()
    install(modelsMenu, at: main.items.firstIndex(where: { $0.title == "Window" }) ?? main.numberOfItems)
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
    guard menu === modelsMenu, actionsEnabled else { return }
    // The native menu opens from its cache. Network/credential reads happen
    // asynchronously in Dart and never hold up AppKit's menu tracking.
    channel.invokeMethod("modelsOpened", arguments: nil)
  }

  func menuDidClose(_ menu: NSMenu) {
    if menu === historyMenu { historyMenuIsOpen = false }
  }

  private func updateMachines(_ rows: [[String: Any]]) {
    let entries = rows.prefix(128).compactMap(SwarmMachineEntry.init)
    guard entries != machines else { return }
    machines = entries
    // The Models menu's last row lists these too (see `rebuildModelsMenu`), so it is rebuilt on
    // the same change rather than waiting for the next models push to catch up.
    rebuildModelsMenu()
  }

  /// One heading's worth of the picker: the account's own grid ("Local") or a shared grid, with
  /// the models it is serving. `own` picks the heading word; `name` names a shared grid under the
  /// "Models shared with you" header, or is empty for the account's own grid.
  private struct MenuGridSection {
    let name: String
    let own: Bool
    let models: [(String, String)]  // (model id, node)
  }

  private func updateModels(_ rows: [[String: Any]], current: String?, local: [[String: Any]] = [],
                            sections: [[String: Any]] = []) {
    let entries = rows.prefix(32).compactMap(SwarmSubscriptionEntry.init)
    // What the picker is actually serving RIGHT NOW, read off the machines that answer for it.
    // Placeholder names lived here before and read as real ones — a menu naming a model nobody is
    // serving is worse than a menu admitting it has none.
    func paired(_ models: [[String: Any]]) -> [(String, String)] {
      models.prefix(32).compactMap {
        guard let id = $0["id"] as? String, !id.isEmpty else { return nil }
        return (id, $0["node"] as? String ?? "")
      }
    }
    let parsed: [MenuGridSection]
    if sections.isEmpty {
      // Older Flutter pushes only `local` (the account's own grid). Fall back to one own section.
      let own = paired(local)
      parsed = own.isEmpty ? [] : [MenuGridSection(name: "", own: true, models: own)]
    } else {
      parsed = sections.prefix(16).compactMap { dict -> MenuGridSection? in
        guard let name = dict["name"] as? String,
              let own = dict["own"] as? Bool,
              let models = dict["models"] as? [[String: Any]] else { return nil }
        return MenuGridSection(name: name, own: own, models: paired(models))
      }
    }
    guard entries != subscriptions || current != currentEngine
            || !sectionsEqual(parsed, localSections) else { return }
    subscriptions = entries
    currentEngine = current
    localSections = parsed
    rebuildModelsMenu()
  }

  private func sectionsEqual(_ a: [MenuGridSection], _ b: [MenuGridSection]) -> Bool {
    guard a.count == b.count else { return false }
    for (x, y) in zip(a, b) {
      guard x.name == y.name, x.own == y.own,
            x.models.map({ $0.0 }) == y.models.map({ $0.0 }),
            x.models.map({ $0.1 }) == y.models.map({ $0.1 }) else { return false }
    }
    return true
  }

  /// `(model id, node)` for every model the account's grids are serving, grouped by the grid that
  /// serves it — the sections the picker draws, the account's own first.
  private var localSections: [MenuGridSection] = []

  /// The engine of the pane in focus, when that pane is running on its own subscription — so the
  /// menu can mark WHICH account is being spent. Null while the focused pane is on a Local model,
  /// which is on no subscription at all.
  private var currentEngine: String?

  private func rebuildModelsMenu() {
    modelsMenu.removeAllItems()
    func label(_ title: String, in menu: NSMenu) {
      let item = NSMenuItem(title: title, action: nil, keyEquivalent: "")
      item.isEnabled = false
      menu.addItem(item)
    }
    func section(_ title: String) {
      if #available(macOS 14.0, *) {
        modelsMenu.addItem(NSMenuItem.sectionHeader(title: title))
      } else {
        label(title, in: modelsMenu)
      }
    }
    section("Subscriptions")
    // One width across every section. Measuring them separately let the menu's halves size
    // independently, so the trailing column stepped in or out at each section break.
    let allModels = localSections.flatMap { $0.models }
    let metered = subscriptions.contains { $0.remaining != nil }
    let balanceColumn = SwarmSubscriptionView.balanceColumn(subscriptions)
    let rowWidth = max(
      subscriptions.map { SwarmSubscriptionView.preferredWidth($0, metered: metered) }.max() ?? 352,
      allModels.map { SwarmSubscriptionView.preferredWidth(title: $0.0, account: "", status: $0.1) }.max() ?? 352)
    for entry in subscriptions {
      let item = NSMenuItem(title: entry.accessibilityLabel, action: nil, keyEquivalent: "")
      // The tick marks the subscription the pane in focus is running on. A pane that has been moved
      // to a Local model is on none of them, and then no row is ticked — which is the truth, not a
      // gap: the menu would otherwise claim an account the agent is not spending.
      item.view = SwarmSubscriptionView(entry: entry, width: rowWidth,
        current: entry.engine != nil && entry.engine == currentEngine,
        balanceColumn: balanceColumn)
      item.isEnabled = false
      modelsMenu.addItem(item)
    }
    if subscriptions.isEmpty {
      label("Anthropic", in: modelsMenu)
      label("OpenAI", in: modelsMenu)
    }
    // No API section. `OpenRouter` and `fal.ai` were placeholders with nothing behind them, and a
    // menu naming providers this app cannot reach reads as a list of things you could pick. The
    // section returns when there is a real source for it, not before.
    modelsMenu.addItem(.separator())
    // One section per grid, the account's own first. Its heading names the COMPUTER rather than the
    // feature ("On this Mac"), because that is the fact that distinguishes it from the shared grids
    // under it; a shared grid folds its name into its own heading rather than hanging it on a
    // second line, which read as an entry of the same kind as the models beneath it.
    if localSections.isEmpty {
      section("On this Mac")
    }
    for (index, gridSection) in localSections.enumerated() {
      if index > 0 { modelsMenu.addItem(.separator()) }
      section(gridSection.own ? "On this Mac" : "Shared from \(gridSection.name)")
      for (id, node) in gridSection.models {
        // The same row view as the subscriptions above, so the menu reads as one list: the model id
        // at full strength where a provider's name sits, and the node — which machine answers, the
        // detail that makes a grid legible — in the trailing column the figures use. Local rows
        // were plain disabled `NSMenuItem`s once, which AppKit greys wholesale, so a served model
        // looked unavailable beside the accounts above.
        let item = NSMenuItem(title: [id, node].filter { !$0.isEmpty }.joined(separator: ", "),
          action: nil, keyEquivalent: "")
        item.view = SwarmSubscriptionView(title: id, account: "", status: node,
          icon: nil, width: rowWidth, accessibility: item.title)
        item.isEnabled = false
        modelsMenu.addItem(item)
      }
    }
    modelsMenu.addItem(.separator())
    let run = NSMenuItem(title: "Open Models…", action: #selector(menuAction(_:)), keyEquivalent: "")
    run.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + "models")
    run.target = self
    run.representedObject = "models"
    modelsMenu.addItem(run)
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

private struct SwarmSubscriptionEntry: Equatable {
  let title: String
  let account: String
  let status: String
  let details: [String]
  let engine: String?
  let iconAsset: String?
  /// How much of the tightest window is left, 0…100. Absent whenever the status is not a figure —
  /// "Usage unavailable", "Checking usage…" — so a meter is never drawn for a reading nobody has.
  let remaining: Double?

  init?(_ row: [String: Any]) {
    guard let title = row["title"] as? String, !title.isEmpty,
          let status = row["status"] as? String else { return nil }
    self.title = title
    account = row["account"] as? String ?? ""
    self.status = status
    details = Array((row["details"] as? [String] ?? [status]).prefix(16))
    engine = row["engine"] as? String
    iconAsset = row["iconAsset"] as? String
    remaining = row["remainingPercent"] as? Double
  }

  /// Amber once the tightest window is nearly out, so the bar and the words agree.
  static let lowWater: Double = 20

  var isLow: Bool { (remaining ?? 100) <= Self.lowWater }

  /// The figure, said the way the menu says it. Falls back to whatever sentence the reading had.
  var balance: String { remaining.map { "\(Int($0.rounded(.down)))% left" } ?? status }

  var accessibilityLabel: String {
    [title, account, status].filter { !$0.isEmpty }.joined(separator: ", ")
  }
}



/// Read-only account information, with aligned trailing balances. There is no
/// action or submenu to suggest another step just to read the remaining usage.
/// The quota meter: a track, and however much of it is left.
///
/// Drawn rather than an `NSProgressIndicator`, which carries a bezel and an animation this row has
/// no use for and cannot recolour. Two rounded rects is the whole of it.
private final class SwarmQuotaBar: NSView {
  var fraction: CGFloat = 0 { didSet { needsDisplay = true } }
  var tint: NSColor = .controlAccentColor { didSet { needsDisplay = true } }

  override func draw(_ dirtyRect: NSRect) {
    let radius = bounds.height / 2
    NSColor.tertiaryLabelColor.withAlphaComponent(0.35).setFill()
    NSBezierPath(roundedRect: bounds, xRadius: radius, yRadius: radius).fill()
    guard fraction > 0 else { return }
    // Never thinner than its own height: a sliver narrower than the cap radius draws as a dot
    // that reads as nothing left rather than as nearly nothing left.
    let width = max(bounds.height, bounds.width * min(1, fraction))
    tint.setFill()
    NSBezierPath(roundedRect: NSRect(x: 0, y: 0, width: width, height: bounds.height),
      xRadius: radius, yRadius: radius).fill()
  }
}

private final class SwarmSubscriptionView: NSView {
  private static let rowFont = NSFont.menuFont(ofSize: 0)
  let identity = NSTextField(labelWithString: "")
  let balance = NSTextField(labelWithString: "")
  private let icon = NSImageView()
  private let meter = SwarmQuotaBar()
  private let tick = NSImageView()
  /// The meter's own column, when the row has one. Wide enough to read as a quantity at a glance
  /// and narrow enough to leave the identity its own room.
  private static let meterWidth: CGFloat = 76
  /// The tick's column, RESERVED on every row so a row becoming the current one does not shift
  /// the figure beside it.
  private static let tickWidth: CGFloat = 18

  private static func textWidth(_ text: String) -> CGFloat {
    // Include the native text cell's horizontal drawing insets. Measuring only
    // glyphs or a label already constrained by its frame can clip the status.
    ceil((text as NSString).size(withAttributes: [.font: rowFont]).width) + 8
  }

  static func preferredWidth(_ entry: SwarmSubscriptionEntry) -> CGFloat {
    preferredWidth(title: entry.title, account: entry.account, status: entry.status)
  }

  static func preferredWidth(title: String, account: String, status: String) -> CGFloat {
    let identityWidth = textWidth(title + "  " + account)
    let balanceWidth = textWidth(status)
    return min(576, max(352, identityWidth + balanceWidth + 88))
  }

  static func preferredWidth(_ entry: SwarmSubscriptionEntry, metered: Bool) -> CGFloat {
    let base = preferredWidth(title: entry.title, account: entry.account, status: entry.balance)
    return metered ? min(576, base + meterWidth + 12) : base
  }

  /// The orange a nearly-spent account is written in, legible in both appearances.
  ///
  /// `.systemOrange` is tuned to be *seen*, not to be *read*: on the light menu
  /// it measures 1.86:1 against the panel, where text wants 4.5:1. It is only
  /// right on the dark one, where it reaches 6.44:1. The light side takes the
  /// same hue carried down to #A85400 (4.52:1). Measured with tool/contrast.py.
  static let lowInk = NSColor(name: "harnessLowInk") { appearance in
    appearance.bestMatch(from: [.aqua, .darkAqua]) == .darkAqua
      ? .systemOrange
      : NSColor(srgbRed: 168 / 255, green: 84 / 255, blue: 0, alpha: 1)
  }

  /// What the trailing figures need to share a column — the widest of them.
  static func balanceColumn(_ entries: [SwarmSubscriptionEntry]) -> CGFloat {
    entries.map { textWidth($0.balance) }.max() ?? 0
  }

  convenience init(entry: SwarmSubscriptionEntry, width: CGFloat, current: Bool,
                   balanceColumn: CGFloat) {
    self.init(title: entry.title, account: entry.account.isEmpty ? "" : "···" + entry.account,
      status: entry.balance, icon: nil, width: width,
      accessibility: entry.accessibilityLabel + (current ? ", current" : ""),
      tint: nil, meter: entry.remaining.map { $0 / 100 },
      meterTint: entry.isLow ? Self.lowInk : .controlAccentColor,
      balanceTint: entry.isLow ? Self.lowInk : .secondaryLabelColor,
      showsTick: current, balanceColumn: balanceColumn)
  }

  /// Every row in this menu is built here, subscription or local. Sharing the construction is what
  /// keeps the two sections reading as one menu: same font, same label/secondary split, same icon
  /// column, same right-aligned trailing field. Local rows were plain disabled `NSMenuItem`s before,
  /// which AppKit greys wholesale, so a served model looked unavailable beside the accounts above.
  init(title primary: String, account: String, status: String, icon: NSImage?, width: CGFloat,
       accessibility: String, tint: NSColor? = nil, meter: Double? = nil,
       meterTint: NSColor = .controlAccentColor, balanceTint: NSColor = .secondaryLabelColor,
       showsTick: Bool = false, balanceColumn: CGFloat = 0) {
    super.init(frame: NSRect(x: 0, y: 0, width: width, height: 26))
    autoresizingMask = [.width]
    self.icon.image = icon
    self.icon.imageScaling = .scaleProportionallyDown
    // Brand artwork carries its own colour; an SF Symbol arrives as a template and would paint flat
    // black without this, which reads as a hole in the row on a dark menu.
    self.icon.contentTintColor = tint
    let title = NSMutableAttributedString(string: primary,
      attributes: [.font: Self.rowFont, .foregroundColor: NSColor.labelColor])
    if !account.isEmpty {
      title.append(NSAttributedString(string: "  " + account,
        attributes: [.font: Self.rowFont, .foregroundColor: NSColor.secondaryLabelColor]))
    }
    identity.attributedStringValue = title
    identity.usesSingleLineMode = true
    identity.lineBreakMode = .byTruncatingMiddle
    balance.stringValue = status
    balance.font = Self.rowFont
    balance.textColor = balanceTint
    balance.alignment = .right
    balance.usesSingleLineMode = true
    balance.lineBreakMode = .byClipping
    self.meter.isHidden = meter == nil
    self.meter.fraction = CGFloat(meter ?? 0)
    self.meter.tint = meterTint
    self.hasMeter = meter != nil
    self.balanceColumn = balanceColumn
    tick.image = showsTick
      ? NSImage(systemSymbolName: "checkmark", accessibilityDescription: nil)
      : nil
    tick.contentTintColor = .labelColor
    tick.imageScaling = .scaleProportionallyDown
    for view in [self.icon, identity, balance, self.meter, tick] {
      addSubview(view)
      view.setAccessibilityElement(false)
    }
    setAccessibilityElement(true)
    setAccessibilityRole(.staticText)
    setAccessibilityLabel(accessibility)
    layout()
  }

  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  private var hasMeter = false

  /// The width every row's trailing figure is laid out in, so the meters beside them start at one
  /// x rather than each one floating off the width of its own text.
  ///
  /// Sizing the figure to itself right-aligns the TEXT correctly — every row shares a right edge —
  /// but it moves that column's LEFT edge per row, and the meter hangs off that. `7% left` is
  /// narrower than `78% left`, so one bar began further right than the other and the two read as
  /// different lengths. Zero means "size to my own text", for rows with no meter to align.
  private var balanceColumn: CGFloat = 0

  override func layout() {
    super.layout()
    icon.frame = NSRect(x: 16, y: (bounds.height - 16) / 2, width: 16, height: 16)
    let height = ceil(Self.rowFont.ascender - Self.rowFont.descender + Self.rowFont.leading)
    // The tick's column is reserved whether or not this row draws one — see [tickWidth].
    tick.frame = NSRect(x: bounds.width - 16 - 13, y: (bounds.height - 13) / 2, width: 13, height: 13)
    let balanceWidth = max(balanceColumn, Self.textWidth(balance.stringValue))
    balance.frame = NSRect(x: bounds.width - 16 - Self.tickWidth - balanceWidth,
      y: (bounds.height - height) / 2, width: balanceWidth, height: height)
    if hasMeter {
      meter.frame = NSRect(x: balance.frame.minX - 10 - Self.meterWidth,
        y: (bounds.height - 5) / 2, width: Self.meterWidth, height: 5)
    }
    // No icon column: the rows carry no artwork, so the text starts where a menu's text starts.
    let identityLeft: CGFloat = icon.image == nil ? 16 : 40
    let identityRight = hasMeter ? meter.frame.minX : balance.frame.minX
    identity.frame = NSRect(x: identityLeft, y: balance.frame.minY,
      width: max(0, identityRight - 16 - identityLeft), height: height)
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

/// Match the quiet rounded hover well used by the app's pane controls.
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

/// A quiet filled pill, with the Store's colorful mark as its focal point.
/// Drawing the content keeps the same spacing across AppKit button styles.
private final class SwarmStoreButton: SwarmIconButton {
  var palette = SwarmNativePalette() { didSet { needsDisplay = true } }
  var preferredWidth: CGFloat {
    ceil((title as NSString).size(withAttributes: [
      .font: font ?? SwarmTabStrip.uiFont(weight: .medium),
    ]).width) + 48
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
    image?.draw(in: NSRect(x: 12, y: (bounds.height - 16) / 2, width: 16, height: 16),
      from: .zero, operation: .sourceOver, fraction: isEnabled ? 1 : 0.45,
      respectFlipped: true, hints: [.interpolation: NSImageInterpolation.high])
    let attributes: [NSAttributedString.Key: Any] = [
      .font: font ?? SwarmTabStrip.uiFont(weight: .medium),
      .foregroundColor: palette.accent.withAlphaComponent(isEnabled ? 1 : 0.45),
    ]
    let text = title as NSString
    let height = text.size(withAttributes: attributes).height
    text.draw(at: NSPoint(x: 36, y: (bounds.height - height) / 2), withAttributes: attributes)
  }
}

private class SwarmNoticeButton: SwarmIconButton {
  var onboarding = false { didSet { needsDisplay = true } }
  var attention = 0 { didSet { contentTintColor = iconTint; needsDisplay = true } }
  var expanded = false { didSet { contentTintColor = iconTint; needsDisplay = true } }

  var iconTint: NSColor {
    let bright = isEnabled && (expanded || state == .on || hovered || hasKeyboardFocus || isHighlighted)
    return NSColor(white: attention > 0 ? 0.96 : bright ? 0.84 : 0.60, alpha: 1)
  }

  var attentionLabel: String? {
    attention > 0 ? (attention > 99 ? "99+" : String(attention)) : nil
  }

  func badgeFrame(textWidth: CGFloat) -> NSRect {
    let width = max(12, ceil(textWidth) + 5)
    return NSRect(x: bounds.maxX - width,
      y: isFlipped ? bounds.minY : bounds.maxY - 12, width: width, height: 12)
  }

  override func draw(_ dirtyRect: NSRect) {
    if contentTintColor != iconTint { contentTintColor = iconTint }
    if expanded {
      NSColor.white.withAlphaComponent(0.08).setFill()
      NSBezierPath(roundedRect: bounds.insetBy(dx: 1, dy: 1), xRadius: 7, yRadius: 7).fill()
    }
    super.draw(dirtyRect)
    if let label = attentionLabel {
      let attributes: [NSAttributedString.Key: Any] = [
        .font: NSFont.monospacedDigitSystemFont(ofSize: 9, weight: .semibold),
        .foregroundColor: NSColor.white,
      ]
      let text = label as NSString
      let size = text.size(withAttributes: attributes)
      let badge = badgeFrame(textWidth: size.width)
      NSColor.systemRed.withAlphaComponent(isEnabled ? 1 : 0.45).setFill()
      NSBezierPath(roundedRect: badge, xRadius: 6, yRadius: 6).fill()
      text.draw(at: NSPoint(x: badge.midX - size.width / 2, y: badge.midY - size.height / 2),
        withAttributes: attributes)
    }
    if onboarding {
      // A quiet next-step dot never replaces a red unread count.
      let offset: CGFloat = attention > 0 ? 19 : 3
      let y = isFlipped ? bounds.minY + offset : bounds.maxY - offset - 6
      NSColor(calibratedRed: 0.60, green: 0.76, blue: 0.93,
        alpha: isEnabled ? 1 : 0.45).setFill()
      NSBezierPath(ovalIn: NSRect(x: bounds.maxX - 7, y: y, width: 6, height: 6)).fill()
    }
  }

}

private final class SwarmSessionsButton: SwarmNoticeButton {
  var running = 0 { didSet { needsDisplay = true } }

  func receiveSession() {
    guard !NSWorkspace.shared.accessibilityDisplayShouldReduceMotion else { return }
    wantsLayer = true
    let pulse = CAKeyframeAnimation(keyPath: "transform.scale")
    pulse.values = [1, 1.18, 1]
    pulse.keyTimes = [0, 0.4, 1]
    pulse.duration = 0.24
    layer?.add(pulse, forKey: "session-arrived")
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

private final class SwarmTabStrip: NSView {
  /// The title bar's own face: the system one, at the system size.
  ///
  /// The tabs wore the terminal's face until 2026-09-23. It reads as a terminal
  /// costume on furniture that is not the terminal — no other Mac window names
  /// its tabs in mono — and the workspace's own chrome, a pane header and the
  /// command box, carries that face where it belongs (owner).
  static func uiFont(weight: NSFont.Weight = .regular) -> NSFont {
    NSFont.systemFont(ofSize: NSFont.systemFontSize, weight: weight)
  }

  private(set) var palette = SwarmNativePalette()
  var emit: ((String, Any?) -> Void)?
  private let scroll = SwarmStripScrollView()
  private let document = NSView()
  fileprivate let newButton = SwarmIconButton()
  fileprivate let machinesButton = SwarmNoticeButton()
  fileprivate let storeButton = SwarmStoreButton(title: "Harness Store", target: nil, action: nil)
  fileprivate let modelsButton = SwarmNoticeButton()
  fileprivate let sessionsButton = SwarmSessionsButton()
  private var tabs: [SwarmTabButton] = []
  private let icons = SwarmHistoryIcons()
  private var activeId = ""
  private var revealActiveAfterLayout = false
  private var tabOrderChanged = false
  private var actionsEnabled = false
  private var lastBackgroundClick: (time: TimeInterval, point: NSPoint)?
  // Hold ⌘ and each of the first nine tabs shows the digit that reaches it
  // (⌘1…⌘9, the app's own bindings) — the same discoverability Safari and
  // the terminals give their tabs. Off again the moment ⌘ is released or the
  // app goes to the background.
  private var commandHeld = false
  private var flagsMonitor: Any?
  private var resignObserver: NSObjectProtocol?
  // Dragging is explicit below. AppKit must not also start a titlebar gesture.
  override var mouseDownCanMoveWindow: Bool { false }

  override init(frame: NSRect) {
    super.init(frame: frame)
    wantsLayer = true
    flagsMonitor = NSEvent.addLocalMonitorForEvents(matching: .flagsChanged) { [weak self] event in
      self?.setCommandHeld(event.modifierFlags.contains(.command))
      return event
    }
    resignObserver = NotificationCenter.default.addObserver(
      forName: NSApplication.didResignActiveNotification, object: nil, queue: .main
    ) { [weak self] _ in self?.setCommandHeld(false) }
    scroll.drawsBackground = false
    scroll.hasHorizontalScroller = false
    scroll.hasVerticalScroller = false
    scroll.documentView = document
    addSubview(scroll)
    func button(_ button: NSButton, _ symbol: String, _ label: String, _ action: Selector) {
      button.image = NSImage(systemSymbolName: symbol, accessibilityDescription: label)
      button.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 13, weight: .regular)
      button.isBordered = false
      button.title = ""
      button.imagePosition = .imageOnly
      button.contentTintColor = (button as? SwarmNoticeButton)?.iconTint ?? palette.accent
      button.target = self
      button.action = action
      button.setAccessibilityLabel(label)
      addSubview(button)
    }
    button(newButton, "plus", "New Tab", #selector(newSwarm))
    newButton.setAccessibilityLabel("New Tab")
    newButton.isEnabled = false
    button(machinesButton, "desktopcomputer", "Machines", #selector(openMachines))
    machinesButton.image = icons.image(engine: "machines", asset: "assets/machines.svg", pointSize: 20)
    machinesButton.symbolConfiguration = nil
    machinesButton.isEnabled = false
    machinesButton.toolTip = "Machines ⌘M"
    button(sessionsButton, "terminal", "Harnesses", #selector(openSessions))
    sessionsButton.image = icons.image(engine: "harnesses", asset: "assets/harnesses.svg", pointSize: 20)
    sessionsButton.symbolConfiguration = nil
    sessionsButton.isEnabled = false
    sessionsButton.toolTip = "Harnesses"
    newButton.toolTip = "New Tab ⌘T"
    storeButton.isBordered = false
    storeButton.palette = palette
    storeButton.image = icons.image(engine: "store", asset: "assets/store/polymath.png")
    storeButton.font = SwarmTabStrip.uiFont(weight: .medium)
    storeButton.target = self
    storeButton.action = #selector(openStore)
    storeButton.isEnabled = false
    storeButton.toolTip = "Harness Store ⌘S"
    storeButton.setAccessibilityLabel("Harness Store")
    addSubview(storeButton)
    button(modelsButton, "brain", "Models", #selector(openModels))
    modelsButton.image = icons.image(engine: "models", asset: "assets/models.svg", pointSize: 20)
    modelsButton.symbolConfiguration = nil
    modelsButton.isEnabled = false
    modelsButton.toolTip = "Models"
    setAccessibilityChildren([scroll, newButton, machinesButton, modelsButton, sessionsButton, storeButton])
    registerForDraggedTypes([swarmPasteboardType])
  }
  required init?(coder: NSCoder) { fatalError("init(coder:) has not been implemented") }

  func updatePalette(_ values: [String: Any]) {
    let nextPalette = SwarmNativePalette(values)
    guard nextPalette != palette else { return }
    palette = nextPalette
    newButton.contentTintColor = palette.accent
    storeButton.palette = palette
    for tab in tabs { tab.palette = palette }
    needsDisplay = true
  }


  deinit {
    if let flagsMonitor { NSEvent.removeMonitor(flagsMonitor) }
    if let resignObserver { NotificationCenter.default.removeObserver(resignObserver) }
  }

  private func setCommandHeld(_ held: Bool) {
    guard commandHeld != held else { return }
    commandHeld = held
    applyShortcutBadges()
  }

  fileprivate func applyShortcutBadges() {
    for (index, tab) in tabs.enumerated() {
      tab.shortcut = commandHeld && actionsEnabled && index < 9 ? index + 1 : nil
    }
  }

  func update(_ state: [String: Any]) {
    // Workspace teardown clears its controls without changing appearance.
    if let palette = state["palette"] as? [String: Any] { updatePalette(palette) }
    actionsEnabled = state["enabled"] as? Bool == true
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
      let count = row["agentCount"] as? Int ?? 0
      // The Harness Store tab holds no agents; without its own mark it would wear New Tab's plus.
      let store = row["kind"] as? String == "store"
      tab.icon = store
        ? icons.image(engine: "store", asset: row["iconAsset"] as? String)
        : count == 1
        ? icons.image(engine: row["engine"] as? String, asset: row["iconAsset"] as? String)
        : count > 1
        ? SwarmIdentity.menuIcon
        : NSImage(systemSymbolName: "plus", accessibilityDescription: "New Tab")
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
    applyShortcutBadges()
    // Moving frames alone leaves AppKit's child traversal in insertion order.
    document.setAccessibilityChildren(tabs)
    newButton.isEnabled = actionsEnabled
    machinesButton.isEnabled = actionsEnabled
    machinesButton.state = state["machinesOpen"] as? Bool == true ? .on : .off
    machinesButton.attention = max(0, state["machineNotices"] as? Int ?? 0)
    let machineExpanded = machinesButton.state == .on ? "Expanded" : "Collapsed"
    machinesButton.setAccessibilityValue(machinesButton.attention > 0
      ? "\(machineExpanded), \(machinesButton.attention) new \(machinesButton.attention == 1 ? "computer" : "computers") ready to connect" : machineExpanded)
    storeButton.isEnabled = actionsEnabled
    modelsButton.isEnabled = actionsEnabled
    modelsButton.state = state["modelsOpen"] as? Bool == true ? .on : .off
    modelsButton.attention = max(0, state["modelNotices"] as? Int ?? 0)
    modelsButton.toolTip = "Models"
    let modelExpanded = modelsButton.state == .on ? "Expanded" : "Collapsed"
    modelsButton.setAccessibilityValue(modelsButton.attention > 0
      ? "\(modelExpanded), \(modelsButton.attention) \(modelsButton.attention == 1 ? "model" : "models") ready to use" : modelExpanded)
    sessionsButton.isEnabled = actionsEnabled
    sessionsButton.running = state["runningSessions"] as? Int ?? 0
    sessionsButton.expanded = state["sessionsOpen"] as? Bool == true
    let expandedState = sessionsButton.expanded ? "Expanded" : "Collapsed"
    sessionsButton.toolTip = sessionsButton.running > 0 ? "Harnesses · \(sessionsButton.running) running" : "Harnesses"
    let attention = state["attention"] as? Int ?? 0
    // What the badge COUNTS is `unread` — harnesses carrying news nobody has looked at, which
    // includes the ones that simply finished. `attention` is the narrower "blocked, waiting on a
    // person" figure and still words the sentence below, because that is the half worth saying
    // out loud. An older Flutter sends no `unread`, and then the badge is what it always was.
    let unread = state["unread"] as? Int ?? attention
    sessionsButton.attention = unread
    let attentionState = "\(attention) \(attention == 1 ? "needs" : "need") input"
    let unreadState = "\(unread) \(unread == 1 ? "harness has" : "harnesses have") news you have not seen"
    sessionsButton.setAccessibilityValue(unread > 0 ? "\(expandedState), \(unreadState)" : expandedState)
    if unread > 0 {
      sessionsButton.toolTip = attention > 0
        ? "Harnesses · \(unreadState) · \(attentionState)"
        : "Harnesses · \(unreadState)"
    }
    let onboarding = state["onboarding"] as? String
    for (button, step, action) in [
      (machinesButton as SwarmNoticeButton, "machines", "Use your harnesses from another computer"),
      (modelsButton as SwarmNoticeButton, "models", "Power a harness with local AI"),
      (sessionsButton as SwarmNoticeButton, "harnesses", "Run your first harness"),
    ] {
      button.onboarding = onboarding == step
      if button.onboarding {
        button.setAccessibilityValue("\(button.accessibilityValue() as? String ?? ""), Suggested next step: \(action)")
      }
    }
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
    let leading: CGFloat = 0
    let spacious = bounds.width >= 480
    let trailing: CGFloat = spacious ? 12 : 8
    let storeWidth = storeButton.preferredWidth
    let modelsWidth: CGFloat = 28
    newButton.isHidden = false
    // A reserve after the "+" that tabs never grow into — Chrome's gap. It is
    // where a full strip can still be dragged and double-clicked to zoom
    // (owner, 2026-09-15); tabs shrink and then scroll instead of taking it.
    let grip: CGFloat = spacious ? 84 : 44
    // Reserve three adjacent controls: Machines, Models, Harnesses.
    let available = max(32, bounds.width - leading - trailing - (newButton.isHidden ? 0 : 36) - grip - storeWidth - modelsWidth - 88)
    // As in Chrome, tabs keep shrinking until they are only their mark, so thirty tabs still sit in
    // one strip with nothing hidden; only past that does the strip scroll (the wheel scrolls it).
    let width = min(220, max(min(SwarmTabButton.minimumWidth, available), available / CGFloat(max(1, tabs.count))))
    let occupied = min(available, CGFloat(tabs.count) * width)
    scroll.frame = NSRect(x: leading, y: 0, width: occupied, height: bounds.height)
    document.frame = NSRect(x: 0, y: 0, width: max(occupied, CGFloat(tabs.count) * width), height: bounds.height)
    // Center tab contents on the same row as the traffic lights and toolbar
    // actions; spacing below the strip belongs to the workspace.
    for (index, tab) in tabs.enumerated() {
      tab.frame = NSRect(x: CGFloat(index) * width, y: 0, width: width, height: bounds.height - 2)
      tab.contentCenterY = bounds.midY
    }
    let buttonY = (bounds.height - 28) / 2
    newButton.frame = NSRect(x: leading + occupied + 4, y: buttonY, width: 28, height: 28)
    storeButton.frame = NSRect(x: bounds.width - trailing - storeWidth, y: buttonY, width: storeWidth, height: 28)
    sessionsButton.frame = NSRect(x: storeButton.frame.minX - 36, y: buttonY, width: 28, height: 28)
    modelsButton.frame = NSRect(x: sessionsButton.frame.minX - modelsWidth - 8, y: buttonY, width: modelsWidth, height: 28)
    machinesButton.frame = NSRect(x: modelsButton.frame.minX - 36, y: buttonY, width: 28, height: 28)
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
  @objc private func newSwarm() {
    if actionsEnabled && newButton.isEnabled { emit?("new", nil) }
  }
  @objc private func openStore() {
    if actionsEnabled { emit?("store", nil) }
  }
  @objc private func openMachines() {
    if actionsEnabled { emit?("machineList", nil) }
  }
  @objc private func openSessions() {
    if actionsEnabled { emit?("sessions", nil) }
  }
  @objc private func openModels() {
    if actionsEnabled { emit?("models", nil) }
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
  var selected = false { didSet { if selected != oldValue { invalidateLabel(); updateAccessibility() } } }
  var attention = false { didSet { if attention != oldValue { needsDisplay = true; updateAccessibility() } } }
  var showsDivider = false { didSet { if showsDivider != oldValue { needsDisplay = true } } }
  /// The ⌘-digit that selects this tab, shown while ⌘ is held; nil otherwise.
  var shortcut: Int? { didSet { if shortcut != oldValue { updateCloseVisibility(); needsDisplay = true } } }
  var contentCenterY: CGFloat = 20
  var emit: ((String, Any?) -> Void)?
  var hoverChanged: (() -> Void)?
  var isHovered: Bool { hovered && actionsEnabled }
  private let closeButton = SwarmCloseButton()
  private let selectButton = SwarmSelectButton()
  /// Whether the middle button went down on THIS tab — see otherMouseUp.
  private var middleDown = false
  private let iconView = NSImageView()
  var icon: NSImage? {
    get { iconView.image }
    set { iconView.image = newValue }
  }
  /// A tab is named in the system face, like every other Mac window's tabs —
  /// Safari's, Ghostty's, Finder's. The terminal's face belongs to the terminal
  /// and to the chrome drawn around it inside the window (owner, 2026-09-23).
  var labelFont = SwarmTabStrip.uiFont() {
    didSet { if oldValue != labelFont { invalidateLabel() } }
  }
  /// The ⌘1 badge: monospaced digits, so 1 and 9 take the same room and the
  /// badges down a strip of tabs line up.
  private var badgeFont: NSFont {
    NSFont.monospacedDigitSystemFont(ofSize: 11, weight: .medium)
  }
  private var cachedLabel: NSAttributedString?
  var actionsEnabled = true {
    didSet {
      closeButton.isEnabled = actionsEnabled
      selectButton.isEnabled = actionsEnabled
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
    iconView.imageScaling = .scaleProportionallyDown
    iconView.contentTintColor = NSColor(white: 0.85, alpha: 1)
    iconView.setAccessibilityElement(false)
    addSubview(iconView)
    selectButton.owner = self
    closeButton.owner = self
    selectButton.title = ""
    selectButton.isBordered = false
    selectButton.target = self
    selectButton.action = #selector(selectSwarm)
    addSubview(selectButton)
    closeButton.image = NSImage(systemSymbolName: "xmark", accessibilityDescription: "Close Tab")
    closeButton.symbolConfiguration = NSImage.SymbolConfiguration(pointSize: 10, weight: .semibold)
    closeButton.contentTintColor = NSColor(white: 0.78, alpha: 1)
    closeButton.isBordered = false
    closeButton.target = self
    closeButton.action = #selector(closeSwarm)
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
  /// Narrowest a tab gets before the strip scrolls: its mark alone, like a Chrome tab among dozens.
  static let minimumWidth: CGFloat = 44
  /// Below this a tab shows only its mark: no name, no close button (⌘W and the tab's menu still close it).
  static let compactWidth: CGFloat = 96
  private var compact: Bool { bounds.width < SwarmTabButton.compactWidth }
  override func layout() {
    super.layout()
    let compact = self.compact
    iconView.frame = compact
      ? NSRect(x: ((bounds.width - 16) / 2).rounded(), y: contentCenterY - 8, width: 16, height: 16)
      : NSRect(x: 22, y: contentCenterY - 8, width: 16, height: 16)
    closeButton.isHidden = compact
    selectButton.frame = NSRect(x: 0, y: 0, width: max(0, compact ? bounds.width : bounds.width - 36), height: bounds.height)
    closeButton.frame = NSRect(x: bounds.width - 36, y: contentCenterY - 12, width: 24, height: 24)
    toolTip = compact ? name : nil
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
    updateCloseVisibility()
    needsDisplay = true
    hoverChanged?()
  }
  fileprivate func updateCloseVisibility() {
    // The badge borrows the close glyph's slot; while ⌘ is held the digit wins.
    closeButton.showsGlyph = shortcut == nil
      && (hovered || selectButton.hasKeyboardFocus || closeButton.hasKeyboardFocus)
  }
  private func invalidateLabel() {
    cachedLabel = nil
    needsDisplay = true
  }
  private var label: NSAttributedString {
    if let cachedLabel { return cachedLabel }
    let paragraph = NSMutableParagraphStyle()
    paragraph.lineBreakMode = .byTruncatingTail
    let label = NSAttributedString(string: name,
      attributes: [.font: selected ? NSFontManager.shared.convert(labelFont, toHaveTrait: .boldFontMask) : labelFont,
        .foregroundColor: selected ? NSColor.white : NSColor(white: 0.76, alpha: 1), .paragraphStyle: paragraph])
    cachedLabel = label
    return label
  }
  override func draw(_ dirtyRect: NSRect) {
    if selected {
      palette.workspace.setFill()
      // Match TerminalTabBorder: small top corners and outward bottom joins,
      // all at the same radius. AppKit's origin is at the bottom left.
      let r = min(CGFloat(3), min(bounds.width, bounds.height) / 4)
      let c = r * 0.5522847498
      let left = bounds.minX + r, right = bounds.maxX - r
      let top = bounds.maxY, bottom = bounds.minY
      let path = NSBezierPath()
      path.move(to: NSPoint(x: bounds.minX, y: bottom))
      path.curve(to: NSPoint(x: left, y: bottom + r),
        controlPoint1: NSPoint(x: bounds.minX + c, y: bottom),
        controlPoint2: NSPoint(x: left, y: bottom + r - c))
      path.line(to: NSPoint(x: left, y: top - r))
      path.curve(to: NSPoint(x: left + r, y: top),
        controlPoint1: NSPoint(x: left, y: top - r + c),
        controlPoint2: NSPoint(x: left + r - c, y: top))
      path.line(to: NSPoint(x: right - r, y: top))
      path.curve(to: NSPoint(x: right, y: top - r),
        controlPoint1: NSPoint(x: right - r + c, y: top),
        controlPoint2: NSPoint(x: right, y: top - r + c))
      path.line(to: NSPoint(x: right, y: bottom + r))
      path.curve(to: NSPoint(x: bounds.maxX, y: bottom),
        controlPoint1: NSPoint(x: right, y: bottom + r - c),
        controlPoint2: NSPoint(x: bounds.maxX - c, y: bottom))
      path.close()
      path.fill()
    } else if hovered && actionsEnabled {
      NSColor(white: 1, alpha: 0.05).setFill()
      let hoverRect = NSRect(x: 8, y: contentCenterY - 13, width: bounds.width - 16, height: 26)
      NSBezierPath(roundedRect: hoverRect, xRadius: 3, yRadius: 3).fill()
    }
    if showsDivider && !hovered {
      NSColor(white: 1, alpha: 0.16).setFill()
      NSBezierPath(roundedRect: NSRect(x: bounds.width - 0.5, y: contentCenterY - 8, width: 1, height: 16),
        xRadius: 0.5, yRadius: 0.5).fill()
    }
    let compact = self.compact
    if !compact {
      let label = self.label
      let labelHeight = label.size().height
      let trailing = shortcut.map { value in
        max(42, ceil(("⌘\(value)" as NSString).size(withAttributes: [.font: badgeFont]).width) + 22)
      } ?? 42
      label.draw(in: NSRect(x: 46, y: contentCenterY - labelHeight / 2,
        width: max(0, bounds.width - 46 - trailing), height: labelHeight))
    }
    if attention {
      NSColor.systemOrange.setFill()
      let dot = compact
        ? NSRect(x: iconView.frame.maxX - 1, y: iconView.frame.maxY - 3, width: 5, height: 5)
        : NSRect(x: 13, y: contentCenterY - 2, width: 4, height: 4)
      NSBezierPath(ovalIn: dot).fill()
    }
    if let shortcut, !compact {
      let paragraph = NSMutableParagraphStyle()
      paragraph.alignment = .right
      let badge = NSAttributedString(string: "⌘\(shortcut)",
        attributes: [.font: badgeFont,
          .foregroundColor: NSColor(white: 1, alpha: selected ? 0.7 : 0.5), .paragraphStyle: paragraph])
      let badgeHeight = badge.size().height
      let badgeWidth = max(32, ceil(badge.size().width))
      badge.draw(in: NSRect(x: bounds.width - 14 - badgeWidth, y: contentCenterY - badgeHeight / 2, width: badgeWidth, height: badgeHeight))
    }
  }
  // Overflowed tabs might not be drawn. Their names and selection still need
  // to be available to VoiceOver and automation before they scroll into view.
  private func updateAccessibility() {
    setAccessibilityLabel(name)
    selectButton.setAccessibilityLabel("Select \(name)")
    selectButton.setAccessibilityValue(selected ? "Selected" : "")
    selectButton.setAccessibilityHelp(attention ? "Contains agents needing input" : nil)
    closeButton.setAccessibilityLabel("Close \(name)")
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
  override func accessibilityChildren() -> [Any]? { [selectButton, closeButton] }
  @objc private func selectSwarm() { if actionsEnabled { emit?("select", ["id": swarmId]) } }
  @objc private func closeSwarm() { if actionsEnabled { emit?("close", ["id": swarmId]) } }
  @objc private func renameSwarm() { if actionsEnabled { emit?("rename", ["id": swarmId]) } }
}

/// Selection and closing are sibling accessibility buttons, so VoiceOver and
/// UI automation can reach the close action without treating the tab as a leaf.
private class SwarmTabActionButton: SwarmIconButton {
  weak var owner: SwarmTabButton?
  override var showsHoverFill: Bool { false }
  override func becomeFirstResponder() -> Bool {
    guard super.becomeFirstResponder() else { return false }
    owner?.updateCloseVisibility()
    if let owner { owner.scrollToVisible(owner.bounds) }
    return true
  }
  override func resignFirstResponder() -> Bool {
    guard super.resignFirstResponder() else { return false }
    owner?.updateCloseVisibility()
    return true
  }
}

/// Keep the close action reachable by keyboard and VoiceOver while its glyph
/// rests quietly. Reserving its space avoids shifting labels on hover.
private final class SwarmCloseButton: SwarmTabActionButton {
  override var showsHoverFill: Bool { true }
  var showsGlyph = false { didSet { if showsGlyph != oldValue { needsDisplay = true } } }
  override func draw(_ dirtyRect: NSRect) {
    if showsGlyph { super.draw(dirtyRect) }
  }
}

private final class SwarmSelectButton: SwarmTabActionButton {
  override func mouseDown(with event: NSEvent) {
    guard isEnabled else { return }
    owner?.mouseDown(with: event)
  }
  override func mouseUp(with event: NSEvent) {}
  override func mouseDragged(with event: NSEvent) {
    guard isEnabled else { return }
    owner?.mouseDragged(with: event)
  }
}
