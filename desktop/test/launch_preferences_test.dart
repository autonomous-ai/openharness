import 'dart:async';
import 'dart:convert';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/agent_preference.dart';
import 'package:harness/core/codex_profiles.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/git_worktree.dart';
import 'package:harness/core/launch_setup.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/permission_modes.dart';
import 'package:harness/core/project_history.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/ws/ws_conn.dart';

import 'support/mixed_agents.dart';
import 'swarm_state_test.dart' show MemoryStore, createApp;

const _agentKey = 'new_harness_preferences_v1';
const _projectKey = 'new_agent_projects_v1';

class _Store extends MemoryStore {
  final pendingReads = <String, Completer<String?>>{};
  final writes = <(String, String)>[];
  bool failWrites = false;

  @override
  Future<String?> read(String key) =>
      pendingReads[key]?.future ?? super.read(key);

  @override
  Future<void> write(String key, String value) async {
    writes.add((key, value));
    if (failWrites) throw StateError('Fixture storage unavailable');
    await super.write(key, value);
  }
}

const _git = <String, dynamic>{
  'isGit': true,
  'branch': 'feature',
  'branches': [
    {'ref': 'refs/heads/main', 'name': 'main'},
    {'ref': 'refs/heads/feature', 'name': 'feature'},
  ],
};

class _Connection extends WsConn {
  _Connection(String machine)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: machine,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final creates = <Map<String, dynamic>>[];
  final gitAnswers = <String, Map<String, dynamic>>{};
  Map<String, dynamic>? failure;

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    switch (type) {
      case 'engines_probe':
        return {
          'engines': [
            for (final engine in kEnginePermissionModes.keys)
              {'engine': engine, 'installed': true},
          ],
        };
      case 'dsh_list':
        return {'dsh': []};
      case 'fs_list_dir':
        return {'path': '/home/user', 'entries': []};
      case 'git_project_info':
        return gitAnswers[payload['path']] ??
            (payload['path'] == '/plain' ? {'isGit': false} : _git);
      case 'codex_profiles_list':
        return {'profiles': []};
      case 'agent_create':
        creates.add(Map.of(payload));
        if (failure != null) {
          return {
            'creationId': payload['creationId'],
            'state': 'failed',
            ...failure!,
          };
        }
        return {
          'creationId': payload['creationId'],
          'state': 'created',
          'agent': {
            'id': 'created-${creates.length}',
            'name': 'Created',
            'engine': payload['engine'],
            'terminalAvailable': true,
            'project': {
              'name': 'repo',
              'cwd': payload['cwd'] ?? '/worktrees/repo/new-task',
            },
          },
        };
      default:
        return {};
    }
  }
}

class _Fixture {
  _Fixture({MemoryStore? storage, bool machines = false}) {
    app = createApp(
      store: storage,
      connectionForTest: (id) =>
          connections.putIfAbsent(id, () => _Connection(id)),
      connected: true,
    );
    if (machines) seedMixedAgents(app);
    addTearDown(app.dispose);
  }

  late final AppNotifier app;
  final connections = <String, _Connection>{};

  NewHarnessController open({
    String machine = 'm',
    String? engine = 'codex',
    String folder = '/repo',
    NewHarnessDraft? draft,
    bool desktop = false,
  }) {
    final box = NewHarnessController(
      app,
      machineId: machine,
      engine: engine,
      folder: folder,
      draft: draft,
    );
    box.useDesktopChoices(desktop);
    addTearDown(box.dispose);
    return box;
  }
}

Future<void> _settle() => Future<void>.delayed(Duration.zero);

void _mode(NewHarnessController box, String mode) {
  box.focusField(NewHarnessField.mode);
  expect(box.field, NewHarnessField.mode);
  box.accept(box.options.singleWhere((row) => row.id == mode));
}

void _engine(NewHarnessController box, String engine) {
  box.focusField(NewHarnessField.agent);
  box.accept(box.options.singleWhere((row) => row.id == engine));
  expect(box.engine, engine);
}

void _machine(NewHarnessController box, String machine) {
  box.focusField(NewHarnessField.machine);
  box.accept(box.options.singleWhere((row) => row.id == machine));
  expect(box.machineId, machine);
}

String _storedModes(Map<String, Object?> modes) =>
    jsonEncode({'engine': 'codex', 'permissionsByEngine': modes});

String _storedWorktrees(Map<String, Map<String, Object?>> machines) =>
    jsonEncode({
      for (final entry in machines.entries)
        entry.key: {'worktrees': entry.value},
    });

