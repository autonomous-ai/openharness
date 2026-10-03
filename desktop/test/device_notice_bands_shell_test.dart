import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_login.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/account_devices.dart'
    as model
    show DeviceConflict, NewDeviceNotice;
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/device_history.dart';

/// The window's device bands are mounted by the shell itself (app_shell.dart), above whatever screen
/// is showing — a band that is built but never mounted would leave a departed key unseen.
class _SignedOutCli extends CliLogin {
  @override
  Future<void> logout() async {}

  @override
  Future<CliAuthStatus> checkStatus() async => CliAuthStatus(loggedIn: false);
}

/// "Got it" writes the dismissal to the daemon; nothing here should reach a network.
class _QuietApi extends ApiClient {
  _QuietApi() : super(config: AppConfig.dev, session: AuthSession());

  @override
  Future<bool> daemonDismissDevices({
    String? pub,
    List<String>? pubs,
    bool baseline = false,
  }) async => true;
}

AppNotifier _app(AppStatus status) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    cliLogin: _SignedOutCli(),
  );
  app.status = status;
  app.currentUser = const CurrentUserProfile(
    id: 'user-1',
    name: 'Sam',
    email: 'sam@example.com',
  );
  return app;
}

const _departed = DeviceLogDeparted(
  pub: 'gone',
  label: 'Phone',
  kind: 'viewer',
  machineId: '',
  fingerprint: 'AAAA',
  addedAt: 1,
  removedAt: 2,
  removedBy: 'gone',
  removedByLabel: 'Phone',
  selfRemoved: true,
);

Future<void> _pump(WidgetTester tester, AppNotifier app) async {
  await tester.pumpWidget(
    ProviderScope(
      overrides: [appStateProvider.overrideWithValue(app)],
      child: HarnessApp(
        authenticatedScreen: (_) => const SizedBox(key: Key('screen')),
      ),
    ),
  );
  await tester.pump();
}

void main() {
  DeviceRemovalNotice removal(String pub, {required bool self}) =>
      DeviceRemovalNotice(
        pub: pub,
        label: 'Phone',
        kind: 'viewer',
        fingerprint: 'AAAA',
        signer: self ? pub : 'signer',
        signerLabel: self ? 'Phone' : 'MacBook',
        signerFingerprint: 'E2FB',
        signerPending: false,
        selfRemoved: self,
        at: 1,
      );

  testWidgets(
    'a key that signed itself out and also left unseen is told once: only the departed band shows',
    (tester) async {
      final app = _app(AppStatus.authenticated)
        ..deviceRemovals.add(removal('gone', self: true))
        ..departedDevices.add(_departed)
        ..api = _QuietApi();
      addTearDown(app.dispose);
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await _pump(tester, app);
      expect(find.byKey(const Key('device-departed-notice')), findsOneWidget);
      expect(find.byKey(const Key('device-removal-notice')), findsNothing);
      // Held back, not dismissed: the departed band's Got it is the one dismissal — and it takes the held
      // sign-out notice with it, so that notice does not surface in its place.
      expect(app.deviceRemovals, hasLength(1));
      await tester.tap(find.byKey(const Key('device-departed-dismiss')));
      await tester.pump();
      expect(app.deviceRemovals, isEmpty);
      expect(find.byKey(const Key('device-departed-notice')), findsNothing);
      expect(find.byKey(const Key('device-removal-notice')), findsNothing);
    },
  );

  testWidgets(
    'the removal band still shows another key\'s sign-out and a removal by someone else of a departed key',
    (tester) async {
      final app = _app(AppStatus.authenticated)
        ..deviceRemovals.addAll([
          removal('other', self: true),
          removal('gone', self: false),
        ])
        ..departedDevices.add(_departed)
        ..api = _QuietApi();
      addTearDown(app.dispose);
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await _pump(tester, app);
      expect(find.byKey(const Key('device-removal-notice')), findsOneWidget);
      expect(find.textContaining('(+1 more)'), findsOneWidget);
      expect(find.byKey(const Key('device-departed-notice')), findsOneWidget);
      // The departed band's Got it takes only a key's own sign-out notice with it: someone else's removal
      // of that key is its own news.
      await tester.tap(find.byKey(const Key('device-departed-dismiss')));
      await tester.pump();
      expect(app.deviceRemovals.map((n) => n.pub), ['other', 'gone']);
      expect(find.textContaining('(+1 more)'), findsOneWidget);
    },
  );

  testWidgets(
    'a key that joined and left before anyone looked is shown by the window itself',
    (tester) async {
      final app = _app(AppStatus.authenticated)..departedDevices.add(_departed);
      addTearDown(app.dispose);
      await _pump(tester, app);
      expect(find.byKey(const Key('screen')), findsOneWidget);
      expect(find.byKey(const Key('device-departed-notice')), findsOneWidget);
      expect(find.byKey(const Key('device-departed-dismiss')), findsOneWidget);
    },
  );

  testWidgets('the departed band waits for the signed-in window', (
    tester,
  ) async {
    final app = _app(AppStatus.bootstrapping)..departedDevices.add(_departed);
    addTearDown(app.dispose);
    await _pump(tester, app);
    expect(find.byKey(const Key('device-departed-notice')), findsNothing);

    app.status = AppStatus.authenticated;
    app.notifyListeners();
    await tester.pump();
    expect(find.byKey(const Key('device-departed-notice')), findsOneWidget);
  });

  testWidgets('nothing departed: no band', (tester) async {
    final app = _app(AppStatus.authenticated);
    addTearDown(app.dispose);
    await _pump(tester, app);
    expect(find.byKey(const Key('screen')), findsOneWidget);
    expect(find.byKey(const Key('device-departed-notice')), findsNothing);
  });

  testWidgets(
    'the bands stack removal → departed → new device → conflict, top to bottom',
    (tester) async {
      final app = _app(AppStatus.authenticated)
        ..deviceRemovals.add(
          const DeviceRemovalNotice(
            pub: 'rm',
            label: 'Old iPad',
            kind: 'viewer',
            fingerprint: 'AAAA',
            signer: 'signer',
            signerLabel: 'MacBook',
            signerFingerprint: 'E2FB',
            signerPending: false,
            selfRemoved: false,
            at: 1,
          ),
        )
        ..departedDevices.add(_departed)
        ..newDevices.add(
          const model.NewDeviceNotice(
            pub: 'new',
            label: 'Evil Phone',
            kind: 'viewer',
          ),
        )
        ..deviceConflict = model.DeviceConflict(
          pub: 'holder',
          label: 'Old install',
          fingerprint: 'AAAA·BBBB',
          addedAt: DateTime(2026, 9, 1),
          afterJoin: false,
        );
      addTearDown(app.dispose);
      tester.view.physicalSize = const Size(1200, 900);
      tester.view.devicePixelRatio = 1;
      addTearDown(tester.view.reset);
      await _pump(tester, app);
      double top(String key) => tester.getTopLeft(find.byKey(Key(key))).dy;
      final order = [
        top('device-removal-notice'),
        top('device-departed-notice'),
        top('new-device-notice'),
        top('device-conflict-notice'),
      ];
      expect(
        order,
        orderedEquals([...order]..sort()),
        reason: 'top to bottom: $order',
      );
      expect(order.toSet(), hasLength(4));
    },
  );
}
