import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/auth/cli_link.dart';
import 'package:harness_mobile/auth/peer_link_client.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/welcome/connect_code.dart';
import 'package:harness_mobile/phone/welcome/connect_computer.dart';
import 'package:harness_mobile/phone/welcome/scan_to_connect.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'viewer_app_fixture.dart' show FakeApi;

class _Links implements PeerLinkClient {
  final codes = <(String, String)>[];

  @override
  Future<CliLinkConnectResult> connectWithCode(
    String machineId,
    String code, {
    required String label,
    String? displayName,
  }) async {
    codes.add((machineId, code));
    return CliLinkConnectResult(linkedMachineId: machineId);
  }

  @override
  Future<CliLinkConnectResult> connect(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
    String? displayName,
    String? label,
  }) async => const CliLinkConnectResult(error: 'not used');

  @override
  Future<CliLinkListResult> list() async =>
      const CliLinkListResult(machines: []);

  @override
  Future<String?> unlink(String machineId) async => null;
}

/// Computers ▸ "Or scan the QR code on your computer": the camera, for a desktop from before the
/// onboarding of 2026-10-12 that still pairs a phone by its Add Phone code — the computer it names
/// looked up on the account, and paired with by the code ([scanAndPairComputer]).
void main() {
  late _Links links;
  late AppNotifier app;
  late List<String?> said;
  late List<bool> paired;

  setUp(() {
    links = _Links();
    app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      peerLinks: links,
    );
    // The account's REST API, answered in memory: its machines are asked for again before a
    // scanned computer is looked for, and none is on it unless a test says so.
    app.api = FakeApi();
    said = [];
    paired = [];
  });
  tearDown(() => app.dispose());

  /// A page with the button that scans, as Computers has it.
  Future<void> pump(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(430, 932);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: TextButton(
                key: const ValueKey('scan'),
                onPressed: () async => paired.add(
                  await scanAndPairComputer(
                    context,
                    app,
                    say: (message, {failed = false}) =>
                        said.add(failed ? '✗ $message' : message),
                    camera: const SizedBox(),
                  ),
                ),
                child: const Text('Scan'),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  Future<void> scan(WidgetTester tester, String link) async {
    await tester.tap(find.byKey(const ValueKey('scan')));
    await tester.pumpAndSettle();
    tester
        .widget<ScanToConnectPage>(find.byType(ScanToConnectPage))
        .onCode(ConnectCode.parse(link)!);
    await tester.pumpAndSettle();
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 6));
  }

  testWidgets('the computer\'s code pairs it, and says so on the way', (
    tester,
  ) async {
    const studio = Machine(
      machineId: 'studio',
      authMode: MachineAuthMode.remote,
      name: 'studio',
    );
    app.machines = [studio];
    app.machineStates['studio'] = MachineState(studio)
      ..nodeOnline = true
      ..needsLink = true;
    await pump(tester);
    await scan(
      tester,
      ConnectCode.link('a@b.co', machineId: 'studio', pairCode: 'K7QM4XPT'),
    );
    expect(links.codes, [('studio', 'K7QM4XPT')]);
    expect(said, ['Pairing…', null]);
    expect(paired, [true]);
    await unmount(tester);
  });

  testWidgets('a code that is not Add Phone\'s is said to be so', (
    tester,
  ) async {
    await pump(tester);
    await scan(tester, ConnectCode.link('a@b.co'));
    expect(links.codes, isEmpty);
    expect(said, ['✗ That’s not the Add Phone code.']);
    expect(paired, [false]);
    await unmount(tester);
  });

  testWidgets('a computer on another account is refused, and says so', (
    tester,
  ) async {
    await pump(tester);
    await scan(
      tester,
      ConnectCode.link('a@b.co', machineId: 'elsewhere', pairCode: 'K7QM4XPT'),
    );
    // The account is asked for its list again first, and given five seconds.
    await tester.pump(const Duration(seconds: 6));
    await tester.pump();
    expect(links.codes, isEmpty);
    expect(said.last, contains("isn't on your account"));
    expect(paired, [false]);
    await unmount(tester);
  });

  testWidgets('an account that cannot be read is said, not left pairing', (
    tester,
  ) async {
    (app.api as FakeApi).onMachines = () async =>
        throw StateError('The network connection was lost.');
    await pump(tester);
    await scan(
      tester,
      ConnectCode.link('a@b.co', machineId: 'studio', pairCode: 'K7QM4XPT'),
    );
    await tester.pump();
    expect(links.codes, isEmpty);
    expect(said.last, contains("Couldn't reach your account"));
    expect(paired, [false]);
    await unmount(tester);
  });
}
