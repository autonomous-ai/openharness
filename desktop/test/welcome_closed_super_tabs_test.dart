import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/workspace_welcome.dart';

import 'support/capture.dart';

const _closed = [(id: 'tab-1', name: 'Pilot'), (id: 'tab-2', name: 'Build')];

Future<List<String>> _mount(
  WidgetTester tester, {
  List<({String id, String name})> closed = _closed,
  bool composer = false,
  Brightness brightness = Brightness.dark,
  double textScale = 1,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.reset);
  final previous = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previous);
  final opened = <String>[];
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: WorkspaceWelcome(
        onCommand: (_) {},
        closedSuperTabs: closed,
        onOpenSuperTab: opened.add,
        composerBuilder: composer
            ? (recents) => Center(child: SizedBox(width: 640, child: recents))
            : null,
      ),
    ),
  );
  await tester.pumpAndSettle();
  return opened;
}

void main() {
  final capture = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() => loadCaptureFonts(capture));
  for (final composer in [false, true]) {
    final layout = composer ? 'composer' : 'classic';
    testWidgets('$layout welcome lists closed Swarms and opens one', (
      tester,
    ) async {
      final opened = await _mount(tester, composer: composer);
      expect(find.text('Recent Swarms'), findsOneWidget);
      expect(find.text('Pilot'), findsOneWidget);
      await tester.tap(
        find.byKey(const ValueKey('welcome-closed-super-tab-tab-2')),
      );
      expect(opened, ['tab-2']);
    });

    testWidgets('$layout welcome has no section when nothing is closed', (
      tester,
    ) async {
      await _mount(tester, closed: const [], composer: composer);
      expect(find.text('Recent Swarms'), findsNothing);
    });
  }

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'recent Swarm rows remain keyboard accessible in ${brightness.name} at $scale',
        (tester) async {
          final opened = await _mount(
            tester,
            composer: true,
            brightness: brightness,
            textScale: scale,
          );
          await captureWindow(
            tester,
            capture,
            'swarm-recents-${brightness.name}-$scale',
          );
          Focus.of(tester.element(find.text('Build'))).requestFocus();
          await tester.pumpAndSettle();
          await captureWindow(
            tester,
            capture,
            'swarm-recents-${brightness.name}-$scale-focus',
          );
          await tester.sendKeyEvent(LogicalKeyboardKey.enter);
          await tester.pumpAndSettle();
          expect(opened, ['tab-2']);
          expect(tester.takeException(), isNull);
        },
      );
    }
  }
}
