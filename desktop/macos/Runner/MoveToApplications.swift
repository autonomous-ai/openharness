import Cocoa

/// Offers to move Harness into Applications when it was opened from inside the disk image.
///
/// A first-time Mac user often double-clicks Harness inside the disk image window instead of
/// dragging it onto Applications. It works that day. After the image is ejected or the Mac
/// restarts there is no Harness to reopen (it is not in Applications, Launchpad or Spotlight),
/// and the updater cannot replace a bundle on a read-only volume. Asked before the engine starts,
/// so a move never interrupts the first-run setup; the copy then opens and the image is ejected.
enum MoveToApplications {
  private static let declinedKey = "HarnessMoveToApplicationsDeclined"

  /// Returns when Harness should keep starting from where it is; exits after a move.
  static func offerIfNeeded() {
    if ProcessInfo.processInfo.environment["FLUTTER_TEST"] != nil { return }
    if UserDefaults.standard.bool(forKey: declinedKey) { return }

    let running = Bundle.main.bundleURL
    // Only the disk image: the website hands out nothing else, and moving a copy out of Downloads
    // or Desktop would add macOS's own "access files in your Downloads folder" prompt.
    guard let volume = diskImageVolume(of: originalURL(of: running)) else { return }
    let destination = applicationsFolder().appendingPathComponent(running.lastPathComponent)

    // A Harness already in Applications that is running: this second copy has nothing to add.
    if let installed = NSWorkspace.shared.runningApplications.first(where: {
      $0.bundleURL?.standardizedFileURL == destination.standardizedFileURL
    }) {
      installed.activate(options: [])
      exit(0)
    }
    // People keep the disk image in Downloads and open Harness from it again on later days. Once
    // Applications has this version or a newer one, that is the Harness they mean.
    if let installed = version(of: destination), let own = version(of: running),
       installed.compare(own, options: .numeric) != .orderedAscending {
      relaunch(destination, ejecting: volume)
      exit(0)
    }

    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    alert.messageText = "Move Harness to Applications?"
    alert.informativeText = "Harness is running from the disk image. In Applications it stays "
      + "after you eject the disk image or restart, opens from Launchpad and Spotlight, and can "
      + "update itself."
    alert.addButton(withTitle: "Move to Applications")
    alert.addButton(withTitle: "Not Now")
    alert.showsSuppressionButton = true
    alert.suppressionButton?.title = "Don't ask again"
    let answer = alert.runModal()
    if alert.suppressionButton?.state == .on {
      UserDefaults.standard.set(true, forKey: declinedKey)
    }
    guard answer == .alertFirstButtonReturn else { return }

    do {
      // From the running bundle, which is this app's own even when Gatekeeper translocated it.
      try move(from: running, to: destination)
    } catch {
      let failed = NSAlert()
      failed.messageText = "Harness could not be moved to Applications"
      failed.informativeText =
        "\(error.localizedDescription)\n\nYou can drag Harness to Applications yourself. "
        + "It will keep running from here for now."
      failed.runModal()
      return
    }

    // The disk image is ejected only after this process has exited and the copy has opened,
    // since a running app keeps its volume busy.
    relaunch(destination, ejecting: volume)
    exit(0)
  }

  /// The mounted volume a read-only disk image put the app on, to eject after the move. An
  /// external drive someone keeps apps on is writable, so it is never mistaken for one.
  private static func diskImageVolume(of url: URL) -> URL? {
    guard url.path.hasPrefix("/Volumes/"),
          let values = try? url.resourceValues(forKeys: [.volumeIsReadOnlyKey, .volumeURLKey]),
          values.volumeIsReadOnly == true else { return nil }
    return values.volume
  }

  /// "1.2.59+412": the marketing version, then the build number, compared numerically.
  private static func version(of app: URL) -> String? {
    guard let info = Bundle(url: app)?.infoDictionary,
          let short = info["CFBundleShortVersionString"] as? String else { return nil }
    return "\(short)+\(info["CFBundleVersion"] as? String ?? "0")"
  }

  /// /Applications when this user can write there; otherwise their own ~/Applications.
  private static func applicationsFolder() -> URL {
    if FileManager.default.isWritableFile(atPath: "/Applications") {
      return URL(fileURLWithPath: "/Applications", isDirectory: true)
    }
    let own = FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Applications", isDirectory: true)
    try? FileManager.default.createDirectory(at: own, withIntermediateDirectories: true)
    return own
  }

  private static func move(from source: URL, to destination: URL) throws {
    let files = FileManager.default
    if files.fileExists(atPath: destination.path) {
      // An older Harness from an earlier download: the Trash keeps it recoverable.
      try files.trashItem(at: destination, resultingItemURL: nil)
    }
    try files.copyItem(at: source, to: destination)
    // The person already confirmed opening this download once. The copy keeps the image's
    // quarantine mark, and without removing it Gatekeeper would ask again on the next open.
    let xattr = Process()
    xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
    xattr.arguments = ["-d", "-r", "com.apple.quarantine", destination.path]
    try? xattr.run()
    xattr.waitUntilExit()
  }

  /// Opens the moved copy once this process is gone, then ejects the image it came from.
  private static func relaunch(_ app: URL, ejecting volume: URL) {
    let pid = ProcessInfo.processInfo.processIdentifier
    // A translocated copy keeps the image busy through its nullfs mount for a moment after it
    // exits (seen in a fresh macOS 26 VM: the first detach failed, one a second later worked).
    let script = "while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 0.1; done; "
      + "/usr/bin/open \(quoted(app.path)); "
      + "for _ in 1 2 3 4 5 6 7 8 9 10; do "
      + "/usr/bin/hdiutil detach \(quoted(volume.path)) -quiet && break; /bin/sleep 1; done"
    let shell = Process()
    shell.executableURL = URL(fileURLWithPath: "/bin/sh")
    shell.arguments = ["-c", script]
    try? shell.run()
  }

  private static func quoted(_ text: String) -> String {
    "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  /// Gatekeeper runs a quarantined app opened from a downloaded disk image from a randomized
  /// read-only path (App Translocation), a nullfs mount whose source is the original bundle:
  /// `/Volumes/Harness/Harness.app on …/AppTranslocation/<id>`. That source is what tells the
  /// disk image apart.
  private static func originalURL(of url: URL) -> URL {
    guard url.path.contains("/AppTranslocation/") else { return url }
    var volume = statfs()
    guard statfs(url.path, &volume) == 0 else { return url }
    let source = withUnsafeBytes(of: &volume.f_mntfromname) { bytes in
      String(decoding: bytes.prefix(while: { $0 != 0 }), as: UTF8.self)
    }
    guard source.hasPrefix("/") else { return url }
    let original = URL(fileURLWithPath: source)
    return original.pathExtension == "app"
      ? original : original.appendingPathComponent(url.lastPathComponent)
  }
}
