import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/bootstrapping_screen.dart';
import 'package:harness/widgets/box_chrome.dart';
import 'package:harness/widgets/terminal_progress.dart';

Widget _host({
  String? message,
  bool reduceMotion = false,
  double textScale = 1,
}) {
  grid.AppTheme.brightness.value = Brightness.dark;
  return MaterialApp(
    theme: grid.buildAppTheme(brightness: Brightness.dark),
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
  testWidgets('is the terminal box, with a truthful fallback status', (
    tester,
  ) async {
    await tester.pumpWidget(_host());
    await tester.pump(const Duration(milliseconds: 100));

    // The first thing the app shows is the box the new tab uses, not a card
    // with a headline: one terminal, from the first frame.
    expect(find.byType(TerminalBox), findsOneWidget);
    expect(find.text(r'$ harness start'), findsOneWidget);
    expect(find.text('Opening Harness…'), findsOneWidget);
    expect(find.byType(TerminalProgressLine), findsOneWidget);
    // Nothing on the line is bigger than the terminal's own text.
    final title = tester.widget<Text>(find.text(r'$ harness start'));
    expect(title.style?.fontSize, boxMonoStyle().fontSize);
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

  testWidgets('Reduce Motion leaves the bar still', (tester) async {
    await tester.pumpWidget(_host(reduceMotion: true));
    await tester.pump(const Duration(milliseconds: 300));

    expect(find.byType(TerminalProgressLine), findsOneWidget);
    expect(
      tester.binding.hasScheduledFrame,
      isFalse,
      reason: 'a bar that kept travelling would never settle',
    );
  });

  testWidgets('fits the minimum window at the largest supported UI scale', (
    tester,
  ) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(880, 560);
    addTearDown(tester.view.resetDevicePixelRatio);
    addTearDown(tester.view.resetPhysicalSize);

    await tester.pumpWidget(_host(textScale: 19 / 14));
    await tester.pump(const Duration(milliseconds: 100));

    expect(tester.takeException(), isNull);
    expect(find.text(r'$ harness start'), findsOneWidget);
    expect(find.text('Opening Harness…'), findsOneWidget);
  });
}
