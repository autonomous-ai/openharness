import 'dart:async';

import 'package:flutter/services.dart';

/// What this phone is called, for the far side's "took control" banner
/// (`TerminalClientDescriptor` in `terminal/terminal_session.dart`).
///
/// `Platform.localHostname` is "localhost" on iOS, which is what a desktop
/// then said had taken its terminal. The name comes from the OS instead, over
/// `harness/device_name` (ios/Runner/AppDelegate.swift, android MainActivity.kt),
/// and reads, in order: the name the person gave this phone in Settings here;
/// the name the OS reports, when it is a real one (iOS 16+ says "iPhone" to an
/// app without Apple's user-assigned-device-name entitlement); the model, by
/// marketing name where the hardware code is known; and a possessive from the
/// signed-in account when all the model can say is "iPhone".

/// What the OS reports, verbatim.
class DeviceInfo {
  const DeviceInfo({this.name, this.model, this.modelCode, this.manufacturer});

  /// The user-assigned device name ("Hieu's iPhone"), or the generic model
  /// name where the OS withholds it; null when the ROM keeps it.
  final String? name;

  /// "iPhone" / "iPad" on iOS, `Build.MODEL` ("SM-S911B") on Android.
  final String? model;

  /// "iPhone16,1" on iOS, `Build.DEVICE` on Android.
  final String? modelCode;
  final String? manufacturer;

  static DeviceInfo? fromMap(Object? raw) {
    if (raw is! Map) return null;
    String? text(Object? value) =>
        value is String && value.trim().isNotEmpty ? value.trim() : null;
    return DeviceInfo(
      name: text(raw['name']),
      model: text(raw['model']),
      modelCode: text(raw['modelCode']),
      manufacturer: text(raw['manufacturer']),
    );
  }
}

/// The native answer, asked once per process and kept: the name is read on
/// every `terminal_open`, and the OS's answer does not change while running.
class NativeDeviceInfo {
  NativeDeviceInfo._();

  static const MethodChannel _channel = MethodChannel('harness/device_name');
  static DeviceInfo? _cached;
  static Future<DeviceInfo?>? _inFlight;

  /// The last answer, or null before the first one lands (or on a platform
  /// with no handler) — the caller falls through to the account's name then.
  static DeviceInfo? get cached => _cached;

  static Future<DeviceInfo?> describe() {
    if (_cached != null) return Future.value(_cached);
    return _inFlight ??= _ask().then((info) {
      _cached = info;
      _inFlight = null;
      return info;
    });
  }

  static Future<DeviceInfo?> _ask() async {
    try {
      return DeviceInfo.fromMap(
        await _channel.invokeMethod<Map<Object?, Object?>>('describe'),
      );
    } on MissingPluginException {
      return null;
    } catch (_) {
      return null;
    }
  }

  /// Tests only: a fixed answer, or none.
  static void setForTest(DeviceInfo? info) {
    _cached = info;
    _inFlight = null;
  }
}

/// Longest a name goes on the wire — the daemon's `CLIENT_NAME_MAX`.
const phoneNameMax = 64;

/// Names the OS hands out that name nothing: the model word alone, and the
/// hostname iOS answers with.
bool isGenericDeviceName(String? name, {String? modelCode}) {
  if (name == null) return true;
  final trimmed = name.trim();
  if (trimmed.isEmpty) return true;
  final lower = trimmed.toLowerCase();
  if (lower == 'localhost' || lower.endsWith('.local')) return true;
  if (const {
    'iphone',
    'ipad',
    'ipod touch',
    'ipod',
    'android',
    'phone',
  }.contains(lower)) {
    return true;
  }
  if (modelCode != null && lower == modelCode.toLowerCase()) return true;
  return false;
}

/// The name this phone introduces itself by — see the library doc for the order.
String composePhoneName({
  String? override,
  DeviceInfo? device,
  String? userName,
}) {
  final chosen = _clean(override);
  if (chosen != null) return chosen;
  final reported = _clean(device?.name);
  if (reported != null &&
      !isGenericDeviceName(reported, modelCode: device?.modelCode)) {
    return reported;
  }
  final model = _clean(deviceModelName(device));
  if (model != null && !isGenericDeviceName(model)) return model;
  final first = _firstName(userName);
  if (first != null) return _clip("$first's ${model ?? 'phone'}");
  return model ?? 'Phone';
}

/// The model as a person would say it: "iPhone 15 Pro" from "iPhone16,1",
/// "Samsung SM-S911B" on Android; "iPhone" when the code is not in the table.
String? deviceModelName(DeviceInfo? device) {
  if (device == null) return null;
  final code = device.modelCode;
  final marketing = code == null ? null : iosMarketingName(code);
  if (marketing != null) return marketing;
  final manufacturer = device.manufacturer;
  final model = device.model;
  if (manufacturer != null &&
      manufacturer.toLowerCase() != 'apple' &&
      model != null) {
    final brand = manufacturer[0].toUpperCase() + manufacturer.substring(1);
    return model.toLowerCase().startsWith(brand.toLowerCase())
        ? model
        : '$brand $model';
  }
  return model;
}

