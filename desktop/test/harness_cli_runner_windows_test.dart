import 'dart:convert';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/harness_cli_runner.dart';
import 'package:harness/core/windows_layout.dart';
import 'package:path/path.dart' as p;

import 'support/windows_test_node.dart';

/// A profile whose name a shell would re-parse (Review Focus 1).
const _profileName = "Nguyễn Văn A'&%!";

/// Prints its arguments as JSON with every non-ASCII character escaped, so the real-Windows check
/// is about argv alone, not about how stdout is decoded (C1.5 checks that).
const _echoArguments = r'''
const json = JSON.stringify(process.argv.slice(2));
console.log(json.replace(/[\u007f-\uffff]/g, (c) => '\\u' + c.charCodeAt(0).toString(16).padStart(4, '0')));
''';

void main() {
  late Directory scratch;
  late Directory profile;
  late Directory harnessHome;

  setUp(() async {
    scratch = await Directory.systemTemp.createTemp('harness-cli-windows-');
    profile = Directory(p.join(scratch.path, _profileName))..createSync();
    harnessHome = Directory(p.join(profile.path, '.harness'))..createSync();
  });

  tearDown(() async {
    for (var attempt = 0; attempt < 40; attempt++) {
      if (!await scratch.exists()) return;
      try {
        await scratch.delete(recursive: true);
        return;
      } on FileSystemException catch (error) {
        // Windows can briefly retain node.exe after its process has exited.
        if (!Platform.isWindows ||
            error.osError?.errorCode != 32 ||
            attempt == 39) {
          rethrow;
        }
        await Future<void>.delayed(const Duration(milliseconds: 125));
      }
    }
  });

  File defaultNode() => File(
    p.join(harnessHome.path, 'runtime', 'node-v22.23.2-win-x64', 'node.exe'),
  );

  /// `runtime\current-node` naming [node], as install.ps1 writes a pointer: UTF-8, CRLF.
  File installNode({File? node}) {
    final exe = node ?? defaultNode();
    if (!exe.existsSync()) exe.createSync(recursive: true);
    File(p.join(harnessHome.path, 'runtime', 'current-node'))
      ..createSync(recursive: true)
      ..writeAsStringSync('${exe.path}\r\n');
    return exe;
  }

  /// `cli\<version>\cli.js`, and a `cli\current` holding [pointer] as written.
  File installCli(String pointer, {String version = '0.4.20'}) {
    final cli = File(p.join(harnessHome.path, 'cli', version, 'cli.js'))
      ..createSync(recursive: true);
    File(p.join(harnessHome.path, 'cli', 'current')).writeAsStringSync(pointer);
    return cli;
  }

  HarnessCliRunner runner([Map<String, String>? environment]) =>
      HarnessCliRunner(
        harnessHome: harnessHome,
        environment:
            environment ??
            {'USERPROFILE': profile.path, 'Path': r'C:\Windows\System32'},
        isWindows: true,
      );

  group('resolve on Windows', () {
    test('the managed tier is current-node with cli\\current, in a profile whose name needs quoting', () async {
      final node = installNode();
      final cli = installCli('0.4.20\r\n');
      final invocation = await runner().resolve([
        'link',
        'import',
        "a'b&c%d!e",
      ]);
      expect(invocation.source, HarnessCliSource.managed);
      expect(invocation.executable, node.path);
      expect(invocation.executable, contains(_profileName));
      // One argument each, never joined into a command line here: nothing re-parses them.
      expect(invocation.arguments, [cli.path, 'link', 'import', "a'b&c%d!e"]);
    });

    test('a pointer saved with a byte order mark still names its folder, as B reads it', () async {
      installNode();
      final cli = installCli('\uFEFF0.4.20\r\n');
      final invocation = await runner().resolve(['version']);
      expect(invocation.source, HarnessCliSource.managed);
      expect(invocation.arguments.first, cli.path);
    });

    test(
      'a cli\\current that names anything but one folder is refused',
      () async {
        installNode();
        for (final bad in [
          '',
          '.',
          '..',
          r'..\0.4.20',
          '0.4.20/..',
          r'a\b',
          'a/b',
          'C:x',
          'cli.js:x',
        ]) {
          installCli(bad);
          final invocation = await runner().resolve(['version']);
          expect(
            invocation.source,
            isNot(HarnessCliSource.managed),
            reason: bad,
          );
        }
      },
    );

    test('a Node outside runtime is refused', () async {
      installNode(node: File(p.join(scratch.path, 'elsewhere', 'node.exe')));
      installCli('0.4.20');
      final invocation = await runner().resolve(['version']);
      expect(invocation.source, isNot(HarnessCliSource.managed));
    });

    test(
      'a version folder that leads out of cli through a link is refused',
      () async {
        installNode();
        final planted = Directory(p.join(scratch.path, 'planted'))
          ..createSync();
        File(p.join(planted.path, 'cli.js')).writeAsStringSync('planted');
        Directory(p.join(harnessHome.path, 'cli')).createSync();
        Link(p.join(harnessHome.path, 'cli', '0.4.20'))
            .createSync(planted.path);
        File(p.join(harnessHome.path, 'cli', 'current'))
            .writeAsStringSync('0.4.20');
        final invocation = await runner().resolve(['version']);
        expect(invocation.source, isNot(HarnessCliSource.managed));
      },
    );

    test('then bin\\harness.exe, then a harness.exe in a PATH folder, never a relative one', () async {
      final onPath = Directory(p.join(scratch.path, 'on path'))..createSync();
      final pathExe = File(p.join(onPath.path, 'harness.exe'))
        ..writeAsStringSync('');
      final environment = {
        'USERPROFILE': profile.path,
        'Path': 'relative;"${onPath.path}"',
      };
      final fromPath = await runner(environment).resolve(['start']);
      expect(fromPath.source, HarnessCliSource.path);
      expect(fromPath.executable, pathExe.path);

      final launcher = File(p.join(harnessHome.path, 'bin', 'harness.exe'))
        ..createSync(recursive: true);
      final invocation = await runner(environment).resolve(['start']);
      expect(invocation.source, HarnessCliSource.launcher);
      expect(invocation.executable, launcher.path);
      expect(invocation.arguments, ['start']);
    });

    test('with nothing installed the last tier is the bare name', () async {
      final invocation = await runner({'USERPROFILE': profile.path})
          .resolve(['start']);
      expect(invocation.source, HarnessCliSource.path);
      expect(invocation.executable, 'harness.exe');
    });

    test(
      'bin joins the inherited Path once, with a semicolon, under its own name',
      () async {
        final invocation = await runner().resolve(['start']);
        expect(
          invocation.environment.keys.where(
            (key) => key.toUpperCase() == 'PATH',
          ),
          ['Path'],
        );
        expect(
          invocation.environment['Path'],
          '${p.join(harnessHome.path, 'bin')};C:\\Windows\\System32',
        );
        expect(invocation.environment['USERPROFILE'], profile.path);
        expect(invocation.environment['LC_ALL'], isNull);
      },
    );

    test(
      'the default Harness home is in USERPROFILE even when Git Bash set HOME',
      () {
        // Review Focus 5.
        final defaults = HarnessCliRunner(
          environment: {
            'HOME': '/c/Users/someone',
            'USERPROFILE': profile.path,
          },
          isWindows: true,
        );
        expect(defaults.harnessHome.path, p.join(profile.path, '.harness'));
      },
    );
  });

  group('the layout', () {
    test('isSingleSegment is B\'s rule', () {
      for (final good in ['0.4.20', '0.3.120-dev.abc123', 'node-v22']) {
        expect(isSingleSegment(good), isTrue, reason: good);
      }
      for (final bad in [
        '',
        '.',
        '..',
        'a..b',
        r'a\b',
        'a/b',
        'C:',
        'a\u0000b',
      ]) {
        expect(isSingleSegment(bad), isFalse, reason: bad);
      }
    });

    test(
      'installedTerminalHost is the harness-pty.exe that current-pty names',
      () async {
        expect(await installedTerminalHost(harnessHome), isNull);
        final host = File(
          p.join(
            harnessHome.path,
            'runtime',
            'pty',
            '0.4.20',
            'harness-pty.exe',
          ),
        )..createSync(recursive: true);
        final pointer = File(
          p.join(harnessHome.path, 'runtime', 'pty', 'current-pty'),
        )..writeAsStringSync('\uFEFF0.4.20\r\n');
        expect(await installedTerminalHost(harnessHome), (
          version: '0.4.20',
          path: host.path,
        ));
        for (final bad in ['0.4.20-rc.1', '..', r'0.4.20\..\x', 'current']) {
          pointer.writeAsStringSync(bad);
          expect(await installedTerminalHost(harnessHome), isNull, reason: bad);
        }
        pointer.writeAsStringSync('0.4.21');
        expect(
          await installedTerminalHost(harnessHome),
          isNull,
          reason: 'a version folder without its host',
        );
      },
    );
  });

  group('on a real Windows', () {
    test('node.exe gets every argument intact, run from a profile whose name needs quoting', () async {
      final node = defaultNode();
      node.parent.createSync(recursive: true);
      File(realWindowsNode()).copySync(node.path);
      installNode(node: node);
      installCli('0.4.20\r\n').writeAsStringSync(_echoArguments);
      const arguments = [
        'link',
        'import',
        "a'b&c%d!e Nguyễn Văn",
        'say "hi"',
        r'ends\',
        '',
      ];
      final result = await HarnessCliRunner(
        harnessHome: harnessHome,
        environment: {...Platform.environment, 'USERPROFILE': profile.path},
      ).run(arguments);
      expect(result.exitCode, 0, reason: '${result.stderr}');
      expect(jsonDecode('${result.stdout}'.trim()), arguments);
    });
  }, skip: Platform.isWindows ? false : 'needs Windows');
}
