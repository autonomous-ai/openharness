import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/auth/phone_sign_in.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/core/config.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/setup_tour.dart';
import 'package:harness/widgets/sign_in_step.dart';

import 'support/capture.dart';

/// The sign-in step as a computer new to Harness sees it after setup: one
/// headline, four lines, and five ways in — Google, Apple, the browser page's
/// email/GitHub/passkey, then a phone's scan and a code another device approves. The page takes callbacks and flags, so no app, CLI or browser is
/// involved. `HARNESS_SIGN_IN_CAPTURE_DIR` writes what it draws.
final _email = find.byKey(const Key('sign-in-step-email'));
final _google = find.byKey(const Key('login-continue-google'));
final _apple = find.byKey(const Key('login-continue-apple'));
final _scan = find.byKey(const Key('sign-in-step-scan'));
final _code = find.byKey(const Key('sign-in-step-code'));
final _boundary = GlobalKey();

Future<void> _mount(
  WidgetTester tester, {
  ValueChanged<SignInProvider?>? onSignIn,
  ValueChanged<ApprovalSignIn>? onApprove,
  bool offerApproval = true,
  Widget? approval,
  bool starting = false,
  SignInProvider? startingProvider,
  bool finishing = false,
  String? error,
  Size size = const Size(1280, 800),
  Brightness brightness = Brightness.dark,
  double textScale = 1,
}) async {
  final previousBrightness = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previousBrightness);
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      debugShowCheckedModeBanner: false,
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: RepaintBoundary(
        key: _boundary,
        child: SignInStep(
          onSignIn: onSignIn ?? (_) {},
          onApprove: offerApproval ? (onApprove ?? (_) {}) : null,
          approval: approval,
          starting: starting,
          startingProvider: startingProvider,
          finishing: finishing,
          error: error,
        ),
      ),
    ),
  );
  await tester.pump();
}

Future<void> _capture(WidgetTester tester, String name) => captureBoundary(
  tester,
  _boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary,
  Platform.environment['HARNESS_SIGN_IN_CAPTURE_DIR'],
  name,
);

/// The CLI's sign-in as the page drives it: which way in was asked for, and a code sign-in a test
/// approves from "another device".
class _Cli extends CliLogin {
  final browser = <SignInProvider?>[];
  void Function(String code, int expiresIn)? showCode;
  Future<bool> Function(String email)? confirm;
  final codeDone = Completer<void>();
  var cancels = 0;

  @override
  Future<void> login({
    required void Function(String url) onAuthorizeUrl,
    SignInProvider? provider,
  }) async {
    browser.add(provider);
    await Completer<void>().future;
  }

  @override
  Future<void> loginWithCode({
    required void Function(String code, int expiresIn) onCode,
    required Future<bool> Function(String email) onConfirm,
  }) async {
    showCode = onCode;
    confirm = onConfirm;
    await codeDone.future;
  }

  @override
  void cancel() => cancels++;
}

