import 'dart:async';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/search_result_text.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'keymap_host_test.dart' show key;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_state_test.dart' show MemoryStore, createApp;

const _channel = MethodChannel('harness/swarm_tabs');
final _historyField = find.byWidgetPredicate(
  (widget) =>
      widget is TextField && widget.decoration?.hintText == 'Search history',
);
final _closeIcon = find.descendant(
  of: find.byType(DesktopDialogHeader),
  matching: find.byIcon(AppIcons.close),
);
final _renderDir = Platform.environment['DESKTOP_HISTORY_RENDER_DIR'];

class _HistoryWorkspace {
  _HistoryWorkspace() {
    app.machineStates['m']!
      ..nodeOnline = true
      ..agents = const [
        Agent(
          id: 'a0',
          name: 'Prototype review',
          engine: 'codex',
          terminalAvailable: true,
        ),
        Agent(
          id: 'a1',
          name: 'Release preparation',
          engine: 'claude',
          terminalAvailable: true,
        ),
      ];
    firstId = app.adoptSessionForTest(terminal('a0', firstInput)).id;
    secondId = app.adoptSessionForTest(terminal('a1', secondInput)).id;
  }

  final app = createApp();
  final projects = SwarmProjectStore(storage: MemoryStore());
  final firstInput = <TerminalBinaryFrame>[];
  final secondInput = <TerminalBinaryFrame>[];
  final picture = GlobalKey();
  late final int firstId, secondId;
  Future<void>? _dialogDone;

  SwarmSearchController search(WidgetTester tester) => tester
      .widget<SwarmSearchKeys>(
        find.ancestor(
          of: _historyField,
          matching: find.byType(SwarmSearchKeys),
        ),
      )
      .search!;

  Future<void> open(WidgetTester tester) async {
    final done = Completer<void>();
    tester.binding.defaultBinaryMessenger.handlePlatformMessage(
      _channel.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('showHistory'),
      ),
      (_) => done.complete(),
    );
    _dialogDone = done.future;
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(_historyField, findsOneWidget);
    expect(tester.widget<TextField>(_historyField).focusNode!.hasFocus, isTrue);
  }

  Future<void> closed(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    await _dialogDone;
    expect(_historyField, findsNothing);
  }
}

Future<_HistoryWorkspace> _mount(
  WidgetTester tester, {
  Brightness brightness = Brightness.dark,
  double scale = 1,
  Size size = const Size(880, 560),
}) async {
  tester.view.physicalSize = size;
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.reset);
  final oldBrightness = grid.AppTheme.brightness.value;
  final oldEntry = newHarnessOpensInBox;
  grid.AppTheme.brightness.value = brightness;
  newHarnessOpensInBox = true;
  addTearDown(() {
    grid.AppTheme.brightness.value = oldBrightness;
    newHarnessOpensInBox = oldEntry;
  });
  final messenger = tester.binding.defaultBinaryMessenger;
  messenger.setMockMethodCallHandler(_channel, (_) async => true);
  addTearDown(() => messenger.setMockMethodCallHandler(_channel, null));
  final fixture = _HistoryWorkspace();
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    fixture.projects.dispose();
    fixture.app.dispose();
  });
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid
          .buildAppTheme(brightness: brightness)
          .copyWith(platform: TargetPlatform.macOS),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: RepaintBoundary(key: fixture.picture, child: child!),
      ),
      home: SwarmScreen(
        notifier: fixture.app,
        nativeTabs: true,
        projectStore: fixture.projects,
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 100));
  fixture.app.focusPane(fixture.firstId);
  await tester.pump();
  fixture.app.focusPane(fixture.secondId);
  fixture.app.focusedPane!.session!.focusInput();
  await tester.pump();
  expect(fixture.app.focusedPaneId, fixture.secondId);
  return fixture;
}

Future<void> _capture(
  WidgetTester tester,
  _HistoryWorkspace fixture,
  String name,
) async {
  if (_renderDir == null) return;
  debugDisableShadows = false;
  try {
    await tester.pump();
    await tester.runAsync(() async {
      final boundary =
          fixture.picture.currentContext!.findRenderObject()!
              as RenderRepaintBoundary;
      final image = await boundary.toImage(pixelRatio: 1.5);
      final data = await image.toByteData(format: ui.ImageByteFormat.png);
      Directory(_renderDir!).createSync(recursive: true);
      await File('$_renderDir/$name.png')
          .writeAsBytes(data!.buffer.asUint8List());
      image.dispose();
    });
  } finally {
    debugDisableShadows = true;
  }
}

double _contrast(Color ink, Color fill) {
  final foreground = Color.alphaBlend(ink, fill).computeLuminance();
  final background = fill.computeLuminance();
  return foreground > background
      ? (foreground + .05) / (background + .05)
      : (background + .05) / (foreground + .05);
}

