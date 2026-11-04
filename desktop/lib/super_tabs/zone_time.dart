import 'package:flutter/material.dart';
import 'package:timezone/data/latest_10y.dart' deferred as zones;
import 'package:timezone/timezone.dart' as tz;

Future<void>? _zonesLoaded;

/// The zone table, read once, the first time a card needs it: deferred, so
/// a browser downloads it then rather than with the app.
Future<void> superTabLoadZones() => _zonesLoaded ??= zones
    .loadLibrary()
    .then((_) => zones.initializeTimeZones());

/// The time of day in [zone] (an IANA name, "Asia/Ho_Chi_Minh") at [now],
/// daylight saving included. Null for no zone, or one the table lacks: the
/// card then shows no time rather than a guess (Huy, 11-04).
Future<TimeOfDay?> superTabTimeIn(String? zone, DateTime now) async {
  if (zone == null) return null;
  await superTabLoadZones();
  try {
    final there = tz.TZDateTime.from(now, tz.getLocation(zone));
    return TimeOfDay(hour: there.hour, minute: there.minute);
  } on tz.LocationNotFoundException {
    return null;
  }
}
