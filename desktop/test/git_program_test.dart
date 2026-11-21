import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/git_program.dart';
import 'package:path/path.dart' as p;

void main() {
  /// A Windows folder that names its drive or its server: `\tools` is
  /// absolute to the path package but means the working folder's drive.
  bool windowsAbsolute(String path) =>
      p.windows.isAbsolute(path) && !p.windows.isRootRelative(path);

  group('on Windows', () {
    test('a git.exe planted in the working folder is never run', () {
      final asked = <String>[];
      final git = GitProgram(
        isWindows: true,
        environment: {
          'PATH': r'.;;tools;\tools;C:\Tools',
          'ProgramFiles': 'Program Files',
          'LOCALAPPDATA': '.',
          'SCOOP': 'scoop',
        },
        // Every relative path finds the planted git.exe in the working folder.
        isProgram: (path) {
          asked.add(path);
          return !windowsAbsolute(path) || path == r'C:\Tools\git.exe';
        },
      );

      expect(git.resolve(), r'C:\Tools\git.exe');
      expect(asked, isNotEmpty);
      expect(asked.where((path) => !windowsAbsolute(path)), isEmpty);
    });

    test('runs git.exe alone, never a git.cmd that needs cmd.exe', () {
      final git = GitProgram(
        isWindows: true,
        environment: {'PATH': r'C:\Scripts;C:\Git\cmd'},
        isProgram: {
          r'C:\Scripts\git.cmd',
          r'C:\Scripts\git.bat',
          r'C:\Scripts\git',
          r'C:\Git\cmd\git.exe',
        }.contains,
      );

      expect(git.resolve(), r'C:\Git\cmd\git.exe');
    });

    test('finds Git for Windows where it installs when PATH has none', () {
      const environment = {
        'PATH': r'C:\Windows\System32',
        'ProgramFiles': r'C:\Program Files',
        'LOCALAPPDATA': r'C:\Users\ana\AppData\Local',
        'USERPROFILE': r'C:\Users\ana',
        'SCOOP': r'D:\scoop',
      };
      for (final found in [
        r'C:\Program Files\Git\cmd\git.exe',
        r'C:\Users\ana\AppData\Local\Programs\Git\cmd\git.exe',
        r'D:\scoop\shims\git.exe',
        r'C:\Users\ana\scoop\shims\git.exe',
      ]) {
        final git = GitProgram(
          isWindows: true,
          environment: environment,
          isProgram: {found}.contains,
        );
        expect(git.resolve(), found);
      }
    });

    // Any member of Users can make %ProgramData%\scoop, so a shim there is anyone's.
    test("never runs a git from Scoop's root for everyone", () {
      final git = GitProgram(
        isWindows: true,
        environment: {
          'PATH': r'C:\Windows\System32',
          'SCOOP_GLOBAL': r'D:\scoop-global',
          'ProgramData': r'C:\ProgramData',
        },
        isProgram: {
          r'D:\scoop-global\shims\git.exe',
          r'C:\ProgramData\scoop\shims\git.exe',
        }.contains,
      );

      expect(git.resolve, throwsA(isA<ProcessException>()));
    });

    test('PATH comes before the install folders', () {
      final git = GitProgram(
        isWindows: true,
        environment: {
          'PATH': r'C:\Tools',
          'ProgramFiles': r'C:\Program Files',
        },
        isProgram: {
          r'C:\Program Files\Git\cmd\git.exe',
          r'C:\Tools\git.exe',
        }.contains,
      );

      expect(git.resolve(), r'C:\Tools\git.exe');
    });
  });

  group('on macOS and Linux', () {
    test('takes the first git in PATH order', () {
      final git = GitProgram(
        isWindows: false,
        environment: {'PATH': '/opt/homebrew/bin:/usr/bin'},
        isProgram: {'/opt/homebrew/bin/git', '/usr/bin/git'}.contains,
      );

      expect(git.resolve(), '/opt/homebrew/bin/git');
    });

    test(
      'passes over a git it cannot run, a file without an execute bit',
      () {
        final folder = Directory.systemTemp.createTempSync('git-program-');
        addTearDown(() => folder.deleteSync(recursive: true));
        String git(String name, String mode) {
          final path = p.join(folder.path, name, 'git');
          File(path).createSync(recursive: true);
          Process.runSync('/bin/chmod', [mode, path]);
          return path;
        }

        final plain = git('plain', '644');
        final runnable = git('bin', '755');
        final found = GitProgram(
          isWindows: false,
          environment: {'PATH': '${p.dirname(plain)}:${p.dirname(runnable)}'},
        ).resolve();

        expect(found, runnable);
      },
      skip: Platform.isWindows,
    );

    test('never looks in the working folder', () {
      final asked = <String>[];
      final git = GitProgram(
        isWindows: false,
        environment: {'PATH': '.:bin::/usr/bin'},
        isProgram: (path) {
          asked.add(path);
          return !p.posix.isAbsolute(path) || path == '/usr/bin/git';
        },
      );

      expect(git.resolve(), '/usr/bin/git');
      expect(asked.where((path) => !p.posix.isAbsolute(path)), isEmpty);
    });
  });

  test('no git throws what a failed Process.start of git throws', () {
    final git = GitProgram(
      isWindows: false,
      environment: {'PATH': '/usr/bin'},
      isProgram: (_) => false,
    );

    expect(
      git.resolve,
      throwsA(
        isA<ProcessException>()
            .having((error) => error.executable, 'executable', 'git')
            .having((error) => error.errorCode, 'errorCode', 2),
      ),
    );
  });

  test('a miss looks again, a find is kept', () {
    var installed = false;
    var asks = 0;
    final git = GitProgram(
      isWindows: false,
      environment: {'PATH': '/usr/bin'},
      isProgram: (path) {
        asks++;
        return installed && path == '/usr/bin/git';
      },
    );

    expect(git.resolve, throwsA(isA<ProcessException>()));
    installed = true;
    expect(git.resolve(), '/usr/bin/git');
    final asksWhenFound = asks;
    installed = false;
    expect(git.resolve(), '/usr/bin/git');
    expect(asks, asksWhenFound);
  });

  test("gitProgram is this process's git, by an absolute path", () {
    final git = gitProgram();
    expect(p.isAbsolute(git), isTrue);
    expect(gitProgram(), same(git));
  });
}
