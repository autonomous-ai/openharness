import AVFoundation
import AudioToolbox
import AuthenticationServices
import Flutter
import Speech
import UIKit
import UserNotifications

@main
@objc class AppDelegate: FlutterAppDelegate, FlutterImplicitEngineDelegate {
  override func application(
    _ application: UIApplication,
    didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?
  ) -> Bool {
    // The "agent finished" notice (Dart: `lib/notify/system_notices.dart`): a tap on it has to reach
    // flutter_local_notifications, which only hears it while the app delegate is the centre's delegate.
    UNUserNotificationCenter.current().delegate = self as? UNUserNotificationCenterDelegate
    return super.application(application, didFinishLaunchingWithOptions: launchOptions)
  }

  func didInitializeImplicitFlutterEngine(_ engineBridge: FlutterImplicitEngineBridge) {
    GeneratedPluginRegistrant.register(with: engineBridge.pluginRegistry)
    DeviceNameChannel.register(with: engineBridge.pluginRegistry)
    InstallSourceChannel.register(with: engineBridge.pluginRegistry)
    ClipboardImageChannel.register(with: engineBridge.pluginRegistry)
    SignInPageChannel.register(with: engineBridge.pluginRegistry)
    HandoffChannel.register(with: engineBridge.pluginRegistry)
    ChimeChannel.register(with: engineBridge.pluginRegistry)
    AppBadgeChannel.register(with: engineBridge.pluginRegistry)
    DictationChannel.register(with: engineBridge.pluginRegistry)
  }
}

/// `harness/dictation` — the phone's own speech recognizer, the one the keyboard's dictation uses
/// (Dart: `SwarmChannelDictation` in `lib/swarm/swarm_dictation.dart`): a Swarm chat's message box
/// fills with the words as they are said.
///
/// `access` asks for speech recognition, then the microphone, the first time, and answers `allowed`,
/// `denied` (speech recognition refused or restricted: Dart records and has the backend transcribe,
/// as before) or `noMic`. `start` takes Dart's `take` and a `locale`, and answers false when the
/// phone has no recognizer for it now. Then, each with the take: `words` (everything heard so far,
/// revised as it goes), `level` (the microphone's RMS, ten a second) and once `end` — `done`,
/// `noSpeech` or `failed`. `stop` ends listening, and the last words and the end follow; `cancel`
/// ends it with nothing more said.
///
/// ⚠️ **On the phone wherever it can be.** `requiresOnDeviceRecognition` whenever the recognizer
/// supports the language on this phone; only where it does not does the audio go to Apple to be
/// recognized, as the keyboard's dictation does. Nothing heard is logged or kept here.
final class DictationChannel {
  private static var shared: DictationChannel?

  private let channel: FlutterMethodChannel

