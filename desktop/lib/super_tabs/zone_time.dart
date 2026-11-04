import 'package:flutter/material.dart';
import 'package:timezone/data/latest_10y.dart' deferred as zones;
import 'package:timezone/timezone.dart' as tz;

Future<void>? _zonesLoading;
var _zonesLoaded = false;

/// The zone table, read once, the first time a card needs it: deferred, so
/// a browser downloads it then rather than with the app.
Future<void> superTabLoadZones() => _zonesLoading ??= zones
    .loadLibrary()
    .then((_) => zones.initializeTimeZones())
    .then((_) => _zonesLoaded = true);

/// Whether [superTabTimeNow] can answer yet.
bool get superTabZonesLoaded => _zonesLoaded;

/// The time of day in [zone] (an IANA name, "Asia/Ho_Chi_Minh") at [now],
/// daylight saving included, once the table is loaded. Null for no zone, or
/// one the table lacks: the card then shows no time rather than a guess
/// (Huy, 11-04).
TimeOfDay? superTabTimeNow(String? zone, DateTime now) {
  if (zone == null || !_zonesLoaded) return null;
  try {
    final there = tz.TZDateTime.from(now, tz.getLocation(zone));
    return TimeOfDay(hour: there.hour, minute: there.minute);
  } on tz.LocationNotFoundException {
    return null;
  }
}

/// [superTabTimeNow], loading the table first.
Future<TimeOfDay?> superTabTimeIn(String? zone, DateTime now) async {
  if (zone == null) return null;
  await superTabLoadZones();
  return superTabTimeNow(zone, now);
}
