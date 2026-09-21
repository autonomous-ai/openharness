import AppKit

// Original Harness Store mark: six colorful branches meet around one center.
// A small constellation for people working across disciplines. Keep the vector
// source here; both Flutter and AppKit display the same transparent PNG.
// From desktop/: swift tool/render_store_mark.swift
let pixels = 256
let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
  pixelsWide: pixels, pixelsHigh: pixels, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
  bytesPerRow: 0, bitsPerPixel: 0)!
bitmap.bitmapData!.initialize(repeating: 0, count: bitmap.bytesPerRow * pixels)
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
let context = NSGraphicsContext.current!.cgContext
context.scaleBy(x: CGFloat(pixels) / 24, y: CGFloat(pixels) / 24)
context.translateBy(x: 12, y: 12)
let colors: [UInt32] = [0x71E2CF, 0x69BBFF, 0xAC92FF, 0xEF8DD0, 0xFFAC88, 0xF4D879]
for (index, hex) in colors.enumerated() {
  context.saveGState()
  context.rotate(by: CGFloat(index) * .pi / 3)
  let branch = NSBezierPath()
  branch.move(to: NSPoint(x: 0, y: 1.4))
  branch.curve(to: NSPoint(x: -2.05, y: 7.1),
    controlPoint1: NSPoint(x: -1.0, y: 3.0), controlPoint2: NSPoint(x: -2.65, y: 5.15))
  branch.curve(to: NSPoint(x: 2.05, y: 7.1),
    controlPoint1: NSPoint(x: -1.5, y: 10.75), controlPoint2: NSPoint(x: 1.5, y: 10.75))
  branch.curve(to: NSPoint(x: 0, y: 1.4),
    controlPoint1: NSPoint(x: 2.65, y: 5.15), controlPoint2: NSPoint(x: 1.0, y: 3.0))
  branch.close()
  NSColor(srgbRed: CGFloat((hex >> 16) & 255) / 255,
    green: CGFloat((hex >> 8) & 255) / 255,
    blue: CGFloat(hex & 255) / 255, alpha: 1).setFill()
  branch.fill()
  context.restoreGState()
}
NSGraphicsContext.restoreGraphicsState()
let destination = URL(fileURLWithPath: "assets/store/polymath.png")
try bitmap.representation(using: .png, properties: [:])!.write(to: destination)
print("Wrote \(destination.path)")
