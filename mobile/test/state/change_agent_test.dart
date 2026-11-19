import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../viewer_app_fixture.dart';

/// Change agent from the phone: the same conversation moved to the other engine, Claude Code to
/// Codex when a subscription runs out, and back. What the machine is asked, in what order, and that
/// nothing is ever left with neither agent, nor the conversation lost to a failed step.
void main() {
  const created = '2026-10-16T01:00:00.000Z';

  /// The harness being switched: Claude Code in `/work`, mid-conversation, on a machine that can
  /// save and stop it.
  Map<String, dynamic> source({
    String sessionId = 's1',
    String status = 'active',
    String engine = 'claude',
    String? permissionMode = 'plan',
    bool closeSupported = true,
  }) => agentJson(
    'a',
    engine: engine,
    sessionId: sessionId,
    status: status,
    extra: {
      'createdAt': created,
      'closeSupported': closeSupported,
      'permissionMode': ?permissionMode,
    },
  );

  /// A signed-in phone whose machine `m` lists [agents], and answers a conversion, a close, a
  /// create and a delete the way a current machine does.
  Future<ViewerRig> rigWith(List<Map<String, dynamic>> agents) async {
    final rig = viewerApp();
    rig.api.onMachines = () async => [remoteMachine('m')];
    final answers = rig.conn('m').answers;
    answers['agents_list'] = (_) => {'agents': agents};
    answers['terminal_capabilities'] = (_) => capabilities();
    answers['agent_session_migrate'] = (p) => {
      'engine': p['targetEngine'],
      'sessionId': 'moved',
      'cwd': '/work',
    };
    answers['agent_close'] = (_) => {'closed': true};
    answers['agent_create'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('b', engine: p['engine'] as String),
    };
    answers['agent_purge'] = (p) => p['mode'] == 'inspect'
        ? {'reviewId': 'r1'}
        : {'deleted': true};
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await settle();
    addTearDown(rig.app.dispose);
    return rig;
  }

  /// [pending] finishing, with the new harness's terminal measured the way its panel would.
  Future<T> finished<T>(ViewerRig rig, Future<T> pending) async {
    for (var i = 0; i < 4; i++) {
      await settle();
      for (final pane in rig.app.panesFor('m')) {
        pane.session?.reportViewport(80, 24);
      }
    }
    return pending;
  }

  /// The switch's own requests, in the order they were sent.
  List<String> steps(ViewerRig rig) => [
    for (final type in rig.conn('m').asked)
      if (const {
        'agent_session_migrate',
        'agent_close',
        'agent_create',
        'agent_create_status',
        'agent_purge',
      }.contains(type))
        type,
  ];

  test('moves the conversation: converted, the old agent saved and stopped, the '
      'copy resumed where it worked, then the old conversation deleted', () async {
    final rig = await rigWith([source()]);

    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));

    expect(result.error, isNull);
    expect(result.agentId, 'b');
    expect(result.notice, isNull);
    expect(steps(rig), [
      'agent_session_migrate',
      'agent_close',
      'agent_create',
    ], reason: 'never closed before the conversation is converted');
    expect(
      rig.app.stateOf('m')!.agents.map((a) => a.id),
      contains('a'),
      reason: 'kept until the new agent is on screen: deleted under its own page, the phone '
          'jumped to another harness mid-switch',
    );

    expect(await rig.app.deleteMovedConversation('m', 'a'), isNull);
    expect(steps(rig).skip(3), ['agent_purge', 'agent_purge']);
    final conn = rig.conn('m');
    expect(conn.payloadsOf('agent_session_migrate').single, {
      'agentId': 'a',
      'targetEngine': 'codex',
    });
    final create = conn.payloadsOf('agent_create').single;
    expect(create['engine'], 'codex');
    expect(create['cwd'], '/work');
    expect(create['resumeSessionId'], 'moved');
    expect(create['permissionMode'], 'ask', reason: 'Codex has no plan mode');
    expect(
      [for (final p in conn.payloadsOf('agent_purge')) p['agentId']],
      ['a', 'a'],
    );
    expect(rig.app.agentChanging('m', 'a'), isFalse);
  });

  test('Codex moves to Claude Code the same way', () async {
    final rig = await rigWith([source(engine: 'codex', permissionMode: null)]);

    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'claude'));

    expect(result.agentId, 'b');
    expect(
      rig.conn('m').payloadsOf('agent_session_migrate').single['targetEngine'],
      'claude',
    );
  });

  test('a conversion the machine refuses: nothing is stopped, started or '
      'deleted, and the phone says why', () async {
    for (final (code, said) in [
      ('NO_SESSION', 'This harness has no conversation to move yet. Send a message first.'),
      ('TARGET_UNAVAILABLE', 'Codex is not installed or signed in on this machine.'),
      ('UNKNOWN_TYPE', 'Update the Harness CLI on this machine to change agents.'),
      ('CONVERT_FAILED', 'Could not convert the conversation for Codex (CONVERT_FAILED).'),
    ]) {
      final rig = await rigWith([source()]);
      rig.conn('m').answers['agent_session_migrate'] = (_) => {'error': code};

      final result = await rig.app.changeAgent('m', 'a', 'codex');

      expect(result.error, said, reason: code);
      expect(steps(rig), ['agent_session_migrate'], reason: code);
    }
  });

  test('a save the machine refuses: nothing is started or deleted, and its '
      'words are said', () async {
    final rig = await rigWith([source()]);
    rig.conn('m').answers['agent_close'] = (_) => {
      'error': 'CLOSE_FAILED',
      'detail': 'Disk is full',
    };

    final result = await rig.app.changeAgent('m', 'a', 'codex');

    expect(result.error, 'Disk is full');
    expect(steps(rig), ['agent_session_migrate', 'agent_close']);
  });

  test('a delete refused after the copy resumed: switched, both kept, and said',
      () async {
    final rig = await rigWith([source()]);
    rig.conn('m').answers['agent_purge'] = (_) => {
      'error': 'PURGE_FAILED',
      'detail': 'The conversation file changed',
    };

    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));

    expect(result.agentId, 'b');
    expect(
      await rig.app.deleteMovedConversation('m', 'a'),
      'Switched. The old conversation was kept: Delete failed: The conversation file changed',
    );
  });

  test('a lost reply to the start: choosing it again checks on it, never '
      'converts, starts or stops twice', () async {
    final rig = await rigWith([source()]);
    final answers = rig.conn('m').answers;
    answers['agent_create'] = (_) =>
        throw const WsRequestTimeout('agent_create');

    final lost = await rig.app.changeAgent('m', 'a', 'codex');

    expect(lost.error, contains('has not confirmed the new harness yet'));
    expect(rig.app.agentChanging('m', 'a'), isFalse);

    answers['agent_create_status'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('b', engine: 'codex'),
    };
    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));

    expect(result.error, isNull);
    expect(result.agentId, 'b');
    expect(steps(rig), [
      'agent_session_migrate',
      'agent_close',
      'agent_create',
      'agent_create_status',
    ]);
  });

  group('a close whose reply never came', () {
    /// The switch's close sent, and the socket dropped under it. The machine then lists [after].
    Future<ViewerRig> lost(Map<String, dynamic> after) async {
      final rig = await rigWith([source()]);
      rig.app.closeRecheckEvery = Duration.zero;
      final answers = rig.conn('m').answers;
      answers['agent_close'] = (_) {
        answers['agents_list'] = (_) => {
          'agents': [after],
        };
        throw Exception('WS disconnected');
      };
      return rig;
    }

    test('the machine lists the old agent stopped: the switch goes on as if '
        'the reply had come', () async {
      final rig = await lost(source(status: 'stopped'));

      final result = await finished(
        rig,
        rig.app.changeAgent('m', 'a', 'codex'),
      );

      expect(result.error, isNull);
      expect(result.agentId, 'b');
      expect(steps(rig).where((s) => s == 'agent_close'), hasLength(1));
    });

    test('it lists the old agent still running: nothing is started or deleted',
        () async {
      final rig = await lost(source());

      final result = await rig.app.changeAgent('m', 'a', 'codex');

      expect(
        result.error,
        'The computer did not confirm the close, and the old agent is still '
        'running. Try switching again.',
      );
      expect(steps(rig), ['agent_session_migrate', 'agent_close']);
    });
  });

  test('a machine too old to close safely is asked to update, before '
      'anything is written there', () async {
    final rig = await rigWith([source(closeSupported: false)]);

    final result = await rig.app.changeAgent('m', 'a', 'codex');

    expect(
      result.error,
      'Update the Harness CLI on this machine to close saved sessions safely.',
    );
    expect(steps(rig), isEmpty);
  });

  test('a stopped harness is moved without closing it again', () async {
    final rig = await rigWith([source(status: 'stopped')]);

    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));

    expect(result.error, isNull);
    expect(steps(rig), [
      'agent_session_migrate',
      'agent_create',
    ]);
  });

  test('the conversation changing under the conversion stops the switch '
      'before the close', () async {
    final rig = await rigWith([source()]);
    final answers = rig.conn('m').answers;
    final good = answers['agent_session_migrate']!;
    answers['agent_session_migrate'] = (p) {
      rig.app.stateOf('m')!.agents = [Agent.fromJson(source(sessionId: 's2'))];
      return good(p);
    };

    final result = await rig.app.changeAgent('m', 'a', 'codex');

    expect(result.error, 'The conversation changed. Reopen Change agent.');
    expect(steps(rig), ['agent_session_migrate']);
  });

  test('a second press while one runs joins it', () async {
    final rig = await rigWith([source()]);
    final answers = rig.conn('m').answers;
    final good = answers['agent_session_migrate']!;
    final release = Completer<void>();
    answers['agent_session_migrate'] = (p) async {
      await release.future;
      return good(p);
    };

    final first = rig.app.changeAgent('m', 'a', 'codex');
    final again = rig.app.changeAgent('m', 'a', 'codex');

    expect(identical(first, again), isTrue);
    expect(rig.app.agentChanging('m', 'a'), isTrue);

    release.complete();
    final result = await finished(rig, first);
    await settle();

    expect(result.agentId, 'b');
    expect(rig.conn('m').payloadsOf('agent_session_migrate'), hasLength(1));
    expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
  });

  test('only Claude Code and Codex move, each to the other: anything else is '
      'refused with nothing sent', () async {
    final rig = await rigWith([
      source(),
      agentJson('o', engine: 'opencode'),
      agentJson('t', engine: 'terminal'),
      agentJson('k', extra: {'dsh': 'autonomous/kicad'}),
    ]);

    expect((await rig.app.changeAgent('m', 'a', 'claude')).agentId, 'a');
    expect(
      (await rig.app.changeAgent('m', 'gone', 'codex')).error,
      'This harness is no longer available.',
    );
    for (final (id, to) in [('a', 'opencode'), ('o', 'codex'), ('t', 'codex'), ('k', 'codex')]) {
      expect(
        (await rig.app.changeAgent('m', id, to)).error,
        'This agent is not supported by the installed harness.',
        reason: '$id to $to',
      );
    }
    expect(steps(rig), isEmpty);
  });

  test('the engine each one moves to', () {
    String? target(Map<String, dynamic> json) =>
        AppNotifier.changeAgentTarget(Agent.fromJson(json));
    expect(target(agentJson('c')), 'codex');
    expect(target(agentJson('x', engine: 'codex')), 'claude');
    for (final engine in ['opencode', 'terminal', 'cursor']) {
      expect(target(agentJson('e', engine: engine)), isNull, reason: engine);
    }
    expect(
      target(agentJson('k', extra: {'dsh': 'autonomous/kicad'})),
      isNull,
      reason: 'a harness package lists its own engines, which the phone does not read',
    );
  });

  test('offered only on the person’s own online machine with both engines '
      'installed and signed in', () async {
    final rig = await rigWith([source()]);
    final agent = Agent.fromJson(source());
    Map<String, dynamic> engine(String id, {bool installed = true, bool? signedIn = true}) => {
      'engine': id,
      'installed': installed,
      'signedIn': ?signedIn,
    };
    Future<bool> offered(List<Map<String, dynamic>> engines) async {
      rig.conn('m').answers['engines_probe'] = (_) => {'engines': engines};
      await rig.app.probeEngines('m', force: true);
      return rig.app.offersChangeAgent('m', agent);
    }

    expect(rig.app.offersChangeAgent('m', agent), isFalse, reason: 'not probed yet');
    expect(await offered([engine('claude'), engine('codex')]), isTrue);
    expect(await offered([engine('claude'), engine('codex', signedIn: false)]), isFalse);
    expect(await offered([engine('claude'), engine('codex', signedIn: null)]), isFalse,
        reason: 'an older computer that does not say');
    expect(await offered([engine('claude', installed: false), engine('codex')]), isFalse);
    expect(await offered([engine('claude')]), isFalse);

    await offered([engine('claude'), engine('codex')]);
    final state = rig.app.machineStates['m']!;
    state.machine = Machine(
      machineId: 'm',
      authMode: state.machine.authMode,
      name: state.machine.name,
      status: state.machine.status,
      shared: true,
    );
    expect(rig.app.offersChangeAgent('m', agent), isFalse, reason: 'shared');
  });

  test('a machine another account shares: never switched from the phone', () async {
    final rig = await rigWith([source()]);
    final state = rig.app.machineStates['m']!;
    state.machine = Machine(
      machineId: 'm',
      authMode: state.machine.authMode,
      name: state.machine.name,
      status: state.machine.status,
      shared: true,
    );

    expect(
      (await rig.app.changeAgent('m', 'a', 'codex')).error,
      'Only the person whose machine runs this agent can change it.',
    );
    expect(steps(rig), isEmpty);
  });

  test('a refused close is said in the machine’s words, else in a sentence', () {
    const generic =
        'Could not save and stop this conversation. '
        'Its agent has not been changed.';
    expect(AppNotifier.closeRefusalMessage('Disk is full'), 'Disk is full');
    for (final detail in [null, '', 7]) {
      expect(AppNotifier.closeRefusalMessage(detail), generic);
    }
  });
}
