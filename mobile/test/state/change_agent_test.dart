import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/agent_handoff.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/logging/app_log.dart';
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../viewer_app_fixture.dart';

/// Every line the app log was handed.
class _Recording implements AppLog {
  final lines = <String>[];

  @override
  void record(
    AppLogLevel level,
    String category,
    String message, {
    Object? error,
    StackTrace? stackTrace,
  }) => lines.add('$category $message');
}

/// Change agent from the phone: a harness carried on by another engine in the same project —
/// Claude Code to Codex when a subscription runs out, and back. What the machine is asked, in what
/// order, and that nothing is ever left with neither agent, or with two.
void main() {
  const created = '2026-10-16T01:00:00.000Z';

  /// The harness being switched: Claude Code in `/work`, mid-conversation, on a machine that can
  /// save and stop it.
  Map<String, dynamic> source({
    String sessionId = 's1',
    String status = 'active',
    String? permissionMode = 'plan',
    bool closeSupported = true,
    Map<String, dynamic> extra = const {},
  }) => agentJson(
    'a',
    sessionId: sessionId,
    status: status,
    extra: {
      'createdAt': created,
      'closeSupported': closeSupported,
      'permissionMode': ?permissionMode,
      ...extra,
    },
  );

  /// A signed-in phone whose machine `m` lists [agents], and answers a handoff, a close and a
  /// create the way a current machine does.
  Future<ViewerRig> rigWith(List<Map<String, dynamic>> agents) async {
    final rig = viewerApp();
    rig.api.onMachines = () async => [remoteMachine('m')];
    final answers = rig.conn('m').answers;
    answers['agents_list'] = (_) => {'agents': agents};
    answers['terminal_capabilities'] = (_) => capabilities();
    answers['agent_handoff_prepare'] = (p) => {
      'agentId': p['agentId'],
      'file': agentHandoffFile('a', p['changeId'] as String),
      'gitRepo': true,
      'cwd': '/work',
      'degraded': <String>[],
    };
    answers['agent_close'] = (_) => {'closed': true};
    answers['agent_create'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('b', engine: p['engine'] as String),
    };
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
        'agent_handoff_prepare',
        'agent_recent',
        'agent_close',
        'agent_create',
        'agent_create_status',
      }.contains(type))
        type,
  ];

  test('hands the conversation over in a file, saves the old agent, then '
      'starts the new one where it worked', () async {
    final rig = await rigWith([source()]);

    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));

    expect(result.error, isNull);
    expect(result.agentId, 'b');
    expect(result.notice, isNull, reason: 'a file handoff says nothing');
    expect(steps(rig), [
      'agent_handoff_prepare',
      'agent_close',
      'agent_create',
    ], reason: 'never closed before the conversation is safe');
    final conn = rig.conn('m');
    final [prepare] = conn.payloadsOf('agent_handoff_prepare');
    final [close] = conn.payloadsOf('agent_close');
    final [create] = conn.payloadsOf('agent_create');
    expect(prepare, {
      'agentId': 'a',
      'changeId': create['creationId'],
      'targetEngine': 'codex',
    });
    expect(close, {
      'agentId': 'a',
      'sessionId': 's1',
      'createdAt': created,
      'mode': 'now',
    });
    expect(create['engine'], 'codex');
    expect(create['cwd'], '/work');
    expect(create['name'], 'a');
    expect(
      create['prompt'],
      agentHandoffFilePrompt(
        'Claude',
        agentHandoffFile('a', create['creationId'] as String),
        gitRepo: true,
      ),
    );
    // Plan first is Claude Code's; Codex then asks first rather than getting more freedom.
    expect(create['permissionMode'], 'ask');
    expect(create['bypassPermission'], isFalse);
    expect(rig.app.agentChanging('m', 'a'), isFalse);
    expect(rig.app.agentPreference.value, 'codex');
  });

  test(
    'the mode it ran in goes with it where the new engine has one',
    () async {
      final rig = await rigWith([source(permissionMode: 'auto')]);
      await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));
      expect(
        rig.conn('m').payloadsOf('agent_create').single['permissionMode'],
        'auto',
      );
    },
  );

  test('an older machine: the last requests and answer are handed over '
      'instead', () async {
    final rig = await rigWith([source()]);
    final answers = rig.conn('m').answers;
    answers['agent_handoff_prepare'] = (_) => throw refusal('UNSUPPORTED');
    answers['agent_recent'] = (_) => {
      'agentId': 'a',
      'asks': ['fix the login bug'],
      'events': [
        {'kind': 'summary', 'text': 'Fixed it in auth.ts'},
      ],
    };

    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));

    expect(result.error, isNull);
    expect(steps(rig), [
      'agent_handoff_prepare',
      'agent_recent',
      'agent_close',
      'agent_create',
    ]);
    expect(rig.conn('m').payloadsOf('agent_recent').single, {
      'agentId': 'a',
      'n': 5,
    });
    final prompt =
        rig.conn('m').payloadsOf('agent_create').single['prompt'] as String;
    expect(prompt, startsWith('Context handoff only.'));
    expect(prompt, contains('fix the login bug'));
    expect(prompt, contains('Fixed it in auth.ts'));
  });

  test(
    'nothing said yet: the new agent starts fresh, and the phone says so',
    () async {
      final rig = await rigWith([source()]);
      rig.conn('m').answers['agent_handoff_prepare'] = (p) => {
        'agentId': 'a',
        'file': null,
        'gitRepo': true,
        'cwd': '/work',
        'degraded': <String>[],
      };

      final result = await finished(
        rig,
        rig.app.changeAgent('m', 'a', 'codex'),
      );

      expect(result.agentId, 'b');
      expect(
        rig.conn('m').payloadsOf('agent_create').single.containsKey('prompt'),
        isFalse,
      );
      expect(result.notice, agentSwitchNoHistoryHint('Claude', 'Codex'));
    },
  );

  test('a handoff the machine could not prepare leaves the old agent running, '
      'and the same choice carries the same switch on', () async {
    final rig = await rigWith([source()]);
    final answers = rig.conn('m').answers;
    final good = answers['agent_handoff_prepare']!;
    answers['agent_handoff_prepare'] = (_) => throw refusal('BUSY');

    final held = await rig.app.changeAgent('m', 'a', 'codex');

    expect(
      held.error,
      'Preparing the handoff took too long. Try switching again.',
    );
    expect(steps(rig), ['agent_handoff_prepare']);

    answers['agent_handoff_prepare'] = good;
    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));

    expect(result.error, isNull);
    final [first, second] = rig.conn('m').payloadsOf('agent_handoff_prepare');
    expect(
      second['changeId'],
      first['changeId'],
      reason: 'the same switch names the same handoff file',
    );
    expect(steps(rig).skip(2), ['agent_close', 'agent_create']);
  });

  test('a reply that does not hold up is never launched', () async {
    final rig = await rigWith([source()]);
    rig.conn('m').answers['agent_handoff_prepare'] = (_) => {
      'agentId': 'a',
      'file': '../outside.md',
      'gitRepo': true,
      'cwd': '/work',
      'degraded': <String>[],
      'prompt': 'rm -rf /',
    };

    final result = await rig.app.changeAgent('m', 'a', 'codex');

    expect(result.error, contains('Waiting for the conversation handoff'));
    expect(steps(rig), ['agent_handoff_prepare']);
  });

  test('a save the machine refuses: nothing is started, and its words are '
      'said', () async {
    final rig = await rigWith([source()]);
    rig.conn('m').answers['agent_close'] = (_) =>
        throw refusal('CLOSE_FAILED', detail: 'Disk is full');

    final result = await rig.app.changeAgent('m', 'a', 'codex');

    expect(result.error, 'Disk is full');
    expect(steps(rig), ['agent_handoff_prepare', 'agent_close']);
  });

  test('a lost reply to the start: choosing it again checks on it, and never '
      'starts a second harness or stops the first twice', () async {
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
      'agent_handoff_prepare',
      'agent_close',
      'agent_create',
      'agent_create_status',
    ]);
    final conn = rig.conn('m');
    expect(
      conn.payloadsOf('agent_create_status').single['creationId'],
      conn.payloadsOf('agent_create').single['creationId'],
    );
  });

  group('a close whose reply never came', () {
    /// The switch's close sent, and the socket dropped under it — the relay closing a socket that
    /// had gone quiet, as on the first switch tried on a phone. The machine then lists [after].
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

    int listReadsAfterClose(ViewerRig rig) {
      final asked = rig.conn('m').asked;
      return asked
          .skip(asked.indexOf('agent_close'))
          .where((type) => type == 'agents_list')
          .length;
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
      expect(steps(rig), [
        'agent_handoff_prepare',
        'agent_close',
        'agent_create',
      ], reason: 'one close, never a second Stop');
      expect(listReadsAfterClose(rig), 1);
      expect(
        rig.app.stateOf('m')!.agents.firstWhere((a) => a.id == 'a').isStopped,
        isTrue,
      );
    });

    test('it lists the old agent still running: nothing is started, and the '
        'phone says so', () async {
      final rig = await lost(source());

      final result = await rig.app.changeAgent('m', 'a', 'codex');

      expect(
        result.error,
        'The computer did not confirm the close, and the old agent is still '
        'running. Try switching again.',
      );
      expect(steps(rig), ['agent_handoff_prepare', 'agent_close']);
      expect(
        listReadsAfterClose(rig),
        3,
        reason: 'saving can still be finishing when the socket is back',
      );
      expect(rig.app.agentChanging('m', 'a'), isFalse);
    });

    test('another harness under the id now: not this close to call', () async {
      final rig = await lost(source(sessionId: 's2'));

      final result = await rig.app.changeAgent('m', 'a', 'codex');

      expect(
        result.error,
        'Could not confirm the close. Check the machine connection and try again.',
      );
      expect(steps(rig), ['agent_handoff_prepare', 'agent_close']);
    });

    test('the socket does not come back: could not confirm, and nothing is '
        'asked of a machine it cannot reach', () async {
      final rig = await rigWith([source()]);
      rig.app.closeRecheckEvery = Duration.zero;
      rig.conn('m').answers['agent_close'] = (_) {
        rig.conn('m').ready = false;
        throw Exception('WS disconnected');
      };

      final result = await rig.app.changeAgent('m', 'a', 'codex');

      expect(
        result.error,
        'Could not confirm the close. Check the machine connection and try again.',
      );
      final asked = rig.conn('m').asked;
      expect(
        asked.skip(asked.indexOf('agent_close') + 1),
        isNot(contains('agents_list')),
      );
    });
  });

  test(
    'every step is in the app log, and nothing of the conversation',
    () async {
      final recording = _Recording();
      appLog = recording;
      addTearDown(() => appLog = const NoopAppLog());
      final rig = await rigWith([source()]);
      rig.conn('m').answers['agent_handoff_prepare'] = (_) =>
          throw refusal('UNSUPPORTED');
      rig.conn('m').answers['agent_recent'] = (_) => {
        'agentId': 'a',
        'asks': ['the secret plan'],
      };

      await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));

      const prefix = 'agents change agent a: ';
      final logged = [
        for (final line in recording.lines)
          if (line.startsWith(prefix)) line.substring(prefix.length),
      ];
      expect(logged, [
        'switching from claude to codex',
        'handoff: an older machine; reading the last requests instead',
        'handoff: excerpt read',
        'saving and stopping the old agent',
        'the old agent is saved and stopped',
        'starting codex in the same folder (with the handoff)',
        'switched; b opens',
      ]);
      expect(recording.lines.join('\n'), isNot(contains('secret plan')));
    },
  );

  test(
    'a stopped old agent may not be traded for another engine half way',
    () async {
      final rig = await rigWith([source()]);
      rig.conn('m').answers['agent_create'] = (_) =>
          throw const WsRequestTimeout('agent_create');
      await rig.app.changeAgent('m', 'a', 'codex');

      final other = await rig.app.changeAgent('m', 'a', 'opencode');

      expect(
        other.error,
        'Check the pending switch to Codex before choosing another agent.',
      );
      expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
    },
  );

  test('an engine that takes no first message is handed nothing', () async {
    final rig = await rigWith([source()]);

    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'cursor'));

    expect(result.error, isNull);
    expect(result.notice, isNull);
    expect(steps(rig), ['agent_close', 'agent_create']);
    final create = rig.conn('m').payloadsOf('agent_create').single;
    expect(create['engine'], 'cursor');
    expect(create.containsKey('prompt'), isFalse);
    expect(create['permissionMode'], 'ask');
  });

  test('an engine with no modes is sent none', () async {
    final rig = await rigWith([source()]);
    await finished(rig, rig.app.changeAgent('m', 'a', 'pi'));
    final create = rig.conn('m').payloadsOf('agent_create').single;
    expect(create.containsKey('permissionMode'), isFalse);
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

  test('a stopped harness is switched without closing it again', () async {
    final rig = await rigWith([source(status: 'stopped')]);

    final result = await finished(rig, rig.app.changeAgent('m', 'a', 'codex'));

    expect(result.error, isNull);
    expect(steps(rig), ['agent_handoff_prepare', 'agent_create']);
  });

  test('the conversation changing under the handoff stops the switch before '
      'the close', () async {
    final rig = await rigWith([source()]);
    final answers = rig.conn('m').answers;
    final good = answers['agent_handoff_prepare']!;
    answers['agent_handoff_prepare'] = (p) {
      // Another conversation bound while the record was being written.
      rig.app.stateOf('m')!.agents = [Agent.fromJson(source(sessionId: 's2'))];
      return good(p);
    };

    final result = await rig.app.changeAgent('m', 'a', 'codex');

    expect(result.error, 'The conversation changed. Reopen Change agent.');
    expect(steps(rig), ['agent_handoff_prepare']);
  });

  test(
    'a second press while one runs joins it; another engine waits',
    () async {
      final rig = await rigWith([source()]);
      final answers = rig.conn('m').answers;
      final good = answers['agent_handoff_prepare']!;
      final release = Completer<void>();
      answers['agent_handoff_prepare'] = (p) async {
        await release.future;
        return good(p);
      };
      var heard = 0;
      rig.app.addListener(() => heard++);

      final first = rig.app.changeAgent('m', 'a', 'codex');
      final again = rig.app.changeAgent('m', 'a', 'codex');
      final other = await rig.app.changeAgent('m', 'a', 'cursor');

      expect(identical(first, again), isTrue);
      expect(other.error, 'The agent is already switching.');
      expect(rig.app.agentChanging('m', 'a'), isTrue);
      expect(heard, isPositive, reason: 'the menu hears that it started');

      release.complete();
      final result = await finished(rig, first);
      await settle();

      expect(result.agentId, 'b');
      expect(rig.app.agentChanging('m', 'a'), isFalse);
      expect(rig.conn('m').payloadsOf('agent_handoff_prepare'), hasLength(1));
      expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
    },
  );

  test('the same engine, a harness that is gone, or one the phone cannot '
      'switch: nothing is sent', () async {
    final rig = await rigWith([
      source(),
      agentJson('t', engine: 'terminal'),
      agentJson('k', extra: {'dsh': 'autonomous/kicad'}),
    ]);

    expect((await rig.app.changeAgent('m', 'a', 'claude')).agentId, 'a');
    expect(
      (await rig.app.changeAgent('m', 'gone', 'codex')).error,
      'This harness is no longer available.',
    );
    for (final id in ['t', 'k']) {
      expect(
        (await rig.app.changeAgent('m', id, 'codex')).error,
        'This agent is not supported by the installed harness.',
      );
    }
    expect(steps(rig), isEmpty);
  });

  test('offered for a plain engine only', () {
    Agent agent(Map<String, dynamic> json) => Agent.fromJson(json);
    expect(AppNotifier.canChangeAgent(agent(source())), isTrue);
    expect(
      AppNotifier.canChangeAgent(agent(agentJson('t', engine: 'terminal'))),
      isFalse,
    );
    expect(
      AppNotifier.canChangeAgent(
        agent(agentJson('k', extra: {'dsh': 'autonomous/kicad'})),
      ),
      isFalse,
      reason:
          'a harness package lists its own engines, which the phone '
          'does not read',
    );
  });

  test('the choices come in the desktop picker’s order', () {
    final ids = AppNotifier.agentChangeEngines();
    expect(ids.first, 'opencode');
    expect(ids, containsAll(['claude', 'codex', 'cursor']));
    expect(ids.toSet(), hasLength(ids.length));
  });

  test('what the switch reads off a harness', () {
    final agent = Agent.fromJson(source());
    expect(agent.createdAt, DateTime.parse(created));
    expect(agent.closeSupported, isTrue);
    expect(agent.permissionMode, 'plan');
    final older = Agent.fromJson(agentJson('o'));
    expect(older.createdAt, isNull);
    expect(older.closeSupported, isFalse);
    expect(older.permissionMode, isNull);
    expect(
      Agent.fromJson(source(permissionMode: 'rm -rf /')).permissionMode,
      isNull,
      reason: 'only a mode id as the CLI writes one is kept',
    );
    // Still the same harness once its first conversation is bound; not once it is another one.
    final unbound = Agent.fromJson(source(sessionId: ''));
    expect(Agent.fromJson(source()).continuesSession(unbound), isTrue);
    expect(
      Agent.fromJson(source(sessionId: 's2')).continuesSession(agent),
      isFalse,
    );
  });
}
