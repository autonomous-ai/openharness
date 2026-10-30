import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/auth/sign_in_provider.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/phone/welcome/connect_code.dart';
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';
import 'package:harness_mobile/phone/welcome/onboarding_picture.dart';
import 'package:harness_mobile/phone/welcome/phone_welcome.dart';
import 'package:harness_mobile/phone/welcome/scan_to_connect.dart';
import 'package:harness_mobile/phone/welcome/set_up_computer.dart';
import 'package:harness_mobile/phone/welcome/your_computer.dart';
import 'package:harness_mobile/phone/welcome/sign_in_provider_button.dart';
import 'package:harness_mobile/state/app_state.dart';

/// The first screen: ① Welcome — the promise, the two accounts, and under them one quiet line:
/// Continue with email · QR code (owner, 2026-10-14; it was Scan QR code first, then the two
/// accounts, on 2026-10-12, `docs/research/2026-10-11-phone-onboarding`).
void main() {
  group('ConnectCode', () {
    test('reads the desktop app\'s link, all of it in the fragment', () {
      final code = ConnectCode.parse(
        ConnectCode.link('ada@example.com', machineId: 'm1', pairCode: 'K7QM'),
      )!;
      expect(code.email, 'ada@example.com');
      expect(code.machineId, 'm1');
      expect(code.pairCode, 'K7QM');
      expect(code.signIn, isNull);
      final signedIn = ConnectCode.parse(
        ConnectCode.link(
          'ada@example.com',
          pairCode: 'K7QM',
          signIn: 'hnh_x-_Y',
        ),
      )!;
      expect(signedIn.signIn, 'hnh_x-_Y');
      // Nothing secret where a browser would send it.
      expect(
        Uri.parse(ConnectCode.link('a@b.co', pairCode: 'K7QM')).query,
        isEmpty,
      );
    });

    test('ignores codes that are not ours', () {
      expect(ConnectCode.parse('https://example.com/pair#e=a@b.co'), isNull);
      expect(
        ConnectCode.parse('http://harness.autonomous.ai/pair#e=a@b.co'),
        isNull,
      );
      expect(
        ConnectCode.parse('https://harness.autonomous.ai/pair#m=m1'),
        isNull,
      );
      expect(ConnectCode.parse('not a link'), isNull);
    });
  });

  late AppNotifier notifier;
  late List<String> sent;
  late List<(String, String)> signedIn;

  setUp(() {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    sent = [];
    signedIn = [];
  });
  tearDown(() => notifier.dispose());

  /// The welcome as the app mounts it: rebuilt whenever the notifier moves (`RootShell`).
  Future<void> pump(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(430, 932);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: ListenableBuilder(
          listenable: notifier,
          builder: (_, _) => PhoneWelcome(
            notifier: notifier,
            sendCode: (email) async => sent.add(email),
            signIn: (email, code) async => signedIn.add((email, code)),
            scanCamera: const SizedBox.expand(),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  Rect picture(WidgetTester tester) =>
      tester.getRect(find.byType(OnboardingPicture));

  final email = find.byKey(const ValueKey('welcome-continue-email'));
  final scan = find.byKey(const ValueKey('welcome-scan'));

  SignInProviderButton account(WidgetTester tester, SignInProvider provider) =>
      tester
          .widgetList<SignInProviderButton>(find.byType(SignInProviderButton))
          .firstWhere((button) => button.provider == provider);

  testWidgets(
    'the promise, the two accounts, then Continue with email · QR code — and nothing else',
    (tester) async {
      await pump(tester);
      expect(find.text(OnboardingCopy.welcome), findsOneWidget);
      expect(
        tester.widget<OnboardingPicture>(find.byType(OnboardingPicture)).scene,
        OnboardingScene.welcome,
      );
      expect(find.text('Continue with Google'), findsOneWidget);
      expect(find.text('Continue with Apple'), findsOneWidget);
      expect(find.text(OnboardingCopy.continueWithEmail), findsOneWidget);
      expect(find.text(OnboardingCopy.qrCode), findsOneWidget);
      // The camera's long name is what a screen reader hears, not what the line says.
      expect(find.text(OnboardingCopy.scanQrCode), findsNothing);
      // Only the accounts are buttons; the lesser ways in are words.
      expect(find.byType(TtyPrimaryButton), findsNothing);
      // Google, then Apple, then the quiet line — email and QR code side by side on it.
      expect(
        tester.getTopLeft(find.text('Continue with Google')).dy,
        lessThan(tester.getTopLeft(find.text('Continue with Apple')).dy),
      );
      expect(
        tester.getTopLeft(find.text('Continue with Apple')).dy,
        lessThan(tester.getTopLeft(email).dy),
      );
      expect(tester.getCenter(email).dy, tester.getCenter(scan).dy);
      expect(
        tester.getCenter(email).dx,
        lessThan(tester.getCenter(scan).dx),
      );

      // Not the camera, the sample, or the steps on the computer of the first screen before it.
      expect(find.byType(ScanToConnectPage), findsNothing);
      expect(find.text('Connect computer'), findsNothing);
      expect(find.text('Can’t scan? Sign in another way'), findsNothing);
      expect(find.text('Try the sample while you wait'), findsNothing);
      expect(find.text('Your agents\nin your pocket.'), findsNothing);
    },
  );

  testWidgets(
    'an account\'s page up: its button says so, and Cancel takes the quiet line',
    (tester) async {
      await pump(tester);
      final before = picture(tester);

      notifier
        ..signingIn = true
        ..signInProvider = SignInProvider.google
        ..status = AppStatus.unauthenticated;
      notifier.notifyListeners();
      await tester.pump();
      expect(find.text('Waiting for Google…'), findsOneWidget);
      // Cancel takes the quiet line's place: email and the camera could not be pressed now.
      expect(find.byKey(const ValueKey('welcome-cancel')), findsOneWidget);
      expect(email, findsNothing);
      expect(scan, findsNothing);
      // The other account waits it out.
      expect(account(tester, SignInProvider.apple).onPressed, isNull);
      // The foot is the same height whatever it says: the picture has not moved.
      expect(picture(tester), before);

      // Past the page, going in: nothing left to cancel; the quiet line is back, and neither an
      // email nor a scan can sign in behind it.
      notifier.status = AppStatus.bootstrapping;
      notifier.notifyListeners();
      await tester.pump();
      expect(find.text('Signing in…'), findsOneWidget);
      expect(find.byKey(const ValueKey('welcome-cancel')), findsNothing);
      await tester.tap(scan);
      await tester.pump();
      expect(find.byType(ScanToConnectPage), findsNothing);
      await tester.tap(email);
      await tester.pump();
      expect(find.text('Your email'), findsNothing);
      expect(picture(tester), before);
    },
  );

  final headline = find.byKey(const ValueKey('welcome-headline'));

  /// Past the headline's 250ms swap: the words going out are gone, the ones coming in in place.
  Future<void> settle(WidgetTester tester) async {
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 300));
  }

  /// [notifier] as one whose accounts' pages are [provider], not the real sign-in.
  void stubAccounts(Future<void> Function(SignInProvider) provider) {
    notifier.dispose();
    notifier = _StubAccounts(provider);
  }

  testWidgets('why the phone was signed out takes the headline\'s place', (
    tester,
  ) async {
    await pump(tester);
    final before = picture(tester);
    final words = tester.getRect(headline);
    notifier.signedOutReason = 'You were signed out on another device.';
    notifier.notifyListeners();
    await settle(tester);
    final said = find.byKey(const ValueKey('welcome-signed-out'));
    expect(said, findsOneWidget);
    expect(
      find.textContaining('You were signed out on another device.'),
      findsOneWidget,
    );
    // The headline gone, the reason where it was, on its left edge; the picture still.
    expect(find.text(OnboardingCopy.welcome), findsNothing);
    expect(tester.getRect(said).topLeft, words.topLeft);
    expect(picture(tester), before);
  });

  // Each way in lets the reason go, and the headline comes back — on the welcome, or on the way
  // back to it.
  for (final way in [
    'Continue with Google',
    'Continue with Apple',
    OnboardingCopy.continueWithEmail,
    OnboardingCopy.qrCode,
  ]) {
    testWidgets('$way pressed: the reason goes, the headline is back', (
      tester,
    ) async {
      final pages = <SignInProvider>[];
      stubAccounts((provider) async => pages.add(provider));
      notifier.signedOutReason = 'You were signed out on another device.';
      await pump(tester);
      final before = picture(tester);
      expect(find.text(OnboardingCopy.welcome), findsNothing);

      await tester.tap(find.text(way));
      await settle(tester);
      if (way == OnboardingCopy.continueWithEmail) {
        expect(find.text('Your email'), findsOneWidget);
      } else if (way == OnboardingCopy.qrCode) {
        expect(find.byType(ScanToConnectPage), findsOneWidget);
      } else {
        expect(pages, hasLength(1));
      }
      if (find.text(OnboardingCopy.welcome).evaluate().isEmpty) {
        await tester.binding.handlePopRoute();
        await settle(tester);
      }

      expect(find.text(OnboardingCopy.welcome), findsOneWidget);
      expect(find.byKey(const ValueKey('welcome-signed-out')), findsNothing);
      expect(picture(tester), before);
    });
  }

  testWidgets(
    'a sign-in that fails says why in the headline\'s place, until the next way in',
    (tester) async {
      stubAccounts(
        (_) async => throw Exception(
          'Could not open the sign-in page. Check your connection and try again.',
        ),
      );
      await pump(tester);
      final before = picture(tester);
      final words = tester.getRect(headline);

      await tester.tap(find.text('Continue with Google'));
      await settle(tester);
      final said = find.byKey(const ValueKey('welcome-error'));
      expect(said, findsOneWidget);
      expect(
        find.textContaining('Could not open the sign-in page.'),
        findsOneWidget,
      );
      expect(find.text(OnboardingCopy.welcome), findsNothing);
      expect(tester.getRect(said).topLeft, words.topLeft);
      expect(picture(tester), before);

      // The email, and back: the failure was the account's, and is gone with it.
      await tester.tap(email);
      await settle(tester);
      expect(find.text('Your email'), findsOneWidget);
      await tester.binding.handlePopRoute();
      await settle(tester);
      expect(find.text(OnboardingCopy.welcome), findsOneWidget);
      expect(said, findsNothing);

      // Failing again says so again, in the same place.
      await tester.tap(find.text('Continue with Apple'));
      await settle(tester);
      expect(said, findsOneWidget);
      expect(find.text(OnboardingCopy.welcome), findsNothing);
    },
  );

  testWidgets(
    'a computer\'s own sign-in code read first: what to do next, in the headline\'s place',
    (tester) async {
      stubAccounts((_) async {});
      await pump(tester);
      await tester.tap(scan);
      await settle(tester);
      tester
          .widget<ScanToConnectPage>(find.byType(ScanToConnectPage))
          .onSignInCode!(const SignInCode('hnq_computer'));
      await settle(tester);
      expect(notifier.pendingComputerSignIn, 'hnq_computer');
      expect(find.byKey(const ValueKey('welcome-notice')), findsOneWidget);
      expect(find.textContaining(OnboardingCopy.signInFirst), findsOneWidget);
      expect(find.text(OnboardingCopy.welcome), findsNothing);

      // An account pressed lets it go; the code is still held for after the sign-in.
      await tester.tap(find.text('Continue with Google'));
      await settle(tester);
      expect(find.byKey(const ValueKey('welcome-notice')), findsNothing);
      expect(find.text(OnboardingCopy.welcome), findsOneWidget);
      expect(notifier.pendingComputerSignIn, 'hnq_computer');
    },
  );

  testWidgets('QR code: the camera, with no "Use email instead" — back is the way out', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(scan);
    await tester.pump();
    expect(find.byType(ScanToConnectPage), findsOneWidget);
    // Continue with email is beside QR code on the welcome, one back away (owner, 2026-10-14).
    expect(find.text('Use email instead'), findsNothing);

    // Under the camera, how the code comes up on the computer (owner, 2026-10-14): Harness from
    // ②'s address, signed in, then Add Phone — in that order.
    expect(find.text('How to get the QR code'), findsOneWidget);
    final steps = [
      find.text(OnboardingCopy.goToHeadline),
      find.text('Sign in'),
      find.text('Click "Add Phone"'),
    ];
    for (final step in steps) {
      expect(step, findsOneWidget);
    }
    for (var i = 1; i < steps.length; i++) {
      expect(
        tester.getTopLeft(steps[i - 1]).dy,
        lessThan(tester.getTopLeft(steps[i]).dy),
      );
    }
    // The first step is ②'s words (owner, 2026-10-15): "On your computer, go to", the address,
    // then "Download and install Harness" — all above the sign-in. The address is words in the
    // step, not ②'s green button, which outweighed the camera.
    final address = find.byKey(const ValueKey('go-address'));
    final install = find.text(OnboardingCopy.installStep);
    expect(address, findsOneWidget);
    expect(install, findsOneWidget);
    expect(
      tester.widget<GoAddressButton>(find.byType(GoAddressButton)).inline,
      isTrue,
    );
    expect(
      find.descendant(
        of: address,
        matching: find.text(OnboardingCopy.goAddress),
      ),
      findsOneWidget,
    );
    expect(
      tester.getBottomLeft(steps[0]).dy,
      lessThanOrEqualTo(tester.getTopLeft(address).dy),
    );
    expect(
      tester.getBottomLeft(address).dy,
      lessThanOrEqualTo(tester.getTopLeft(install).dy),
    );
    expect(
      tester.getBottomLeft(install).dy,
      lessThanOrEqualTo(tester.getTopLeft(steps[1]).dy),
    );
    // Indented with the step's words, not out at the ring.
    expect(tester.getTopLeft(address).dx, tester.getTopLeft(steps[0]).dx);
    expect(find.text('Go to autonomous.ai/go'), findsNothing);
    expect(find.text('Download and install on your computer'), findsNothing);
    expect(find.text(kAddPhoneWhere), findsOneWidget);
    // Signed out, there is no account for the sign-in to name.
    expect(find.textContaining('Use '), findsNothing);

    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.text(OnboardingCopy.welcome), findsOneWidget);
    expect(email, findsOneWidget);
  });

  testWidgets(
    'QR code: the address under the camera\'s first step sends the link',
    (tester) async {
      final shared = <String?>[];
      final messenger =
          TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
      const share = MethodChannel('dev.fluttercommunity.plus/share');
      messenger.setMockMethodCallHandler(share, (call) async {
        shared.add((call.arguments as Map)['uri'] as String?);
        return 'dev.fluttercommunity.plus/share/dismissed';
      });
      addTearDown(() => messenger.setMockMethodCallHandler(share, null));

      await pump(tester);
      await tester.tap(scan);
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('go-address')));
      await tester.pump();
      expect(shared, [OnboardingCopy.goUrl]);
    },
  );

  test('the camera\'s first step is ②\'s headline and install step', () {
    final first = computerSteps(null).first;
    expect(first.title, OnboardingCopy.goToHeadline);
    expect(first.note, OnboardingCopy.installStep);
    // The step says the link is the download (owner, 2026-10-19).
    expect(first.note, 'Download and install Harness');
    expect(first.note, goToSteps(null).first.title);
  });

  testWidgets('StepsTimeline: the link stands under the first title, over its note', (
    tester,
  ) async {
    const steps = <ComputerStep>[
      (title: 'First', note: 'First note'),
      (title: 'Second', note: 'Second note'),
    ];
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(
          body: StepsTimeline(
            steps: steps,
            link: SizedBox(key: ValueKey('link'), height: 40),
          ),
        ),
      ),
    );
    final link = find.byKey(const ValueKey('link'));
    expect(link, findsOneWidget);
    expect(
      tester.getBottomLeft(find.text('First')).dy,
      lessThanOrEqualTo(tester.getTopLeft(link).dy),
    );
    expect(
      tester.getBottomLeft(link).dy,
      lessThanOrEqualTo(tester.getTopLeft(find.text('First note')).dy),
    );
    expect(
      tester.getTopLeft(find.text('Second')).dy,
      greaterThan(tester.getBottomLeft(find.text('First note')).dy),
    );

    // With none, nothing stands between a title and its note.
    await tester.pumpWidget(
      const MaterialApp(
        home: Scaffold(body: StepsTimeline(steps: steps)),
      ),
    );
    expect(link, findsNothing);
  });

  test('the camera\'s sign-in step names the account, when there is one', () {
    final signedIn = computerSteps('ada@example.com');
    expect(signedIn.map((s) => s.title), [
      OnboardingCopy.goToHeadline,
      'Sign in',
      'Click "Add Phone"',
    ]);
    expect(signedIn[1].note, 'Use ada@example.com');
    // ②'s sign-in step, word for word.
    expect(signedIn[1], goToSteps('ada@example.com')[1]);
    expect(computerSteps(null)[1].note, isNull);
  });

  testWidgets('the emailed code: the address, then the four digits, and back', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(email);
    await tester.pump();
    expect(find.text('Your email'), findsOneWidget);

    await tester.enterText(find.byType(TextField), 'ada@example.com');
    await tester.tap(find.text('Send code'));
    await tester.pump();
    await tester.pump();
    expect(sent, ['ada@example.com']);
    expect(find.text('Check your email'), findsOneWidget);
    expect(find.textContaining('ada@example.com'), findsOneWidget);

    // The last digit signs in by itself.
    await tester.enterText(find.byType(TextField), '4242');
    await tester.pump();
    await tester.pump();
    expect(signedIn, [('ada@example.com', '4242')]);

    // Back from the code is the email, and back from that the welcome.
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.text('Your email'), findsOneWidget);
    await tester.binding.handlePopRoute();
    await tester.pump();
    expect(find.text(OnboardingCopy.welcome), findsOneWidget);

    // The resend clock runs out before the test ends.
    await tester.pump(const Duration(seconds: 31));
  });
}

/// The app's notifier, its accounts' pages stubbed: [provider] stands in for the real sign-in.
class _StubAccounts extends AppNotifier {
  _StubAccounts(this.provider)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final Future<void> Function(SignInProvider) provider;

  @override
  Future<void> signInWithProvider(SignInProvider provider) =>
      this.provider(provider);
}
