// Appended to the actual native source by check_swarm_titlebar.sh.
// No Flutter engine, window, timer, connection, or saved workspace is opened.
// Measures eight tabs' geometry and offscreen activity drawing, not app energy.
private extension SwarmTabButton {
  func activityGeometryForBenchmark(_ tick: Int) -> Double {
    activityFrame = tick % 10
    return Double(activityRect.minX + activityRect.width + preferredWidth)
  }
}

private func tabBenchmarkDistribution(_ values: [Double]) -> [String: Double] {
  let sorted = values.sorted()
  return ["medianMs": sorted[sorted.count / 2],
          "minMs": sorted[0], "maxMs": sorted.last!]
}

let tabBenchmarkApp = NSApplication.shared
tabBenchmarkApp.setActivationPolicy(.prohibited)
tabBenchmarkApp.appearance = NSAppearance(named: .darkAqua)
private let tabBenchmarkViews = (0..<8).map { index -> SwarmTabButton in
  let tab = SwarmTabButton(id: "fixture-\(index)")
  tab.name = ["desktop office", "desktop m2", "device", "tui", "swarm", "daemons", "growth", "New Tab"][index]
  tab.displayLabel = tab.name
  tab.shortcutHint = "⌘\(index + 1)"
  tab.activity = HarnessNativeActivity(["mark": "⠋", "label": "Working",
    "working": true, "color": Int64(0xff64d2ff)])
  tab.frame = NSRect(x: 0, y: 0, width: tab.preferredWidth, height: 40)
  tab.layoutSubtreeIfNeeded()
  return tab
}
let tabBenchmarkBitmap = NSBitmapImageRep(bitmapDataPlanes: nil,
  pixelsWide: 280, pixelsHigh: 40, bitsPerSample: 8, samplesPerPixel: 4,
  hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB,
  bytesPerRow: 0, bitsPerPixel: 0)!
var tabBenchmarkChecksum = 0.0
var tabBenchmarkResults: [String: Any] = [:]
for drawing in [false, true] {
  let frames = drawing ? 80 : 400
  var observations: [Double] = []
  for sample in -2..<9 {
    let start = ProcessInfo.processInfo.systemUptime
    autoreleasepool {
      if drawing {
        NSGraphicsContext.saveGraphicsState()
        NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: tabBenchmarkBitmap)
      }
      defer { if drawing { NSGraphicsContext.restoreGraphicsState() } }
      for tick in 0..<frames {
        for tab in tabBenchmarkViews {
          tabBenchmarkChecksum += tab.activityGeometryForBenchmark(tick)
          if drawing { tab.draw(tab.bounds) }
        }
      }
    }
    if sample >= 0 {
      observations.append((ProcessInfo.processInfo.systemUptime - start) * 1000)
    }
  }
  tabBenchmarkResults[drawing ? "offscreenDrawing" : "geometry"] = [
    "framesPerSample": frames, "tabsPerFrame": tabBenchmarkViews.count,
    "samplesMs": observations, "distribution": tabBenchmarkDistribution(observations),
  ]
}
precondition(tabBenchmarkApp.windows.isEmpty)
tabBenchmarkResults["kind"] = "native_optimized_geometry_and_offscreen_drawing"
tabBenchmarkResults["checksum"] = tabBenchmarkChecksum
tabBenchmarkResults["os"] = ProcessInfo.processInfo.operatingSystemVersionString
let tabBenchmarkData = try JSONSerialization.data(withJSONObject: tabBenchmarkResults, options: [.sortedKeys])
print(String(data: tabBenchmarkData, encoding: .utf8)!)
