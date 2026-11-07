/// An update installs only when the publisher that signed the running app
/// signed it too: a manifest someone else wrote can point at a build with the
/// right sha256, but it cannot sign one as us.
///
/// The running app is the reference, not a name written here, so a release
/// signed the way the last one was always passes, and nothing changes the day
/// a short-lived certificate is renewed. A running app that is itself unsigned
/// (a local build, a Windows staging build) has nothing to compare with and
/// keeps the sha256 check alone; released builds are all signed, so an
/// installed release only ever moves to another signed one.
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:flutter/foundation.dart';

import '../bootstrap/environment_provisioner.dart' show windowsPowerShellPath;
import '../core/hidden_process.dart';
import '../core/runtime_platform.dart';

/// Long enough for a cold `codesign --deep` over a 300 MB bundle or a
/// PowerShell start on a busy PC; a check that takes longer refuses.
const signatureCheckTimeout = Duration(seconds: 60);

/// Why an update was not installed, in words for the person: the banner shows
/// "Could not install Harness X: " followed by [message].
class UpdateRefused implements Exception {
  const UpdateRefused(this.message);
  final String message;

  @override
  String toString() => message;
}

/// The update is not from whoever made the running app.
UpdateRefused notFromPublisher(String publisher) => UpdateRefused(
  'it is not signed by $publisher, who made the Harness you are using, so it '
  'may not be genuine. You are still on your current version.',
);

/// Harness could not find out who signed the update or itself.
const cannotCheckSignature = UpdateRefused(
  'Harness could not check who signed it. You are still on your current '
  'version; try again later.',
);

/// The running macOS app's signer: what a staged bundle must also carry.
class MacSigner {
  const MacSigner({
    required this.team,
    required this.identifier,
    required this.name,
  });

  /// The Developer ID team, e.g. `54DJVWMJCC`.
  final String team;

  /// The bundle identifier, e.g. `ai.autonomous.harness`.
  final String identifier;

  /// The certificate's person-readable name, e.g. `Autonomous Inc.`.
  final String name;
}

/// Reads `codesign -dv --verbose=2` of the running bundle. Null means it is
/// ad hoc or unsigned. Anything else it cannot read throws, so a missing tool
/// or path is never mistaken for an unsigned build.
MacSigner? parseMacSigner(String codesignDisplay) {
  String? field(String key) => RegExp(
    '^$key=(.*)\$',
    multiLine: true,
  ).firstMatch(codesignDisplay)?.group(1)?.trim();

  if (codesignDisplay.contains('code object is not signed at all') ||
      field('Signature') == 'adhoc') {
    return null;
  }
  final team = field('TeamIdentifier');
  final identifier = field('Identifier');
  final authority = RegExp(
    r'^Authority=Developer ID Application: (.+) \(([A-Z0-9]{10})\)$',
    multiLine: true,
  ).firstMatch(codesignDisplay);
  if (team == null ||
      identifier == null ||
      authority == null ||
      authority.group(2) != team) {
    throw cannotCheckSignature;
  }
  return MacSigner(
    team: team,
    identifier: identifier,
    name: authority.group(1)!,
  );
}

/// The code requirement a staged bundle must meet: Apple's Developer ID chain
/// (intermediate and leaf marker fields), the running app's team and
/// identifier, and Apple's notarization ticket.
String macUpdateRequirement(MacSigner signer) =>
    'anchor apple generic'
    ' and certificate 1[field.1.2.840.113635.100.6.2.6]'
    ' and certificate leaf[field.1.2.840.113635.100.6.1.13]'
    ' and certificate leaf[subject.OU] = "${signer.team}"'
    ' and identifier "${signer.identifier}"'
    ' and notarized';

/// One Authenticode signature as `Get-AuthenticodeSignature` reports it.
class WindowsSigner {
  const WindowsSigner({
    required this.status,
    required this.subject,
    required this.identity,
  });