/// `utsname.machine` → the name on the box. Recent phones and pads; a code
/// not here reads as its model word, which the account's name then qualifies.
String? iosMarketingName(String code) => _iosModels[code];

const _iosModels = <String, String>{
  'iPhone12,1': 'iPhone 11',
  'iPhone12,3': 'iPhone 11 Pro',
  'iPhone12,5': 'iPhone 11 Pro Max',
  'iPhone12,8': 'iPhone SE (2nd gen)',
  'iPhone13,1': 'iPhone 12 mini',
  'iPhone13,2': 'iPhone 12',
  'iPhone13,3': 'iPhone 12 Pro',
  'iPhone13,4': 'iPhone 12 Pro Max',
  'iPhone14,2': 'iPhone 13 Pro',
  'iPhone14,3': 'iPhone 13 Pro Max',
  'iPhone14,4': 'iPhone 13 mini',
  'iPhone14,5': 'iPhone 13',
  'iPhone14,6': 'iPhone SE (3rd gen)',
  'iPhone14,7': 'iPhone 14',
  'iPhone14,8': 'iPhone 14 Plus',
  'iPhone15,2': 'iPhone 14 Pro',
  'iPhone15,3': 'iPhone 14 Pro Max',
  'iPhone15,4': 'iPhone 15',
  'iPhone15,5': 'iPhone 15 Plus',
  'iPhone16,1': 'iPhone 15 Pro',
  'iPhone16,2': 'iPhone 15 Pro Max',
  'iPhone17,1': 'iPhone 16 Pro',
  'iPhone17,2': 'iPhone 16 Pro Max',
  'iPhone17,3': 'iPhone 16',
  'iPhone17,4': 'iPhone 16 Plus',
  'iPhone17,5': 'iPhone 16e',
  'iPhone18,1': 'iPhone 17 Pro',
  'iPhone18,2': 'iPhone 17 Pro Max',
  'iPhone18,3': 'iPhone 17',
  'iPhone18,4': 'iPhone Air',
  'iPad13,1': 'iPad Air (4th gen)',
  'iPad13,2': 'iPad Air (4th gen)',
  'iPad13,4': 'iPad Pro 11" (3rd gen)',
  'iPad13,5': 'iPad Pro 11" (3rd gen)',
  'iPad13,6': 'iPad Pro 11" (3rd gen)',
  'iPad13,7': 'iPad Pro 11" (3rd gen)',
  'iPad13,8': 'iPad Pro 12.9" (5th gen)',
  'iPad13,9': 'iPad Pro 12.9" (5th gen)',
  'iPad13,10': 'iPad Pro 12.9" (5th gen)',
  'iPad13,11': 'iPad Pro 12.9" (5th gen)',
  'iPad13,16': 'iPad Air (5th gen)',
  'iPad13,17': 'iPad Air (5th gen)',
  'iPad13,18': 'iPad (10th gen)',
  'iPad13,19': 'iPad (10th gen)',
  'iPad14,1': 'iPad mini (6th gen)',
  'iPad14,2': 'iPad mini (6th gen)',
  'iPad14,3': 'iPad Pro 11" (4th gen)',
  'iPad14,4': 'iPad Pro 11" (4th gen)',
  'iPad14,5': 'iPad Pro 12.9" (6th gen)',
  'iPad14,6': 'iPad Pro 12.9" (6th gen)',
  'iPad14,8': 'iPad Air 11" (M2)',
  'iPad14,9': 'iPad Air 11" (M2)',
  'iPad14,10': 'iPad Air 13" (M2)',
  'iPad14,11': 'iPad Air 13" (M2)',
  'iPad15,3': 'iPad Air 11" (M3)',
  'iPad15,4': 'iPad Air 11" (M3)',
  'iPad15,5': 'iPad Air 13" (M3)',
  'iPad15,6': 'iPad Air 13" (M3)',
  'iPad15,7': 'iPad (11th gen)',
  'iPad15,8': 'iPad (11th gen)',
  'iPad16,1': 'iPad mini (A17 Pro)',
  'iPad16,2': 'iPad mini (A17 Pro)',
  'iPad16,3': 'iPad Pro 11" (M4)',
  'iPad16,4': 'iPad Pro 11" (M4)',
  'iPad16,5': 'iPad Pro 13" (M4)',
  'iPad16,6': 'iPad Pro 13" (M4)',
};

String? _firstName(String? userName) {
  final trimmed = userName?.trim();
  if (trimmed == null || trimmed.isEmpty) return null;
  final first = trimmed.split(RegExp(r'\s+')).first;
  return first.isEmpty ? null : first;
}

/// Control characters out, whitespace trimmed, cut to the wire's limit.
String? _clean(String? raw) {
  if (raw == null) return null;
  final clean = raw
      .replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ')
      .replaceAll(RegExp(r'\s+'), ' ')
      .trim();
  return clean.isEmpty ? null : _clip(clean);
}

String _clip(String value) => value.length > phoneNameMax
    ? value.substring(0, phoneNameMax).trim()
    : value;
