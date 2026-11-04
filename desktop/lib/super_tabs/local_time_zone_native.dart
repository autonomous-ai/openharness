import 'dart:io';

import 'local_time_zone.dart' show superTabZoneFromLink;

/// A Mac's or a Linux computer's zone: `TZ` when it names one, else the
/// `/etc/localtime` link, else Debian's `/etc/timezone`. Windows names its
/// zones its own way, so it gives none.
String? localTimeZone() {
  if (Platform.isWindows) return null;
  final tz = Platform.environment['TZ'];
  if (tz != null && RegExp(r'^[A-Za-z]+(/[A-Za-z0-9_+-]+)+$').hasMatch(tz)) {
    return tz;
  }
  final link = Link('/etc/localtime');
  if (link.existsSync()) {
    if (superTabZoneFromLink(link.targetSync()) case final zone?) return zone;
  }
  final file = File('/etc/timezone');
  return file.existsSync() ? file.readAsStringSync().trim() : null;
}
