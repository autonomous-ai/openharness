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
import 'package:harness_mobile/phone/welcome/set_up_computer.dart';
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

/// Setting up a computer from a signed-in phone is the first screen's Connect your computer, plus
/// what only a signed-in phone can do there: watch for the computer, and pair with it by its code.
void main() {
  late _Links links;
  late AppNotifier app;
  late List<bool> backs;
  late int samples;

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
    backs = [];
    samples = 0;
  });
  tearDown(() => app.dispose());

  Future<void> pump(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(430, 1400);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        home: ConnectComputerPage(
          notifier: app,
          onBack: () => backs.add(true),
          onTrySample: (_) async {
            samples++;
            return null;
          },
          scanCamera: const SizedBox(),
        ),
      ),
    );
    await tester.pump();
  }

  Future<void> scan(WidgetTester tester, String link) async {
    await tester.tap(find.byKey(const ValueKey('set-up-scan')));
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

  testWidgets('Connect your computer, watching, and Get it behind it', (
    tester,
  ) async {
    await pump(tester);
    expect(find.byType(SetUpComputerPage), findsOneWidget);
    expect(find.text('Connect your computer'), findsOneWidget);
    expect(find.text('Waiting for your computer…'), findsOneWidget);
    // The sample is Get it's, for somebody waiting on the computer to install — not this page's.
    expect(find.byKey(const ValueKey('get-it-sample')), findsNothing);
    // The old page's second way of saying all this is gone.
    expect(find.text('Email me the setup link'), findsNothing);
    expect(find.textContaining('remote-password'), findsNothing);

    // No Harness yet: the download to send, and the sample to try meanwhile.
    await tester.tap(find.byKey(const ValueKey('set-up-get-it')));
    await tester.pumpAndSettle();
    expect(find.byType(GetHarnessPage), findsOneWidget);
    expect(find.text('For Mac and Linux.'), findsOneWidget);
    await tester.tap(find.byKey(const ValueKey('get-it-sample')));
    await tester.pumpAndSettle();
    expect(samples, 1);

    // Installed: Get it goes, and the camera comes up over this page — not over Get it.
    await tester.tap(find.byKey(const ValueKey('get-it-pair')));
    await tester.pumpAndSettle();
    expect(find.byType(ScanToConnectPage), findsOneWidget);
    expect(find.byType(GetHarnessPage), findsNothing);
    tester.widget<ScanToConnectPage>(find.byType(ScanToConnectPage)).onBack();
    await tester.pumpAndSettle();
    expect(find.byType(ScanToConnectPage), findsNothing);
    expect(find.text('Connect your computer'), findsOneWidget);
    expect(backs, isEmpty);
    await unmount(tester);
  });

  testWidgets('scanning the new computer\'s code pairs it and goes back', (
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
    expect(backs, [true]);
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
    // The page asks for the list again first, and gives that five seconds.
    await tester.pump(const Duration(seconds: 6));
    await tester.pump();
    expect(links.codes, isEmpty);
    expect(backs, isEmpty);
    expect(find.textContaining("isn't on your account"), findsOneWidget);
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
    expect(backs, isEmpty);
    expect(find.text('Pairing…'), findsNothing);
    expect(find.textContaining("Couldn't reach your account"), findsOneWidget);
    await unmount(tester);
  });
}
