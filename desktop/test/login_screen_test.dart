import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/core/config.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/login_fleet_map.dart';
import 'package:harness/widgets/sign_in_step.dart';
import 'package:flutter/services.dart';

/// Wraps the screen in the same chrome `main.dart` gives it, at the app's
/// minimum window size — 880×560 — because that is where a card gets cramped
/// and nowhere else.
Widget _host(
  AppNotifier app, {
  Brightness brightness = Brightness.light,
  bool reduceMotion = false,
}) {
  return MaterialApp(
    theme: grid.buildAppTheme(brightness: brightness),
    home: MediaQuery(
      data: MediaQueryData(
        size: const Size(880, 560),
        disableAnimations: reduceMotion,
      ),
      child: grid.BrightnessScope(
        child: ListenableBuilder(
          listenable: app,
          builder: (_, _) => LoginScreen(notifier: app),
        ),
      ),
    ),
  );
}

/// A login that fails without shelling out. The real one starts a `harness`
/// process, which a unit test must never do — it would block on a binary the
/// machine may not have.
class _FailingCliLogin extends CliLogin {
  final providers = <SignInProvider?>[];

  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
    SignInProvider? provider,
  }) async {
    providers.add(provider);
    throw CliNotAvailableException('Could not run the harness CLI');
  }
}

/// A login that stays in flight until it is cancelled, recording which account
/// each attempt named.
class _WaitingCliLogin extends CliLogin {
  final providers = <SignInProvider?>[];
  Completer<void>? _pending;

  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
    SignInProvider? provider,
  }) {
    providers.add(provider);
    return (_pending = Completer<void>()).future;
  }

  @override
  void cancel() {
    final pending = _pending;
    _pending = null;
    if (pending != null && !pending.isCompleted) {
      pending.completeError(StateError('Sign-in was cancelled.'));
    }
  }
}

AppNotifier _notifier(AppStatus status, {CliLogin? cliLogin}) {
  grid.AppTheme.brightness.value = Brightness.light;
  return AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLogin: cliLogin,
    )
    ..status = status
    ..signedIn = status == AppStatus.authenticated;
}

/// WCAG 2.x relative luminance and contrast — the same arithmetic as
/// `tool/contrast.py`, inlined so the guard runs in the normal suite.
double _luminance(Color c) {
  double channel(double v) =>
      v <= 0.03928 ? v / 12.92 : math.pow((v + 0.055) / 1.055, 2.4).toDouble();
  return 0.2126 * channel(c.r) + 0.7152 * channel(c.g) + 0.0722 * channel(c.b);
}

double _contrast(Color a, Color b) {
  final la = _luminance(a);
  final lb = _luminance(b);
  final (hi, lo) = la > lb ? (la, lb) : (lb, la);
  return (hi + 0.05) / (lo + 0.05);
}

