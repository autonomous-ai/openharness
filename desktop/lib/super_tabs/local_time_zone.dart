import 'package:flutter/foundation.dart';

import '../core/test_run.dart';
import 'local_time_zone_native.dart'
    if (dart.library.js_interop) 'local_time_zone_web.dart'
    as platform;

/// Stands in for this computer's zone in a test; null reads the computer's.
@visibleForTesting
String? Function()? superTabLocalTimeZoneOverride;

/// This computer's time zone by its IANA name ("Asia/Ho_Chi_Minh"), which
/// the reader's app tells the Swarm for the local time on their card
/// (Huy, 11-04; River: the name, so daylight saving stays right). Null when
/// it names none: a test, or a computer that cannot say.
String? superTabLocalTimeZone() {
  if (superTabLocalTimeZoneOverride case final override?) return override();
  if (kUnderTest) return null;
  try {
    final zone = platform.localTimeZone()?.trim();
    return zone == null || zone.isEmpty ? null : zone;
  } catch (_) {
    return null;
  }
}

/// The zone a `/etc/localtime` link names: what follows `zoneinfo/` in its
/// target (macOS `/var/db/timezone/zoneinfo/…`, Linux `/usr/share/zoneinfo/…`).
String? superTabZoneFromLink(String target) {
  const marker = '/zoneinfo/';
  final at = target.indexOf(marker);
  if (at < 0) return null;
  final name = target.substring(at + marker.length);
  return name.isEmpty ? null : name;
}
