// Preview the team's September 30 symbols in the Dock and menu bar.
// Run from the repository root on macOS, with Xcode installed:
//   swift docs/branding/app-logo/render-team-symbols.swift
// The supplied SVGs keep their colors and transparent cutouts.
import AppKit
import CoreText

_ = NSApplication.shared
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let folder = root.appendingPathComponent("docs/branding/app-logo/team-symbols-2026-09-30")
let names = ["dark", "light"]
let symbols = names.map { NSImage(contentsOf: folder.appendingPathComponent("Symbol Harness_" + $0 + ".svg"))! }

func renderPNG(_ image: NSImage, size: NSSize, scale: CGFloat = 2, to url: URL) throws {
  let rep = NSBitmapImageRep(bitmapDataPlanes: nil, pixelsWide: Int(size.width * scale),
    pixelsHigh: Int(size.height * scale), bitsPerSample: 8, samplesPerPixel: 4,
    hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)!
  rep.size = size
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  image.draw(in: NSRect(origin: .zero, size: size), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  try rep.representation(using: .png, properties: [:])!.write(to: url)
}

var icons: [NSImage] = []
for (index, name) in names.enumerated() {
  let icon = NSImage(size: NSSize(width: 1024, height: 1024), flipped: false) { _ in
    // Use the same outer margin as the shipping macOS app icon.
    symbols[index].draw(in: NSRect(x: 54, y: 54, width: 916, height: 916))
    return true
  }
  icons.append(icon)
  try renderPNG(icon, size: NSSize(width: 1024, height: 1024), scale: 1,
                to: folder.appendingPathComponent("dock-" + name + ".png"))
}

let codeIcon = NSImage(contentsOfFile: "/Applications/Xcode.app/Contents/Resources/Xcode.icns")!
let terminalIcon = NSImage(contentsOfFile: "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns")!
let currentIcon = NSImage(contentsOf: root.appendingPathComponent("desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_1024.png"))!

func text(_ value: String, at point: NSPoint, size: CGFloat, color: NSColor,
          weight: NSFont.Weight = .regular, mono: Bool = false) {
  (value as NSString).draw(at: point, withAttributes: [
    .font: mono ? NSFont.monospacedSystemFont(ofSize: size, weight: weight) : NSFont.systemFont(ofSize: size, weight: weight),
    .foregroundColor: color,
  ])
}

func drawIcon(_ icon: NSImage, in rect: NSRect) {
  NSGraphicsContext.saveGraphicsState()
  let shadow = NSShadow()
  shadow.shadowColor = NSColor.black.withAlphaComponent(0.32)
  shadow.shadowBlurRadius = 6
  shadow.shadowOffset = NSSize(width: 0, height: -3)
  shadow.set()
  icon.draw(in: rect)
  NSGraphicsContext.restoreGraphicsState()
}

func dockScene(icon: NSImage, at origin: NSPoint) {
  let scene = NSRect(x: origin.x, y: origin.y, width: 524, height: 264)
  NSGraphicsContext.saveGraphicsState()
  NSBezierPath(roundedRect: scene, xRadius: 14, yRadius: 14).addClip()
  NSColor(white: 0.095, alpha: 1).setFill()
  scene.fill()
  NSColor(white: 0.25, alpha: 1).setFill()
  NSRect(x: scene.minX, y: scene.minY + 83, width: 243, height: 181).fill()
  NSColor(white: 0.35, alpha: 1).setFill()
  NSRect(x: scene.minX + 249, y: scene.minY + 83, width: 1, height: 181).fill()
  text("harness / workspace", at: NSPoint(x: scene.minX + 16, y: scene.minY + 238),
       size: 12, color: NSColor(white: 0.65, alpha: 1), mono: true)
  text("$ hn", at: NSPoint(x: scene.minX + 272, y: scene.minY + 238),
       size: 12, color: NSColor(white: 0.75, alpha: 1), mono: true)
  let dock = NSRect(x: scene.minX + 8, y: scene.minY + 12, width: 508, height: 127)
  let dockPath = NSBezierPath(roundedRect: dock, xRadius: 23, yRadius: 23)
  NSGradient(starting: NSColor(white: 0.66, alpha: 0.56), ending: NSColor(white: 0.47, alpha: 0.72))!
    .draw(in: dockPath, angle: 90)
  NSColor(white: 0.92, alpha: 0.33).setStroke()
  dockPath.lineWidth = 0.75
  dockPath.stroke()
  let placements: [(NSImage, CGFloat, CGFloat)] = [
    (terminalIcon, 64, 88), (codeIcon, 184, 112), (icon, 330, 146), (currentIcon, 465, 100),
  ]
  for (appIcon, center, size) in placements {
    drawIcon(appIcon, in: NSRect(x: scene.minX + center - size / 2,
                                y: scene.minY + 32, width: size, height: size))
    NSColor(white: 0.07, alpha: 1).setFill()
    NSBezierPath(ovalIn: NSRect(x: scene.minX + center - 2, y: scene.minY + 21, width: 4, height: 4)).fill()
  }
  let tooltip = NSRect(x: scene.minX + 286, y: scene.minY + 196, width: 88, height: 29)
  let tip = NSBezierPath()
  tip.move(to: NSPoint(x: tooltip.midX - 8, y: tooltip.minY + 1))
  tip.line(to: NSPoint(x: tooltip.midX, y: tooltip.minY - 7))
  tip.line(to: NSPoint(x: tooltip.midX + 8, y: tooltip.minY + 1))
  tip.close()
  NSColor(white: 0.79, alpha: 1).setFill()
  tip.fill()
  NSBezierPath(roundedRect: tooltip, xRadius: 14, yRadius: 14).fill()
  text("Harness", at: NSPoint(x: tooltip.minX + 14, y: tooltip.minY + 6),
       size: 15, color: NSColor(white: 0.13, alpha: 1))
  NSGraphicsContext.restoreGraphicsState()
}

// Preserve this original proposal's 20pt artwork and lower-right count badge.
func statusImage(logo: NSImage, count: Int?) -> NSImage {
  NSImage(size: NSSize(width: 32, height: 22), flipped: false) { bounds in
    let hasBadge = (count ?? 0) > 0
    logo.draw(in: NSRect(x: hasBadge ? 0 : 6, y: hasBadge ? 2 : 1, width: 20, height: 20))
    if hasBadge, let count, let context = NSGraphicsContext.current?.cgContext {
      let badge = NSRect(x: bounds.maxX - 13, y: 0.5, width: 12.5, height: 12.5)
      context.saveGState()
      context.setBlendMode(.clear)
      context.fillEllipse(in: badge.insetBy(dx: -0.75, dy: -0.75))
      context.restoreGState()
      NSColor.black.setFill()
      NSBezierPath(ovalIn: badge).fill()
      let label = String(count)
      let attributed = NSAttributedString(string: label, attributes: [
        .font: NSFont.monospacedDigitSystemFont(ofSize: label.count == 1 ? 9.5 : 8.5, weight: .medium),
        .foregroundColor: NSColor.black,
      ])
      let line = CTLineCreateWithAttributedString(attributed)
      let ink = CTLineGetBoundsWithOptions(line, .useGlyphPathBounds)
      context.saveGState()
      context.setBlendMode(.destinationOut)
      context.textPosition = NSPoint(x: badge.midX - ink.midX, y: badge.midY - ink.midY)
      CTLineDraw(line, context)
      context.restoreGState()
    }
    return true
  }
}

func drawTemplate(_ image: NSImage, in rect: NSRect, color: NSColor) {
  let context = NSGraphicsContext.current!.cgContext
  let mask = CGContext(data: nil, width: Int(rect.width * 2), height: Int(rect.height * 2),
    bitsPerComponent: 8, bytesPerRow: 0, space: CGColorSpaceCreateDeviceRGB(),
    bitmapInfo: CGImageAlphaInfo.premultipliedLast.rawValue)!
  mask.scaleBy(x: 2, y: 2)
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: mask, flipped: false)
  image.draw(in: NSRect(origin: .zero, size: rect.size))
  NSGraphicsContext.restoreGraphicsState()
  context.saveGState()
  context.clip(to: rect, mask: mask.makeImage()!)
  context.setFillColor(color.cgColor)
  context.fill(rect)
  context.restoreGState()
}

