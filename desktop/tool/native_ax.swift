import ApplicationServices
import Cocoa

// Reads and presses the native controls of ONE process, named by its pid,
// through the accessibility API, and names its on-screen window for
// `screencapture -l`. `tool/native_driver.py` builds and runs this for a native
// integration test: AppKit draws the tab row, so a Flutter test can neither
// see nor press it, and a click it synthesised would move the person's pointer.
//
//   native_ax windowid <pid>
//   native_ax list <pid>            every named button in the window
//   native_ax find <pid> <label>
//   native_ax press <pid> <label>
//   native_ax tree <pid>            the first levels of the window, to debug
//
// It needs Accessibility for the terminal that runs it (System Settings ▸
// Privacy & Security). It reads no other process and no screen contents.
func value(_ element: AXUIElement, _ name: String) -> CFTypeRef? {
  var out: CFTypeRef?
  return AXUIElementCopyAttributeValue(element, name as CFString, &out) == .success ? out : nil
}
func text(_ element: AXUIElement, _ name: String) -> String { (value(element, name) as? String) ?? "" }
func frame(_ element: AXUIElement) -> CGRect? {
  guard let p = value(element, kAXPositionAttribute), let s = value(element, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero, size = CGSize.zero
  AXValueGetValue(p as! AXValue, .cgPoint, &point)
  AXValueGetValue(s as! AXValue, .cgSize, &size)
  return CGRect(origin: point, size: size)
}
var visited = 0
func walk(_ element: AXUIElement, _ depth: Int, _ visit: (AXUIElement) -> Void) {
  visited += 1
  if depth > 14 || visited > 6000 { return }
  visit(element)
  // The Flutter view's own tree is not what this reads.
  if text(element, kAXRoleAttribute) == "AXTextArea" { return }
  for child in (value(element, kAXChildrenAttribute) as? [AXUIElement]) ?? [] { walk(child, depth + 1, visit) }
}
func describe(_ element: AXUIElement) -> [String: Any] {
  let rect = frame(element) ?? .zero
  return ["role": text(element, kAXRoleAttribute), "title": text(element, kAXTitleAttribute),
    "label": text(element, kAXDescriptionAttribute), "help": text(element, kAXHelpAttribute),
    "enabled": (value(element, kAXEnabledAttribute) as? Bool) ?? false,
    "x": rect.minX, "y": rect.minY, "w": rect.width, "h": rect.height]
}
func emit(_ object: Any) {
  print(String(data: try! JSONSerialization.data(withJSONObject: object, options: [.sortedKeys]), encoding: .utf8)!)
}
func mainWindow(_ pid: pid_t) -> AXUIElement? {
  let app = AXUIElementCreateApplication(pid)
  return ((value(app, kAXWindowsAttribute) as? [AXUIElement]) ?? []).first
}
func windowInfo(_ pid: pid_t) -> [String: Any]? {
  let all = (CGWindowListCopyWindowInfo([.optionOnScreenOnly, .excludeDesktopElements], kCGNullWindowID) as? [[String: Any]]) ?? []
  return all.first { ($0[kCGWindowOwnerPID as String] as? Int).map { pid_t($0) } == pid && ($0[kCGWindowLayer as String] as? Int) == 0 }
}

let arguments = CommandLine.arguments
guard arguments.count >= 3, let pid = pid_t(arguments[2]) else { emit(["error": "usage"]); exit(2) }
guard AXIsProcessTrusted() else { emit(["error": "accessibility is not allowed for this process"]); exit(3) }
switch arguments[1] {
case "windowid":
  guard let info = windowInfo(pid) else { emit(["error": "no window"]); exit(1) }
  emit(["id": info[kCGWindowNumber as String] as? Int ?? 0, "bounds": info[kCGWindowBounds as String] ?? [:]])
case "list", "find", "press":
  guard let window = mainWindow(pid) else { emit(["error": "no window"]); exit(1) }
  var buttons: [(AXUIElement, [String: Any])] = []
  walk(window, 0) { element in
    guard text(element, kAXRoleAttribute) == "AXButton" else { return }
    let about = describe(element)
    if !(about["label"] as! String).isEmpty || !(about["title"] as! String).isEmpty { buttons.append((element, about)) }
  }
  let bounds = frame(window) ?? .zero
  if arguments[1] == "list" {
    emit(["window": ["x": bounds.minX, "y": bounds.minY, "w": bounds.width, "h": bounds.height],
      "buttons": buttons.map { $0.1 }, "visited": visited])
    break
  }
  guard arguments.count >= 4 else { emit(["error": "usage"]); exit(2) }
  let wanted = arguments[3]
  let hits = buttons.filter { ($0.1["label"] as! String) == wanted || ($0.1["title"] as! String) == wanted }
  guard let hit = hits.first else {
    emit(["found": false, "window": ["x": bounds.minX, "y": bounds.minY, "w": bounds.width, "h": bounds.height]])
    break
  }
  var answer = hit.1
  answer["found"] = true
  answer["count"] = hits.count
  answer["window"] = ["x": bounds.minX, "y": bounds.minY, "w": bounds.width, "h": bounds.height]
  if arguments[1] == "press" {
    answer["pressed"] = AXUIElementPerformAction(hit.0, kAXPressAction as CFString) == .success
  }
  emit(answer)
case "tree":
  guard let window = mainWindow(pid) else { emit(["error": "no window"]); exit(1) }
  var lines: [String] = []
  func dump(_ element: AXUIElement, _ depth: Int) {
    if lines.count > 260 || depth > 9 { return }
    let children = (value(element, kAXChildrenAttribute) as? [AXUIElement]) ?? []
    let rect = frame(element) ?? .zero
    lines.append(String(repeating: "  ", count: depth) + text(element, kAXRoleAttribute) + "/" + text(element, kAXSubroleAttribute)
      + " title=" + text(element, kAXTitleAttribute) + " label=" + text(element, kAXDescriptionAttribute)
      + " [\(Int(rect.minX)),\(Int(rect.minY)) \(Int(rect.width))x\(Int(rect.height))] kids=\(children.count)")
    for child in children { dump(child, depth + 1) }
  }
  dump(window, 0)
  emit(["tree": lines])
default:
  emit(["error": "unknown command"]); exit(2)
}
