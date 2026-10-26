import 'package:flutter/foundation.dart';

import '../core/browser_storage.dart';

/// The address switch that brings traces back for one browser: `?debug=traces` turns them on and
/// is remembered there, `?debug=off` forgets it.
const String kWebTracesParameter = 'debug';
const String _tracesPreference = 'debugTraces';

/// The browser console of a released web build carries errors, not traces.
///
/// Shared code traces with `debugPrint` (`agents_list start: …`, `zoo: read failed: …`, a sign-in
/// fallback it recovered from). On Desktop that is stderr, read only by a developer; in a browser
/// it is the console, kept in memory while DevTools is open. A released web build drops those
/// lines, failures included. What the framework reports (a build, layout or paint error) still
/// prints, and an error nothing caught still reaches the console through the browser.
///
/// Called once, before anything prints. Desktop never calls it.
void prepareWebConsole() => quietReleaseConsole(
  release: kReleaseMode,
  traces: webTracesWanted(
    Uri.base.queryParameters[kWebTracesParameter],
    read: () => readBrowserPreference(_tracesPreference),
    write: (value) => writeBrowserPreference(_tracesPreference, value),
  ),
);

/// Whether this browser asked for traces: [parameter] is the address's switch, read once at start,
/// and what it says is kept for the next visit.
@visibleForTesting
bool webTracesWanted(
  String? parameter, {
  required String? Function() read,
  required void Function(String value) write,
}) {
  try {
    switch (parameter) {
      case 'traces':
        write('on');
        return true;
      case 'off':
        write('');
        return false;
    }
    return read() == 'on';
  } catch (_) {
    // Storage a browser refuses (a private window) keeps only what the address says.
    return parameter == 'traces';
  }
}

/// Drops `debugPrint` lines in a [release] build unless [traces] is on, keeping the ones the
/// framework prints while it reports an error.
@visibleForTesting
void quietReleaseConsole({required bool release, required bool traces}) {
  if (!release || traces) return;
  final printLine = debugPrint;
  var reporting = false;
  debugPrint = (message, {wrapWidth}) {
    if (reporting) printLine(message, wrapWidth: wrapWidth);
  };
  final report = FlutterError.onError;
  FlutterError.onError = (details) {
    reporting = true;
    try {
      report?.call(details);
    } finally {
      reporting = false;
    }
  };
}
