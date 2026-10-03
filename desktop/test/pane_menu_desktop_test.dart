import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/terminal/terminal_search.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/grid_model_picker.dart';
import 'package:harness/widgets/model_picker_chrome.dart';
import 'package:harness/widgets/resting_section.dart';
import 'package:harness/widgets/terminal_find_bar.dart';
import 'package:xterm/xterm.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'support/real_fonts.dart';
import 'support/resting_models.dart';
import 'swarm_state_test.dart' show createApp;

const _captureKey = ValueKey('desktop-menu-preview');
final _menu = find.byKey(const ValueKey('pane-menu-surface'));
final _renderDir = Platform.environment['PANE_MENU_RENDER_DIR'];

Widget _frame({
  required Widget child,
  double scale = 1,
  bool highContrast = false,
}) => RepaintBoundary(
  key: _captureKey,
  child: grid.BrightnessScope(
    child: ValueListenableBuilder(
      valueListenable: grid.AppTheme.brightness,
      builder: (context, brightness, _) => MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(
          brightness: brightness,
          highContrast: highContrast,
        ),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context).copyWith(
            textScaler: TextScaler.linear(scale),
            highContrast: highContrast,
          ),
          child: child!,
        ),
        home: Scaffold(
          body: Align(
            alignment: Alignment.topRight,
            child: Padding(padding: const EdgeInsets.all(16), child: child),
          ),
        ),
      ),
    ),
  ),
);

