import 'dart:async';
import 'dart:ffi';
import 'dart:io';

import 'package:ffi/ffi.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/environment_setup_screen.dart';
import 'package:path/path.dart' as p;

import 'support/windows_test_node.dart';
import 'support/windows_scratch_cleanup.dart';

/// An owned Windows file handle that deliberately denies delete sharing.
class _NoDeleteShareHandle {
  _NoDeleteShareHandle._(this._value, this._close);

  final int _value;
  final int Function(int) _close;
  bool _closed = false;

  static _NoDeleteShareHandle open(String path) {
    final kernel = DynamicLibrary.open('kernel32.dll');
    final createFile = kernel
        .lookupFunction<
          IntPtr Function(
            Pointer<Utf16>,
            Uint32,
            Uint32,
            Pointer<Void>,
            Uint32,
            Uint32,
            IntPtr,
          ),
          int Function(Pointer<Utf16>, int, int, Pointer<Void>, int, int, int)
        >('CreateFileW');
    final close = kernel
        .lookupFunction<Int32 Function(IntPtr), int Function(int)>(
          'CloseHandle',
        );
    final nativePath = path.toNativeUtf16(allocator: calloc);
    try {
      final handle = createFile(
        nativePath,
        0x80000000, // GENERIC_READ
        0x00000001, // FILE_SHARE_READ, deliberately no FILE_SHARE_DELETE
        nullptr,
        3, // OPEN_EXISTING
        0x00000080, // FILE_ATTRIBUTE_NORMAL
        0,
      );
      if (handle == -1) {
        throw StateError('CreateFileW failed for owned fixture');
      }
      return _NoDeleteShareHandle._(handle, close);
    } finally {
      calloc.free(nativePath);
    }
  }

  void close() {
    if (_closed) return;
    if (_close(_value) == 0) {
      throw StateError('CloseHandle failed for owned fixture');
    }
    _closed = true;
  }
}

ProcessResult _result(int code, {String stdout = '', String stderr = ''}) =>
    ProcessResult(1, code, stdout, stderr);

/// A profile whose name a shell would re-parse (Review Focus 1).
const _profileName = "Nguyễn Văn A'&%!";

const _productionUrl = 'https://cdn.autonomous.ai/harness/cli/install.ps1';

/// What a person pastes into PowerShell, with the installer address quoted.
const _manualCommand =
    r'''iex "& { $(irm 'https://cdn.autonomous.ai/harness/cli/install.ps1') } -Desktop"''';

/// install.ps1's failure, as it prints one.
const _hostFailure = '''
Installing Harness for x64 into C:\\Users\\me\\.harness
  OK Harness 0.4.20 -> C:\\Users\\me\\.harness\\cli\\0.4.20

Harness could not be installed. The step that failed: Installing the terminal host.
  The terminal host archive lacks one of harness-pty.exe, harness-launch.exe, harness.exe, conpty.dll, OpenConsole.exe.
  Nothing outside C:\\Users\\me\\.harness and your PATH was changed. Run the installer again, or send this message to Harness support.
''';

/// A fake install.ps1 for the real-Windows tests: it lays down B's layout under
/// $env:USERPROFILE, with a copy of a real node.exe and a cli.js that answers
/// `version`. Pure ASCII, as install.ps1 is.
const _fakeInstaller = r'''
param([switch]$Desktop)
if (-not $Desktop) {
  Write-Host 'Harness could not be installed. The step that failed: Checking this computer.'
  Write-Host '  -Desktop was not passed.'
  $global:LASTEXITCODE = 1
  return
}
$root = Join-Path $env:USERPROFILE '.harness'
Write-Host "Installing Harness into $root"
function Set-Pointer([string]$Path, [string]$Value) {
  [IO.File]::WriteAllText($Path, "$Value`r`n", (New-Object Text.UTF8Encoding $false))
}
$nodeDir = Join-Path $root 'runtime\node-v22.23.2-win-x64'
$cliDir = Join-Path $root 'cli\0.4.20'
$ptyDir = Join-Path $root 'runtime\pty\0.4.20'
New-Item -ItemType Directory -Force -Path $nodeDir, $cliDir, $ptyDir | Out-Null
Copy-Item -LiteralPath $env:HARNESS_TEST_NODE -Destination (Join-Path $nodeDir 'node.exe')
Set-Pointer (Join-Path $root 'runtime\current-node') (Join-Path $nodeDir 'node.exe')
[IO.File]::WriteAllText((Join-Path $cliDir 'cli.js'), "console.log('0.4.20')`n")
Set-Pointer (Join-Path $root 'cli\current') '0.4.20'
[IO.File]::WriteAllBytes((Join-Path $ptyDir 'harness-pty.exe'), [byte[]]@())
Set-Pointer (Join-Path $root 'runtime\pty\current-pty') '0.4.20'
$global:LASTEXITCODE = 0
''';

