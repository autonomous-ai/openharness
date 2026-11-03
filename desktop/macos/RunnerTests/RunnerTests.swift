import Cocoa
import FlutterMacOS
import XCTest
@testable import Harness

class RunnerTests: XCTestCase {

  func testExample() {
    // If you add code to the Runner application, consider adding tests here.
    // See https://developer.apple.com/documentation/xctest for more information about using XCTest.
  }

}

/// App Nap: hidden, Harness keeps its timers and sockets running, and the Mac still sleeps when idle.
final class AppNapTests: XCTestCase {
  /// The power assertions this process holds that keep an idle Mac awake.
  private func sleepPreventingAssertions() throws -> [String] {
    let pmset = Process()
    let pipe = Pipe()
    pmset.executableURL = URL(fileURLWithPath: "/usr/bin/pmset")
    pmset.arguments = ["-g", "assertions"]
    pmset.standardOutput = pipe
    try pmset.run()
    let output = String(decoding: pipe.fileHandleForReading.readDataToEndOfFile(), as: UTF8.self)
    pmset.waitUntilExit()
    let pid = ProcessInfo.processInfo.processIdentifier
    return output.split(separator: "\n").map(String.init)
      .filter { $0.contains("pid \(pid)(") && $0.contains("PreventUserIdleSystemSleep") }
  }

  func testTheRunningAppHoldsTheActivity() {
    XCTAssertNotNil((NSApp.delegate as? AppDelegate)?.appNapActivity)
  }

  func testLaunchHoldsTheActivityAndQuitEndsIt() throws {
    let app = AppDelegate()
    app.applicationDidFinishLaunching(Notification(name: NSApplication.didFinishLaunchingNotification))
    XCTAssertNotNil(app.appNapActivity)
    XCTAssertEqual(try sleepPreventingAssertions(), [], "the activity must still let an idle Mac sleep")
    app.applicationWillTerminate(Notification(name: NSApplication.willTerminateNotification))
    XCTAssertNil(app.appNapActivity)
  }
}

/// The native tab row: it scrolls only sideways, and each tab's × sits in the middle of the tab's body.
final class SwarmTabStripTests: XCTestCase {
  private func verticalSwipe(_ dy: Int32) -> NSEvent {
    let event = CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 2, wheel1: dy, wheel2: 0, wheel3: 0)!
    return NSEvent(cgEvent: event)!
  }

  func testStripHasNoVerticalElasticity() {
    let scroll = SwarmStripScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
    XCTAssertEqual(scroll.verticalScrollElasticity, .none)
    XCTAssertEqual(scroll.horizontalScrollElasticity, .automatic)
  }

  // A synthetic wheel event never moves an NSScrollView here (a plain one stays put too), so this
  // drives the two ways an offset reaches the clip view: AppKit's wheel and elastic scrolling ask
  // constrainBoundsRect, and scroll(to:) / scrollToVisible set it directly.
  func testNothingMovesTheStripVertically() {
    let scroll = SwarmStripScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
    // Taller than the strip, so any vertical offset that gets through is visible.
    let document = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 80))
    scroll.documentView = document
    let proposed = NSRect(x: 0, y: 20, width: 300, height: 40)
    XCTAssertEqual(scroll.contentView.constrainBoundsRect(proposed).origin.y, 0)
    scroll.contentView.scroll(to: NSPoint(x: 0, y: 20))
    XCTAssertEqual(scroll.contentView.bounds.origin.y, 0)
    document.scrollToVisible(NSRect(x: 600, y: 60, width: 100, height: 20))
    XCTAssertEqual(scroll.contentView.bounds.origin, NSPoint(x: 400, y: 0))
  }

  func testOverflowingTabsStillScrollSidewaysOnAVerticalSwipe() {
    let scroll = SwarmStripScrollView(frame: NSRect(x: 0, y: 0, width: 300, height: 40))
    scroll.documentView = NSView(frame: NSRect(x: 0, y: 0, width: 900, height: 40))
    scroll.scrollWheel(with: verticalSwipe(-30))
    XCTAssertGreaterThan(scroll.contentView.bounds.origin.x, 0)
    XCTAssertEqual(scroll.contentView.bounds.origin.y, 0)
  }

  func testContentAndCloseCentreOnTheTabBody() {
    for height in [40, 30] as [CGFloat] {
      let bounds = NSRect(x: 0, y: 0, width: 200, height: height)
      let body = SwarmTabGeometry.shapeRect(in: bounds)
      let close = SwarmTabGeometry.closeFrame(in: bounds)
      XCTAssertEqual(body.maxY, height - SwarmTabGeometry.topInset)
      XCTAssertEqual(SwarmTabGeometry.contentCenterY(in: bounds), body.midY, "height \(height)")
      XCTAssertEqual(close.midY, body.midY, "height \(height)")
      XCTAssertTrue(body.contains(close), "× \(close) leaves the body \(body)")
    }
  }

  // The pane's close button (PaneCloseButton): a 28pt square, here as large as the tab's body
  // allows, with one gap above, below and to the body's straight right side.
  func testCloseIsASquareWithEvenGaps() {
    for (height, side) in [(40, 28), (30, 24)] as [(CGFloat, CGFloat)] {
      let bounds = NSRect(x: 0, y: 0, width: 200, height: height)
      let body = SwarmTabGeometry.shapeRect(in: bounds)
      let close = SwarmTabGeometry.closeFrame(in: bounds)
      XCTAssertEqual(close.width, close.height, "height \(height)")
      XCTAssertEqual(close.width, side, "height \(height)")
      let below = close.minY - body.minY, above = body.maxY - close.maxY
      let right = bounds.maxX - SwarmTabGeometry.shoulder - close.maxX
      XCTAssertEqual(below, above, "height \(height)")
      XCTAssertEqual(right, above, "height \(height)")
    }
  }
}

