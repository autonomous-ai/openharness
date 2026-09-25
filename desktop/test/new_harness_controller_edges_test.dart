import 'dart:async';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/codex_profiles.dart';
import 'package:harness/core/first_task.dart';
import 'package:harness/core/git_worktree.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/core/repository_clone.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/ws/ws_conn.dart';

import 'swarm_state_test.dart' show createApp;

const _git = <String, dynamic>{
  'isGit': true,
  'branch': 'feature',
  'branches': [
    {'ref': 'refs/heads/main', 'name': 'main'},
    {'ref': 'refs/heads/feature', 'name': 'feature'},
    {'ref': 'refs/heads/release', 'name': 'release'},
    {
      'ref': 'refs/remotes/origin/feature',
      'name': 'origin/feature',
      'remote': true,
    },
    {
      'ref': 'refs/remotes/origin/release',
      'name': 'origin/release',
      'remote': true,
    },
  ],
};

typedef _Reply = FutureOr<Map<String, dynamic>> Function(Map<String, dynamic>);

class _Connection extends WsConn {
  _Connection()
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: 'm',
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );

  final calls = <(String, Map<String, dynamic>)>[];
  final replies = <String, _Reply>{};
  Map<String, dynamic> git = {'isGit': false};
  List<Map<String, dynamic>> catalog = [
    {
      'id': 'autonomous/blender',
      'name': 'Blender',
      'engine': 'claude',
      'engines': ['codex', 'claude'],
      'installed': true,
    },
  ];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    calls.add((type, Map.of(payload)));
    if (replies[type] case final reply?) return reply(payload);
    return switch (type) {
      'git_project_info' => {...git, 'refreshed': true},
      'engines_probe' => {
        'engines': [
          {'engine': 'codex', 'installed': true, 'supportsCodexHome': true},
          {'engine': 'claude', 'installed': true},
        ],
      },
      'dsh_list' => {'dsh': catalog},
      'fs_list_dir' => {'path': payload['path'] ?? '/home/test', 'entries': []},
      'codex_profiles_list' => {
        'profiles': [
          {'path': '/profiles/work', 'label': 'Work'},
        ],
      },
      'agent_create' || 'agent_create_status' => {
        'creationId': payload['creationId'],
        'state': 'created',
        'agent': {'id': 'created', 'name': 'Created', 'engine': 'codex'},
      },
      _ => {},
    };
  }

  Iterable<Map<String, dynamic>> requests(String type) =>
      calls.where((call) => call.$1 == type).map((call) => call.$2);
}

class _Fixture {
  _Fixture() {
    app = createApp(connectionForTest: (_) => connection, connected: true);
    app.machineStates['m']!.agents = [];
    addTearDown(app.dispose);
  }
  final connection = _Connection();
  late final AppNotifier app;
  NewHarnessController box({
    String engine = 'codex',
    String? harnessId,
    String? folder = '/work/repo',
    String? projectName,
    bool autoProject = false,
    NewHarnessDraft? draft,
  }) {
    final box = NewHarnessController(
      app,
      machineId: 'm',
      engine: engine,
      harnessId: harnessId,
      folder: folder,
      projectName: projectName,
      autoProject: autoProject,
      draft: draft,
      offersStore: true,
      now: () => DateTime(2026, 9, 25, 9, 10, 11),
    );
    addTearDown(box.dispose);
    return box;
  }
}

NewHarnessDraft _draft(
  NewHarnessProject project, {
  String engine = 'codex',
  bool? worktree,
  String? branchRef,
  String? branchName,
  GitProjectInfo? gitProject,
  LocalCodexProfile? profile,
}) => NewHarnessDraft(
  machineId: 'm',
  engine: engine,
  project: project,
  task: '',
  permissionMode: 'full',
  worktree: worktree,
  branchRef: branchRef,
  branchName: branchName,
  gitProject: gitProject,
  profile: profile,
);