  /// The take listening now. Its audio goes from the engine's tap into the request; the recognizer
  /// is held for as long as its task runs.
  private var current:
    (
      take: Int, recognizer: SFSpeechRecognizer, engine: AVAudioEngine,
      request: SFSpeechAudioBufferRecognitionRequest, task: SFSpeechRecognitionTask
    )?

  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "HarnessDictation")?.messenger() else { return }
    shared = DictationChannel(messenger: messenger)
  }

  private init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "harness/dictation", binaryMessenger: messenger)
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    let arguments = call.arguments as? [String: Any]
    let take = arguments?["take"] as? Int
    switch call.method {
    case "access":
      Self.access { result($0) }
    case "start":
      guard let take, let locale = arguments?["locale"] as? String else {
        result(FlutterError(code: "bad-args", message: "A take and a locale", details: nil))
        return
      }
      result(start(take, locale: locale))
    case "stop":
      if let current, current.take == take {
        // The last words, then the end, come through the task.
        current.engine.stop()
        current.engine.inputNode.removeTap(onBus: 0)
        current.request.endAudio()
      }
      result(nil)
    case "cancel":
      if current?.take == take { finish(nil) }
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  /// Speech recognition, then the microphone: asked the first time, and answered at once after.
  private static func access(_ answer: @escaping (String) -> Void) {
    SFSpeechRecognizer.requestAuthorization { status in
      guard status == .authorized else {
        DispatchQueue.main.async { answer("denied") }
        return
      }
      let microphone: (Bool) -> Void = { granted in
        DispatchQueue.main.async { answer(granted ? "allowed" : "noMic") }
      }
      if #available(iOS 17.0, *) {
        AVAudioApplication.requestRecordPermission(completionHandler: microphone)
      } else {
        AVAudioSession.sharedInstance().requestRecordPermission(microphone)
      }
    }
  }

  /// Listens for [take] in [locale]. False, with nothing open, when it cannot.
  private func start(_ take: Int, locale: String) -> Bool {
    finish(nil)
    guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
      recognizer.isAvailable
    else { return false }
    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.taskHint = .dictation
    if recognizer.supportsOnDeviceRecognition { request.requiresOnDeviceRecognition = true }
    if #available(iOS 16.0, *) { request.addsPunctuation = true }

    let session = AVAudioSession.sharedInstance()
    let engine = AVAudioEngine()
    let input = engine.inputNode
    do {
      try session.setCategory(.record, mode: .measurement, options: .duckOthers)
      try session.setActive(true, options: .notifyOthersOnDeactivation)
      let format = input.outputFormat(forBus: 0)
      guard format.sampleRate > 0, format.channelCount > 0 else {
        try? session.setActive(false, options: .notifyOthersOnDeactivation)
        return false
      }
      var measured = 0.0
      input.installTap(onBus: 0, bufferSize: 1024, format: format) { [weak self] buffer, _ in
        request.append(buffer)
        let now = CACurrentMediaTime()
        guard now - measured >= 0.1, let rms = Self.rms(buffer) else { return }
        measured = now
        DispatchQueue.main.async {
          guard let self, self.current?.take == take else { return }
          self.channel.invokeMethod("level", arguments: ["take": take, "rms": rms])
        }
      }
      engine.prepare()
      try engine.start()
    } catch {
      input.removeTap(onBus: 0)
      try? session.setActive(false, options: .notifyOthersOnDeactivation)
      return false
    }

    let task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      let text = result?.bestTranscription.formattedString
      let final = result?.isFinal ?? false
      // "No speech detected": stopped, or given up, before a word was heard.
      let silent = (error as NSError?).map { $0.domain == "kAFAssistantErrorDomain" && $0.code == 1110 }
      DispatchQueue.main.async {
        guard let self, self.current?.take == take else { return }
        if let text { self.channel.invokeMethod("words", arguments: ["take": take, "text": text]) }
        if final {
          self.finish("done")
        } else if let silent {
          self.finish(silent ? "noSpeech" : "failed")
        }
      }
    }
    current = (take, recognizer, engine, request, task)
    return true
  }

  /// Closes the take listening now, and says how it ended — or nothing, for a cancel.
  private func finish(_ end: String?) {
    guard let current else { return }
    self.current = nil
    if end == nil { current.task.cancel() }
    current.engine.stop()
    current.engine.inputNode.removeTap(onBus: 0)
    current.request.endAudio()
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    if let end { channel.invokeMethod("end", arguments: ["take": current.take, "end": end]) }
  }

  /// How loud [buffer] is, 0…1 of full scale.
  private static func rms(_ buffer: AVAudioPCMBuffer) -> Double? {
    guard let samples = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return nil }
    let count = Int(buffer.frameLength)
    var sum: Float = 0
    for index in 0..<count { sum += samples[index] * samples[index] }
    return Double((sum / Float(count)).squareRoot())
  }
}

