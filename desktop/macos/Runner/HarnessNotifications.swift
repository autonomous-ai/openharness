import Cocoa
import FlutterMacOS
import UserNotifications

/// An agent's news, handed to macOS so it reaches somebody whose window is elsewhere.
///
/// Dart decides WHETHER and WHEN (`lib/notify/system_notifications.dart`): only with the switch on,
/// and only while the window is not in front. This side only posts, replaces, withdraws, and reports
/// a click back.
///
/// Answers are strings Dart parses — `granted`, `denied`, `unavailable`. `unavailable` is what an
/// ad-hoc-signed `flutter run` build gets: the centre refuses an app with no team identifier with an
/// error rather than a prompt. The signed and notarized release is not refused.
final class HarnessNotifications: NSObject, UNUserNotificationCenterDelegate {
  private let channel: FlutterMethodChannel

  init(messenger: FlutterBinaryMessenger) {
    channel = FlutterMethodChannel(name: "harness/notifications", binaryMessenger: messenger)
    super.init()
    // Set here, at window creation, so a click on a notification is heard as early as this app can
    // hear one. A click that LAUNCHES Harness only opens it: nothing here is ready to open an agent
    // before sign-in and the machines have answered.
    UNUserNotificationCenter.current().delegate = self
    channel.setMethodCallHandler { [weak self] call, result in
      guard let self else { result(nil); return }
      switch call.method {
      case "authorize":
        self.authorize { result($0) }
      case "show":
        guard let args = call.arguments as? [String: Any],
              let id = args["id"] as? String,
              let title = args["title"] as? String,
              let body = args["body"] as? String else {
          result(FlutterError(code: "INVALID_NOTIFICATION", message: "Missing id, title or body", details: nil))
          return
        }
        self.show(id: id, title: title, body: body,
                  machineId: args["machineId"] as? String ?? "",
                  agentId: args["agentId"] as? String ?? "") { result($0) }
      case "withdraw":
        if let id = (call.arguments as? [String: Any])?["id"] as? String {
          let center = UNUserNotificationCenter.current()
          center.removeDeliveredNotifications(withIdentifiers: [id])
          center.removePendingNotificationRequests(withIdentifiers: [id])
        }
        result(nil)
      default:
        result(FlutterMethodNotImplemented)
      }
    }
  }

  /// Ask once; after that the system answers from what the person chose, without a prompt.
  ///
  /// `.alert` only. The sound is its own switch and its own channel (`playAlert`), and a notification
  /// that also chimed would make one event two noises for somebody who has both on.
  private func authorize(_ done: @escaping (String) -> Void) {
    let center = UNUserNotificationCenter.current()
    center.requestAuthorization(options: [.alert]) { granted, error in
      if granted {
        DispatchQueue.main.async { done("granted") }
        return
      }
      // An error does not by itself mean this build cannot post: macOS answers a person's "no" with
      // one too. What the settings say after asking is what tells them apart — a person who said no
      // is `.denied`; a build the centre will not deal with at all is still `.notDetermined`.
      center.getNotificationSettings { settings in
        let answer: String
        switch settings.authorizationStatus {
        case .authorized, .provisional: answer = "granted"
        case .denied: answer = "denied"
        default: answer = error != nil ? "unavailable" : "denied"
        }
        DispatchQueue.main.async { done(answer) }
      }
    }
  }

  private func show(id: String, title: String, body: String, machineId: String, agentId: String,
                    _ done: @escaping (String) -> Void) {
    let center = UNUserNotificationCenter.current()
    center.getNotificationSettings { settings in
      let post = {
        let content = UNMutableNotificationContent()
        content.title = title
        content.body = body
        content.userInfo = ["machineId": machineId, "agentId": agentId]
        // The same identifier REPLACES what is already delivered, which is what keeps a busy agent
        // to one entry in Notification Center rather than a column of them.
        center.add(UNNotificationRequest(identifier: id, content: content, trigger: nil)) { error in
          // A failed add is this one notification, not the channel: "unknown" keeps the next alert trying.
          DispatchQueue.main.async { done(error == nil ? "granted" : "unknown") }
        }
      }
      switch settings.authorizationStatus {
      case .authorized, .provisional:
        post()
      case .notDetermined:
        // The switch was on before this Mac was ever asked (a restored preference). Ask now, at the
        // first thing there is to say.
        self.authorize { answer in
          if answer == "granted" { post() } else { done(answer) }
        }
      default:
        DispatchQueue.main.async { done("denied") }
      }
    }
  }

  /// Shown even though Harness is the active app. Dart already decided the window is not in front —
  /// it can be active and still out of sight, on another Space or covered — and returning nothing
  /// here would drop the notification with no trace anywhere.
  func userNotificationCenter(_ center: UNUserNotificationCenter, willPresent notification: UNNotification,
                              withCompletionHandler completionHandler: @escaping (UNNotificationPresentationOptions) -> Void) {
    completionHandler([.banner, .list])
  }

  /// A click: the window forward, then Dart opens that agent — the same thing a click on its banner does.
  func userNotificationCenter(_ center: UNUserNotificationCenter, didReceive response: UNNotificationResponse,
                              withCompletionHandler completionHandler: @escaping () -> Void) {
    defer { completionHandler() }
    guard response.actionIdentifier == UNNotificationDefaultActionIdentifier else { return }
    let info = response.notification.request.content.userInfo
    DispatchQueue.main.async {
      NSApp.activate(ignoringOtherApps: true)
      self.channel.invokeMethod("tapped", arguments: [
        "machineId": info["machineId"] as? String ?? "",
        "agentId": info["agentId"] as? String ?? "",
      ])
    }
  }
}
