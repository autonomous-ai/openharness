// Appended to the real native sources by check_swarm_titlebar.sh --status-preview.
// Generate input with HARNESS_NATIVE_STATUS_CAPTURE_DIR=... flutter test
// test/workspace_status_test.dart, then use that directory for this renderer.
import AppKit

let _ = NSApplication.shared
guard let directory = ProcessInfo.processInfo.environment["HARNESS_NATIVE_STATUS_CAPTURE_DIR"] else {
  fatalError("Set HARNESS_NATIVE_STATUS_CAPTURE_DIR to the synthetic Dart fixture directory")
}
let root = URL(fileURLWithPath: directory)
let catalog = try JSONSerialization.jsonObject(with: Data(contentsOf: root.appendingPathComponent("catalog.json"))) as! [[String: String]]
let width = 1100, rowHeight = 64, height = catalog.count * rowHeight
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: width * 2, pixelsHigh: height * 2,
  bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
  colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let scale = NSAffineTransform(); scale.scale(by: 2); scale.concat()
NSColor(white: 0.11, alpha: 1).setFill()
NSRect(x: 0, y: 0, width: width, height: height).fill()

func drawTree(_ view: NSView) {
  guard !view.isHidden else { return }
  view.draw(view.bounds)
  for child in view.subviews {
    NSGraphicsContext.saveGraphicsState()
    let move = NSAffineTransform()
    move.translateX(by: child.frame.minX - view.bounds.minX, yBy: child.frame.minY - view.bounds.minY)
    move.concat()
    drawTree(child)
    NSGraphicsContext.restoreGraphicsState()
  }
}

for (index, choice) in catalog.enumerated() {
  var state = try JSONSerialization.jsonObject(with: Data(contentsOf:
    root.appendingPathComponent("\(choice["id"]!).json"))) as! [String: Any]
  state["tabs"] = [["id": "review", "name": "Review", "label": "1:review"]]
  state["activeId"] = "review"
  state["enabled"] = true
  let bar = SwarmTabStrip(frame: NSRect(x: 0, y: 0, width: width, height: 36))
  bar.update(state)
  bar.layoutSubtreeIfNeeded()
  let origin = CGFloat((catalog.count - index - 1) * rowHeight)
  NSAttributedString(string: choice["label"]!, attributes: [
    .font: NSFont.monospacedSystemFont(ofSize: 12, weight: .regular),
    .foregroundColor: NSColor(white: 0.65, alpha: 1),
  ]).draw(at: NSPoint(x: 12, y: origin + 43))
  NSGraphicsContext.saveGraphicsState()
  let move = NSAffineTransform(); move.translateX(by: 0, yBy: origin + 3); move.concat()
  drawTree(bar)
  NSGraphicsContext.restoreGraphicsState()
}
NSGraphicsContext.restoreGraphicsState()
let output = root.appendingPathComponent("native-themes.png")
try bitmap.representation(using: .png, properties: [:])!.write(to: output)
print("Rendered \(catalog.count) native status presets to \(output.path); no window opened.")
