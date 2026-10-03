import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/state/device_form.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show createApp;

class _Daemon extends WsConn {
  _Daemon()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final requests = <String>[];
  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    requests.add(type);
    if (type == 'engines_probe') return {'engines': []};
    if (type == 'dsh_list') return {'dsh': []};
    if (type == 'git_project_info') {
      return {
        'isGit': true,
        'branch': 'main',
        'branches': [
          {'ref': 'refs/heads/main', 'name': 'main'},
        ],
      };
    }
    return {};
  }
}

void main() {
  Future<(DeviceFormPort, NewHarnessController, _Daemon)> mount(
    WidgetTester t,
  ) async {
    final daemon = _Daemon(), app = createApp(connectionForTest: (_) => daemon);
    seedMixedAgents(app);
    final box = NewHarnessController(
      app,
      machineId: 'm',
      folder: '/work/openharness',
      offersStore: true,
    );
    final port = DeviceFormPort();
    addTearDown(box.dispose);
    addTearDown(app.dispose);
    await t.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: NewHarnessForm(
            controller: box,
            devicePort: port,
            onClose: port.detach,
            onCreated: port.detach,
            onStore: () =>
                fail('A device action must not open an unsupported route.'),
          ),
        ),
      ),
    );
    await t.pumpAndSettle();
    return (port, box, daemon);
  }

  Future<Map<String, dynamic>> command(
    WidgetTester t,
    DeviceFormPort p,
    String op, {
    int delta = 0,
  }) async {
    final result = p.command(op, p.snapshot()['revision'] as int, delta);
    await t.pumpAndSettle();
    return result;
  }

  Future<void> row(WidgetTester t, DeviceFormPort p, String label) async {
    for (var i = 0; i < 12 && p.snapshot()['label'] != label; i++) {
      await command(t, p, 'move', delta: 1);
    }
    expect(p.snapshot()['label'], label);
  }

  testWidgets(
    'same form: movement previews; accepting an agent never starts it',
    (t) async {
      final (port, box, daemon) = await mount(t);
      expect(port.snapshot(), containsPair('label', 'New Harness'));
      await row(t, port, 'Agent');
      await command(t, port, 'activate');
      expect(port.snapshot()['title'], 'Agent');
      final before = port.snapshot()['revision'] as int;
      await command(t, port, 'move', delta: 1);
      expect(port.command('activate', before, 0)['ok'], isFalse);
      expect(daemon.requests, isNot(contains('agent_create')));
      // Choose the direct Codex entry, avoiding any specialized runner step.
      box.move(box.options.indexWhere((o) => o.id == 'codex') - box.cursor);
      await t.pumpAndSettle();
      final chosen = port.snapshot()['revision'] as int;
      await command(t, port, 'activate');
      expect(port.snapshot()['label'], 'New Harness');
      expect(daemon.requests, isNot(contains('agent_create')));
      expect(port.command('activate', chosen, 0)['ok'], isFalse);
      await command(t, port, 'activate');
      expect(daemon.requests.where((r) => r == 'agent_create'), hasLength(1));
    },
  );

  testWidgets(
    'project movement keeps the committed machine and folder; back cancels',
    (t) async {
      final (port, box, daemon) = await mount(t);
      final folder = box.project.folder, machine = box.machineId;
      await row(t, port, 'Project');
      await command(t, port, 'activate');
      await command(t, port, 'move', delta: 1);
      expect(box.project.folder, folder);
      expect(box.machineId, machine);
      await command(t, port, 'back');
      expect(box.project.folder, folder);
      expect(box.machineId, machine);
      expect(daemon.requests, isNot(contains('agent_create')));
      await command(t, port, 'close');
      expect(port.snapshot()['active'], isFalse);
      expect(port.command('activate', 0, 0)['active'], isFalse);
    },
  );

  testWidgets(
    'desktop-only setup stays visible and cannot be invoked remotely',
    (t) async {
      final (port, box, daemon) = await mount(t);
      await row(t, port, 'Agent');
      await command(t, port, 'activate');
      final store = box.options.indexWhere(
        (o) => o.id == NewHarnessController.storeId,
      );
      expect(store, greaterThanOrEqualTo(0));
      box.move(store - box.cursor);
      await t.pumpAndSettle();
      expect(port.snapshot()['enabled'], isFalse);
      expect(port.snapshot()['error'], contains('desktop'));
      await command(t, port, 'activate');
      expect(daemon.requests, isNot(contains('agent_create')));
    },
  );

  testWidgets('spoken names filter choices; only a later tap commits', (
    t,
  ) async {
    final (port, box, daemon) = await mount(t);
    await row(t, port, 'Agent');
    final before = port.snapshot();
    final revision = before['revision'] as int;
    expect(before['canQuery'], isTrue);
    expect(
      port.command('query.begin', revision, 0, queryId: 'speech')['queryId'],
      'speech',
    );
    expect(
      port.command(
        'query',
        revision,
        0,
        queryId: 'speech',
        text: 'Codex.',
      )['ok'],
      isTrue,
    );
    await t.pumpAndSettle();
    expect(box.query, 'Codex');
    expect(port.snapshot()['label'], 'Codex');
    expect(daemon.requests, isNot(contains('agent_create')));
    expect(
      port.command(
        'query',
        revision,
        0,
        queryId: 'speech',
        text: 'Claude',
      )['ok'],
      isFalse,
    );
    await command(t, port, 'activate');
    expect(box.engine, 'codex');
    expect(daemon.requests, isNot(contains('agent_create')));
  });

  testWidgets(
    'discard, changing fields, and desktop typing invalidate spoken searches',
    (t) async {
      final (port, box, daemon) = await mount(t);
      await row(t, port, 'Project');
      var revision = port.snapshot()['revision'] as int;
      port.command('query.begin', revision, 0, queryId: 'discard');
      port.command('query.cancel', revision, 0, queryId: 'discard');
      expect(
        port.command(
          'query',
          revision,
          0,
          queryId: 'discard',
          text: 'other',
        )['ok'],
        isFalse,
      );
      expect(box.query, isEmpty);
      port.command('query.begin', revision, 0, queryId: 'moved');
      await command(t, port, 'move', delta: 1);
      expect(
        port.command(
          'query',
          revision,
          0,
          queryId: 'moved',
          text: 'other',
        )['ok'],
        isFalse,
      );
      await row(t, port, 'Agent');
      revision = port.snapshot()['revision'] as int;
      port.command('query.begin', revision, 0, queryId: 'typed');
      box.setQuery('Claude');
      expect(
        port.command(
          'query',
          revision,
          0,
          queryId: 'typed',
          text: 'Codex',
        )['ok'],
        isFalse,
      );
      expect(box.query, 'Claude');
      await command(t, port, 'back');
      await row(t, port, 'New Harness');
      expect(port.snapshot()['canQuery'], isFalse);
      expect(
        port.command(
          'query.begin',
          port.snapshot()['revision'] as int,
          0,
          queryId: 'start',
        )['ok'],
        isFalse,
      );
      expect(daemon.requests, isNot(contains('agent_create')));
    },
  );

  test('expired and malformed device requests cannot call a form', () async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    var calls = 0;
    app.deviceFormCommand = (_, _) async {
      calls++;
      return {'ok': true, 'active': false};
    };
    final frame = <String, dynamic>{
      'formId': 'form-one',
      'requestId': 'request-one',
      'op': 'activate',
      'revision': 1,
      'expiresAt': 0,
    };
    expect((await app.formFromDevice('m', frame))!['ok'], isFalse);
    expect(await app.formFromDevice('m', {...frame, 'delta': 'bad'}), isNull);
    expect(await app.formFromDevice('m', {...frame, 'op': 'run'}), isNull);
    expect(calls, 0);
  });
}