Future<void> _capture(WidgetTester tester, String name) async {
  if (_renderDir == null) return;
  final oldShadows = debugDisableShadows;
  debugDisableShadows = false;
  try {
    await tester.runAsync(
      () => Future.wait([
        for (final brand in ['openai', 'qwen', 'deepseek'])
          precacheImage(
            AssetImage('assets/model-icons/$brand.png'),
            tester.element(find.byKey(_captureKey)),
          ),
      ]),
    );
    for (final object in tester.allRenderObjects) {
      object.markNeedsPaint();
    }
    await tester.pump();
    await expectLater(
      find.byKey(_captureKey),
      matchesGoldenFile(Uri.file('$_renderDir/$name.png')),
    );
  } finally {
    debugDisableShadows = oldShadows;
    for (final object in tester.allRenderObjects) {
      object.markNeedsPaint();
    }
    await tester.pump();
  }
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    if (_renderDir != null) await loadPreviewFonts();
  });

  for (final brightness in Brightness.values) {
    for (final enlarged in [false, true]) {
      final label = '${brightness.name}-${enlarged ? 'narrow-large' : 'wide'}';
      testWidgets('desktop model menu remains usable $label', (tester) async {
        final originalBrightness = grid.AppTheme.brightness.value;
        final originalFont = terminalFontStore.value;
        grid.AppTheme.brightness.value = brightness;
        tester.view.devicePixelRatio = 1;
        final size = enlarged ? const Size(380, 440) : const Size(900, 700);
        tester.view.physicalSize = size;
        addTearDown(() {
          grid.AppTheme.brightness.value = originalBrightness;
          terminalFontStore.value = originalFont;
          tester.view.reset();
        });

        final daemon = RecordingDaemon(
          modelsReply([
            section(
              'home',
              own: true,
              models: [
                row('Qwen3.5-4B', 'macbook-pro'),
                row(
                  'DeepSeek-V4-Flash',
                  'mac-studio',
                  offlineMachine: 'Studio',
                ),
              ],
            ),
            section('Design team', state: 'asleep'),
          ]),
        );
        final app = createApp(connectionForTest: (_) => daemon);
        addTearDown(app.dispose);
        final selections = <GridModel>[];
        await tester.pumpWidget(
          _frame(
            scale: enlarged ? 1.7 : 1,
            highContrast: enlarged,
            child: GridModelPicker(
              notifier: app,
              machineId: 'm',
              engineLabel: 'codex',
              currentModel: 'Qwen3.5-4B',
              onSelected: selections.add,
              onRunLocalModel: () {},
            ),
          ),
        );
        await tester.pump();
        await tester.tap(find.byType(GridModelPicker));
        await tester.pumpAndSettle();

        final bounds = tester.getRect(_menu);
        expect(bounds.left, greaterThanOrEqualTo(8));
        expect(bounds.top, greaterThanOrEqualTo(8));
        expect(bounds.right, lessThanOrEqualTo(size.width - 8));
        expect(bounds.bottom, lessThanOrEqualTo(size.height - 8));
        expect(find.byType(ModelPickerSearch).hitTestable(), findsOneWidget);
        expect(find.text('Local models').hitTestable(), findsOneWidget);
        final footer = find.byType(ModelPickerFooter);
        final footerAction = find.descendant(
          of: footer,
          matching: find.text('Local models'),
        );
        if (enlarged) {
          expect(
            tester.getTopLeft(footerAction).dy,
            greaterThan(
              tester.getBottomLeft(find.text('2 models available')).dy,
            ),
          );
        }
        final editor = find.descendant(
          of: find.byType(ModelPickerSearch),
          matching: find.byType(TextField),
        );
        final controller = tester.widget<TextField>(editor).controller!;
        expect(
          tester.widget<TextField>(editor).style!.fontFamily,
          DesktopChrome.control().fontFamily,
        );
        expect(
          MediaQuery.textScalerOf(tester.element(editor)).scale(10),
          enlarged ? 17 : 10,
        );
        await _capture(tester, 'model-menu-$label');

        // The saved model and keyboard target are separate: moving focus must
        // not choose a model or add a second stop around a button.
        final firstRow = find.byType(ModelPickerRow).first;
        await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
        await tester.pumpAndSettle();
        final firstFocus = FocusManager.instance.primaryFocus!;
        expect(
          firstFocus.context!
              .findAncestorWidgetOfExactType<ModelPickerRow>()
              ?.title,
          tester.widget<ModelPickerRow>(firstRow).title,
        );
        expect(selections, isEmpty);
        expect(
          tester
              .widgetList<ModelPickerRow>(find.byType(ModelPickerRow))
              .where((row) => row.selected)
              .single
              .title,
          'Qwen3.5-4B',
        );
        await _capture(tester, 'model-menu-focus-$label');

        final stops = <FocusNode>{firstFocus};
        final labels = <String>['${firstFocus.debugLabel}: ${firstFocus.rect}'];
        final controlCount =
            find
                .descendant(of: _menu, matching: find.byType(TextButton))
                .evaluate()
                .length +
            1; // Search is the only non-button stop.
        for (var i = 0; i < controlCount; i++) {
          await tester.sendKeyEvent(LogicalKeyboardKey.tab);
          await tester.pumpAndSettle();
          final focused = FocusManager.instance.primaryFocus!;
          labels.add('${focused.debugLabel}: ${focused.rect}');
          if (i == controlCount - 1) {
            expect(focused, same(firstFocus));
          } else {
            expect(stops.add(focused), isTrue, reason: labels.join('\n'));
          }
        }
        expect(stops.length, controlCount);

        final chosen = find.byWidgetPredicate(
          (widget) => widget is ModelPickerRow && widget.selected,
        );
        Material chosenMaterial() => tester.widget<Material>(
          find.descendant(of: chosen, matching: find.byType(Material)),
        );
        tester
            .widget<EditableText>(
              find.descendant(of: editor, matching: find.byType(EditableText)),
            )
            .focusNode
            .requestFocus();
        await tester.ensureVisible(chosen);
        await tester.pumpAndSettle();
        final savedShape = chosenMaterial().shape;
        final savedBounds = tester.getRect(chosen);
        expect(chosenMaterial().color, grid.AppSurface.accentWash);
        expect(
          find.descendant(of: chosen, matching: find.byIcon(AppIcons.check)),
          findsOneWidget,
        );
        Focus.of(
          tester.element(
            find.descendant(of: chosen, matching: find.text('Qwen3.5-4B')),
          ),
        ).requestFocus();
        await tester.pumpAndSettle();
        expect(chosenMaterial().color, grid.AppDesktop.selection);
        expect(chosenMaterial().shape, savedShape);
        expect(tester.getRect(chosen), savedBounds);
        expect(
          tester
              .widget<Icon>(
                find.descendant(
                  of: chosen,
                  matching: find.byIcon(AppIcons.check),
                ),
              )
              .color,
          grid.AppDesktop.onSelection,
        );

        final wake = find.widgetWithText(TextButton, 'Show models');
        await tester.ensureVisible(wake);
        Focus.of(tester.element(find.text('Show models'))).requestFocus();
        await tester.pumpAndSettle();
        expect(
          tester
              .widget<Material>(
                find.descendant(of: wake, matching: find.byType(Material)),
              )
              .color,
          grid.AppDesktop.selection,
        );
        for (final label in ['Show models', 'usually 15–40 s']) {
          expect(
            tester.widget<Text>(find.text(label)).style!.color,
            grid.AppDesktop.onSelection,
          );
        }
        expect(
          tester
              .widget<Icon>(
                find.descendant(of: wake, matching: find.byIcon(AppIcons.eye)),
              )
              .color,
          grid.AppDesktop.onSelection,
        );
        await _capture(tester, 'model-menu-wake-focus-$label');

        await tester.enterText(editor, 'macbook');
        await tester.pumpAndSettle();
        const editing = TextEditingValue(
          text: 'macbook',
          selection: TextSelection.collapsed(offset: 7),
          composing: TextRange(start: 0, end: 7),
        );
        controller.value = editing;
        final filteredBounds = tester.getRect(_menu);
        grid.AppTheme.brightness.value = brightness == Brightness.dark
            ? Brightness.light
            : Brightness.dark;
        terminalFontStore.value = TerminalStyle(
          fontSize: 22,
          fontFamily: originalFont.fontFamily,
          fontFamilyFallback: originalFont.fontFamilyFallback,
        );
        await tester.pumpAndSettle();
        expect(tester.widget<TextField>(editor).controller, same(controller));
        expect(controller.value, editing);
        expect(tester.getRect(_menu), filteredBounds);
        expect(tester.widget<Material>(_menu).color, grid.AppMenu.fill);
        expect(
          tester.widget<TextField>(editor).style!.fontSize,
          DesktopChrome.control().fontSize,
        );
        expect(daemon.asks.every((ask) => ask['wake'] == null), isTrue);
        expect(daemon.others, isEmpty);
        expect(selections, isEmpty);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        await tester.pump();
      });

      testWidgets('offline switch keeps Cancel reachable $label', (
        tester,
      ) async {
        final originalBrightness = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = enlarged
            ? const Size(380, 360)
            : const Size(900, 700);
        addTearDown(() {
          grid.AppTheme.brightness.value = originalBrightness;
          tester.view.reset();
        });
        bool? result;
        await tester.pumpWidget(
          _frame(
            scale: enlarged ? 1.7 : 1,
            highContrast: enlarged,
            child: Builder(
              builder: (context) => TextButton(
                onPressed: () async => result = await confirmSwitchAnyway(
                  context,
                  model: 'DeepSeek-V4-Flash',
                  offline: const GridModelUnavailable(
                    machine: 'Studio · remote development workstation',
                  ),
                ),
                child: const Text('Choose offline model'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Choose offline model'));
        await tester.pumpAndSettle();
        expect(find.text('Cancel').hitTestable(), findsOneWidget);
        expect(find.text('Switch').hitTestable(), findsOneWidget);
        final cancel = find.widgetWithText(TextButton, 'Cancel');
        expect(
          tester.widget<TextButton>(cancel).focusNode!.hasPrimaryFocus,
          isTrue,
        );
        await _capture(tester, 'offline-confirmation-$label');
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(result, isFalse);
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
      });
    }
  }

  testWidgets('terminal Find stays fixed while desktop options scale', (
    tester,
  ) async {
    final originalBrightness = grid.AppTheme.brightness.value;
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(380, 440);
    addTearDown(() {
      grid.AppTheme.brightness.value = originalBrightness;
      tester.view.reset();
    });
    final terminal = Terminal()..resize(80, 4);
    terminal.write('Marker\r\nmarker\r\n');
    final search = TerminalSearch(terminal);
    addTearDown(search.dispose);
    await tester.runAsync(() async {
      search.setQuery('marker');
      await search.settled;
    });
    final bar = SizedBox(
      width: 300,
      child: TerminalFindBar(
        search: search,
        onQuery: (query, sensitive) =>
            search.setQuery(query, caseSensitive: sensitive),
        onStep: search.step,
        onClose: () {},
        onFocus: () {},
      ),
    );
    final editor = find.byType(TextField);
    Rect? initialBounds;
    TextEditingController? initialController;
    for (final brightness in Brightness.values) {
      grid.AppTheme.brightness.value = brightness;
      for (final scale in [1.0, 1.7]) {
        await tester.pumpWidget(
          _frame(child: bar, scale: scale, highContrast: scale > 1),
        );
        await tester.pumpAndSettle();
        final controller = tester.widget<TextField>(editor).controller!;
        initialBounds ??= tester.getRect(find.byType(TerminalFindBar));
        initialController ??= controller;
        expect(tester.getRect(find.byType(TerminalFindBar)), initialBounds);
        expect(controller, same(initialController));
        expect(controller.text, 'marker');
        expect(MediaQuery.textScalerOf(tester.element(editor)).scale(10), 10);
        expect(
          tester.widget<TextField>(editor).style!.fontFamily,
          terminalFontStore.value.fontFamily,
        );
        await tester.tap(find.byTooltip('Find options'));
        await tester.pumpAndSettle();
        expect(
          MediaQuery.textScalerOf(tester.element(find.text('Match case')))
              .scale(10),
          scale * 10,
        );
        expect(
          tester.widget<Text>(find.text('Match case')).style!.fontFamily,
          DesktopChrome.control().fontFamily,
        );
        final menuBounds = tester.getRect(_menu);
        expect(menuBounds.left, greaterThanOrEqualTo(8));
        expect(menuBounds.right, lessThanOrEqualTo(372));
        final matchCase = find.widgetWithText(TextButton, 'Match case');
        expect(
          tester
              .widget<Material>(
                find.descendant(of: matchCase, matching: find.byType(Material)),
              )
              .color,
          grid.AppDesktop.selection,
        );
        expect(
          tester.widget<Text>(find.text('Match case')).style!.color,
          grid.AppDesktop.onSelection,
        );
        expect(
          tester
              .widget<Text>(
                find.descendant(
                  of: matchCase,
                  matching: find.text(search.caseSensitive ? 'On' : 'Off'),
                ),
              )
              .style!
              .color,
          grid.AppDesktop.onSelection,
        );
        if (search.caseSensitive) {
          expect(
            tester
                .widget<Icon>(
                  find.descendant(
                    of: matchCase,
                    matching: find.byIcon(AppIcons.check),
                  ),
                )
                .color,
            grid.AppDesktop.onSelection,
          );
        }
        await _capture(tester, 'find-options-${brightness.name}-$scale');
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(search.caseSensitive, scale == 1);
        expect(controller.text, 'marker');
        expect(tester.widget<TextField>(editor).focusNode!.hasFocus, isTrue);
        expect(tester.takeException(), isNull);
      }
    }
    await tester.pumpWidget(const SizedBox());
  });
}
