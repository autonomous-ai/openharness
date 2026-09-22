// Rasterise one local SVG to a square PNG, at whatever size is asked for.
//
// Native macOS, because nothing else on a stock developer machine reads SVG:
// there is no `rsvg-convert`, no Inkscape, and `cairosvg` needs a cairo the
// repo does not install. `NSImage` decodes SVG on its own, without launching
// an app or a browser.
//
// A twin of `desktop/tool/render_svg.swift`, which is fixed at 256 and belongs
// to that package. This one takes the size, because the icon builder renders a
// supersampled master and then resamples each of the 21 slots from it.
//
//   swift render_svg.swift app_icon.svg out.png 2048
import AppKit

let args = CommandLine.arguments
guard args.count == 4, let size = Int(args[3]), size > 0 else {
    fatalError("Usage: render_svg.swift source.svg output.png size")
}
guard let image = NSImage(contentsOfFile: args[1]) else {
    fatalError("Could not read \(args[1]) as an image")
}
guard let bitmap = NSBitmapImageRep(
    bitmapDataPlanes: nil, pixelsWide: size, pixelsHigh: size,
    bitsPerSample: 8, samplesPerPixel: 4, hasAlpha: true,
    isPlanar: false, colorSpaceName: .deviceRGB,
    bytesPerRow: 0, bitsPerPixel: 0
) else {
    fatalError("Could not allocate a \(size)x\(size) bitmap")
}
NSGraphicsContext.saveGraphicsState()
NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: bitmap)
NSGraphicsContext.current?.imageInterpolation = .high
// The whole square, not fitted: the SVG this renders is authored square, and a
// fit would silently letterbox a source that stopped being one.
image.draw(in: NSRect(x: 0, y: 0, width: size, height: size))
NSGraphicsContext.restoreGraphicsState()
guard let data = bitmap.representation(using: .png, properties: [:]) else {
    fatalError("Could not encode the bitmap as PNG")
}
try data.write(to: URL(fileURLWithPath: args[2]))
