import 'dart:async';
import 'dart:ui' show AppExitResponse;

import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/sign_in_client.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/core/config.dart';
import 'package:harness/screens/login_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/or_divider.dart';

/// The login screen's second way in: a QR a signed-in phone approves, then a yes here to the
/// account that approved it.

/// Shows a QR, then asks the account question, and records the answer — no process started.
class _PhoneLogin extends CliLogin {
  final answers = <bool>[];
  final Completer<void> finished = Completer<void>();

  @override
  Future<void> loginWithPhone({
    required void Function(String link, int expiresIn) onQr,
    required Future<bool> Function(String email) onConfirm,
  }) async {
    onQr('https://harness.autonomous.ai/signin#k=hnq_${'a' * 43}', 120);
    await Future<void>.delayed(const Duration(milliseconds: 10));
    answers.add(await onConfirm('dee@example.com'));
    await finished.future;
    if (!answers.last) throw StateError('Not signed in as dee@example.com.');
  }
}

/// A sign-in that waits behind another one — what the CLI's `waiting` event sets — until released.
class _WaitingLogin extends CliLogin {
  static const note = 'Another sign-in on this computer is still running — waiting for it to finish…';
  final release = Completer<void>();

  @override
  Future<void> loginWithPhone({
    required void Function(String link, int expiresIn) onQr,
    required Future<bool> Function(String email) onConfirm,
  }) async {
    waitingNote.value = note;
    await release.future;
    throw StateError('Sign-in was cancelled.');
  }
}

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
      child: ListenableBuilder(listenable: app, builder: (_, _) => LoginScreen(notifier: app)),
    ),
  ),
);

/// [_host] says the window is 700 tall while the test surface is 600, so the last way in can sit
/// under the fold: bring it up before pressing it.
Future<void> _tapScanWithPhone(WidgetTester tester) async {
  final scan = find.byKey(const Key('login-scan-with-phone'));
  await tester.ensureVisible(scan);
  await tester.tap(scan);
}

void main() {
  testWidgets('offers "Scan with your phone", shows the QR, then asks whose account', (tester) async {
    grid.AppTheme.brightness.value = Brightness.light;
    final login = _PhoneLogin();
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null, cliLogin: login)
      ..status = AppStatus.unauthenticated;
    addTearDown(app.dispose);
    await tester.pumpWidget(_host(app));
    expect(find.byKey(const Key('login-scan-with-phone')), findsOneWidget);
    // A way in of its own, set apart from the two accounts above it.
    expect(find.byType(OrDivider), findsOneWidget);

    await _tapScanWithPhone(tester);
    await tester.pump();
    expect(find.byKey(const Key('login-phone-qr')), findsOneWidget);
    expect(find.textContaining('Sign in a computer'), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 20));
    expect(find.text('Sign in as dee@example.com?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('login-phone-refuse')));
    await tester.pump();
    expect(login.answers, [false]);
    login.finished.complete();
    await tester.pump();
    expect(app.signingIn, isFalse);
    expect(find.byKey(const Key('login-scan-with-phone')), findsOneWidget);
  });

  testWidgets('over the desk (a guest signing in), the QR still appears and the question too', (tester) async {
    // The sheet is its own route, built once: it has to follow the notifier itself, or a QR that
    // arrives after the click is never drawn (2026-10-01, a guest's "Scan with your phone").
    grid.AppTheme.brightness.value = Brightness.light;
    final login = _PhoneLogin();
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null, cliLogin: login)
      ..status = AppStatus.authenticated
      ..signedIn = false;
    addTearDown(app.dispose);
    await tester.pumpWidget(MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.light),
      home: MediaQuery(
        data: const MediaQueryData(size: Size(880, 700)),
        child: grid.BrightnessScope(
          child: Builder(
            builder: (context) => Center(
              child: TextButton(
                key: const Key('open-sheet'),
                onPressed: () => unawaited(showSignInSheet(context, app)),
                child: const Text('Sign in'),
              ),
            ),
          ),
        ),
      ),
    ));
    await tester.tap(find.byKey(const Key('open-sheet')));
    await tester.pump();
    await tester.tap(find.byKey(const Key('login-scan-with-phone')));
    await tester.pump();
    expect(find.byKey(const Key('login-phone-qr')), findsOneWidget);

    await tester.pump(const Duration(milliseconds: 20));
    expect(find.text('Sign in as dee@example.com?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('login-phone-refuse')));
    await tester.pump();
    expect(login.answers, [false]);
    login.finished.complete();
    await tester.pump();
  });

  testWidgets('a sign-in waiting behind another one says so, rather than showing nothing', (tester) async {
    grid.AppTheme.brightness.value = Brightness.light;
    final login = _WaitingLogin();
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null, cliLogin: login)
      ..status = AppStatus.unauthenticated;
    addTearDown(app.dispose);
    await tester.pumpWidget(_host(app));
    await _tapScanWithPhone(tester);
    await tester.pump();
    expect(find.text(_WaitingLogin.note), findsOneWidget);
    // Its turn comes: the note goes with the wait.
    login.waitingNote.value = null;
    await tester.pump();
    expect(find.text(_WaitingLogin.note), findsNothing);
    login.release.complete();
    await tester.pump();
  });

  testWidgets('quitting the app stops a phone sign-in still waiting on the phone', (tester) async {
    // Its CLI would otherwise wait on after the app has gone — minutes, holding the lock the next
    // sign-in needs, with its QR still good for anyone who scans it.
    final login = _HangingLogin();
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null, cliLogin: login)
      ..status = AppStatus.unauthenticated;
    unawaited(app.loginWithPhone());
    await tester.pumpWidget(_wholeApp(app));
    await tester.pump();
    expect(app.signingIn, isTrue);
    expect(app.pendingQrLink, isNotNull);

    final observer = tester.state(find.byType(RootShell)) as WidgetsBindingObserver;
    expect(await observer.didRequestAppExit(), AppExitResponse.exit);
    expect(login.cancels, 1);
    expect(app.signingIn, isFalse);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('quitting with no sign-in in flight stops nothing', (tester) async {
    // A signed-out app on its login screen quits as before: there is no CLI to stop.
    final login = _HangingLogin();
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null, cliLogin: login)
      ..status = AppStatus.unauthenticated;
    await tester.pumpWidget(_wholeApp(app));
    await tester.pump();
    final observer = tester.state(find.byType(RootShell)) as WidgetsBindingObserver;
    expect(await observer.didRequestAppExit(), AppExitResponse.exit);
    expect(login.cancels, 0);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets('a build that cannot sign in by phone does not offer it', (tester) async {
    grid.AppTheme.brightness.value = Brightness.light;
    final app = AppNotifier(config: AppConfig.dev, authSession: AuthSession(), configStore: null, cliLogin: _SsoOnly())
      ..status = AppStatus.unauthenticated;
    addTearDown(app.dispose);
    await tester.pumpWidget(_host(app));
    expect(find.byKey(const Key('login-scan-with-phone')), findsNothing);
  });
}

class _SsoOnly implements SignInClient {
  @override
  Future<CliAuthStatus> checkStatus() async => const CliAuthStatus(loggedIn: false);
  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
    SignInProvider? provider,
  }) async {}
  @override
  void cancel() {}
  @override
  Future<void> logout() async {}
}