  factory WindowsSigner.fromJson(Map<String, dynamic> json) => WindowsSigner(
    status: json['status'] as String? ?? '',
    subject: json['subject'] as String? ?? '',
    identity: json['identity'] as String? ?? '',
  );

  /// `Valid`, `NotSigned`, `HashMismatch`, `UnknownError`, …
  final String status;

  /// The signing certificate's subject.
  final String subject;

  /// Azure Artifact Signing's identity EKUs (`1.3.6.1.4.1.311.97.*` other
  /// than the generic `.97.1.0`), sorted and space-separated. They name the
  /// validated identity and stay the same while the 3-day certificates
  /// rotate, so a lookalike subject on another identity does not match.
  final String identity;

  bool get valid => status == 'Valid';

  /// The certificate's common name, e.g. `AUTONOMOUS INC.`.
  String get name =>
      RegExp(r'(?:^|, )CN=("[^"]*"|[^,]*)').firstMatch(subject)?.group(1) ??
      subject;

  bool sameAs(WindowsSigner other) =>
      subject == other.subject && identity == other.identity;
}

/// The staged version folder's file catalog: `Test-FileCatalog`'s verdict on
/// every file, and the catalog's own signature.
class WindowsCatalog {
  const WindowsCatalog({required this.status, required this.signer});
  final String status;
  final WindowsSigner signer;
}

/// What the hidden PowerShell found, keyed by file name relative to the
/// version folder (the launcher as `Harness.exe`).
class WindowsSignatureReport {
  const WindowsSignatureReport({
    required this.running,
    required this.runningFolder,
    required this.files,
    required this.catalog,
  });

  factory WindowsSignatureReport.fromJson(Map<String, dynamic> json) {
    // PowerShell writes a one-item list as the item itself.
    Map<String, WindowsSigner> byPath(Object? list) => {
      for (final row
          in (list is Map ? [list] : list as List? ?? const []).cast<Map>())
        row['path'] as String: WindowsSigner.fromJson(row.cast()),
    };
    final catalog = json['catalog'] as Map?;
    return WindowsSignatureReport(
      running: WindowsSigner.fromJson((json['running'] as Map).cast()),
      runningFolder: byPath(json['runningFolder']),
      files: byPath(json['files']),
      catalog: catalog == null
          ? null
          : WindowsCatalog(
              status: catalog['status'] as String? ?? '',
              signer: WindowsSigner.fromJson(
                (catalog['signer'] as Map? ?? const {}).cast(),
              ),
            ),
    );
  }

  /// The running `harness-desktop.exe`.
  final WindowsSigner running;

  /// Every `.exe` and `.dll` beside it.
  final Map<String, WindowsSigner> runningFolder;

  /// Every staged `.exe` and `.dll`, and the staged launcher.
  final Map<String, WindowsSigner> files;
  final WindowsCatalog? catalog;
}

/// The files only we may sign: the app and its launcher.
const _ourFiles = {'harness-desktop.exe', 'harness.exe'};

/// Null when the staged Windows update may install; otherwise what is wrong,
/// for the log. Every staged program file must be validly signed; the app,
/// the launcher and the catalog by the running app's signer; any other file
/// by a signer the running version folder already trusts (Microsoft for
/// WebView2Loader.dll). The catalog covers the files Authenticode cannot sign,
/// the Dart code in `data/app.so` above all.
String? windowsUpdateRefusal(WindowsSignatureReport report) {
  final running = report.running;
  if (running.status == 'NotSigned') return null;
  if (!running.valid) {
    return 'the running harness-desktop.exe signature is ${running.status}';
  }
  final trusted = [
    running,
    ...report.runningFolder.values.where((signer) => signer.valid),
  ];
  for (final required in ['harness-desktop.exe', 'Harness.exe']) {
    if (!report.files.keys.any(
      (path) => path.toLowerCase() == required.toLowerCase(),
    )) {
      return 'the update has no $required';
    }
  }
  for (final MapEntry(key: path, value: signer) in report.files.entries) {
    if (!signer.valid) return '$path signature is ${signer.status}';
    final ours = _ourFiles.contains(
      path.split(RegExp(r'[/\\]')).last.toLowerCase(),
    );
    final allowed = ours ? signer.sameAs(running) : trusted.any(signer.sameAs);
    if (!allowed) return '$path is signed by ${signer.subject}';
  }
  final catalog = report.catalog;
  if (catalog == null) return 'the update has no file catalog';
  if (catalog.status != 'Valid') {
    return 'the file catalog check says ${catalog.status}';
  }
  if (!catalog.signer.valid || !catalog.signer.sameAs(running)) {
    return 'the file catalog is signed by "${catalog.signer.subject}" '
        '(${catalog.signer.status})';
  }
  return null;
}

