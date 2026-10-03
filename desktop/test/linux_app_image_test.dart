import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/linux_app_image.dart';

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
    expect(text, contains('Exec=$home/Downloads/Harness-linux-x64.AppImage\n'));
    expect(text, contains('StartupWMClass=com.autonomous.harness\n'));
    expect(text, contains('Icon=$home/.local/share/icons/harness.png\n'));
    expect(File('$home/.local/share/icons/harness.png').readAsBytesSync(), [
      1,
      2,
      3,
    ]);
  });

  test('a path with spaces is quoted for the launcher', () async {
    await launch('$home/My Apps/Harness.AppImage');
    expect(
      entry().readAsStringSync(),
      contains('Exec="$home/My Apps/Harness.AppImage"\n'),
    );
  });

  test('an entry for a copy still on disk is not taken over', () async {
    await launch('$home/.local/opt/Harness.AppImage');
    await launch('$home/Downloads/Harness-linux-x64.AppImage');
    expect(
      entry().readAsStringSync(),
      contains('Exec=$home/.local/opt/Harness.AppImage\n'),
    );
  });

  test('an entry whose AppImage is gone follows the one running', () async {
    await launch('$home/My Apps/Harness.AppImage');
    File('$home/My Apps/Harness.AppImage').deleteSync();
    await launch('$home/Downloads/Harness-linux-x64.AppImage');
    expect(
      entry().readAsStringSync(),
      contains('Exec=$home/Downloads/Harness-linux-x64.AppImage\n'),
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
