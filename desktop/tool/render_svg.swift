// Native macOS alternative for harness_marks.mjs --appkit.
// Decodes local SVG artwork without launching an app or browser.
import AppKit

guard CommandLine.arguments.count == 3,
      let image = NSImage(contentsOfFile: CommandLine.arguments[1]),
      let bitmap = NSBitmapImageRep(
        bitmapDataPlanes: nil, pixelsWide: 256, pixelsHigh: 256,
        bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
        isPlanar: false, colorSpaceName: .deviceRGB,
        bytesPerRow: 0, bitsPerPixel: 0
      ) else {
    fatalError("Usage: render_svg.swift source.svg output.png")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSGraphicsContext.current?.imageInterpolation = .high
let scale = min(256 / image.size.width, 256 / image.size.height)
let width = image.size.width * scale
let height = image.size.height * scale
image.draw(in: NSRect(x: (256 - width) / 2, y: (256 - height) / 2, width: width, height: height))
NSGraphicsContext.restoreGraphicsState()
guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not encode SVG as PNG")
}
try data.write(to: URL(fileURLWithPath: CommandLine.arguments[2]))
