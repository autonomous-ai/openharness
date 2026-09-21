// Optional PNGs: HARNESS_SETUP_CAPTURE_DIR=/private/tmp/setup-review
// flutter test test/setup_review_render_test.dart
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/environment_preflight_screen.dart';
import 'package:harness/widgets/environment_setup_screen.dart';

import 'support/real_fonts.dart';

class _NoInstall extends EnvironmentProvisioner {
  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) => throw StateError('The render fixture must not run an installer');
}

void main() {
  setUpAll(() async {
    await loadRealFonts();
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
  });
  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('setup at minimum window, ${brightness.name}, $scale text', (
        tester,
      ) async {
        tester.view.devicePixelRatio = 1;
        tester.view.physicalSize = const Size(880, 560);
        addTearDown(tester.view.reset);
        final previousBrightness = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previousBrightness);
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          SystemChannels.platform,
          (call) async {
            if (call.method == 'Clipboard.setData') {
              throw PlatformException(code: 'clipboard_unavailable');
            }
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            SystemChannels.platform,
            null,
          ),
        );
        const review = EnvironmentReadiness(
          steps: {
            EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
            EnvironmentStep.tmux: EnvironmentStepStatus.failed,
            EnvironmentStep.harness: EnvironmentStepStatus.failed,
          },
          phase: EnvironmentSetupPhase.review,
          plan: [
            EnvironmentPlanItem.tmuxManaged,
            EnvironmentPlanItem.harnessCli,
          ],
        );
        final app =
            AppNotifier(
                config: AppConfig.dev,
                authSession: AuthSession(),
                configStore: null,
                environmentProvisioner: _NoInstall(),
              )
              ..status = AppStatus.preparingEnvironment
              ..environmentReadiness = EnvironmentReadiness.initial();
        addTearDown(app.dispose);
        final boundary = GlobalKey();
        Future<void> capture(String name) async {
          expect(tester.takeException(), isNull);
          final output = Platform.environment['HARNESS_SETUP_CAPTURE_DIR'];
          if (output == null) return;
          final render =
              boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final picture = await render.toImage(pixelRatio: 1);
            try {
              final bytes = await picture.toByteData(
                format: ui.ImageByteFormat.png,
              );
              await Directory(output).create(recursive: true);
              await File('$output/$name-${brightness.name}-$scale.png')
                  .writeAsBytes(bytes!.buffer.asUint8List());
            } finally {
              picture.dispose();
            }
          });
        }

        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context).copyWith(
                  disableAnimations: true,
                  textScaler: TextScaler.linear(scale),
                ),
                child: child!,
              ),
              home: ListenableBuilder(
                listenable: app,
                builder: (_, _) => switch (app.environmentReadiness.phase) {
                  EnvironmentSetupPhase.preflight ||
                  EnvironmentSetupPhase.ready => EnvironmentPreflightScreen(
                    readiness: app.environmentReadiness,
                  ),
                  _ => EnvironmentSetupScreen(notifier: app),
                },
              ),
            ),
          ),
        );
        await tester.pump();
        expect(
          find.text('Checking this computer').hitTestable(),
          findsOneWidget,
        );
        await capture('checking');
        app.environmentReadiness = EnvironmentReadiness(
          steps: {
            for (final step in EnvironmentStep.values)
              step: EnvironmentStepStatus.ready,
          },
          phase: EnvironmentSetupPhase.ready,
        );
        app.notifyListeners();
        await tester.pump();
        await tester.pump();
        expect(find.text('Environment ready').hitTestable(), findsOneWidget);
        await capture('ready');
        app.environmentReadiness = review;
        app.notifyListeners();
        await tester.pump();
        expect(find.text('Install 2 tools').hitTestable(), findsOneWidget);
        await capture('review');
        app.selectEnvironmentSetupMode(EnvironmentSetupMode.manual);
        await tester.pump();
        expect(find.text('Check again').hitTestable(), findsOneWidget);
        await capture('manual');
        app.environmentReadiness = review.copyWith(
          mode: EnvironmentSetupMode.automatic,
          phase: EnvironmentSetupPhase.waitingForTerminal,
        );
        app.notifyListeners();
        await tester.pump();
        expect(find.text('Recheck now').hitTestable(), findsOneWidget);
        await capture('waiting');
        app.environmentReadiness = review.copyWith(
          phase: EnvironmentSetupPhase.failed,
          failure: const EnvironmentFailure(
            title: 'Setup could not finish',
            detail: 'Check your connection, then retry setup.',
          ),
          output: const ['Recent package output', 'Connection interrupted'],
        );
        app.notifyListeners();
        await tester.pump();
        expect(find.text('Retry').hitTestable(), findsOneWidget);
        await capture('failed');
        await tester.ensureVisible(find.text('Copy diagnostics'));
        await tester.tap(find.text('Copy diagnostics'));
        await tester.pump();
        expect(
          find
              .text('Could not copy. Select the text to copy it, or try again.')
              .hitTestable(),
          findsOneWidget,
        );
        expect(find.text('Retry').hitTestable(), findsOneWidget);
        await capture('copy-error');
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
