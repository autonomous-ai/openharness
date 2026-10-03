import 'dart:async';
import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/config.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/add_phone_dialog.dart';

import 'swarm_interactions_test.dart' show chord;
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp, MemoryStore;

/// The alphabet the Add Phone contract names. The code must come from it —
/// and, see [kPhonePairCodeAlphabet], from the part both normalisers agree on.
const _contractAlphabet = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/// A signed-in window whose machine `m` is this computer.
AppNotifier _signedInApp() {
  final app = createApp()
    ..status = AppStatus.authenticated
    ..signedIn = true
    ..currentUser = const CurrentUserProfile(email: 'dee+phone@example.com');
  app.machineStates['m']!.localOnly = true;
  return app;
}

/// A scripted daemon: answers in order, records every code it was handed.
class _FakeDaemon {
  _FakeDaemon(this.answers);

  final List<FutureOr<PhonePairAnswer> Function()> answers;
  final codes = <String>[];
  final tokens = <CancelToken>[];

  Future<PhonePairAnswer> call(String code, CancelToken cancel) async {
    codes.add(code);
    tokens.add(cancel);
    return answers.removeAt(0)();
  }
}

PhonePairAnswer Function() _failed(String code) =>
    () => PhonePairAnswer.failed(code);

/// A backend that mints sign-in codes `h1`, `h2`, … — or none at all.
class _FakeSignIn {
  _FakeSignIn({this.available = true});

  final bool available;
  var minted = 0;

  Future<({String code, Duration ttl})?> call() async {
    if (!available) return null;
    minted++;
    return (code: 'h$minted', ttl: const Duration(seconds: 90));
  }
}

Future<void> _open(
  WidgetTester tester,
  AppNotifier app,
  PhonePairCall pair, {
  PhoneSignInCodeCall? signInCode,
  VoidCallback? onConnectMachine,
  VoidCallback? onManageDevices,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: const Scaffold(body: SizedBox.expand()),
    ),
  );
  unawaited(
    showAddPhoneDialog(
      tester.element(find.byType(Scaffold)),
      app,
      pair: pair,
      signInCode: signInCode ?? _FakeSignIn().call,
      onConnectMachine: onConnectMachine,
      onManageDevices: onManageDevices,
    ),
  );
  await tester.pump();
  // The sign-in code's answer, which the QR waits for.
  await tester.pump();
}

String _qrData(WidgetTester tester) =>
    tester.widget<PhonePairQr>(find.byType(PhonePairQr)).data;

String _status(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const ValueKey('add-phone-status'))).data!;

