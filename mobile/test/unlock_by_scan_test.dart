import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/auth/cli_link.dart';
import 'package:harness_mobile/auth/peer_link_client.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/welcome/connect_code.dart';
import 'package:harness_mobile/phone/welcome/scan_to_connect.dart';
import 'package:harness_mobile/phone/welcome/unlock_computer.dart';
import 'package:harness_mobile/state/app_state.dart';

/// Pairs by code and answers [result]; records what it was asked.
class _Links implements PeerLinkClient {
  _Links(this.result);

  final CliLinkConnectResult result;
  final codes = <(String, String)>[];

  @override
  Future<CliLinkConnectResult> connectWithCode(
    String machineId,
    String code, {
    required String label,
    String? displayName,
  }) async {
    codes.add((machineId, code));
    return result;
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

/// A locked computer is unlocked the way the first one was added: scan the QR its Add Phone
/// shows. The password is still there, second, for a computer with no desktop app.
void main() {
  const studio = Machine(
    machineId: 'studio',
    authMode: MachineAuthMode.remote,
    name: 'studio',
  );

  Future<(AppNotifier, List<bool>)> pump(
    WidgetTester tester,
    _Links links,
  ) async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      peerLinks: links,
    );
    addTearDown(app.dispose);
    app.machines = [studio];
    final state = app.machineStates['studio'] = MachineState(studio)
      ..nodeOnline = true
      ..needsLink = true;
    final unlocked = <bool>[];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: UnlockComputer(
            notifier: app,
            machineState: state,
            scanCamera: const SizedBox(),
            onUnlocked: () => unlocked.add(true),
          ),
        ),
      ),
    );
    return (app, unlocked);
  }

  Future<void> scan(WidgetTester tester, String link) async {
    await tester.tap(find.byKey(const ValueKey('unlock-scan')));
    await tester.pumpAndSettle();
    final page = tester.widget<ScanToConnectPage>(
      find.byType(ScanToConnectPage),
    );
    expect(page.fallbackLabel, 'Use its password instead');
    page.onCode(ConnectCode.parse(link)!);
    await tester.pumpAndSettle();
  }

  testWidgets('scanning the computer\'s own code pairs it, no password', (
    tester,
  ) async {
    final links = _Links(const CliLinkConnectResult(linkedMachineId: 'studio'));
    final (_, unlocked) = await pump(tester, links);
    expect(find.text('Scan its code'), findsOneWidget);
    expect(find.text('or enter its Harness phone password'), findsOneWidget);

    await scan(
      tester,
      ConnectCode.link('a@b.co', machineId: 'studio', pairCode: 'K7QM4XPT'),
    );
    expect(links.codes, [('studio', 'K7QM4XPT')]);
    expect(unlocked, [true]);
  });

  testWidgets('another computer\'s code is refused, and says whose it is', (
    tester,
  ) async {
    final links = _Links(const CliLinkConnectResult(linkedMachineId: 'mini'));
    final (_, unlocked) = await pump(tester, links);
    await scan(
      tester,
      ConnectCode.link('a@b.co', machineId: 'mini', pairCode: 'K7QM4XPT'),
    );
    expect(links.codes, isEmpty);
    expect(unlocked, isEmpty);
    expect(find.textContaining('for another computer'), findsOneWidget);
  });

  testWidgets('a code with nothing to pair with is refused', (tester) async {
    final links = _Links(const CliLinkConnectResult(linkedMachineId: 'studio'));
    final (_, unlocked) = await pump(tester, links);
    await scan(tester, ConnectCode.link('a@b.co'));
    expect(links.codes, isEmpty);
    expect(unlocked, isEmpty);
    expect(find.textContaining("can't unlock a computer"), findsOneWidget);
  });

  testWidgets(
    'a pairing that fails says why, and the password is still there',
    (tester) async {
      final links = _Links(
        const CliLinkConnectResult(error: 'That code didn’t match.'),
      );
      final (_, unlocked) = await pump(tester, links);
      await scan(
        tester,
        ConnectCode.link('a@b.co', machineId: 'studio', pairCode: 'K7QM4XPT'),
      );
      expect(unlocked, isEmpty);
      expect(find.textContaining('didn’t match'), findsOneWidget);
      expect(
        find.byKey(const Key('remote-password-connect-field')),
        findsOneWidget,
      );
    },
  );
}
