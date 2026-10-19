import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';

import '../viewer_app_fixture.dart';

/// Cancel request from the phone: a creation the machine holds before starting anything — an
/// engine it is installing — called off under its own receipt, the desktop's
/// `cancelAgentCreation`. Only a hold can be cancelled, and only the machine's word ends it.
void main() {
  const holding = 'Installing Kilo. The harness starts once it is installed.';

  Future<ViewerRig> holdingRig() async {
    final rig = viewerApp();
    rig.api.onMachines = () async => [remoteMachine('m')];
    final answers = rig.conn('m').answers;
    answers['agents_list'] = (_) => {'agents': <Object>[]};
    answers['terminal_capabilities'] = (_) => capabilities();
    answers['agent_create'] = (p) => {
      'creationId': p['creationId'],
      'state': 'pending',
      'held': {'service': 'engine', 'detail': holding},
    };
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await settle();
    addTearDown(rig.app.dispose);
    return rig;
  }

  Future<AgentCreationAttempt> heldCreation(ViewerRig rig) async {
    final attempt = AgentCreationAttempt();
    expect(
      await rig.app.createAgent(
        'm',
        engine: 'kilo',
        folder: '/work',
        attempt: attempt,
      ),
      holding,
    );
    return attempt;
  }

  test('a hold names itself and can be called off under the same '
      'receipt, after which nothing more is asked', () async {
    final rig = await holdingRig();
    final conn = rig.conn('m');
    conn.answers['agent_create_cancel'] = (p) => {
      'creationId': p['creationId'],
      'state': 'cancelled',
    };
    final attempt = await heldCreation(rig);
    expect(attempt.canCancelPending, isTrue);

    expect(await rig.app.cancelAgentCreation(attempt), isNull);

    final receipt = conn.payloadsOf('agent_create').single['creationId'];
    expect(conn.payloadsOf('agent_create_cancel'), [
      {'creationId': receipt},
    ]);
    expect(attempt.canCancelPending, isFalse);
    expect(attempt.awaitingConfirmation, isFalse);
    expect(await rig.app.checkAgentCreation(attempt), 'Creation cancelled.');
    expect(conn.payloadsOf('agent_create_status'), isEmpty);
  });

  test('a harness already starting holds nothing to cancel, and nothing is '
      'sent', () async {
    final rig = await holdingRig();
    final conn = rig.conn('m');
    conn.answers['agent_create'] = (p) => {
      'creationId': p['creationId'],
      'state': 'pending',
    };
    final attempt = AgentCreationAttempt();
    await rig.app.createAgent(
      'm',
      engine: 'claude',
      folder: '/work',
      attempt: attempt,
    );

    expect(attempt.awaitingConfirmation, isTrue);
    expect(attempt.canCancelPending, isFalse);
    expect(
      await rig.app.cancelAgentCreation(attempt),
      'Check the request status before cancelling.',
    );
    expect(conn.payloadsOf('agent_create_cancel'), isEmpty);
  });

  test('a cancel answered with anything but cancelled keeps the request to '
      'check', () async {
    final rig = await holdingRig();
    final conn = rig.conn('m');
    conn.answers['agent_create_cancel'] = (p) => {
      'creationId': p['creationId'],
      'state': 'pending',
    };
    final attempt = await heldCreation(rig);

    expect(
      await rig.app.cancelAgentCreation(attempt),
      'The request may already be starting. Check status before starting '
      'another.',
    );
    expect(attempt.awaitingConfirmation, isTrue);
  });

  test('an answer for another receipt is not this cancel', () async {
    final rig = await holdingRig();
    rig.conn('m').answers['agent_create_cancel'] = (_) => {
      'creationId': 'someone-else',
      'state': 'cancelled',
    };
    final attempt = await heldCreation(rig);

    expect(
      await rig.app.cancelAgentCreation(attempt),
      'The request may already be starting. Check status before starting '
      'another.',
    );
    expect(attempt.canCancelPending, isTrue);
  });

  test('a request cancelled elsewhere ends on a status check', () async {
    final rig = await holdingRig();
    final conn = rig.conn('m');
    final attempt = await heldCreation(rig);
    conn.answers['agent_create_status'] = (p) => {
      'creationId': p['creationId'],
      'state': 'cancelled',
    };

    expect(await rig.app.checkAgentCreation(attempt), 'Creation cancelled.');
    expect(attempt.awaitingConfirmation, isFalse);
    expect(attempt.canCancelPending, isFalse);
  });

  test('a hold that turns into a start is no longer cancellable', () async {
    final rig = await holdingRig();
    final conn = rig.conn('m');
    final attempt = await heldCreation(rig);
    conn.answers['agent_create_status'] = (p) => {
      'creationId': p['creationId'],
      'state': 'pending',
    };

    await rig.app.checkAgentCreation(attempt);

    expect(attempt.awaitingConfirmation, isTrue);
    expect(attempt.canCancelPending, isFalse);
  });
}
