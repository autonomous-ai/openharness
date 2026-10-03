import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/shared/widgets/app_select_field.dart';

import 'support/real_fonts.dart';

const _appearanceOptions = [
  SelectOption(value: 'system', label: 'Automatic'),
  SelectOption(value: 'light', label: 'Light'),
  SelectOption(value: 'dark', label: 'Dark'),
];

Widget _host(
  Widget child, {
  required GlobalKey boundary,
  Brightness brightness = Brightness.light,
  double scale = 1,
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
      body: Align(
        alignment: Alignment.topCenter,
        child: Padding(padding: const EdgeInsets.all(24), child: child),
      ),
    ),
  ),
);

Future<void> _capture(
  WidgetTester tester,
  GlobalKey boundary,
  String name,
) async {
  final directory = Platform.environment['APP_SELECT_CAPTURE_DIR'];
  if (directory == null) return;
  final shadows = debugDisableShadows;
  try {
    debugDisableShadows = false;
    for (final render in tester.allRenderObjects) {
      render.markNeedsPaint();
    }
    await tester.pump();
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
  } finally {
    debugDisableShadows = shadows;
    for (final render in tester.allRenderObjects) {
      render.markNeedsPaint();
    }
    await tester.pump();
  }
}

Future<void> _open(WidgetTester tester) async {
  await tester.tap(find.byType(AppSelectField<String>));
  await tester.pumpAndSettle();
  expect(tester.takeException(), isNull);
}

void _expectAllOptionsVisible(WidgetTester tester) {
  final scroll = tester.state<ScrollableState>(find.byType(Scrollable));
  expect(scroll.position.maxScrollExtent, 0);
  final viewport = tester.getRect(find.byType(Scrollable));
  for (final row in find.byType(AppMenuItem).evaluate()) {
    final rect = tester.getRect(find.byWidget(row.widget));
    expect(rect.top, greaterThanOrEqualTo(viewport.top));
    expect(rect.bottom, lessThanOrEqualTo(viewport.bottom));
  }
}

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
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });

  tearDown(() {
    grid.AppTheme.brightness.value = Brightness.light;
  });

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('short ${brightness.name} menu fits at $scale text size', (
        tester,
      ) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(800, 600);
        addTearDown(tester.view.reset);
        grid.AppTheme.brightness.value = brightness;
        final boundary = GlobalKey();
        String? picked;
        await tester.pumpWidget(
          _host(
            AppSelectField<String>(
              semanticLabel: 'Appearance',
              width: 280,
              value: 'system',
              options: _appearanceOptions,
              onChanged: (value) => picked = value,
            ),
            boundary: boundary,
            brightness: brightness,
            scale: scale,
          ),
        );
        await _open(tester);
        _expectAllOptionsVisible(tester);
        expect(picked, isNull);
        await _capture(tester, boundary, 'select-${brightness.name}-$scale');
        await tester.tap(find.widgetWithText(AppMenuItem, 'Dark'));
        await tester.pumpAndSettle();
        expect(picked, 'dark');
        expect(find.byType(AppMenuItem), findsNothing);
      });
    }
  }

  testWidgets('large detail rows use their actual natural height', (
    tester,
  ) async {
    final boundary = GlobalKey();
    await tester.pumpWidget(
      _host(
        AppSelectField<String>(
          width: 460,
          value: 'invite',
          textStyle: grid.AppType.body().copyWith(fontSize: 18),
          options: const [
            SelectOption(
              value: 'invite',
              label: 'Invite only',
              detail: 'Only people you invite.',
            ),
            SelectOption(value: 'public', label: 'Public'),
          ],
          onChanged: (_) {},
        ),
        boundary: boundary,
        scale: 2,
      ),
    );
    await _open(tester);
    _expectAllOptionsVisible(tester);
    await _capture(tester, boundary, 'select-detail-2.0');
  });

  testWidgets('a small window still scrolls to keyboard-selected choices', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(360, 240);
    addTearDown(tester.view.reset);
    final boundary = GlobalKey();
    String? picked;
    await tester.pumpWidget(
      _host(
        AppSelectField<String>(
          width: 280,
          value: '0',
          options: [
            for (var i = 0; i < 10; i++)
              SelectOption(value: '$i', label: 'Choice $i'),
            const SelectOption(value: 'last', label: 'Last choice'),
          ],
          onChanged: (value) => picked = value,
        ),
        boundary: boundary,
        scale: 2,
      ),
    );
    await _open(tester);
    final scroll = tester.state<ScrollableState>(find.byType(Scrollable));
    expect(scroll.position.maxScrollExtent, greaterThan(0));
    final viewport = tester.getRect(find.byType(Scrollable));
    expect(viewport.top, greaterThanOrEqualTo(0));
    expect(viewport.bottom, lessThanOrEqualTo(240));
    await tester.sendKeyEvent(LogicalKeyboardKey.keyL, character: 'l');
    await tester.pumpAndSettle();
    final last = tester.getRect(
      find.widgetWithText(AppMenuItem, 'Last choice'),
    );
    expect(last.top, greaterThanOrEqualTo(viewport.top));
    expect(last.bottom, lessThanOrEqualTo(viewport.bottom));
    expect(scroll.position.pixels, greaterThan(0));
    expect(picked, isNull);
    await _capture(tester, boundary, 'select-small-window-2.0');
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(picked, 'last');
    expect(find.byType(AppMenuItem), findsNothing);
    expect(tester.takeException(), isNull);
  });

  testWidgets('filter results shrink naturally with large text', (
    tester,
  ) async {
    final boundary = GlobalKey();
    await tester.pumpWidget(
      _host(
        AppSelectField<String>(
          width: 360,
          value: '0',
          options: [
            for (var i = 0; i < 9; i++)
              SelectOption(value: '$i', label: 'Choice $i'),
            const SelectOption(value: 'match', label: 'Matching option'),
          ],
          filterable: true,
          onChanged: (_) {},
        ),
        boundary: boundary,
        scale: 2,
      ),
    );
    await _open(tester);
    final menuScroll = tester
        .stateList<ScrollableState>(find.byType(Scrollable))
        .where((scroll) => scroll.position.axis == Axis.vertical)
        .single;
    expect(menuScroll.position.maxScrollExtent, greaterThan(0));
    await tester.enterText(find.byKey(const Key('app-select-filter')), 'match');
    await tester.pumpAndSettle();
    expect(find.byType(AppMenuItem), findsOneWidget);
    expect(menuScroll.position.maxScrollExtent, 0);
    await _capture(tester, boundary, 'select-filtered-2.0');
    expect(tester.takeException(), isNull);
  });
}