void main() {
  AppNotifier browserApp() {
    final storage = MemoryStore();
    final session = AuthSession(storage: storage);
    return AppNotifier(
        config: AppConfig.dev,
        authSession: session,
        viewer: ViewerServices(
          config: AppConfig.dev,
          session: session,
          keys: ViewerKeyStore(storage: storage),
        ),
      )
      ..status = AppStatus.authenticated
      ..signedIn = true
      ..currentUser = const CurrentUserProfile(email: 'browser@example.test');
  }

  testWidgets(
    'browser QR targets a linked computer and keeps that destination',
    (tester) async {
      final app = browserApp();
      addTearDown(app.dispose);
      for (final id in ['a', 'b']) {
        app.machineStates[id] =
            MachineState(
                Machine(
                  machineId: id,
                  name: 'Computer $id',
                  authMode: MachineAuthMode.remote,
                ),
              )
              ..connectionStatus = ConnectionStatus.connected
              ..nodeOnline = true;
      }
      app.selectedMachineId = 'b';
      final daemon = _FakeDaemon(List.filled(3, _failed('NO_INTENT')));
      await _open(tester, app, daemon.call);
      final before = _qrData(tester);
      expect(Uri.splitQueryString(Uri.parse(before).fragment)['m'], 'b');
      expect(find.text('Computer b'), findsOneWidget);
      app.selectedMachineId = 'a';
      app.notifyListeners();
      await tester.pump();
      expect(_qrData(tester), before);
      expect(daemon.codes, hasLength(1));
      await tester.pumpWidget(const SizedBox());
      expect(daemon.tokens.single.isCancelled, isTrue);
    },
  );

  testWidgets('browser without a linked computer offers the machine picker', (
    tester,
  ) async {
    final app = browserApp();
    addTearDown(app.dispose);
    app.machineStates['unlinked'] = MachineState(
      const Machine(machineId: 'unlinked', authMode: MachineAuthMode.remote),
    )..needsLink = true;
    var opened = false;
    final daemon = _FakeDaemon([]);
    await _open(
      tester,
      app,
      daemon.call,
      onConnectMachine: () => opened = true,
    );
    expect(find.byType(PhonePairQr), findsNothing);
    expect(daemon.codes, isEmpty);
    await tester.tap(find.widgetWithText(TextButton, 'Connect a machine'));
    await tester.pump();
    expect(opened, isTrue);
    expect(find.byType(AddPhoneDialog), findsNothing);
    await tester.pumpWidget(const SizedBox());
  });

  group('the QR payload', () {
    test('is the /pair link with everything in the fragment', () {
      final link = phonePairLink(
        email: 'dee+phone@example.com',
        machineId: '3f2c9a10-7d4e-4b8a-9c61-0e5f2a7b8c9d',
        code: 'ABCDEFGHJKMNPQRS',
      );
      expect(
        link.toString(),
        'https://harness.autonomous.ai/pair'
        '#e=dee%2Bphone%40example.com'
        '&m=3f2c9a10-7d4e-4b8a-9c61-0e5f2a7b8c9d'
        '&c=ABCDEFGHJKMNPQRS',
      );
      // The code is the E2EE secret: a browser sends the query to the server
      // and never the fragment.
      expect(link.hasQuery, isFalse);
      expect(link.query, isEmpty);
      expect(link.path, '/pair');
      // What the phone does with it (mobile ConnectCode.parse).
      final scanned = Uri.parse(link.toString());
      expect(Uri.splitQueryString(scanned.fragment), {
        'e': 'dee+phone@example.com',
        'm': '3f2c9a10-7d4e-4b8a-9c61-0e5f2a7b8c9d',
        'c': 'ABCDEFGHJKMNPQRS',
      });
    });

    test(
      'codes are 16 characters from the allowed alphabet, fresh each time',
      () {
        final seen = <String>{};
        for (var i = 0; i < 500; i++) {
          final code = newPhonePairCode();
          expect(code, hasLength(16));
          for (final char in code.split('')) {
            expect(_contractAlphabet, contains(char), reason: code);
            expect(kPhonePairCodeAlphabet, contains(char), reason: code);
          }
          seen.add(code);
        }
        expect(seen, hasLength(500));
        // Every symbol turns up: nothing in the alphabet is unreachable.
        final used = seen.join().split('').toSet();
        expect(used, kPhonePairCodeAlphabet.split('').toSet());
      },
    );

    test('no code carries a character the two normalisers disagree on', () {
      // core.ts normalizeCode maps I L O U; the phone's does not.
      final random = math.Random(7);
      for (var i = 0; i < 2000; i++) {
        expect(
          newPhonePairCode(random: random),
          isNot(matches(RegExp('[ILOU01]'))),
        );
      }
    });
  });

  group('the sign-in code', () {
    test('rides in the fragment as h, after the pairing code', () {
      final link = phonePairLink(
        email: 'dee@example.com',
        machineId: 'm',
        code: 'ABCDEFGHJKMNPQRS',
        signIn: 'hnh_abc-_XYZ',
      );
      expect(link.hasQuery, isFalse);
      expect(Uri.splitQueryString(Uri.parse(link.toString()).fragment), {
        'e': 'dee@example.com',
        'm': 'm',
        'c': 'ABCDEFGHJKMNPQRS',
        'h': 'hnh_abc-_XYZ',
      });
    });

    testWidgets('is in the QR, and a new one replaces it every minute', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final signIn = _FakeSignIn();
      final daemon = _FakeDaemon(List.filled(80, _failed('NO_INTENT')));
      await _open(tester, app, daemon.call, signInCode: signIn.call);

      expect(
        Uri.splitQueryString(Uri.parse(_qrData(tester)).fragment)['h'],
        'h1',
      );
      await tester.pump(const Duration(seconds: 60));
      await tester.pump();
      expect(signIn.minted, 2);
      expect(
        Uri.splitQueryString(Uri.parse(_qrData(tester)).fragment)['h'],
        'h2',
      );

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.pump(const Duration(minutes: 3));
      expect(signIn.minted, 2, reason: 'nothing is minted after closing');
    });

    testWidgets('without one the QR still pairs — the phone emails a code', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final daemon = _FakeDaemon(List.filled(10, _failed('NO_INTENT')));
      await _open(
        tester,
        app,
        daemon.call,
        signInCode: _FakeSignIn(available: false).call,
      );
      final fields = Uri.splitQueryString(Uri.parse(_qrData(tester)).fragment);
      expect(fields.keys, ['e', 'm', 'c']);
      expect(fields['c'], daemon.codes.single);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.pump(const Duration(seconds: 10));
    });
  });

  group('the account\'s devices', () {
    testWidgets(
      'are one link away — Settings ▸ Your devices — not a list in here',
      (tester) async {
        final app = _signedInApp();
        addTearDown(app.dispose);
        var opened = 0;
        await _open(
          tester,
          app,
          _FakeDaemon(List.filled(20, _failed('NO_INTENT'))).call,
          onManageDevices: () => opened++,
        );
        await tester.pump();
        final link = find.byKey(const ValueKey('add-phone-manage-devices'));
        expect(link, findsOneWidget);
        expect(find.text('Manage devices…'), findsOneWidget);
        await tester.tap(link);
        await tester.pump();
        // The dialog makes way for Settings: one is open at a time.
        expect(opened, 1);
        expect(find.byType(AddPhoneDialog), findsNothing);
        await tester.pump(const Duration(seconds: 10));
      },
    );

    testWidgets('no link when there is nowhere to send it', (tester) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      await _open(
        tester,
        app,
        _FakeDaemon(List.filled(20, _failed('NO_INTENT'))).call,
      );
      await tester.pump();
      expect(
        find.byKey(const ValueKey('add-phone-manage-devices')),
        findsNothing,
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.pump(const Duration(seconds: 10));
    });
  });

  group('arming the daemon', () {
    testWidgets('retries while no phone is waiting and closes once paired', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final daemon = _FakeDaemon([
        _failed('NO_INTENT'),
        _failed('NO_INTENT'),
        () => const PhonePairAnswer.paired('Dee’s iPhone'),
      ]);
      await _open(tester, app, daemon.call);

      expect(find.text('Add your phone'), findsOneWidget);
      expect(daemon.codes, hasLength(1));
      final code = daemon.codes.single;
      expect(
        _qrData(tester),
        phonePairLink(
          email: 'dee+phone@example.com',
          machineId: 'm',
          code: code,
          signIn: 'h1',
        ).toString(),
      );
      expect(_status(tester), 'Scan with Harness on your iPhone');

      await tester.pump(const Duration(milliseconds: 1500));
      expect(daemon.codes, [code, code]);
      await tester.pump(const Duration(milliseconds: 1500));
      expect(daemon.codes, [code, code, code]);
      await tester.pump();
      expect(_status(tester), '✓ Connected Dee’s iPhone');
      expect(find.byType(AddPhoneDialog), findsOneWidget);

      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
      expect(daemon.codes, hasLength(3));
    });

    testWidgets('a code that did not match is replaced, QR and all', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final daemon = _FakeDaemon([
        _failed('CODE_MISMATCH'),
        _failed('NO_INTENT'),
        _failed('NO_INTENT'),
      ]);
      await _open(tester, app, daemon.call);
      await tester.pump();
      final first = daemon.codes.single;
      expect(_status(tester), "That didn't match. Scan the new code.");
      expect(_qrData(tester), isNot(contains('c=$first')));

      await tester.pump(const Duration(milliseconds: 1500));
      expect(daemon.codes, hasLength(2));
      final second = daemon.codes.last;
      expect(second, isNot(first));
      expect(_qrData(tester), contains('c=$second&'));
      // An instruction outlives the "no phone yet" that follows it.
      await tester.pump();
      expect(_status(tester), "That didn't match. Scan the new code.");

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
      expect(daemon.tokens.last.isCancelled, isTrue);
      await tester.pump(const Duration(seconds: 10));
      expect(daemon.codes, hasLength(2), reason: 'nothing asks after closing');
    });

    testWidgets('rate limited waits a minute before asking again', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final daemon = _FakeDaemon([
        _failed('RATE_LIMITED'),
        _failed('NO_INTENT'),
      ]);
      await _open(tester, app, daemon.call);
      await tester.pump();
      expect(_status(tester), 'Too many tries. Wait a minute.');
      await tester.pump(const Duration(seconds: 59));
      expect(daemon.codes, hasLength(1));
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(daemon.codes, hasLength(2));
      expect(_status(tester), 'Scan with Harness on your iPhone');
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    });

    testWidgets('a daemon that cannot pair stops the loop', (tester) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final daemon = _FakeDaemon([_failed(PhonePairAnswer.unavailable)]);
      await _open(tester, app, daemon.call);
      await tester.pump();
      expect(_status(tester), startsWith('Update Harness on this '));
      await tester.pump(const Duration(seconds: 30));
      expect(daemon.codes, hasLength(1));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    });

    testWidgets('a long poll that ends after closing touches nothing', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final answer = Completer<PhonePairAnswer>();
      final daemon = _FakeDaemon([() => answer.future]);
      await _open(tester, app, daemon.call);
      expect(daemon.codes, hasLength(1));

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
      expect(daemon.tokens.single.isCancelled, isTrue);

      answer.complete(const PhonePairAnswer.paired('Late phone'));
      await tester.pump(const Duration(seconds: 5));
      expect(tester.takeException(), isNull);
      expect(daemon.codes, hasLength(1));
    });

    testWidgets('a guest is asked to sign in, and nothing is armed', (
      tester,
    ) async {
      final app = _signedInApp()..signedIn = false;
      addTearDown(app.dispose);
      final daemon = _FakeDaemon([]);
      await _open(tester, app, daemon.call);
      expect(find.text('Sign in to add your phone.'), findsOneWidget);
      expect(find.byType(PhonePairQr), findsNothing);
      expect(daemon.codes, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    });
  });

  group('the way in', () {
    // `createApp` has no profile and no local machine, so the dialog opens
    // with nothing to arm — these tests never reach for a real daemon.
    testWidgets('Harness ▸ Add Phone… opens the dialog', (tester) async {
      const channel = MethodChannel('harness/swarm_tabs');
      final messenger = tester.binding.defaultBinaryMessenger;
      messenger.setMockMethodCallHandler(channel, (_) async => true);
      addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
      final app = createApp()..status = AppStatus.authenticated;
      addTearDown(app.dispose);
      await mount(tester, app, nativeTabs: true);

      final handled = Completer<void>();
      messenger.handlePlatformMessage(
        channel.name,
        const StandardMethodCodec().encodeMethodCall(
          const MethodCall('addPhone'),
        ),
        (_) => handled.complete(),
      );
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(AddPhoneDialog), findsOneWidget);
      expect(find.text('Add your phone'), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await handled.future;
      expect(find.byType(AddPhoneDialog), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('> add phone opens the dialog from the command search', (
      tester,
    ) async {
      final app = createApp()..status = AppStatus.authenticated;
      addTearDown(app.dispose);
      await mount(tester, app);
      await chord(tester, LogicalKeyboardKey.keyP, shift: true);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        '> add phone',
      );
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(AddPhoneDialog), findsOneWidget);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets(
      'Manage devices… makes way for Settings ▸ Your devices, which opens',
      (tester) async {
        // The dialog is still this screen's open dialog while it pops, so a
        // Settings asked for from the link itself was silently refused.
        final app = _signedInApp();
        addTearDown(app.dispose);
        await mount(tester, app);
        await chord(tester, LogicalKeyboardKey.keyP, shift: true);
        await tester.enterText(
          find.byKey(const ValueKey('swarm-search-input')),
          '> add phone',
        );
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        final link = find.byKey(const ValueKey('add-phone-manage-devices'));
        expect(link, findsOneWidget);

        await tester.tap(link);
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 500));
        expect(find.byType(AddPhoneDialog), findsNothing);
        expect(find.text('Your devices'), findsWidgets);
        await tester.pumpWidget(const SizedBox());
        await tester.pump(const Duration(seconds: 10));
      },
    );
  });
}
