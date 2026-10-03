import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/auth/cli_link.dart';
import 'package:harness_mobile/auth/peer_link_client.dart';
import 'package:harness_mobile/core/config.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/agent_home.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/phone/welcome/pairing_with_code.dart';
import 'package:harness_mobile/state/app_state.dart';

/// A link client that pairs by code: [result] is what the machine answered.
class _Links implements PeerLinkClient {
  _Links(this.result);

  final CliLinkConnectResult result;
  final codes = <(String, String, String)>[];

  /// Held until the test lets the machine answer.
  final gate = Completer<void>();

  @override
  Future<CliLinkConnectResult> connectWithCode(
    String machineId,
    String code, {
    required String label,
    String? displayName,
  }) async {
    codes.add((machineId, code, label));
    await gate.future;
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

/// Signed in from a scanned "Add phone" QR: the computer it named shows up locked, and the phone
/// pairs with the QR's code instead of asking for its password.
void main() {
  Future<AppNotifier> pumpHome(WidgetTester tester, _Links links) async {
    final app = AppNotifier(
      config: AppConfig.dev,
      authSession: AuthSession(),
      configStore: null,
      peerLinks: links,
    );
    addTearDown(app.dispose);
    const mac = Machine(
      machineId: 'mac',
      authMode: MachineAuthMode.remote,
      name: 'MacBook Pro',
    );
    app.machines = [mac];
    app.machineStates['mac'] = MachineState(mac)
      ..nodeOnline = true
      ..needsLink = true
      ..connectionStatus = ConnectionStatus.disconnected;
    app.pendingPairing = (machineId: 'mac', code: 'K7QM4XPT9D2W');
    await tester.pumpWidget(
      MaterialApp(
        home: PhoneShellScope(
          onMachineLinked: (_) {},
          onOpenAgent: (_, _) {},
          child: AgentHome(notifier: app),
        ),
      ),
    );
    await tester.pump();
    return app;
  }

  testWidgets('pairs by the code, no password, and the computer unlocks', (
    tester,
  ) async {
    final links = _Links(const CliLinkConnectResult(linkedMachineId: 'mac'));
    final app = await pumpHome(tester, links);

    expect(find.byType(PairingWithCode), findsOneWidget);
    expect(find.textContaining('MacBook Pro'), findsOneWidget);
    links.gate.complete();
    await tester.pump();
    expect(links.codes.single.$1, 'mac');
    expect(links.codes.single.$2, 'K7QM4XPT9D2W');
    expect(app.pendingPairing, isNull);
    expect(app.machineStates['mac']!.needsLink, isFalse);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 40));
  });

  testWidgets('a code that fails says why, and the password is the way on', (
    tester,
  ) async {
    final links = _Links(
      const CliLinkConnectResult(
        error: 'That code didn’t match. Scan the new one on MacBook Pro.',
      ),
    );
    final app = await pumpHome(tester, links);
    links.gate.complete();
    await tester.pump();
    await tester.pump();

    expect(find.textContaining('didn’t match'), findsOneWidget);
    await tester.tap(find.text('Use its password instead'));
    await tester.pump();
    expect(app.pendingPairing, isNull);
    expect(find.byType(PairingWithCode), findsNothing);

    await tester.pumpWidget(const SizedBox());
    await tester.pump(const Duration(seconds: 40));
  });
}