/// The titlebar redraws only what an update changes: Dart sends one on nearly every app change, and
/// a control that repaints (or turns off and on) each time flickers like a reload.
final class SwarmTitlebarUpdateTests: XCTestCase {
  private final class Messenger: NSObject, FlutterBinaryMessenger {
    var handlers: [String: FlutterBinaryMessageHandler] = [:]
    func send(onChannel channel: String, message: Data?) {}
    func send(onChannel channel: String, message: Data?, binaryReply callback: FlutterBinaryReply? = nil) {
      callback?(nil)
    }
    func setMessageHandlerOnChannel(_ channel: String,
                                    binaryMessageHandler handler: FlutterBinaryMessageHandler? = nil)
      -> FlutterBinaryMessengerConnection {
      handlers[channel] = handler
      return 0
    }
    func cleanUpConnection(_ connection: FlutterBinaryMessengerConnection) {}
    func call(_ method: String, _ arguments: Any?) {
      let message = FlutterStandardMethodCodec.sharedInstance()
        .encode(FlutterMethodCall(methodName: method, arguments: arguments))
      handlers["harness/swarm_tabs"]?(message) { _ in }
    }
  }

  private func descendants(of view: NSView) -> [NSView] {
    view.subviews + view.subviews.flatMap(descendants(of:))
  }

  /// Marked for drawing, as AppKit keeps it for a layer-backed view (the row is one).
  private func dirty(_ views: [NSView]) -> [String] {
    views.filter { $0.needsDisplay || $0.layer?.needsDisplay() == true }.map { "\(type(of: $0))" }
  }

  private struct Row {
    let window: NSWindow
    let messenger: Messenger
    let titlebar: SwarmTitlebar
    let strip: NSView
  }

