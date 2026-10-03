import 'browser_label_native.dart'
    if (dart.library.js_interop) 'browser_label_web.dart'
    as impl;

/// What a browser calls itself on the account's devices, and to the phone approving its sign-in:
/// "Chrome on macOS". A browser cannot read its computer's name, and "Browser" twice in the
/// Devices list told nobody which one to remove.
String browserLabel() => browserLabelFrom(impl.userAgent());

/// "Chrome on macOS" from a user agent — pure, so it is tested without a browser.
String browserLabelFrom(String ua) {
  String? browser;
  if (ua.contains('Edg/')) {
    browser = 'Edge';
  } else if (ua.contains('OPR/')) {
    browser = 'Opera';
  } else if (ua.contains('Firefox/') || ua.contains('FxiOS/')) {
    browser = 'Firefox';
  } else if (ua.contains('Chrome/') || ua.contains('CriOS/')) {
    browser = 'Chrome';
  } else if (ua.contains('Safari/')) {
    browser = 'Safari';
  }
  String? os;
  if (ua.contains('iPhone')) {
    os = 'iPhone';
  } else if (ua.contains('iPad')) {
    os = 'iPad';
  } else if (ua.contains('Android')) {
    os = 'Android';
  } else if (ua.contains('CrOS')) {
    os = 'ChromeOS';
  } else if (ua.contains('Mac OS X') || ua.contains('Macintosh')) {
    os = 'macOS';
  } else if (ua.contains('Windows')) {
    os = 'Windows';
  } else if (ua.contains('Linux')) {
    os = 'Linux';
  }
  if (browser == null && os == null) return 'Web browser';
  if (browser == null) return 'Browser on $os';
  return os == null ? browser : '$browser on $os';
}