/// Refuses [stagedBundle] unless it meets [macUpdateRequirement] for the
/// signer of [runningBundle]; a running bundle with no signer passes it.
Future<void> verifyMacUpdate({
  required String stagedBundle,
  required String runningBundle,
  Duration timeout = signatureCheckTimeout,
}) async {
  final display = await _run('/usr/bin/codesign', [
    '-dv',
    '--verbose=2',
    runningBundle,
  ], timeout);
  final signer = parseMacSigner('${display.stdout}${display.stderr}');
  if (signer == null) {
    debugPrint(
      'UpdateSignature: the running app is not signed; the update is checked by sha256 only',
    );
    return;
  }
  final check = await _run('/usr/bin/codesign', [
    '--verify',
    '--deep',
    '--strict',
    '-R=${macUpdateRequirement(signer)}',
    stagedBundle,
  ], timeout);
  if (check.exitCode != 0) {
    debugPrint('UpdateSignature: refused: ${'${check.stderr}'.trim()}');
    throw notFromPublisher(signer.name);
  }
}

/// Prints one [WindowsSignatureReport] as JSON. Paths come in through the
/// environment, so no file name is ever parsed as PowerShell.
@visibleForTesting
const windowsReportScript = r"""
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Signer($signature) {
  $certificate = $signature.SignerCertificate
  $identity = @()
  if ($certificate) {
    $identity = @($certificate.EnhancedKeyUsageList | ForEach-Object { $_.ObjectId } |
      Where-Object { $_ -like '1.3.6.1.4.1.311.97.*' -and $_ -ne '1.3.6.1.4.1.311.97.1.0' } | Sort-Object)
  }
  [ordered]@{
    status = "$($signature.Status)"
    subject = if ($certificate) { $certificate.Subject } else { '' }
    identity = $identity -join ' '
  }
}
function Read-Signer($path) {
  try { Signer (Get-AuthenticodeSignature -LiteralPath $path) }
  catch { [ordered]@{ status = 'Unreadable'; subject = ''; identity = '' } }
}
function Programs($folder) {
  $root = (Resolve-Path -LiteralPath $folder).Path.TrimEnd('\') + '\'
  @(Get-ChildItem -LiteralPath $folder -Recurse -File -Force |
    Where-Object { $_.Extension -in '.exe', '.dll' } | ForEach-Object {
      $row = Read-Signer $_.FullName
      $row.path = $_.FullName.Substring($root.Length).Replace('\', '/')
      $row
    })
}
$files = @(Programs $env:HARNESS_UPDATE_STAGED)
$launcher = Read-Signer $env:HARNESS_UPDATE_LAUNCHER
$launcher.path = 'Harness.exe'
$files += $launcher
$catalog = $null
$catalogPath = Join-Path $env:HARNESS_UPDATE_STAGED 'harness-desktop.cat'
if (Test-Path -LiteralPath $catalogPath -PathType Leaf) {
  try {
    $result = Test-FileCatalog -CatalogFilePath $catalogPath -Path $env:HARNESS_UPDATE_STAGED -FilesToSkip 'harness-desktop.cat' -Detailed
    $catalog = [ordered]@{ status = "$($result.Status)"; signer = Signer $result.Signature }
  } catch {
    $catalog = [ordered]@{ status = 'Unreadable'; signer = (Read-Signer $catalogPath) }
  }
}
[ordered]@{
  running = Read-Signer $env:HARNESS_UPDATE_RUNNING
  runningFolder = @(Programs (Split-Path -Parent $env:HARNESS_UPDATE_RUNNING))
  files = $files
  catalog = $catalog
} | ConvertTo-Json -Depth 5 -Compress
""";

