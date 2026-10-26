import 'dart:async';
import 'dart:math' as math;

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/phone_app_links.dart';
import 'package:harness/measurement/product_measurement.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/sign_in_provider.dart';
import 'package:harness/viewer/viewer_services.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/qr_code_view.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/add_phone_dialog.dart';
import 'package:harness/widgets/desktop_chrome.dart'
    show DesktopChrome, DesktopDialogSurface;

import 'support/add_phone_measurement.dart';
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

class _DeviceSnapshotApi extends ApiClient {
  _DeviceSnapshotApi({this.fails = false, this.listing})
    : super(
        config: AppConfig.dev,
        session: AuthSession(storage: MemoryStore()),
      );
  final bool fails;
  final Map<String, dynamic>? listing;
  @override
  Future<Map<String, dynamic>?> daemonDevices() async {
    if (fails) throw StateError('unreadable');
    return listing ?? {'members': <Object>[]};
  }
}

/// A scripted daemon: answers in order, records every code it was handed.
class _FakeDaemon {
  /// Copied: a fixed-length `List.filled` cannot be answered from, and the
  /// dialog would say "Could not pair" instead of asking again.
  _FakeDaemon(Iterable<FutureOr<PhonePairAnswer> Function()> answers)
    : answers = [...answers];

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
  AddPhoneOpening? from,
  PhoneSignInCodeCall? signInCode,
  bool Function()? signInUnavailable,
  VoidCallback? onConnectMachine,
  VoidCallback? onManageDevices,
  bool reduceMotion = false,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = const Size(1280, 800);
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context).copyWith(disableAnimations: reduceMotion),
        child: child!,
      ),
      home: const Scaffold(body: SizedBox.expand()),
    ),
  );
  unawaited(
    showAddPhoneDialog(
      tester.element(find.byType(Scaffold)),
      app,
      from: from,
      pair: pair,
      signInCode: signInCode ?? _FakeSignIn().call,
      signInUnavailable: signInUnavailable,
      onConnectMachine: onConnectMachine,
      onManageDevices: onManageDevices,
    ),
  );
  await tester.pump();
  await tester.pump();
}

/// The sign-in code's answer, which the QR waits for: the code is up — and
/// armed — from the first frame, and shows once its sign-in code is in.
Future<void> _codeUp(WidgetTester tester) => tester.pump();

String _qrData(WidgetTester tester) =>
    tester.widget<PhonePairQr>(find.byType(PhonePairQr)).data;

/// What went wrong under the code; none while nothing has.
String _status(WidgetTester tester) =>
    tester.widget<Text>(find.byKey(const ValueKey('add-phone-status'))).data!;

/// The download codes on screen: what each one says, other than the pairing
/// code.
List<String> _downloadCodes(WidgetTester tester) => [
  for (final qr in tester.widgetList<QrCodeView>(find.byType(QrCodeView)))
    if (!qr.data.startsWith('https://$kPhonePairHost$kPhonePairPath')) qr.data,
];

