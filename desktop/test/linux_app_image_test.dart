import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/linux_app_image.dart';
import 'package:harness/logging/app_log.dart';

/// Every message logged, as it would be written.
class _RecordedLog implements AppLog {
  final messages = <String>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => messages.add(message);
}

void main() {
  late Directory root;
  late String home, bundle;

  setUp(() {
    root = Directory.systemTemp.createTempSync('harness-appimage-');
    home = '${root.path}/home';
    bundle = '${root.path}/mount/usr/bin';
    Directory(bundle).createSync(recursive: true);
    File('$bundle/harness.png').writeAsBytesSync([1, 2, 3]);
    File('$bundle/harness').writeAsStringSync('');
  });
  tearDown(() => root.deleteSync(recursive: true));

  File entry() => File('$home/.local/share/applications/harness.desktop');

  Future<void> launch(String appImage) async {
    File(appImage)
      ..parent.createSync(recursive: true)
      ..writeAsStringSync('');
    await registerAppImageLauncher(
      environment: {'APPIMAGE': appImage, 'HOME': home},
      executable: '$bundle/harness',
    );
  }

  test('an AppImage started from Downloads lands in the app list', () async {
    await launch('$home/Downloads/Harness-linux-x64.AppImage');
    final text = entry().readAsStringSync();
    expect(
      text,
      contains('Exec=$home/Downloads/Harness-linux-x64.AppImage %u\n'),
    );
    expect(text, contains('MimeType=x-scheme-handler/harness;\n'));
    expect(text, contains('StartupWMClass=com.autonomous.harness\n'));
    expect(text, contains('Icon=$home/.local/share/icons/harness.png\n'));
    expect(File('$home/.local/share/icons/harness.png').readAsBytesSync(), [
      1,
      2,
      3,
    ]);
  });

  // The path holds the person's name, which no log line may carry.
  test('the log names no path', () async {
    final previous = appLog;
    final log = _RecordedLog();
    appLog = log;
    addTearDown(() => appLog = previous);

    await launch('$home/Nguyễn Văn A/Harness.AppImage');

    expect(entry().existsSync(), isTrue);
    expect(log.messages, isNotEmpty);
    for (final message in log.messages) {
      expect(message, isNot(contains('Nguyễn')));
      expect(message, isNot(contains(root.path)));
    }
  });

  test('a path with spaces is quoted for the launcher', () async {
    await launch('$home/My Apps/Harness.AppImage');
    expect(
      entry().readAsStringSync(),
      contains('Exec="$home/My Apps/Harness.AppImage" %u\n'),
    );
  });

  // The Desktop Entry spec reserves % for field codes: GLib would read %o in
  // 50%off as one and start another path.
  test('a % in the path is written %% for the launcher', () async {
    await launch('$home/50%off/Harness.AppImage');
    expect(
      entry().readAsStringSync(),
      contains('Exec=$home/50%%off/Harness.AppImage %u\n'),
    );
  });

  test("an entry today's Desktop wrote with a single % is its own, and is "
      'written again with %%', () async {
    final path = '$home/50%off/Harness.AppImage';
    await launch(path);
    entry().writeAsStringSync(
      '[Desktop Entry]\nType=Application\nExec=$path %u\n'
      'MimeType=x-scheme-handler/harness;\n',
    );
    await launch(path);
    expect(
      entry().readAsStringSync(),
      contains('Exec=$home/50%%off/Harness.AppImage %u\n'),
    );
  });

  test('Exec= reads back every path it was written with', () {
    for (final path in [
      '/home/p/Harness.AppImage',
      '/home/p q/Harness.AppImage',
      '/home/50%off/Harness.AppImage',
      '/home/50%%off now/Harness.AppImage',
      '/home/a"b/Harness.AppImage',
      r'/home/a\b/Harness.AppImage',
      r'/home/a$b`c/Harness.AppImage',
    ]) {
      expect(
        launcherExecTarget(
          '[Desktop Entry]\nExec=${quoteLauncherExec(path)} %u\n',
        ),
        path,
        reason: path,
      );
    }
  });

  test('an entry for a copy still on disk is not taken over', () async {
    await launch('$home/.local/opt/Harness.AppImage');
    await launch('$home/Downloads/Harness-linux-x64.AppImage');
    expect(
      entry().readAsStringSync(),
      contains('Exec=$home/.local/opt/Harness.AppImage %u\n'),
    );
  });

  test('an existing launcher for this copy gains the fork protocol', () async {
    final path = '$home/Applications/Harness.AppImage';
    await launch(path);
    entry().writeAsStringSync(
      '[Desktop Entry]\nType=Application\nExec=$path\n',
    );
    await launch(path);
    expect(entry().readAsStringSync(), contains('Exec=$path %u\n'));
    expect(
      entry().readAsStringSync(),
      contains('MimeType=x-scheme-handler/harness;'),
    );
  });

  test('an entry whose AppImage is gone follows the one running', () async {
    await launch('$home/My Apps/Harness.AppImage');
    File('$home/My Apps/Harness.AppImage').deleteSync();
    await launch('$home/Downloads/Harness-linux-x64.AppImage');
    expect(
      entry().readAsStringSync(),
      contains('Exec=$home/Downloads/Harness-linux-x64.AppImage %u\n'),
    );
  });

  test('not started from an AppImage, nothing is written', () async {
    await registerAppImageLauncher(
      environment: {'HOME': home},
      executable: '$bundle/harness',
    );
    expect(entry().existsSync(), isFalse);
  });
}