/// `harness/app_badge` — the app icon's count (Dart: `setSwarmBadge` in `lib/notify/system_notices.dart`):
/// what the Swarms ask of the person, the drawer's waiting count. `set` takes the count; zero takes it
/// off. Drawn only where the person allowed badges with the notification prompt.
enum AppBadgeChannel {
  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "HarnessAppBadge")?.messenger() else { return }
    let channel = FlutterMethodChannel(name: "harness/app_badge", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "set" else { result(FlutterMethodNotImplemented); return }
      guard let count = call.arguments as? Int, count >= 0 else {
        result(FlutterError(code: "bad_count", message: "A count of zero or more.", details: nil))
        return
      }
      if #available(iOS 16.0, *) {
        // The completion can run off the main thread; Flutter is answered on it.
        UNUserNotificationCenter.current().setBadgeCount(count) { error in
          DispatchQueue.main.async {
            result(error.map { FlutterError(code: "badge", message: $0.localizedDescription, details: nil) })
          }
        }
      } else {
        UIApplication.shared.applicationIconBadgeNumber = count
        result(nil)
      }
    }
  }
}

/// `harness/chime` — a short sound the app plays of its own (Dart: `lib/core/chime.dart`): the two
/// glass notes when a computer joins during the onboarding.
///
/// Through System Sound Services, not an audio player: a system sound is silenced by the Ring/Silent
/// switch — muted means silent, as the onboarding asks — and plays without touching the audio
/// session, which belongs to the voice input's recorder. `play` takes the Flutter asset's name, and
/// answers whether it played; each sound is loaded once and kept.
enum ChimeChannel {
  private static var sounds: [String: SystemSoundID] = [:]

  static func register(with registry: FlutterPluginRegistry) {
    guard let registrar = registry.registrar(forPlugin: "HarnessChime") else { return }
    let channel = FlutterMethodChannel(name: "harness/chime", binaryMessenger: registrar.messenger())
    channel.setMethodCallHandler { call, result in
      guard call.method == "play" else { result(FlutterMethodNotImplemented); return }
      guard let asset = call.arguments as? String else { result(false); return }
      if let sound = ChimeChannel.sounds[asset] {
        AudioServicesPlaySystemSound(sound)
        result(true)
        return
      }
      let key = registrar.lookupKey(forAsset: asset)
      guard let path = Bundle.main.path(forResource: key, ofType: nil) else { result(false); return }
      var sound: SystemSoundID = 0
      guard AudioServicesCreateSystemSoundID(URL(fileURLWithPath: path) as CFURL, &sound) == kAudioServicesNoError
      else { result(false); return }
      ChimeChannel.sounds[asset] = sound
      AudioServicesPlaySystemSound(sound)
      result(true)
    }
  }
}

/// `harness/handoff` — a web page offered to the person's other Apple devices (Dart:
/// `lib/core/handoff.dart`). While the onboarding's "On your computer, go to" is up, a Mac nearby
/// signed in to the same Apple account shows the download page in its Dock.
///
/// `offer` takes the page's https address and makes it the current activity; `withdraw` ends it.
/// The activity is held here, since nothing else keeps it alive, and replaced by each `offer` —
/// Dart offers again whenever the app comes back to the front, where iOS has stopped advertising.
enum HandoffChannel {
  private static var activity: NSUserActivity?

  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "HarnessHandoff")?.messenger() else { return }
    let channel = FlutterMethodChannel(name: "harness/handoff", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      switch call.method {
      case "offer":
        // Only a web page: Handoff opens it in the other device's browser, and that takes https.
        guard let text = call.arguments as? String, let url = URL(string: text),
          url.scheme == "https"
        else {
          result(FlutterError(code: "bad-url", message: "Not an https address", details: nil))
          return
        }
        HandoffChannel.activity?.invalidate()
        let offered = NSUserActivity(activityType: NSUserActivityTypeBrowsingWeb)
        offered.webpageURL = url
        offered.isEligibleForHandoff = true
        offered.becomeCurrent()
        HandoffChannel.activity = offered
        result(nil)
      case "withdraw":
        HandoffChannel.activity?.invalidate()
        HandoffChannel.activity = nil
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }
}

