import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';

import 'local_time_zone.dart' show superTabZoneFromLink;

/// A Windows PC's zone by its IANA name, from the ICU Windows ships. Tried on
/// Windows 11: `America/Los_Angeles` for its "Pacific Standard Time".
String? _windowsTimeZone() {
  final read = DynamicLibrary.open('icu.dll')
      .lookupFunction<
        Int32 Function(Pointer<Uint16>, Int32, Pointer<Int32>),
        int Function(Pointer<Uint16>, int, Pointer<Int32>)
      >('ucal_getDefaultTimeZone');
  const capacity = 128;
  final name = calloc<Uint16>(capacity);
  final status = calloc<Int32>();
  try {
    final length = read(name, capacity, status);
    return status.value > 0 || length <= 0 || length > capacity
        ? null
        : String.fromCharCodes(name.asTypedList(length));
  } finally {
    calloc
      ..free(name)
      ..free(status);
  }
}

/// A Mac's or a Linux computer's zone: `TZ` when it names one, else the
/// `/etc/localtime` link, else Debian's `/etc/timezone`. Windows' comes from
/// its ICU.
String? localTimeZone() {
  if (Platform.isWindows) return _windowsTimeZone();
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
