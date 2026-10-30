import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:harness/finder/widgets/finder_pane_panel.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:integration_test/integration_test.dart';
import 'package:path/path.dart' as p;
import 'package:window_manager/window_manager.dart';

// A Finder tile on a real folder, disk, `git` and renderer. The editor's
// highlighting runs on an isolate that headless widget tests never let
// answer, so only a native run shows the colours:
// FLUTTER_TEST=1 flutter test -d macos --no-pub \
//   integration_test/finder_native_test.dart
// FINDER_CAPTURE_DIR optionally saves what the tile drew.
void main() {
  if (!kUnderTest) throw StateError('Finder fixtures require FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.setSize(const Size(1300, 800));
    await windowManager.show();
  });

  late String root;
  setUp(() async {
    root = await (await Directory.systemTemp.createTemp('finder-native-'))
        .resolveSymbolicLinks();
    Future<void> git(List<String> args) =>
        Process.run('git', ['-C', root, ...args]);
    await git(['init', '-q', '-b', 'main']);
    await git(['config', 'user.email', 'finder@test']);
    await git(['config', 'user.name', 'Finder Test']);
    File(p.join(root, 'main.dart')).writeAsStringSync(
      '// A greeting.\nvoid main() {\n  final name = "world";\n  print(name);\n}\n',
    );
    await git(['add', '.']);
    await git(['commit', '-qm', 'first']);
    File(p.join(root, 'main.dart')).writeAsStringSync(
      '// A greeting.\nvoid main() {\n  final name = "Harness";\n  print(name);\n}\n',
    );
  });
  tearDown(() => Directory(root).delete(recursive: true));

  testWidgets('the editor colours code and the diff shows the edit', (
    tester,
  ) async {
    final frame = GlobalKey();
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Builder(
          builder: (context) {
            grid.AppTheme.brightness.value = Theme.of(context).brightness;
            return grid.BrightnessScope(
              child: Scaffold(
                body: RepaintBoundary(
                  key: frame,
                  child: FinderPanePanel(root: root),
                ),
              ),
            );
          },
        ),
      ),
    );
    await _settle(tester);
    await tester.tap(find.text('main.dart'));
    await _settle(tester);

    expect(find.byKey(const ValueKey('finder-code-editor')), findsOneWidget);
    // re_editor paints its own paragraphs, so the colours are checked by eye
    // in the capture.
    await _capture(frame, 'editor');

    await tester.tap(find.byKey(const ValueKey('finder-mode-changes')));
    await _settle(tester);
    await tester.tap(
      find.byKey(const ValueKey('finder-change-unstaged-main.dart')),
    );
    await _settle(tester);
    expect(find.byKey(const ValueKey('finder-diff')), findsOneWidget);
    await _capture(frame, 'diff');
  });
}

Future<void> _settle(WidgetTester tester) async {
  for (var i = 0; i < 20; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

Future<void> _capture(GlobalKey frame, String name) async {
  final dir = Platform.environment['FINDER_CAPTURE_DIR'];
  if (dir == null) return;
  final boundary =
      frame.currentContext!.findRenderObject()! as RenderRepaintBoundary;
  final image = await boundary.toImage();
  final png = await image.toByteData(format: ui.ImageByteFormat.png);
  File(p.join(dir, 'finder-$name.png'))
      .writeAsBytesSync(png!.buffer.asUint8List());
}
