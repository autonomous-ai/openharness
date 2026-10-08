import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/bootstrap/environment_provisioner.dart';
import 'package:harness/core/config.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/environment_setup_screen.dart';

import 'support/guest_app.dart';

const setupReview = EnvironmentReadiness(
  steps: {
    EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
    EnvironmentStep.tmux: EnvironmentStepStatus.failed,
    EnvironmentStep.harness: EnvironmentStepStatus.failed,
  },
  phase: EnvironmentSetupPhase.review,
  // Nothing on this computer — the longest plan the screen renders on macOS.
  plan: [EnvironmentPlanItem.tmuxManaged, EnvironmentPlanItem.harnessCli],
);

class SetupLogin extends CliLogin {
  @override
  Future<CliAuthStatus> checkStatus() async =>
      const CliAuthStatus(loggedIn: false);
}

class SetupAttempt {
  SetupAttempt(this.install, this.progress);
  final bool install;
  final void Function(EnvironmentReadiness) progress;
  final result = Completer<EnvironmentReadiness>();
  void finish(EnvironmentReadiness state) {
    progress(state);
    result.complete(state);
  }
}

class SetupProvisioner extends EnvironmentProvisioner {
  SetupProvisioner() : super(isMacOS: true);
  final attempts = <SetupAttempt>[];
  @override
  Future<EnvironmentReadiness> ensureReady({
    required void Function(EnvironmentReadiness) onProgress,
    EnvironmentReadiness? resumeFrom,
    bool install = true,
    EnvironmentSetupMode? mode,
  }) {
    final attempt = SetupAttempt(install, onProgress);
    attempts.add(attempt);
    onProgress(
      (resumeFrom ?? setupReview).copyWith(
        phase: install
            ? EnvironmentSetupPhase.installing
            : EnvironmentSetupPhase.preflight,
      ),
    );
    return attempt.result.future;
  }
}

Future<void> _mount(
  WidgetTester tester,
  AppNotifier app, {
  double textScale = 1,
  Brightness brightness = Brightness.dark,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(880, 560);
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid
          .buildAppTheme(brightness: brightness)
          .copyWith(platform: TargetPlatform.macOS),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(
          disableAnimations: true,
          textScaler: TextScaler.linear(textScale),
        ),
        child: child!,
      ),
      home: ListenableBuilder(
        listenable: app,
        builder: (_, _) => app.status == AppStatus.authenticated
            ? const Scaffold(body: Text('Guest workspace reached'))
            : EnvironmentSetupScreen(notifier: app),
      ),
    ),
  );
  await tester.pump();
}

AppNotifier _app(SetupProvisioner provisioner) =>
    GuestTestApp(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: SetupLogin(),
        environmentProvisioner: provisioner,
      )
      ..status = AppStatus.preparingEnvironment
      ..environmentReadiness = setupReview;

void _expectReadableText(WidgetTester tester, Finder finder) {
  final text = tester.widget<Text>(finder);
  final foreground = text.style!.color!;
  Color? background;
  tester.element(finder).visitAncestorElements((element) {
    final widget = element.widget;
    if (widget case DecoratedBox(
      decoration: BoxDecoration(color: final color?),
    )) {
      background = color;
      return false;
    }
    return true;
  });
  expect(
    background,
    isNotNull,
    reason: 'Measure against the painted setup surface.',
  );
  final fg = foreground.computeLuminance();
  final bg = background!.computeLuminance();
  final ratio = fg > bg ? (fg + .05) / (bg + .05) : (bg + .05) / (fg + .05);
  expect(
    ratio,
    greaterThanOrEqualTo(4.5),
    reason: '${text.data} must remain readable.',
  );
}

