import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/home_dir.dart';
import 'package:path/path.dart' as p;

/// Every Dart source under lib/, as (path with forward slashes, text).
List<(String, String)> _libSources() => [
  for (final file
      in Directory('lib')
          .listSync(recursive: true)
          .whereType<File>()
          .where((f) => f.path.endsWith('.dart')))
    (p.split(p.relative(file.path)).join('/'), file.readAsStringSync()),
];

void main() {
  group('homeDir', () {
    test('is USERPROFILE on Windows, even when Git Bash exported a HOME of its own', () {
      // Review Focus 5. Git Bash, MSYS2 and Cygwin hand every program they start a HOME such as
      // /c/Users/me; the CLI and B's launchers live in the profile.
      expect(
        homeDir(
          environment: {'HOME': '/c/Users/me', 'USERPROFILE': r'C:\Users\me'},
          isWindows: true,
        ),
        r'C:\Users\me',
      );
    });

    test('is HOME off Windows, even when USERPROFILE is set', () {
      expect(
        homeDir(
          environment: {'HOME': '/Users/me', 'USERPROFILE': r'C:\Users\me'},
          isWindows: false,
        ),
        '/Users/me',
      );
    });

    test(
      'falls back to the other variable when its own is missing or empty',
      () {
        expect(
          homeDir(environment: {'HOME': '/home/me'}, isWindows: true),
          '/home/me',
        );
        expect(
          homeDir(
            environment: {'USERPROFILE': '', 'HOME': '/home/me'},
            isWindows: true,
          ),
          '/home/me',
        );
        expect(
          homeDir(
            environment: {'USERPROFILE': r'C:\Users\me'},
            isWindows: false,
          ),
          r'C:\Users\me',
        );
        expect(
          homeDir(
            environment: {'HOME': '', 'USERPROFILE': r'C:\Users\me'},
            isWindows: false,
          ),
          r'C:\Users\me',
        );
      },
    );

    test('on Windows HOMEDRIVE and HOMEPATH come before HOME', () {
      expect(
        homeDir(
          environment: {
            'HOMEDRIVE': 'D:',
            'HOMEPATH': r'\Users\me',
            'HOME': '/c/Users/me',
          },
          isWindows: true,
        ),
        r'D:\Users\me',
      );
    });

    test('keeps a profile path exactly as Windows gives it', () {
      const profile = "C:\\Users\\Nguyễn Văn A'&%!";
      expect(
        homeDir(environment: {'USERPROFILE': profile}, isWindows: true),
        profile,
      );
    });

    test(
      'with no variable at all, maybeHomeDir is null and homeDir throws',
      () {
        expect(maybeHomeDir(environment: const {}, isWindows: true), isNull);
        expect(maybeHomeDir(environment: const {}, isWindows: false), isNull);
        expect(
          () => homeDir(environment: const {}, isWindows: false),
          throwsStateError,
        );
      },
    );
  });

  group('lib/', () {
    test('reads HOME and USERPROFILE only through homeDir', () {
      const allowed = {
        'lib/core/home_dir.dart': 'the one reader',
        'lib/core/linux_app_image.dart':
            'the AppImage desktop entry, Linux only',
        'lib/ws/local_daemon_transport.dart':
            'the Unix socket path, null on Windows before HOME is read',
      };
      final reader = RegExp(r'''\[\s*['"](HOME|USERPROFILE)['"]\s*\]''');
      final sources = _libSources();
      expect(
        sources.length,
        greaterThan(500),
        reason: 'the scan found almost nothing; run it from desktop/',
      );
      final offenders = [
        for (final (path, source) in sources)
          if (!allowed.containsKey(path) && reader.hasMatch(source)) path,
      ];
      expect(
        offenders,
        isEmpty,
        reason:
            'read the home folder with homeDir() or maybeHomeDir() '
            '(lib/core/home_dir.dart)',
      );
    });

    test('runs /bin/chmod only where Windows skips it or on Linux', () {
      const audited = {
        'lib/core/harness_file_store_native.dart':
            'skipped when Platform.isWindows',
        'lib/community/fork_project.dart': 'skipped when Platform.isWindows',
        'lib/update/desktop_updater.dart': 'the AppImage, Linux only',
        'lib/bootstrap/environment_provisioner.dart':
            'the Linux Terminal setup script only',
      };
      final found = {
        for (final (path, source) in _libSources())
          if (source.contains("'/bin/chmod'")) path,
      };
      expect(found.difference(audited.keys.toSet()), isEmpty);
    });

    test('reserves folders with reserveDirectory, never the mkdir program', () {
      final offenders = [
        for (final (path, source) in _libSources())
          if (path != 'lib/core/folder_commands.dart' &&
              source.contains("Process.run('mkdir'"))
            path,
      ];
      expect(offenders, isEmpty);
    });
  });
}