/// `harness/clipboard_image` — the image on the clipboard, as PNG bytes (Dart:
/// `lib/clipboard/native_clipboard.dart`). Flutter's own clipboard reads `text/plain` only, so a
/// screenshot or a "Copy" from Photos was invisible to Paste. The same channel the desktop runners
/// answer; only `readImagePng` and `hasImage` are implemented here, since nothing on the phone
/// writes an image.
enum ClipboardImageChannel {
  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "HarnessClipboardImage")?.messenger() else { return }
    let channel = FlutterMethodChannel(name: "harness/clipboard_image", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      // Whether an image is there, for the key strip's `paste` (Dart: `phone/terminal_key_bar.dart`),
      // which is asked about every second while the keyboard is up. `hasImages` never brings up the
      // system's paste prompt: only reading the image does.
      if call.method == "hasImage" {
        result(UIPasteboard.general.hasImages)
        return
      }
      guard call.method == "readImagePng" else { result(FlutterMethodNotImplemented); return }
      // `hasImages` answers without the system's paste prompt, so an empty clipboard never asks.
      let pasteboard = UIPasteboard.general
      guard pasteboard.hasImages else { result(nil); return }
      // An existing PNG is passed through untouched; anything else (a JPEG or HEIC from Photos) is
      // re-encoded, which for a full-size photo is slow enough to keep off the main thread.
      if let png = pasteboard.data(forPasteboardType: "public.png") {
        result(FlutterStandardTypedData(bytes: png))
        return
      }
      // From here an image IS on the clipboard, so a failure answers EMPTY bytes rather than nil:
      // Dart then says the image is unreadable instead of that there is nothing to paste.
      let unreadable = FlutterStandardTypedData(bytes: Data())
      guard let image = pasteboard.image else { result(unreadable); return }
      DispatchQueue.global(qos: .userInitiated).async {
        let png = image.pngData()
        DispatchQueue.main.async {
          result(png.map { FlutterStandardTypedData(bytes: $0) } ?? unreadable)
        }
      }
    }
  }
}

/// `harness/install_source` — whether this build came from the App Store, for the measurement
/// context's channel (Dart: `lib/core/install_source.dart`): a tester's counts are kept apart. An App
/// Store build's receipt is named `receipt`; TestFlight's, and any build Xcode installed, `sandboxReceipt`.
/// Only the file's name is read, never the receipt, and only `store` or `sandbox` goes back.
enum InstallSourceChannel {
  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "HarnessInstallSource")?.messenger() else { return }
    let channel = FlutterMethodChannel(name: "harness/install_source", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "source" else { result(FlutterMethodNotImplemented); return }
      let sandbox = Bundle.main.appStoreReceiptURL?.lastPathComponent == "sandboxReceipt"
      result(sandbox ? "sandbox" : "store")
    }
  }
}

/// `harness/device_name` — what this phone is called, for the far side's "took control" banner
/// (Dart: `lib/core/device_name.dart`). `name` is the user's own name for the device where iOS still
/// hands it out (before iOS 16, or with Apple's user-assigned-device-name entitlement); otherwise it
/// is the generic "iPhone" and Dart falls back to the model, read off the hardware code.
enum DeviceNameChannel {
  static func register(with registry: FlutterPluginRegistry) {
    guard let messenger = registry.registrar(forPlugin: "HarnessDeviceName")?.messenger() else { return }
    let channel = FlutterMethodChannel(name: "harness/device_name", binaryMessenger: messenger)
    channel.setMethodCallHandler { call, result in
      guard call.method == "describe" else { result(FlutterMethodNotImplemented); return }
      result([
        "name": UIDevice.current.name,
        "model": UIDevice.current.model,
        "modelCode": modelCode(),
        "manufacturer": "Apple",
      ])
    }
  }

  /// "iPhone16,1" — the hardware identifier; on the simulator, the device it is pretending to be.
  private static func modelCode() -> String {
    if let simulated = ProcessInfo.processInfo.environment["SIMULATOR_MODEL_IDENTIFIER"], !simulated.isEmpty {
      return simulated
    }
    var systemInfo = utsname()
    uname(&systemInfo)
    return withUnsafePointer(to: &systemInfo.machine) {
      $0.withMemoryRebound(to: CChar.self, capacity: 1) { String(validatingCString: $0) ?? "" }
    }
  }
}

