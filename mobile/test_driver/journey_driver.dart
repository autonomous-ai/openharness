// A command-line driver; printing is its interface.
// ignore_for_file: avoid_print

import 'dart:io';

import 'package:integration_test/integration_test_driver_extended.dart';

/// Host side of `integration_test/first_run_journey_test.dart`: writes each screenshot the app
/// takes into `HARNESS_JOURNEY_OUT` (default `build/journey/`).
Future<void> main() => integrationDriver(
  onScreenshot: (name, bytes, [args]) async {
    final root = Platform.environment['HARNESS_JOURNEY_OUT'] ?? 'build/journey';
    final file = File('$root/$name.png');
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes);
    print('[journey] $name');
    return true;
  },
);