void main() {
  testWidgets(
    'every native login uses the onboarding page without the old card',
    (tester) async {
      final app = _notifier(AppStatus.unauthenticated);
      addTearDown(app.dispose);
      await tester.pumpWidget(_host(app));
      expect(find.byType(SignInStep), findsOneWidget);
      expect(find.text(signInStepTitle), findsOneWidget);
      for (final label in [
        'Continue with Google',
        'Continue with Apple',
        'Email, GitHub or passkey',
        // The ways a new or remote computer signs in with no browser of its own.
        'Scan with your phone',
        'Sign in on another device',
      ]) {
        expect(find.text(label), findsOneWidget);
      }
      expect(find.byType(LoginFleetMap), findsNothing);
      // The page's own buttons, not the old card's.
      expect(find.byKey(const Key('login-scan-with-phone')), findsNothing);
      expect(find.byKey(const Key('login-close-button')), findsNothing);
    },
  );

  testWidgets(
    'provider choices stay in place through browser wait and cancellation',
    (tester) async {
      final cli = _WaitingCliLogin();
      final app = _notifier(AppStatus.unauthenticated, cliLogin: cli);
      addTearDown(app.dispose);
      await tester.pumpWidget(_host(app));
      for (final provider in SignInProvider.values) {
        await tester.tap(find.text('Continue with ${provider.label}'));
        await tester.pump();
        expect(cli.providers.last, provider);
        app.pendingAuthorizeUrl = 'https://auth.example/authorize';
        app.notifyListeners();
        await tester.pump();
        expect(find.byType(SignInStep), findsOneWidget);
        expect(find.text('Continue with Google'), findsOneWidget);
        expect(find.text('Continue with Apple'), findsOneWidget);
        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        expect(app.signingIn, isFalse);
        expect(find.byType(SignInStep), findsOneWidget);
      }
    },
  );

  testWidgets('a fast failure stays on the shared page and can be retried', (
    tester,
  ) async {
    final cli = _FailingCliLogin();
    final app = _notifier(AppStatus.unauthenticated, cliLogin: cli);
    addTearDown(app.dispose);
    await tester.pumpWidget(_host(app));
    await tester.tap(find.text('Continue with Apple'));
    await tester.pump();
    expect(find.byKey(const Key('sign-in-step-error')), findsOneWidget);
    await tester.tap(find.text('Continue with Apple'));
    await tester.pump();
    expect(cli.providers, [SignInProvider.apple, SignInProvider.apple]);
  });

  testWidgets(
    'the shared page fits the minimum window in both palettes without idle frames',
    (tester) async {
      tester.view.physicalSize = const Size(880, 560);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      for (final brightness in Brightness.values) {
        final app = _notifier(AppStatus.unauthenticated);
        grid.AppTheme.brightness.value = brightness;
        await tester.pumpWidget(
          _host(app, brightness: brightness, reduceMotion: true),
        );
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(find.text('Continue with Google').hitTestable(), findsOneWidget);
        for (final label in const [
          'Email, GitHub or passkey',
          'Scan with your phone',
          'Sign in on another device',
        ]) {
          expect(find.text(label).hitTestable(), findsOneWidget, reason: label);
        }
        final page = tester.widget<Material>(
          find.byKey(const Key('sign-in-step')),
        );
        expect(page.color, grid.AppPalette.windowBg);
        expect(tester.binding.hasScheduledFrame, isFalse);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
      grid.AppTheme.brightness.value = Brightness.light;
    },
  );

  test('the diagram\'s caption clears the body-text contrast floor', () {
    // Measured with tool/contrast.py, pinned here so a later "let\'s soften
    // that grey" is caught by the suite rather than by a user who cannot read
    // the one sentence the drawing exists to make. WCAG 1.4.3 asks 4.5:1.
    //
    // `textFaint` was the first choice and measured 3.33:1 light / 3.18:1 dark
    // against the hub — under the floor in BOTH themes.
    for (final (name, brightness, ink, ground) in [
      (
        'light',
        Brightness.light,
        const Color(0xFF62615B),
        const Color(0xFFFFFFFF),
      ),
      (
        'dark',
        Brightness.dark,
        const Color(0xFFA8A8A2),
        const Color(0xFF202020),
      ),
    ]) {
      grid.AppTheme.brightness.value = brightness;
      expect(
        grid.AppPalette.textSecondary,
        ink,
        reason: '$name: the caption token moved',
      );
      expect(
        _contrast(ink, ground),
        greaterThanOrEqualTo(4.5),
        reason: '$name: caption fell under the body-text floor',
      );
    }
    grid.AppTheme.brightness.value = Brightness.light;
  });

  test('every frame of the diagram carries a sealed packet', () {
    // The seal — plaintext dot becoming a glowing block — is the one beat this
    // drawing exists to make, so it must be on screen whenever someone looks.
    //
    // The first stagger (0.075) bunched all three lanes into the same state:
    // half of every cycle had no sealed packet at all, and only 4% of frames
    // showed a plain dot and a sealed block together. These are the constants
    // from `login_relay_diagram.dart`, checked here because they are a
    // relationship between four numbers rather than one value to eyeball.
    const stagger = 1 / 3;
    const sealStart = 0.26, sealEnd = 0.38, travelEnd = 0.72, gone = 0.88;

    var framesWithoutSeal = 0;
    var framesShowingBoth = 0;
    for (var i = 0; i < 200; i++) {
      final t = i / 200;
      final phases = [
        for (var lane = 0; lane < 3; lane++) (t - lane * stagger) % 1.0,
      ];
      final sealed = phases.where((p) => p >= sealEnd && p < travelEnd).length;
      final plain = phases.where((p) => p > 0 && p < sealStart).length;
      if (sealed == 0) framesWithoutSeal++;
      if (sealed >= 1 && plain >= 1) framesShowingBoth++;
      expect(
        phases.where((p) => p > 0 && p < gone).length,
        greaterThan(0),
        reason: 'the diagram went empty at t=\$t',
      );
    }

    expect(framesWithoutSeal, 0, reason: 'a frame had no sealed packet');
    expect(
      framesShowingBoth / 200,
      greaterThan(0.6),
      reason: 'too few frames show plaintext and ciphertext side by side',
    );
  });
}