/// Fails the way install.ps1 does, naming the profile, so the sentence must arrive intact.
const _fakeFailingInstaller = r'''
param([switch]$Desktop)
Write-Host ''
Write-Host 'Harness could not be installed. The step that failed: Installing the terminal host.' -ForegroundColor Red
Write-Host "  Could not write $env:USERPROFILE\.harness\runtime\pty." -ForegroundColor Red
$global:LASTEXITCODE = 1
''';

void main() {
  late Directory scratch;
  late Directory profile;
  late Directory harnessHome;

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('harness-env-windows-');
    profile = Directory(p.join(scratch.path, _profileName))..createSync();
    harnessHome = Directory(p.join(profile.path, '.harness'));
  });

  tearDown(() async {
    if (await scratch.exists()) await deleteWindowsScratch(scratch);
  });

  String nodePath() =>
      p.join(harnessHome.path, 'runtime', 'node-v22.23.2-win-x64', 'node.exe');

  /// What install.ps1 -Desktop leaves (B §1, "Layout"), pointers as it writes them.
  void installLayout({String cliVersion = '0.4.20', bool terminalHost = true}) {
    File(nodePath())
      ..createSync(recursive: true)
      ..writeAsStringSync('node');
    File(p.join(harnessHome.path, 'runtime', 'current-node'))
        .writeAsStringSync('${nodePath()}\r\n');
    File(p.join(harnessHome.path, 'cli', cliVersion, 'cli.js'))
      ..createSync(recursive: true)
      ..writeAsStringSync('cli');
    File(p.join(harnessHome.path, 'cli', 'current'))
        .writeAsStringSync('$cliVersion\r\n');
    if (terminalHost) {
      File(
        p.join(harnessHome.path, 'runtime', 'pty', '0.4.20', 'harness-pty.exe'),
      ).createSync(recursive: true);
      File(p.join(harnessHome.path, 'runtime', 'pty', 'current-pty'))
          .writeAsStringSync('0.4.20\r\n');
    }
  }

  Map<String, String> windowsEnvironment() => {
    'USERPROFILE': profile.path,
    'SystemRoot': r'C:\Windows',
    'Path': r'C:\Windows\System32',
  };

  /// A Windows computer with no shell: node answers, the CLI answers [version()], and PowerShell
  /// runs the installer, which lays down the layout when it succeeds and [lays] is set.
  ProcessRunner windows({
    required List<List<String>> calls,
    List<Map<String, String>?>? installEnvironments,
    String Function()? version,
    ProcessResult Function()? install,
    bool lays = true,
  }) {
    return (executable, arguments, {environment}) async {
      calls.add([executable, ...arguments]);
      if (executable.endsWith(r'\powershell.exe')) {
        installEnvironments?.add(environment);
        final answer =
            install?.call() ??
            _result(0, stdout: 'Harness 0.4.20 is installed.');
        if (answer.exitCode == 0 && lays) installLayout();
        return answer;
      }
      if (executable == nodePath() &&
          arguments.length == 1 &&
          arguments.single == '--version') {
        return _result(0, stdout: 'v22.23.2');
      }
      if (executable == nodePath() && arguments.last == 'version') {
        return _result(0, stdout: version?.call() ?? '0.4.20');
      }
      return _result(127, stderr: 'not a Windows program: $executable');
    };
  }

  EnvironmentProvisioner provisioner(
    ProcessRunner run, {
    String? installScriptUrl,
  }) => EnvironmentProvisioner(
    harnessHome: harnessHome,
    isMacOS: false,
    isLinux: false,
    isWindows: true,
    platformEnvironment: windowsEnvironment(),
    windowsInstallScriptUrl: installScriptUrl,
    run: run,
    openTerminal: (_) async => fail('Windows setup never opens a terminal'),
  );

  test('a PC with the CLI and the terminal host is ready, with no shell, tmux or clipboard step', () async {
    installLayout();
    final calls = <List<String>>[];
    final ready = await provisioner(windows(calls: calls))
        .ensureReady(onProgress: (_) {}, install: false);
    expect(ready.isReady, isTrue);
    expect(
      ready.steps[EnvironmentStep.clipboard],
      EnvironmentStepStatus.notApplicable,
    );
    expect(ready.steps[EnvironmentStep.tmux], EnvironmentStepStatus.ready);
    expect(ready.steps[EnvironmentStep.harness], EnvironmentStepStatus.ready);
    expect(calls.map((call) => call.first), everyElement(nodePath()));
    expect(ready.output.join('\n'), contains('terminal host 0.4.20'));
    expect(ready.output.join('\n'), isNot(contains('tmux')));
  });

  test('a PC without Harness gets a two-item plan that installs in-app, and nothing ran', () async {
    final calls = <List<String>>[];
    final probed = await provisioner(windows(calls: calls))
        .ensureReady(onProgress: (_) {}, install: false);
    expect(probed.phase, EnvironmentSetupPhase.review);
    expect(probed.plan.map((item) => item.step), [
      EnvironmentStep.harness,
      EnvironmentStep.tmux,
    ]);
    // In-app, so AppNotifier installs straight after the probe, with no review screen.
    expect(probed.plan.any((item) => item.requiresTerminal), isFalse);
    expect(calls, isEmpty);
  });

  test('install runs install.ps1 -Desktop hidden, by this exact argv, then verifies', () async {
    final calls = <List<String>>[];
    final environments = <Map<String, String>?>[];
    final ready =
        await provisioner(
          windows(calls: calls, installEnvironments: environments),
        ).ensureReady(
          onProgress: (_) {},
          install: true,
          mode: EnvironmentSetupMode.automatic,
        );
    expect(ready.isReady, isTrue, reason: '${ready.failure?.detail}');
    final install = calls.singleWhere(
      (call) => call.first.endsWith('powershell.exe'),
    );
    expect(install, [
      r'C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-Command',
      r"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
          r"""iex "& { $(irm 'https://cdn.autonomous.ai/harness/cli/install.ps1' -ErrorAction Stop) } -Desktop"; exit $LASTEXITCODE""",
    ]);
    // Review Focus 1: the profile is never on the command line, only in the environment, as is.
    expect(install.join(' '), isNot(contains(_profileName)));
    expect(environments.single?['USERPROFILE'], profile.path);
    expect(ready.output, contains('Harness 0.4.20 is installed.'));
  });

  test('an older CLI is reinstalled, through the same install.ps1', () async {
    installLayout(cliVersion: '0.4.19');
    var installed = '0.4.19';
    final calls = <List<String>>[];
    ProcessRunner run() => windows(
      calls: calls,
      version: () => installed,
      install: () {
        installed = '0.4.20';
        return _result(0);
      },
    );
    final probed = await provisioner(run())
        .ensureReady(onProgress: (_) {}, install: false);
    expect(probed.steps[EnvironmentStep.harness], EnvironmentStepStatus.failed);
    expect(
      probed.output,
      contains('✗ harness 0.4.19 < $kMinimumWindowsHarnessCliVersion'),
    );
    expect(probed.plan.map((item) => item.step), [EnvironmentStep.harness]);

    final ready = await provisioner(run()).ensureReady(
      onProgress: (_) {},
      resumeFrom: probed,
      install: true,
      mode: EnvironmentSetupMode.automatic,
    );
    expect(ready.isReady, isTrue);
    expect(
      calls.where((call) => call.first.endsWith('powershell.exe')),
      hasLength(1),
    );
  });

  test(
    "a failed install keeps install.ps1's own sentence and names its step",
    () async {
      final calls = <List<String>>[];
      final failed =
          await provisioner(
            windows(
              calls: calls,
              install: () => _result(1, stdout: _hostFailure),
            ),
          ).ensureReady(
            onProgress: (_) {},
            install: true,
            mode: EnvironmentSetupMode.automatic,
          );
      expect(failed.phase, EnvironmentSetupPhase.failed);
      expect(failed.failure?.step, EnvironmentStep.tmux);
      expect(failed.failure?.title, 'Harness could not be installed');
      expect(
        failed.failure?.detail,
        'The step that failed: Installing the terminal host. The terminal host archive lacks one '
        'of harness-pty.exe, harness-launch.exe, harness.exe, conpty.dll, OpenConsole.exe.',
      );
      expect(failed.failure?.command, _manualCommand);
      expect(failed.failure?.exitCode, 1);
      expect(failed.steps[EnvironmentStep.tmux], EnvironmentStepStatus.failed);
      // The whole sentence is in the log the screen shows and Copy diagnostics copies.
      expect(
        failed.output,
        contains(
          'Harness could not be installed. The step that failed: Installing the terminal host.',
        ),
      );
    },
  );

  test("an installer that cannot be downloaded fails with PowerShell's own error", () async {
    final failed =
        await provisioner(
          windows(
            calls: [],
            install: () => _result(
              1,
              stderr:
                  'irm : The remote server returned an error: (404) Not Found.',
            ),
          ),
        ).ensureReady(
          onProgress: (_) {},
          install: true,
          mode: EnvironmentSetupMode.automatic,
        );
    expect(failed.phase, EnvironmentSetupPhase.failed);
    expect(failed.failure?.step, EnvironmentStep.harness);
    expect(failed.failure?.detail, contains('(404) Not Found'));
    expect(failed.failure?.exitCode, 1);
  });

  test(
    'an install that exits 0 but leaves no CLI fails its final check',
    () async {
      final failed = await provisioner(windows(calls: [], lays: false))
          .ensureReady(
            onProgress: (_) {},
            install: true,
            mode: EnvironmentSetupMode.automatic,
          );
      expect(failed.phase, EnvironmentSetupPhase.failed);
      expect(failed.failure?.command, _manualCommand);
    },
  );

  test('an installer address this build does not trust is never run', () async {
    final calls = <List<String>>[];
    final failed =
        await provisioner(
          windows(calls: calls),
          installScriptUrl: r"https://cdn.autonomous.ai/x'); calc; ('",
        ).ensureReady(
          onProgress: (_) {},
          install: true,
          mode: EnvironmentSetupMode.automatic,
        );
    expect(failed.phase, EnvironmentSetupPhase.failed);
    expect(
      calls.where((call) => call.first.endsWith('powershell.exe')),
      isEmpty,
    );
  });

  test('manual recovery quotes a trusted multi-query installer URL', () {
    const url = 'https://example.com/install.ps1?a=1&b=2;tail=(ok)';
    expect(isTrustedInstallScriptUrl(url), isTrue);
    expect(
      windowsManualInstallCommand(url),
      r'''iex "& { $(irm 'https://example.com/install.ps1?a=1&b=2;tail=(ok)') } -Desktop"''',
    );
  });

  test('the installer address: production, staging, or a trusted override', () {
    expect(
      harnessInstallScriptUrl(override: '', staging: false),
      _productionUrl,
    );
    expect(
      harnessInstallScriptUrl(override: '', staging: true),
      'https://cdn.autonomous.ai/harness/staging/cli/install.ps1',
    );
    expect(
      harnessInstallScriptUrl(
        override: 'http://127.0.0.1:8080/install.ps1',
        staging: true,
      ),
      'http://127.0.0.1:8080/install.ps1',
    );
    for (final trusted in [
      _productionUrl,
      'https://cdn.autonomous.ai/harness/staging/cli/install.ps1',
      'http://127.0.0.1:53111/install.ps1',
      'http://localhost:8080/install.ps1?run=1',
    ]) {
      expect(isTrustedInstallScriptUrl(trusted), isTrue, reason: trusted);
    }
    for (final refused in [
      '',
      'https://',
      r"https://cdn.autonomous.ai/x'); calc; ('",
      r'https://cdn.autonomous.ai/$(calc)',
      'https://cdn.autonomous.ai/`calc`',
      'https://cdn.autonomous.ai/"x"',
      'https://cdn.autonomous.ai/a b',
      'http://cdn.autonomous.ai/install.ps1',
      'file:///C:/install.ps1',
      'ftp://cdn.autonomous.ai/install.ps1',
    ]) {
      expect(isTrustedInstallScriptUrl(refused), isFalse, reason: refused);
    }
  });

  test(
    'a profile Harness cannot write to stops setup before any check',
    () async {
      profile.createSync();
      Process.runSync('chmod', ['500', profile.path]);
      addTearDown(() => Process.runSync('chmod', ['700', profile.path]));
      final calls = <List<String>>[];
      final failed = await provisioner(windows(calls: calls))
          .ensureReady(onProgress: (_) {}, install: false);
      expect(failed.phase, EnvironmentSetupPhase.failed);
      expect(failed.failure?.title, 'Home directory is not writable');
      expect(failed.failure?.detail, contains(r'%USERPROFILE%\.harness'));
      expect(calls, isEmpty);
    },
    skip: Platform.isWindows
        ? 'POSIX modes; the Windows probe is the same file write'
        : false,
  );

  testWidgets('the setup list names the terminal host on Windows', (
    tester,
  ) async {
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SingleChildScrollView(
            child: EnvironmentCheckList(
              isWindows: true,
              readiness: EnvironmentReadiness(
                steps: const {
                  EnvironmentStep.clipboard:
                      EnvironmentStepStatus.notApplicable,
                  EnvironmentStep.tmux: EnvironmentStepStatus.failed,
                  EnvironmentStep.harness: EnvironmentStepStatus.ready,
                },
                phase: EnvironmentSetupPhase.review,
                plan: [EnvironmentPlanItem.windowsTerminalHost],
              ),
            ),
          ),
        ),
      ),
    );
    expect(find.text('Terminal host'), findsOneWidget);
    expect(find.text('tmux terminal backend'), findsNothing);
    expect(
      find.textContaining('installs with the Harness CLI'),
      findsOneWidget,
    );
    expect(find.textContaining(r'%USERPROFILE%\.harness'), findsOneWidget);
  });

  group('on a real Windows', () {
    test(
      'fixture cleanup retries real sharing32 until its owned handle closes',
      () async {
        final owned = await Directory.systemTemp.createTemp(
          'harness-cleanup-release-',
        );
        final target = File(
          p.join(owned.path, _profileName, '.harness', 'node.exe'),
        );
        await target.create(recursive: true);
        final handle = _NoDeleteShareHandle.open(target.path);
        final firstSharing = Completer<FileSystemException?>();
        try {
          final deletion = deleteWindowsScratch(
            owned,
            onSharingViolation: (error) {
              if (!firstSharing.isCompleted) firstSharing.complete(error);
            },
          );
          unawaited(
            deletion.then(
              (_) {
                if (!firstSharing.isCompleted) firstSharing.complete(null);
              },
              onError: (Object error, StackTrace stack) {
                if (!firstSharing.isCompleted) {
                  firstSharing.completeError(error, stack);
                }
              },
            ),
          );
          final error = await firstSharing.future;
          expect(error?.osError?.errorCode, 32);
          expect(await owned.exists(), isTrue);
          handle.close();
          await deletion;
          expect(await owned.exists(), isFalse);
        } finally {
          handle.close();
          if (await owned.exists()) await owned.delete(recursive: true);
        }
      },
    );

    test('fixture cleanup fails sharing32 at deadline while its owned handle remains open', () async {
      final owned = await Directory.systemTemp.createTemp(
        'harness-cleanup-held-',
      );
      final target = File(
        p.join(owned.path, _profileName, '.harness', 'node.exe'),
      );
      await target.create(recursive: true);
      final handle = _NoDeleteShareHandle.open(target.path);
      try {
        await expectLater(
          deleteWindowsScratch(
            owned,
            timeout: const Duration(milliseconds: 80),
          ),
          throwsA(
            isA<FileSystemException>().having(
              (error) => error.osError?.errorCode,
              'Windows error',
              32,
            ),
          ),
        );
        expect(await owned.exists(), isTrue);
        handle.close();
        await owned.delete(recursive: true);
        expect(await owned.exists(), isFalse);
      } finally {
        handle.close();
        if (await owned.exists()) await owned.delete(recursive: true);
      }
    });

    test('fixture cleanup rejects success after a delayed retry passes its deadline', () async {
      final owned = await Directory.systemTemp.createTemp(
        'harness-cleanup-late-',
      );
      final target = File(
        p.join(owned.path, _profileName, '.harness', 'node.exe'),
      );
      await target.create(recursive: true);
      final handle = _NoDeleteShareHandle.open(target.path);
      var sawSharing = false;
      var delayedRetry = false;
      try {
        final deletion = runZoned(
          () => deleteWindowsScratch(
            owned,
            timeout: const Duration(milliseconds: 300),
            onSharingViolation: (error) {
              expect(error.osError?.errorCode, 32);
              sawSharing = true;
            },
          ),
          zoneSpecification: ZoneSpecification(
            createTimer: (self, parent, zone, duration, callback) {
              if (duration > const Duration(milliseconds: 20)) {
                return parent.createTimer(zone, duration, callback);
              }
              delayedRetry = true;
              return parent.createTimer(
                zone,
                const Duration(milliseconds: 600),
                () {
                  handle.close();
                  callback();
                },
              );
            },
          ),
        );
        await expectLater(
          deletion,
          throwsA(
            isA<FileSystemException>().having(
              (error) => error.osError?.errorCode,
              'Windows error',
              32,
            ),
          ),
        );
        expect(sawSharing, isTrue);
        expect(delayedRetry, isTrue);
        expect(await owned.exists(), isTrue);
      } finally {
        handle.close();
        if (await owned.exists()) await owned.delete(recursive: true);
      }
      expect(await owned.exists(), isFalse);
    });

    Future<HttpServer> serve(
      Map<String, String> scripts, {
      List<Uri>? requests,
    }) async {
      final server = await HttpServer.bind(InternetAddress.loopbackIPv4, 0);
      server.listen((request) async {
        requests?.add(request.uri);
        final body = scripts[request.uri.path];
        request.response.statusCode = body == null ? 404 : 200;
        if (body != null) request.response.write(body);
        await request.response.close();
      });
      addTearDown(() => server.close(force: true));
      return server;
    }

    EnvironmentProvisioner real(String url) => EnvironmentProvisioner(
      harnessHome: harnessHome,
      platformEnvironment: {
        ...Platform.environment,
        'USERPROFILE': profile.path,
        'HARNESS_TEST_NODE': realWindowsNode(),
      },
      windowsInstallScriptUrl: url,
    );

    test('install.ps1 -Desktop runs hidden in Windows PowerShell and installs into a profile whose name needs quoting', () async {
      final server = await serve({'/install.ps1': _fakeInstaller});
      final ready = await real('http://127.0.0.1:${server.port}/install.ps1')
          .ensureReady(
            onProgress: (_) {},
            install: true,
            mode: EnvironmentSetupMode.automatic,
          );
      expect(
        ready.isReady,
        isTrue,
        reason: '${ready.failure?.detail}\n${ready.output.join('\n')}',
      );
      // UTF-8 end to end: PowerShell's own line about the profile arrives as written.
      expect(
        ready.output,
        contains('Installing Harness into ${harnessHome.path}'),
      );
    }, timeout: const Timeout(Duration(minutes: 2)));

    test('manual recovery installs from a trusted multi-query URL', () async {
      final requests = <Uri>[];
      final server = await serve({
        '/install.ps1': _fakeInstaller,
      }, requests: requests);
      final url =
          'http://127.0.0.1:${server.port}/install.ps1?a=1&b=2;tail=(ok)';
      expect(isTrustedInstallScriptUrl(url), isTrue);
      final installed = await Process.run(
        windowsPowerShellPath(Platform.environment),
        [
          '-NoProfile',
          '-NonInteractive',
          '-ExecutionPolicy',
          'Bypass',
          '-Command',
          '${windowsManualInstallCommand(url)}; exit \$LASTEXITCODE',
        ],
        environment: {
          ...Platform.environment,
          'USERPROFILE': profile.path,
          'HARNESS_TEST_NODE': realWindowsNode(),
        },
      );
      expect(installed.exitCode, 0, reason: '${installed.stderr}');
      expect(requests, hasLength(1));
      expect(requests.single.queryParameters, {'a': '1', 'b': '2;tail=(ok)'});
      final ready = await real(url)
          .ensureReady(onProgress: (_) {}, install: false);
      expect(ready.isReady, isTrue, reason: '${ready.failure?.detail}');
    }, timeout: const Timeout(Duration(minutes: 2)));

    test("a failed install's sentence and exit code arrive intact", () async {
      final server = await serve({'/install.ps1': _fakeFailingInstaller});
      final failed = await real('http://127.0.0.1:${server.port}/install.ps1')
          .ensureReady(
            onProgress: (_) {},
            install: true,
            mode: EnvironmentSetupMode.automatic,
          );
      expect(failed.phase, EnvironmentSetupPhase.failed);
      expect(
        failed.failure?.exitCode,
        1,
        reason: 'exit \$LASTEXITCODE carries the result',
      );
      expect(
        failed.failure?.detail,
        'The step that failed: Installing the terminal host. '
        'Could not write ${profile.path}\\.harness\\runtime\\pty.',
      );
    }, timeout: const Timeout(Duration(minutes: 2)));
  }, skip: Platform.isWindows ? false : 'needs Windows');
}
