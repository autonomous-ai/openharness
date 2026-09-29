import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/auth/cli_link.dart';
import 'package:harness/auth/peer_link_client.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/viewer/connect_code.dart';
import 'package:harness/widgets/add_machine_dialog.dart';

class _Links implements PeerLinkClient {
  final calls = <(String, String, String?)>[];
  String? error;

  @override
  Future<CliLinkConnectResult> connectWithCode(
    String machineId,
    String code, {
    required String label,
    String? displayName,
    String? expectedFingerprint,
  }) async {
    calls.add((machineId, code, expectedFingerprint));
    return error == null
        ? CliLinkConnectResult(linkedMachineId: machineId)
        : CliLinkConnectResult(error: error);
  }

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
  }) async => const CliLinkConnectResult(error: 'not used');

  @override
  Future<CliLinkListResult> list() async => const CliLinkListResult();

  @override
  Future<String?> unlink(String machineId) async => null;
}

final _id = 'b' * 32;

/// The backend's side of a browser's sign-in, as the approving device sees it.
class _Api extends ApiClient {
  _Api({this.pub, this.viewer = true})
    : super(config: AppConfig.dev, session: AuthSession());
  final String? pub;
  final bool viewer;
  var denied = 0;
  @override
  Future<MachineSignInRequest> lookupMachineSignIn(String userCode) async =>
      MachineSignInRequest(
        label: viewer ? 'Chrome on macOS' : 'box2',
        viewer: viewer,
        fingerprint: 'AB12CD34EF567890',
        country: 'VN',
        pub: pub,
      );
  @override
  Future<void> denyMachineSignIn(String userCode) async => denied++;
}

/// The group handoff, faked: its real work (sealing, the roster, the sync) is tested where it lives.
class _Approver extends AppNotifier {
  _Approver(PeerLinkClient links, {this.error})
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        peerLinks: links,
      );
  final String? error;
  final calls = <(String, String, String, String?, bool)>[];
  @override
  Future<({String? error, int machines, String? machineId})> approveSignInByQr({
    required String userCode,
    required String code,
    required String pub,
    required String label,
    String? qrFingerprint,
    bool machine = false,
  }) async {
    calls.add((userCode, code, pub, qrFingerprint, machine));
    return (error: error, machines: 2, machineId: machine ? 'c' * 32 : null);
  }
}

ConnectCode _browserCode() => ConnectCode.parse(
  ConnectCode.signInLink(
    'U' * 26,
    pairCode: 'ABCDEFGHJKMNPQRS',
    fingerprint: 'AB12CD34EF567890',
    hostname: 'Chrome on macOS',
    viewer: true,
  ),
)!;

AppNotifier _app(_Links links, {String email = 'dee@x.ai'}) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: null,
    peerLinks: links,
  )..currentUser = CurrentUserProfile(email: email);
  final machine = Machine(
    machineId: _id,
    name: 'machine-remote-2',
    authMode: MachineAuthMode.remote,
  );
  app.machineStates[_id] = MachineState(machine)
    ..nodeOnline = true
    ..needsLink = true;
  return app;
}

ConnectCode _code({String email = 'dee@x.ai'}) => ConnectCode.parse(
  ConnectCode.link(
    email,
    machineId: _id,
    pairCode: 'ABCDEFGHJKMNPQRS',
    fingerprint: '5F8061C46142ADCF',
    hostname: 'box2.local',
  ),
)!;

Future<void> _open(
  WidgetTester tester,
  AppNotifier app,
  ConnectCode code, {
  bool expired = false,
}) async {
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () =>
                showAddMachineDialog(context, app, code, expired: expired),
            child: const Text('open'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('open'));
  await tester.pumpAndSettle();
}

String _text(WidgetTester tester, String key) =>
    tester.widget<Text>(find.byKey(Key(key))).data!;

