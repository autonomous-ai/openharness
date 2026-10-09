import Cocoa
import FlutterMacOS

/// Channel the app menu talks to Dart over.
///
/// One-way: AppKit reports that a menu item fired, Dart decides what that
/// means. Nothing about updating lives on this side.
private let kMenuChannel = "harness/app_menu"

/// Channel Dart calls INTO this side over, to read a native image off the general pasteboard.
/// Flutter's own `Clipboard` API only ever sees `text/plain` — see `terminal_panel.dart`'s
/// `_paste()` — so a real image (a screenshot, "Copy Image" from a browser, ...) needs this native
/// round trip instead. The other direction of `harness/clipboard_image` (Dart calling Swift) rather
/// than `harness/app_menu`'s (Swift calling Dart). It also answers for the FILES a pasteboard
/// holds (`readFilePaths`), which Flutter's `Clipboard` cannot see either.
private let kClipboardImageChannel = "harness/clipboard_image"

/// Channel Dart asks for the font families installed on this Mac, for the terminal font picker
/// (`lib/terminal/installed_fonts.dart`). `NSFontManager` answers in a fraction of a second where
/// `system_profiler SPFontsDataType` takes ~10s, and it can say which families are monospaced.
private let kFontsChannel = "harness/fonts"

class MainFlutterWindow: NSWindow {
  private var swarmTitlebar: SwarmTitlebar?
  private var menuChannel: FlutterMethodChannel?
  private var clipboardImageChannel: FlutterMethodChannel?
  private var fontsChannel: FlutterMethodChannel?
  private var notifications: HarnessNotifications?

  override func awakeFromNib() {
    // Before the engine exists, so a move never interrupts the first-run setup.
    MoveToApplications.offerIfNeeded()
    // Before the engine exists: its first frame already draws from the
    // back-buffer cache this patches (flutter/flutter#185394).
    SurfaceCacheGuard.install()
    let flutterViewController = FlutterViewController()
    let windowFrame = self.frame
    self.contentViewController = flutterViewController
    self.setFrame(windowFrame, display: true)

    RegisterGeneratedPlugins(registry: flutterViewController)
    AppDelegate.installCommunityLinks(messenger: flutterViewController.engine.binaryMessenger)

    menuChannel = FlutterMethodChannel(
      name: kMenuChannel,
      binaryMessenger: flutterViewController.engine.binaryMessenger
    )
    swarmTitlebar = SwarmTitlebar(window: self, messenger: flutterViewController.engine.binaryMessenger)
    installClipboardImageChannel(messenger: flutterViewController.engine.binaryMessenger)
    installFontsChannel(messenger: flutterViewController.engine.binaryMessenger)
    notifications = HarnessNotifications(messenger: flutterViewController.engine.binaryMessenger)

    // Flutter's own theme does not reach AppKit — every native surface (the
    // standard About panel, the menu bar, the window's title bar and its
    // traffic lights, any AppKit sheet) follows `NSApp.appearance`, not
    // `MaterialApp.theme`. Dark until Dart's first palette arrives (the saved
    // one, sent before the first frame); `SwarmTabStrip.updatePalette` then
    // follows the palette's own brightness rather than the Mac's setting.
    NSApp.appearance = NSAppearance(named: .darkAqua)

    installAppMenuItems()
    installViewMenuItems()
    installHelpMenuItems()
    takeOverAboutItem()
    HarnessAppMenu.arrange()

    super.awakeFromNib()
  }