/// `harness/sign_in_page` — the SSO page, in an ASWebAuthenticationSession over the app (Dart:
/// `lib/viewer/sign_in_browser.dart`).
///
/// Not an SFSafariViewController, as it was: since iOS 11 that keeps cookies of its own, apart from
/// Safari's, so the Google accounts the phone was signed in to were never there and every "Continue
/// with Google" began on an empty sign-in form. This session shares Safari's — not ephemeral — at
/// the price of iOS's "“Harness” Wants to Use … to Sign In" before the page.
///
/// The page's last screen goes on to [returnScheme] (Dart: `signInReturnUrl`), and the session takes
/// the page down there by itself. Cancel — the alert's or the page's — is said back: `closed`, with
/// the id Dart opened the page with.
///
/// `open` answers once the page is on its way up; `close` takes it down and says nothing, since Dart
/// asked.
final class SignInPageChannel: NSObject, ASWebAuthenticationPresentationContextProviding {
  private static var shared: SignInPageChannel?

  /// Dart's `signInReturnUrl`: the loopback's last page goes there once the redirect is in.
  private static let returnScheme = "ai.autonomous.harness.signin"

  private let registrar: FlutterPluginRegistrar
  private let channel: FlutterMethodChannel
  /// The page up now, the id Dart opened it with, and its own number here, which is what its session
  /// ends with — Dart's ids start over on a hot restart. Nil once it is closed or taken down.
  private var page: (session: ASWebAuthenticationSession, id: Int, serial: Int)?
  private var serial = 0

  static func register(with registry: FlutterPluginRegistry) {
    guard let registrar = registry.registrar(forPlugin: "HarnessSignInPage") else { return }
    shared = SignInPageChannel(registrar: registrar)
  }

  private init(registrar: FlutterPluginRegistrar) {
    self.registrar = registrar
    channel = FlutterMethodChannel(
      name: "harness/sign_in_page", binaryMessenger: registrar.messenger())
    super.init()
    channel.setMethodCallHandler { [weak self] call, result in
      self?.handle(call, result: result)
    }
  }

  private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
    switch call.method {
    case "open":
      let arguments = call.arguments as? [String: Any]
      guard let id = arguments?["id"] as? Int,
        let url = (arguments?["url"] as? String).flatMap(URL.init(string:)),
        let scheme = url.scheme?.lowercased(), scheme == "https" || scheme == "http"
      else {
        result(FlutterError(code: "bad-args", message: "Not a page to open", details: nil))
        return
      }
      open(url, id: id, result: result)
    case "close":
      take()?.cancel()
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func open(_ url: URL, id: Int, result: @escaping FlutterResult) {
    // One page at a time: one an earlier sign-in left up goes first, without a word to Dart.
    take()?.cancel()
    guard window() != nil else {
      result(FlutterError(code: "no-ui", message: "Nothing on screen to open it over", details: nil))
      return
    }
    serial += 1
    let serial = serial
    let session = ASWebAuthenticationSession(
      url: url, callbackURLScheme: Self.returnScheme
    ) { [weak self] _, error in
      DispatchQueue.main.async { self?.ended(serial, cancelled: error != nil) }
    }
    session.presentationContextProvider = self
    // Safari's cookies, and with them the accounts the phone is already signed in to.
    session.prefersEphemeralWebBrowserSession = false
    page = (session, id, serial)
    guard session.start() else {
      page = nil
      result(FlutterError(code: "no-ui", message: "The sign-in page would not open", details: nil))
      return
    }
    result(nil)
  }

  /// The page, no longer this channel's to watch.
  private func take() -> ASWebAuthenticationSession? {
    let session = page?.session
    page = nil
    return session
  }

  /// Session [serial] is over. Only a cancel by the person — or an error, which leaves no page either
  /// — is Dart's to hear: at [returnScheme] the redirect is already in, and a `close` was Dart's own.
  private func ended(_ serial: Int, cancelled: Bool) {
    guard let page, page.serial == serial else { return }
    self.page = nil
    if cancelled { channel.invokeMethod("closed", arguments: page.id) }
  }

  /// The app's window, for the page to come up over.
  private func window() -> UIWindow? {
    registrar.viewController?.view.window
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    window() ?? ASPresentationAnchor()
  }
}
