import 'package:flutter/services.dart';
import 'package:flutter_secure_storage/flutter_secure_storage.dart';

/// The Wi-Fi passwords a device was set up with from this phone, by Wi-Fi name: the next setup on the
/// same Wi-Fi fills it in. Kept only once the device came online with it, so a mistyped one is never
/// offered again. In the iOS Keychain (Android: Keystore-backed), never carried to another device or a
/// backup. A store that cannot be read is empty: nothing here is worth an error.
class SavedWifi {
  const SavedWifi();

  static const _storage = FlutterSecureStorage(
    iOptions: IOSOptions(
      accessibility: KeychainAccessibility.first_unlock_this_device,
    ),
  );

  static String _key(String ssid) => 'setup_wifi:$ssid';

  Future<String?> password(String ssid) async {
    try {
      return await _storage.read(key: _key(ssid));
    } on PlatformException {
      return null;
    } on MissingPluginException {
      return null;
    }
  }

  Future<void> remember(String ssid, String password) async {
    try {
      await _storage.write(key: _key(ssid), value: password);
    } on PlatformException {
      // Not kept: typed again next time.
    } on MissingPluginException {
      // Not on this platform.
    }
  }
}
