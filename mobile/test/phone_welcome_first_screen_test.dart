import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/phone/welcome/connect_code.dart';
import 'package:harness_mobile/phone/welcome/phone_welcome.dart';
import 'package:harness_mobile/phone/welcome/scan_to_connect.dart';
import 'package:harness_mobile/phone/welcome/set_up_computer.dart';
import 'package:harness_mobile/state/app_state.dart';

/// The first screen: Connect your computer — one button, Pair computer, that scans the code the
/// desktop app shows; Get it behind it for a computer with no Harness yet; and the other ways to sign
/// in behind the camera's "Can’t scan?".
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
  late List<String> scanned;
  Object? scanFails;
  Completer<void>? scanGate;

  setUp(() {
    notifier = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
    );
    sent = [];
    scanned = [];
    scanFails = null;
    scanGate = null;
  });
  tearDown(() => notifier.dispose());

  Future<void> pump(
    WidgetTester tester, {
    Widget? camera,
    Future<Object?> Function(BuildContext context)? onTrySample,
  }) async {
    // A phone's height, so the whole page is on screen.
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(430, 1400);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: PhoneWelcome(
          notifier: notifier,
          onTrySample: onTrySample,
          sendCode: (email) async => sent.add(email),
          signIn: (_, _) async {},
          signInWithScan: (code) async {
            scanned.add(code);
            await scanGate?.future;
            if (scanFails case final error?) throw error;
          },
          scanCamera: camera ?? const SizedBox(),
        ),
      ),
    );
    await tester.pump();
  }

  Future<void> pairComputer(WidgetTester tester) async {
    await tester.tap(find.byKey(const ValueKey('set-up-scan')));
    await tester.pump();
    expect(find.byType(ScanToConnectPage), findsOneWidget);
  }

  ScanToConnectPage camera(WidgetTester tester) =>
      tester.widget<ScanToConnectPage>(find.byType(ScanToConnectPage));

  Future<void> openOtherWays(WidgetTester tester) async {
    await tester.tap(find.text('Can’t scan? Sign in another way'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('welcome-other-ways-title')), findsOneWidget);
  }

  testWidgets('one button, how it works, Get it, and nothing else', (
    tester,
  ) async {
    await pump(tester, onTrySample: (_) async => null);
    expect(find.text('Connect your computer'), findsOneWidget);
    expect(find.text('Pair computer'), findsOneWidget);
    for (final line in [
      'Open Add Phone on your computer',
      kAddPhoneWhere,
      'Scan its code',
      'You’re connected',
    ]) {
      expect(find.text(line), findsOneWidget, reason: line);
    }
    expect(find.byKey(const ValueKey('set-up-get-it')), findsOneWidget);
    // The accounts are behind the camera's "Can’t scan?", and the sample behind Get it.
    expect(find.text('Continue with Google'), findsNothing);
    expect(find.text('Continue with email'), findsNothing);
    expect(find.byKey(const ValueKey('get-it-sample')), findsNothing);
    expect(find.text('Is Harness on your computer?'), findsNothing);
  });

  testWidgets(
    'Get it: the download page, sent to the computer, then back to Pair computer',
    (tester) async {
      String? shared;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        const MethodChannel('dev.fluttercommunity.plus/share'),
        (call) async {
          shared = (call.arguments as Map)['uri'] as String?;
          return 'dev.fluttercommunity.plus/share/dismissed';
        },
      );
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          const MethodChannel('dev.fluttercommunity.plus/share'),
          null,
        ),
      );
      await pump(tester);
      await tester.tap(find.byKey(const ValueKey('set-up-get-it')));
      await tester.pump();
      expect(find.byType(GetHarnessPage), findsOneWidget);
      expect(find.text('Get Harness on your computer'), findsOneWidget);
      expect(find.text('For Mac and Linux.'), findsOneWidget);
      expect(
        find.textContaining('harness.autonomous.ai/desktop'),
        findsOneWidget,
      );
      // No sample to offer, no link to it.
      expect(find.byKey(const ValueKey('get-it-sample')), findsNothing);

      // The page goes, not a file: the computer's browser picks its own download.
      await tester.tap(find.byKey(const ValueKey('get-it-send')));
      await tester.pump();
      await tester.pump();
      expect(shared, kDesktopDownloadUrl);
      expect(kDesktopDownloadUrl, 'https://harness.autonomous.ai/desktop');

      // Installed: the camera, and back from it is Get it, and back from that the first screen.
      await tester.tap(find.byKey(const ValueKey('get-it-pair')));
      await tester.pump();
      expect(find.byType(ScanToConnectPage), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('Back'));
      await tester.pump();
      expect(find.byType(GetHarnessPage), findsOneWidget);
      await tester.tap(find.bySemanticsLabel('Back'));
      await tester.pump();
      expect(find.text('Connect your computer'), findsOneWidget);
    },
  );

  testWidgets('a scanned code fills in the account and sends its code', (
    tester,
  ) async {
    await pump(tester);
    await pairComputer(tester);
    camera(
      tester,
    ).onCode(ConnectCode.parse(ConnectCode.link('ada@example.com'))!);
    await tester.pump();
    await tester.pump();
    expect(sent, ['ada@example.com']);
    expect(find.text('Check your email'), findsOneWidget);
    expect(find.textContaining('ada@example.com'), findsOneWidget);
  });

  testWidgets(
    'a code that carries a sign-in signs in by the scan: no email, no digits',
    (tester) async {
      scanGate = Completer<void>();
      await pump(tester);
      await pairComputer(tester);
      camera(tester).onCode(
        ConnectCode.parse(
          ConnectCode.link(
            'ada@example.com',
            machineId: 'mac',
            pairCode: 'K7QM4XPT9D2W',
            signIn: 'hnh_one',
          ),
        )!,
      );
      await tester.pump();
      expect(find.text('Signing in…'), findsOneWidget);
      // Not while the scan signs in: the other way would start a second.
      expect(
        tester
            .widget<TtyTextButton>(
              find.widgetWithText(
                TtyTextButton,
                'Can’t scan? Sign in another way',
              ),
            )
            .onPressed,
        isNull,
      );
      scanGate!.complete();
      await tester.pump();
      expect(scanned, ['hnh_one']);
      expect(sent, isEmpty);
      expect(find.text('Check your email'), findsNothing);
      expect(notifier.pendingPairing, (machineId: 'mac', code: 'K7QM4XPT9D2W'));
    },
  );

  testWidgets('an expired sign-in in the code falls back to the emailed code', (
    tester,
  ) async {
    scanFails = Exception('That code has expired. Scan the new one.');
    await pump(tester);
    await pairComputer(tester);
    camera(tester).onCode(
      ConnectCode.parse(
        ConnectCode.link('ada@example.com', signIn: 'hnh_old'),
      )!,
    );
    await tester.pump();
    await tester.pump();
    await tester.pump();
    expect(scanned, ['hnh_old']);
    expect(sent, ['ada@example.com']);
    expect(find.text('Check your email'), findsOneWidget);
  });

  testWidgets('can’t scan: the other ways, in a sheet over the camera', (
    tester,
  ) async {
    await pump(tester);
    await pairComputer(tester);
    await openOtherWays(tester);
    expect(find.text('Continue with Google'), findsOneWidget);
    expect(find.text('Continue with Apple'), findsOneWidget);
    await tester.tap(find.text('Continue with email'));
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('welcome-other-ways-title')), findsNothing);
    expect(find.text('Your email'), findsOneWidget);
    // Back from the email is the camera it was chosen over.
    await tester.binding.handlePopRoute();
    await tester.pumpAndSettle();
    expect(find.byType(ScanToConnectPage), findsOneWidget);
  });

  testWidgets('a code read under the sheet takes it down and signs in', (
    tester,
  ) async {
    await pump(tester);
    await pairComputer(tester);
    await openOtherWays(tester);
    // The camera runs on under the sheet.
    camera(tester).onCode(
      ConnectCode.parse(
        ConnectCode.link(
          'ada@example.com',
          machineId: 'mac',
          pairCode: 'K7QM4XPT9D2W',
          signIn: 'hnh_one',
        ),
      )!,
    );
    await tester.pumpAndSettle();
    expect(find.byKey(const ValueKey('welcome-other-ways-title')), findsNothing);
    expect(scanned, ['hnh_one']);
    expect(sent, isEmpty);
    expect(notifier.pendingPairing, (machineId: 'mac', code: 'K7QM4XPT9D2W'));
  });

  testWidgets(
    'a computer\'s own sign-in QR read under the sheet: the sheet goes, then sign in first',
    (tester) async {
      await pump(tester);
      await pairComputer(tester);
      await openOtherWays(tester);
      final code = 'hnq_${'a' * 43}';
      camera(tester).onSignInCode!(SignInCode(code));
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('welcome-other-ways-title')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('welcome-sign-in-first')),
        findsOneWidget,
      );
      expect(notifier.pendingComputerSignIn, code);
      // Back is the camera, and the computer's code is let go there.
      await tester.binding.handlePopRoute();
      await tester.pumpAndSettle();
      expect(find.byType(ScanToConnectPage), findsOneWidget);
      expect(notifier.pendingComputerSignIn, isNull);
    },
  );

  testWidgets('the sample, from Get it, comes back to Get it', (tester) async {
    var samples = 0;
    await pump(
      tester,
      onTrySample: (_) async {
        samples++;
        return 'set-up';
      },
    );
    await tester.tap(find.byKey(const ValueKey('set-up-get-it')));
    await tester.pump();
    await tester.tap(find.byKey(const ValueKey('get-it-sample')));
    await tester.pump();
    await tester.pump();
    expect(samples, 1);
    expect(find.byType(GetHarnessPage), findsOneWidget);
  });
}
