import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/demo/sample_runtime.dart';
import 'package:harness_mobile/ws/ws_conn.dart';

void main() {
  late SampleRuntime runtime;
  late SampleConnection connection;
  setUp(() {
    runtime = SampleRuntime();
    connection = runtime.connectionFor('sample-studio');
  });
  tearDown(() => runtime.dispose());

  test('sample folders and git metadata come from fixtures', () async {
    final home = await connection.request(
      'fs_list_dir',
      payload: {'path': '.'},
    );
    expect(home['path'], '~');
    expect(home['entries'], contains(equals({'name': 'code', 'isDir': true})));
    final folder = await connection.request(
      'fs_list_dir',
      payload: {'path': ' ~/code/api/ '},
    );
    expect(folder['path'], '~/code/api');
    expect(
      folder['entries'],
      contains(equals({'name': 'tests', 'isDir': true})),
    );
    final empty = await connection.request(
      'fs_list_dir',
      payload: {'path': '~/code/unlisted'},
    );
    expect(empty['entries'], isEmpty);
    expect(
      (await connection.request(
        'git_project_info',
        payload: {'path': '~/code/scratch'},
      ))['isGit'],
      isFalse,
    );
    final repo = await connection.request(
      'git_project_info',
      payload: {'path': '~/code/api'},
    );
    expect(repo['isGit'], isTrue);
    expect(repo['defaultRef'], 'refs/remotes/origin/main');
  });

  test(
    'creation status, rename, and deletion follow the sample harness',
    () async {
      final result = await connection.request(
        'agent_create',
        payload: {
          'creationId': 'creation-one',
          'engine': 'codex',
          'repositoryUrl': 'https://example.invalid/team/project.git',
          'branchRef': 'refs/remotes/origin/feature',
        },
      );
      final agent = result['agent'] as Map;
      final id = agent['id'] as String;
      expect(agent['engine'], 'codex');
      expect((agent['project'] as Map)['cwd'], '~/code/project');
      expect(
        (await connection.request(
          'agent_create_status',
          payload: {'creationId': 'creation-one'},
        ))['agent'],
        agent,
      );
      expect(
        (await connection.request(
          'agent_create_status',
          payload: {'creationId': 'unknown'},
        ))['state'],
        'missing',
      );
      await connection.request(
        'agent_update',
        payload: {'agentId': id, 'name': '  renamed  ', 'opened': true},
      );
      final renamed = runtime.harnessOf('sample-studio', id)!;
      expect(renamed.agent['name'], 'renamed');
      expect(
        DateTime.tryParse(renamed.agent['lastOpenedAt'] as String),
        isNotNull,
      );
      await connection.request(
        'agent_update',
        payload: {'agentId': id, 'name': '   '},
      );
      expect(renamed.agent['name'], 'renamed');
      final recent = await connection.request(
        'agent_recent',
        payload: {'agentId': id},
      );
      expect(recent['asks'], isEmpty);
      await connection.request('agent_delete', payload: {'agentId': id});
      expect(runtime.harnessOf('sample-studio', id), isNull);
      final listed =
          (await connection.request('agents_list'))['agents'] as List;
      expect(listed.where((agent) => agent['id'] == id), isEmpty);
    },
  );

  test(
    'sample creation honors explicit folders and validates engines',
    () async {
      for (final payload in <Map<String, dynamic>>[
        {'cwd': ' ~/code/chosen ', 'gitSource': '~/code/ignored'},
        {'gitSource': '~/code/chosen'},
        {},
      ]) {
        final result = await connection.request(
          'agent_create',
          payload: payload,
        );
        final cwd = ((result['agent'] as Map)['project'] as Map)['cwd'];
        expect(
          cwd,
          payload.isEmpty ? startsWith('~/code/new-project-') : '~/code/chosen',
        );
      }
      await expectLater(
        connection.request('agent_create', payload: {'engine': 'missing'}),
        throwsA(
          isA<WsRequestFailure>().having(
            (e) => e.code,
            'code',
            'INVALID_ENGINE',
          ),
        ),
      );
      final probe = await connection.request(
        'engines_probe',
        payload: {
          'engines': ['codex', 'missing'],
        },
      );
      expect((probe['engines'] as List).map((e) => e['installed']), [
        true,
        false,
      ]);
    },
  );

  test(
    'the sample offers model creation and keeps the selected model',
    () async {
      final catalog = await runtime.notifier.gridModels('sample-studio');
      expect(catalog.supportsModelLaunch, isTrue);
      final model = catalog.sections.first.models.first;
      final result = await connection.request(
        'agent_create',
        payload: {
          'engine': 'codex',
          'cwd': '~/code/api',
          'gridModel': model.id,
          'gridName': model.grid,
        },
      );
      final agent = result['agent'] as Map;
      expect(agent['grid'], {'model': model.id, 'gridName': model.grid});
      expect(
        runtime.notifier
            .stateOf('sample-studio')!
            .agents
            .firstWhere((item) => item.id == agent['id'])
            .gridModel,
        model.id,
      );
    },
  );

  test('missing harnesses and unsupported requests fail explicitly', () async {
    await expectLater(
      connection.request('agent_recent', payload: {'agentId': 'gone'}),
      throwsA(
        isA<WsRequestFailure>().having(
          (e) => e.code,
          'code',
          'AGENT_NOT_FOUND',
        ),
      ),
    );
    await expectLater(
      connection.request('not_a_sample_method'),
      throwsA(
        isA<WsRequestFailure>().having((e) => e.code, 'code', 'UNSUPPORTED'),
      ),
    );
  });

  test('leaving sample mode cancels timers and refuses later input', () async {
    var fired = false;
    runtime.schedule(Duration.zero, () => fired = true);
    runtime.dispose();
    final after = runtime.schedule(Duration.zero, () => fired = true);
    expect(after.isActive, isFalse);
    expect(connection.isReady, isFalse);
    expect(await connection.sendTerminalFrame('terminal_open', {}), isFalse);
    await expectLater(
      connection.request('agents_list'),
      throwsA(isA<WsRequestFailure>().having((e) => e.code, 'code', 'CLOSED')),
    );
    await Future<void>.delayed(Duration.zero);
    expect(fired, isFalse);
  });
}
