// Preview app icons using the original Departure Mono lettermark.
// Run from the repository root on macOS:
//   swift docs/branding/app-logo/render-hn-dock-options.swift
// Writes review SVGs, PNGs, and Dock mockups; does not replace shipping app icons.
import AppKit

_ = NSApplication.shared
let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let folder = root.appendingPathComponent("docs/branding/app-logo/hn-dock-options")
try FileManager.default.createDirectory(at: folder, withIntermediateDirectories: true)
let source = folder.appendingPathComponent("hn.svg")
let document = try XMLDocument(contentsOf: source, options: [])
let glyph = (try document.nodes(forXPath: "//*[local-name()='path']").first as! XMLElement)
  .attribute(forName: "d")!.stringValue!

struct Option {
  let file: String
  let name: String
  let subtitle: String
  let top: String
  let bottom: String
  let ink: String
}
let options = [
  Option(file: "a-green", name: "A  Green", subtitle: "Harness green · black letters", top: "#56FF40", bottom: "#39DE24", ink: "#10130F"),
  Option(file: "b-terminal", name: "B  Terminal", subtitle: "Graphite · green letters", top: "#303533", bottom: "#111513", ink: "#65F747"),
  Option(file: "c-light", name: "C  Light", subtitle: "Soft white · black letters", top: "#FFFFFF", bottom: "#E9ECE7", ink: "#161B17"),
  Option(file: "d-dark", name: "D  Dark", subtitle: "Graphite · white letters", top: "#303533", bottom: "#111513", ink: "#F5F8F2"),
]

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
for option in options {
  let svg = """
  <svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1024" viewBox="0 0 1024 1024">
    <!-- hn outlined from Departure Mono Regular 1.500 by Helena Zhang (SIL OFL 1.1). -->
    <defs><linearGradient id="tile" x1="0" y1="0" x2="0" y2="1">
      <stop stop-color="\(option.top)"/><stop offset="1" stop-color="\(option.bottom)"/>
    </linearGradient></defs>
    <rect x="54" y="54" width="916" height="916" rx="205" fill="url(#tile)"/>
    <path transform="translate(195.333333 178.666667) scale(33.333333)" fill="\(option.ink)" d="\(glyph)"/>
  </svg>
  """
  let url = folder.appendingPathComponent(option.file + ".svg")
  try svg.write(to: url, atomically: true, encoding: .utf8)
  let icon = NSImage(contentsOf: url)!
  icons.append(icon)
  try renderPNG(icon, size: NSSize(width: 1024, height: 1024), scale: 1,
                to: folder.appendingPathComponent(option.file + ".png"))
}

let codeIcon = NSImage(contentsOfFile: "/Applications/Visual Studio Code.app/Contents/Resources/Code.icns")!
let terminalIcon = NSImage(contentsOfFile: "/System/Applications/Utilities/Terminal.app/Contents/Resources/Terminal.icns")!
let currentIcon = NSImage(contentsOf: root.appendingPathComponent("desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon_1024.png"))!
let canvas = NSSize(width: 1120, height: 850)

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

func dockScene(option: Option, icon: NSImage, at origin: NSPoint) {
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

  // A translucent macOS-style Dock, with the proposed icon magnified as on hover.
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
  // Hover label anchors the new icon in each comparison, like the reference Dock.
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

let sheet = NSImage(size: canvas, flipped: false) { _ in
  NSColor(white: 0.065, alpha: 1).setFill()
  NSRect(origin: .zero, size: canvas).fill()
  text("hn / in the Dock", at: NSPoint(x: 24, y: 794), size: 29, color: .white, weight: .semibold)
  text("Departure Mono · four app icon treatments", at: NSPoint(x: 24, y: 768), size: 14, color: .lightGray)
  for (index, option) in options.enumerated() {
    let x: CGFloat = index % 2 == 0 ? 24 : 572
    let y: CGFloat = index < 2 ? 419 : 63
    text(option.name, at: NSPoint(x: x, y: y + 298), size: 19, color: .white, weight: .semibold)
    text(option.subtitle, at: NSPoint(x: x, y: y + 277), size: 12, color: .lightGray)
    dockScene(option: option, icon: icons[index], at: NSPoint(x: x, y: y))
  }
  text("Dock mockups · proposed icon under the Harness label · current app icon at the right for comparison",
       at: NSPoint(x: 24, y: 24), size: 11.5, color: .gray)
  return true
}
let output = folder.appendingPathComponent("dock-options.png")
try renderPNG(sheet, size: canvas, to: output)
print(output.path)
