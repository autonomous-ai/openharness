import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/update/update_signature.dart';
import 'package:path/path.dart' as p;

/// Real `codesign` on real bundles. Unsigned and ad-hoc fixtures are built
/// here; a Developer ID, notarized one cannot be (that needs the signing
/// identity), so the signed cases use an installed release:
/// `HARNESS_SIGNED_APP_FIXTURE`, else `/Applications/Harness.app`.
final String? _macOnly = Platform.isMacOS ? null : 'needs codesign (macOS)';

String? _signedRelease() {
  final path =
      Platform.environment['HARNESS_SIGNED_APP_FIXTURE'] ??
      '/Applications/Harness.app';
  if (!Platform.isMacOS || !Directory(path).existsSync()) return null;
  final display = Process.runSync('/usr/bin/codesign', ['-dv', path]);
  return '${display.stderr}'.contains('TeamIdentifier=54DJVWMJCC')
      ? path
      : null;
}

/// A minimal `Harness.app`: Info.plist and an unsigned Mach-O.
String _unsignedBundle(String dir, String name) {
  final bundle = p.join(dir, name);
  Directory(p.join(bundle, 'Contents', 'MacOS')).createSync(recursive: true);
  File(p.join(bundle, 'Contents', 'Info.plist')).writeAsStringSync('''
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>CFBundleExecutable</key>
	<string>Harness</string>
	<key>CFBundleIdentifier</key>
	<string>ai.autonomous.harness</string>
	<key>CFBundleShortVersionString</key>
	<string>9.9.9</string>
</dict>
</plist>
''');
  final binary = p.join(bundle, 'Contents', 'MacOS', 'Harness');
  File('/usr/bin/true').copySync(binary);
  final strip = Process.runSync('/usr/bin/codesign', [
    '--remove-signature',
    binary,
  ]);
  expect(strip.exitCode, 0, reason: '${strip.stderr}');
  return bundle;
}

String _adHocBundle(String dir, String name) {
  final bundle = _unsignedBundle(dir, name);
  final sign = Process.runSync('/usr/bin/codesign', [
    '--force',
    '--sign',
    '-',
    bundle,
  ]);
  expect(sign.exitCode, 0, reason: '${sign.stderr}');
  return bundle;
}

/// An APFS clone: instant, and changing it leaves the original alone.
String _clone(String source, String dir, String name) {
  final target = p.join(dir, name);
  final copy = Process.runSync('/bin/cp', ['-cR', source, target]);
  expect(copy.exitCode, 0, reason: '${copy.stderr}');
  return target;
}

Matcher _refusedWith(String text) => throwsA(
  isA<UpdateRefused>().having((e) => e.message, 'message', contains(text)),
);

void main() {
  late Directory scratch;
  final signed = _signedRelease();
  final noSigned = _macOnly ??
      (signed == null
          ? 'no notarized Developer ID Harness here: set HARNESS_SIGNED_APP_FIXTURE'
          : null);

  setUp(() => scratch = Directory.systemTemp.createTempSync('update-sig-'));
  tearDown(() => scratch.deleteSync(recursive: true));

  test('a running build with no signer of its own keeps the sha256 check alone', () async {
    final running = _adHocBundle(scratch.path, 'Running.app');
    await verifyMacUpdate(
      stagedBundle: _unsignedBundle(scratch.path, 'Harness.app'),
      runningBundle: running,
    );
  }, skip: _macOnly);

  test('a running app whose signer cannot be read refuses', () async {
    await expectLater(
      verifyMacUpdate(
        stagedBundle: _unsignedBundle(scratch.path, 'Harness.app'),
        runningBundle: p.join(scratch.path, 'Missing.app'),
      ),
      _refusedWith('could not check'),
    );
  }, skip: _macOnly);

  test('a check that runs out of time refuses', () async {
    await expectLater(
      verifyMacUpdate(
        stagedBundle: _unsignedBundle(scratch.path, 'Harness.app'),
        runningBundle: _adHocBundle(scratch.path, 'Running.app'),
        timeout: Duration.zero,
      ),
      _refusedWith('could not check'),
    );
  }, skip: _macOnly);

  test('an unsigned update is refused by a signed release', () async {
    await expectLater(
      verifyMacUpdate(
        stagedBundle: _unsignedBundle(scratch.path, 'Harness.app'),
        runningBundle: signed!,
      ),
      _refusedWith('not signed by Autonomous Inc.'),
    );
  }, skip: noSigned);

  test('an ad-hoc signed update is refused by a signed release', () async {
    await expectLater(
      verifyMacUpdate(
        stagedBundle: _adHocBundle(scratch.path, 'Harness.app'),
        runningBundle: signed!,
      ),
      _refusedWith('not signed by Autonomous Inc.'),
    );
  }, skip: noSigned);

  test('a correctly signed and notarized update installs', () async {
    await verifyMacUpdate(
      stagedBundle: _clone(signed!, scratch.path, 'Harness.app'),
      runningBundle: signed,
    );
  }, skip: noSigned);

  test('a signed update changed after signing is refused', () async {
    final staged = _clone(signed!, scratch.path, 'Harness.app');
    final resources = Directory(p.join(staged, 'Contents', 'Resources'));
    final victim = resources.listSync().whereType<File>().first;
    victim.writeAsStringSync('changed', mode: FileMode.append);
    await expectLater(
      verifyMacUpdate(stagedBundle: staged, runningBundle: signed),
      _refusedWith('not signed by Autonomous Inc.'),
    );
  }, skip: noSigned);
}
