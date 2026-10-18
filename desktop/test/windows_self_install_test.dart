import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/windows_self_install.dart';
import 'package:path/path.dart' as p;

void main() {
  late Directory dir;
  late String zip;
  late String install;
  late List<(String, List<String>)> started;
  late List<String> cleaned;

  String layout(String root, String version) {
    final folder = Directory(p.join(root, 'app', version))
      ..createSync(recursive: true);
    final exe = p.join(folder.path, 'harness-desktop.exe');
    File(exe).writeAsStringSync('');
    File(p.join(root, 'Harness.exe')).writeAsStringSync('');
    File(p.join(root, 'current')).writeAsStringSync('$version\r\n');
    return exe;
  }

  setUp(() {
    dir = Directory.systemTemp.createTempSync('self-install-');
    final profile = p.join(dir.path, "Nguyễn Văn A' & 100% !x");
    zip = p.join(profile, 'Downloads', 'harness-desktop-1.2.3-windows-x64');
    install = p.join(profile, 'Programs', 'Harness');
    started = [];
    cleaned = [];
  });

  tearDown(() => dir.deleteSync(recursive: true));

  WindowsSelfInstall subject(
    String exe, {
    bool isWindows = true,
    bool releaseMode = true,
    Object? failStart,
    Future<void> Function(String)? cleanUp,
  }) => WindowsSelfInstall(
    isWindows: isWindows,
    releaseMode: releaseMode,
    executablePath: exe,
    installRoot: install,
    pid: 4242,
    start: (command, args) async {
      if (failStart != null) throw failStart;
      started.add((command, args));
    },
    cleanUp: cleanUp ?? (root) async => cleaned.add(root),
  );

  test('zip copy starts its launcher with the exact install argv', () async {
    final exe = layout(zip, '1.2.3');
    expect(
      await subject(exe).ensureInstalled(),
      SelfInstallOutcome.relaunching,
    );
    expect(started.single.$1, p.join(zip, 'Harness.exe'));
    expect(started.single.$2, ['--install', '--wait-pid', '4242']);
    expect(cleaned, isEmpty);
  });

  test('installed copy schedules cleanup without waiting for it', () async {
    final exe = layout(install, '1.2.3');
    final pending = Completer<void>();
    final installer = subject(
      exe,
      cleanUp: (root) {
        cleaned.add(root);
        return pending.future;
      },
    );
    expect(
      await installer.ensureInstalled(),
      SelfInstallOutcome.alreadyInstalled,
    );
    expect(cleaned, [install]);
    expect(started, isEmpty);
    pending.complete();
    await installer.lastCleanUp;
  });

  test('installed copy with a missing launcher reports failure', () async {
    final exe = layout(install, '1.2.3');
    File(p.join(install, 'Harness.exe')).deleteSync();

    final result = await subject(exe).ensureInstalled();

    expect(result, isA<SelfInstallFailed>());
    expect(
      (result as SelfInstallFailed).message,
      contains('has no Harness.exe'),
    );
    expect(started, isEmpty);
    expect(cleaned, isEmpty);
  });

  test('cleanup failure is contained after installed startup', () async {
    final installer = subject(
      layout(install, '1.2.3'),
      cleanUp: (_) async => throw const FileSystemException('held'),
    );
    expect(
      await installer.ensureInstalled(),
      SelfInstallOutcome.alreadyInstalled,
    );
    await installer.lastCleanUp;
  });

  test('installed path comparison handles case, separator and alias', () async {
    final exe = layout(install, '1.2.3');
    final upper = WindowsSelfInstall(
      isWindows: true,
      releaseMode: true,
      executablePath: exe,
      installRoot: '${install.toUpperCase()}${Platform.pathSeparator}',
      start: (command, args) async => started.add((command, args)),
      cleanUp: (_) async {},
    );
    expect(await upper.ensureInstalled(), SelfInstallOutcome.alreadyInstalled);
    if (!Platform.isWindows) {
      final alias = p.join(dir.path, 'install-alias');
      Link(alias).createSync(install);
      expect(sameFolder(alias, install), isTrue);
    }
    expect(sameFolder('$install-other', install), isFalse);
    expect(started, isEmpty);
  });

  test('Windows extended path prefix compares like the launcher', () {
    expect(
      sameFolder(
        r'\\?\C:\Users\A\Programs\Harness\',
        r'c:\users\a\programs\harness',
      ),
      isTrue,
    );
    expect(
      sameFolder(
        r'\\?\C:\Users\A\Programs\Harness2',
        r'C:\Users\A\Programs\Harness',
      ),
      isFalse,
    );
  });

  test('other hosts, development and non-layout builds do nothing', () async {
    final exe = layout(zip, '1.2.3');
    expect(
      await subject(exe, isWindows: false).ensureInstalled(),
      SelfInstallOutcome.alreadyInstalled,
    );
    expect(
      await subject(exe, releaseMode: false).ensureInstalled(),
      SelfInstallOutcome.alreadyInstalled,
    );
    final built = p.join(
      dir.path,
      'build',
      'windows',
      'runner',
      'Release',
      'harness-desktop.exe',
    );
    expect(
      await subject(built).ensureInstalled(),
      SelfInstallOutcome.alreadyInstalled,
    );
    expect(started, isEmpty);
    expect(cleaned, isEmpty);
  });

  test('missing launcher and refused spawn report a usable fallback', () async {
    final exe = layout(zip, '1.2.3');
    File(p.join(zip, 'Harness.exe')).deleteSync();
    final missing = await subject(exe).ensureInstalled();
    expect(
      (missing as SelfInstallFailed).message,
      contains('has no Harness.exe'),
    );
    layout(zip, '1.2.3');
    final refused = await subject(
      exe,
      failStart: const ProcessException(
        'Harness.exe',
        [],
        'Access is denied',
        5,
      ),
    ).ensureInstalled();
    expect(
      (refused as SelfInstallFailed).message,
      contains('could not start its installer'),
    );
    expect(started, isEmpty);
  });

  test('malformed packaged pointer reports failure without spawning', () async {
    final exe = layout(zip, '1.2.3');
    File(p.join(zip, 'current')).deleteSync();
    final missing = await subject(exe).ensureInstalled();
    expect(missing, isA<SelfInstallFailed>());
    expect((missing as SelfInstallFailed).message, contains('current'));
    Directory(p.join(zip, 'current')).createSync();
    final unreadable = await subject(exe).ensureInstalled();
    expect(unreadable, isA<SelfInstallFailed>());
    expect(started, isEmpty);
  });

  test(
    'known-folder failure from an injected Windows host falls through',
    () async {
      final installer = WindowsSelfInstall(
        isWindows: true,
        releaseMode: true,
        executablePath: layout(zip, '1.2.3'),
        environment: const {},
        start: (command, args) async => started.add((command, args)),
      );
      // This host is macOS; production's known-folder lookup is Windows only.
      if (!Platform.isWindows) {
        expect(await installer.ensureInstalled(), isA<SelfInstallFailed>());
        expect(started, isEmpty);
      }
    },
  );

  test('install root override matches the launcher setting', () {
    final installer = WindowsSelfInstall(
      isWindows: true,
      environment: {'HARNESS_DESKTOP_INSTALL_ROOT': install},
    );
    expect(installer.installRoot(), install);
  });
}
