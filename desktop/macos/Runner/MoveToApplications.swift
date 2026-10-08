import Cocoa
import DiskArbitration
import Security

/// Offers to move Harness into Applications when it was opened from inside the disk image.
///
/// A first-time Mac user often double-clicks Harness inside the disk image window instead of
/// dragging it onto Applications. It works that day. After the image is ejected or the Mac
/// restarts there is no Harness to reopen (it is not in Applications, Launchpad or Spotlight),
/// and the updater cannot replace a bundle on a read-only volume. Asked before the engine starts,
/// so a move never interrupts the first-run setup; the copy then opens and the image is ejected.
///
/// The relaunch is a plain `open`: a harness:// link or an `open --env` variable that started the
/// image's copy does not reach the moved one. Both are rare on a first open from the image.
enum MoveToApplications {
  private static let declinedKey = "HarnessMoveToApplicationsDeclined"

  /// Returns when Harness should keep starting from where it is; exits after a move.
  static func offerIfNeeded() {
    if ProcessInfo.processInfo.environment["FLUTTER_TEST"] != nil { return }

    let running = Bundle.main.bundleURL
    // Only the disk image: the website hands out nothing else, and moving a copy out of Downloads
    // or Desktop would add macOS's own "access files in your Downloads folder" prompt.
    guard let volume = diskImageVolume(of: originalURL(of: running)),
          let bundleID = Bundle.main.bundleIdentifier else { return }
    let installed = installedCopy(of: bundleID, named: running.lastPathComponent)
    let others = NSRunningApplication.runningApplications(withBundleIdentifier: bundleID)
      .filter { $0.processIdentifier != ProcessInfo.processInfo.processIdentifier }

    // People keep the disk image in Downloads and open Harness from it again on later days. When
    // Applications has this build or a newer one, that is the Harness they mean.
    if let installed, isSameOrNewer(installed, than: running) {
      if let open = others.first {
        open.activate(options: [])
        exit(0)
      }
      if relaunch(installed, ejecting: volume) { exit(0) }
      return
    }
    // An older Harness an administrator put in /Applications cannot be replaced by a standard
    // user; asking would end in an error they cannot act on, on every open from the image.
    if let installed, !FileManager.default.isDeletableFile(atPath: installed.path) {
      return stepAside(for: others)
    }
    if UserDefaults.standard.bool(forKey: declinedKey) { return stepAside(for: others) }

    NSApp.activate(ignoringOtherApps: true)
    let alert = NSAlert()
    let quitsFirst = others.isEmpty ? "" : " The Harness that is open now quits first."
    if installed == nil {
      alert.messageText = "Move Harness to Applications?"
      alert.informativeText = "Harness is running from the disk image. In Applications it stays "
        + "after you eject the disk image or restart, opens from Launchpad and Spotlight, and can "
        + "update itself." + quitsFirst
      alert.addButton(withTitle: "Move to Applications")
    } else {
      alert.messageText = "Replace the Harness in Applications?"
      alert.informativeText = "Applications has an older or different Harness. This one replaces "
        + "it, and the old one goes to the Trash." + quitsFirst
      alert.addButton(withTitle: "Replace")
    }
    alert.addButton(withTitle: "Not Now")
    alert.showsSuppressionButton = true
    alert.suppressionButton?.title = "Don't ask again"
    guard alert.runModal() == .alertFirstButtonReturn else {
      // Only a declined prompt is remembered, and it only hides the prompt: opening the image's
      // copy later still goes to an installed Harness.
      if alert.suppressionButton?.state == .on {
        UserDefaults.standard.set(true, forKey: declinedKey)
      }
      return stepAside(for: others)
    }

    let destination = installed
      ?? applicationsFolder().appendingPathComponent(running.lastPathComponent)
    var staging: URL?
    do {
      // From the running bundle, which is this app's own even when Gatekeeper translocated it.
      let copy = try stage(running, beside: destination)
      staging = copy.deletingLastPathComponent()
      // Only with a whole copy ready does the open Harness have to quit, so a failed copy never
      // closes it.
      try quit(others)
      try place(copy, at: destination, bundleID: bundleID)
      try? FileManager.default.removeItem(at: staging!)
    } catch {
      if let staging { try? FileManager.default.removeItem(at: staging) }
      let failed = NSAlert()
      failed.messageText = "Harness could not be moved to Applications"
      failed.informativeText =
        "\(error.localizedDescription)\n\nYou can drag Harness to Applications yourself. "
        + "It will keep running from here for now."
      failed.runModal()
      return
    }
    if relaunch(destination, ejecting: volume) { exit(0) }
  }

