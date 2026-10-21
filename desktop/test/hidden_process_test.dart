import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/hidden_process.dart';

/// [script] as PowerShell's -EncodedCommand wants it: UTF-16LE, base64. No quoting to get wrong.
String _encoded(String script) {
  final bytes = BytesBuilder();
  for (final unit in script.codeUnits) {
    bytes
      ..addByte(unit & 0xff)
      ..addByte(unit >> 8);
  }
  return base64.encode(bytes.takeBytes());
}

/// Prints the console window the child was given: 0 when it has none.
const _consoleWindow = r'''
Add-Type -Namespace Harness -Name Console -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("kernel32.dll")] public static extern System.IntPtr GetConsoleWindow();
'@
[Console]::Out.Write("window=" + [Harness.Console]::GetConsoleWindow().ToInt64())
''';

void main() {
  group('off Windows', () {
    test(
      'runHidden is Process.run, environment and working folder included',
      () async {
        final scratch = await Directory.systemTemp.createTemp(
          'harness-hidden-',
        );
        addTearDown(() => scratch.delete(recursive: true));
        final result = await runHidden(
          '/bin/sh',
          ['-c', r'printf "%s" "$GREETING"'],
          environment: {'GREETING': 'Xin chào Nguyễn|'},
          workingDirectory: scratch.path,
        );
        expect(result.exitCode, 0);
        expect(result.stdout, 'Xin chào Nguyễn|');
      },
    );

    test('startHidden is Process.start, with pipes', () async {
      final process = await startHidden('/bin/cat', const []);
      process.stdin.write('ping');
      await process.stdin.close();
      expect(await utf8.decodeStream(process.stdout), 'ping');
      expect(await process.exitCode, 0);
    });
  }, skip: Platform.isWindows ? 'POSIX programs' : false);

  test('the CLI runner and the provisioner start their children through hidden_process', () {
    for (final path in [
      'lib/core/harness_cli_runner.dart',
      'lib/bootstrap/environment_provisioner.dart',
    ]) {
      final offenders = File(path)
          .readAsLinesSync()
          .where((line) => !line.trimLeft().startsWith('//'))
          // A call or a tear-off (`runProcess ?? Process.run`).
          .where((line) => RegExp(r'Process\.(run|start)\b').hasMatch(line))
          // The macOS and Linux Terminal handoff, never reached on Windows.
          .where(
            (line) =>
                !line.contains("'/usr/bin/open'") &&
                !line.contains('candidate.first'),
          )
          .toList();
      expect(offenders, isEmpty, reason: path);
    }
  });

  group('on Windows', () {
    final powershell =
        '${Platform.environment['SystemRoot']}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
    final arguments = [
      '-NoProfile',
      '-NonInteractive',
      '-EncodedCommand',
      _encoded(_consoleWindow),
    ];

    test(
      'a console child started by runHidden has no console window',
      () async {
        final result = await runHidden(powershell, arguments);
        expect(result.exitCode, 0, reason: '${result.stderr}');
        expect('${result.stdout}'.trim(), 'window=0');
      },
    );

    test(
      'a console child started by startHidden has no console window',
      () async {
        final process = await startHidden(powershell, arguments);
        await process.stdin.close();
        final output = await utf8.decodeStream(process.stdout);
        expect(await process.exitCode, 0);
        expect(output.trim(), 'window=0');
      },
    );

    test("a child's UTF-8 output arrives as written", () async {
      final result = await runHidden(powershell, [
        '-NoProfile',
        '-NonInteractive',
        '-EncodedCommand',
        _encoded(
          r"[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); "
          r"[Console]::Out.Write('Nguyễn Văn A')",
        ),
      ]);
      expect(result.stdout, 'Nguyễn Văn A');
    });
  }, skip: Platform.isWindows ? false : 'needs Windows');
}
