import 'dart:async';
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';

/// A phone sign-in that never hears back from the phone, and counts how often it is told to stop.
class _HangingLogin extends CliLogin {
  var cancels = 0;

  @override
  Future<void> loginWithPhone({
    required void Function(String link, int expiresIn) onQr,
    required Future<bool> Function(String email) onConfirm,
  }) async {
    onQr('https://harness.autonomous.ai/signin#k=hnq_${'a' * 43}', 120);
    await Completer<void>().future;
  }

  @override
  void cancel() {
    cancels++;
    super.cancel();
  }
}

/// The whole app, the way it runs — for what happens when the person quits it.
Widget _wholeApp(AppNotifier app) => ProviderScope(
  overrides: [appStateProvider.overrideWithValue(app)],
  child: HarnessApp(authenticatedScreen: (_) => const SizedBox()),
);

Widget _host(AppNotifier app) => MaterialApp(
  theme: grid.buildAppTheme(brightness: Brightness.light),
  home: MediaQuery(
    data: const MediaQueryData(size: Size(880, 700)),
    child: grid.BrightnessScope(
      child: ListenableBuilder(
        listenable: app,
        builder: (_, _) => LoginScreen(notifier: app),
      ),
    ),
  ),
);

void main() {
  testWidgets(
    'quitting the app stops a phone sign-in still waiting on the phone',
    (tester) async {
      // Its CLI would otherwise wait on after the app has gone — minutes, holding the lock the next
      // sign-in needs, with its QR still good for anyone who scans it.
      final login = _HangingLogin();
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        cliLogin: login,
      )..status = AppStatus.unauthenticated;
      unawaited(app.loginWithPhone());
      await tester.pumpWidget(_wholeApp(app));
      await tester.pump();
      expect(app.signingIn, isTrue);
      expect(app.pendingQrLink, isNotNull);

      final observer =
          tester.state(find.byType(RootShell)) as WidgetsBindingObserver;
      expect(await observer.didRequestAppExit(), AppExitResponse.exit);
      expect(login.cancels, 1);
      expect(app.signingIn, isFalse);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets('quitting with no sign-in in flight stops nothing', (
    tester,
  ) async {
    // A signed-out app on its login screen quits as before: there is no CLI to stop.
    final login = _HangingLogin();
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLogin: login,
    )..status = AppStatus.unauthenticated;
    await tester.pumpWidget(_wholeApp(app));
    await tester.pump();
    final observer =
        tester.state(find.byType(RootShell)) as WidgetsBindingObserver;
    expect(await observer.didRequestAppExit(), AppExitResponse.exit);
    expect(login.cancels, 0);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'Desktop uses onboarding choices instead of the old phone dialog',
    (tester) async {
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      )..status = AppStatus.unauthenticated;
      addTearDown(app.dispose);
      await tester.pumpWidget(_host(app));
      expect(find.text('Continue with Google'), findsOneWidget);
      expect(find.text('Email, GitHub or passkey'), findsOneWidget);
      // The phone's scan is the page's own button, beside a code for another device.
      expect(find.byKey(const Key('sign-in-step-scan')), findsOneWidget);
      expect(find.byKey(const Key('sign-in-step-code')), findsOneWidget);
      expect(find.byKey(const Key('login-scan-with-phone')), findsNothing);
    },
  );
}
