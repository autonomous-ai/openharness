import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/widgets/desktop_search_panel.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'swarm_state_test.dart' show createApp;

/// Independent final-review regressions. These exercise visible controls using
/// keyboard and pointer input, without a daemon, user files, or native windows.
void main() {
  final renderDir = Platform.environment['DESKTOP_FINAL_UX_RENDER_DIR'];
  setUpAll(() async {
    if (renderDir != null) await loadPreviewFonts();
  });
  const inputKey = ValueKey('swarm-search-input');
  final input = find.byKey(inputKey);

  Future<void> capture(WidgetTester tester, String name) async {
    if (renderDir == null) return;
    await tester.runAsync(() async {
      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find
            .ancestor(
              of: find.byType(DesktopSearchPanel),
              matching: find.byType(RepaintBoundary),
            )
            .first,
      );
      final image = await boundary.toImage(pixelRatio: 1.5);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      final directory = Directory(renderDir)..createSync(recursive: true);
      await File('${directory.path}/$name.png')
          .writeAsBytes(data!.buffer.asUint8List());
      image.dispose();
    });
  }

  Future<SwarmSearchController> mount(WidgetTester tester) async {
    tester.view.physicalSize = const Size(440, 780);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final app = createApp();
    final search = SwarmSearchController(
      app,
      const [],
      adding: true,
      selectOnEmptyQuery: false,
      offersHarnessCreate: false,
    );
    final editor = TextEditingController();
    final focus = FocusNode();
    final map = MemoryKeymap();
    addTearDown(app.dispose);
    addTearDown(search.dispose);
    addTearDown(editor.dispose);
    addTearDown(focus.dispose);
    addTearDown(map.dispose);
    search.addListener(() {
      if (editor.text != search.query) {
        editor.value = TextEditingValue(
          text: search.query,
          selection: TextSelection.collapsed(offset: search.query.length),
        );
      }
    });
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(1.6)),
          child: child!,
        ),
        home: KeymapProvider(
          keymap: map,
          child: KeymapHost(
            keymap: map,
            enabled: () => true,
            actions: const {},
            child: Scaffold(
              body: Padding(
                padding: const EdgeInsets.all(20),
                child: Center(
                  child: SizedBox(
                    height: 570,
                    child: SwarmSearchKeys(
                      desktop: true,
                      search: search,
                      editing: editor,
                      onChoose: (_) =>
                          fail('Scope navigation cannot open a result'),
                      onClose: () =>
                          fail('Scope navigation cannot close the dialog'),
                      onRefocus: focus.requestFocus,
                      child: DesktopSearchPanel(
                        search: search,
                        editing: editor,
                        focusNode: focus,
                        onChoose: (_) =>
                            fail('Scope navigation cannot open a result'),
                        onClose: () =>
                            fail('Scope navigation cannot close the dialog'),
                        onRefocus: focus.requestFocus,
                        previewBuilder: () => const SizedBox(),
                      ),
                    ),
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      await tester.pump();
    });
    return search;
  }

  void expectScopeVisible(WidgetTester tester, String label) {
    final selected = find.byKey(ValueKey('search-category-$label'));
    final viewport = find
        .ancestor(of: selected, matching: find.byType(SingleChildScrollView))
        .first;
    final visibleBounds = tester.getRect(viewport);
    final selectedBounds = tester.getRect(selected);
    expect(
      selectedBounds.left,
      greaterThanOrEqualTo(visibleBounds.left),
      reason:
          'The selected $label scope must stay visible in a narrow window: '
          '$selectedBounds inside $visibleBounds',
    );
    expect(selectedBounds.right, lessThanOrEqualTo(visibleBounds.right));
  }

  testWidgets(
    'keyboard scope changes reveal the selected segment when narrow',
    (tester) async {
      final search = await mount(tester);
      for (var step = 0; step < 20; step++) {
        await key(tester, LogicalKeyboardKey.tab);
        if (tester
            .widget<Focus>(find.byKey(const ValueKey('search-scopes')))
            .focusNode!
            .hasFocus) {
          break;
        }
      }
      for (final (label, _) in DesktopSearchPanel.categories.skip(1)) {
        await key(tester, LogicalKeyboardKey.arrowRight);
        await tester.pumpAndSettle();
        expectScopeVisible(tester, label);
      }
      expect(search.isCommandMode, isTrue);
      await capture(tester, 'keyboard-commands-narrow');
      for (final (label, _) in DesktopSearchPanel.categories.reversed.skip(1)) {
        await key(tester, LogicalKeyboardKey.arrowLeft);
        await tester.pumpAndSettle();
        expectScopeVisible(tester, label);
      }
      expect(search.query, isEmpty);
      await capture(tester, 'keyboard-all-narrow');
      await key(tester, LogicalKeyboardKey.enter);
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'typed prefixes reveal the matching scope without stealing focus',
    (tester) async {
      final search = await mount(tester);
      for (final (label, prefix) in DesktopSearchPanel.categories.reversed) {
        await tester.enterText(input, prefix);
        await tester.pumpAndSettle();
        expect(search.query, prefix);
        expectScopeVisible(tester, label);
        expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
        if (prefix == '>') await capture(tester, 'typed-commands-narrow');
      }
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'resizing the palette keeps its active scope and editor visible',
    (tester) async {
      await mount(tester);
      tester.view.physicalSize = const Size(1200, 780);
      await tester.pumpAndSettle();
      await tester.enterText(input, '* release');
      await tester.pumpAndSettle();
      tester.view.physicalSize = const Size(440, 780);
      await tester.pumpAndSettle();
      expectScopeVisible(tester, 'Store');
      expect(tester.widget<TextField>(input).controller!.text, '* release');
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      expect(tester.takeException(), isNull);
    },
  );
}
