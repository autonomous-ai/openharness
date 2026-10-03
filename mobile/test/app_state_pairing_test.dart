import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/cli_link.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

import 'agent_pager_fixture.dart' show goLive;
import 'viewer_app_fixture.dart';

/// Linking a phone to a machine: by its password, by the code an "Add phone" QR
/// carries, and taking the link away again.
void main() {
  /// Signed in to an account with one machine, `m`, that wants its password.
  Future<ViewerRig> lockedMachine() async {
    final rig = viewerApp();
    rig.api.onMachines = () async => [remoteMachine('m')];
    await rig.app.bootstrap();
    await settle();
    rig.app.localFailureForTest('m', 4404, 'NO_PEER_LINK');
    return rig;
  }

  group('by password', () {
    test('an empty one is not sent', () async {
      final rig = await lockedMachine();
      addTearDown(rig.app.dispose);

      expect(
        await rig.app.connectWithPassword('m', ''),
        'Enter the remote password first',
      );
      expect(rig.links.passwords, isEmpty);
    });

    test('a refused one says why and leaves the machine locked', () async {
      final rig = await lockedMachine();
      addTearDown(rig.app.dispose);
      rig.links.connectResult = const CliLinkConnectResult(
        error: 'Wrong password',
      );

      expect(await rig.app.connectWithPassword('m', 'nope'), 'Wrong password');
      expect(rig.app.stateOf('m')!.needsLink, isTrue);
    });

    test('a right one unlocks the machine and dials it again', () async {
      final rig = await lockedMachine();
      addTearDown(rig.app.dispose);
      final stages = <String>[];

      final error = await rig.app.connectWithPassword(
        'm',
        'hunter2',
        onProgress: stages.add,
      );

      expect(error, isNull);
      expect(rig.links.passwords.single, ('m', 'hunter2'));
      // The computer files the pairing under this phone's own name ("Dee's iPhone").
      expect(rig.links.labels.single, rig.app.phoneClientDescriptor().name);
      expect(stages, ['connecting']);
      final machine = rig.app.stateOf('m')!;
      expect(machine.needsLink, isFalse);
      expect(machine.agentLoadStatus, AgentLoadStatus.idle);
    });

    test('the machine the link actually named is the one unlocked', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m'), remoteMachine('n')];
      await rig.app.bootstrap();
      await settle();
      rig.app.localFailureForTest('m', 4404, 'NO_PEER_LINK');
      rig.app.localFailureForTest('n', 4404, 'NO_PEER_LINK');
      rig.links.connectResult = const CliLinkConnectResult(
        linkedMachineId: 'n',
      );

      expect(await rig.app.connectWithPassword('m', 'pw'), isNull);

      expect(rig.app.stateOf('n')!.needsLink, isFalse);
      expect(rig.app.stateOf('m')!.needsLink, isTrue);
    });
  });

  group('by the code a QR carries', () {
    test('pairs, naming this phone, and unlocks the machine', () async {
      final rig = await lockedMachine();
      addTearDown(rig.app.dispose);

      expect(await rig.app.connectWithCode('m', 'K7QM'), isNull);

      final (machineId, code, label) = rig.links.codes.single;
      expect((machineId, code), ('m', 'K7QM'));
      expect(label, rig.app.phoneClientDescriptor().name);
      expect(rig.app.stateOf('m')!.needsLink, isFalse);
    });

    test('a spent code says so and leaves the machine locked', () async {
      final rig = await lockedMachine();
      addTearDown(rig.app.dispose);
      rig.links.codeResult = const CliLinkConnectResult(error: 'Code expired');

      expect(await rig.app.connectWithCode('m', 'OLD'), 'Code expired');
      expect(rig.app.stateOf('m')!.needsLink, isTrue);
    });

    test('dropping a held code is said once, and only when there was one', () {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      var redraws = 0;
      rig.app.addListener(() => redraws++);

      rig.app.dropPendingPairing();
      expect(redraws, 0);

      rig.app.pendingPairing = (machineId: 'm', code: 'K7QM');
      rig.app.dropPendingPairing();
      expect(rig.app.pendingPairing, isNull);
      expect(redraws, 1);
    });

    test(
      'a held code does not outlive the session it was scanned into',
      () async {
        final rig = await lockedMachine();
        addTearDown(rig.app.dispose);
        rig.app.pendingPairing = (machineId: 'm', code: 'K7QM');

        await rig.app.logout();

        // Left standing, the next sign-in — perhaps another account's — would
        // try this spent code on the first locked machine of that id instead of
        // offering its password.
        expect(rig.app.pendingPairing, isNull);
      },
    );

    test('a held code goes when its machine connects without it', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.app.pendingPairing = (machineId: 'm', code: 'K7QM');
      rig.api.onMachines = () async => [remoteMachine('m')];
      await rig.app.bootstrap();
      await settle();

      // Already linked: the socket comes up and nothing asks for a password.
      rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
      await settle();
      expect(rig.app.pendingPairing, isNull);

      // So unlinking it later offers the password, not a code long spent.
      await rig.app.unlinkMachine('m');
      expect(rig.app.pendingPairing, isNull);
    });

    test(
      'a held code for a machine the account does not have is dropped',
      () async {
        final rig = viewerApp();
        addTearDown(rig.app.dispose);
        rig.app.pendingPairing = (machineId: 'gone', code: 'K7QM');
        rig.api.onMachines = () async => [remoteMachine('m')];

        await rig.app.bootstrap();
        await settle();

        expect(rig.app.pendingPairing, isNull);
      },
    );

    test(
      'a held code survives a machine list that is still on its way',
      () async {
        final rig = viewerApp();
        addTearDown(rig.app.dispose);
        rig.app.pendingPairing = (machineId: 'm', code: 'K7QM');
        rig.api.onMachines = () async => [remoteMachine('m')];

        await rig.app.bootstrap();
        await settle();
        rig.app.localFailureForTest('m', 4404, 'NO_PEER_LINK');

        expect(rig.app.pendingPairing, (machineId: 'm', code: 'K7QM'));
      },
    );
  });

  group('taking the link away', () {
    test('a refusal is said and nothing changes', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      await rig.app.bootstrap();
      await settle();
      rig.links.unlinkError = 'Could not unlink';

      expect(await rig.app.unlinkMachine('m'), 'Could not unlink');
      expect(rig.app.stateOf('m')!.needsLink, isFalse);
      expect(rig.links.lists, 0);
    });

    test('locks the machine, keeps it on, and freezes its terminals', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      await rig.app.bootstrap();
      await settle();
      final machine = rig.app.stateOf('m')!
        ..agents = [Agent.fromJson(agentJson('a'))]
        ..terminalCapabilityAvailable = true;
      final session = TerminalSession(
        machineId: 'm',
        agentId: 'a',
        agentName: 'a',
        engineId: 'claude',
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      );
      rig.app.adoptSessionForTest(session);
      await goLive(session);

      expect(await rig.app.unlinkMachine('m'), isNull);

      expect(rig.links.unlinked, ['m']);
      expect(rig.links.lists, 1, reason: 'the linked list is read again');
      expect(machine.needsLink, isTrue);
      expect(machine.agentLoadStatus, AgentLoadStatus.needsLink);
      expect(machine.nodeOnline, isNot(false), reason: 'still switched on');
      expect(session.status, TerminalSessionStatus.error);
      expect(session.errorMessage, contains('no longer linked'));
    });

    test('an unknown machine is unlinked with nothing else to do', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);

      expect(await rig.app.unlinkMachine('ghost'), isNull);
      expect(rig.links.unlinked, ['ghost']);
    });
  });

  group('the relay saying a machine is not linked', () {
    test('marks it locked, and a phone does not poll for the link', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      await rig.app.bootstrap();
      await settle();
      final asked = rig.conn('m').requests.length;

      rig.app.localFailureForTest('m', 4404, 'NO_PEER_LINK');
      await Future<void>.delayed(
        AppNotifier.offlineRetryInterval + const Duration(milliseconds: 200),
      );

      final machine = rig.app.stateOf('m')!;
      expect(machine.needsLink, isTrue);
      expect(machine.agentLoadStatus, AgentLoadStatus.needsLink);
      expect(
        rig.conn('m').requests.length,
        asked,
        reason: 'only the password form can fix this on a phone',
      );
    });

    test('any other close, or an unknown machine, changes nothing', () async {
      final rig = viewerApp();
      addTearDown(rig.app.dispose);
      rig.api.onMachines = () async => [remoteMachine('m')];
      await rig.app.bootstrap();
      await settle();

      rig.app.localFailureForTest('m', 1006, 'abnormal');
      rig.app.localFailureForTest('ghost', 4404, 'NO_PEER_LINK');

      expect(rig.app.stateOf('m')!.needsLink, isFalse);
      expect(rig.app.stateOf('ghost'), isNull);
    });
  });
}
