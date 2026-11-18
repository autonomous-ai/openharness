import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/windows_git_setup.dart';
import 'package:harness/core/harness_home.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory home;
  late List<List<String>> runs;
  late List<String> logs;

  setUp(() {
    home = Directory.systemTemp.createTempSync('git-setup-');
    runs = [];
    logs = [];
  });
  tearDown(() => home.deleteSync(recursive: true));

  WindowsGitSetup setup({
    Set<String> files = const {},
    bool isWindows = true,
    int code = 0,
    Object? thrown,
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
      if (thrown != null) throw thrown;
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

  test('installs it for this user alone, asking nothing', () async {
    await setup().start();
    expect(runs.single.first, 'winget');
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

  test('marks its one try in Harness\'s run folder under the profile', () async {
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
    // The profile's run folder by this computer's rule.
    final run = HarnessHome.of(
      r'C:\Users\me',
      join: p.windows.join,
    ).path(HarnessEntry.run);
    expect(asked.last, p.windows.join(run, 'git-install-tried'));
    expect(runs, isEmpty);
  });

  test('a computer without winget goes on without Git', () async {
    await setup(thrown: const ProcessException('winget', [])).start();
    expect(logs.single, contains('was not installed'));
  });
}
