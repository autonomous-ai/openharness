import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/environment_provisioner.dart'
    show windowsPowerShellPath;
import 'package:harness/core/hidden_process.dart';
import 'package:harness/update/update_signature.dart';
import 'package:path/path.dart' as p;

/// Real `Get-AuthenticodeSignature` and `Test-FileCatalog` on real files.
/// Nothing here can be signed by a trusted publisher (that needs a signing
/// identity), so the signed fixture is a Microsoft program every Windows has,
/// with its signature embedded, standing in for the running app.
final String? _windowsOnly = Platform.isWindows
    ? null
    : 'needs Authenticode (Windows)';

/// .NET Framework programs carry an embedded Microsoft signature; most of
/// System32 is signed only through the system catalog, which a copy keeps.
const _candidates = [
  r'Microsoft.NET\Framework64\v4.0.30319\csc.exe',
  r'Microsoft.NET\Framework64\v4.0.30319\vbc.exe',
  r'Microsoft.NET\Framework64\v4.0.30319\MSBuild.exe',
  r'Microsoft.NET\Framework\v4.0.30319\csc.exe',
];

const _loadSecurity =
    r"Import-Module -Name (Join-Path $PSHOME 'Modules\Microsoft.PowerShell.Security\Microsoft.PowerShell.Security.psd1')";

/// What [body] printed through debugPrint, where the refusal names its rule.
Future<List<String>> _logged(Future<void> Function() body) async {
  final lines = <String>[];
  final previous = debugPrint;
  debugPrint = (message, {wrapWidth}) => lines.add(message ?? '');
  try {
    await body();
  } finally {
    debugPrint = previous;
  }
  return lines;
}

Future<String> _powershell(String script) async {
  final result = await runHidden(windowsPowerShellPath(Platform.environment), [
    '-NoProfile',
    '-NonInteractive',
    '-EncodedCommand',
    // As the report does: 5.1's own Security module, whatever PSModulePath
    // this process hands on (a PowerShell 7 step in CI).
    base64.encode(_utf16le('$_loadSecurity\n$script')),
  ]);
  expect(result.exitCode, 0, reason: '${result.stderr}');
  return '${result.stdout}'.trim();
}

Uint8List _utf16le(String text) {
  final units = text.codeUnits;
  final bytes = Uint8List(units.length * 2);
  for (var i = 0; i < units.length; i++) {
    bytes[i * 2] = units[i] & 0xff;
    bytes[i * 2 + 1] = units[i] >> 8;
  }
  return bytes;
}

Future<String> _embeddedSignedProgram() async {
  final root = Platform.environment['SystemRoot'] ?? r'C:\Windows';
  final named = [
    for (final candidate in _candidates) "'${p.join(root, candidate)}'",
  ].join(', ');
  final system32 = p.join(root, 'System32');
  final found = await _powershell(
    "foreach (\$path in @($named) + @((Get-ChildItem -LiteralPath '$system32' -Filter *.exe).FullName)) { "
    'if (-not (Test-Path -LiteralPath \$path)) { continue }; '
    '\$s = Get-AuthenticodeSignature -LiteralPath \$path; '
    "if (\$s.SignatureType -eq 'Authenticode' -and \$s.Status -eq 'Valid') "
    '{ \$path; break } }',
  );
  if (found.isEmpty) fail('no program with an embedded signature here');
  return found;
}

/// [source] without its Authenticode certificate table, and one byte of its
/// DOS stub changed so no system catalog lists it either: unsigned.
void _stripSignature(String source, String target) {
  final bytes = File(source).readAsBytesSync();
  final view = ByteData.sublistView(bytes);
  final pe = view.getUint32(0x3c, Endian.little);
  final magic = view.getUint16(pe + 24, Endian.little);
  final security = pe + 24 + (magic == 0x10b ? 96 : 112) + 4 * 8;
  final offset = view.getUint32(security, Endian.little);
  expect(offset, isNot(0), reason: '$source has no embedded signature');
  view.setUint32(security, 0, Endian.little);
  view.setUint32(security + 4, 0, Endian.little);
  bytes[0x4e] ^= 0x01;
  File(target).writeAsBytesSync(Uint8List.sublistView(bytes, 0, offset));
}

