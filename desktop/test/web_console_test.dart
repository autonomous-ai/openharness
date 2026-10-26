// A released web build's console: traces dropped, framework errors kept, and one browser's
// switch that brings the traces back.
import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/web/web_console.dart';

/// Runs [body] with [quietReleaseConsole] installed over a recording console, and puts the
/// framework's handlers back before the test ends.
List<String> _console(
  void Function() body, {
  required bool release,
  required bool traces,
}) {
  final printed = <String>[];
  final savedPrint = debugPrint;
  final savedError = FlutterError.onError;
  debugPrint = (message, {wrapWidth}) => printed.add(message ?? '');
  // What the framework's own handler does: print the error.
  FlutterError.onError = (details) =>
      debugPrint('reported: ${details.exceptionAsString()}');
  try {
    quietReleaseConsole(release: release, traces: traces);
    body();
  } finally {
    debugPrint = savedPrint;
    FlutterError.onError = savedError;
  }
  return printed;
}

void _trace() => debugPrint('agents_list start: box');

void _frameworkError() => FlutterError.reportError(
  FlutterErrorDetails(
    exception: StateError('layout overflowed'),
    library: 'rendering library',
  ),
);

void main() {
  test('a release build drops trace lines', () {
    expect(_console(_trace, release: true, traces: false), isEmpty);
  });

  test('a release build still prints what the framework reports', () {
    final printed = _console(_frameworkError, release: true, traces: false);

    expect(printed, ['reported: Bad state: layout overflowed']);
  });

  test('a debug build prints everything as before', () {
    expect(_console(_trace, release: false, traces: false), [
      'agents_list start: box',
    ]);
  });

  test('the switch brings traces back in a release build', () {
    expect(_console(_trace, release: true, traces: true), [
      'agents_list start: box',
    ]);
  });

  group('the switch', () {
    late String? stored;
    bool wanted(String? parameter) => webTracesWanted(
      parameter,
      read: () => stored,
      write: (value) => stored = value,
    );
    setUp(() => stored = null);

    test('is off unless asked for', () {
      expect(wanted(null), isFalse);
    });

    test('?debug=traces turns it on and is remembered', () {
      expect(wanted('traces'), isTrue);
      expect(wanted(null), isTrue);
    });

    test('?debug=off forgets it', () {
      wanted('traces');

      expect(wanted('off'), isFalse);
      expect(wanted(null), isFalse);
    });

    test('a browser that refuses storage keeps what the address says', () {
      bool refused(String? parameter) => webTracesWanted(
        parameter,
        read: () => throw StateError('storage refused'),
        write: (_) => throw StateError('storage refused'),
      );

      expect(refused('traces'), isTrue);
      expect(refused(null), isFalse);
    });
  });
}
