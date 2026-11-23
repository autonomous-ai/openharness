import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/windows_git_setup.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory home;
  late List<List<String>> runs;
  late List<String> logs;
  // Where the App Installer puts winget for this user.
  const winget = r'C:\Users\a\AppData\Local\Microsoft\WindowsApps\winget.exe';

  setUp(() {
    home = Directory.systemTemp.createTempSync('git-setup-');
    runs = [];
    logs = [];
  });
  tearDown(() => home.deleteSync(recursive: true));

  WindowsGitSetup setup({
    Set<String> files = const {winget},
    bool isWindows = true,
    int code = 0,
    Map<String, String>? environment,
  }) => WindowsGitSetup(
    environment:
        environment ??
        {
          'USERPROFILE': home.path,
          'PATH': r'C:\Windows;C:\Tools',
          'ProgramFiles': r'C:\Program Files',
          'LOCALAPPDATA': r'C:\Users\a\AppData\Local',
        },
    isFile: files.contains,
    isWindows: isWindows,
    log: logs.add,
    run: (executable, arguments) async {
      runs.add([executable, ...arguments]);
      return code;
    },
  );

  test('finds Git where the CLI looks for it', () {
    for (final found in [
      r'C:\Tools\git.exe',
      r'C:\Program Files\Git\bin\bash.exe',
      r'C:\Users\a\AppData\Local\Programs\Git\bin\bash.exe',
    ]) {
      expect(setup(files: {found}).gitIsThere, isTrue, reason: found);
    }
    expect(setup().gitIsThere, isFalse);
  });

  // A relative PATH entry is a folder of the app's working folder: a git.exe
  // put there would stop setup from installing Git.
  test('a git.exe by a relative PATH entry is not Git', () {
    final there = setup(
      environment: {'USERPROFILE': home.path, 'PATH': r'tools;.;\tools'},
      files: {r'tools\git.exe', r'.\git.exe', r'\tools\git.exe'},
    ).gitIsThere;
    expect(there, isFalse);
  });

  test('installs it for this user alone, asking nothing', () async {
    await setup().start();
    expect(runs.single.first, winget);
    expect(
      runs.single,
      containsAll([
        'Git.Git',
        '--silent',
        '--scope',
        'user',
        '--disable-interactivity',
      ]),
    );
    expect(logs.single, 'Git for Windows installed');
  });

  test('does nothing where Git is there, or off Windows', () async {
    await setup(files: {r'C:\Tools\git.exe'}).start();
    await setup(isWindows: false).start();
    expect(runs, isEmpty);
  });

  test('never throws, and says why in the log', () async {
    await setup(code: 7).start();
    expect(logs.single, contains('winget exited 7'));
  });

  test('marks its one try under the profile\'s .harness/run on any host', () async {
    final asked = <String>[];
    // Answering yes for the marker stops start() before it creates the file,
    // so a wrong path is only recorded, never written.
    await WindowsGitSetup(
      environment: {'USERPROFILE': r'C:\Users\me', 'PATH': ''},
      isFile: (path) {
        asked.add(path);
        return path.endsWith('git-install-tried');
      },
      isWindows: true,
      run: (executable, arguments) async {
        runs.add([executable, ...arguments]);
        return 0;
      },
    ).start();
    expect(asked.last, r'C:\Users\me\.harness\run\git-install-tried');
    expect(runs, isEmpty);
  });

  test('a computer without winget goes on without Git', () async {
    await setup(files: {}).start();
    expect(runs, isEmpty);
    expect(logs.single, contains('was not installed'));
  });

  // A bare `winget` is looked for in the app's folder and its working folder before PATH.
  test(
    "runs winget by an absolute path, PATH's then this user's WindowsApps",
    () async {
      // Each try leaves its marker, which would stop the next.
      final marker = File(
        p.windows.join(home.path, '.harness', 'run', 'git-install-tried'),
      );
      for (final (path, found) in [
        (r'C:\Windows;C:\Tools', r'C:\Tools\winget.exe'),
        (r'C:\Windows;C:\Tools', winget),
        (r'.;;tools;\tools', winget),
      ]) {
        runs.clear();
        await setup(
          environment: {
            'USERPROFILE': home.path,
            'PATH': path,
            'LOCALAPPDATA': r'C:\Users\a\AppData\Local',
          },
          // Every relative path finds the planted winget.exe in the working folder.
          files: {
            found,
            r'.\winget.exe',
            r'winget.exe',
            r'tools\winget.exe',
            r'\tools\winget.exe',
            r'C:\Program Files\Harness\winget.exe',
          },
        ).start();
        expect(runs.single.first, found, reason: path);
        marker.deleteSync();
      }
    },
  );

  // The App Installer's winget.exe is an App Execution Alias: a link the file
  // system cannot follow, which Windows runs.
  final local = Platform.environment['LOCALAPPDATA'];
  final alias = local == null
      ? null
      : p.windows.join(local, 'Microsoft', 'WindowsApps', 'winget.exe');
  test(
    "on a real Windows this user's winget is found where the App Installer puts it",
    () async {
      await WindowsGitSetup(
        environment: {
          'USERPROFILE': home.path,
          'PATH': '',
          'LOCALAPPDATA': local!,
        },
        isWindows: true,
        log: logs.add,
        run: (executable, arguments) async {
          runs.add([executable, ...arguments]);
          return 0;
        },
      ).start();
      expect(runs.single.first, alias);
    },
    skip:
        !Platform.isWindows ||
            alias == null ||
            FileSystemEntity.typeSync(alias, followLinks: false) ==
                FileSystemEntityType.notFound
        ? 'needs a Windows with the App Installer'
        : false,
  );
}