void main() {
  late Directory scratch;
  late String signed;
  late String unsigned;
  late String staged;
  late String launcher;

  setUp(() async {
    if (!Platform.isWindows) return;
    scratch = Directory.systemTemp.createTempSync('update-sig-');
    signed = p.join(scratch.path, 'running', 'harness-desktop.exe');
    Directory(p.dirname(signed)).createSync();
    File(await _embeddedSignedProgram()).copySync(signed);
    unsigned = p.join(scratch.path, 'unsigned', 'harness-desktop.exe');
    Directory(p.dirname(unsigned)).createSync();
    _stripSignature(signed, unsigned);
    staged = p.join(scratch.path, 'app', '9.9.9.staging');
    Directory(p.join(staged, 'data')).createSync(recursive: true);
    File(signed).copySync(p.join(staged, 'harness-desktop.exe'));
    File(p.join(staged, 'data', 'app.so')).writeAsStringSync('dart code');
    launcher = p.join(scratch.path, 'Harness.exe.new');
    File(signed).copySync(launcher);
  });
  tearDown(() {
    if (Platform.isWindows) scratch.deleteSync(recursive: true);
  });

  Future<WindowsSignatureReport> report({String? running}) =>
      readWindowsSignatureReport(
        stagedFolder: staged,
        stagedLauncher: launcher,
        runningExe: running ?? signed,
      );

  // As the release does: over app/<version>, which the updater unpacks
  // as app/<version>.staging.
  Future<void> writeCatalog() {
    final built = p.join(p.dirname(staged), '9.9.9');
    return _powershell(
      "Rename-Item -LiteralPath '$staged' -NewName '9.9.9'; "
      "New-FileCatalog -CatalogVersion 2.0 -Path '$built' "
      "-CatalogFilePath '${scratch.path}\\c.cat' | Out-Null; "
      "Move-Item -LiteralPath '${scratch.path}\\c.cat' "
      "-Destination '$built\\harness-desktop.cat'; "
      "Rename-Item -LiteralPath '$built' -NewName '9.9.9.staging'",
    );
  }

  test(
    'the report reads who signed each program and the running app',
    () async {
      _stripSignature(signed, p.join(staged, 'extra.dll'));
      final found = await report();
      expect(found.running.status, 'Valid');
      expect(found.running.subject, contains('Microsoft'));
      expect(found.runningFolder.keys, contains('harness-desktop.exe'));
      expect(found.files['harness-desktop.exe']!.sameAs(found.running), isTrue);
      expect(found.files['Harness.exe']!.sameAs(found.running), isTrue);
      expect(found.files['extra.dll']!.status, 'NotSigned');
      expect(found.files.keys, isNot(contains('data/app.so')));
      expect(found.catalog, isNull);
    },
    skip: _windowsOnly,
  );

  test('one program in a folder still reads as a list', () async {
    final found = await report(running: unsigned);
    expect(found.runningFolder.keys, ['harness-desktop.exe']);
    expect(
      found.files.keys,
      unorderedEquals(['harness-desktop.exe', 'Harness.exe']),
    );
  }, skip: _windowsOnly);

  test('a changed program reads as changed, not as signed', () async {
    final copy = File(p.join(staged, 'harness-desktop.exe'));
    final bytes = copy.readAsBytesSync();
    bytes[bytes.length ~/ 2] ^= 0xff;
    copy.writeAsBytesSync(bytes);
    final found = await report();
    expect(found.files['harness-desktop.exe']!.valid, isFalse);
  }, skip: _windowsOnly);

  test('the catalog covers app.so: a changed or extra file fails it', () async {
    await writeCatalog();
    var found = await report();
    expect(found.catalog!.status, 'Valid');
    expect(found.catalog!.signer.status, 'NotSigned');

    File(p.join(staged, 'data', 'app.so')).writeAsStringSync('other code');
    found = await report();
    expect(found.catalog!.status, 'ValidationFailed');

    File(p.join(staged, 'data', 'app.so')).writeAsStringSync('dart code');
    File(p.join(staged, 'data', 'extra.bin')).writeAsStringSync('more');
    found = await report();
    expect(found.catalog!.status, 'ValidationFailed');
  }, skip: _windowsOnly);

  // Run 42354774882 refused both of these for the wrong reason ("the update
  // has no harness-desktop.exe"): the log says which rule refused.
  test('an unsigned catalog is refused, in plain words', () async {
    await writeCatalog();
    final logged = await _logged(
      () => expectLater(
        verifyWindowsUpdate(
          stagedFolder: staged,
          stagedLauncher: launcher,
          runningExe: signed,
        ),
        throwsA(
          isA<UpdateRefused>().having(
            (e) => e.message,
            'message',
            contains('not signed by Microsoft'),
          ),
        ),
      ),
    );
    expect(
      logged,
      contains(contains('refused: the file catalog is signed by')),
    );
  }, skip: _windowsOnly);

  test('an unsigned program is refused', () async {
    await writeCatalog();
    _stripSignature(signed, launcher);
    final logged = await _logged(
      () => expectLater(
        verifyWindowsUpdate(
          stagedFolder: staged,
          stagedLauncher: launcher,
          runningExe: signed,
        ),
        throwsA(isA<UpdateRefused>()),
      ),
    );
    expect(
      logged,
      contains(contains('refused: Harness.exe signature is NotSigned')),
    );
  }, skip: _windowsOnly);

  test(
    'a running app that is itself unsigned keeps the sha256 check alone',
    () async {
      _stripSignature(signed, launcher);
      await verifyWindowsUpdate(
        stagedFolder: staged,
        stagedLauncher: launcher,
        runningExe: unsigned,
      );
    },
    skip: _windowsOnly,
  );

  test('a check that runs out of time refuses', () async {
    await expectLater(
      verifyWindowsUpdate(
        stagedFolder: staged,
        stagedLauncher: launcher,
        runningExe: signed,
        timeout: Duration.zero,
      ),
      throwsA(
        isA<UpdateRefused>().having(
          (e) => e.message,
          'message',
          contains('could not check'),
        ),
      ),
    );
  }, skip: _windowsOnly);
}