void main() {
  testWidgets('shows what the code is for, and links only once approved', (
    tester,
  ) async {
    final links = _Links();
    final app = _app(links);
    addTearDown(app.dispose);
    await _open(tester, app, _code());
    expect(_text(tester, 'add-machine-title'), 'Add this machine?');
    expect(
      _text(tester, 'add-machine-fingerprint'),
      contains('5F80·61C4·6142·ADCF'),
    );
    expect(find.text('box2.local'), findsOneWidget);
    expect(links.calls, isEmpty);

    await tester.tap(find.byKey(const Key('add-machine-approve')));
    await tester.pumpAndSettle();
    expect(links.calls, [(_id, 'ABCDEFGHJKMNPQRS', '5F8061C46142ADCF')]);
    expect(_text(tester, 'add-machine-title'), 'Machine added');
    expect(app.machineStates[_id]!.needsLink, isFalse);
  });

  testWidgets(
    'a code for another account is refused before anything is asked',
    (tester) async {
      final links = _Links();
      final app = _app(links, email: 'ann@x.ai');
      addTearDown(app.dispose);
      await _open(tester, app, _code(email: 'dee@x.ai'));
      expect(
        _text(tester, 'add-machine-status'),
        contains('Signed in as ann@x.ai'),
      );
      expect(find.byKey(const Key('add-machine-approve')), findsNothing);
      expect(links.calls, isEmpty);
    },
  );

  testWidgets('a code that waited too long says to scan again', (tester) async {
    final links = _Links();
    final app = _app(links);
    addTearDown(app.dispose);
    await _open(tester, app, _code(), expired: true);
    expect(_text(tester, 'add-machine-status'), contains('expired'));
    expect(find.byKey(const Key('add-machine-approve')), findsNothing);
  });

  testWidgets('a failed link is said, with nothing marked linked', (
    tester,
  ) async {
    final links = _Links()
      ..error =
          'That machine’s fingerprint doesn’t match its code. Nothing was linked.';
    final app = _app(links);
    addTearDown(app.dispose);
    await _open(tester, app, _code());
    await tester.tap(find.byKey(const Key('add-machine-approve')));
    await tester.pumpAndSettle();
    expect(
      _text(tester, 'add-machine-status'),
      contains('fingerprint doesn’t match'),
    );
    expect(app.machineStates[_id]!.needsLink, isTrue);
  });

  testWidgets(
    'a browser\'s sign-in QR: approve signs it in and hands it this device\'s group',
    (tester) async {
      final app = _Approver(_Links())
        ..currentUser = const CurrentUserProfile(email: 'dee@x.ai')
        ..api = _Api(pub: 'PUB=');
      addTearDown(app.dispose);
      await _open(tester, app, _browserCode());
      expect(_text(tester, 'add-machine-title'), 'Sign in this browser?');
      expect(find.text('Chrome on macOS'), findsOneWidget);
      expect(
        _text(tester, 'add-machine-warning'),
        contains('browser you are using'),
      );
      expect(
        _text(tester, 'add-machine-status'),
        contains('joins your devices'),
      );

      await tester.tap(find.byKey(const Key('add-machine-approve')));
      await tester.pumpAndSettle();
      expect(app.calls, [
        ('U' * 26, 'ABCDEFGHJKMNPQRS', 'PUB=', 'AB12CD34EF567890', false),
      ]);
      expect(_text(tester, 'add-machine-title'), 'Browser signed in');
      expect(_text(tester, 'add-machine-status'), contains('your 2 machines'));
    },
  );

  testWidgets('a browser whose key does not match its QR is refused', (
    tester,
  ) async {
    final app = _Approver(_Links(), error: 'FINGERPRINT')
      ..currentUser = const CurrentUserProfile(email: 'dee@x.ai')
      ..api = _Api(pub: 'PUB=');
    addTearDown(app.dispose);
    await _open(tester, app, _browserCode());
    await tester.tap(find.byKey(const Key('add-machine-approve')));
    await tester.pumpAndSettle();
    expect(_text(tester, 'add-machine-status'), contains("doesn't match"));
  });

  testWidgets('an old sign-in page, with no key to take in, is not approved', (
    tester,
  ) async {
    final app = _Approver(_Links())
      ..currentUser = const CurrentUserProfile(email: 'dee@x.ai')
      ..api = _Api();
    addTearDown(app.dispose);
    await _open(tester, app, _browserCode());
    await tester.tap(find.byKey(const Key('add-machine-approve')));
    await tester.pumpAndSettle();
    expect(app.calls, isEmpty);
    expect(_text(tester, 'add-machine-status'), contains('too old'));
  });

  testWidgets('"Not me" declines a browser\'s request', (tester) async {
    final api = _Api(pub: 'PUB=');
    final app = _Approver(_Links())
      ..currentUser = const CurrentUserProfile(email: 'dee@x.ai')
      ..api = api;
    addTearDown(app.dispose);
    await _open(tester, app, _browserCode());
    await tester.tap(find.byKey(const Key('add-machine-not-me')));
    await tester.pumpAndSettle();
    expect(api.denied, 1);
    expect(app.calls, isEmpty);
    expect(_text(tester, 'add-machine-status'), contains('browser was not'));
  });

  testWidgets(
    'a machine\'s sign-in QR goes the same way: approve hands it the group, no dial',
    (tester) async {
      final links = _Links();
      final app = _Approver(links)
        ..currentUser = const CurrentUserProfile(email: 'dee@x.ai')
        ..api = _Api(pub: 'PUB=', viewer: false);
      addTearDown(app.dispose);
      final code = ConnectCode.parse(
        ConnectCode.signInLink(
          'U' * 26,
          pairCode: 'ABCDEFGHJKMNPQRS',
          fingerprint: 'AB12CD34EF567890',
          hostname: 'box2',
        ),
      )!;
      await _open(tester, app, code);
      expect(_text(tester, 'add-machine-title'), 'Sign in & add machine?');
      await tester.tap(find.byKey(const Key('add-machine-approve')));
      await tester.pumpAndSettle();
      expect(app.calls, [
        ('U' * 26, 'ABCDEFGHJKMNPQRS', 'PUB=', 'AB12CD34EF567890', true),
      ]);
      // The keys changed hands in the approval: nothing waits for the machine, nothing dials it.
      expect(links.calls, isEmpty);
      expect(_text(tester, 'add-machine-title'), 'Machine added');
      expect(_text(tester, 'add-machine-status'), contains('your 2 machines'));
    },
  );
}
