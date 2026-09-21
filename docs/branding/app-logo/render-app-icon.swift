// Run from the repository root:
// swift docs/branding/app-logo/render-app-icon.swift
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let icons = root.appendingPathComponent("desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset")
let source = icons.appendingPathComponent("app_icon.svg")
// The 400-unit artwork sits inside the existing 54px macOS margin, with
// a further 6% inset for its figure and geometry. Keep the frame visible
// when rasterized at small sizes rather than letting it become a hairline.
let artworkScale = 2.29 * 0.94
for size in [16, 32, 64, 128, 256, 512, 1024] {
  let document = try XMLDocument(contentsOf: source, options: [])
  let minimumStrokePixels = size == 16 ? 0.5 : 0.65
  let frameWidth = max(2.8, minimumStrokePixels * 1024 / (Double(size) * artworkScale))
  let frames = try document.nodes(forXPath: "//*[local-name()='circle' or local-name()='rect'][@stroke]")
  guard frames.count == 2 else { fatalError("Expected the circle and square outlines") }
  for case let element as XMLElement in frames {
    element.attribute(forName: "stroke-width")?.stringValue = String(frameWidth)
  }
  guard let image = NSImage(data: document.xmlData),
        let bitmap = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
          bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true, isPlanar: false,
          colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0) else {
    fatalError("Could not render the icon")
  }
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
  NSGraphicsContext.current?.imageInterpolation = .high
  let rect = NSRect(x: 0, y: 0, width: size, height: size)
  NSColor.clear.setFill()
  rect.fill(using: .copy)
  image.draw(in: rect, from: .zero, operation: .sourceOver, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  let data = bitmap.representation(using: .png, properties: [:])!
  try data.write(to: icons.appendingPathComponent("app_icon_\(size).png"))
  if size == 256 { try data.write(to: root.appendingPathComponent("desktop/assets/app_icon.png")) }
  print("Rendered \(size) × \(size)")
}
