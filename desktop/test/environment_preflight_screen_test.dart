import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/environment_preflight_screen.dart';

Widget host(
  EnvironmentReadiness readiness, {
  bool reduceMotion = false,
  Brightness brightness = Brightness.dark,
  double textScale = 1,
}) {
  grid.AppTheme.brightness.value = brightness;
  return MaterialApp(
    theme: grid.buildAppTheme(brightness: brightness),
    builder: (context, child) => MediaQuery(
      data: MediaQuery.of(context).copyWith(
        disableAnimations: reduceMotion,
        textScaler: TextScaler.linear(textScale),
      ),
      child: child!,
    ),
    home: grid.BrightnessScope(
      child: EnvironmentPreflightScreen(readiness: readiness),
    ),
  );
}

void main() {
  testWidgets('the initial computer check respects Reduce Motion', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(EnvironmentReadiness.initial(), reduceMotion: true),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byType(LinearProgressIndicator), findsOneWidget);
    expect(find.text('0 of 3 checks finished'), findsOneWidget);
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  testWidgets('computer readiness has an accessible changing status', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    try {
      await tester.pumpWidget(
        host(EnvironmentReadiness.initial(), reduceMotion: true),
      );
      final status = find.byKey(const Key('environment-status'));
      expect(status, findsOneWidget);
      expect(
        tester
            .getSemantics(status)
            .getSemanticsData()
            .flagsCollection
            .isLiveRegion,
        isTrue,
      );
      expect(find.text('Checking this computer'), findsOneWidget);
      expect(find.bySemanticsLabel('Harness CLI\nWaiting'), findsOneWidget);
      await tester.pumpWidget(
        host(
          EnvironmentReadiness(
            steps: {
              for (final step in EnvironmentStep.values)
                step: EnvironmentStepStatus.ready,
            },
            phase: EnvironmentSetupPhase.ready,
          ),
          reduceMotion: true,
        ),
      );
      await tester.pump();
      expect(
        find.text('All checks passed. Opening your workspace…'),
        findsOneWidget,
      );
      expect(find.text("This check doesn't install anything."), findsNothing);
      expect(
        tester
            .getSemantics(status)
            .getSemanticsData()
            .flagsCollection
            .isLiveRegion,
        isTrue,
      );
    } finally {
      semantics.dispose();
    }
  });

  testWidgets('finished checks include failures without claiming readiness', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(
        const EnvironmentReadiness(
          steps: {
            EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
            EnvironmentStep.harness: EnvironmentStepStatus.failed,
            EnvironmentStep.tmux: EnvironmentStepStatus.running,
          },
        ),
      ),
    );
    expect(find.text('Not needed'), findsOneWidget);
    expect(find.text('Check failed'), findsOneWidget);
    expect(find.text('Checking…'), findsOneWidget);
    expect(find.text('2 of 3 checks finished'), findsOneWidget);
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      2 / 3,
    );
    expect(find.text('Your computer is ready'), findsNothing);

    await tester.pumpWidget(
      host(
        EnvironmentReadiness(
          steps: {
            for (final step in EnvironmentStep.values)
              step: EnvironmentStepStatus.ready,
          },
        ),
      ),
    );
    expect(find.text('3 of 3 checks finished'), findsOneWidget);
    expect(
      find.text('Your computer is ready'),
      findsNothing,
      reason: 'the provisioner must publish its final ready phase',
    );
  });

  testWidgets('unknown progress stays unnumbered and respects Reduce Motion', (
    tester,
  ) async {
    await tester.pumpWidget(host(const EnvironmentReadiness(steps: {})));
    expect(
      tester
          .widget<LinearProgressIndicator>(find.byType(LinearProgressIndicator))
          .value,
      isNull,
    );
    await tester.pumpWidget(
      host(const EnvironmentReadiness(steps: {}), reduceMotion: true),
    );
    await tester.pumpAndSettle(
      const Duration(milliseconds: 50),
      EnginePhase.sendSemanticsUpdate,
      const Duration(seconds: 1),
    );
    expect(find.byIcon(AppIcons.hourglass), findsOneWidget);
    expect(find.text('Waiting for checks…'), findsOneWidget);
    expect(find.byType(LinearProgressIndicator), findsNothing);
    expect(tester.binding.hasScheduledFrame, isFalse);
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'readiness fits a narrow ${brightness.name} window with large text',
      (tester) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(360, 360);
        addTearDown(tester.view.reset);
        await tester.pumpWidget(
          host(
            const EnvironmentReadiness(
              steps: {
                EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
                EnvironmentStep.harness: EnvironmentStepStatus.unavailable,
                EnvironmentStep.tmux: EnvironmentStepStatus.needsTerminal,
              },
            ),
            brightness: brightness,
            textScale: 1.6,
            reduceMotion: true,
          ),
        );
        await tester.pump();
        expect(tester.takeException(), isNull);
        expect(find.text('Unavailable'), findsOneWidget);
        expect(find.text('Needs Terminal'), findsOneWidget);
        await tester.ensureVisible(
          find.text("This check doesn't install anything."),
        );
        expect(
          find.text("This check doesn't install anything.").hitTestable(),
          findsOneWidget,
        );
        expect(
          tester.widget<Text>(find.text('Harness CLI')).style?.fontFamily,
          grid.AppType.sansFamily,
        );
      },
    );
  }
}
