import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/desktop_workspace_tab.dart';

import 'support/real_fonts.dart';

typedef _Tab = ({String name, String? hint, bool working});

const _eightTabs = <_Tab>[
  (name: 'New Tab', hint: '⌘1', working: false),
  (name: 'Desktop', hint: '⌘2', working: true),
  (name: 'Docs', hint: '⌘3', working: false),
  (name: 'Web', hint: '⌘4', working: false),
  (name: 'Notes', hint: '⌘5', working: false),
  (name: 'API', hint: '⌘6', working: false),
  (name: 'Tests', hint: '⌘7', working: false),
  (name: 'Release', hint: '⌘8', working: false),
];

Widget _host(
  ValueNotifier<bool> hints, {
  List<_Tab> tabs = _eightTabs,
  Brightness brightness = Brightness.dark,
  double scale = 1,
  GlobalKey? boundary,
  VoidCallback? onSelect,
  VoidCallback? onClose,
  VoidCallback? onRename,
  bool enabled = true,
}) => RepaintBoundary(
  key: boundary,
  child: MaterialApp(
    debugShowCheckedModeBanner: false,
    theme: grid.buildAppTheme(brightness: brightness),
    themeAnimationDuration: Duration.zero,
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context)
          .copyWith(textScaler: TextScaler.linear(scale)),
      child: child!,
    ),
    home: Scaffold(
      backgroundColor: grid.AppPalette.windowBg,
      body: Align(
        alignment: Alignment.topLeft,
        child: ColoredBox(
          color: grid.AppPalette.swarmTabBar,
          child: SizedBox(
            height: scale == 1 ? 40 : 54,
            child: Row(
              children: [
                const SizedBox(width: 8),
                Expanded(
                  child: LayoutBuilder(
                    builder: (context, constraints) => SingleChildScrollView(
                      scrollDirection: Axis.horizontal,
                      child: Row(
                        children: [
                          for (final tab in tabs)
                            Builder(
                              builder: (context) => SizedBox(
                                width: DesktopWorkspaceTab.widthForStrip(
                                  constraints.maxWidth,
                                  tabs.length,
                                ),
                                child: DesktopWorkspaceTab(
                                  id: tab.name,
                                  label: tab.name,
                                  selected: tab.name == 'Desktop',
                                  shortcutHint: tab.hint,
                                  showShortcuts: hints,
                                  onSelect: enabled
                                      ? (onSelect ?? () {})
                                      : null,
                                  onClose: enabled ? (onClose ?? () {}) : null,
                                  onRename: onRename,
                                  activityLabel: tab.working ? 'Working' : null,
                                  activity: tab.working
                                      ? SizedBox(
                                          key: ValueKey('status:${tab.name}'),
                                          width: 16,
                                          child: Text(
                                            '⠋',
                                            textAlign: TextAlign.center,
                                            textScaler: TextScaler.noScaling,
                                            style:
                                                grid.AppType.mono(
                                                  color: const Color(
                                                    0xff64d2ff,
                                                  ),
                                                ).copyWith(
                                                  fontFamilyFallback: const [
                                                    'Apple Symbols',
                                                  ],
                                                ),
                                          ),
                                        )
                                      : null,
                                ),
                              ),
                            ),
                        ],
                      ),
                    ),
                  ),
                ),
                const SizedBox(width: 152),
              ],
            ),
          ),
        ),
      ),
    ),
  ),
);