  /// Show "Version 1.0.4" in the About box instead of "Version 1.0.4 (10004)".
  ///
  /// The build number is a release-pipeline artefact — upload-desktop.sh derives
  /// an integer from the version because `flutter build --build-number` demands
  /// one — and it means nothing to the person reading it, nor to this app, which
  /// compares releases by CFBundleShortVersionString everywhere else.
  ///
  /// Making the two Info.plist keys AGREE does not do it: the panel then reads
  /// "Version 1.0.4 (1.0.4)". AppKit's own header is explicit about the way out
  /// — NSAboutPanelOptionVersion is the BUILD half, "if not specified or empty
  /// string, leave blank" — so the fix is to open the standard panel ourselves
  /// with that half blanked, and leave Info.plist alone.
  ///
  /// The item is retargeted rather than replaced, so it keeps its place, its
  /// title and its localisation from the nib.
  private func takeOverAboutItem() {
    guard let appMenu = NSApp.mainMenu?.item(at: 0)?.submenu else { return }
    // Matched by selector NAME rather than `#selector(...)`. AppKit declares
    // several `orderFrontStandardAboutPanel` overloads, so the literal form is
    // ambiguous enough that the compiler offers a fix-it for a DIFFERENT method
    // — and a mismatch here fails silently: the guard falls through, the item
    // keeps its stock action, and the About box quietly keeps its parenthesis.
    guard let about = appMenu.items.first(where: {
      $0.action.map(NSStringFromSelector) == "orderFrontStandardAboutPanel:"
    }) else { return }
    about.target = self
    about.action = #selector(showAbout(_:))
  }

  @objc private func showAbout(_ sender: Any?) {
    NSApp.orderFrontStandardAboutPanel(options: [.version: ""])
  }

  /// Puts Check for Updates… in the application menu; [HarnessAppMenu.arrange]
  /// gives it its place. Keyboard Shortcuts… and Flash Firmware… live in Help.
  ///
  /// Added here rather than in MainMenu.xib so the whole menu bar keeps coming
  /// from the nib — declaring it in Dart with PlatformMenuBar would replace the
  /// bar wholesale, taking Edit and Window with it, and with them the standard
  /// Cut/Copy/Paste shortcuts a terminal window needs.
  private func installAppMenuItems() {
    guard let appMenu = NSApp.mainMenu?.item(at: 0)?.submenu else { return }
    // awakeFromNib can run more than once if the nib is reloaded; a second
    // pass must not stack duplicate rows onto the menu.
    guard appMenu.indexOfItem(withTag: updateMenuItemTag) == -1 else { return }
    appMenu.insertItem(
      menuItem(
        title: "Check for Updates…",
        action: #selector(checkForUpdates(_:)),
        symbol: "arrow.triangle.2.circlepath",
        tag: updateMenuItemTag
      ),
      at: insertionIndex(in: appMenu)
    )
  }

