import 'dart:io' show Platform;

import 'package:flutter/services.dart';
import 'package:url_launcher/url_launcher.dart';

/// Opens this app's own page in the phone's Settings — where a permission refused once is turned
/// back on, since the app may not ask again.
///
/// iOS: `app-settings:` (`UIApplication.openSettingsURLString`) through url_launcher, which lands
/// on Settings ▸ Harness with its switches. Android: App info, over `harness/app_task` (android
/// `MainActivity.kt`) — no URL reaches that screen, so url_launcher cannot; the permissions are
/// one tap further in, under Permissions.
///
/// False when nothing opened: another platform, or the OS refused.
Future<bool> openAppSettings() async {
  try {
    if (Platform.isIOS) return await launchUrl(Uri.parse('app-settings:'));
    if (Platform.isAndroid) {
      return await _appTask.invokeMethod<bool>('openSettings') ?? false;
    }
  } on MissingPluginException {
    return false;
  } catch (_) {
    return false;
  }
  return false;
}

/// The same channel `phone/exit_app.dart` sends the app to the background over.
const MethodChannel _appTask = MethodChannel('harness/app_task');
