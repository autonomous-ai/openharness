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
import 'package:harness/widgets/bootstrapping_screen.dart';
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
    if (Platform.isMacOS) {
      final bytes = ByteData.sublistView(
        await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
      );
      for (final family in ['.AppleSystemUIFont', 'SF Pro Text', 'Roboto']) {
        await (FontLoader(family)..addFont(Future.value(bytes))).load();
      }
    }
    await (FontLoader(
      'MaterialIcons',
    )..addFont(rootBundle.load('fonts/MaterialIcons-Regular.otf'))).load();
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
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
        app.environmentReadiness = const EnvironmentReadiness(
          steps: {
            EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
            EnvironmentStep.harness: EnvironmentStepStatus.running,
            EnvironmentStep.tmux: EnvironmentStepStatus.ready,
          },
        );
        app.notifyListeners();
        await tester.pump();
        await capture('checking-progress');
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
        expect(
          find.text('All checks passed. Opening your workspace…').hitTestable(),
          findsOneWidget,
        );
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
        // What a fresh Mac shows now that an in-app plan installs unasked.
        app.environmentReadiness = review.copyWith(
          mode: EnvironmentSetupMode.automatic,
          phase: EnvironmentSetupPhase.installing,
          message: 'Installing the Harness CLI and its Node runtime…',
          steps: {
            EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
            EnvironmentStep.tmux: EnvironmentStepStatus.ready,
            EnvironmentStep.harness: EnvironmentStepStatus.running,
          },
          output: const ['Downloading Node 22.23.2', 'Verifying sha256'],
        );
        app.notifyListeners();
        await tester.pump();
        expect(
          find.text('Preparing this computer').hitTestable(),
          findsOneWidget,
        );
        expect(find.byType(FilledButton), findsNothing);
        expect(find.text('Install 2 tools'), findsNothing);
        await capture('installing');
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
        final startupStatus = ValueNotifier('Starting local service…');
        addTearDown(startupStatus.dispose);
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
              home: ValueListenableBuilder(
                valueListenable: startupStatus,
                builder: (context, message, _) =>
                    BootstrappingScreen(statusMessage: message),
              ),
            ),
          ),
        );
        await tester.pump();
        expect(
          find.text('Opening your workspace').hitTestable(),
          findsOneWidget,
        );
        await capture('startup');
        startupStatus.value = 'Restoring your workspace…';
        await tester.pump();
        expect(find.text('Recent activity'), findsOneWidget);
        await capture('startup-history');
        await tester.pumpWidget(const SizedBox());
      });
    }
  }
}