let canvas = NSSize(width: 1120, height: 730)
let sheet = NSImage(size: canvas, flipped: false) { _ in
  NSColor(white: 0.065, alpha: 1).setFill()
  NSRect(origin: .zero, size: canvas).fill()
  text("Harness / team symbols", at: NSPoint(x: 24, y: 677), size: 29, color: .white, weight: .semibold)
  text("The supplied SVGs, shown in the Dock and as menu bar templates", at: NSPoint(x: 24, y: 650), size: 14, color: .lightGray)
  for index in 0..<2 {
    let x: CGFloat = index == 0 ? 24 : 572
    text(index == 0 ? "Dark symbol" : "Light symbol", at: NSPoint(x: x, y: 610), size: 19, color: .white, weight: .semibold)
    text(index == 0 ? "Symbol Harness_dark.svg" : "Symbol Harness_light.svg", at: NSPoint(x: x, y: 586), size: 12, color: .lightGray)
    dockScene(icon: icons[index], at: NSPoint(x: x, y: 300))
  }
  text("Menu bar", at: NSPoint(x: 24, y: 260), size: 19, color: .white, weight: .semibold)
  text("Enlarged at left · actual-size previews at right", at: NSPoint(x: 24, y: 239), size: 12, color: .lightGray)
  for (index, dark) in [true, false].enumerated() {
    let x: CGFloat = index == 0 ? 24 : 572
    let color: NSColor = dark ? .white : .black
    (dark ? NSColor.black : NSColor(white: 0.94, alpha: 1)).setFill()
    NSBezierPath(roundedRect: NSRect(x: x, y: 54, width: 524, height: 160), xRadius: 12, yRadius: 12).fill()
    text(dark ? "Dark menu bar" : "Light menu bar", at: NSPoint(x: x + 16, y: 182), size: 13, color: color, weight: .medium)
    let logo = symbols[dark ? 1 : 0]
    drawTemplate(statusImage(logo: logo, count: 3), in: NSRect(x: x + 24, y: 102, width: 96, height: 66), color: color)
    text("3×", at: NSPoint(x: x + 62, y: 78), size: 10, color: color.withAlphaComponent(0.5))
    let counts: [Int?] = [nil, 0, 3, 12]
    for (column, count) in counts.enumerated() {
      let left = x + 178 + CGFloat(column) * 82
      drawTemplate(statusImage(logo: logo, count: count), in: NSRect(x: left, y: 122, width: 32, height: 22), color: color)
      text(count.map { String($0) } ?? "none", at: NSPoint(x: left + (count == nil ? 4 : 11), y: 96),
           size: 10, color: color.withAlphaComponent(0.5))
    }
  }
  text("Dock mockups · original transparency retained · current green icon at right · menu bar footprint 32 × 22pt",
       at: NSPoint(x: 24, y: 23), size: 11.5, color: .gray)
  return true
}
let output = folder.appendingPathComponent("team-icons-preview.png")
try renderPNG(sheet, size: canvas, to: output)
print(output.path)
