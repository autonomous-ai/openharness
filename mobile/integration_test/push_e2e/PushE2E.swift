import XCTest

/// The phone push end to end on an iOS simulator (task #3248), driven by `run.sh`, which installs
/// `integration_test/push_e2e_app.dart` and sends each push this runner asks for with
/// `xcrun simctl push`: the body the server sends (`reply_push.apns`, pinned by backend
/// `src/push/apns.test.ts`).
///
/// 1. The app's first launch: notices allowed, the app up on its Swarm, then closed.
/// 2. A reply push to the closed app: iOS draws it, and its tap starts the app on that thread.
/// 3. The same push with the app in front: not drawn (the app's own notices decide there).
///
/// The method is `testDrive`, never `testRun`, which is XCTest's own and would skip the body.
final class PushE2E: XCTestCase {
  let app = XCUIApplication(bundleIdentifier: "ai.autonomous.harness.ios")
  let springboard = XCUIApplication(bundleIdentifier: "com.apple.springboard")
  let notice = "River replied in a thread"

  override func setUp() {
    continueAfterFailure = false
  }

  func testDrive() throws {
    // 1. First launch.
    app.launch()
    let allow = springboard.alerts.buttons["Allow"]
    if allow.waitForExistence(timeout: 25) { allow.tap() }
    XCTAssertTrue(element(app, containing: "Phone Swarm").waitForExistence(timeout: 40), "the app is up on its Swarm")
    shot("01-app-up")
    app.terminate()
    XCTAssertEqual(app.state, .notRunning)
    log("app closed")

    // 2. The push to the closed app, drawn by iOS; its tap.
    push("push-1")
    var drawn = element(springboard, containing: notice)
    if !drawn.waitForExistence(timeout: 8) {
      // The banner went before it was looked for: the push waits in Notification Centre.
      let top = springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.002))
      top.press(forDuration: 0.1, thenDragTo: springboard.coordinate(withNormalizedOffset: CGVector(dx: 0.3, dy: 0.7)))
      drawn = element(springboard, containing: notice)
      XCTAssertTrue(drawn.waitForExistence(timeout: 10), "the push is drawn")
    }
    log("push drawn: \(drawn.label)")
    shot("02-push-drawn")
    // In Notification Centre a first tap may only open the stack the push sits in: tap it again.
    var started = false
    for attempt in 0..<3 where !started {
      log("tap \(attempt): \(drawn.elementType.rawValue) frame \(drawn.frame) hittable \(drawn.isHittable)")
      if attempt == 0 { drawn.tap() } else { drawn.coordinate(withNormalizedOffset: CGVector(dx: 0.5, dy: 0.5)).tap() }
      started = app.wait(for: .runningForeground, timeout: 10)
      drawn = element(springboard, containing: notice)
    }
    XCTAssertTrue(started, "the tap starts the app")
    XCTAssertTrue(element(app, containing: "Drafted the first two screens").waitForExistence(timeout: 40), "the thread is open at River's reply")
    XCTAssertTrue(element(app, containing: "Onboarding copy").exists, "in the chat its link names")
    shot("03-thread-opened")
    log("thread opened")

    // 3. The same push with the app in front.
    push("push-2")
    XCTAssertFalse(element(springboard, containing: notice).waitForExistence(timeout: 8), "no push drawn over the app")
    shot("04-in-front-not-drawn")
    log("in front: not drawn")
  }

  /// What is on screen whose label holds [text]: Flutter's semantics, or the springboard's own.
  private func element(_ on: XCUIApplication, containing text: String) -> XCUIElement {
    on.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
  }

  private var out: URL {
    URL(fileURLWithPath: ProcessInfo.processInfo.environment["OUT"] ?? NSTemporaryDirectory())
  }

  /// Asks `run.sh` for push [name] and waits until it was sent.
  private func push(_ name: String) {
    FileManager.default.createFile(atPath: out.appendingPathComponent("want-\(name)").path, contents: nil)
    let sent = out.appendingPathComponent("sent-\(name)").path
    let until = Date().addingTimeInterval(60)
    while !FileManager.default.fileExists(atPath: sent) {
      XCTAssertLessThan(Date(), until, "\(name) was not sent")
      Thread.sleep(forTimeInterval: 0.2)
    }
    log("\(name) sent")
  }

  private func shot(_ name: String) {
    try? XCUIScreen.main.screenshot().pngRepresentation.write(to: out.appendingPathComponent("\(name).png"))
  }

  private func log(_ line: String) {
    let file = out.appendingPathComponent("runner.log")
    let text = "\(ISO8601DateFormatter().string(from: Date())) \(line)\n"
    if let handle = try? FileHandle(forWritingTo: file) {
      handle.seekToEndOfFile()
      handle.write(text.data(using: .utf8)!)
      try? handle.close()
    } else {
      try? text.write(to: file, atomically: true, encoding: .utf8)
    }
  }
}