void main() {
  setUpAll(() async {
    if (_renderDir != null) await loadPreviewFonts();
  });

  testWidgets('native History owns keyboard input and restores its pane', (
    tester,
  ) async {
    final fixture = await _mount(tester);
    final target = fixture.app.activeSwarmId;
    await fixture.open(tester);
    final search = fixture.search(tester);
    final selected = search.selected!.id;
    expect(search.supportsPreview, isFalse);
    await key(tester, LogicalKeyboardKey.slash, ctrl: true);
    expect(search.hasPreview, isFalse);
    expect(search.selected!.id, selected);
    expect(tester.widget<TextField>(_historyField).focusNode!.hasFocus, isTrue);

    // The field and visible Close control form one compact traversal loop.
    await key(tester, LogicalKeyboardKey.tab);
    expect(Focus.of(tester.element(_closeIcon)).hasFocus, isTrue);
    await key(tester, LogicalKeyboardKey.tab);
    expect(tester.widget<TextField>(_historyField).focusNode!.hasFocus, isTrue);
    await key(tester, LogicalKeyboardKey.tab, shift: true);
    expect(Focus.of(tester.element(_closeIcon)).hasFocus, isTrue);
    await key(tester, LogicalKeyboardKey.tab, shift: true);
    expect(tester.widget<TextField>(_historyField).focusNode!.hasFocus, isTrue);
    await tester.enterText(_historyField, 'Prototype review');
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await fixture.closed(tester);
    expect(fixture.app.activeSwarmId, target);
    expect(fixture.app.focusedPaneId, fixture.firstId);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
    await tester.pump(const Duration(milliseconds: 10));
    expect(fixture.firstInput.single.bytes, [27, 91, 68]);
    expect(fixture.secondInput, isEmpty);

    await fixture.open(tester);
    expect(tester.widget<TextField>(_historyField).controller!.text, isEmpty);
    await key(tester, LogicalKeyboardKey.tab);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await fixture.closed(tester);
    expect(fixture.app.focusedPaneId, fixture.firstId);

    await fixture.open(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await fixture.closed(tester);
    await tester.sendKeyEvent(LogicalKeyboardKey.arrowRight);
    await tester.pump(const Duration(milliseconds: 10));
    expect(fixture.firstInput.last.bytes, [27, 91, 67]);
    expect(fixture.firstInput, hasLength(2));
    expect(fixture.secondInput, isEmpty);
  });

  testWidgets(
    'History composition keeps navigation and dismissal in the editor',
    (tester) async {
      final fixture = await _mount(tester);
      await fixture.open(tester);
      tester.testTextInput.updateEditingValue(
        const TextEditingValue(
          text: 're',
          selection: TextSelection.collapsed(offset: 2),
          composing: TextRange(start: 0, end: 2),
        ),
      );
      await tester.pump();
      expect(fixture.search(tester).rows.length, greaterThan(1));
      final selected = fixture.search(tester).selected!.id;
      for (final key in [
        LogicalKeyboardKey.arrowDown,
        LogicalKeyboardKey.enter,
        LogicalKeyboardKey.escape,
      ]) {
        // The fake editor can commit preedit while handling a key. Restore the
        // active range that the platform IME would send for each event.
        tester
            .widget<TextField>(_historyField)
            .controller!
            .value = const TextEditingValue(
          text: 're',
          selection: TextSelection.collapsed(offset: 2),
          composing: TextRange(start: 0, end: 2),
        );
        await tester.sendKeyEvent(key);
        await tester.pump();
        expect(_historyField, findsOneWidget);
        expect(fixture.search(tester).selected!.id, selected);
      }
      expect(fixture.firstInput, isEmpty);
      expect(fixture.secondInput, isEmpty);
      expect(fixture.app.focusedPaneId, fixture.secondId);
      // Explicit pointer dismissal is still available while composing.
      await tester.tap(find.byTooltip('Close'));
      await fixture.closed(tester);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowLeft);
      await tester.pump(const Duration(milliseconds: 10));
      expect(fixture.secondInput.single.bytes, [27, 91, 68]);
    },
  );

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'live History ${brightness.name} at ${scale}x stays readable',
        (tester) async {
          final size = scale == 1 ? const Size(880, 560) : const Size(440, 420);
          final fixture = await _mount(
            tester,
            brightness: brightness,
            scale: scale,
            size: size,
          );
          await fixture.open(tester);
          final surface = find.byType(DesktopDialogSurface);
          expect(surface, findsOneWidget);
          final bounds = tester.getRect(surface);
          expect(bounds.left, greaterThanOrEqualTo(20));
          expect(bounds.right, lessThanOrEqualTo(size.width - 20));
          expect(bounds.bottom, lessThanOrEqualTo(size.height - 20));
          final fieldBounds = tester.getRect(_historyField);
          expect(bounds.contains(fieldBounds.topLeft), isTrue);
          expect(bounds.contains(fieldBounds.bottomRight), isTrue);
          final context = tester.widget<Text>(find.text('This window'));
          expect(
            _contrast(context.style!.color!, DesktopChrome.surface),
            greaterThanOrEqualTo(4.5),
          );
          final search = fixture.search(tester);
          final selectedId = search.selected!.id;
          final selected = find.byKey(
            ValueKey('swarm-search-line:$selectedId'),
          );
          expect(selected, findsOneWidget);
          final fill = tester.widget<Material>(selected).color!;
          final label = tester.widget<SearchResultText>(
            find
                .descendant(
                  of: selected,
                  matching: find.byType(SearchResultText),
                )
                .first,
          );
          expect(
            _contrast(label.style.color!, fill),
            greaterThanOrEqualTo(4.5),
          );
          expect(tester.getRect(selected).top, greaterThan(fieldBounds.bottom));
          expect(tester.getRect(selected).bottom, lessThan(bounds.bottom));
          await _capture(tester, fixture, 'history-${brightness.name}-$scale');
          expect(tester.takeException(), isNull);
          await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
          await tester.pump();
          expect(search.selected!.id, isNot(selectedId));
          await tester.pump();
          final next = find.byKey(
            ValueKey('swarm-search-line:${search.selected!.id}'),
          );
          final viewport = tester.getRect(
            find.byKey(const ValueKey('swarm-search-result-list')),
          );
          expect(tester.getRect(next).top, greaterThanOrEqualTo(viewport.top));
          expect(
            tester.getRect(next).bottom,
            lessThanOrEqualTo(viewport.bottom),
          );
          expect(tester.getRect(_historyField), fieldBounds);
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await fixture.closed(tester);
        },
      );
    }
  }
}