void main() {
  test('new harnesses default to OpenCode and Muse without changing explicit choices', () async {
    final fixture = _Fixture();
    final fresh = fixture.open(engine: null);
    expect(fresh.engine, 'opencode');
    expect(fresh.modelLabel, 'Muse Spark 1.3');
    final explicit = fixture.open(engine: 'claude');
    expect(explicit.engine, 'claude');
    await fixture.app.agentPreference.selectLaunch('codex');
    final remembered = fixture.open(engine: null);
    expect(remembered.engine, 'codex');
  });

  test(
    'explicit agent defaults persist without inventing a recent launch',
    () async {
      final storage = _Store();
      final preferences = AgentPreference(storage);
      await preferences.remember('grok');
      await preferences.selectLaunch('claude', harnessId: 'autonomous/blender');
      await preferences.selectLaunch('codex', harnessId: 'autonomous/blender');
      final restored = AgentPreference(storage);
      await restored.load();
      expect(restored.harness, 'autonomous/blender');
      expect(restored.value, 'codex');
      expect(restored.engineFor('autonomous/blender'), 'codex');
      expect(restored.recentChoices, ['grok']);
      await restored.selectLaunch('claude');
      expect(restored.harness, isNull);
      expect(restored.engineFor(null), 'claude');
      expect(restored.engineFor('autonomous/blender'), 'codex');
    },
  );

  test(
    'desktop ignores cancelled choices when opening the next form',
    () async {
      final storage = _Store();
      final fixture = _Fixture(storage: storage);
      final box = fixture.open(desktop: true);
      await _settle();
      _engine(box, 'claude');
      box.setFolder('/chosen/project');
      await _settle();
      expect(fixture.app.agentPreference.successfulLaunch, isNull);
      expect(fixture.app.projectHistory.lastLaunched, isNull);
      expect(fixture.connections.values.expand((c) => c.creates), isEmpty);
      final next = fixture.open(engine: null, desktop: true);
      await _settle();
      expect(next.engine, 'opencode');
    },
  );

  test(
    'desktop defaults to main with saved worktree off and sends that branch',
    () async {
      final fixture = _Fixture();
      await fixture.app.agentPreference.remember('codex', worktree: false);
      final box = fixture.open(desktop: true);
      await _settle();
      expect(box.worktree, isFalse);
      expect(box.branchRef, 'refs/heads/main');
      expect(box.projectFolderRequest!.branchRef, 'refs/heads/main');
      box.focusField(NewHarnessField.branch);
      box.accept(
        box.options.singleWhere((row) => row.id == 'refs/heads/feature'),
      );
      final restored = fixture.open(draft: box.draft, desktop: true);
      final fresh = fixture.open(desktop: true);
      await _settle();
      expect(restored.branchRef, 'refs/heads/feature');
      expect(fresh.branchRef, 'refs/heads/main');
      expect(await fresh.create(), NewHarnessOutcome.created);
      expect(
        fixture.connections['m']!.creates.single['branchRef'],
        'refs/heads/main',
      );
    },
  );

  test('desktop does not substitute a remote or different branch for missing local main', () async {
    final fixture = _Fixture();
    await fixture.app.agentPreference.remember('codex', worktree: false);
    final connection = fixture.connections.putIfAbsent(
      'm',
      () => _Connection('m'),
    );
    connection.gitAnswers['/repo'] = {
      ..._git,
      'branches': [
        {'ref': 'refs/heads/feature', 'name': 'feature'},
        {
          'ref': 'refs/remotes/origin/main',
          'name': 'origin/main',
          'remote': true,
        },
      ],
    };
    final box = fixture.open(desktop: true);
    await _settle();
    expect(box.branchRef, isNull);
    expect(box.requiredChoice?.field, NewHarnessField.branch);
    expect(box.branchLabel, 'main · unavailable');
    box.toggleWorktree();
    expect(box.branchRef, 'refs/remotes/origin/main');
  });

  test(
    'successful desktop choices apply globally after launch and reload',
    () async {
      final storage = _Store();
      final fixture = _Fixture(storage: storage);
      final box = fixture.open(desktop: true);
      await _settle();
      _engine(box, 'claude');
      _mode(box, 'plan');
      box.toggleWorktree();
      expect(fixture.app.agentPreference.successfulLaunch, isNull);
      expect(fixture.app.agentPreference.successfulWorktree, isNull);
      expect(await box.create(), NewHarnessOutcome.created);
      final preferences = AgentPreference(storage);
      await preferences.load();
      expect(preferences.successfulLaunch?.engine, 'claude');
      expect(preferences.successfulLaunch?.permissionMode, 'plan');
      expect(preferences.successfulWorktree, isFalse);
      final other = fixture.open(
        engine: null,
        folder: '/another',
        desktop: true,
      );
      await _settle();
      expect(other.engine, 'claude');
      expect(other.mode, 'plan');
      expect(other.worktree, isFalse);
      expect(other.branchRef, 'refs/heads/main');
      expect(other.task, isEmpty);
      final history = ProjectHistory(storage);
      await history.load();
      expect(history.lastLaunched, (machineId: 'm', folder: '/repo'));
    },
  );

  test(
    'a non-Git launch preserves the last successful worktree preference',
    () async {
      final fixture = _Fixture();
      await fixture.app.agentPreference.remember('codex', worktree: false);
      final box = fixture.open(
        engine: 'claude',
        folder: '/plain',
        desktop: true,
      );
      await _settle();
      expect(await box.create(), NewHarnessOutcome.created);
      expect(fixture.app.agentPreference.successfulLaunch?.engine, 'claude');
      final next = fixture.open(engine: null, desktop: true);
      await _settle();
      expect(next.worktree, isFalse);
    },
  );

  test(
    'failed desktop launches leave the last successful setup intact',
    () async {
      final fixture = _Fixture();
      await fixture.app.agentPreference.remember('codex', worktree: true);
      final box = fixture.open(desktop: true);
      await _settle();
      _engine(box, 'claude');
      _mode(box, 'plan');
      box.toggleWorktree();
      fixture.connections['m']!.failure = {
        'failure': {'code': 'WORKTREE_FAILED', 'detail': 'Fixture failure'},
      };
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(fixture.app.agentPreference.successfulLaunch?.engine, 'codex');
      expect(fixture.app.agentPreference.successfulWorktree, isTrue);
      expect(fixture.app.projectHistory.lastLaunched, isNull);
    },
  );

  test(
    'retrying a prepared worktree remembers the original isolation choice',
    () async {
      final fixture = _Fixture();
      await fixture.app.agentPreference.remember('codex', worktree: false);
      final connection = fixture.connections.putIfAbsent(
        'm',
        () => _Connection('m'),
      );
      connection.gitAnswers['/worktrees/repo/task'] = {
        ..._git,
        'branch': 'task',
        'mainFolder': '/repo',
        'mainBranch': 'feature',
      };
      connection.failure = {
        'preparedFolder': '/worktrees/repo/task',
        'failure': {'code': 'TMUX_UNAVAILABLE'},
      };
      final box = fixture.open(desktop: true);
      await _settle();
      box.toggleWorktree();
      expect(await box.create(), NewHarnessOutcome.failed);
      await _settle();
      expect(box.worktree, isFalse);
      expect(fixture.app.agentPreference.successfulWorktree, isFalse);
      final retry = fixture.open(draft: box.draft, desktop: true);
      await _settle();
      connection.failure = null;
      expect(await retry.create(), NewHarnessOutcome.created);
      await _settle();
      expect(fixture.app.agentPreference.successfulWorktree, isTrue);
      expect(connection.creates.last['projectSource'], 'branch');
    },
  );

  test(
    'model routes and machine-scoped account references survive reload',
    () async {
      final storage = _Store();
      final preferences = AgentPreference(storage);
      const model = GridModel(
        id: 'Qwen-35B',
        node: 'Studio',
        grid: 'team-grid',
      );
      await preferences.remember(
        'codex',
        setup: const LaunchSetup(
          engine: 'codex',
          model: model,
          permissionMode: 'readOnly',
        ),
      );
      var restored = AgentPreference(storage);
      await restored.load();
      expect(restored.successfulLaunch?.model?.id, model.id);
      expect(restored.successfulLaunch?.model?.node, model.node);
      expect(restored.successfulLaunch?.model?.grid, model.grid);
      await preferences.remember(
        'codex',
        setup: const LaunchSetup(
          engine: 'codex',
          profile: LocalCodexProfile('/accounts/work', 'Work'),
          profileMachineId: 'm',
        ),
      );
      restored = AgentPreference(storage);
      await restored.load();
      expect(restored.successfulLaunch?.model, isNull);
      final fixture = _Fixture(storage: storage, machines: true);
      final local = fixture.open(engine: null, desktop: true);
      final remote = fixture.open(
        engine: null,
        machine: 'studio',
        desktop: true,
      );
      await _settle();
      expect(local.draft.profile?.path, '/accounts/work');
      expect(remote.draft.profile, isNull);
    },
  );

  test(
    'internal utilities cannot replace launch defaults or user projects',
    () async {
      final storage = _Store();
      final preferences = AgentPreference(storage);
      await preferences.remember('codex', worktree: false);
      await preferences.remember(
        'opencode',
        harnessId: 'autonomous/harness-monitor',
        worktree: true,
      );
      expect(preferences.successfulLaunch?.engine, 'codex');
      expect(preferences.successfulWorktree, isFalse);
      expect(preferences.recentChoices, ['codex']);
      final history = ProjectHistory(storage);
      await history.select('m', '/repo', launched: true);
      await history.select(
        'm',
        '/harnesses/harness-monitor-2026-09-21-18-41',
        launched: true,
      );
      await history.select('studio', '/just-browsing');
      expect(history.lastLaunched, (machineId: 'm', folder: '/repo'));
      expect(history.recent('m'), ['/repo']);
      // A normal repository with this name remains selectable.
      await history.select('m', '/projects/harness-monitor', launched: true);
      expect(history.lastLaunched?.folder, '/projects/harness-monitor');
    },
  );

  test(
    'legacy successful history migrates without using cancelled defaults',
    () async {
      final storage = _Store()
        ..values['new_agent_engine'] = 'claude'
        ..values['new_agent_recent'] = 'codex';
      final preferences = AgentPreference(storage);
      await preferences.load();
      expect(preferences.successfulLaunch?.engine, 'codex');
      expect(LaunchSetup.fromJson({'engine': 'terminal'}), isNull);
      expect(
        LaunchSetup.fromJson({
          'engine': 'opencode',
          'harness': 'autonomous/harness-monitor',
        }),
        isNull,
      );
      expect(
        LaunchSetup.fromJson({'engine': 'codex', 'permissionMode': 'plan'})
            ?.permissionMode,
        kDefaultPermissionMode,
      );
    },
  );

  test(
    'migration ignores dropdown-only defaults with no successful launch',
    () async {
      final storage = _Store();
      await AgentPreference(storage).selectLaunch('claude');
      final restored = AgentPreference(storage);
      await restored.load();
      expect(restored.successfulLaunch, isNull);
      final fixture = _Fixture(storage: storage);
      final box = fixture.open(engine: null, desktop: true);
      await _settle();
      expect(box.engine, 'opencode');
    },
  );

  test(
    'launch recency interleaves harnesses and agents across reloads',
    () async {
      final storage = _Store();
      final preferences = AgentPreference(storage);
      await preferences.remember('grok');
      await preferences.remember('codex', harnessId: 'autonomous/blender');
      await preferences.remember('cursor');
      await preferences.remember('codex', harnessId: 'autonomous/rdkit');
      await preferences.remember('grok');
      final restored = AgentPreference(storage);
      await restored.load();
      expect(restored.recentChoices, [
        'grok',
        'autonomous/rdkit',
        'cursor',
        'autonomous/blender',
      ]);
      expect(restored.recentChoices, isNot(contains('codex')));
      expect(restored.engineFor('autonomous/rdkit'), 'codex');
    },
  );

  test('old launch history migrates with the last used choice first', () async {
    final storage = _Store()
      ..values[_agentKey] = jsonEncode({
        'engine': 'cursor',
        'harness': null,
        'agents': ['cursor', 'codex'],
        'harnesses': ['autonomous/blender'],
      });
    final preferences = AgentPreference(storage);
    await preferences.load();
    expect(preferences.recentChoices, [
      'cursor',
      'autonomous/blender',
      'codex',
    ]);
    await preferences.remember('grok');
    final restored = AgentPreference(storage);
    await restored.load();
    expect(restored.recentChoices, [
      'grok',
      'cursor',
      'autonomous/blender',
      'codex',
    ]);
  });

  test(
    'desktop keeps every coding agent above recent specialized harnesses',
    () async {
      final fixture = _Fixture();
      final box = fixture.open();
      await _settle();
      const featured = [
        'autonomous/blender',
        'autonomous/circuitjs',
        'autonomous/godogen',
        'autonomous/mujoco',
        'autonomous/rdkit',
        'autonomous/strudel',
        'autonomous/typst',
      ];
      fixture.app.machineStates['m']!.dsh.replace([
        for (final id in [...featured, 'autonomous/manim'])
          DshEntry(id: id, name: id, engine: 'codex'),
      ]);
      box.useDesktopChoices(true);
      box.focusField(NewHarnessField.harness);
      const leading = [
        'claude',
        'codex',
        'cursor',
        'copilot',
        'grok',
        'opencode',
      ];
      final engines = allEngines.map((engine) => engine.id).toSet();
      final initial = box.options.map((option) => option.id).toList();
      expect(initial.take(leading.length), leading);
      expect(initial.take(engines.length).toSet(), engines);
      expect(initial.skip(engines.length).take(featured.length), featured);
      expect(initial.last, kTerminalEngine);
      await fixture.app.agentPreference.remember(
        'codex',
        harnessId: 'autonomous/rdkit',
      );
      await fixture.app.agentPreference.remember('cursor');
      await fixture.app.agentPreference.remember(
        'codex',
        harnessId: 'removed/tool',
      );
      box.focusField(NewHarnessField.launch);
      box.focusField(NewHarnessField.harness);
      final ids = box.options.map((o) => o.id).toList();
      expect(ids.take(engines.length), initial.take(engines.length));
      expect(ids.skip(engines.length).take(featured.length), [
        'autonomous/rdkit',
        ...featured.where((id) => id != 'autonomous/rdkit'),
      ]);
      expect(ids.toSet().length, ids.length);
      expect(ids, isNot(contains('removed/tool')));
      expect(ids, contains('autonomous/manim'));
      expect(ids.last, kTerminalEngine);
      // A search for a specialized harness still brings that match to the top.
      box.setQuery('rdkit');
      expect(box.options.first.id, 'autonomous/rdkit');
      box.setQuery('');
      expect(box.options.map((option) => option.id), ids);
    },
  );

  group('approval preference storage', () {
    test(
      'each engine keeps its last explicit supported mode across reloads',
      () async {
        final storage = _Store();
        final preferences = AgentPreference(storage);
        await preferences.remember('claude', harnessId: 'studio/agent');
        await preferences.setAdvanced(true);
        final expected = <String, String>{};
        for (final entry in kEnginePermissionModes.entries) {
          for (final mode in entry.value) {
            await preferences.selectPermissionMode(entry.key, mode.id);
            expected[entry.key] = mode.id;
            final reloaded = AgentPreference(storage);
            await reloaded.load();
            for (final choice in expected.entries) {
              expect(reloaded.permissionModeFor(choice.key), choice.value);
            }
            expect(reloaded.value, 'claude');
            expect(reloaded.harness, 'studio/agent');
            expect(reloaded.recent, ['claude']);
            expect(reloaded.engineFor('studio/agent'), 'claude');
            expect(reloaded.advancedOpen, isTrue);
          }
        }
      },
    );

    test(
      'malformed and unsupported stored modes never become approvals',
      () async {
        for (final raw in [
          'not json',
          '[]',
          '{"permissionsByEngine":[]}',
          _storedModes({
            'codex': 'plan',
            'claude': 'readOnly',
            'cursor': 'full',
            'opencode': true,
            'terminal': 'full',
            'retired': 'full',
          }),
        ]) {
          final storage = _Store()..values[_agentKey] = raw;
          final preferences = AgentPreference(storage);
          await preferences.load();
          for (final engine in [
            ...kEnginePermissionModes.keys,
            'terminal',
            'retired',
          ]) {
            expect(preferences.permissionModeFor(engine), isNull, reason: raw);
          }
        }
        final storage = _Store()
          ..values[_agentKey] = _storedModes({
            'codex': 'ask',
            'claude': 'plan',
          });
        final preferences = AgentPreference(storage);
        await preferences.load();
        await preferences.selectPermissionMode('codex', 'plan');
        await preferences.selectPermissionMode('terminal', 'full');
        expect(preferences.permissionModeFor('codex'), 'ask');
        expect(preferences.permissionModeFor('claude'), 'plan');
        expect(storage.writes, isEmpty);
      },
    );

    test(
      'new explicit modes win over a delayed read and serialize in order',
      () async {
        final read = Completer<String?>();
        final storage = _Store()..pendingReads[_agentKey] = read;
        final preferences = AgentPreference(storage);
        final loading = preferences.load();
        final first = preferences.selectPermissionMode('codex', 'readOnly');
        final other = preferences.selectPermissionMode('claude', 'plan');
        final last = preferences.selectPermissionMode('codex', 'ask');
        read.complete(_storedModes({'codex': 'full', 'claude': 'auto'}));
        await Future.wait([loading, first, other, last]);
        expect(preferences.permissionModeFor('codex'), 'ask');
        expect(preferences.permissionModeFor('claude'), 'plan');
        storage.pendingReads.clear();
        final reloaded = AgentPreference(storage);
        await reloaded.load();
        expect(reloaded.permissionModeFor('codex'), 'ask');
        expect(reloaded.permissionModeFor('claude'), 'plan');
      },
    );

    test(
      'unavailable storage leaves explicit choices usable in this session',
      () async {
        for (final storage in <_Store?>[null, _Store()..failWrites = true]) {
          final preferences = AgentPreference(storage);
          await preferences.selectPermissionMode('codex', 'readOnly');
          await preferences.selectPermissionMode('claude', 'plan');
          expect(preferences.permissionModeFor('codex'), 'readOnly');
          expect(preferences.permissionModeFor('claude'), 'plan');
        }
      },
    );
  });

  group('worktree preference storage', () {
    test('choices are isolated by machine and path without changing project history', () async {
      final storage = _Store();
      final history = ProjectHistory(storage);
      await history.select('m', '/selected');
      await history.selectWorktree('m', '/repo', false);
      await history.selectWorktree('m', '/other', true);
      await history.selectWorktree('studio', '/repo', true);
      final reloaded = ProjectHistory(storage);
      await reloaded.load();
      expect(reloaded.worktreeFor('m', '/repo'), isFalse);
      expect(reloaded.worktreeFor('m', '/other'), isTrue);
      expect(reloaded.worktreeFor('studio', '/repo'), isTrue);
      expect(reloaded.worktreeFor('studio', '/other'), isNull);
      expect(reloaded.worktreeFor('m', '/repo-extra'), isNull);
      expect(reloaded.selected('m'), '/selected');
      expect(reloaded.recent('m'), ['/selected']);
      expect(reloaded.hasSelection('studio'), isFalse);
      expect(reloaded.recent('studio'), isEmpty);
    });

    test(
      'corrupt values and invalid paths cannot create remembered toggles',
      () async {
        final invalidPaths = [
          'relative',
          '',
          '/bad\npath',
          '/bad\u0000path',
          '/${'x' * 4096}',
        ];
        final storage = _Store()
          ..values[_projectKey] = _storedWorktrees({
            'm': {
              '/repo': false,
              '/other': true,
              '/wrong-string': 'false',
              '/wrong-int': 0,
              for (final path in invalidPaths) path: true,
            },
          });
        final history = ProjectHistory(storage);
        await history.load();
        for (final path in [...invalidPaths, '/wrong-string', '/wrong-int']) {
          expect(history.worktreeFor('m', path), isNull);
        }
        for (final path in invalidPaths) {
          await history.selectWorktree('m', path, false);
        }
        expect(history.worktreeFor('m', '/repo'), isFalse);
        expect(history.worktreeFor('m', '/other'), isTrue);
        expect(storage.writes, isEmpty);
        for (final raw in ['broken', '[]', '{"m":{"worktrees":[]}}']) {
          final broken = ProjectHistory(_Store()..values[_projectKey] = raw);
          await broken.load();
          expect(broken.worktreeFor('m', '/repo'), isNull);
          await broken.selectWorktree('m', '/repo', false);
          expect(broken.worktreeFor('m', '/repo'), isFalse);
        }
      },
    );

    test('rapid choices made during a slow read preserve the latest value and other projects', () async {
      final read = Completer<String?>();
      final storage = _Store()..pendingReads[_projectKey] = read;
      final history = ProjectHistory(storage);
      final first = history.selectWorktree('m', '/repo', false);
      final second = history.selectWorktree('m', '/repo', true);
      final last = history.selectWorktree('m', '/repo', false);
      read.complete(
        _storedWorktrees({
          'm': {'/repo': true, '/other': false},
          'studio': {'/repo': true},
        }),
      );
      await Future.wait([first, second, last]);
      storage.pendingReads.clear();
      final reloaded = ProjectHistory(storage);
      await reloaded.load();
      expect(reloaded.worktreeFor('m', '/repo'), isFalse);
      expect(reloaded.worktreeFor('m', '/other'), isFalse);
      expect(reloaded.worktreeFor('studio', '/repo'), isTrue);
    });

    test(
      'bounded history retains the most recently changed projects',
      () async {
        final storage = _Store();
        final history = ProjectHistory(storage);
        for (var i = 0; i < 40; i++) {
          await history.selectWorktree('m', '/repo-$i', false);
        }
        await history.selectWorktree('m', '/repo-0', true);
        await history.selectWorktree('m', '/repo-40', true);
        final reloaded = ProjectHistory(storage);
        await reloaded.load();
        expect(reloaded.worktreeFor('m', '/repo-0'), isTrue);
        expect(reloaded.worktreeFor('m', '/repo-1'), isNull);
        expect(reloaded.worktreeFor('m', '/repo-2'), isFalse);
        expect(reloaded.worktreeFor('m', '/repo-40'), isTrue);
      },
    );

    test('storage failures do not undo the visible worktree choice', () async {
      for (final storage in <_Store?>[null, _Store()..failWrites = true]) {
        final history = ProjectHistory(storage);
        await history.selectWorktree('m', '/repo', false);
        expect(history.worktreeFor('m', '/repo'), isFalse);
        await history.selectWorktree('m', '/repo', true);
        expect(history.worktreeFor('m', '/repo'), isTrue);
      }
    });
  });

  group('launch preference behavior', () {
    test(
      'browsing and cancelling approvals does not remember a hovered mode',
      () async {
        final storage = _Store()
          ..values[_agentKey] = _storedModes({
            'codex': 'readOnly',
            'claude': 'plan',
          });
        final fixture = _Fixture(storage: storage);
        final box = fixture.open();
        await _settle();
        expect(box.mode, 'readOnly');
        box.focusField(NewHarnessField.mode);
        box.setQuery('full');
        expect(box.selected!.id, 'full');
        box.back();
        expect(box.mode, 'readOnly');
        expect(
          fixture.app.agentPreference.permissionModeFor('codex'),
          'readOnly',
        );
        expect(storage.writes.where((write) => write.$1 == _agentKey), isEmpty);
        _mode(box, 'ask');
        await _settle();
        expect(fixture.connections['m']!.creates, isEmpty);
        final reloaded = AgentPreference(storage);
        await reloaded.load();
        expect(reloaded.permissionModeFor('codex'), 'ask');
        expect(reloaded.permissionModeFor('claude'), 'plan');
        expect(
          reloaded.value,
          'codex',
          reason: 'A permission choice does not count as a launch.',
        );
      },
    );

    test('switching engines restores independent approval modes, including after Terminal', () async {
      final storage = _Store()
        ..values[_agentKey] = _storedModes({
          'codex': 'readOnly',
          'claude': 'plan',
        });
      final fixture = _Fixture(storage: storage);
      final box = fixture.open();
      await _settle();
      expect(box.mode, 'readOnly');
      _engine(box, 'claude');
      expect(box.mode, 'plan');
      _mode(box, 'acceptEdits');
      _engine(box, 'codex');
      expect(box.mode, 'readOnly');
      _mode(box, 'ask');
      _engine(box, 'terminal');
      expect(box.hasModes, isFalse);
      _engine(box, 'claude');
      expect(box.mode, 'acceptEdits');
      _engine(box, 'codex');
      expect(box.mode, 'ask');
      await _settle();
      final next = fixture.open(engine: 'claude');
      await _settle();
      expect(next.mode, 'acceptEdits');
      expect(fixture.app.agentPreference.permissionModeFor('terminal'), isNull);
    });

    test(
      'previewed agent approvals stay separate until explicitly accepted',
      () async {
        final storage = _Store()
          ..values[_agentKey] = _storedModes({
            'codex': 'readOnly',
            'claude': 'plan',
          });
        final fixture = _Fixture(storage: storage);
        final box = fixture.open();
        await _settle();
        expect(
          box
              .agentSettingsFor('claude')
              .singleWhere(
                (row) => row.id == NewHarnessController.permissionsId,
              )
              .detail,
          'Plan first',
        );
        box.focusField(NewHarnessField.agent);
        box.openAgentSetting('claude', NewHarnessController.permissionsId);
        expect(box.selected!.id, 'plan');
        box.setQuery('skip all');
        expect(box.selected!.id, 'full');
        box.back();
        expect(box.engine, 'codex');
        expect(box.mode, 'readOnly');
        box.openAgentSetting('claude', NewHarnessController.permissionsId);
        box.accept(box.options.singleWhere((row) => row.id == 'acceptEdits'));
        await _settle();
        expect(box.engine, 'claude');
        expect(box.mode, 'acceptEdits');
        expect(
          fixture.app.agentPreference.permissionModeFor('claude'),
          'acceptEdits',
        );
        expect(
          fixture.app.agentPreference.permissionModeFor('codex'),
          'readOnly',
        );
        expect(fixture.connections['m']!.creates, isEmpty);
      },
    );

    test('unsupported remembered modes use the engine default and never cross engines', () async {
      final storage = _Store()
        ..values[_agentKey] = _storedModes({
          'codex': 'plan',
          'claude': 'readOnly',
        });
      final fixture = _Fixture(storage: storage);
      final box = fixture.open();
      await _settle();
      expect(box.mode, kDefaultPermissionMode);
      _engine(box, 'claude');
      expect(box.mode, kDefaultPermissionMode);
      expect(fixture.app.agentPreference.permissionModeFor('codex'), isNull);
      expect(fixture.app.agentPreference.permissionModeFor('claude'), isNull);
    });

    test('late approval reads update the form but cannot replace a new explicit choice', () async {
      for (final chooseBeforeRead in [false, true]) {
        final read = Completer<String?>();
        final storage = _Store()..pendingReads[_agentKey] = read;
        final fixture = _Fixture(storage: storage);
        final box = fixture.open();
        await _settle();
        if (chooseBeforeRead) _mode(box, 'readOnly');
        final observed = <String>[];
        box.addListener(() => observed.add(box.mode));
        read.complete(_storedModes({'codex': 'full', 'claude': 'plan'}));
        await _settle();
        final expected = chooseBeforeRead ? 'readOnly' : 'full';
        expect(box.mode, expected);
        expect(observed, contains(expected));
        expect(
          fixture.app.agentPreference.permissionModeFor('codex'),
          expected,
        );
      }
    });

    test(
      'late worktree reads repaint and preserve a toggle made during loading',
      () async {
        for (final chooseBeforeRead in [false, true]) {
          final read = Completer<String?>();
          final storage = _Store()..pendingReads[_projectKey] = read;
          final fixture = _Fixture(storage: storage);
          final box = fixture.open();
          await _settle();
          expect(box.worktree, isTrue);
          if (chooseBeforeRead) box.toggleWorktree();
          final observed = <bool>[];
          box.addListener(() => observed.add(box.worktree));
          read.complete(
            _storedWorktrees({
              'm': {'/repo': chooseBeforeRead},
            }),
          );
          await _settle();
          expect(box.worktree, isFalse);
          expect(observed, contains(false));
          expect(fixture.app.projectHistory.worktreeFor('m', '/repo'), isFalse);
          expect(box.branchRef, 'refs/heads/feature');
        }
      },
    );

    test('worktree follows the selected machine and project and remembers cancelled edits', () async {
      final storage = _Store();
      final fixture = _Fixture(storage: storage, machines: true);
      final box = fixture.open();
      await _settle();
      box.toggleWorktree();
      expect(box.worktree, isFalse);
      await _settle();
      box.setFolder('/other');
      await _settle();
      expect(box.worktree, isTrue);
      box.setFolder('/repo');
      await _settle();
      expect(box.worktree, isFalse);
      _machine(box, 'studio');
      box.setFolder('/repo');
      await _settle();
      expect(
        box.worktree,
        isTrue,
        reason: 'The same path belongs to a different host.',
      );
      box.toggleWorktree();
      box.toggleWorktree();
      await _settle();
      _machine(box, 'm');
      await _settle();
      expect(box.project.folder, '/repo');
      expect(box.worktree, isFalse);
      final next = fixture.open();
      await _settle();
      expect(next.worktree, isFalse);
      expect(
        fixture.connections.values.expand((conn) => conn.creates),
        isEmpty,
      );
      final reloaded = ProjectHistory(storage);
      await reloaded.load();
      expect(reloaded.worktreeFor('m', '/repo'), isFalse);
      expect(reloaded.worktreeFor('studio', '/repo'), isTrue);
      expect(reloaded.hasSelection('m'), isFalse);
    });

    test('a draft keeps its reviewed approvals and worktree over later remembered defaults', () async {
      final storage = _Store()
        ..values[_agentKey] = _storedModes({'codex': 'readOnly'})
        ..values[_projectKey] = _storedWorktrees({
          'm': {'/repo': false},
        });
      final fixture = _Fixture(storage: storage);
      final original = fixture.open();
      await _settle();
      final draft = original.draft;
      final reviewedRequest = original.projectFolderRequest!.payload;
      expect(draft.permissionMode, 'readOnly');
      expect(draft.worktree, isFalse);
      expect(draft.projectFolderRequest!.payload, reviewedRequest);
      await fixture.app.agentPreference.selectPermissionMode('codex', 'full');
      await fixture.app.projectHistory.selectWorktree('m', '/repo', true);
      final restored = fixture.open(draft: draft);
      await _settle();
      expect(restored.mode, 'readOnly');
      expect(restored.worktree, isFalse);
      expect(restored.projectFolderRequest!.payload, reviewedRequest);
      final fresh = fixture.open();
      await _settle();
      expect(fresh.mode, 'full');
      expect(fresh.worktree, isTrue);
    });

    test(
      'explicit draft values win even when preference reads finish afterwards',
      () async {
        final agentRead = Completer<String?>();
        final projectRead = Completer<String?>();
        final storage = _Store()
          ..pendingReads[_agentKey] = agentRead
          ..pendingReads[_projectKey] = projectRead;
        final fixture = _Fixture(storage: storage);
        final box = fixture.open(
          draft: NewHarnessDraft(
            machineId: 'm',
            engine: 'codex',
            project: const NewHarnessProject.folder('/repo'),
            task: 'Review without making changes',
            permissionMode: 'readOnly',
            worktree: true,
            gitProject: GitProjectInfo.fromJson(_git),
          ),
        );
        agentRead.complete(_storedModes({'codex': 'full'}));
        projectRead.complete(
          _storedWorktrees({
            'm': {'/repo': false},
          }),
        );
        await _settle();
        expect(box.mode, 'readOnly');
        expect(box.worktree, isTrue);
        expect(box.task, 'Review without making changes');
        expect(box.projectFolderRequest!.payload['projectSource'], 'worktree');
      },
    );

    test('launching a restored draft does not redefine last explicit approval or worktree choices', () async {
      final storage = _Store()
        ..values[_agentKey] = _storedModes({'codex': 'ask'})
        ..values[_projectKey] = _storedWorktrees({
          'm': {'/repo': true},
        });
      final fixture = _Fixture(storage: storage);
      final box = fixture.open(
        draft: NewHarnessDraft(
          machineId: 'm',
          engine: 'codex',
          project: const NewHarnessProject.folder('/repo'),
          task: '',
          permissionMode: 'readOnly',
          worktree: false,
          gitProject: GitProjectInfo.fromJson(_git),
        ),
      );
      await _settle();
      expect(await box.create(), NewHarnessOutcome.created);
      await _settle();
      final payload = fixture.connections['m']!.creates.single;
      expect(payload['permissionMode'], 'readOnly');
      expect(payload['projectSource'], 'branch');
      final preferences = AgentPreference(storage);
      final history = ProjectHistory(storage);
      await Future.wait([preferences.load(), history.load()]);
      expect(preferences.permissionModeFor('codex'), 'ask');
      expect(history.worktreeFor('m', '/repo'), isTrue);
    });

    test(
      'non-Git and Terminal cannot overwrite the remembered project toggle',
      () async {
        final storage = _Store()
          ..values[_projectKey] = _storedWorktrees({
            'm': {'/repo': false},
          });
        final fixture = _Fixture(storage: storage);
        final box = fixture.open();
        await _settle();
        _engine(box, 'terminal');
        await _settle();
        expect(box.canUseWorktree, isFalse);
        box.toggleWorktree();
        _engine(box, 'codex');
        await _settle();
        expect(box.worktree, isFalse);
        box.setFolder('/plain');
        await _settle();
        expect(box.canUseWorktree, isFalse);
        box.toggleWorktree();
        expect(fixture.app.projectHistory.worktreeFor('m', '/plain'), isNull);
        expect(fixture.app.projectHistory.worktreeFor('m', '/repo'), isFalse);
        expect(
          storage.writes.where((write) => write.$1 == _projectKey),
          isEmpty,
        );
      },
    );

    for (final worktree in [false, true]) {
      test(
        'reload sends exact remembered approvals and worktree=$worktree at launch',
        () async {
          final storage = _Store();
          await AgentPreference(storage)
              .selectPermissionMode('codex', 'readOnly');
          await ProjectHistory(storage).selectWorktree('m', '/repo', worktree);
          final fixture = _Fixture(storage: storage);
          final box = fixture.open();
          await _settle();
          expect(box.mode, 'readOnly');
          expect(box.worktree, worktree);
          final request = box.projectFolderRequest!.payload;
          expect(
            request,
            worktree
                ? {
                    'projectSource': 'worktree',
                    'gitSource': '/repo',
                    'branchRef': 'refs/heads/main',
                    'branchName': box.placeholder,
                    'branchMode': 'placeholder',
                  }
                : {
                    'projectSource': 'branch',
                    'gitSource': '/repo',
                    'branchRef': 'refs/heads/feature',
                  },
          );
          expect(await box.create(), NewHarnessOutcome.created);
          final payload = fixture.connections['m']!.creates.single;
          expect(payload, containsPair('engine', 'codex'));
          expect(payload, containsPair('permissionMode', 'readOnly'));
          expect(payload, containsPair('bypassPermission', false));
          expect({...payload}..remove('creationId'), {
            'engine': 'codex',
            ...request,
            'bypassPermission': false,
            'permissionMode': 'readOnly',
          });
        },
      );
    }

    test('linked worktree entry uses the main project preference and current main branch', () async {
      final storage = _Store()
        ..values[_projectKey] = _storedWorktrees({
          'm': {'/repo': false},
        });
      final fixture = _Fixture(storage: storage);
      final connection = fixture.connections.putIfAbsent(
        'm',
        () => _Connection('m'),
      );
      connection.gitAnswers['/worktrees/repo/task'] = {
        ..._git,
        'branch': 'task',
        'mainFolder': '/repo',
        'mainBranch': 'feature',
      };
      final box = fixture.open(folder: '/worktrees/repo/task');
      await _settle();
      expect(box.project.folder, '/repo');
      expect(box.worktree, isFalse);
      expect(box.branchRef, 'refs/heads/feature');
      expect(box.projectFolderRequest!.payload, {
        'projectSource': 'branch',
        'gitSource': '/repo',
        'branchRef': 'refs/heads/feature',
      });
      box.toggleWorktree();
      await _settle();
      expect(fixture.app.projectHistory.worktreeFor('m', '/repo'), isTrue);
      expect(
        fixture.app.projectHistory.worktreeFor('m', '/worktrees/repo/task'),
        isNull,
      );
    });

    test('failed worktree preparation retry does not persist its automatic worktree-off state', () async {
      final storage = _Store();
      await ProjectHistory(storage).selectWorktree('m', '/repo', true);
      final fixture = _Fixture(storage: storage);
      final connection = fixture.connections.putIfAbsent(
        'm',
        () => _Connection('m'),
      );
      connection.gitAnswers['/worktrees/repo/task'] = {
        ..._git,
        'branch': 'task',
        'mainFolder': '/repo',
        'mainBranch': 'feature',
      };
      connection.failure = {
        'preparedFolder': '/worktrees/repo/task',
        'failure': {'code': 'TMUX_UNAVAILABLE'},
      };
      final box = fixture.open();
      await _settle();
      expect(await box.create(), NewHarnessOutcome.failed);
      await _settle();
      expect(box.project.folder, '/repo');
      expect(box.worktree, isFalse);
      expect(box.branchRef, 'refs/heads/task');
      expect(fixture.app.projectHistory.worktreeFor('m', '/repo'), isTrue);
      final fresh = fixture.open();
      await _settle();
      expect(fresh.worktree, isTrue);
      expect(fresh.branchRef, 'refs/heads/main');
    });
  });
}