/// The phone signing in to the account, as this computer's daemon says it:
/// a `device_key_added` frame, which is what puts up the "New device" band.
///
/// Run outside the fake clock: the frame also re-reads the daemon's pending
/// list, a real request to a loopback port nobody answers here.
Future<void> _joins(
  WidgetTester tester,
  AppNotifier app, {
  String pub = 'pub-phone',
  String label = 'Dee’s iPhone',
  String kind = 'viewer',
}) async {
  app.ownDaemonMachineIdForTest('m');
  await tester.runAsync(
    () => app.handleEventForTest('m', {
      'type': 'device_key_added',
      'payload': {'pub': pub, 'label': label, 'kind': kind},
    }),
  );
}

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

  group('signed in, the code is the dialog', () {
    testWidgets('it is up and armed at once, under one line and the stores — '
        'nothing else to read', (tester) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final signIn = _FakeSignIn();
      final daemon = _FakeDaemon(List.filled(3, _failed('NO_INTENT')));
      await _open(tester, app, daemon.call, signInCode: signIn.call);
      await _codeUp(tester);

      expect(find.text('Add your phone'), findsOneWidget);
      expect(find.byType(PhonePairQr), findsOneWidget);
      expect(
        Uri.splitQueryString(Uri.parse(_qrData(tester)).fragment)['h'],
        'h1',
      );
      expect(find.text('Scan with the Harness mobile app.'), findsOneWidget);
      expect(find.text('No app yet?'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('add-phone-show-downloads')),
          matching: find.text('App Store · Google Play'),
        ),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('add-phone-close')), findsOneWidget);
      // Few words (owner, 2026-10-13): no headline, no steps, no status.
      expect(
        find.text(
          'Manage all your agents on all your computers from your phone.',
        ),
        findsNothing,
      );
      expect(find.text('Install Harness'), findsNothing);
      expect(find.textContaining('Looking for your phone'), findsNothing);
      expect(find.byKey(const ValueKey('add-phone-status')), findsNothing);
      expect(find.text('Cancel'), findsNothing);
      // Armed with the code on screen.
      expect(signIn.minted, 1);
      expect(daemon.codes, hasLength(1));

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
      expect(daemon.tokens.single.isCancelled, isTrue);
    });

    testWidgets('a phone that signs in to the account is ready; Done closes', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      await _open(
        tester,
        app,
        _FakeDaemon(List.filled(3, _failed('NO_INTENT'))).call,
        onManageDevices: () {},
      );
      await _codeUp(tester);
      expect(find.byKey(const ValueKey('add-phone-done')), findsNothing);

      await _joins(tester, app);
      await tester.pump();
      expect(find.byKey(const ValueKey('add-phone-ready')), findsOneWidget);
      expect(find.text('Dee’s iPhone is ready.'), findsOneWidget);
      expect(find.byType(PhonePairQr), findsNothing);
      expect(find.text('Scan with the Harness mobile app.'), findsNothing);
      expect(find.byKey(const ValueKey('add-phone-close')), findsNothing);
      expect(
        find.byKey(const ValueKey('add-phone-see-phones')),
        findsOneWidget,
      );
      // One row across the foot: See your phones at the panel's left edge,
      // Done at its right, both inside the panel's padding.
      final panel = tester
          .getRect(find.byType(DesktopDialogSurface))
          .deflate(DesktopChrome.panelPadding);
      final link = tester.getRect(
        find.byKey(const ValueKey('add-phone-see-phones')),
      );
      final done = tester.getRect(find.byKey(const ValueKey('add-phone-done')));
      expect((link.center.dy - done.center.dy).abs(), lessThan(1));
      expect(link.left, moreOrLessEquals(panel.left, epsilon: 1));
      expect(done.right, moreOrLessEquals(panel.right, epsilon: 1));
      // Nothing moves once the phone is in: the dialog settles.
      await tester.pumpAndSettle();
      expect(find.byType(AddPhoneDialog), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('add-phone-done')));
      await tester.pumpAndSettle();
      expect(find.byType(AddPhoneDialog), findsNothing);
    });

    testWidgets('See your phones closes it and hands Machines to the caller', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      var manage = 0;
      await _open(
        tester,
        app,
        _FakeDaemon(List.filled(3, _failed('NO_INTENT'))).call,
        onManageDevices: () => manage++,
      );
      await _codeUp(tester);
      await _joins(tester, app);
      await tester.pump();
      expect(find.text('See your phones'), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('add-phone-see-phones')));
      await tester.pumpAndSettle();
      expect(manage, 1);
      expect(find.byType(AddPhoneDialog), findsNothing);
    });

    testWidgets('without a way to Machines, ready says so with Done alone', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      await _open(
        tester,
        app,
        _FakeDaemon(List.filled(3, _failed('NO_INTENT'))).call,
      );
      await _codeUp(tester);
      await _joins(tester, app);
      await tester.pump();
      expect(find.byKey(const ValueKey('add-phone-ready')), findsOneWidget);
      expect(find.byKey(const ValueKey('add-phone-see-phones')), findsNothing);
      expect(find.byKey(const ValueKey('add-phone-done')), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
    });

    testWidgets('a computer joining the account is not the phone', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      await _open(
        tester,
        app,
        _FakeDaemon(List.filled(3, _failed('NO_INTENT'))).call,
      );
      await _codeUp(tester);
      await _joins(
        tester,
        app,
        pub: 'pub-mac',
        label: 'Studio Mac',
        kind: 'machine',
      );
      await tester.pump();
      expect(find.byKey(const ValueKey('add-phone-ready')), findsNothing);
      expect(find.byType(PhonePairQr), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    });

    testWidgets('waiting says nothing more: no status after minutes, and '
        'nothing keeps the frames busy', (tester) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      await _open(
        tester,
        app,
        _FakeDaemon(List.filled(200, _failed('NO_INTENT'))).call,
      );
      await _codeUp(tester);
      await tester.pumpAndSettle();
      await tester.pump(const Duration(minutes: 2));
      expect(find.textContaining('Looking'), findsNothing);
      expect(find.textContaining('Still looking'), findsNothing);
      expect(find.byKey(const ValueKey('add-phone-status')), findsNothing);
      expect(find.byType(PhonePairQr), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
    });
  });

  group('a computer with no account', () {
    testWidgets('the sign-in\'s ways in, with no words around them: nothing '
        'is armed and there is no code', (tester) async {
      final app = _signedInApp()..signedIn = false;
      addTearDown(app.dispose);
      final signIn = _FakeSignIn();
      final daemon = _FakeDaemon([]);
      await _open(tester, app, daemon.call, signInCode: signIn.call);
      expect(find.text('Add your phone'), findsOneWidget);
      expect(find.byKey(const Key('login-continue-google')), findsOneWidget);
      expect(find.byKey(const Key('login-continue-apple')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('add-phone-sign-in-email')),
        findsOneWidget,
      );
      expect(find.byKey(const ValueKey('add-phone-cancel')), findsOneWidget);
      expect(find.text('Sign in first'), findsNothing);
      expect(find.text('Scan with the Harness mobile app.'), findsNothing);
      expect(find.byType(PhonePairQr), findsNothing);
      expect(daemon.codes, isEmpty);
      expect(signIn.minted, 0);
      // The phone that signs in meanwhile is not news yet: there is no
      // account here for it to have joined.
      await _joins(tester, app);
      await tester.pump();
      expect(find.byKey(const ValueKey('add-phone-ready')), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    });

    testWidgets('the way pressed says what it waits on; the others stay', (
      tester,
    ) async {
      final app = _signedInApp()..signedIn = false;
      addTearDown(app.dispose);
      await _open(tester, app, _FakeDaemon([]).call);
      app
        ..signingIn = true
        ..signInProvider = SignInProvider.apple
        ..pendingAuthorizeUrl = 'https://auth.example.test/authorize';
      app.notifyListeners();
      await tester.pump();
      expect(
        find.descendant(
          of: find.byKey(const Key('login-continue-apple')),
          matching: find.text('Waiting for your browser'),
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const Key('login-continue-google')),
          matching: find.text('Continue with Google'),
        ),
        findsOneWidget,
      );
      expect(find.byType(PhonePairQr), findsNothing);
      app.signingIn = false;
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    });

    testWidgets('signed in while it is open: the code comes up in the same '
        'dialog, with its sign-in code', (tester) async {
      final app = _signedInApp()..signedIn = false;
      addTearDown(app.dispose);
      final signIn = _FakeSignIn();
      final daemon = _FakeDaemon(List.filled(4, _failed('NO_INTENT')));
      await _open(tester, app, daemon.call, signInCode: signIn.call);
      expect(find.byType(PhonePairQr), findsNothing);

      app.signedIn = true;
      app.notifyListeners();
      await tester.pump();
      await _codeUp(tester);
      expect(find.byKey(const Key('login-continue-google')), findsNothing);
      expect(find.byKey(const ValueKey('add-phone-close')), findsOneWidget);
      expect(find.byType(PhonePairQr), findsOneWidget);
      expect(signIn.minted, 1);
      expect(
        Uri.splitQueryString(Uri.parse(_qrData(tester)).fragment)['h'],
        'h1',
      );
      expect(daemon.codes, hasLength(1));
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    });
  });

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
      await _codeUp(tester);
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
    await _codeUp(tester);
    expect(find.byType(PhonePairQr), findsNothing);
    expect(daemon.codes, isEmpty);
    expect(
      find.text('Your phone pairs with a computer on your account.'),
      findsOneWidget,
    );
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
      await _codeUp(tester);

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

    testWidgets('the stores\' code in its place, the code lets its renewal '
        'lapse; back, a fresh one is asked for', (tester) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final signIn = _FakeSignIn();
      final daemon = _FakeDaemon(List.filled(80, _failed('NO_INTENT')));
      await _open(tester, app, daemon.call, signInCode: signIn.call);
      await _codeUp(tester);
      expect(signIn.minted, 1);

      await tester.tap(find.byKey(const ValueKey('add-phone-show-downloads')));
      await tester.pump();
      expect(find.byType(PhonePairQr), findsNothing);
      final armed = daemon.codes.length;
      await tester.pump(const Duration(minutes: 3));
      expect(signIn.minted, 1, reason: 'no code up, nothing minted');
      expect(
        daemon.codes.length,
        lessThanOrEqualTo(armed + 1),
        reason: 'the loop ends after the answer it was waiting for',
      );

      await tester.tap(find.byKey(const ValueKey('add-phone-hide-downloads')));
      await tester.pump();
      await _codeUp(tester);
      expect(signIn.minted, 2);
      expect(
        Uri.splitQueryString(Uri.parse(_qrData(tester)).fragment)['h'],
        'h2',
      );
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
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
      await _codeUp(tester);
      final fields = Uri.splitQueryString(Uri.parse(_qrData(tester)).fragment);
      expect(fields.keys, ['e', 'm', 'c']);
      expect(fields['c'], daemon.codes.single);
      // An older CLI, or a moment without one: nothing more is said.
      expect(find.byKey(const ValueKey('add-phone-email-code')), findsNothing);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await tester.pump(const Duration(seconds: 10));
    });

    testWidgets(
      'with no sign-in code to be had on this PC, the QR says the phone will ask for an emailed one',
      (tester) async {
        final app = _signedInApp();
        addTearDown(app.dispose);
        final daemon = _FakeDaemon(List.filled(10, _failed('NO_INTENT')));
        var unavailable = true;
        final signIn = _FakeSignIn(available: false);
        await _open(
          tester,
          app,
          daemon.call,
          signInCode: () => unavailable ? signIn.call() : _FakeSignIn().call(),
          signInUnavailable: () => unavailable,
        );
        await _codeUp(tester);
        expect(Uri.splitQueryString(Uri.parse(_qrData(tester)).fragment).keys, [
          'e',
          'm',
          'c',
        ]);
        expect(
          tester
              .widget<Text>(find.byKey(const ValueKey('add-phone-email-code')))
              .data,
          'Your phone will ask for a code from your email.',
        );
        // Still the QR to scan, as with an older CLI.
        expect(find.text('Scan with the Harness mobile app.'), findsOneWidget);

        // The pipe is back by the next renewal: the code is in the QR, the sentence gone.
        unavailable = false;
        await tester.pump(const Duration(seconds: 61));
        await tester.pump();
        expect(
          Uri.splitQueryString(Uri.parse(_qrData(tester)).fragment)['h'],
          'h1',
        );
        expect(
          find.byKey(const ValueKey('add-phone-email-code')),
          findsNothing,
        );

        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        await tester.pump(const Duration(seconds: 10));
      },
    );
  });

  group('arming the daemon', () {
    testWidgets('retries while no phone is waiting; paired, it is ready', (
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
      await _codeUp(tester);

      expect(daemon.codes, hasLength(1), reason: 'armed with the code up');
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
      expect(find.text('Scan with the Harness mobile app.'), findsOneWidget);
      expect(find.byKey(const ValueKey('add-phone-status')), findsNothing);

      await tester.pump(const Duration(milliseconds: 1500));
      expect(daemon.codes, [code, code]);
      await tester.pump(const Duration(milliseconds: 1500));
      expect(daemon.codes, [code, code, code]);
      await tester.pump();
      expect(find.text('Dee’s iPhone is ready.'), findsOneWidget);
      expect(find.byType(PhonePairQr), findsNothing);

      // It stays, saying so, until Done.
      await tester.pump(const Duration(seconds: 5));
      expect(find.byType(AddPhoneDialog), findsOneWidget);
      expect(daemon.codes, hasLength(3));
      await tester.tap(find.byKey(const ValueKey('add-phone-done')));
      await tester.pumpAndSettle();
      expect(find.byType(AddPhoneDialog), findsNothing);
    });

    testWidgets('a code that did not match is replaced quietly, QR and all', (
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
      await _codeUp(tester);
      await tester.pump();
      final first = daemon.codes.single;
      // Most often a phone already in, pairing late by an earlier dialog's
      // code: nothing for the person to do here, so nothing in red.
      expect(find.byKey(const ValueKey('add-phone-status')), findsNothing);
      expect(find.textContaining("didn't work"), findsNothing);
      expect(_qrData(tester), isNot(contains('c=$first')));

      await tester.pump(const Duration(milliseconds: 1500));
      expect(daemon.codes, hasLength(2));
      final second = daemon.codes.last;
      expect(second, isNot(first));
      expect(_qrData(tester), contains('c=$second&'));
      await tester.pump();
      expect(find.byKey(const ValueKey('add-phone-status')), findsNothing);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
      expect(daemon.tokens.last.isCancelled, isTrue);
      await tester.pump(const Duration(seconds: 10));
      expect(daemon.codes, hasLength(2), reason: 'nothing asks after closing');
    });

    testWidgets('a mismatch also takes away what an earlier answer said', (
      tester,
    ) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final daemon = _FakeDaemon([
        _failed('TIMEOUT'),
        _failed('CODE_MISMATCH'),
        _failed('NO_INTENT'),
      ]);
      await _open(tester, app, daemon.call);
      await _codeUp(tester);
      await tester.pump();
      expect(_status(tester), 'Your phone stopped answering. Scan again.');

      await tester.pump(const Duration(milliseconds: 1500));
      await tester.pump();
      expect(daemon.codes, hasLength(2));
      expect(find.byKey(const ValueKey('add-phone-status')), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
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
      await _codeUp(tester);
      await tester.pump();
      expect(_status(tester), 'Too many tries. Wait a minute.');
      await tester.pump(const Duration(seconds: 59));
      expect(daemon.codes, hasLength(1));
      await tester.pump(const Duration(seconds: 1));
      await tester.pump();
      expect(daemon.codes, hasLength(2));
      // A condition, not an instruction: it goes when the condition does.
      expect(find.byKey(const ValueKey('add-phone-status')), findsNothing);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
    });

    testWidgets('a daemon that cannot pair stops the loop', (tester) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      final daemon = _FakeDaemon([_failed(PhonePairAnswer.unavailable)]);
      await _open(tester, app, daemon.call);
      await _codeUp(tester);
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
      await _codeUp(tester);
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
  });

  group('App Store · Google Play', () {
    testWidgets('one code, for either store, in the Harness code\'s place; '
        'Back brings it back', (tester) async {
      final app = _signedInApp();
      addTearDown(app.dispose);
      await _open(
        tester,
        app,
        _FakeDaemon(List.filled(5, _failed('NO_INTENT'))).call,
      );
      await _codeUp(tester);
      expect(_downloadCodes(tester), isEmpty);
      // Named by its stores, not "Get Harness", which in the computer's own
      // Harness read as this app's download.
      final open = find.byKey(const ValueKey('add-phone-show-downloads'));
      expect(
        find.descendant(
          of: open,
          matching: find.text('App Store · Google Play'),
        ),
        findsOneWidget,
      );
      await tester.tap(open);
      await tester.pump();

      // One code: the website's, which sends an iPhone to the App Store and
      // an Android phone to Google Play. One kind of code on screen at a
      // time: the Harness code goes while it is up.
      expect(_downloadCodes(tester), ['https://harness.autonomous.ai/app']);
      expect(kPhoneAppUrl, 'https://harness.autonomous.ai/app');
      expect(find.byType(PhonePairQr), findsNothing);
      expect(
        find.bySemanticsLabel(
          'QR code for Harness on the App Store or Google Play',
        ),
        findsOneWidget,
      );
      // Both stores named under it, so nobody wonders whether theirs is one.
      expect(find.text('App Store'), findsOneWidget);
      expect(find.text('Google Play'), findsOneWidget);
      expect(
        tester.getTopLeft(find.text('App Store')).dy,
        greaterThan(tester.getBottomLeft(find.byType(QrCodeView)).dy),
      );
      // Few words: no heading or caption of its own; Close stays.
      expect(find.text('Get Harness on your phone'), findsNothing);
      expect(find.text('Scan with the Harness mobile app.'), findsNothing);
      expect(find.byKey(const ValueKey('add-phone-close')), findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('add-phone-hide-downloads')));
      await tester.pump();
      await _codeUp(tester);
      expect(_downloadCodes(tester), isEmpty);
      expect(find.byType(PhonePairQr), findsOneWidget);

      // Esc, over the store's code, closes the dialog.
      await tester.tap(open);
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
    });
  });

  for (final from in AddPhoneOpening.values) {
    testWidgets('new phones count once per device from ${from.name}', (
      tester,
    ) async {
      final usage = AddPhoneRecorder();
      final app = createApp(productMeasurement: usage)
        ..status = AppStatus.authenticated
        ..signedIn = true
        ..currentUser = const CurrentUserProfile(
          id: 'a',
          email: 'a@example.test',
        )
        ..api = _DeviceSnapshotApi(
          listing: {
            'members': [
              {
                'pub': 'existing',
                'label': 'Existing phone',
                'kind': 'viewer',
                'addedAt': 1,
                'fingerprint': 'fp',
                'self': false,
              },
            ],
          },
        );
      addTearDown(app.dispose);
      // A completed handshake alone can be a phone that was already on the account.
      final daemon = _FakeDaemon([() => const PhonePairAnswer.paired('Phone')]);
      await _open(tester, app, daemon.call, from: from);
      await _codeUp(tester);
      expect(usage.pairings, isEmpty);
      await _joins(tester, app, pub: 'existing');
      await _joins(tester, app, pub: 'computer', kind: 'machine');
      await tester.pump();
      expect(usage.pairings, isEmpty);
      await _joins(tester, app, pub: 'new-one');
      await tester.pump();
      expect(usage.pairings, [from]);
      // Remove the banner so the same real notice is emitted again.
      app.newDevices.clear();
      await _joins(tester, app, pub: 'new-one');
      app.notifyListeners();
      await tester.pump();
      expect(usage.pairings, [from]);
      await _joins(tester, app, pub: 'new-two');
      await tester.pump();
      expect(usage.pairings, [from, from]);
      app.currentUser = const CurrentUserProfile(
        id: 'b',
        email: 'b@example.test',
      );
      await _joins(tester, app, pub: 'another-account');
      await tester.pump();
      expect(usage.pairings, [from, from]);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      await _joins(tester, app, pub: 'closed');
      expect(usage.pairings, [from, from]);
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets(
    'an unreadable opening snapshot leaves pairing attribution unknown',
    (tester) async {
      final usage = AddPhoneRecorder();
      final app = createApp(productMeasurement: usage)
        ..status = AppStatus.authenticated
        ..signedIn = true
        ..currentUser = const CurrentUserProfile(
          id: 'a',
          email: 'a@example.test',
        )
        ..api = _DeviceSnapshotApi(fails: true);
      addTearDown(app.dispose);
      final daemon = _FakeDaemon(List.filled(3, _failed('NO_INTENT')));
      await _open(tester, app, daemon.call, from: AddPhoneOpening.offer);
      await _joins(tester, app);
      await tester.pump();
      expect(find.text('Dee’s iPhone is ready.'), findsOneWidget);
      expect(usage.pairings, isEmpty);
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets('a phone joining an open menu dialog counts its source once', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final messenger = tester.binding.defaultBinaryMessenger;
    messenger.setMockMethodCallHandler(channel, (_) async => true);
    addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
    final usage = AddPhoneRecorder();
    final app = createApp(productMeasurement: usage)
      ..status = AppStatus.authenticated
      ..signedIn = true
      ..api = _DeviceSnapshotApi()
      ..currentUser = const CurrentUserProfile(
        id: 'a',
        email: 'a@example.test',
      );
    addTearDown(app.dispose);
    await mount(tester, app, nativeTabs: true);
    messenger.handlePlatformMessage(
      channel.name,
      const StandardMethodCodec().encodeMethodCall(
        const MethodCall('addPhone'),
      ),
      (_) {},
    );
    await tester.pump();
    await tester.pump(const Duration(milliseconds: 100));
    expect(find.byType(AddPhoneDialog), findsOneWidget);
    await _joins(tester, app);
    await tester.pump();
    expect(usage.pairings, [AddPhoneOpening.menu]);
    await _joins(tester, app);
    app.notifyListeners();
    await tester.pump();
    expect(usage.pairings, [AddPhoneOpening.menu]);
    await tester.sendKeyEvent(LogicalKeyboardKey.escape);
    await tester.pump();
    await _joins(tester, app, pub: 'after-close');
    expect(usage.pairings, [AddPhoneOpening.menu]);
    await tester.pumpWidget(const SizedBox());
  });

  group('the way in', () {
    // `createApp` has no profile and no local machine, so the dialog opens
    // with nothing to arm — these tests never reach for a real daemon.
    // Each way in is counted as its own (`ui_desktop_add_phone_<way>`).
    for (final (name, arguments, from) in [
      ('Harness ▸ Add Phone…', null, AddPhoneOpening.menu),
      (
        'The native title bar\'s phone',
        {'from': 'titlebar'},
        AddPhoneOpening.titlebar,
      ),
    ]) {
      testWidgets('$name opens the dialog', (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        final messenger = tester.binding.defaultBinaryMessenger;
        messenger.setMockMethodCallHandler(channel, (_) async => true);
        addTearDown(() => messenger.setMockMethodCallHandler(channel, null));
        final usage = AddPhoneRecorder();
        final app = createApp(productMeasurement: usage)
          ..status = AppStatus.authenticated;
        addTearDown(app.dispose);
        await mount(tester, app, nativeTabs: true);

        final handled = Completer<void>();
        messenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('addPhone', arguments),
          ),
          (_) => handled.complete(),
        );
        await tester.pump();
        await tester.pump(const Duration(milliseconds: 100));
        expect(find.byType(AddPhoneDialog), findsOneWidget);
        expect(find.text('Add your phone'), findsOneWidget);
        expect(usage.openings, [from]);

        // Asked again while it is open: refused, so not counted.
        messenger.handlePlatformMessage(
          channel.name,
          const StandardMethodCodec().encodeMethodCall(
            MethodCall('addPhone', arguments),
          ),
          (_) {},
        );
        await tester.pump();
        expect(usage.openings, [from]);

        await tester.sendKeyEvent(LogicalKeyboardKey.escape);
        await tester.pump();
        await handled.future;
        expect(find.byType(AddPhoneDialog), findsNothing);
        await tester.pumpWidget(const SizedBox());
      });
    }

    testWidgets('> add phone opens the dialog from the command search', (
      tester,
    ) async {
      final usage = AddPhoneRecorder();
      final app = createApp(productMeasurement: usage)
        ..status = AppStatus.authenticated;
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
      expect(usage.openings, [AddPhoneOpening.command]);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the tab row\'s Add Phone opens the dialog', (tester) async {
      final usage = AddPhoneRecorder();
      final app = createApp(productMeasurement: usage)
        ..status = AppStatus.authenticated;
      addTearDown(app.dispose);
      await mount(tester, app);
      await tester.tap(find.byKey(const ValueKey('swarm-add-phone-button')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.byType(AddPhoneDialog), findsOneWidget);
      expect(usage.openings, [AddPhoneOpening.titlebar]);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
      await tester.pumpWidget(const SizedBox());
    });

    testWidgets('the account menu\'s Add Phone opens the dialog', (
      tester,
    ) async {
      final usage = AddPhoneRecorder();
      final app = createApp(productMeasurement: usage)
        ..currentUser = const CurrentUserProfile(
          name: 'Dee Example',
          email: 'dee@example.com',
        );
      addTearDown(app.dispose);
      await mount(tester, app);
      await tester.tap(find.byKey(const ValueKey('swarm-account-button')));
      await tester.pump();
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('account-menu-addPhone')));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      expect(find.byType(AddPhoneDialog), findsOneWidget);
      expect(usage.openings, [AddPhoneOpening.account]);

      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pump();
      expect(find.byType(AddPhoneDialog), findsNothing);
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 5));
    });
  });
}
