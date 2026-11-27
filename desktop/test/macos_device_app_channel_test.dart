import 'dart:io';

import 'package:flutter_test/flutter_test.dart';

// Reads the macOS sources, as test/swarm_screen_test.dart reads SwarmTitlebar.swift. Substrings only: a Windows
// checkout has CRLF line ends.
void main() {
  final swift = File('macos/Runner/HarnessDeviceApp.swift');
  final project = File('macos/Runner.xcodeproj/project.pbxproj')
      .readAsStringSync();
  final window = File('macos/Runner/MainFlutterWindow.swift')
      .readAsStringSync();
  int count(String text, String part) => part.allMatches(text).length;

  test('the lookup is compiled into the macOS app and registered', () {
    expect(
      count(project, 'HarnessDeviceApp.swift'),
      count(project, 'MoveToApplications.swift'),
    );
    expect(window, contains('HarnessDeviceApp.install(messenger:'));
    final source = swift.readAsStringSync();
    for (final part in [
      '"harness/device_app"',
      '"lookup"',
      '"ai.autonomous.harness.device"',
      '"paths"',
      '"running"',
      'urlsForApplications(withBundleIdentifier:',
      'runningApplications(withBundleIdentifier:',
    ]) {
      expect(source, contains(part), reason: part);
    }
  });

  // The filter is Dart's (device_app_probe.dart), where pull request CI tests it: a second one here would
  // be a rule no gate runs.
  test('the lookup filters nothing', () {
    final source = swift.readAsStringSync();
    for (final part in ['/Volumes/', '.Trash', 'fileExists', '.filter']) {
      expect(source, isNot(contains(part)), reason: part);
    }
  });

  test('the lookup starts no process and opens nothing', () {
    final source = swift.readAsStringSync();
    for (final part in [
      'Process(',
      'NSTask',
      '.open(',
      'openApplication',
      'launchApplication',
    ]) {
      expect(source, isNot(contains(part)), reason: part);
    }
  });
}
