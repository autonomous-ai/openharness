import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness/screens/swarm_menu_bus.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/in_window_menu_bar.dart';

/// Throwaway renderer: writes PNGs of the compact Windows app menu for review.
void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final boundaryKey = GlobalKey();

  Future<void> shoot(WidgetTester tester, String path) async {
    final boundary = tester.renderObject<RenderRepaintBoundary>(
      find.byKey(boundaryKey),
    );
    // Image encoding needs the real event loop; inside fake async it never
    // completes (the test then dies on its two-minute timeout).
    await tester.runAsync(() async {
      final image = await boundary.toImage(pixelRatio: 2);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      File(path).parent.createSync(recursive: true);
    File(path).writeAsBytesSync(bytes!.buffer.asUint8List());
    });
  }

  setUp(() {
    swarmMenuBus.send('update', {
      'enabled': true,
      'canReopen': true,
      'canFind': true,
      'canClosePane': true,
      'canGoBack': true,
      'canGoForward': true,
    });
    swarmMenuBus.send('keymapState', {
      'contexts': {
        'workspace': {
          'new': 'Ctrl+Shift+T',
          'closeActive': 'Ctrl+Shift+W',
          'settings': 'Ctrl+,',
        },
      },
    });
  });

  testWidgets('renders the compact menu closed and open', timeout: const Timeout(Duration(seconds: 60)), (tester) async {
    tester.view.physicalSize = const Size(1100 * 2, 620 * 2);
    tester.view.devicePixelRatio = 2;
    addTearDown(tester.view.reset);

    const tabWidth = 132.0;
    Widget tab(String name, {bool active = false}) => Container(
      width: tabWidth,
      margin: const EdgeInsets.only(right: 2),
      padding: const EdgeInsets.symmetric(horizontal: 12),
      alignment: Alignment.centerLeft,
      decoration: BoxDecoration(
        color: active ? grid.AppPalette.panelBg : Colors.transparent,
        borderRadius: BorderRadius.circular(6),
      ),
      child: Text(
        name,
        style: TextStyle(
          fontSize: 12.5,
          color: active
              ? grid.AppPalette.textPrimary
              : grid.AppPalette.textSecondary,
        ),
      ),
    );

    await tester.pumpWidget(
      RepaintBoundary(
        key: boundaryKey,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            backgroundColor: grid.AppPalette.swarmField,
            body: Align(
              alignment: Alignment.topCenter,
              child: Column(
                children: [
                  Container(
                    height: 36,
                    color: grid.AppPalette.swarmTabBar,
                    child: Row(
                      children: [
                        const SizedBox(width: 15),
                        SizedBox(
                          width: appMenuButtonWidth,
                          child: const Align(
                            alignment: Alignment.centerLeft,
                            child: InWindowMenuBar(compact: true),
                          ),
                        ),
                        tab('API rollout', active: true),
                        tab('Docs pass'),
                        tab('Release 1.3.56'),
                        const Spacer(),
                        Icon(
                          Icons.search,
                          size: 16,
                          color: grid.AppPalette.textSecondary,
                        ),
                        const SizedBox(width: 18),
                        CircleAvatar(
                          radius: 10,
                          backgroundColor: grid.AppPalette.panelBg,
                        ),
                        const SizedBox(width: 15),
                      ],
                    ),
                  ),
                  Expanded(
                    child: Center(
                      child: Text(
                        'workspace',
                        style: TextStyle(
                          fontSize: 13,
                          color: grid.AppPalette.textFaint,
                        ),
                      ),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await shoot(
      tester,
      '/Users/macbookpro/Workspace/autonomous-harness/evidence/windows-app-menu/preview-closed.png',
    );

    await tester.tap(find.byKey(const Key('app-menu-button')));
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 400));
    await shoot(
      tester,
      '/Users/macbookpro/Workspace/autonomous-harness/evidence/windows-app-menu/preview-open.png',
    );
  });
}