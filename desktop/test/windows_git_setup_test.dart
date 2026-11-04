import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/windows_git_setup.dart';

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

  test('a computer without winget goes on without Git', () async {
    await setup(thrown: const ProcessException('winget', [])).start();
    expect(logs.single, contains('was not installed'));
  });
}
