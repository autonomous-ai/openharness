import Cocoa
import FlutterMacOS
import XCTest
@testable import Harness

class RunnerTests: XCTestCase {

  private func keyDown(_ characters: String, _ modifiers: NSEvent.ModifierFlags) -> NSEvent {
    NSEvent.keyEvent(
      with: .keyDown, location: .zero, modifierFlags: modifiers, timestamp: 0,
      windowNumber: 0, context: nil, characters: characters,
      charactersIgnoringModifiers: characters, isARepeat: false, keyCode: 9
    )!
  }

  // Dictation tools post ⌘V with Command on the key event alone (flutter/flutter#184571).
  func testCommandVWithNoCommandPressIsAnInjectedPaste() {
    XCTAssertTrue(isInjectedPaste(keyDown("v", .command), commandPressed: false))
    XCTAssertTrue(isInjectedPaste(keyDown("V", [.command, .capsLock]), commandPressed: false))
  }

  func testPhysicalCommandVIsLeftToFlutter() {
    XCTAssertFalse(isInjectedPaste(keyDown("v", .command), commandPressed: true))
  }

  func testOtherKeysAreLeftToFlutter() {
    XCTAssertFalse(isInjectedPaste(keyDown("v", [.command, .shift]), commandPressed: false))
    XCTAssertFalse(isInjectedPaste(keyDown("v", [.command, .option]), commandPressed: false))
    XCTAssertFalse(isInjectedPaste(keyDown("c", .command), commandPressed: false))
    XCTAssertFalse(isInjectedPaste(keyDown("v", []), commandPressed: false))
  }

}
