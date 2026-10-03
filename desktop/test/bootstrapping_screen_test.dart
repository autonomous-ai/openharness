import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:harness/widgets/bootstrapping_screen.dart';
import 'package:xterm/xterm.dart';

Widget _host({
  String? message,
  bool reduceMotion = false,
  double textScale = 1,
  Brightness brightness = Brightness.dark,
}) {
  grid.AppTheme.brightness.value = brightness;
  return MaterialApp(
    theme: grid.buildAppTheme(brightness: brightness),
    home: MediaQuery(
      data: MediaQueryData(
        size: const Size(880, 560),
        disableAnimations: reduceMotion,
        textScaler: TextScaler.linear(textScale),
      ),
      child: grid.BrightnessScope(
        child: BootstrappingScreen(statusMessage: message),
      ),
    ),
  );
}

void main() {
  testWidgets('the heading and the status sit in the middle of the window', (
    tester,
  ) async {
    // The block is up to 470 wide and its lines are shorter; start-aligned, they
    // read as sitting left of centre.
    tester.view.physicalSize = const Size(1600, 1000);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(_host(message: 'Starting local service…'));
    await tester.pump(const Duration(milliseconds: 100));
    final middle = tester.getSize(find.byType(BootstrappingScreen)).width / 2;
    for (final text in ['Opening your workspace', 'Starting local service…']) {
      final centre = tester.getCenter(find.text(text)).dx;
      expect((centre - middle).abs(), lessThan(24), reason: text);
    }
  });

  testWidgets('opens with a task heading and a truthful fallback status', (
    tester,
  ) async {
    await tester.pumpWidget(_host());
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('Opening your workspace'), findsOneWidget);
    expect(find.text('Opening Harness…'), findsOneWidget);
    expect(find.byType(CircularProgressIndicator), findsOneWidget);
    expect(find.textContaining('%'), findsNothing);
    final title = tester.widget<Text>(find.text('Opening your workspace'));
    expect(title.style?.fontFamily, grid.AppType.sansFamily);
  });

  testWidgets('shows the daemon status as an accessible live update', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();

    await tester.pumpWidget(_host(message: 'Starting local service…'));
    await tester.pump(const Duration(milliseconds: 100));

    expect(find.text('Starting local service…'), findsOneWidget);
    expect(find.bySemanticsLabel('Harness startup status'), findsOneWidget);
    final node = tester.getSemantics(find.byKey(const Key('boot-status')));
    expect(node.value, 'Starting local service…');
    semantics.dispose();
  });

  testWidgets('Reduce Motion uses a static waiting indicator', (tester) async {
    await tester.pumpWidget(_host(reduceMotion: true));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byIcon(AppIcons.hourglass), findsOneWidget);
    expect(
      tester.binding.hasScheduledFrame,
      isFalse,
      reason: 'startup must not continuously animate under Reduce Motion',
    );
  });

  testWidgets(
    'keeps bounded recent activity and announces the current message',
    (tester) async {
      final semantics = tester.ensureSemantics();
      try {
        for (final message in [
          'Opening Harness…',
          'Checking account…',
          'Checking account…',
          'Starting local service…',
          'Connecting to local service…',
          'Restoring your workspace…',
        ]) {
          await tester.pumpWidget(_host(message: message, reduceMotion: true));
        }
        expect(find.text('Recent activity'), findsOneWidget);
        expect(find.text('Opening Harness…'), findsNothing);
        expect(find.text('Checking account…'), findsOneWidget);
        expect(find.text('Starting local service…'), findsOneWidget);
        expect(find.text('Connecting to local service…'), findsOneWidget);
        expect(
          tester.getSemantics(find.byKey(const Key('boot-status'))).value,
          'Restoring your workspace…',
        );
      } finally {
        semantics.dispose();
      }
    },
  );

  testWidgets('startup typography is independent of the terminal preference', (
    tester,
  ) async {
    final original = terminalFontStore.value;
    addTearDown(() => terminalFontStore.value = original);
    await tester.pumpWidget(_host(reduceMotion: true));
    final title = find.text('Opening your workspace');
    final style = tester.widget<Text>(title).style;
    final size = tester.getSize(title);
    terminalFontStore.value = const TerminalStyle(
      fontFamily: 'Courier New',
      fontSize: 22,
    );
    await tester.pump();
    expect(tester.widget<Text>(title).style, style);
    expect(tester.getSize(title), size);
  });

  for (final brightness in Brightness.values) {
    testWidgets('long startup status fits a narrow ${brightness.name} window', (
      tester,
    ) async {
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(360, 360);
      addTearDown(tester.view.reset);
      const message =
          'Connecting to the local Harness service and restoring your saved '
          'workspace with its open projects…';
      await tester.pumpWidget(
        _host(
          textScale: 1.6,
          brightness: brightness,
          reduceMotion: true,
          message: message,
        ),
      );
      await tester.pump();
      expect(tester.takeException(), isNull);
      expect(find.text('Opening your workspace'), findsOneWidget);
      final text = tester.widget<Text>(find.text(message));
      expect(text.maxLines, isNull);
      expect(
        tester.widget<Scaffold>(find.byType(Scaffold)).backgroundColor,
        grid.AppPalette.windowBg,
      );
    });
  }
}
