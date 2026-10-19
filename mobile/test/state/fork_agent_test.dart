import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../viewer_app_fixture.dart';

/// Fork from the phone: a second harness that starts with another one's conversation, in the
/// same folder — the desktop's Fork Harness. What the machine is asked, and that a lost reply is
/// checked under the same receipt rather than answered with a second fork.
void main() {
  /// A signed-in phone whose machine `m` lists [agents] and forks the way a current machine does.
  Future<ViewerRig> rigWith(List<Map<String, dynamic>> agents) async {
    final rig = viewerApp();
    rig.api.onMachines = () async => [remoteMachine('m')];
    final answers = rig.conn('m').answers;
    answers['agents_list'] = (_) => {'agents': agents};
    answers['terminal_capabilities'] = (_) => capabilities();
    answers['agent_fork'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'level': 'native',
      'agent': agentJson('f', name: p['name'] as String?),
    };
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await settle();
    addTearDown(rig.app.dispose);
    return rig;
  }

  Agent? agentOf(ViewerRig rig, String id) =>
      rig.app.stateOf('m')?.agents.where((a) => a.id == id).firstOrNull;

  group('what can be forked', () {
    test('the machine says; an older one leaves it to the engine', () {
      Agent agent(String engine, [Object? forkable]) => Agent.fromJson(
        agentJson('a', engine: engine, extra: {'forkable': ?forkable}),
      );
      expect(agent('claude').canFork, isTrue);
      expect(agent('codex').canFork, isTrue);
      expect(agent('opencode').canFork, isTrue);
      expect(agent('terminal').canFork, isFalse);
      expect(agent('cursor').canFork, isFalse);
      expect(agent('claude', false).canFork, isFalse, reason: 'it said no');
      expect(agent('devin', true).canFork, isTrue, reason: 'it said yes');
      expect(agent('claude', 'yes').canFork, isTrue, reason: 'not a bool');
    });
  });

  test('forks under a receipt with the name and first task, and the fork '
      'joins the machine’s list', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    final attempt = rig.app.forkAttempt('m', 'a', name: 'a - fork');
    attempt.prompt = 'Try the other approach';

    final result = await rig.app.forkAgent('m', 'a', attempt: attempt);

    expect(result.error, isNull);
    expect(result.agentId, 'f');
    expect(result.level, 'native');
    final [sent] = rig.conn('m').payloadsOf('agent_fork');
    expect(sent['agentId'], 'a');
    expect(sent['name'], 'a - fork');
    expect(sent['prompt'], 'Try the other approach');
    expect(sent['creationId'], isA<String>());
    expect((sent['creationId'] as String).length, 32);
    expect(agentOf(rig, 'f')?.name, 'a - fork');
    expect(rig.app.agentForking('m', 'a'), isFalse);
  });

  test('an empty first task and a blank name are left out', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    final attempt = rig.app.forkAttempt('m', 'a', name: '  ');
    attempt.prompt = '   ';

    await rig.app.forkAgent('m', 'a', attempt: attempt);

    final [sent] = rig.conn('m').payloadsOf('agent_fork');
    expect(sent.keys.toSet(), {'creationId', 'agentId'});
  });

  test('a handoff fork says so', () async {
    final rig = await rigWith([agentJson('a', engine: 'opencode')]);
    rig.conn('m').answers['agent_fork'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'level': 'handoff',
      'agent': agentJson('f', engine: 'opencode'),
    };

    final result = await rig.app.forkAgent('m', 'a');

    expect(result.level, 'handoff');
    expect(result.agentId, 'f');
  });

  test('asking again while one is on its way joins it', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    final reply = Completer<Map<String, dynamic>>();
    rig.conn('m').answers['agent_fork'] = (_) => reply.future;

    final first = rig.app.forkAgent('m', 'a');
    final second = rig.app.forkAgent('m', 'a');
    expect(rig.app.agentForking('m', 'a'), isTrue);
    expect(rig.app.forkPending('m', 'a'), isNotNull);
    final [sent] = rig.conn('m').payloadsOf('agent_fork');
    reply.complete({
      'creationId': sent['creationId'],
      'state': 'created',
      'agent': agentJson('f'),
    });

    expect((await first).agentId, 'f');
    expect((await second).agentId, 'f');
    expect(rig.conn('m').payloadsOf('agent_fork'), hasLength(1));
    expect(rig.app.agentForking('m', 'a'), isFalse);
  });

  test('a lost reply is checked under the same receipt, never forked '
      'again', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    final conn = rig.conn('m');
    conn.answers['agent_fork'] = (_) =>
        throw const WsRequestTimeout('agent_fork');
    final attempt = rig.app.forkAttempt('m', 'a');

    final lost = await rig.app.forkAgent('m', 'a', attempt: attempt);
    expect(lost.error, contains('not confirmed yet'));
    expect(attempt.awaitingConfirmation, isTrue);
    expect(attempt.locked, isTrue);
    expect(
      identical(rig.app.forkAttempt('m', 'a'), attempt),
      isTrue,
      reason: 'the form opened again holds the same fork',
    );

    final receipt = conn.payloadsOf('agent_fork').single['creationId'];
    conn.answers['agent_create_status'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('f'),
    };
    final checked = await rig.app.forkAgent('m', 'a', attempt: attempt);

    expect(checked.error, isNull);
    expect(checked.agentId, 'f');
    expect(conn.payloadsOf('agent_fork'), hasLength(1));
    expect(conn.payloadsOf('agent_create_status'), [
      {'creationId': receipt},
    ]);
    expect(agentOf(rig, 'f'), isNotNull);
  });

  test('a refusal before anything started can be corrected and sent '
      'again', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    final conn = rig.conn('m');
    conn.answers['agent_fork'] = (_) => throw refusal('PROMPT_TOO_LONG');
    final attempt = rig.app.forkAttempt('m', 'a');

    final refused = await rig.app.forkAgent('m', 'a', attempt: attempt);
    expect(refused.error, 'Fork failed: PROMPT_TOO_LONG');
    expect(attempt.awaitingConfirmation, isFalse);

    conn.answers['agent_fork'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('f'),
    };
    final sent = await rig.app.forkAgent('m', 'a', attempt: attempt);
    expect(sent.agentId, 'f');
    expect(conn.payloadsOf('agent_fork'), hasLength(2));
  });

  test('a refusal that cannot prove nothing started stays to be '
      'checked', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    rig.conn('m').answers['agent_fork'] = (_) => throw refusal('INTERNAL');
    final attempt = rig.app.forkAttempt('m', 'a');

    final result = await rig.app.forkAgent('m', 'a', attempt: attempt);

    expect(result.error, contains('not confirmed yet'));
    expect(attempt.awaitingConfirmation, isTrue);
  });

  test('the machine’s own sentence wins, and a recorded failure ends the '
      'attempt', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    rig.conn('m').answers['agent_fork'] = (p) => {
      'creationId': p['creationId'],
      'state': 'failed',
      'failure': {
        'code': 'AGENT_BUSY',
        'detail': 'a is in the middle of a turn.',
      },
    };
    final attempt = rig.app.forkAttempt('m', 'a');

    final result = await rig.app.forkAgent('m', 'a', attempt: attempt);

    expect(result.error, 'a is in the middle of a turn.');
    expect(attempt.awaitingConfirmation, isFalse);
  });

  test('an answer for another receipt is not taken as this fork', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    rig.conn('m').answers['agent_fork'] = (_) => {
      'creationId': 'someone-else',
      'state': 'created',
      'agent': agentJson('f'),
    };

    final result = await rig.app.forkAgent('m', 'a');

    expect(result.error, contains('not confirmed yet'));
    expect(agentOf(rig, 'f'), isNull);
  });

  test('a fork that names its source back is not a fork', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    rig.conn('m').answers['agent_fork'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('a'),
    };

    final result = await rig.app.forkAgent('m', 'a');

    expect(result.agentId, isNull);
    expect(result.error, contains('not confirmed yet'));
  });

  test('a harness mid-turn is not forked, and nothing is sent', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    await push(rig, 'm', 'turn_started', {'agentId': 'a'});

    final result = await rig.app.forkAgent('m', 'a');

    expect(
      result.error,
      'This harness is working. Wait for its turn to finish, then fork.',
    );
    expect(rig.conn('m').payloadsOf('agent_fork'), isEmpty);
  });

  test('an engine that cannot fork is refused here', () async {
    final rig = await rigWith([agentJson('a', engine: 'terminal')]);

    final result = await rig.app.forkAgent('m', 'a');

    expect(result.error, 'This harness does not support forking.');
    expect(rig.conn('m').payloadsOf('agent_fork'), isEmpty);
  });

  test('a source that changed conversation since the form opened is not '
      'forked', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    final attempt = rig.app.forkAttempt('m', 'a');
    rig.conn('m').answers['agents_list'] = (_) => {
      'agents': [agentJson('a', sessionId: 's2')],
    };
    await rig.app.syncAgentsForTest('m');
    await settle();

    final result = await rig.app.forkAgent('m', 'a', attempt: attempt);

    expect(result.error, contains('The source harness changed.'));
    expect(rig.conn('m').payloadsOf('agent_fork'), isEmpty);
  });

  test('names and first tasks over the limits are refused before '
      'sending', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    final named = rig.app.forkAttempt('m', 'a', name: 'n' * 81);
    expect(
      (await rig.app.forkAgent('m', 'a', attempt: named)).error,
      'Use at most 80 characters for the name.',
    );
    named.name = 'ok';
    named.prompt = 'p' * 2001;
    expect(
      (await rig.app.forkAgent('m', 'a', attempt: named)).error,
      'Use at most 2000 characters for the first task.',
    );
    expect(rig.conn('m').payloadsOf('agent_fork'), isEmpty);
  });

  test('only an idle, held attempt can be let go', () async {
    final rig = await rigWith([agentJson('a', sessionId: 's1')]);
    final reply = Completer<Map<String, dynamic>>();
    rig.conn('m').answers['agent_fork'] = (_) => reply.future;
    final attempt = rig.app.forkAttempt('m', 'a');

    final pending = rig.app.forkAgent('m', 'a', attempt: attempt);
    expect(rig.app.discardForkAttempt('m', 'a', attempt), isFalse);
    reply.completeError(const WsRequestTimeout('agent_fork'));
    await pending;

    expect(rig.app.discardForkAttempt('m', 'a', attempt), isTrue);
    expect(identical(rig.app.forkAttempt('m', 'a'), attempt), isFalse);
    expect(
      rig.app.discardForkAttempt('m', 'a', attempt),
      isFalse,
      reason: 'no longer the one held',
    );
  });
}
