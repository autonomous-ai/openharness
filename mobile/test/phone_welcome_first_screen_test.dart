import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/phone/welcome/connect_code.dart';
import 'package:harness_mobile/phone/welcome/phone_welcome.dart';
import 'package:harness_mobile/phone/welcome/scan_to_connect.dart';
import 'package:harness_mobile/phone/welcome/set_up_computer.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'viewer/fake_http.dart';

/// The first screen: what Harness is, one question, and its two answers — scan the code the
/// desktop app shows, or get Harness onto the computer.
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

  Future<void> pump(WidgetTester tester, {Widget? camera}) async {
    await tester.pumpWidget(
      MaterialApp(
        home: PhoneWelcome(
          notifier: notifier,
          sendCode: (email) async => sent.add(email),
          signIn: (_, _) async {},
          signInWithScan: (code) async {
            scanned.add(code);
            await scanGate?.future;
            if (scanFails case final error?) throw error;
          },
          scanCamera: camera ?? const SizedBox(),
          loadDownloads: () async => const {},
        ),
      ),
    );
    await tester.pump();
  }

  testWidgets('one question, two answers, and nothing else', (tester) async {
    await pump(tester);
    expect(find.text('Is Harness on your computer?'), findsOneWidget);
    expect(find.text('Yes — scan to connect'), findsOneWidget);
    expect(find.text('Not yet — set it up'), findsOneWidget);
    expect(find.text('Continue with email'), findsNothing);
    expect(find.text('Try it first'), findsNothing);
  });

  testWidgets(
    'not yet: the website\'s download menu, each row sent to the computer',
    (tester) async {
      // A phone's height, so the whole page is on screen.
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(430, 1400);
      addTearDown(tester.view.reset);
      await pump(tester);
      await tester.tap(find.text('Not yet — set it up'));
      await tester.pump();
      expect(find.byType(SetUpComputerPage), findsOneWidget);
      for (final row in [
        'Apple Silicon',
        'Intel',
        'Intel/AMD · Ubuntu, Omarchy and more',
        'ARM · Raspberry Pi, ARM servers',
        'curl -fsSL …/install.sh | bash',
      ]) {
        expect(find.text(row), findsOneWidget, reason: row);
      }
      expect(find.text('macOS'), findsNWidgets(2));
      expect(find.text('Linux'), findsNWidgets(2));
      expect(
        find.textContaining('harness.autonomous.ai/desktop'),
        findsOneWidget,
      );

      // The CLI row copies the website's command, and says so.
      String? copied;
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        SystemChannels.platform,
        (call) async {
          if (call.method == 'Clipboard.setData') {
            copied = (call.arguments as Map)['text'] as String?;
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
      await tester.tap(find.text('curl -fsSL …/install.sh | bash'));
      await tester.pump();
      expect(copied, kCliInstall);
      expect(
        kCliInstall,
        'curl -fsSL https://harness.autonomous.ai/cli/install.sh | bash',
      );
      expect(find.text('copied'), findsOneWidget);
      await tester.pump(const Duration(seconds: 2));
      expect(find.text('copied'), findsNothing);

      // Back is the first screen.
      await tester.tap(find.bySemanticsLabel('Back'));
      await tester.pump();
      expect(find.text('Is Harness on your computer?'), findsOneWidget);
    },
  );

  test('each row\'s file comes from the desktop release manifest', () async {
    final manifest = FakeHttp({
      kDesktopManifestUrl: (
        status: 200,
        body: {
          'desktop-macos-arm64-dmg': {
            'version': '1.2.6',
            'url': 'https://cdn.autonomous.ai/harness/desktop/1.2.6/Harness-macos-arm64.dmg',
          },
          'desktop-linux-x64': {
            'url': 'https://cdn.example/Harness-linux-x64.AppImage',
          },
          'broken': 'not an entry',
        },
      ),
    });
    final downloads = await loadDesktopDownloads(dio: manifest.dio());
    expect(downloads, {
      'desktop-macos-arm64-dmg': 'https://cdn.autonomous.ai/harness/desktop/1.2.6/Harness-macos-arm64.dmg',
      'desktop-linux-x64': 'https://cdn.example/Harness-linux-x64.AppImage',
    });
    // Every row names a key the manifest publishes.
    expect(kDesktopPlatforms.map((p) => p.key), [
      'desktop-macos-arm64-dmg',
      'desktop-macos-dmg',
      'desktop-linux-x64',
      'desktop-linux-arm64',
    ]);
    // Offline: no files, and every row falls back to the download page.
    expect(await loadDesktopDownloads(dio: FakeHttp({}).dio()), isEmpty);
  });

  testWidgets('a scanned code fills in the account and sends its code', (
    tester,
  ) async {
    await pump(tester);
    await tester.tap(find.text('Yes — scan to connect'));
    await tester.pump();
    final page = tester.widget<ScanToConnectPage>(
      find.byType(ScanToConnectPage),
    );
    page.onCode(ConnectCode.parse(ConnectCode.link('ada@example.com'))!);
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
      await tester.tap(find.text('Yes — scan to connect'));
      await tester.pump();
      final page = tester.widget<ScanToConnectPage>(
        find.byType(ScanToConnectPage),
      );
      page.onCode(
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
    await tester.tap(find.text('Yes — scan to connect'));
    await tester.pump();
    tester
        .widget<ScanToConnectPage>(find.byType(ScanToConnectPage))
        .onCode(
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

  testWidgets('no code at hand: email instead', (tester) async {
    await pump(tester);
    await tester.tap(find.text('Yes — scan to connect'));
    await tester.pump();
    await tester.tap(find.text('Use email instead'));
    await tester.pump();
    expect(find.text('Your email'), findsOneWidget);
  });
}
