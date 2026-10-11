import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/setup_tour.dart';
import 'package:harness/widgets/sign_in_step.dart';

import 'support/capture.dart';

/// The sign-in step as a computer new to Harness sees it after setup: one
/// headline, four lines, two buttons, and Skip and Continue with email under
/// them. The page takes callbacks and flags, so no app, CLI or browser is
/// involved. `HARNESS_SIGN_IN_CAPTURE_DIR` writes what it draws.
final _skip = find.byKey(const Key('sign-in-step-skip'));
final _email = find.byKey(const Key('sign-in-step-email'));
final _google = find.byKey(const Key('login-continue-google'));
final _apple = find.byKey(const Key('login-continue-apple'));
final _boundary = GlobalKey();

Future<void> _mount(
  WidgetTester tester, {
  ValueChanged<SignInProvider?>? onSignIn,
  VoidCallback? onSkip,
  bool starting = false,
  SignInProvider? startingProvider,
  bool finishing = false,
  String? error,
  Size size = const Size(1280, 800),
  Brightness brightness = Brightness.dark,
  double textScale = 1,
}) async {
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
          onSkip: onSkip ?? () {},
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

void main() {
  setUpAll(
    () => loadCaptureFonts(Platform.environment['HARNESS_SIGN_IN_CAPTURE_DIR']),
  );

  testWidgets('one headline, four lines, two buttons, Skip and email', (
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
    expect(find.text('Skip'), findsOneWidget);
    expect(find.text('Continue with email'), findsOneWidget);
    // It follows the tour: the same tagline, and the install line finished.
    expect(find.text(tourTagline), findsOneWidget);
    expect(find.text('Harness is ready.'), findsOneWidget);
    // Nothing the sign-in sheet carries beside its buttons is on this page.
    for (final absent in const [
      'Scan with your phone',
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

  testWidgets('each control reports itself; Return is Continue with Google', (
    tester,
  ) async {
    final pressed = <SignInProvider?>[];
    var skipped = 0;
    await _mount(tester, onSignIn: pressed.add, onSkip: () => skipped++);

    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pump();
    expect(pressed, [SignInProvider.google]);

    await tester.tap(_apple);
    await tester.tap(_google);
    // No provider is the sign-in page's own chooser, which takes an email.
    await tester.tap(_email);
    expect(pressed, [
      SignInProvider.google,
      SignInProvider.apple,
      SignInProvider.google,
      null,
    ]);
    expect(skipped, 0);
    await tester.tap(_skip);
    expect(skipped, 1);
  });

  testWidgets(
    'Skip starts where the buttons start, email ends where they end',
    (tester) async {
      for (final size in const [Size(1280, 800), Size(880, 560)]) {
        await _mount(tester, size: size);
        final button = tester.getRect(_google);
        expect(tester.getRect(_apple).left, button.left);
        expect(tester.getRect(_apple).right, button.right);
        expect(
          tester.getRect(find.text('Skip')).left,
          moreOrLessEquals(button.left, epsilon: 0.5),
          reason: '$size',
        );
        expect(
          tester.getRect(find.text('Continue with email')).right,
          moreOrLessEquals(button.right, epsilon: 0.5),
          reason: '$size',
        );
        // Under the card, not in it.
        expect(
          tester.getRect(find.text('Skip')).top,
          greaterThan(tester.getRect(_apple).bottom + 20),
        );
      }
    },
  );

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
    expect(find.text('Harness is ready.'), findsNothing);

    await _mount(tester, error: 'The sign-in page could not be reached.');
    expect(find.text('The sign-in page could not be reached.'), findsOneWidget);
    expect(find.text('Harness is ready.'), findsOneWidget);
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
        expect(find.text('Skip'), findsOneWidget);
        if (scale == 1.0) {
          await _capture(
            tester,
            'sign-in-step-${brightness.name}-${size.width.round()}',
          );
        }
      });
    }
  }
}
