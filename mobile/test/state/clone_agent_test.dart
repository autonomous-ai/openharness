import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

import '../viewer_app_fixture.dart';

/// Clone from the phone: another harness of the same kind, in the same folder, with a fresh
/// conversation — the desktop's Clone Harness (⌘⇧N). What the machine is asked for, read off the
/// source's own frame, and that a lost reply is checked rather than answered with a second clone.
void main() {
  /// A signed-in phone whose machine `m` lists [agents] and creates what it is asked for as `c`.
  Future<ViewerRig> rigWith(List<Map<String, dynamic>> agents) async {
    final rig = viewerApp();
    rig.api.onMachines = () async => [remoteMachine('m')];
    final answers = rig.conn('m').answers;
    answers['agents_list'] = (_) => {'agents': agents};
    answers['terminal_capabilities'] = (_) => capabilities();
    answers['agent_create'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('c', engine: p['engine'] as String),
    };
    await rig.app.bootstrap();
    await settle();
    rig.app.connectionStatusForTest('m', ConnectionStatus.connected);
    await settle();
    addTearDown(rig.app.dispose);
    return rig;
  }

  List<String> listed(ViewerRig rig) => [
    for (final agent in rig.app.stateOf('m')!.agents) agent.id,
  ];

  group('the frame', () {
    test('carries what a clone is launched with', () {
      final agent = Agent.fromJson(
        agentJson(
          'a',
          extra: {'bypassPermission': false, 'namedAgent': 'reviewer'},
        ),
      );
      expect(agent.bypassPermission, isFalse);
      expect(agent.namedAgent, 'reviewer');
      expect(agent.canClone, isTrue);
    });

    test('a named agent that is not an id is not read as one', () {
      final agent = Agent.fromJson(
        agentJson('a', extra: {'namedAgent': '../etc/passwd'}),
      );
      expect(agent.namedAgent, isNull);
    });

    test('a grid agent cannot be cloned', () {
      final agent = Agent.fromJson(
        agentJson(
          'a',
          extra: {
            'grid': {'model': 'qwen3-coder'},
          },
        ),
      );
      expect(agent.canClone, isFalse);
    });
  });

  test('the same folder, engine, harness, profile, named agent and mode, '
      'under a fresh name — and the clone joins the list', () async {
    final rig = await rigWith([
      agentJson(
        'a',
        name: 'api',
        engine: 'codex',
        extra: {
          'codexHome': '/Users/me/.codex-work',
          'dsh': 'autonomous/kicad',
          'namedAgent': 'reviewer',
          'permissionMode': 'plan',
          'bypassPermission': false,
        },
      ),
    ]);

    final error = await rig.app.cloneAgent('m', 'a');

    expect(error, isNull);
    final [sent] = rig.conn('m').payloadsOf('agent_create');
    expect(Map.of(sent)..remove('creationId'), {
      'engine': 'codex',
      'cwd': '/work',
      'dsh': 'autonomous/kicad',
      'codexHome': '/Users/me/.codex-work',
      'agent': 'reviewer',
      'permissionMode': 'plan',
      'bypassPermission': false,
      'name': 'api - clone',
    });
    expect(rig.app.cloneAttempt('m', 'a')?.agentId, 'c');
    expect(listed(rig), containsAll(['a', 'c']));
    expect(rig.app.agentCloning('m', 'a'), isFalse);
  });

  test('a launch the machine never recorded clones the way a new one '
      'opens', () async {
    final rig = await rigWith([agentJson('a')]);

    await rig.app.cloneAgent('m', 'a');

    final [sent] = rig.conn('m').payloadsOf('agent_create');
    expect(sent['bypassPermission'], isTrue);
    expect(sent.containsKey('permissionMode'), isFalse);
    expect(sent.containsKey('agent'), isFalse);
    expect(sent.containsKey('dsh'), isFalse);
  });

  test('a terminal clones to a terminal the machine names, with nothing to '
      'bypass', () async {
    final rig = await rigWith([agentJson('t', engine: 'terminal')]);

    expect(await rig.app.cloneAgent('m', 't'), isNull);

    final [sent] = rig.conn('m').payloadsOf('agent_create');
    expect(sent['engine'], 'terminal');
    expect(sent['cwd'], '/work');
    expect(sent['bypassPermission'], isFalse);
    expect(sent.containsKey('name'), isFalse);
  });

  test('a profile outside Codex is not sent', () async {
    final rig = await rigWith([
      agentJson('a', extra: {'codexHome': '/Users/me/.codex-work'}),
    ]);

    await rig.app.cloneAgent('m', 'a');

    expect(
      rig.conn('m').payloadsOf('agent_create').single.containsKey('codexHome'),
      isFalse,
    );
  });

  test('what cannot be cloned says why and asks nothing', () async {
    final rig = await rigWith([
      agentJson(
        'g',
        extra: {
          'grid': {'model': 'qwen3-coder'},
        },
      ),
      {...agentJson('n'), 'project': null},
    ]);

    expect(
      await rig.app.cloneAgent('m', 'g'),
      'g runs on a grid; cloning a grid harness is not supported.',
    );
    expect(
      await rig.app.cloneAgent('m', 'n'),
      'n has no project folder to clone into.',
    );
    expect(
      await rig.app.cloneAgent('m', 'gone'),
      'The source harness is no longer available.',
    );
    expect(rig.conn('m').payloadsOf('agent_create'), isEmpty);
  });

  test('pressed again while it is out joins the first', () async {
    final rig = await rigWith([agentJson('a')]);
    final reply = Completer<Map<String, dynamic>>();
    rig.conn('m').answers['agent_create'] = (_) => reply.future;

    final first = rig.app.cloneAgent('m', 'a');
    final second = rig.app.cloneAgent('m', 'a');
    expect(rig.app.agentCloning('m', 'a'), isTrue);
    final [sent] = rig.conn('m').payloadsOf('agent_create');
    reply.complete({
      'creationId': sent['creationId'],
      'state': 'created',
      'agent': agentJson('c'),
    });

    expect(await first, isNull);
    expect(await second, isNull);
    expect(rig.conn('m').payloadsOf('agent_create'), hasLength(1));
    expect(rig.app.agentCloning('m', 'a'), isFalse);
  });

  test('a lost reply is checked under the same receipt the next time, never '
      'cloned again', () async {
    final rig = await rigWith([agentJson('a')]);
    final conn = rig.conn('m');
    conn.answers['agent_create'] = (_) =>
        throw const WsRequestTimeout('agent_create');

    expect(
      await rig.app.cloneAgent('m', 'a'),
      'The clone is not confirmed yet. Tap Clone again to check before '
      'starting another.',
    );

    conn.answers['agent_create_status'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('c'),
    };
    expect(await rig.app.cloneAgent('m', 'a'), isNull);

    final receipt = conn.payloadsOf('agent_create').single['creationId'];
    expect(conn.payloadsOf('agent_create_status'), [
      {'creationId': receipt},
    ]);
    expect(rig.app.cloneAttempt('m', 'a')?.agentId, 'c');

    // Confirmed, it is let go: the next Clone is a new one.
    conn.answers['agent_create'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('d'),
    };
    await rig.app.cloneAgent('m', 'a');
    expect(conn.payloadsOf('agent_create'), hasLength(2));
    expect(rig.app.cloneAttempt('m', 'a')?.agentId, 'd');
  });

  test('a refusal before anything started is said, and the next Clone is a '
      'new request', () async {
    final rig = await rigWith([agentJson('a')]);
    final conn = rig.conn('m');
    conn.answers['agent_create'] = (_) => throw refusal('CWD_NOT_FOUND');

    expect(
      await rig.app.cloneAgent('m', 'a'),
      'The project folder is unavailable on Machine m. Choose another '
      'folder and try again.',
    );

    conn.answers['agent_create'] = (p) => {
      'creationId': p['creationId'],
      'state': 'created',
      'agent': agentJson('c'),
    };
    expect(await rig.app.cloneAgent('m', 'a'), isNull);
    final [first, second] = conn.payloadsOf('agent_create');
    expect(first['creationId'], isNot(second['creationId']));
  });
}