/// Asks a hidden Windows PowerShell who signed the running app, everything
/// beside it, every staged program and the staged file catalog.
Future<WindowsSignatureReport> readWindowsSignatureReport({
  required String stagedFolder,
  required String stagedLauncher,
  required String runningExe,
  Duration timeout = signatureCheckTimeout,
}) async {
  final script = windowsReportScript.codeUnits;
  final utf16 = Uint8List(script.length * 2);
  for (var i = 0; i < script.length; i++) {
    utf16[i * 2] = script[i] & 0xff;
    utf16[i * 2 + 1] = script[i] >> 8;
  }
  final result = await _run(
    windowsPowerShellPath(RuntimePlatform.environment),
    [
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-EncodedCommand',
      base64.encode(utf16),
    ],
    timeout,
    environment: {
      'HARNESS_UPDATE_STAGED': stagedFolder,
      'HARNESS_UPDATE_LAUNCHER': stagedLauncher,
      'HARNESS_UPDATE_RUNNING': runningExe,
    },
  );
  try {
    if (result.exitCode != 0) throw FormatException('exit ${result.exitCode}');
    return WindowsSignatureReport.fromJson(
      (jsonDecode('${result.stdout}') as Map).cast(),
    );
  } on Object catch (error) {
    debugPrint(
      'UpdateSignature: no report ($error): ${'${result.stderr}'.trim()}',
    );
    throw cannotCheckSignature;
  }
}

/// Refuses the staged Windows update unless [windowsUpdateRefusal] passes it.
Future<void> verifyWindowsUpdate({
  required String stagedFolder,
  required String stagedLauncher,
  required String runningExe,
  Duration timeout = signatureCheckTimeout,
}) async {
  final report = await readWindowsSignatureReport(
    stagedFolder: stagedFolder,
    stagedLauncher: stagedLauncher,
    runningExe: runningExe,
    timeout: timeout,
  );
  if (report.running.status == 'NotSigned') {
    debugPrint(
      'UpdateSignature: the running app is not signed; the update is checked by sha256 only',
    );
    return;
  }
  final refusal = windowsUpdateRefusal(report);
  if (refusal != null) {
    debugPrint('UpdateSignature: refused: $refusal');
    throw notFromPublisher(report.running.name);
  }
}

/// Runs a check through [startHidden] (no console window on Windows) and
/// refuses the update when it cannot finish within [timeout].
Future<ProcessResult> _run(
  String executable,
  List<String> arguments,
  Duration timeout, {
  Map<String, String>? environment,
}) async {
  final Process process;
  try {
    process = await startHidden(
      executable,
      arguments,
      environment: environment,
    );
  } on ProcessException catch (error) {
    debugPrint('UpdateSignature: could not start $executable: $error');
    throw cannotCheckSignature;
  }
  final stdout = process.stdout.transform(utf8.decoder).join();
  final stderr = process.stderr.transform(utf8.decoder).join();
  try {
    final code = await process.exitCode.timeout(timeout);
    return ProcessResult(process.pid, code, await stdout, await stderr);
  } on TimeoutException {
    process.kill();
    debugPrint('UpdateSignature: $executable took over ${timeout.inSeconds} s');
    throw cannotCheckSignature;
  }
}
