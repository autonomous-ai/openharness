import Flutter
import SafariServices
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
    ClipboardImageChannel.register(with: engineBridge.pluginRegistry)
    SignInPageChannel.register(with: engineBridge.pluginRegistry)
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

/// `harness/sign_in_page` — the SSO page, in an SFSafariViewController over the app (Dart:
/// `lib/viewer/sign_in_browser.dart`). url_launcher's in-app page tells Dart nothing once its first
/// load is over, so a page closed with Done left its sign-in waiting out five minutes behind
/// "Waiting for Google…" and a Cancel. Here Done — or a swipe down — is said back: `closed`, with the
/// id Dart opened the page with.
///
/// `open` answers once the page is on its way up; `close` takes it down and says nothing, since Dart
/// asked.
final class SignInPageChannel: NSObject, SFSafariViewControllerDelegate,
  UIAdaptivePresentationControllerDelegate
{
  private static var shared: SignInPageChannel?

  private let registrar: FlutterPluginRegistrar
  private let channel: FlutterMethodChannel
  /// The page up now, and the id Dart opened it with; nil once it is closed or taken down.
  private var page: (controller: SFSafariViewController, id: Int)?

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
      if let controller = take() { Self.takeDown(controller, animated: true) }
      result(nil)
    default:
      result(FlutterMethodNotImplemented)
    }
  }

  private func open(_ url: URL, id: Int, result: @escaping FlutterResult) {
    // One page at a time: one an earlier sign-in left up goes first, without a word to Dart.
    guard let old = take(), old.presentingViewController != nil else {
      present(url, id: id, result: result)
      return
    }
    Self.takeDown(old, animated: false) { self.present(url, id: id, result: result) }
  }

  private func present(_ url: URL, id: Int, result: @escaping FlutterResult) {
    var presenter = registrar.viewController
    while let presented = presenter?.presentedViewController, !presented.isBeingDismissed {
      presenter = presented
    }
    guard let presenter else {
      result(FlutterError(code: "no-ui", message: "Nothing on screen to open it over", details: nil))
      return
    }
    let controller = SFSafariViewController(url: url)
    controller.delegate = self
    // Shown as a sheet, it can also be swiped away, which its own delegate does not hear.
    controller.presentationController?.delegate = self
    page = (controller, id)
    presenter.present(controller, animated: true)
    result(nil)
  }

  /// The page, no longer this channel's to watch.
  private func take() -> SFSafariViewController? {
    let controller = page?.controller
    page = nil
    return controller
  }

  /// Dismisses [controller] — once it is up, when it is still animating in: UIKit drops a dismiss
  /// made during a presentation, and the page would stay up over a sign-in that had ended.
  private static func takeDown(
    _ controller: UIViewController, animated: Bool, then: (() -> Void)? = nil
  ) {
    if controller.isBeingPresented, let coordinator = controller.transitionCoordinator,
      coordinator.animate(
        alongsideTransition: nil,
        completion: { _ in controller.dismiss(animated: animated, completion: then) })
    {
      return
    }
    controller.dismiss(animated: animated, completion: then)
  }

  /// The person closed [controller] — if it is still the page up, Dart is told.
  private func closedByPerson(_ controller: UIViewController) {
    guard let page, page.controller === controller else { return }
    self.page = nil
    channel.invokeMethod("closed", arguments: page.id)
  }

  // Done. The dismiss is url_launcher's own: harmless when the page has already gone by itself.
  func safariViewControllerDidFinish(_ controller: SFSafariViewController) {
    closedByPerson(controller)
    controller.dismiss(animated: true)
  }

  func presentationControllerDidDismiss(_ presentationController: UIPresentationController) {
    closedByPerson(presentationController.presentedViewController)
  }
}