Future<void> _settle() => Future<void>.delayed(Duration.zero);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  test(
    'profile support is unknown until the selected machine answers',
    () async {
      final fixture = _Fixture();
      final box = fixture.box();
      expect(box.profileHelp, 'Checking Codex profile support on Test host…');
      expect(box.supportsProfiles, isFalse);
      await _settle();
      expect(box.profileHelp, isNull);
      expect(box.supportsProfiles, isTrue);
    },
  );

  test(
    'project identity preserves generated intent in sets and draft requests',
    () {
      final generated = ProjectFolderRequest.generated(
        label: 'Codex',
        at: DateTime(2026),
      );
      final projects = [
        const NewHarnessProject.fresh('name'),
        const NewHarnessProject.folder('/work'),
        NewHarnessProject.clone(GitHubRepository.parse('openai/codex')!),
        NewHarnessProject.generated(generated),
      ];
      expect(projects.map((project) => project.isNew), [
        true,
        false,
        true,
        true,
      ]);
      expect({...projects, ...projects}, hasLength(4));
      expect(NewHarnessProject.generated(generated), projects.last);
      expect(
        NewHarnessProject.generated(generated).hashCode,
        projects.last.hashCode,
      );
      expect(
        projects.last,
        isNot(const NewHarnessProject.fresh('codex-2026-01-01-00-00')),
      );
      expect(_draft(projects.first).projectFolderRequest!.name, 'name');
      expect(_draft(projects[1]).projectFolderRequest, isNull);
      expect(
        _draft(projects[2]).projectFolderRequest!.repository!.url,
        'https://github.com/openai/codex.git',
      );
      expect(_draft(projects.last).projectFolderRequest, same(generated));
      expect(
        _draft(projects.first, engine: 'terminal').projectFolderRequest,
        isNull,
      );
      final pending = _draft(
        projects[1],
        worktree: true,
        branchRef: 'refs/heads/main',
      ).projectFolderRequest!;
      expect(pending.createsWorktree, isTrue);
      expect(pending.branchRef, 'refs/heads/main');
      final branch = _draft(
        projects[1],
        worktree: false,
        branchRef: 'refs/heads/release',
      ).projectFolderRequest!;
      expect(branch.createsWorktree, isFalse);
      expect(branch.branchRef, 'refs/heads/release');
    },
  );

  test(
    'worktree plans distinguish current, existing and remote tracking branches',
    () {
      final info = GitProjectInfo.fromJson(_git);
      WorktreePlan plan(String? base, [String? name]) => planWorktree(
        info,
        base: base,
        name: name,
        placeholder: 'brave-otter',
      );
      expect(
        plan('refs/heads/main', 'feature').kind,
        WorktreeStart.unavailable,
      );
      expect(plan('refs/heads/feature').branch, 'brave-otter');
      expect(plan('refs/remotes/origin/feature').branch, 'brave-otter');
      expect(
        plan('refs/remotes/origin/release').kind,
        WorktreeStart.existingBranch,
      );
      expect(plan('refs/heads/missing').branch, 'brave-otter');
      expect(
        plan('refs/heads/main', 'release').kind,
        WorktreeStart.existingBranch,
      );
      final fresh = plan('refs/remotes/upstream/new');
      expect(fresh.branch, 'new');
      expect(fresh.tracks, isTrue);
    },
  );

  test(
    'explicit runner and empty named drafts retain their intended launch',
    () async {
      final fixture = _Fixture();
      final runner = fixture.box(
        harnessId: 'autonomous/blender',
        engine: 'codex',
      );
      await _settle();
      expect(runner.launchAgentLabel, 'Blender · Codex');
      final named = fixture.box(
        projectName: 'my-project',
        draft: _draft(const NewHarnessProject.fresh()),
      );
      expect(named.project.name, 'my-project');
      final generated = fixture.box(
        autoProject: true,
        draft: _draft(const NewHarnessProject.fresh()),
      );
      expect(generated.project.generated, isNotNull);
      final missing = fixture.box(folder: null);
      expect(missing.projectLocation, 'Choose a project on Test host');
      expect(missing.requiredChoice!.field, NewHarnessField.projectMenu);
    },
  );

  test(
    'main stays unavailable and a delayed Git read revalidates before creating',
    () async {
      final fixture = _Fixture();
      final pending = Completer<Map<String, dynamic>>();
      fixture.connection.replies['git_project_info'] = (_) => pending.future;
      final box = fixture.box();
      final creating = box.create();
      expect(box.busy, isTrue);
      pending.complete({
        'isGit': true,
        'branch': 'trunk',
        'branches': [
          {'ref': 'refs/heads/trunk', 'name': 'trunk'},
        ],
        'refreshed': true,
      });
      expect(await creating, NewHarnessOutcome.failed);
      expect(box.branchLabel, 'main · unavailable');
      expect(box.worktree, isTrue);
      expect(box.field, NewHarnessField.branch);
      expect(box.error, contains('Choose a branch'));
      expect(fixture.connection.requests('agent_create'), isEmpty);
    },
  );

  test('early branch focus refreshes after discovery and replaces a colliding placeholder', () async {
    final fixture = _Fixture();
    final pending = Completer<Map<String, dynamic>>();
    fixture.connection.replies['git_project_info'] = (payload) =>
        payload['refresh'] == true
        ? {..._git, 'refreshed': true}
        : pending.future;
    final box = fixture.box(
      draft: _draft(
        const NewHarnessProject.folder('/work/repo'),
        gitProject: GitProjectInfo.fromJson(_git),
      ),
    );
    final placeholder = box.placeholder;
    box.focusField(NewHarnessField.branch);
    pending.complete({
      ..._git,
      'branches': [
        ..._git['branches'] as List,
        {'ref': 'refs/heads/$placeholder', 'name': placeholder},
      ],
    });
    await _settle();
    expect(box.placeholder, isNot(placeholder));
    expect(
      fixture.connection
          .requests('git_project_info')
          .where((request) => request['refresh'] == true),
      isNotEmpty,
    );
  });

  test(
    'typing the current checkout branch cannot create a second worktree',
    () async {
      final fixture = _Fixture();
      fixture.connection.git = _git;
      final box = fixture.box(
        draft: _draft(
          const NewHarnessProject.folder('/work/repo'),
          gitProject: GitProjectInfo.fromJson(_git),
          worktree: true,
          branchName: 'feature',
        ),
      );
      await _settle();
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('project folder’s branch'));
      expect(box.worktree, isTrue);
      expect(fixture.connection.requests('agent_create'), isEmpty);
    },
  );

  test('agent preview navigation never commits a runner and settings retain its provider', () async {
    final fixture = _Fixture();
    final box = fixture.box(harnessId: 'autonomous/blender');
    await _settle();
    expect(
      box.agentSettingsFor('autonomous/blender').first.detail,
      'Auto-approve',
    );
    expect(
      box.agentSettingsFor('unknown/tool').first.id,
      NewHarnessController.permissionsId,
    );
    box.focusField(NewHarnessField.agent);
    box.move(1);
    expect(box.engine, 'codex');
    final next = box.selected!.id;
    box.page(-1, 1);
    expect(box.engine, 'codex');
    expect(box.selected!.id, isNot(next));
    box.focusField(NewHarnessField.machine);
    box.nextField();
    expect(box.field, NewHarnessField.projectMenu);
  });

  test(
    'carried task validates length while editing and ignores value rows',
    () async {
      final fixture = _Fixture();
      final box = fixture.box();
      box.focusField(NewHarnessField.task);
      final oversized = 'x' * (kFirstTaskMaxLength + 1);
      box.setQuery(oversized);
      expect(box.task, oversized);
      expect(box.error, contains('this is ${oversized.length}'));
      const irrelevant = NewHarnessOption(id: 'claude', title: 'Claude');
      box.applyOption(irrelevant);
      expect(box.engine, 'codex');
      box.setQuery('Keep this');
      expect(box.error, isNull);
      box.focusField(NewHarnessField.launch);
      box.applyOption(irrelevant);
      expect(box.task, 'Keep this');
      expect(box.engine, 'codex');
    },
  );

  for (final field in [
    NewHarnessField.projectName,
    NewHarnessField.projectRepository,
  ]) {
    test(
      'a stale $field value cannot move a project to another machine',
      () async {
        final fixture = _Fixture();
        final box = fixture.box();
        box.focusField(field);
        box.applyOption(
          const NewHarnessOption(
            id: 'old',
            title: 'Old machine project',
            machineId: 'removed',
            project: NewHarnessProject.fresh('wrong-machine'),
          ),
        );
        expect(box.project.folder, '/work/repo');
        expect(box.error, contains('machine has changed'));
      },
    );
  }

  test(
    'controller doors preserve the project until a value is accepted',
    () async {
      final fixture = _Fixture();
      final box = fixture.box();
      await _settle();
      for (final (id, field) in [
        (NewHarnessController.permissionsId, NewHarnessField.mode),
        (NewHarnessController.profileId, NewHarnessField.profile),
        (NewHarnessController.changeMachineId, NewHarnessField.machine),
        (NewHarnessController.repositoryId, NewHarnessField.projectRepository),
      ]) {
        box.focusField(NewHarnessField.harness);
        box.accept(NewHarnessOption(id: id, title: 'Choose'));
        expect(box.field, field);
        expect(box.project.folder, '/work/repo');
      }
      expect(fixture.connection.requests('agent_create'), isEmpty);
    },
  );

  testWidgets(
    'missing path matches explain the empty folder without launching',
    (tester) async {
      final fixture = _Fixture();
      final box = fixture.box();
      box.focusField(NewHarnessField.project);
      box.setQuery('/no-match');
      await tester.pump(const Duration(milliseconds: 100));
      // Browse and Change Machine remain available, but neither is a path match.
      box.cursor = -1;
      box.accept();
      expect(box.error, contains('No folder matches'));
      expect(box.project.folder, '/work/repo');
      expect(fixture.connection.requests('agent_create'), isEmpty);
    },
  );

  test(
    'legacy quick start refuses browsing, Store and disabled choices',
    () async {
      final fixture = _Fixture();
      final box = fixture.box();
      await _settle();
      box.focusField(NewHarnessField.project);
      expect(await box.createNow(), NewHarnessOutcome.failed);
      expect(box.error, 'Choose a folder to continue.');
      box.focusField(NewHarnessField.harness);
      box.cursor = box.options.indexWhere(
        (row) => row.id == NewHarnessController.storeId,
      );
      expect(await box.createNow(), NewHarnessOutcome.failed);
      expect(box.error, contains('Store first'));
      box.focusField(NewHarnessField.projectName);
      box.setQuery('!!!');
      expect(box.selected!.enabled, isFalse);
      expect(await box.createNow(), NewHarnessOutcome.failed);
      expect(box.error, contains('Use a project name'));
      expect(fixture.connection.requests('agent_create'), isEmpty);
    },
  );

  test('generated projects avoid existing remote folder names without creating folders', () async {
    final fixture = _Fixture();
    fixture.connection.replies['fs_list_dir'] = (payload) => {
      'path': payload['path'] ?? '/home/test',
      'entries': [
        if (payload['path'] == '/home/test/harnesses') ...[
          {'name': 'codex-2026-09-25-09-10', 'isDir': true},
          {'name': 'codex-2026-09-25-09-10-11', 'isDir': true},
        ],
      ],
    };
    final box = fixture.box(folder: null, autoProject: true);
    await _settle();
    expect(box.project.name, 'codex-2026-09-25-09-10-11-2');
    expect(box.project.generated!.isGenerated, isTrue);
    expect(
      fixture.connection.calls.every((call) => call.$1 != 'fs_mkdir'),
      isTrue,
    );
    expect(fixture.connection.requests('agent_create'), isEmpty);
  });

  test('profile discovery includes observed agent paths and link failures preserve selection', () async {
    final fixture = _Fixture();
    fixture.app.machineStates['m']!.agents = [
      const Agent(
        id: 'existing',
        name: 'Existing',
        engine: 'codex',
        codexHome: '/profiles/seen',
      ),
    ];
    fixture.connection.replies['codex_profile_link'] = (_) => {
      'error': 'MISSING',
    };
    final box = fixture.box();
    await _settle();
    box.focusField(NewHarnessField.profile);
    await _settle();
    expect(
      fixture.connection
          .requests('codex_profiles_list')
          .single['observedPaths'],
      contains('/profiles/seen'),
    );
    await box.linkProfile('/profiles/bad');
    expect(box.linkingProfile, isFalse);
    expect(box.error, contains('Try another folder'));
    expect(box.draft.profile, isNull);
    expect(box.field, NewHarnessField.profile);
    expect(fixture.connection.requests('agent_create'), isEmpty);
  });

  test(
    'launch waits for an explicit profile check already in progress',
    () async {
      final fixture = _Fixture();
      final pending = Completer<Map<String, dynamic>>();
      fixture.connection.replies['codex_profiles_list'] = (_) => pending.future;
      final box = fixture.box(
        draft: _draft(
          const NewHarnessProject.folder('/work/repo'),
          profile: const LocalCodexProfile('/profiles/work', 'Work'),
        ),
      );
      await _settle();
      box.focusField(NewHarnessField.profile);
      expect(box.loadingProfiles, isTrue);
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, contains('still loading'));
      expect(fixture.connection.requests('agent_create'), isEmpty);
      pending.complete({
        'profiles': [
          {'path': '/profiles/work', 'label': 'Work'},
        ],
      });
      await _settle();
      expect(box.loadingProfiles, isFalse);
      expect(await box.create(), NewHarnessOutcome.created);
      expect(
        fixture.connection.requests('agent_create').single['codexHome'],
        '/profiles/work',
      );
    },
  );

  testWidgets(
    'relative paths use the committed project and old listings are evicted',
    (tester) async {
      final fixture = _Fixture();
      final box = fixture.box();
      box.focusField(NewHarnessField.project);
      for (final path in ['./child/', '../sibling/']) {
        box.setQuery(path);
        await tester.pump(const Duration(milliseconds: 100));
      }
      expect(
        fixture.connection.requests('fs_list_dir').map((call) => call['path']),
        containsAll(['/work/repo/child', '/work/sibling']),
      );
      for (var i = 0; i < 18; i++) {
        box.setQuery('/folder$i/');
        await tester.pump(const Duration(milliseconds: 100));
      }
      box.setQuery('/folder0/');
      expect(box.listing, isTrue);
      await tester.pump(const Duration(milliseconds: 100));
      expect(
        fixture.connection
            .requests('fs_list_dir')
            .where((call) => call['path'] == '/folder0'),
        hasLength(2),
      );
      expect(box.listing, isFalse);
    },
  );

  testWidgets('unresolved remote home keeps relative completion safe', (
    tester,
  ) async {
    final fixture = _Fixture();
    final home = Completer<Map<String, dynamic>>();
    fixture.connection.replies['fs_list_dir'] = (_) => home.future;
    final box = fixture.box(folder: null);
    box.focusField(NewHarnessField.project);
    box.setQuery('~/');
    expect(box.options.map((row) => row.id), [
      NewHarnessController.browseId,
      NewHarnessController.changeMachineId,
    ]);
    expect(box.total, 0);
    home.complete({'error': 'UNAVAILABLE'});
    await tester.pump(const Duration(milliseconds: 200));
    expect(box.needsProject, isTrue);
    expect(fixture.connection.requests('agent_create'), isEmpty);
  });

  test(
    'a lost creation reply cannot launch again when its machine disappears',
    () async {
      final fixture = _Fixture();
      fixture.connection.replies['agent_create'] = (_) =>
          throw const WsRequestTimeout('agent_create');
      final box = fixture.box();
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.checking, isTrue);
      fixture.app.machineStates.remove('m');
      expect(await box.create(), NewHarnessOutcome.failed);
      expect(box.error, 'Choose a machine.');
      expect(box.checking, isTrue);
      expect(fixture.connection.requests('agent_create'), hasLength(1));
    },
  );

  test(
    'late remembered agent loading leaves an unsupported task editor safely',
    () async {
      final fixture = _Fixture();
      final box = NewHarnessController(
        fixture.app,
        machineId: 'm',
        folder: '/work/repo',
      );
      addTearDown(box.dispose);
      box.focusField(NewHarnessField.task);
      box.setQuery('Keep this task');
      await fixture.app.agentPreference.select('terminal');
      await _settle();
      expect(box.engine, 'terminal');
      expect(box.field, NewHarnessField.harness);
      expect(box.query, isEmpty);
      expect(box.task, 'Keep this task');
    },
  );

  test('a harness removed during the launch probe requires an explicit replacement', () async {
    final fixture = _Fixture();
    final box = fixture.box(harnessId: 'autonomous/blender');
    await _settle();
    expect(box.requiredChoice, isNull);
    fixture.connection.catalog = [];
    expect(await box.create(), NewHarnessOutcome.failed);
    expect(box.harnessId, 'autonomous/blender');
    expect(box.error, contains('Choose an agent'));
    expect(box.field, NewHarnessField.harness);
    expect(box.busy, isFalse);
    expect(fixture.connection.requests('agent_create'), isEmpty);
  });
}
