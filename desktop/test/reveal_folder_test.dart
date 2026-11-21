import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/reveal_folder.dart';
import 'package:harness/core/windows_folder.dart';
import 'package:path/path.dart' as p;

void main() {
  // A bare `explorer` is looked for in the app's folder and its working folder before Windows' own.
  test(
    'on Windows a folder opens in Explorer by its path in the Windows folder',
    () {
      expect(
        systemOpener('windows'),
        p.windows.join(windowsFolder(), 'explorer.exe'),
      );
    },
  );
}