Future<void> _capture(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  final directory = Platform.environment['HARNESS_WORKSPACE_TAB_CAPTURE_DIR'];
  if (directory == null) return;
  await tester.runAsync(() async {
    final image =
        await (boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(directory).create(recursive: true);
    await File('$directory/$name.png')
        .writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

Finder _label(String name) => find.byKey(ValueKey('tab-label:$name'));
Finder _hint(String name) => find.byKey(ValueKey('tab-shortcut:$name'));
Finder _close(String name) => find.byKey(ValueKey('tab-close:$name'));
Finder _tab(String name) => find.byWidgetPredicate(
  (widget) => widget is DesktopWorkspaceTab && widget.id == name,
);

void main() {
  setUpAll(() async {
    await loadRealFonts();
    if (Platform.isMacOS) {
      final sans = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in [grid.AppType.sansFamily, 'Roboto']) {
        await (FontLoader(family)..addFont(Future.value(sans))).load();
      }
      await (FontLoader('Apple Symbols')..addFont(
            Future.value(
              ByteData.sublistView(
                await File('/System/Library/Fonts/Apple Symbols.ttf')
                    .readAsBytes(),
              ),
            ),
          ))
          .load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });

  tearDown(() => grid.AppTheme.brightness.value = Brightness.dark);

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('centered ${brightness.name} tabs at $scale text scale', (
        tester,
      ) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(1280, 100);
        addTearDown(tester.view.reset);
        grid.AppTheme.brightness.value = brightness;
        final hints = ValueNotifier(false);
        addTearDown(hints.dispose);
        final boundary = GlobalKey();
        await tester.pumpWidget(
          _host(
            hints,
            brightness: brightness,
            scale: scale,
            boundary: boundary,
          ),
        );
        expect(tester.takeException(), isNull);
        if (scale == 1) {
          final scroll = tester.state<ScrollableState>(find.byType(Scrollable));
          expect(scroll.position.maxScrollExtent, 0);
        }
        expect(
          tester.getCenter(_label('New Tab')).dx,
          closeTo(tester.getCenter(_tab('New Tab')).dx, .01),
        );
        final title = tester.getRect(_label('Desktop'));
        final tabBounds = tester.getRect(_tab('Desktop'));
        final mark = find.byKey(const ValueKey('status:Desktop'));
        expect(mark, findsOneWidget);
        expect(_close('Desktop').hitTestable(), findsNothing);
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: const Offset(1260, 90));
        await tester.pump();
        await _capture(tester, boundary, 'tabs-${brightness.name}-$scale-rest');
        await mouse.moveTo(title.center);
        await tester.pumpAndSettle();
        expect(_close('Desktop').hitTestable(), findsOneWidget);
        expect(tester.getRect(_label('Desktop')), title);
        final icon = tester.widget<Icon>(
          find.descendant(of: _close('Desktop'), matching: find.byType(Icon)),
        );
        expect(icon.icon, AppIcons.close);
        expect(icon.size, 12);
        expect(tester.getSize(_close('Desktop')), const Size(32, 32));
        await _capture(
          tester,
          boundary,
          'tabs-${brightness.name}-$scale-hover',
        );
        hints.value = true;
        await tester.pump();
        expect(mark, findsNothing);
        expect(_hint('Desktop'), findsOneWidget);
        expect(_close('Desktop').hitTestable(), findsOneWidget);
        expect(tester.getRect(_label('Desktop')), title);
        expect(tester.getRect(_tab('Desktop')), tabBounds);
        final shortcut = tester.getRect(_hint('Desktop'));
        final indicator = tester.getRect(
          find.ancestor(of: _hint('Desktop'), matching: find.byType(Center)),
        );
        // The stable slot also holds the 16px activity mark. A narrower hint
        // remains centered inside it; its font-dependent glyph edge can be
        // farther from the label than the slot's six-pixel gap.
        expect(indicator.left - title.right, closeTo(6, .5));
        expect(shortcut.center.dx, closeTo(indicator.center.dx, .01));
        expect(
          indicator.right,
          lessThanOrEqualTo(tester.getRect(_close('Desktop')).left),
        );
        expect(
          (title.left + indicator.right) / 2,
          closeTo(tabBounds.center.dx, .5),
        );
        await _capture(
          tester,
          boundary,
          'tabs-${brightness.name}-$scale-command',
        );
        await mouse.removePointer();
        hints.value = false;
        await tester.pump();
        expect(mark, findsOneWidget);
        expect(tester.getRect(_label('Desktop')), title);
        expect(_close('Desktop').hitTestable(), findsNothing);
        expect(tester.takeException(), isNull);
      });
    }
  }

  testWidgets('a narrow hint preserves the centered activity slot', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(640, 100);
    addTearDown(tester.view.reset);
    final hints = ValueNotifier(false);
    addTearDown(hints.dispose);
    await tester.pumpWidget(
      _host(hints, tabs: [(name: 'Desktop', hint: '1', working: true)]),
    );
    final title = tester.getRect(_label('Desktop'));
    final slot = tester.getRect(
      find.ancestor(
        of: find.byKey(const ValueKey('status:Desktop')),
        matching: find.byType(Center),
      ),
    );
    expect(slot.width, 16);
    expect(slot.left - title.right, closeTo(6, .01));
    hints.value = true;
    await tester.pump();
    final shortcut = tester.getRect(_hint('Desktop'));
    expect(shortcut.width, lessThan(slot.width));
    expect(shortcut.left - title.right, greaterThan(6));
    expect(shortcut.center.dx, closeTo(slot.center.dx, .01));
    expect(tester.getRect(_label('Desktop')), title);
    expect(
      (title.left + slot.right) / 2,
      closeTo(tester.getCenter(_tab('Desktop')).dx, .01),
    );
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    'resolved remaps replace status and preserve purposeful actions',
    (tester) async {
      final semantics = tester.ensureSemantics();
      final hints = ValueNotifier(false);
      var selections = 0, closes = 0, renames = 0;
      try {
        await tester.pumpWidget(
          _host(
            hints,
            tabs: const [(name: 'Desktop', hint: '⌃⌥⌘R', working: true)],
            onSelect: () => selections++,
            onClose: () => closes++,
            onRename: () => renames++,
          ),
        );
        final title = tester.getRect(_label('Desktop'));
        final status = find.bySemanticsLabel('Desktop, Working');
        expect(status, findsOneWidget);
        expect(
          tester
              .getSemantics(status)
              .getSemanticsData()
              .flagsCollection
              .isButton,
          isTrue,
        );
        hints.value = true;
        await tester.pump();
        expect(find.text('⌃⌥⌘R'), findsOneWidget);
        expect(find.text('⌘1'), findsNothing);
        expect(tester.getRect(_label('Desktop')), title);
        expect(status, findsOneWidget);
        Focus.of(tester.element(_label('Desktop'))).requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        expect(selections, 1);
        final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
        await mouse.addPointer(location: title.center);
        await tester.pump();
        await tester.tap(_close('Desktop'));
        await tester.pump();
        expect(closes, 1);
        expect(selections, 1);
        await tester.tap(_label('Desktop'));
        await tester.pump(const Duration(milliseconds: 80));
        await tester.tap(_label('Desktop'));
        await tester.pumpAndSettle();
        expect(renames, 1);
        await mouse.removePointer();
      } finally {
        await tester.pumpWidget(const SizedBox());
        semantics.dispose();
        hints.dispose();
      }
    },
  );

  testWidgets('unbound and disabled tabs advertise no shortcut', (
    tester,
  ) async {
    final hints = ValueNotifier(true);
    addTearDown(hints.dispose);
    await tester.pumpWidget(
      _host(hints, tabs: const [(name: 'Notes', hint: null, working: true)]),
    );
    expect(_hint('Notes'), findsNothing);
    expect(find.byKey(const ValueKey('status:Notes')), findsOneWidget);
    await tester.pumpWidget(
      _host(
        hints,
        tabs: const [(name: 'Notes', hint: '⌘2', working: true)],
        enabled: false,
      ),
    );
    expect(_hint('Notes'), findsNothing);
    expect(find.byKey(const ValueKey('status:Notes')), findsOneWidget);
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: tester.getCenter(_label('Notes')));
    await tester.pump();
    expect(_close('Notes').hitTestable(), findsNothing);
    await mouse.removePointer();
  });
}