  /// Help: learning Harness first — the Welcome Tour (the first-run slides,
  /// again), Quick Start, Keyboard Practice, and the shortcut sheet — then
  /// the two things support asks for.
  ///
  /// Keyboard Shortcuts… ⌘/ sits where people look for it in every Mac app,
  /// and AppKit prints ⌘/ beside it, which is how people learn the chord.
  /// Export Logs… is the bug-report zip, from a menu every build has (Settings
  /// ▸ Debug carries the same action but is hidden in a shipped app, and the
  /// person whose dial got stuck is running a shipped app). Flash Firmware…
  /// is that dial's, and is here for the same reason.
  private func installHelpMenuItems() {
    guard let helpMenu = NSApp.mainMenu?.item(withTitle: "Help")?.submenu else { return }
    guard helpMenu.indexOfItem(withTag: exportLogsMenuItemTag) == -1 else { return }
    let items: [NSMenuItem] = [
      menuItem(title: "Welcome Tour", action: #selector(welcomeTour(_:)), symbol: "sparkles", tag: welcomeTourMenuItemTag),
      menuItem(title: "Quick Start", action: #selector(quickStart(_:)), symbol: "terminal", tag: 7310),
      menuItem(title: "Keyboard Practice", action: #selector(keyboardPractice(_:)), symbol: "keyboard", tag: 7311),
      menuItem(
        title: "Keyboard Shortcuts…",
        action: #selector(showShortcuts(_:)),
        symbol: "command",
        tag: shortcutsMenuItemTag,
        keyEquivalent: "/"
      ),
      NSMenuItem.separator(),
      menuItem(title: "Export Logs…", action: #selector(exportLogs(_:)), symbol: "doc.zipper", tag: exportLogsMenuItemTag),
      menuItem(title: "Flash Firmware…", action: #selector(flashFirmware(_:)), symbol: "bolt.circle", tag: flashMenuItemTag),
      NSMenuItem.separator(),
    ]
    for (index, item) in items.enumerated() { helpMenu.insertItem(item, at: index) }
  }

  /// The Safari/Chrome/Terminal.app "Font" convention, in the SAME menu and the SAME order those
  /// apps use it in — this is deliberately a NATIVE menu, not a row in Dart's own ⌘/ sheet: AppKit
  /// already owns "View" in the menu bar, already prints the key equivalent beside each item, and
  /// a native key equivalent is handled by the responder chain before Flutter's own keyboard
  /// handling ever sees the event — a Dart-side `CallbackShortcuts` binding on the same chord would
  /// never fire once this exists, so there is exactly one implementation, not two.
  private func installViewMenuItems() {
    guard let viewMenu = NSApp.mainMenu?.item(withTitle: "View")?.submenu else { return }
    guard viewMenu.indexOfItem(withTag: layoutMenuItemTag) == -1 else { return }

    // Terminal.app's own View menu keeps its font-size trio well above Enter Full Screen, in its
    // own bracketed section. The nib's "Enter Full Screen" must stay LAST — appending after it
    // (the previous approach) put this section in the wrong place relative to that convention, so
    // this inserts before it instead. Matched by ACTION alone (not `indexOfItem(withTarget:
    // andAction:)`, which requires an EXACT target match — the nib wires this to Interface
    // Builder's First Responder placeholder, which does not reliably read back as a literal `nil`
    // target here) — same reason insertionIndex(in:) below matches by action too: a first-responder
    // action survives menu-bar localization, a hardcoded index does not.
    //
    // No leading separator is added here: AppKit's own automatic window-tabbing injection
    // ("Show Tab Bar"/"Show All Tabs", enabled by default and not opted out of anywhere in this
    // project) always leaves its own separator directly above "Enter Full Screen" — but it runs on
    // its own schedule, at some point AFTER this method (observed empirically: a second, adjacent
    // separator added here shows up doubled, because this method's own insertion point is computed
    // before that injection happens). Matching Terminal.app's spacing this way, by omission, is more
    // reliable than trying to race or detect AppKit's exact timing.
    let fullScreenIndex = viewMenu.items.firstIndex {
      $0.action == #selector(NSWindow.toggleFullScreen(_:))
    }
    var at = fullScreenIndex ?? viewMenu.numberOfItems

    // The grid's shape, and the only way to it with a mouse. It was reachable
    // by ⌘L alone at first, which is the same mistake the shortcut sheet's own
    // comment describes above: a command nobody can see is a command nobody
    // uses — and worse here, the native terminal holds the keyboard, so the
    // Dart-side binding does not even fire while a pane has focus. As a native
    // key equivalent it is handled by the responder chain first, so it works
    // wherever the focus happens to be.
    //
    // Cmd-Shift-L matches the workspace keymap; Cmd-S opens the Store.
    viewMenu.insertItem(
      menuItem(
        title: "Layout…",
        action: #selector(showLayout(_:)),
        symbol: "square.grid.2x2",
        tag: layoutMenuItemTag,
        keyEquivalent: "l"
      ),
      at: at
    )
    at += 1
    viewMenu.insertItem(NSMenuItem.separator(), at: at)
    at += 1
    viewMenu.insertItem(
      menuItem(
        title: "Default Font Size",
        action: #selector(resetTerminalFontSize(_:)),
        symbol: "textformat.size",
        tag: resetFontMenuItemTag,
        keyEquivalent: "0"
      ),
      at: at
    )
    at += 1
    viewMenu.insertItem(
      menuItem(
        title: "Bigger",
        action: #selector(increaseTerminalFontSize(_:)),
        symbol: "character",
        tag: biggerFontMenuItemTag,
        // "+" (not "=") is the literal string AppKit's own zoom-style menus use — it renders as ⌘+
        // and, since the default keyEquivalentModifierMask has no .shift in it, still fires on the
        // plain, easy-to-reach ⌘= keypress, matching Safari/Chrome/Terminal.app exactly.
        keyEquivalent: "+"
      ),
      at: at
    )
    at += 1
    viewMenu.insertItem(
      menuItem(
        title: "Smaller",
        action: #selector(decreaseTerminalFontSize(_:)),
        symbol: "character",
        tag: smallerFontMenuItemTag,
        keyEquivalent: "-"
      ),
      at: at
    )
    at += 1
    viewMenu.insertItem(NSMenuItem.separator(), at: at)
  }

  private func menuItem(
    title: String,
    action: Selector,
    symbol: String,
    tag: Int,
    keyEquivalent: String = ""
  ) -> NSMenuItem {
    let item = NSMenuItem(
      title: title,
      action: action,
      keyEquivalent: keyEquivalent
    )
    item.target = self
    item.tag = tag
    if tag == layoutMenuItemTag { item.keyEquivalentModifierMask = [.command, .shift] }
    let keymapActions = [shortcutsMenuItemTag: "showShortcuts", layoutMenuItemTag: "layout",
      7310: "quickStart", 7311: "keyboardPractice"]
    if let command = keymapActions[tag] {
      item.identifier = NSUserInterfaceItemIdentifier(HarnessKeymapMenu.actionPrefix + command)
    }
    // Every other row in this menu carries a glyph, so one without reads as
    // unfinished — the gutter stays but nothing sits in it.
    item.image = HarnessControlSymbols.image(symbol, description: title)
    return item
  }

  /// Just below Show All.
  ///
  /// Located by ACTION, not by title: the titles in this menu are localised by
  /// AppKit, so "Show All" only matches while the user runs an English system.
  private func insertionIndex(in appMenu: NSMenu) -> Int {
    let showAll = appMenu.indexOfItem(
      withTarget: nil,
      andAction: #selector(NSApplication.unhideAllApplications(_:))
    )
    if showAll >= 0 { return showAll + 1 }
    let byTitle = appMenu.indexOfItem(withTitle: "Show All")
    if byTitle >= 0 { return byTitle + 1 }
    // Nothing recognisable to anchor to — sit above Quit rather than vanish.
    return max(appMenu.numberOfItems - 1, 0)
  }

  private var updateMenuItemTag: Int { 7301 }
  private var flashMenuItemTag: Int { 7302 }
  private var shortcutsMenuItemTag: Int { 7303 }
  private var resetFontMenuItemTag: Int { 7304 }
  private var biggerFontMenuItemTag: Int { 7305 }
  private var smallerFontMenuItemTag: Int { 7306 }
  private var layoutMenuItemTag: Int { 7307 }
  private var exportLogsMenuItemTag: Int { 7308 }
  private var welcomeTourMenuItemTag: Int { 7309 }

  @objc private func checkForUpdates(_ sender: Any?) {
    menuChannel?.invokeMethod("checkForUpdates", arguments: nil)
  }

  @objc private func flashFirmware(_ sender: Any?) {
    menuChannel?.invokeMethod("flashFirmware", arguments: nil)
  }

  @objc private func exportLogs(_ sender: Any?) {
    menuChannel?.invokeMethod("exportLogs", arguments: nil)
  }

  @objc private func showLayout(_ sender: Any?) {
    menuChannel?.invokeMethod("showLayout", arguments: nil)
  }

  @objc private func showShortcuts(_ sender: Any?) {
    menuChannel?.invokeMethod("showShortcuts", arguments: nil)
  }

  @objc private func welcomeTour(_ sender: Any?) {
    menuChannel?.invokeMethod("welcomeTour", arguments: nil)
  }

  @objc private func quickStart(_ sender: Any?) {
    swarmTitlebar?.startQuickStart()
  }

  @objc private func keyboardPractice(_ sender: Any?) {
    menuChannel?.invokeMethod("keyboardPractice", arguments: nil)
  }

  @objc private func increaseTerminalFontSize(_ sender: Any?) {
    menuChannel?.invokeMethod("increaseTerminalFontSize", arguments: nil)
  }

  @objc private func decreaseTerminalFontSize(_ sender: Any?) {
    menuChannel?.invokeMethod("decreaseTerminalFontSize", arguments: nil)
  }

  @objc private func resetTerminalFontSize(_ sender: Any?) {
    menuChannel?.invokeMethod("resetTerminalFontSize", arguments: nil)
  }

  private func installFontsChannel(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: kFontsChannel, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "listFonts" else {
        result(FlutterMethodNotImplemented)
        return
      }
      DispatchQueue.global(qos: .userInitiated).async {
        let fonts = MainFlutterWindow.installedFontFamilies()
        DispatchQueue.main.async { result(fonts) }
      }
    }
    fontsChannel = channel
  }

  /// Every installed family as `{family, mono}`, hidden system families (a leading `.`) left out.
  ///
  /// CoreText, not `NSFontManager`: this runs off the main thread so a large font catalog never
  /// stalls the window, and AppKit's font manager is not documented safe there; CoreText is.
  private static func installedFontFamilies() -> [[String: Any]] {
    guard let names = CTFontManagerCopyAvailableFontFamilyNames() as? [String] else { return [] }
    var fonts: [[String: Any]] = []
    for family in names where !family.hasPrefix(".") {
      let descriptor = CTFontDescriptorCreateWithAttributes(
        [kCTFontFamilyNameAttribute: family] as CFDictionary)
      let font = CTFontCreateWithFontDescriptor(descriptor, 12, nil)
      fonts.append(["family": family, "mono": isMonospaced(font)])
    }
    return fonts
  }

  /// The font's own monospace trait, OR equal advances for `i`, `W` and `m` — some monospaced
  /// families (Nerd Fonts among them) do not set the trait. A symbol font (Wingdings and the like)
  /// is never monospaced here, whatever its advances: its letters are pictures.
  private static func isMonospaced(_ font: CTFont) -> Bool {
    let traits = CTFontGetSymbolicTraits(font)
    let fontClass = CTFontStylisticClass(
      rawValue: traits.rawValue & CTFontSymbolicTraits.traitClassMask.rawValue)
    if fontClass == .classSymbolic { return false }
    if traits.contains(.traitMonoSpace) { return true }
    var characters = Array("iWm".utf16)
    var glyphs = [CGGlyph](repeating: 0, count: characters.count)
    guard CTFontGetGlyphsForCharacters(font, &characters, &glyphs, characters.count),
      !glyphs.contains(0)
    else { return false }
    var advances = [CGSize](repeating: .zero, count: glyphs.count)
    CTFontGetAdvancesForGlyphs(font, .horizontal, glyphs, &advances, glyphs.count)
    guard let first = advances.first?.width, first > 0 else { return false }
    return advances.allSatisfy { abs($0.width - first) < 0.01 }
  }

  private func installClipboardImageChannel(messenger: FlutterBinaryMessenger) {
    let channel = FlutterMethodChannel(name: kClipboardImageChannel, binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "readImagePng":
        result(MainFlutterWindow.readClipboardImagePng())
      case "writeImagePng":
        guard let bytes = (call.arguments as? FlutterStandardTypedData)?.data else {
          result(FlutterError(code: "INVALID_ARGUMENT", message: "expected PNG bytes", details: nil))
          return
        }
        result(MainFlutterWindow.writeClipboardImagePng(bytes))
      case "readFilePaths":
        result(MainFlutterWindow.readClipboardFilePaths())
      default:
        result(FlutterMethodNotImplemented)
      }
    }
    clipboardImageChannel = channel
  }

  /// Reads the general pasteboard for image data, returned as PNG bytes — or `nil` when the
  /// clipboard holds no image (the normal case for a plain-text paste, which the caller is
  /// expected to fall back to). Prefers an existing PNG representation; falls back to TIFF (what
  /// "Copy Image" from Safari, Preview, and many other apps actually put on the pasteboard),
  /// re-encoded to PNG since the terminal wire protocol only carries one image format.
  private static func readClipboardImagePng() -> FlutterStandardTypedData? {
    let pasteboard = NSPasteboard.general
    if let pngData = pasteboard.data(forType: .png) {
      return FlutterStandardTypedData(bytes: pngData)
    }
    guard let tiffData = pasteboard.data(forType: .tiff),
      let bitmap = NSBitmapImageRep(data: tiffData),
      let pngData = bitmap.representation(using: .png, properties: [:])
    else {
      return nil
    }
    return FlutterStandardTypedData(bytes: pngData)
  }

  /// Writes PNG bytes onto the general pasteboard, replacing whatever was there — the LOCAL half
  /// of native image drag-drop (`_dropImage` in pane_grid.dart): when the pane's machine is this
  /// same computer, the app puts the dropped image on ITS OWN clipboard directly instead of
  /// sending it over the terminal wire, then forwards a Ctrl+V so the engine reads it exactly as
  /// it already does for an ordinary local clipboard paste.
  private static func writeClipboardImagePng(_ data: Data) -> Bool {
    let pasteboard = NSPasteboard.general
    pasteboard.clearContents()
    return pasteboard.setData(data, forType: .png)
  }

  /// The files the general pasteboard holds, as paths in the order they were copied — what
  /// Finder's Copy puts there. Empty when the clipboard holds none. Beside them Finder also
  /// leaves each file's NAME as text and its ICON as an image, so a caller that wants the files
  /// has to ask for them first: the text and the picture are not what was copied.
  private static func readClipboardFilePaths() -> [String] {
    let urls =
      NSPasteboard.general.readObjects(
        forClasses: [NSURL.self],
        options: [.urlReadingFileURLsOnly: true]
      ) as? [URL] ?? []
    return urls.map { $0.path }
  }
}

/// The Harness menu, in the order people act on it: what they came to do first,
/// then keeping it current, and About — which holds nothing to act on — last of
/// those; then the system's own rows.
///
/// ```
/// Add Phone…
/// Customize Harness
/// Settings…            ⌘,
/// ──────────
/// Check for Updates…
/// About Harness
/// ──────────
/// Services ›
/// ──────────
/// Hide Harness         ⌘H
/// Hide Others         ⌥⌘H
/// Show All
/// ──────────
/// Quit Harness         ⌘Q
/// ```
///
/// Two places add to this menu — this window (Check for Updates) and the title
/// bar (Settings, Customize, Add Phone) — in an order AppKit decides, so each
/// calls this once it is done, and it rebuilds the whole menu from what is
/// there. Rows are found by what they do, not where they are; anything it does
/// not know keeps a place above Quit.
enum HarnessAppMenu {
  static func arrange() {
    guard let menu = NSApp.mainMenu?.item(at: 0)?.submenu else { return }
    var rows = menu.items.filter { !$0.isSeparatorItem }
    func take(_ matches: (NSMenuItem) -> Bool) -> NSMenuItem? {
      guard let index = rows.firstIndex(where: matches) else { return nil }
      return rows.remove(at: index)
    }
    func named(_ action: String) -> (NSMenuItem) -> Bool {
      { $0.representedObject as? String == action }
    }
    func doing(_ selectors: String...) -> (NSMenuItem) -> Bool {
      { item in item.action.map { selectors.contains(NSStringFromSelector($0)) } ?? false }
    }
    let quit = take(doing("terminate:"))
    let groups: [[NSMenuItem?]] = [
      [take(named("addPhone")), take(named("customize")), take { $0.keyEquivalent == "," }],
      [take { $0.tag == 7301 }, take(doing("showAbout:", "orderFrontStandardAboutPanel:"))],
      [take { $0.submenu != nil && $0.submenu === NSApp.servicesMenu } ?? take { $0.title == "Services" }],
      [take(doing("hide:")), take(doing("hideOtherApplications:")), take(doing("unhideAllApplications:"))],
    ] + [rows.map { Optional($0) }, [quit]]
    menu.removeAllItems()
    for group in groups.map({ $0.compactMap { $0 } }) where !group.isEmpty {
      if menu.numberOfItems > 0 { menu.addItem(.separator()) }
      for item in group { menu.addItem(item) }
    }
  }
}
