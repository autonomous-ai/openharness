import 'package:flutter/foundation.dart';

import 'web_form_factor_native.dart'
    if (dart.library.js_interop) 'web_form_factor_web.dart'
    as impl;

/// Which kind of browser this web build is running in — the same build plays two parts:
///
/// * **Web desktop** (a laptop's or desktop's browser, and tablets): the one BEING signed in. Its
///   sign-in page opens on a QR that a phone approves.
/// * **Web mobile** (a phone's browser): the APPROVER, like the Harness app. A phone cannot scan its
///   own screen, so it signs in by SSO and scans other devices' codes.
///
/// Always false in a native build.
bool get isMobileWeb => debugMobileWebOverride ?? (_detected ??= impl.detectMobileWeb());
bool? _detected;

/// Tests pick a form factor; null is the real one.
@visibleForTesting
bool? debugMobileWebOverride;

/// What this browser calls itself on the account's devices and on the approving phone:
/// "Chrome on macOS". Native: "Harness".
String browserLabel() => impl.browserLabel();

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

/// A phone's browser by its user agent — the mobile token every phone browser sends, which tablets
/// (iPadOS asks for the desktop site; Android tablets drop "Mobile") do not.
bool mobileUserAgent(String ua) =>
    ua.contains('iPhone') ||
    ua.contains('iPod') ||
    (ua.contains('Android') && ua.contains('Mobile')) ||
    ua.contains('Mobi');
