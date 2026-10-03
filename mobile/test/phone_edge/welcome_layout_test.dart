import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/welcome/connect_computer.dart';
import 'package:harness_mobile/phone/welcome/focus_hints.dart';
import 'package:harness_mobile/phone/welcome/how_it_works.dart';
import 'package:harness_mobile/phone/welcome/pairing_with_code.dart';
import 'package:harness_mobile/phone/welcome/phone_boot.dart';
import 'package:harness_mobile/phone/welcome/phone_welcome.dart';
import 'package:harness_mobile/phone/welcome/pick_up_page.dart';
import 'package:harness_mobile/phone/welcome/scan_to_connect.dart';
import 'package:harness_mobile/phone/welcome/unlock_computer.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../voice_fakes.dart';
import 'edge_fixture.dart';

/// The first-run flow — every screen somebody meets before their first harness — laid out at every
/// phone, scale and brightness, with an account and a computer whose names are long. None may
/// report an overflow.
///
/// ⚠️ Nothing here reaches anything real: the downloads manifest, the camera, the account service
/// and the computer are all stand-ins, and no screen is left up long enough for a poll to fire.
void main() {
  setUpAll(loadRealFontsIfAsked);

  Future<void> pump(
    WidgetTester tester,
    Widget screen,
    double scale,
    Brightness brightness,
  ) async {
    await tester.pumpWidget(
      phoneApp(screen, textScale: scale, brightness: brightness),
    );
    await frames(tester);
  }

  Widget welcome(AppNotifier app) => PhoneWelcome(
    notifier: app,
    onTrySample: (_) async => null,
    sendCode: (_) async {},
    signIn: (_, _) async => throw Exception(
      'That code has expired. Ask for a new one and try again within ten minutes.',
    ),
    signInWithScan: (_) async {},
    scanCamera: const SizedBox(),
    loadDownloads: () async => const {},
  );

  testWidgets('the first screen', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(noMachines: true);
      addTearDown(app.dispose);
      await pump(tester, welcome(app), scale, brightness);
      expect(find.text('Yes — scan to connect'), findsOneWidget);
    });
  });

  testWidgets('scan, then email, then a code that fails', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(noMachines: true);
      addTearDown(app.dispose);
      await pump(tester, welcome(app), scale, brightness);
      await tapInView(tester, find.text('Yes — scan to connect'));
      await frames(tester);
      await tapInView(tester, find.text('Use email instead'));
      await frames(tester);
      await tester.enterText(
        find.byType(TextField),
        'ada.lovelace.the.first.programmer@analytical-engine.example.com',
      );
      raiseKeyboard(tester);
      await frames(tester);
      // The keyboard's own `go`: with it up on a small phone, the button can be below the fold.
      await tester.testTextInput.receiveAction(TextInputAction.go);
      await frames(tester);
      await tester.enterText(find.byType(TextField), '1234');
      await frames(tester);
      expect(find.textContaining('expired'), findsOneWidget);
      lowerKeyboard(tester);
      await frames(tester);
    });
  });

  testWidgets('the set-up page', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(noMachines: true);
      addTearDown(app.dispose);
      await pump(tester, welcome(app), scale, brightness);
      await tapInView(tester, find.text('Not yet — set it up'));
      await frames(tester);
      await tester.drag(find.byType(ListView), const Offset(0, -2000));
      await frames(tester);
    });
  });

  testWidgets('scanning, signing in', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      await pump(
        tester,
        Scaffold(
          body: SafeArea(
            child: ScanToConnectPage(
              onCode: (_) {},
              onUseEmail: () {},
              onBack: () {},
              signingIn: true,
              camera: const SizedBox(),
            ),
          ),
        ),
        scale,
        brightness,
      );
    });
  });

  testWidgets('set up your computer, signed in, both ways', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(noMachines: true);
      addTearDown(app.dispose);
      app.currentUser = const CurrentUserProfile(
        id: 'u',
        name: longName,
        email:
            'ada.lovelace.the.first.programmer@analytical-engine.example.com',
      );
      // ⚠️ Kept under five seconds of the test's clock: the page re-reads the account's machines
      // every five, and that read is the real service's.
      await pump(
        tester,
        ConnectComputerPage(
          notifier: app,
          onBack: () {},
          onTrySample: (_) async => null,
          loadDownloads: () async => const {},
        ),
        scale,
        brightness,
      );
      await tester.drag(find.byType(ListView), const Offset(0, -2000));
      await frames(tester, count: 1);
    });
  });

  testWidgets('unlocking a computer with a long name', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(machineName: longMachine);
      addTearDown(app.dispose);
      await pump(
        tester,
        Scaffold(
          body: UnlockComputer(notifier: app, machineState: app.stateOf('m')!),
        ),
        scale,
        brightness,
      );
      await tapInView(tester, find.text('Unlock'));
      await frames(tester, count: 1);
      expect(find.text('✗ Enter the password first.'), findsOneWidget);
    });
  });

  testWidgets('pairing with a code, and failing', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(machineName: longMachine);
      addTearDown(app.dispose);
      await pump(
        tester,
        PairingWithCode(notifier: app, machineId: 'm', code: '123456'),
        scale,
        brightness,
      );
    });
  });

  for (final count in [0, 1, 200]) {
    testWidgets('pick up where you left off, $count sessions', (tester) async {
      await expectNoLayoutErrors(tester, (scale, brightness) async {
        final app = count == 0
            ? edgeApp(agents: [])
            : edgeApp(
                machineName: longMachine,
                agents: manyAgents(count, firstName: longName),
              );
        addTearDown(app.dispose);
        await pump(tester, PickUpPage(notifier: app), scale, brightness);
      });
    });
  }

  testWidgets('how Harness works', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      await pump(tester, const HowItWorksPage(), scale, brightness);
      await tester.drag(find.byType(ListView), const Offset(0, -3000));
      await frames(tester);
    });
  });

  testWidgets('starting up', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      await pump(tester, const PhoneBoot(), scale, brightness);
    });
  });

  testWidgets('the first-time hints over Focus', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      await pump(
        tester,
        Builder(
          builder: (context) => ColoredBox(
            color: Tty.of(context).ground,
            child: FocusHints(
              micBottom: 34 + 4 + 30,
              store: FocusHintsSeen(storage: MemoryKeyValueStore()),
            ),
          ),
        ),
        scale,
        brightness,
      );
      expect(find.text('→ swipe right'), findsOneWidget);
    });
  });
}
