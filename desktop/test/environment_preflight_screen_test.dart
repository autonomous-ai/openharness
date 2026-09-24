import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/environment_preflight_screen.dart';
import 'package:harness/widgets/terminal_progress.dart';

Widget host(EnvironmentReadiness readiness, {bool reduceMotion = false}) =>
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
        child: child!,
      ),
      home: EnvironmentPreflightScreen(readiness: readiness),
    );

void main() {
  testWidgets('the initial computer check respects Reduce Motion', (
    tester,
  ) async {
    await tester.pumpWidget(
      host(EnvironmentReadiness.initial(), reduceMotion: true),
    );
    await tester.pump(const Duration(milliseconds: 300));
    expect(find.byType(CircularProgressIndicator), findsNothing);
    expect(find.byType(TerminalProgressLine), findsOneWidget);
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
      expect(find.text(r'$ harness doctor'), findsOneWidget);
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
        find.text('all checks passed · opening your workspace'),
        findsOneWidget,
      );
      // The prompt line is the same in both states; what changes is the line
      // under the bar.
      expect(
        find.text('read-only: nothing is installed by this check'),
        findsNothing,
      );
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
}