  private func row(_ state: [String: Any]) -> Row? {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 600),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.contentView = NSView()
    let messenger = Messenger()
    let titlebar = SwarmTitlebar(window: window, messenger: messenger, installStatusItem: false)
    messenger.call("configure", [:])
    messenger.call("update", state)
    guard let strip = window.titlebarAccessoryViewControllers.first?.view else {
      XCTFail("the row is not in the title bar")
      return nil
    }
    strip.layoutSubtreeIfNeeded()
    flush(Row(window: window, messenger: messenger, titlebar: titlebar, strip: strip))
    return Row(window: window, messenger: messenger, titlebar: titlebar, strip: strip)
  }

  private func flush(_ row: Row) {
    row.window.layoutIfNeeded()
    row.window.displayIfNeeded()
    // Offscreen, AppKit leaves layer-backed views marked: draw them now.
    for view in [row.strip] + descendants(of: row.strip) { view.layer?.displayIfNeeded() }
  }

  private func state(enabled: Bool = true, stripEnabled: Bool = true) -> [String: Any] {
    [
      "enabled": enabled, "stripEnabled": stripEnabled, "activeId": "a",
      "tabs": [["id": "a", "name": "First"], ["id": "b", "name": "Second"]],
      "account": ["kind": "avatar", "initial": "T"],
    ]
  }

  private func tabs(_ row: Row) -> [NSView] {
    descendants(of: row.strip).filter { "\(type(of: $0))" == "SwarmTabButton" }
  }

  func testAnIdenticalUpdateRedrawsNoControl() {
    guard let row = row(state()) else { return }
    let controls = [row.strip] + descendants(of: row.strip).filter {
      $0 is NSButton || "\(type(of: $0))".hasPrefix("SwarmTab")
    }
    XCTAssertFalse(controls.isEmpty)
    XCTAssertEqual(dirty(controls), [], "drawn once")
    let enabled = controls.compactMap { ($0 as? NSButton)?.isEnabled }
    row.messenger.call("update", state())
    XCTAssertEqual(dirty(controls), [])
    XCTAssertEqual(controls.compactMap { ($0 as? NSButton)?.isEnabled }, enabled)
    withExtendedLifetime(row.titlebar) {}
  }

  private func holdCommand(_ row: Row, _ held: Bool) {
    let event = NSEvent.keyEvent(with: .flagsChanged, location: .zero, modifierFlags: held ? .command : [],
      timestamp: ProcessInfo.processInfo.systemUptime, windowNumber: row.window.windowNumber, context: nil,
      characters: "", charactersIgnoringModifiers: "", isARepeat: false, keyCode: 55)!
    NSApp.sendEvent(event)
  }

  // The tabs' ⌘1… hints teach the menu shortcuts, so they follow the menus (`enabled`), not the row,
  // which stays live over Settings while the shortcuts are off.
  func testShortcutHintsFollowTheMenusNotTheRow() {
    guard let row = row(state()) else { return }
    holdCommand(row, true)
    XCTAssertEqual(dirty(tabs(row)).count, 2, "Command shows each tab's hint")
    holdCommand(row, false)
    row.messenger.call("update", state(enabled: false, stripEnabled: true))
    flush(row)
    holdCommand(row, true)
    XCTAssertEqual(dirty(tabs(row)), [], "over Settings the shortcuts are off: no hints")
    holdCommand(row, false)
    withExtendedLifetime(row.titlebar) {}
  }

  /// The strongest ink a view draws, from 0 to 1.
  private func ink(_ view: NSView) -> CGFloat {
    guard let rep = view.bitmapImageRepForCachingDisplay(in: view.bounds) else { return 0 }
    view.cacheDisplay(in: view.bounds, to: rep)
    var strongest: CGFloat = 0
    for y in 0..<rep.pixelsHigh {
      for x in 0..<rep.pixelsWide { strongest = max(strongest, rep.colorAt(x: x, y: y)?.alphaComponent ?? 0) }
    }
    return strongest
  }

  // The tab's × draws at rest with the ink it has pressed (AppIcons.closeInk in Flutter).
  func testCloseMarkIsFullInkAtRest() {
    guard let row = row(state()),
          let close = descendants(of: row.strip).first(where: {
            "\(type(of: $0))" == "SwarmPlainIconButton" && "\(type(of: $0.superview!))" == "SwarmTabButton"
          }) as? NSButton else { return XCTFail("no tab ×") }
    close.isHidden = false
    let resting = ink(close)
    close.highlight(true)
    let pressed = ink(close)
    XCTAssertGreaterThan(pressed, 0)
    XCTAssertEqual(resting, pressed, accuracy: 0.02)
    XCTAssertEqual(HarnessControlSymbols.closeInk, 1)
    withExtendedLifetime(row.titlebar) {}
  }
}

/// The menu bar's Harness menu.
final class HarnessStatusMenuTests: XCTestCase {
  // "View all N notifications…" opens the inbox; only a titlebar button toggles it, so the row asks
  // for `open`: an inbox already open stays.
  func testViewAllOpensTheInbox() {
    var sent: [(String, Any?)] = []
    let status = HarnessStatusMenu(installStatusItem: false, showWindow: {}, emit: { sent.append(($0, $1)) })
    let entries: [[String: Any]] = (0..<6).map {
      ["machineId": "m", "agentId": "a\($0)", "sessionId": "s\($0)", "readToken": "r\($0)",
       "unread": true, "title": "Harness \($0)"]
    }
    status.update(["enabled": true, "statusMenuEntries": entries])
    status.menuNeedsUpdate(status.menu)
    guard let viewAll = status.menu.items.first(where: { $0.title.hasPrefix("View all") }),
          let action = viewAll.action else { return XCTFail("no View all row") }
    NSApp.sendAction(action, to: viewAll.target, from: viewAll)
    XCTAssertEqual(sent.last?.0, "notificationInbox")
    XCTAssertEqual((sent.last?.1 as? [String: Any])?["open"] as? Bool, true)
  }
}
