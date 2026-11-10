import 'package:timezone/data/latest_10y.dart' deferred as zones;
import 'package:timezone/timezone.dart' as tz;

import 'model.dart' show superTabDefaultTimeZone;

Future<void>? _zonesLoading;
var _zonesLoaded = false;

/// The zone table, read once, the first time a screen needs it: deferred, so
/// a browser downloads it then rather than with the app.
Future<void> superTabLoadZones() => _zonesLoading ??= zones
    .loadLibrary()
    .then((_) => zones.initializeTimeZones())
    .then((_) => _zonesLoaded = true);

/// Whether [superTabDateIn] can answer in a zone yet.
bool get superTabZonesLoaded => _zonesLoaded;

/// The date in [zone] at [now], as a UTC midnight to compare dates by; in
/// [superTabDefaultTimeZone] for a zone the table lacks. Until the table is
/// loaded, this computer's date.
DateTime superTabDateIn(String zone, DateTime now) {
  DateTime day(DateTime t) => DateTime.utc(t.year, t.month, t.day);
  if (!_zonesLoaded) return day(now.toLocal());
  tz.Location location;
  try {
    location = tz.getLocation(zone);
  } on tz.LocationNotFoundException {
    location = tz.getLocation(superTabDefaultTimeZone);
  }
  return day(tz.TZDateTime.from(now, location));
}