  /// Two desktop apps on one daemon fight over it; when Harness is already open elsewhere and this
  /// copy is not taking its place, that one comes forward and this one quits.
  private static func stepAside(for others: [NSRunningApplication]) {
    guard let open = others.first else { return }
    open.activate(options: [])
    exit(0)
  }

  /// The mounted volume a disk image put the app on, to eject after the move. DiskArbitration
  /// says whether it is one: a read-only NTFS drive, network share or backup volume also sits
  /// under /Volumes, and ejecting it would unmount the person's own disk.
  private static func diskImageVolume(of url: URL) -> URL? {
    guard url.path.hasPrefix("/Volumes/"),
          let values = try? url.resourceValues(forKeys: [.volumeIsReadOnlyKey, .volumeURLKey]),
          values.volumeIsReadOnly == true, let volume = values.volume,
          let session = DASessionCreate(kCFAllocatorDefault),
          let disk = DADiskCreateFromVolumePath(kCFAllocatorDefault, session, volume as CFURL),
          let description = DADiskCopyDescription(disk) as? [String: Any],
          // macOS 26 reports such an image as model "Disk Image", protocol "Virtual Interface".
          description[kDADiskDescriptionDeviceModelKey as String] as? String == "Disk Image"
            || (description[kDADiskDescriptionDevicePathKey as String] as? String)?
              .contains("AppleDiskImage") == true
    else { return nil }
    return volume
  }

  /// This app's copy in /Applications or ~/Applications: same bundle identifier, and an
  /// executable that is really there.
  private static func installedCopy(of bundleID: String, named name: String) -> URL? {
    let home = FileManager.default.homeDirectoryForCurrentUser
    let ownApplications = home.appendingPathComponent("Applications", isDirectory: true)
    let candidates = [
      URL(fileURLWithPath: "/Applications", isDirectory: true).appendingPathComponent(name),
      ownApplications.appendingPathComponent(name),
    ] + NSWorkspace.shared.urlsForApplications(withBundleIdentifier: bundleID).filter {
      let folder = $0.deletingLastPathComponent().standardizedFileURL.path
      return folder == "/Applications" || folder == ownApplications.standardizedFileURL.path
    }
    return candidates.first { app in
      guard let bundle = Bundle(url: app), bundle.bundleIdentifier == bundleID,
            let executable = bundle.executableURL else { return false }
      return FileManager.default.isExecutableFile(atPath: executable.path)
    }
  }

  /// A newer version, or this very build. Internal builds carry the next release's version, so
  /// an equal version is the same build only when the code signatures match too: the code
  /// directory hash covers the runner executable and Info.plist, which CodeResources does not.
  private static func isSameOrNewer(_ installed: URL, than running: URL) -> Bool {
    guard let theirs = version(of: installed), let ours = version(of: running) else { return false }
    switch theirs.compare(ours, options: .numeric) {
    case .orderedDescending: return true
    case .orderedAscending: return false
    case .orderedSame:
      guard let theirs = codeHash(of: installed), let ours = codeHash(of: running) else { return true }
      return theirs == ours
    }
  }

  private static func codeHash(of app: URL) -> Data? {
    var code: SecStaticCode?
    guard SecStaticCodeCreateWithPath(app as CFURL, [], &code) == errSecSuccess, let code
    else { return nil }
    var info: CFDictionary?
    guard SecCodeCopySigningInformation(code, [], &info) == errSecSuccess,
          let info = info as? [String: Any] else { return nil }
    return info[kSecCodeInfoUnique as String] as? Data
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
    return FileManager.default.homeDirectoryForCurrentUser
      .appendingPathComponent("Applications", isDirectory: true)
  }

