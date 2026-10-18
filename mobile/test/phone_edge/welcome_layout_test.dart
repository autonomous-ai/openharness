import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/welcome/focus_hints.dart';
import 'package:harness_mobile/phone/welcome/how_it_works.dart';
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';
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
/// ⚠️ Nothing here reaches anything real: the camera, the account service and the computer are all
/// stand-ins, and no screen is left up long enough for a poll to fire.
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
    sendCode: (_) async {},
    signIn: (_, _) async => throw Exception(
      'That code has expired. Ask for a new one and try again within ten minutes.',
    ),
    scanCamera: const SizedBox.expand(),
  );

  /// Home as the shell mounts it, for an account with no computer yet.
  Widget home(AppNotifier app) => PhoneShellScope(
    onMachineLinked: (_) {},
    onOpenAgent: (_, _) {},
    child: AgentHome(notifier: app),
  );

  testWidgets('the first screen, and why it was signed out', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(noMachines: true)
        ..signedOutReason =
            'You were signed out because this phone was removed from your account on another device.';
      addTearDown(app.dispose);
      await pump(tester, welcome(app), scale, brightness);
      // The reason in the headline's place, the headline back once a way in is pressed.
      expect(
        find.textContaining('removed from your account on another device'),
        findsOneWidget,
      );
      expect(find.text(OnboardingCopy.welcome), findsNothing);
    });
  });

  testWidgets('the email, then a code that fails', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      final app = edgeApp(noMachines: true);
      addTearDown(app.dispose);
      await pump(tester, welcome(app), scale, brightness);
      // The emailed code's way in: Continue with email, under the accounts.
      await tapInView(
        tester,
        find.byKey(const ValueKey('welcome-continue-email')),
      );
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

  testWidgets(
    'On your computer, go to — a long account — then a computer with a long name joining',
    (tester) async {
      await expectNoLayoutErrors(tester, (scale, brightness) async {
        final app = edgeApp(noMachines: true)
          ..currentUser = const CurrentUserProfile(
            id: 'u',
            name: longName,
            email: 'ada.lovelace.the.first.programmer@analytical-engine.example.com',
          );
        addTearDown(app.dispose);
        // ⚠️ Kept under five seconds of the test's clock: the page re-reads the account's machines
        // every five.
        await pump(tester, home(app), scale, brightness);
        expect(find.text(OnboardingCopy.goToHeadline), findsOneWidget);

        const joining = Machine(
          machineId: 'm',
          authMode: MachineAuthMode.remote,
          name: longMachine,
        );
        app.machines = [joining];
        app.notifyListeners();
        await frames(tester);
        expect(find.text(OnboardingCopy.ready(longMachine)), findsOneWidget);
      });
    },
  );

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

  testWidgets('the hints over Focus, asked for again', (tester) async {
    await expectNoLayoutErrors(tester, (scale, brightness) async {
      await pump(
        tester,
        Builder(
          builder: (context) => ColoredBox(
            color: Tty.of(context).ground,
            child: FocusHints(
              micBottom: 34 + 4 + 30,
              // As the terminal has them: the notification prompt after, and its line with them.
              onDone: () {},
              store: FocusHintsSeen(
                storage: MemoryKeyValueStore()
                  ..values['phone_focus_hints_v1'] = 'again',
              ),
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
