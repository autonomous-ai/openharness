import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/phone/new_agent_page.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/welcome/connect_code.dart';
import 'package:harness_mobile/phone/welcome/focus_hints.dart';
import 'package:harness_mobile/phone/welcome/onboarding_copy.dart';
import 'package:harness_mobile/phone/welcome/phone_welcome.dart';
import 'package:harness_mobile/phone/welcome/pick_up_page.dart';
import 'package:harness_mobile/phone/welcome/scan_to_connect.dart';
import 'package:harness_mobile/phone/welcome/unlock_computer.dart';
import 'package:harness_mobile/phone/welcome/your_computer.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:mobile_scanner/mobile_scanner.dart';

import '../voice_fakes.dart';
import 'edge_fixture.dart';

/// The first-run flow as somebody walks it: wrong email, short code, Back, the address sent to the
/// computer, a password that fails and one that works, the hints only when asked for, and the
/// ways to a first harness.
///
/// ⚠️ The camera, the share sheet, Mail and the account service are all answered here — no screen
/// under test reaches the real one.
void main() {
  late List<String> platformCalls;

  setUp(() {
    platformCalls = [];
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    for (final channel in const [
      MethodChannel('plugins.flutter.io/url_launcher'),
      MethodChannel('dev.fluttercommunity.plus/share'),
    ]) {
      messenger.setMockMethodCallHandler(channel, (call) async {
        platformCalls.add('${channel.name} ${call.method}');
        // Mail will not open here; the share sheet is dismissed.
        return channel.name.contains('share')
            ? 'dev.fluttercommunity.plus/share/dismissed'
            : false;
      });
    }
  });

  tearDown(() {
    final messenger =
        TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger;
    for (final name in const [
      'plugins.flutter.io/url_launcher',
      'dev.fluttercommunity.plus/share',
    ]) {
      messenger.setMockMethodCallHandler(MethodChannel(name), null);
    }
  });

  Future<void> close(WidgetTester tester, AppNotifier app) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 3));
    app.dispose();
    await tester.pump(const Duration(seconds: 30));
  }

  group('signing in', () {
    Future<({AppNotifier app, List<String> sent})> welcome(
      WidgetTester tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp(noMachines: true);
      final sent = <String>[];
      await tester.pumpWidget(
        phoneApp(
          PhoneWelcome(
            notifier: app,
            sendCode: (email) async => sent.add(email),
            signIn: (_, code) async {
              if (code != '4242') throw Exception('That code is not right.');
            },
            scanCamera: const SizedBox.expand(),
          ),
        ),
      );
      await frames(tester);
      return (app: app, sent: sent);
    }

    /// The emailed code's way in: Continue with email, under the accounts.
    Future<void> toEmail(WidgetTester tester) async {
      await tester.tap(find.byKey(const ValueKey('welcome-continue-email')));
      await frames(tester);
    }

    testWidgets('a wrong email, then a short code, then a wrong one, then the '
        'right one', (tester) async {
      final (:app, :sent) = await welcome(tester);
      await toEmail(tester);

      await tester.enterText(find.byType(TextField), 'not-an-email');
      await tester.tap(find.text('Send code'));
      await frames(tester);
      expect(find.textContaining('doesn’t look like an email'), findsOneWidget);
      expect(sent, isEmpty);

      await tester.enterText(find.byType(TextField), 'ada@example.com');
      await tester.tap(find.text('Send code'));
      await frames(tester);
      expect(sent, ['ada@example.com']);
      expect(find.textContaining('ada@example.com'), findsOneWidget);
      expect(find.text('Resend in 30s'), findsOneWidget);

      await tester.enterText(find.byType(TextField), '12');
      final signIn = tester.widget<TtyPrimaryButton>(
        find.byType(TtyPrimaryButton),
      );
      expect(signIn.onPressed, isNull, reason: 'two digits cannot sign in');
      await tester.tap(find.text('Sign in'));
      await frames(tester);
      expect(find.textContaining('Enter the 4 digits'), findsNothing);

      await tester.enterText(find.byType(TextField), '1234');
      await frames(tester);
      expect(find.textContaining('That code is not right.'), findsOneWidget);

      // The clock runs out: the code can be sent again.
      await tester.pump(const Duration(seconds: 31));
      await tester.tap(find.text('Resend code'));
      await frames(tester);
      expect(sent, hasLength(2));

      // Change email, then Back: the welcome it was chosen on.
      await tester.tap(find.text('Change email'));
      await frames(tester);
      expect(find.text('Your email'), findsOneWidget);
      await tester.binding.handlePopRoute();
      await frames(tester);
      expect(find.text(OnboardingCopy.welcome), findsOneWidget);
      await close(tester, app);
    });

    testWidgets('Back from the code goes to the email, not out', (
      tester,
    ) async {
      final (:app, sent: _) = await welcome(tester);
      await toEmail(tester);
      await tester.enterText(find.byType(TextField), 'ada@example.com');
      await tester.testTextInput.receiveAction(TextInputAction.go);
      await frames(tester);
      await tester.binding.handlePopRoute();
      await frames(tester);
      expect(find.text('Your email'), findsOneWidget);
      await close(tester, app);
    });
  });

  group('scanning', () {
    Future<List<ConnectCode>> scan(WidgetTester tester) async {
      setPhone(tester, largePhone);
      final codes = <ConnectCode>[];
      await tester.pumpWidget(
        phoneApp(
          Scaffold(
            body: ScanToConnectPage(
              onCode: codes.add,
              onUseEmail: () {},
              onBack: () {},
            ),
          ),
        ),
      );
      await frames(tester);
      return codes;
    }

    testWidgets('a code of ours is taken once; anything else is not', (
      tester,
    ) async {
      final codes = await scan(tester);
      final scanner = tester.widget<MobileScanner>(find.byType(MobileScanner));
      scanner.onDetect!(
        const BarcodeCapture(
          barcodes: [Barcode(rawValue: 'https://example.com')],
        ),
      );
      expect(codes, isEmpty);
      final ours = ConnectCode.link(
        'ada@example.com',
        machineId: 'm',
        pairCode: '123456',
      );
      scanner.onDetect!(BarcodeCapture(barcodes: [Barcode(rawValue: ours)]));
      scanner.onDetect!(BarcodeCapture(barcodes: [Barcode(rawValue: ours)]));
      expect(codes, hasLength(1), reason: 'the camera reports it every frame');
      expect(codes.single.pairCode, '123456');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
    });
  });

  testWidgets('On your computer, go to: the address goes to the share sheet', (
    tester,
  ) async {
    setPhone(tester, largePhone);
    final app = edgeApp(noMachines: true);
    await tester.pumpWidget(phoneApp(YourComputerPage(notifier: app)));
    await frames(tester);
    await tester.tap(find.byKey(const ValueKey('go-address')));
    await frames(tester);
    expect(platformCalls.where((call) => call.contains('share')), hasLength(1));
    await close(tester, app);
  });

  group('unlocking a computer', () {
    Future<({AppNotifier app, EdgeLinks links, List<int> unlocked})> unlock(
      WidgetTester tester, {
      String? refuse,
    }) async {
      setPhone(tester, largePhone);
      final links = EdgeLinks()..error = refuse;
      final app = edgeApp(links: links, machineName: 'studio');
      // Locked, so not connected: a socket that is up has passed the machine's welcome, and a
      // link leaves it alone (`_keepsOpenConnection`).
      app.stateOf('m')!
        ..needsLink = true
        ..connectionStatus = ConnectionStatus.disconnected;
      final unlocked = <int>[];
      await tester.pumpWidget(
        phoneApp(
          Scaffold(
            body: UnlockComputer(
              notifier: app,
              machineState: app.stateOf('m')!,
              onUnlocked: () => unlocked.add(1),
            ),
          ),
        ),
      );
      await frames(tester);
      return (app: app, links: links, unlocked: unlocked);
    }

    testWidgets('a password that fails says why; shown, then hidden', (
      tester,
    ) async {
      final (:app, :links, :unlocked) = await unlock(
        tester,
        refuse: 'Wrong password for studio.',
      );
      await tester.enterText(find.byType(TextField), 'hunter2');
      await tester.tap(find.text('Show'));
      await tester.pump();
      expect(find.text('Hide'), findsOneWidget);
      await tester.tap(find.text('Unlock'));
      await frames(tester);
      expect(links.passwords, ['hunter2']);
      expect(find.text('✗ Wrong password for studio.'), findsOneWidget);
      expect(unlocked, isEmpty);
      await tester.tap(find.text('Copy'));
      await tester.pump();
      expect(find.text('Copied'), findsOneWidget);
      await close(tester, app);
    });

    testWidgets('a password that works unlocks it', (tester) async {
      final (:app, :links, :unlocked) = await unlock(tester);
      await tester.enterText(find.byType(TextField), 'correct horse');
      await tester.testTextInput.receiveAction(TextInputAction.go);
      await frames(tester);
      expect(links.passwords, ['correct horse']);
      expect(unlocked, [1]);
      expect(app.stateOf('m')!.needsLink, isFalse);
      await close(tester, app);
    });
  });

  group('the hints over Focus', () {
    testWidgets(
      'not before the first look: only when asked for again, then once',
      (tester) async {
        setPhone(tester, largePhone);
        final storage = MemoryKeyValueStore();
        var done = 0;
        Widget hints() => phoneApp(
          FocusHints(
            micBottom: 60,
            store: FocusHintsSeen(storage: storage),
            onDone: () => done++,
          ),
        );
        // A first terminal: nothing over it (owner, 2026-10-12).
        await tester.pumpWidget(hints());
        await frames(tester);
        expect(find.text('→ swipe right'), findsNothing);

        // Settings ▸ Show the tips again.
        await FocusHintsSeen(storage: storage).forget();
        await tester.pumpWidget(const SizedBox());
        await tester.pumpWidget(hints());
        await frames(tester);
        expect(find.text('→ swipe right'), findsOneWidget);
        await tester.tapAt(const Offset(200, 400));
        await tester.pump();
        expect(find.text('→ swipe right'), findsNothing);
        expect(done, 1);
        expect(storage.values.values, contains('yes'));

        // The next Focus, on the same install: nothing.
        await tester.pumpWidget(const SizedBox());
        await tester.pumpWidget(hints());
        await frames(tester);
        expect(find.text('→ swipe right'), findsNothing);
      },
    );

    // ⚠️ The OS's notification prompt follows them, so they say what a notice is for — and only what
    // reaches a phone: a question does since 2026-10-21 (`commander_question` over the relay).
    testWidgets(
      'before the notification prompt: a harness finishing or needing you, a new device',
      (tester) async {
        setPhone(tester, largePhone);
        Widget hints({VoidCallback? onDone}) => phoneApp(
          FocusHints(
            micBottom: 60,
            store: FocusHintsSeen(
              storage: MemoryKeyValueStore()
                ..values['phone_focus_hints_v1'] = 'again',
            ),
            onDone: onDone,
          ),
        );
        await tester.pumpWidget(hints(onDone: () {}));
        await frames(tester);
        expect(find.text('→ swipe right'), findsOneWidget);
        expect(
          find.text(
            'Notifications tell you when a harness finishes or needs you, or a new device joins your account.',
          ),
          findsOneWidget,
        );
        expect(find.textContaining('needs you'), findsOneWidget);

        // No prompt after them: no line about notices either.
        await tester.pumpWidget(const SizedBox());
        await tester.pumpWidget(hints());
        await frames(tester);
        expect(find.text('→ swipe right'), findsOneWidget);
        expect(find.textContaining('Notifications'), findsNothing);
      },
    );

    test('nothing stored is put away; asked for, they come back; a store that fails never nags', () async {
      final storage = MemoryKeyValueStore();
      final seen = FocusHintsSeen(storage: storage);
      expect(await seen.seen(), isTrue);
      await seen.forget();
      expect(await seen.seen(), isFalse);
      expect(storage.values['phone_focus_hints_v1'], 'again');
      await seen.markSeen();
      expect(await FocusHintsSeen(storage: storage).seen(), isTrue);

      final broken = FocusHintsSeen(storage: _Failing());
      expect(await broken.seen(), isTrue);
      await broken.forget();
      await broken.markSeen();
    });
  });

  group('picking up where you left off', () {
    testWidgets('+ New Harness, on the first computer ready for one', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp(agents: manyAgents(3));
      final opened = <(String, String)>[];
      await tester.pumpWidget(
        PhoneShellScope(
          onMachineLinked: (_) {},
          onOpenAgent: (machineId, agentId) => opened.add((machineId, agentId)),
          child: phoneApp(PickUpPage(notifier: app)),
        ),
      );
      await frames(tester);
      expect(find.text('3 harnesses on studio'), findsOneWidget);

      // A session is what the page is for: a tap opens it as the home screen.
      await tester.tap(find.text('agent-0', findRichText: true).first);
      await tester.pump();
      expect(opened, [('m', 'a0')]);

      await tapInView(tester, find.text('+ New Harness', findRichText: true));
      await frames(tester, count: 6);
      expect(find.byType(NewAgentPage), findsOneWidget);
      await close(tester, app);
    });

    testWidgets('sessions on more than one computer are counted so', (
      tester,
    ) async {
      setPhone(tester, largePhone);
      final app = edgeApp(agents: manyAgents(1));
      const other = Machine(
        machineId: 'mini',
        authMode: MachineAuthMode.remote,
        name: 'mini',
      );
      app.machines = [...app.machines, other];
      app.machineStates['mini'] = MachineState(other)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..agents = [edgeAgent('x')];
      await tester.pumpWidget(phoneApp(PickUpPage(notifier: app)));
      await frames(tester);
      expect(find.text('2 harnesses on 2 computers'), findsOneWidget);
      await close(tester, app);
    });
  });
}

class _Failing implements LocalKeyValueStore {
  @override
  Future<String?> read(String key) async => throw Exception('unreadable');

  @override
  Future<void> write(String key, String value) async =>
      throw Exception('read-only');

  @override
  Future<void> delete(String key) async => throw Exception('read-only');
}
