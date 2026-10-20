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

  func testAnIdenticalUpdateRedrawsNoControl() {
    let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 1100, height: 600),
      styleMask: [.titled, .closable, .miniaturizable, .resizable], backing: .buffered, defer: false)
    window.contentView = NSView()
    let messenger = Messenger()
    let titlebar = SwarmTitlebar(window: window, messenger: messenger, installStatusItem: false)
    messenger.call("configure", [:])
    let state: [String: Any] = [
      "enabled": true, "stripEnabled": true, "activeId": "a",
      "tabs": [["id": "a", "name": "First"], ["id": "b", "name": "Second"]],
      "account": ["kind": "avatar", "initial": "T"],
    ]
    messenger.call("update", state)
    guard let strip = window.titlebarAccessoryViewControllers.first?.view else {
      return XCTFail("the row is not in the title bar")
    }
    strip.layoutSubtreeIfNeeded()
    window.layoutIfNeeded()
    window.displayIfNeeded()
    // Offscreen, AppKit leaves layer-backed views marked: draw them now.
    for view in [strip] + descendants(of: strip) { view.layer?.displayIfNeeded() }
    let controls = [strip] + descendants(of: strip).filter { $0 is NSButton || "\(type(of: $0))".hasPrefix("SwarmTab") }
    XCTAssertFalse(controls.isEmpty)
    XCTAssertEqual(dirty(controls), [], "drawn once")
    let enabled = controls.compactMap { ($0 as? NSButton)?.isEnabled }
    messenger.call("update", state)
    XCTAssertEqual(dirty(controls), [])
    XCTAssertEqual(controls.compactMap { ($0 as? NSButton)?.isEnabled }, enabled)
    withExtendedLifetime(titlebar) {}
  }

  // The close mark is full ink at rest, as AppIcons.closeInk in Flutter.
  func testCloseMarkIsFullInkAtRest() {
    XCTAssertEqual(HarnessControlSymbols.closeInk, 1)
  }
}
