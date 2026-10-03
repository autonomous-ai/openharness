import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/teams/team_controller.dart';
import 'package:harness/teams/team_workspace.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/team_fixture.dart';
import 'support/real_fonts.dart';

void main() {
  setUpAll(() async {
    await loadRealFonts();
    if (Platform.isMacOS &&
        Platform.environment['CHANNEL_RENDER_DIR'] != null) {
      final font = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
        await (FontLoader(family)..addFont(Future.value(font))).load();
      }
    }
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });

  Future<void> capture(WidgetTester tester, String name) async {
    final directory = Platform.environment['CHANNEL_RENDER_DIR'];
    if (directory == null) return;
    final oldShadows = debugDisableShadows;
    try {
      debugDisableShadows = false;
      for (final object in tester.allRenderObjects) {
        object.markNeedsPaint();
      }
      await tester.pump();
      final boundary = tester.renderObject<RenderRepaintBoundary>(
        find.byKey(const ValueKey('channel-preview')),
      );
      await tester.runAsync(() async {
        final image = await boundary.toImage(pixelRatio: 2);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(directory).create(recursive: true);
        await File('$directory/$name.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });
    } finally {
      debugDisableShadows = oldShadows;
      for (final object in tester.allRenderObjects) {
        object.markNeedsPaint();
      }
      await tester.pump();
    }
  }

  Future<TeamController> show(
    WidgetTester tester, {
    required List<Map<String, dynamic>> calls,
    Map<String, dynamic>? fixture,
    Brightness brightness = Brightness.dark,
    Size size = const Size(390, 620),
    double scale = 1,
    VoidCallback? onClose,
    String? error,
  }) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    final oldBrightness = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
    final model = TeamController(
      channelTabId: 'device',
      request: (payload) async {
        calls.add(payload);
        if (error != null) throw TeamRequestError(error);
        return {
          'team': {
            ...fixture ?? teamFixture(),
            'name': 'Device',
            'channel': {'tabId': 'device'},
          },
        };
      },
    );
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        builder: (context, child) => MediaQuery(
          data: MediaQuery.of(context)
              .copyWith(textScaler: TextScaler.linear(scale)),
          child: child!,
        ),
        home: RepaintBoundary(
          key: const ValueKey('channel-preview'),
          child: Scaffold(
            body: TeamWorkspace(
              controller: model,
              candidates: const [],
              machineName: 'Mac',
              onClose: onClose ?? () {},
              onOpen: (_, _) {},
            ),
          ),
        ),
      ),
    );
    addTearDown(() async {
      await tester.pumpWidget(const SizedBox());
      model.dispose();
    });
    await tester.pumpAndSettle();
    return model;
  }

  for (final width in [390.0, 1280.0]) {
    for (final brightness in Brightness.values) {
      for (final scale in [1.0, 2.0]) {
        testWidgets(
          'tab channel $width ${brightness.name} $scale keeps the same read-only history',
          (tester) async {
            final calls = <Map<String, dynamic>>[];
            await show(
              tester,
              calls: calls,
              brightness: brightness,
              size: Size(width, width == 390 && scale == 2 ? 360 : 820),
              scale: scale,
            );
            expect(find.text('Device'), findsOneWidget);
            expect(find.textContaining('This tab only'), findsOneWidget);
            expect(find.byKey(const Key('team-question')), findsNothing);
            expect(find.byKey(const Key('team-new')), findsNothing);
            expect(find.text('New question'), findsNothing);
            expect(
              find.textContaining('Use GET /api/daemons.'),
              findsOneWidget,
            );
            expect(calls.map((p) => p['action']), everyElement('channel_get'));
            expect(tester.takeException(), isNull);
            if (width == 390 && scale == 2) {
              expect(
                tester
                    .getSize(find.byKey(const ValueKey('team-compact-content')))
                    .height,
                greaterThan(220),
              );
              expect(
                find.byKey(const ValueKey('team-close')).hitTestable(),
                findsOneWidget,
              );
            }
            await capture(
              tester,
              'channel-${brightness.name}-${width.toInt()}-$scale',
            );
            if (width == 390 || scale == 2) {
              await tester.ensureVisible(
                find.textContaining('Use GET /api/daemons.'),
              );
              await tester.pumpAndSettle();
              expect(tester.takeException(), isNull);
              await capture(
                tester,
                'answer-${brightness.name}-${width.toInt()}-$scale',
              );
            }
          },
        );
      }
    }
  }

  testWidgets(
    'page keys scroll the active list and keyboard focus keeps row geometry',
    (tester) async {
      final calls = <Map<String, dynamic>>[];
      final fixture = teamFixture();
      final exchange = (fixture['exchanges'] as List).first as Map;
      fixture['exchanges'] = [
        for (var i = 0; i < 24; i++)
          {
            ...exchange,
            'id': 'exchange-$i',
            'createdAt': i,
            'text':
                'Review $i: Which endpoint should the frontend use while the owner machine reconnects?',
          },
      ];
      var closed = false;
      final model = await show(
        tester,
        calls: calls,
        fixture: fixture,
        size: const Size(390, 540),
        scale: 1.6,
        onClose: () => closed = true,
      );
      final compact = tester
          .widget<SingleChildScrollView>(
            find.byKey(const ValueKey('team-compact-content')),
          )
          .controller!;
      await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
      await tester.pump();
      expect(compact.offset, greaterThan(0));
      await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
      await tester.pump();
      expect(compact.offset, 0);

      final row = find.byKey(const ValueKey('team-exchange-exchange-23'));
      await tester.ensureVisible(row);
      await tester.pumpAndSettle();
      final before = tester.getRect(row);
      await tester.tap(row);
      await tester.pumpAndSettle();
      expect(model.selectedExchange, 'exchange-23');
      expect(tester.getRect(row), before);
      final button = find.descendant(
        of: row,
        matching: find.byType(TextButton),
      );
      Focus.of(
        tester.element(
          find.descendant(of: button, matching: find.byType(Text)).first,
        ),
      ).requestFocus();
      await tester.pump();
      final style = tester.widget<TextButton>(button).style!;
      expect(
        style.side!.resolve({WidgetState.focused})!.color,
        DesktopChrome.focusRing,
      );
      expect(
        style.backgroundColor!.resolve({WidgetState.focused}),
        DesktopChrome.selection,
      );
      final list = tester
          .widget<ListView>(find.byKey(const ValueKey('team-exchanges')))
          .controller!;
      await tester.sendKeyEvent(LogicalKeyboardKey.pageDown);
      await tester.pump();
      expect(list.offset, greaterThan(0));
      await tester.sendKeyEvent(LogicalKeyboardKey.pageUp);
      await tester.pump();
      expect(list.offset, 0);

      final originalFont = terminalFontStore.value;
      addTearDown(() => terminalFontStore.value = originalFont);
      terminalFontStore.value = originalFont.copyWith(fontSize: 26);
      await tester.pumpAndSettle();
      expect(tester.getRect(row), before);
      expect(calls.map((p) => p['action']), everyElement('channel_get'));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      expect(closed, isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a long failed read remains readable without enabling team actions',
    (tester) async {
      final calls = <Map<String, dynamic>>[];
      await show(
        tester,
        calls: calls,
        size: const Size(390, 360),
        scale: 2,
        error: 'The owner is unavailable. ' * 20,
      );
      expect(find.text('No teams yet. Start with two sessions.'), findsNothing);
      final retry = find.widgetWithText(TextButton, 'Retry reading tab');
      await tester.ensureVisible(retry);
      await tester.pumpAndSettle();
      expect(retry.hitTestable(), findsOneWidget);
      expect(calls.map((p) => p['action']), everyElement('channel_get'));
      expect(tester.takeException(), isNull);
      await capture(tester, 'unavailable-dark-2.0');
    },
  );
}