void main() {
  for (final brightness in Brightness.values) {
    testWidgets(
      'setup details and recovery text have readable contrast in ${brightness.name}',
      (tester) async {
        final previousBrightness = grid.AppTheme.brightness.value;
        final previousPalette = grid.AppTheme.palette.value;
        addTearDown(() {
          grid.AppTheme.brightness.value = previousBrightness;
          grid.AppTheme.palette.value = previousPalette;
        });
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
        for (final palette in HarnessPalette.values) {
          grid.AppTheme.brightness.value = brightness;
          grid.AppTheme.palette.value = palette;
          final provisioner = SetupProvisioner();
          final app = _app(provisioner);
          try {
            await _mount(tester, app, brightness: brightness);
            for (final item in setupReview.plan) {
              _expectReadableText(tester, find.text(item.detail));
            }
            app.environmentReadiness = setupReview.copyWith(
              phase: EnvironmentSetupPhase.failed,
              output: const ['Synthetic setup diagnostic'],
            );
            app.notifyListeners();
            await tester.pump();
            _expectReadableText(
              tester,
              find.textContaining('Required for every harness'),
            );
            _expectReadableText(
              tester,
              find.text('~/.harness/runtime · harness version'),
            );
            for (var i = 0; i < find.text('Missing').evaluate().length; i++) {
              _expectReadableText(tester, find.text('Missing').at(i));
            }
            await tester.ensureVisible(find.text('Copy diagnostics'));
            await tester.tap(find.text('Copy diagnostics'));
            await tester.pump();
            final error = find.text(
              'Could not copy. Select the text to copy it, or try again.',
            );
            expect(error.hitTestable(), findsOneWidget);
            _expectReadableText(tester, error);
            expect(find.text('Retry').hitTestable(), findsOneWidget);
            expect(provisioner.attempts, isEmpty);
            expect(tester.takeException(), isNull);
          } finally {
            await tester.pumpWidget(const SizedBox());
            app.dispose();
          }
        }
      },
    );
  }

  testWidgets(
    'Retry after a launch check failure checks, then installs unasked',
    (tester) async {
      final provisioner = SetupProvisioner();
      final app = _app(provisioner)
        ..environmentReadiness = setupReview.copyWith(
          phase: EnvironmentSetupPhase.failed,
          mode: EnvironmentSetupMode.automatic,
          failure: const EnvironmentFailure(
            title: 'Checking this computer took too long',
            detail: 'A required tool did not respond.',
          ),
        );
      await _mount(tester, app);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(provisioner.attempts, hasLength(1));
      expect(provisioner.attempts.single.install, isFalse);
      provisioner.attempts.single.finish(setupReview);
      await tester.pump();
      // Everything on the plan installs in-app, so the install follows the
      // check without stopping on the review and its Install button.
      expect(provisioner.attempts, hasLength(2));
      expect(provisioner.attempts.last.install, isTrue);
      expect(find.text('Install 2 tools'), findsNothing);
      expect(find.text('Preparing this computer'), findsOneWidget);
      provisioner.attempts.last.finish(
        const EnvironmentReadiness(
          steps: {
            EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
            EnvironmentStep.tmux: EnvironmentStepStatus.ready,
            EnvironmentStep.harness: EnvironmentStepStatus.ready,
          },
          phase: EnvironmentSetupPhase.ready,
        ),
      );
      await tester.pump();
      await tester.pump();
      // Past setup: the wizard has handed off to the rest of bootstrap.
      expect(app.status, isNot(AppStatus.preparingEnvironment));
      expect(provisioner.attempts.map((attempt) => attempt.install), [
        false,
        true,
      ]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('manual setup keeps keyboard focus and never starts an install', (
    tester,
  ) async {
    final provisioner = SetupProvisioner();
    final app = _app(provisioner);
    await _mount(tester, app);
    await tester.sendKeyDownEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.tab);
    await tester.sendKeyUpEvent(LogicalKeyboardKey.shiftLeft);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(app.environmentReadiness.mode, EnvironmentSetupMode.manual);
    expect(find.text('Check again').hitTestable(), findsOneWidget);
    // The method button retains focus when its label changes. Enter again
    // switches back instead of accidentally running the newly enabled action.
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(app.environmentReadiness.mode, EnvironmentSetupMode.automatic);
    expect(provisioner.attempts, isEmpty);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('Retry after manual setup failure remains a read-only check', (
    tester,
  ) async {
    final provisioner = SetupProvisioner();
    final app = _app(provisioner)
      ..environmentReadiness = setupReview.copyWith(
        phase: EnvironmentSetupPhase.failed,
        mode: EnvironmentSetupMode.manual,
      );
    await _mount(tester, app);
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(provisioner.attempts, hasLength(1));
    expect(provisioner.attempts.single.install, isFalse);
    provisioner.attempts.single.finish(
      setupReview.copyWith(mode: EnvironmentSetupMode.manual),
    );
    await tester.pump();
    await tester.pump();
    expect(find.text('Check again').hitTestable(), findsOneWidget);
    expect(app.environmentReadiness.mode, EnvironmentSetupMode.manual);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('setup details can expand and copy without hiding Retry', (
    tester,
  ) async {
    final provisioner = SetupProvisioner();
    final diagnostics = List.generate(40, (i) => 'Installer output line $i');
    final app = _app(provisioner)
      ..environmentReadiness = setupReview.copyWith(
        phase: EnvironmentSetupPhase.failed,
        failure: const EnvironmentFailure(
          title: 'Could not install Harness',
          detail: 'Check your connection, then retry setup.',
        ),
        output: diagnostics,
      );
    String? clipboard;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          clipboard = (call.arguments as Map)['text'] as String;
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
    await _mount(tester, app);
    expect(find.byType(SelectableText), findsNothing);
    await tester.ensureVisible(find.text('Setup details'));
    await tester.tap(find.text('Setup details'));
    await tester.pump();
    expect(find.byType(SelectableText), findsOneWidget);
    expect(find.text('Retry').hitTestable(), findsOneWidget);
    await tester.tap(find.text('Copy diagnostics'));
    await tester.pump();
    expect(clipboard, diagnostics.join('\n'));
    expect(find.text('Copied'), findsOneWidget);
    expect(provisioner.attempts, isEmpty);
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('copy failure keeps setup recovery visible and can be retried', (
    tester,
  ) async {
    final provisioner = SetupProvisioner();
    final app = _app(provisioner)
      ..environmentReadiness = setupReview.copyWith(
        phase: EnvironmentSetupPhase.failed,
        output: const ['A diagnostic to copy'],
      );
    addTearDown(app.dispose);
    var rejectClipboard = true;
    String? copied;
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          if (rejectClipboard) {
            throw PlatformException(code: 'clipboard_unavailable');
          }
          copied = (call.arguments as Map)['text'] as String;
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
    await _mount(tester, app, textScale: 2);
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
    expect(find.text('Copied'), findsNothing);
    expect(tester.takeException(), isNull);
    expect(provisioner.attempts, isEmpty);
    rejectClipboard = false;
    await tester.ensureVisible(find.text('Copy diagnostics'));
    await tester.tap(find.text('Copy diagnostics'));
    await tester.pump();
    expect(copied, 'A diagnostic to copy');
    expect(find.text('Copied'), findsOneWidget);
    expect(find.textContaining('Could not copy.'), findsNothing);
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('an older clipboard failure cannot replace a newer copy result', (
    tester,
  ) async {
    final app = _app(SetupProvisioner())
      ..environmentReadiness = setupReview.copyWith(
        phase: EnvironmentSetupPhase.failed,
        output: const ['Diagnostics'],
      );
    addTearDown(app.dispose);
    final writes = <Completer<void>>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
      SystemChannels.platform,
      (call) async {
        if (call.method == 'Clipboard.setData') {
          final write = Completer<void>();
          writes.add(write);
          await write.future;
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
    await _mount(tester, app);
    await tester.ensureVisible(find.text('Copy diagnostics'));
    await tester.tap(find.text('Copy diagnostics'));
    await tester.tap(find.text('Copy diagnostics'));
    expect(writes, hasLength(2));
    writes.last.complete();
    await tester.pump();
    expect(find.text('Copied'), findsOneWidget);
    writes.first.completeError(
      PlatformException(code: 'clipboard_unavailable'),
    );
    await tester.pump();
    expect(find.text('Copied'), findsOneWidget);
    expect(find.textContaining('Could not copy.'), findsNothing);
    expect(tester.takeException(), isNull);
    await tester.pump(const Duration(milliseconds: 1500));
    await tester.pumpWidget(const SizedBox());
  });

  for (final scale in [1.0, 2.0]) {
    testWidgets('setup actions stay visible at minimum size with $scale text', (
      tester,
    ) async {
      final provisioner = SetupProvisioner();
      final app = _app(provisioner);
      addTearDown(app.dispose);
      await _mount(tester, app, textScale: scale);
      expect(find.text('Install 2 tools').hitTestable(), findsOneWidget);
      expect(provisioner.attempts, isEmpty);
      app.environmentReadiness = setupReview.copyWith(
        phase: EnvironmentSetupPhase.failed,
        failure: const EnvironmentFailure(
          title: 'Could not install Harness',
          detail: 'Check your connection, then retry setup.',
        ),
        output: List.generate(40, (i) => 'Installer output line $i'),
      );
      app.notifyListeners();
      await tester.pump();
      expect(find.text('Retry').hitTestable(), findsOneWidget);
      expect(find.text('Switch to Manual').hitTestable(), findsOneWidget);
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'Enter installs and retries once before reaching the guest workspace',
    (tester) async {
      final provisioner = SetupProvisioner();
      final app = _app(provisioner);
      await _mount(tester, app);
      expect(provisioner.attempts, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(provisioner.attempts, hasLength(1));
      expect(provisioner.attempts.single.install, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(provisioner.attempts, hasLength(1));
      provisioner.attempts.single.finish(
        setupReview.copyWith(
          phase: EnvironmentSetupPhase.failed,
          failure: const EnvironmentFailure(
            title: 'Could not install Harness',
            detail: 'Check your connection, then retry setup.',
          ),
        ),
      );
      await tester.pump();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      expect(provisioner.attempts, hasLength(2));
      provisioner.attempts.last.finish(
        const EnvironmentReadiness(
          steps: {
            EnvironmentStep.clipboard: EnvironmentStepStatus.notApplicable,
            EnvironmentStep.tmux: EnvironmentStepStatus.ready,
            EnvironmentStep.harness: EnvironmentStepStatus.ready,
          },
          phase: EnvironmentSetupPhase.ready,
        ),
      );
      await tester.pump();
      await tester.pump();
      expect(find.text('Guest workspace reached'), findsOneWidget);
      expect(provisioner.attempts.map((attempt) => attempt.install), [
        true,
        true,
      ]);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );
}