void main() {
  setUpAll(
    () => loadCaptureFonts(Platform.environment['HARNESS_SIGN_IN_CAPTURE_DIR']),
  );

  testWidgets('one headline, four lines, and every way in; no Skip', (
    tester,
  ) async {
    await _mount(tester);
    expect(find.text(signInStepTitle), findsOneWidget);
    for (final line in const [
      'All your machines, one window',
      'Your agents on your phone',
      'Harness in any browser',
      'Same tabs on every computer',
    ]) {
      expect(find.text(line), findsOneWidget);
    }
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.text('Continue with Apple'), findsOneWidget);
    // Named for what it opens, as a button, not small print.
    expect(find.text('Email, GitHub or passkey'), findsOneWidget);
    expect(find.text('Continue with email'), findsNothing);
    expect(
      find.ancestor(
        of: find.text('Email, GitHub or passkey'),
        matching: find.byType(FilledButton),
      ),
      findsOneWidget,
    );
    // A new or remote computer's ways in that need no browser here.
    expect(find.text('Scan with your phone'), findsOneWidget);
    expect(find.text('Sign in on another device'), findsOneWidget);
    expect(find.text('OR'), findsOneWidget);
    expect(find.text('Skip'), findsNothing);
    // It follows the tour: the same tagline, and the install line finished.
    expect(find.text(tourTagline), findsOneWidget);
    expect(find.text('Sign in to continue.'), findsOneWidget);
    for (final absent in const [
      'End-to-end encrypted',
      'Sign in through your browser to continue.',
      'Cancel',
      'Open browser',
      'Copy link',
    ]) {
      expect(find.text(absent), findsNothing, reason: absent);
    }
    await _capture(tester, 'sign-in-step-dark');
  });

  testWidgets('a sign-in client that cannot be approved from elsewhere offers '
      'the browser alone', (tester) async {
    await _mount(tester, offerApproval: false);
    expect(_scan, findsNothing);
    expect(_code, findsNothing);
    expect(find.text('OR'), findsNothing);
    expect(_email, findsOneWidget);
  });

  testWidgets('each control reports itself; Return is Continue with Google', (
    tester,
  ) async {
    final pressed = <SignInProvider?>[];
    final approvals = <ApprovalSignIn>[];
    await _mount(tester, onSignIn: pressed.add, onApprove: approvals.add);

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(pressed, [SignInProvider.google]);

    await tester.tap(_apple);
    await tester.tap(_google);
    // No provider is the sign-in page's own chooser: email, GitHub, passkey.
    await tester.tap(_email);
    expect(pressed, [
      SignInProvider.google,
      SignInProvider.apple,
      SignInProvider.google,
      null,
    ]);
    await tester.tap(_scan);
    await tester.tap(_code);
    expect(approvals, [ApprovalSignIn.phone, ApprovalSignIn.code]);
    expect(pressed, hasLength(4));
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    expect(find.byType(SignInStep), findsOneWidget);
  });

  testWidgets('the five ways in are one width, accounts first, the others '
      'after OR', (tester) async {
    for (final size in const [Size(1280, 800), Size(880, 560)]) {
      await _mount(tester, size: size);
      final google = tester.getRect(_google);
      for (final other in [_apple, _email, _scan, _code]) {
        expect(tester.getRect(other).left, google.left, reason: '$size');
        expect(tester.getRect(other).right, google.right, reason: '$size');
      }
      expect(tester.getRect(_apple).top, greaterThan(google.bottom));
      expect(
        tester.getRect(_email).top,
        greaterThan(tester.getRect(_apple).bottom),
      );
      final or = tester.getRect(find.text('OR'));
      expect(or.top, greaterThan(tester.getRect(_email).bottom));
      expect(tester.getRect(_scan).top, greaterThan(or.bottom));
      expect(
        tester.getRect(_code).top,
        greaterThan(tester.getRect(_scan).bottom),
      );
    }
  });

  testWidgets('a phone scan or a code under way takes the ways in\'s place', (
    tester,
  ) async {
    await _mount(
      tester,
      approval: const SizedBox(key: Key('approval-under-way')),
    );
    expect(find.byKey(const Key('approval-under-way')), findsOneWidget);
    expect(_google, findsNothing);
    expect(_email, findsNothing);
    expect(_scan, findsNothing);
    // The rest of the page stays.
    expect(find.text(signInStepTitle), findsOneWidget);
  });

  testWidgets('nothing changes while the browser is open, and every way in '
      'stays live', (tester) async {
    final pressed = <SignInProvider?>[];
    await _mount(
      tester,
      onSignIn: pressed.add,
      starting: true,
      startingProvider: SignInProvider.google,
    );
    // The pressed button keeps its words; it only steps back until its
    // browser opens.
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.textContaining('Waiting'), findsNothing);
    double opacity(Finder control) => tester
        .widget<AnimatedOpacity>(
          find.ancestor(of: control, matching: find.byType(AnimatedOpacity)),
        )
        .opacity;
    expect(opacity(_google), lessThan(1));
    expect(opacity(_apple), 1);
    expect(opacity(_email), 1);

    await tester.tap(_google);
    await tester.tap(_apple);
    await tester.tap(_email);
    expect(pressed, [SignInProvider.google, SignInProvider.apple, null]);

    // Email pressed: it is the one that steps back.
    await _mount(tester, starting: true);
    expect(opacity(_email), lessThan(1));
    expect(opacity(_google), 1);
  });

  testWidgets('says it is signing in once the browser has approved, and why '
      'a sign-in failed', (tester) async {
    await _mount(tester, finishing: true);
    expect(find.text('Signing in…'), findsOneWidget);
    expect(find.text('Sign in to continue.'), findsNothing);

    await _mount(tester, error: 'The sign-in page could not be reached.');
    expect(find.text('The sign-in page could not be reached.'), findsOneWidget);
    expect(find.text('Sign in to continue.'), findsOneWidget);
  });

  testWidgets('on the app: the email button opens the browser sign-in page, '
      'and a code approved elsewhere gets as far as whose account', (
    tester,
  ) async {
    final cli = _Cli();
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      cliLogin: cli,
    )..status = AppStatus.authenticated;
    addTearDown(app.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 800);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SignInStepScreen(app: app),
      ),
    );

    // The browser page with no account named: its own chooser, where email, GitHub and passkey are.
    await tester.tap(_email);
    await tester.pump();
    expect(cli.browser, [null]);

    // Another way in ends that one and shows its code where the buttons were.
    await tester.tap(_code);
    await tester.pump();
    expect(cli.cancels, 1);
    expect(find.text('Getting a code…'), findsOneWidget);
    cli.showCode!('12345678', 120);
    await tester.pump();
    expect(find.text('1234 5678'), findsOneWidget);
    expect(find.textContaining('New code in 9:'), findsOneWidget);
    expect(_google, findsNothing);

    // Approved on another device (faked): the person here is asked whose account.
    final answer = cli.confirm!('dee@example.com');
    await tester.pump();
    expect(find.text('Sign in as dee@example.com?'), findsOneWidget);
    await tester.tap(find.byKey(const Key('login-phone-continue')));
    await tester.pump();
    expect(await answer, isTrue);
    expect(find.text('Signing in…'), findsWidgets);
    expect(find.text('1234 5678'), findsNothing);

    // Cancel goes back to the ways in, with nothing left on screen.
    await tester.tap(find.byKey(const Key('approval-sign-in-cancel')));
    await tester.pump();
    expect(_google, findsOneWidget);
    expect(find.text('1234 5678'), findsNothing);
    expect(app.signingIn, isFalse);
    await tester.pumpWidget(const SizedBox());
  });

  for (final brightness in Brightness.values) {
    for (final (size, scale) in const [
      (Size(1280, 800), 1.0),
      (Size(880, 560), 1.0),
      (Size(880, 560), 1.6),
      (Size(880, 560), 2.0),
      (Size(1920, 1200), 1.0),
    ]) {
      testWidgets('draws in ${brightness.name} at ${size.width.round()}×'
          '${size.height.round()}, text ${scale}x, without overflow', (
        tester,
      ) async {
        await _mount(
          tester,
          size: size,
          brightness: brightness,
          textScale: scale,
          error: 'The sign-in page could not be reached.',
        );
        expect(tester.takeException(), isNull);
        expect(find.text('Skip'), findsNothing);
        expect(_email, findsOneWidget);
        await _capture(
          tester,
          'sign-in-step-${brightness.name}-${size.width.round()}'
          '${scale == 1.0 ? '' : '-text-${(scale * 100).round()}'}',
        );
      });
    }
  }
}