  /// Asks the other open Harness to quit, so its bundle can be replaced, and waits up to 10 s.
  private static func quit(_ apps: [NSRunningApplication]) throws {
    guard !apps.isEmpty else { return }
    let pids = apps.map(\.processIdentifier)
    apps.forEach { $0.terminate() }
    // Polled with kill(0) rather than isTerminated, which LaunchServices updates on a run loop
    // this app has not started yet.
    func running() -> Bool { pids.contains { kill($0, 0) == 0 || errno == EPERM } }
    let deadline = Date().addingTimeInterval(10)
    while running() && Date() < deadline { usleep(100_000) }
    if running() {
      throw failure("The Harness that is already open did not quit. Quit it, then open this one again.")
    }
  }

  /// Copies into a staging folder on the destination's volume, so a copy that fails or is
  /// interrupted (171 MB from a compressed image) never leaves a partial Harness in Applications.
  /// Returns the whole copy, ready to rename into place.
  private static func stage(_ source: URL, beside destination: URL) throws -> URL {
    let files = FileManager.default
    let folder = destination.deletingLastPathComponent()
    try files.createDirectory(at: folder, withIntermediateDirectories: true)
    let staging = try files.url(
      for: .itemReplacementDirectory, in: .userDomainMask, appropriateFor: folder, create: true)
    let copy = staging.appendingPathComponent(destination.lastPathComponent)
    do {
      try files.copyItem(at: source, to: copy)
      // The person already confirmed opening this download once. A copy that kept the image's
      // quarantine mark would be translocated again from Applications, where the updater could
      // not replace it, so a failure here fails the move.
      let xattr = Process()
      xattr.executableURL = URL(fileURLWithPath: "/usr/bin/xattr")
      xattr.arguments = ["-d", "-r", "com.apple.quarantine", copy.path]
      try xattr.run()
      xattr.waitUntilExit()
      guard xattr.terminationStatus == 0 else {
        throw failure("Its download mark could not be cleared (xattr exited \(xattr.terminationStatus)).")
      }
    } catch {
      try? files.removeItem(at: staging)
      throw error
    }
    return copy
  }

  /// Renames the staged copy into place. An older Harness there first steps aside under another
  /// name, so there is never a moment with none installed; it comes back if the new one cannot
  /// go in, and otherwise goes to the Trash, where it stays recoverable.
  private static func place(_ copy: URL, at destination: URL, bundleID: String) throws {
    let files = FileManager.default
    guard files.fileExists(atPath: destination.path) else {
      try files.moveItem(at: copy, to: destination)
      return
    }
    guard Bundle(url: destination)?.bundleIdentifier == bundleID else {
      throw failure("Applications already has a different app called \(destination.lastPathComponent).")
    }
    let previous = destination.deletingLastPathComponent().appendingPathComponent(
      "\(destination.deletingPathExtension().lastPathComponent) (previous).app")
    if files.fileExists(atPath: previous.path) {
      try files.trashItem(at: previous, resultingItemURL: nil)
    }
    try files.moveItem(at: destination, to: previous)
    do {
      try files.moveItem(at: copy, to: destination)
    } catch {
      try? files.moveItem(at: previous, to: destination)
      throw error
    }
    try? files.trashItem(at: previous, resultingItemURL: nil)
  }

  /// Opens the moved copy once this process is gone, then ejects the image it came from. False
  /// when the helper could not start, and Harness keeps running from the image instead.
  private static func relaunch(_ app: URL, ejecting volume: URL) -> Bool {
    let pid = ProcessInfo.processInfo.processIdentifier
    // A translocated copy keeps the image busy through its nullfs mount for a moment after it
    // exits (seen in a fresh macOS 26 VM: the first detach failed, one a second later worked).
    let script = "while /bin/kill -0 \(pid) 2>/dev/null; do /bin/sleep 0.1; done; "
      + "/usr/bin/open \(quoted(app.path)) && "
      + "for _ in 1 2 3 4 5 6 7 8 9 10; do "
      + "/usr/bin/hdiutil detach \(quoted(volume.path)) -quiet && break; /bin/sleep 1; done"
    let shell = Process()
    shell.executableURL = URL(fileURLWithPath: "/bin/sh")
    shell.arguments = ["-c", script]
    do {
      try shell.run()
      return true
    } catch {
      return false
    }
  }

  private static func quoted(_ text: String) -> String {
    "'" + text.replacingOccurrences(of: "'", with: "'\\''") + "'"
  }

  private static func failure(_ reason: String) -> NSError {
    NSError(domain: "MoveToApplications", code: 1, userInfo: [NSLocalizedDescriptionKey: reason])
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
