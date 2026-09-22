// Renders every app icon — desktop and mobile — from the one source SVG.
//
//   swift docs/branding/app-logo/render-app-icon.swift        (from the repository root, on macOS)
//
// The source is desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon.svg: the 400-unit
// mark as the design ships it, fitted into a 1024 canvas with 54px of margin (a 916px tile), which is
// what keeps macOS from clipping the corners of its own squircle. The drawing is cut three ways:
//   mac     the canvas as-is: macOS icon set, Linux harness.png, both apps' in-app assets/app_icon.png
//   tile    cropped to the tile, the design's own rounded corners: Windows .ico, Android launcher
//   square  cropped to the tile with its corners squared off and no alpha: iOS, which masks the
//           icon itself and whose App Store upload rejects an alpha channel
// To adopt a new logo, keep its untouched SVG beside this script, put its 400x400 markup inside the
// <g transform> in app_icon.svg, and rerun.
import AppKit

let root = URL(fileURLWithPath: FileManager.default.currentDirectoryPath)
let source = root.appendingPathComponent("desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset/app_icon.svg")
guard FileManager.default.fileExists(atPath: source.path) else {
  fatalError("Run from the repository root: \(source.path) not found")
}

enum Cut { case mac, tile, square }

func svg(_ cut: Cut) throws -> Data {
  let document = try XMLDocument(contentsOf: source, options: [])
  if cut != .mac {
    document.rootElement()?.attribute(forName: "viewBox")?.stringValue = "54 54 916 916"
  }
  if cut == .square {
    // The tile and the clip path that follows it are the only rounded rects.
    for case let rect as XMLElement in try document.nodes(forXPath: "//*[local-name()='rect'][@rx]") {
      rect.attribute(forName: "rx")?.stringValue = "0"
    }
  }
  return document.xmlData
}

func png(_ cut: Cut, _ size: Int) throws -> Data {
  guard let image = NSImage(data: try svg(cut)) else { fatalError("Could not read \(source.path)") }
  let opaque = cut == .square
  guard let context = CGContext(data: nil, width: size, height: size, bitsPerComponent: 8, bytesPerRow: 0,
    space: CGColorSpace(name: CGColorSpace.sRGB)!,
    bitmapInfo: (opaque ? CGImageAlphaInfo.noneSkipLast : .premultipliedLast).rawValue) else {
    fatalError("Could not make a \(size)px bitmap")
  }
  context.interpolationQuality = .high
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(cgContext: context, flipped: false)
  image.draw(in: NSRect(x: 0, y: 0, width: size, height: size), from: .zero, operation: .copy, fraction: 1)
  NSGraphicsContext.restoreGraphicsState()
  let data = NSMutableData()
  let destination = CGImageDestinationCreateWithData(data, "public.png" as CFString, 1, nil)!
  CGImageDestinationAddImage(destination, context.makeImage()!, nil)
  guard CGImageDestinationFinalize(destination) else { fatalError("Could not encode a \(size)px PNG") }
  return data as Data
}

func write(_ data: Data, _ path: String) throws {
  try data.write(to: root.appendingPathComponent(path))
  print(path)
}

// A Windows .ico whose frames are PNGs, which every Windows since Vista reads.
func ico(_ frames: [(Int, Data)]) -> Data {
  var out = Data()
  func le16(_ v: Int) { out.append(contentsOf: [UInt8(v & 0xff), UInt8(v >> 8 & 0xff)]) }
  func le32(_ v: Int) { le16(v & 0xffff); le16(v >> 16) }
  le16(0); le16(1); le16(frames.count)
  var offset = 6 + 16 * frames.count
  for (size, data) in frames {
    out.append(contentsOf: [UInt8(size % 256), UInt8(size % 256), 0, 0])  // 256 is written as 0
    le16(1); le16(32); le32(data.count); le32(offset)
    offset += data.count
  }
  for (_, data) in frames { out.append(data) }
  return out
}

let mac = "desktop/macos/Runner/Assets.xcassets/AppIcon.appiconset"
for size in [16, 32, 64, 128, 256, 512, 1024] {
  try write(try png(.mac, size), "\(mac)/app_icon_\(size).png")
}
try write(try png(.mac, 256), "desktop/assets/app_icon.png")
try write(try png(.mac, 256), "mobile/assets/app_icon.png")
try write(try png(.mac, 512), "desktop/linux/harness.png")

try write(ico(try [16, 32, 48, 256].map { ($0, try png(.tile, $0)) }), "desktop/windows/runner/resources/app_icon.ico")

for (density, size) in [("mdpi", 48), ("hdpi", 72), ("xhdpi", 96), ("xxhdpi", 144), ("xxxhdpi", 192)] {
  try write(try png(.tile, size), "mobile/android/app/src/main/res/mipmap-\(density)/ic_launcher.png")
}

// Read the iOS slots from Contents.json so a slot added there is never left on the old icon.
let ios = "mobile/ios/Runner/Assets.xcassets/AppIcon.appiconset"
struct Slot: Decodable { let size: String; let scale: String; let filename: String? }
struct Catalog: Decodable { let images: [Slot] }
let catalog = try JSONDecoder().decode(Catalog.self,
  from: Data(contentsOf: root.appendingPathComponent("\(ios)/Contents.json")))
var rendered = Set<String>()
for slot in catalog.images {
  guard let filename = slot.filename, rendered.insert(filename).inserted else { continue }
  let points = Double(slot.size.split(separator: "x")[0])!
  let scale = Double(slot.scale.dropLast())!
  try write(try png(.square, Int((points * scale).rounded())), "\(ios)/\(filename)")
}
