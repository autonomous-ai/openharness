import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../viewer_app_fixture.dart';

/// Stop after it finishes, from the phone: the machine waits for the agent to be idle, then saves
/// and stops it (`agent_close`, `after_task`) — and Keep running calls that off (`cancel`).
void main() {
  const created = '2026-10-16T01:00:00.000Z';

  Map<String, dynamic> source({
    String engine = 'claude',
    bool closeSupported = true,
    Object? closePlan,
  }) => agentJson(
    'a',
    engine: engine,
    sessionId: 's1',
    extra: {
      'createdAt': created,
      'closeSupported': closeSupported,
      'closePlan': ?closePlan,
    },
  );

  Future<ViewerRig> rigWith(List<Map<String, dynamic>> agents) async {
    final rig = viewerApp();
    rig.api.onMachines = () async => [remoteMachine('m')];
    final answers = rig.conn('m').answers;
    answers['agents_list'] = (_) => {'agents': agents};
    answers['terminal_capabilities'] = (_) => capabilities();
    answers['agent_close'] = (p) =>
        p['mode'] == 'cancel' ? {'cancelled': true} : {'deferred': true};
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await settle();
    addTearDown(rig.app.dispose);
    return rig;
  }

  Agent agent(ViewerRig rig) =>
      rig.app.stateOf('m')!.agents.singleWhere((a) => a.id == 'a');

  group('the frame', () {
    test('says what became of a queued stop', () {
      Agent read(Object? plan) =>
          Agent.fromJson(agentJson('a', extra: {'closePlan': ?plan}));
      expect(read(null).closePlanState, isNull);
      expect(read({'state': 'waiting'}).closePlanState, 'waiting');
      final failed = read({'state': 'failed', 'detail': 'Could not save.'});
      expect(failed.closePlanState, 'failed');
      expect(failed.closePlanDetail, 'Could not save.');
      expect(read({'state': 'weird'}).closePlanState, isNull);
      expect(read('waiting').closePlanState, isNull);
    });

    test('a shell, or an agent its machine cannot close, has no stop to '
        'queue', () {
      Agent read({String engine = 'claude', bool closeSupported = true}) =>
          Agent.fromJson(
            source(engine: engine, closeSupported: closeSupported),
          );
      expect(AppNotifier.canStopAfterTask(read()), isTrue);
      expect(AppNotifier.canStopAfterTask(read(engine: 'terminal')), isFalse);
      expect(
        AppNotifier.canStopAfterTask(read(closeSupported: false)),
        isFalse,
      );
    });
  });

  test('queues the stop under the agent’s exact identity, and the agent '
      'reads it at once', () async {
    final rig = await rigWith([source()]);

    expect(await rig.app.stopAfterTask('m', 'a'), isNull);

    expect(rig.conn('m').payloadsOf('agent_close'), [
      {
        'agentId': 'a',
        'sessionId': 's1',
        'createdAt': created,
        'mode': 'after_task',
      },
    ]);
    expect(agent(rig).closePlanState, 'waiting');
    expect(rig.app.agentClosePlanPending('m', 'a'), isFalse);
  });

  test('Keep running calls it off', () async {
    final rig = await rigWith([
      source(closePlan: {'state': 'waiting'}),
    ]);
    expect(agent(rig).closePlanState, 'waiting');

    expect(await rig.app.keepRunning('m', 'a'), isNull);

    expect(rig.conn('m').payloadsOf('agent_close').single['mode'], 'cancel');
    expect(agent(rig).closePlanState, isNull);
  });

  test('nothing is asked of a machine that cannot close it', () async {
    final rig = await rigWith([source(closeSupported: false)]);

    expect(
      await rig.app.stopAfterTask('m', 'a'),
      'Update the Harness CLI on this machine to stop a harness once it '
      'finishes.',
    );
    expect(rig.conn('m').payloadsOf('agent_close'), isEmpty);
  });

  test('a refusal says why, in the machine’s words when it has them', () async {
    final rig = await rigWith([source()]);
    final conn = rig.conn('m');
    conn.answers['agent_close'] = (_) =>
        throw refusal('AGENT_CHANGED', detail: 'changed');
    expect(
      await rig.app.stopAfterTask('m', 'a'),
      'The harness changed. Open its menu again.',
    );

    conn.answers['agent_close'] = (_) =>
        throw refusal('CLOSE_FAILED', detail: 'The session is busy.');
    expect(await rig.app.stopAfterTask('m', 'a'), 'The session is busy.');
    expect(agent(rig).closePlanState, isNull);
  });

  test('a lost reply is not taken for either answer, and the agents are '
      'read again', () async {
    final rig = await rigWith([source()]);
    final conn = rig.conn('m');
    conn.answers['agent_close'] = (_) =>
        throw const WsRequestTimeout('agent_close');
    final listsBefore = conn.payloadsOf('agents_list').length;

    expect(
      await rig.app.stopAfterTask('m', 'a'),
      'Could not confirm the stop is queued. Check its menu again in a '
      'moment.',
    );
    await settle();

    expect(agent(rig).closePlanState, isNull);
    expect(conn.payloadsOf('agents_list').length, greaterThan(listsBefore));
  });

  test('an answer that confirms nothing is not taken for one', () async {
    final rig = await rigWith([source()]);
    rig.conn('m').answers['agent_close'] = (_) => <String, dynamic>{};

    expect(
      await rig.app.stopAfterTask('m', 'a'),
      'The machine did not confirm it. Check its menu again in a moment.',
    );
    expect(agent(rig).closePlanState, isNull);
  });

  test('pressed again while it is out joins the first', () async {
    final rig = await rigWith([source()]);
    final reply = Completer<Map<String, dynamic>>();
    rig.conn('m').answers['agent_close'] = (_) => reply.future;

    final first = rig.app.stopAfterTask('m', 'a');
    final second = rig.app.stopAfterTask('m', 'a');
    expect(rig.app.agentClosePlanPending('m', 'a'), isTrue);
    reply.complete({'deferred': true});

    expect(await first, isNull);
    expect(await second, isNull);
    expect(rig.conn('m').payloadsOf('agent_close'), hasLength(1));
  });

  test('opening an agent with a queued stop always tells its machine — that '
      'is what calls it off', () async {
    final rig = await rigWith([
      source(closePlan: {'state': 'waiting'}),
      agentJson('b'),
    ]);
    final conn = rig.conn('m');
    List<Object?> opened() => [
      for (final p in conn.payloadsOf('agent_update'))
        if (p['opened'] == true) p['agentId'],
    ];

    rig.app.touchAgent('m', 'a');
    rig.app.touchAgent('m', 'a');
    rig.app.touchAgent('m', 'b');
    rig.app.touchAgent('m', 'b');
    await settle();

    expect(opened().where((id) => id == 'a'), hasLength(2));
    expect(
      opened().where((id) => id == 'b'),
      hasLength(1),
      reason: 'still coalesced with nothing queued',
    );
  });
}
