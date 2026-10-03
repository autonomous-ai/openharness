import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/agent_output_stats.dart';
import 'package:harness_mobile/core/agent_preference.dart';
import 'package:harness_mobile/core/device_name.dart';
import 'package:harness_mobile/core/fuzzy_match.dart';
import 'package:harness_mobile/core/git_project.dart';
import 'package:harness_mobile/core/harness_file_store.dart';
import 'package:harness_mobile/core/local_key_value_store.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/core/phone_search_history.dart';
import 'package:harness_mobile/core/project_folder.dart';
import 'package:harness_mobile/core/project_history.dart';
import 'package:harness_mobile/state/external_session.dart';
import 'package:harness_mobile/state/search_when.dart';
import 'package:harness_mobile/state/session_content_search.dart';

import 'voice_fakes.dart' show MemoryKeyValueStore;

/// The parts of `core/` the phone's screens stand on: what a machine's answers
/// are read into, what a new agent's Git choices become, how the search ranks,
/// and what is kept on disk between launches.
void main() {
  group('Git choices', () {
    GitProjectInfo repo({
      String? branch = 'main',
      String? defaultRef = 'refs/remotes/origin/main',
      List<GitBranch> branches = const [
        GitBranch('refs/heads/main', 'main'),
        GitBranch('refs/heads/feature', 'feature'),
        GitBranch('refs/heads/busy', 'busy', worktree: '/w/busy'),
        GitBranch('refs/remotes/origin/main', 'origin/main', remote: true),
        GitBranch('refs/remotes/origin/only-remote', 'x', remote: true),
      ],
    }) => GitProjectInfo(
      isGit: true,
      branch: branch,
      defaultRef: defaultRef,
      branches: branches,
    );

    test('a machine\'s answer is read, and what it cannot mean is dropped', () {
      final info = GitProjectInfo.fromJson({
        'isGit': true,
        'branch': 'main',
        'mainFolder': 'relative/path',
        'mainBranch': 'main',
        'defaultRef': 'refs/tags/v1',
        'root': '/w/app',
        'branches': [
          {'ref': 'refs/heads/main', 'name': 'main', 'harness': true},
          {'ref': 'refs/heads/x', 'name': 'x', 'worktree': '/w/x'},
          {'ref': 3},
          'junk',
        ],
      });

      expect(info.isGit, isTrue);
      expect(info.mainFolder, isNull, reason: 'not an absolute path');
      expect(info.defaultRef, isNull, reason: 'not a branch ref');
      expect(info.root, '/w/app');
      expect(info.branches.map((b) => b.name), ['main', 'x']);
      expect(info.branches.first.harness, isTrue);
      expect(info.branches.last.worktree, '/w/x');
      expect(info.unavailable, isFalse);
      expect(
        GitProjectInfo.fromJson({'error': 'UNAVAILABLE'}).unavailable,
        isTrue,
      );
    });

    test('where Start begins with nothing chosen', () {
      final info = repo();

      expect(currentBranchRef(info), 'refs/heads/main');
      expect(currentBranchRef(repo(branch: 'gone')), isNull);
      expect(worktreeByDefault(info), isTrue);
      expect(worktreeByDefault(const GitProjectInfo(isGit: true)), isFalse);
      expect(defaultBranchRef(info, worktree: false), 'refs/heads/main');
      expect(defaultBranchRef(info, worktree: true), 'refs/heads/main');
      expect(
        defaultBranchRef(
          repo(defaultRef: 'refs/remotes/origin/dev'),
          worktree: true,
        ),
        'refs/remotes/origin/dev',
        reason: 'no local branch of that name: the remote itself',
      );
      expect(
        defaultBranchRef(repo(defaultRef: null), worktree: true),
        'refs/heads/main',
      );
    });

    test('a worktree plan for every kind of base and name', () {
      final info = repo();
      WorktreePlan plan({String? base, String? name}) =>
          planWorktree(info, base: base, name: name, placeholder: 'calm-otter');

      // Typed names.
      expect(plan(name: 'new-thing').kind, WorktreeStart.newBranch);
      expect(plan(name: 'new-thing').branch, 'new-thing');
      expect(plan(name: 'main').kind, WorktreeStart.unavailable);
      expect(plan(name: 'feature').kind, WorktreeStart.existingBranch);
      expect(plan(name: 'busy').kind, WorktreeStart.openWorktree);
      expect(plan(name: 'busy').worktree, '/w/busy');

      // Nothing typed.
      expect(plan().branch, 'calm-otter');
      expect(plan(base: 'refs/remotes/origin/main').branch, 'calm-otter');
      expect(plan(base: 'refs/heads/main').branch, 'calm-otter');
      expect(
        plan(base: 'refs/heads/feature').kind,
        WorktreeStart.existingBranch,
      );
      expect(plan(base: 'refs/heads/missing').branch, 'calm-otter');
      expect(
        plan(base: 'refs/remotes/origin/feature').kind,
        WorktreeStart.existingBranch,
      );

      final tracking = plan(base: 'refs/remotes/origin/only-remote');
      expect(tracking.kind, WorktreeStart.newBranch);
      expect(tracking.branch, 'only-remote');
      expect(tracking.tracks, isTrue);
      expect(plan(name: 'x', base: 'refs/heads/main').tracks, isFalse);

      // The folder's own branch, picked from the list, starts a new branch.
      final own = planWorktree(
        repo(defaultRef: null),
        base: 'refs/heads/main',
        name: null,
        placeholder: 'calm-otter',
      );
      expect(own.kind, WorktreeStart.newBranch);
      expect(own.branch, 'calm-otter');
    });

    test('what the machine is asked to do with the folder', () {
      final info = repo();
      ProjectFolderRequest? request({
        bool worktree = true,
        String? ref,
        String? name,
      }) => gitFolderRequest(
        '/w/app',
        info,
        worktree: worktree,
        branchRef: ref,
        branchName: name,
        placeholder: 'calm-otter',
      );

      expect(request(worktree: false)!.payload, {
        'projectSource': 'branch',
        'gitSource': '/w/app',
        'branchRef': 'refs/heads/main',
      });
      expect(request(worktree: false, name: 'fresh')!.payload, {
        'projectSource': 'branch',
        'gitSource': '/w/app',
        'branchRef': 'refs/heads/fresh',
        'branchName': 'fresh',
      });
      expect(
        gitFolderRequest(
          '/w/app',
          repo(branch: null),
          worktree: false,
          branchRef: null,
          branchName: null,
          placeholder: 'p',
        ),
        isNull,
      );
      expect(request()!.payload, {
        'projectSource': 'worktree',
        'gitSource': '/w/app',
        'branchRef': 'refs/heads/main',
        'branchName': 'calm-otter',
        'branchMode': 'placeholder',
      });
      expect(request(name: 'feature')!.payload['branchMode'], 'existing');
      expect(request(name: 'busy')!.payload, {
        'projectSource': 'branch',
        'gitSource': '/w/app',
        'branchRef': 'refs/heads/busy',
      });
      expect(
        request(name: 'typed')!.payload.containsKey('branchMode'),
        isFalse,
      );
    });

    test('with Worktree off, only a name no branch has is a new one', () {
      final info = repo();

      expect(newBranchHere(info, null), isNull);
      expect(newBranchHere(info, '  '), isNull);
      expect(newBranchHere(info, 'feature'), isNull);
      expect(newBranchHere(info, ' fresh '), 'fresh');
    });

    test('a placeholder branch is two words none of the taken ones use', () {
      final taken = <String>{};
      final random = Random(1);
      for (var i = 0; i < 50; i++) {
        final name = placeholderBranch(taken, random: random);
        expect(taken, isNot(contains(name)));
        expect(name, matches(RegExp(r'^[a-z]+-[a-z]+(-\d+)?$')));
        taken.add(name);
      }
      // Every name taken: a suffix.
      final all = {
        for (final a in kPlaceholderAdjectives)
          for (final n in kPlaceholderNouns) 'refs/heads/$a-$n',
      };
      expect(placeholderBranch(all), matches(RegExp(r'-\d+$')));
    });

    test('a typed name becomes a branch git accepts', () {
      expect(branchNameFrom('  fix the  login  '), 'fix-the-login');
      expect(branchNameFrom('a..b~c^d:e?f*g[h\\i'), 'a.bcdefghi');
      expect(branchNameFrom('-/.lead'), 'lead');
      expect(branchNameFrom('x//y/.z'), 'x/y/z');
      expect(branchNameFrom('name.lock'), 'name');
      expect(branchNameFrom('ends/.'), 'ends');
      expect(branchNameFrom('a@{b'), 'a@b');
      expect(branchNameFrom('@'), '');
      expect(branchNameFrom('a---b'), 'a-b');

      expect(plausibleBranchName('ok/name'), isTrue);
      expect(plausibleBranchName(''), isFalse);
      expect(plausibleBranchName('-x'), isFalse);
      expect(plausibleBranchName('has space'), isFalse);
      expect(plausibleBranchName('x' * 256), isFalse);
      expect(validGitPath('/abs'), isTrue);
      expect(validGitPath('rel'), isFalse);
      expect(validGitPath('/a\u0001b'), isFalse);
      expect(validGitRef('refs/heads/x'), isTrue);
      expect(validGitRef('refs/tags/x'), isFalse);
    });
  });

  group('fuzzy matching', () {
    test('a subsequence, its spread, and where each letter landed', () {
      final at = <(int, int)>[];

      expect(subsequenceSpread('harness', ''), 0);
      expect(
        subsequenceSpread('harness', 'hns', onMatch: (s, e) => at.add((s, e))),
        5,
      );
      expect(at, [(0, 1), (3, 4), (5, 6)]);
      expect(subsequenceSpread('harness', 'z'), isNull);
      expect(subsequenceSpread('harness', 'h', from: 1), isNull);
    });

    test('a word starts after anything that is not a letter or digit', () {
      expect(startsWord('fix-auth', 0), isTrue);
      expect(startsWord('fix-auth', 4), isTrue);
      expect(startsWord('fix-auth', 5), isFalse);
      expect(startsWord('a9', 1), isFalse);
      expect(startsWord('a\u00a0b', 2), isTrue);
      expect(startsWord('a·b', 2), isTrue);
      expect(startsWord('a—b', 2), isTrue);
      expect(startsWord('é b', 1), isFalse);
      expect(startsWord('éb', 1), isFalse);
      expect(startsWord('中b', 1), isFalse);
      expect(startsWord('🙂b', 2), isTrue);
    });

    test('a term found only where it begins a word', () {
      expect(wordStartIndexOf('windows port', 'port'), 8);
      expect(wordStartIndexOf('support', 'port'), -1);
      expect(wordStartIndexOf('abc', '', 5), 3);
    });

    test('scattered letters stay close and start on a word', () {
      final at = <(int, int)>[];

      expect(
        wordSubsequenceSpread(
          'fix authentication',
          'ath',
          onMatch: (s, e) => at.add((s, e)),
        ),
        isNotNull,
      );
      expect(at.first.$1, 4);
      expect(wordSubsequenceSpread('command', 'cmd'), isNotNull);
      expect(wordSubsequenceSpread('x', ''), 0);
      expect(wordSubsequenceSpread('autonomous-harness', 'auth'), isNull);
      expect(wordSubsequenceSpread('abc', 'xyz'), isNull);
      // Two letters count only as initials.
      expect(wordSubsequenceSpread('new split', 'ns'), isNotNull);
      expect(wordSubsequenceSpread('harness', 'hn'), isNull);
      final initials = <(int, int)>[];
      wordSubsequenceSpread(
        'new split',
        'ns',
        onMatch: (s, e) => initials.add((s, e)),
      );
      expect(initials, [(0, 1), (4, 5)]);
      // Too far apart to count.
      expect(wordSubsequenceSpread('a${' ' * 40}bc', 'abc'), isNull);
      // A later start that finds the tightest spread wins.
      expect(wordSubsequenceSpread('dxxxxxial dial', 'dial'), 3);
    });
  });

  group('models off the wire', () {
    test('the account\'s profile, and what it cannot be', () {
      expect(
        () => CurrentUserProfile.fromMe({'user': 'x'}),
        throwsFormatException,
      );
      expect(
        () => CurrentUserProfile.fromMe({
          'user': {'email': ' '},
        }),
        throwsFormatException,
      );
      final pat = CurrentUserProfile.fromMe({
        'user': {'id': 'u', 'email': ' pat@x.co ', 'name': ' Pat Lee '},
        'avatarUrl': ' https://a/b.png ',
      });
      expect(pat.email, 'pat@x.co');
      expect(pat.displayName, 'Pat Lee');
      expect(pat.initials, 'PL');
      expect(pat.avatarUrl, 'https://a/b.png');
      final bare = CurrentUserProfile.fromMe({
        'user': {'email': 'q@x.co', 'name': ''},
      });
      expect(bare.displayName, 'q@x.co');
      expect(bare.initials, 'Q');
      expect(const CurrentUserProfile(email: '  ').initials, '?');
    });

    test('a machine with no name is called by its id', () {
      const long = Machine(
        machineId: 'abcdef0123456789',
        authMode: MachineAuthMode.remote,
      );
      const short = Machine(machineId: 'abc', authMode: MachineAuthMode.remote);

      expect(long.displayName, 'machine-abcdef01');
      expect(short.displayName, 'machine-abc');
      expect(long.copyWith(name: 'Mac').displayName, 'Mac');
      expect(
        Machine.fromJson({'machineId': 'm', 'authMode': 'weird'}).authMode,
        MachineAuthMode.managed,
      );
    });

    test('an agent reads only what it can trust', () {
      final agent = Agent.fromJson({
        'id': 'a',
        'engine': 'codex',
        'codexHome': 'relative',
        'launch': {'state': 'failed', 'error': 'E', 'detail': 'bad\u0000thing'},
        'terminal': {
          'runtimes': [
            {'backend': 'tmux'},
          ],
        },
        'tokenUsage': {'totalTokens': -1},
        'resumeMode': 'nonsense',
      });

      expect(agent.name, 'harness');
      expect(agent.codexHome, isNull);
      expect(agent.launchDetail, 'bad thing');
      expect(agent.terminalAvailable, isTrue, reason: 'a tmux runtime');
      expect(agent.tokensUsed, isNull);
      expect(agent.resumeMode, isNull);
      expect(
        Agent.fromJson({'id': 'a', 'engine': 'bad engine!'}).engine,
        isNull,
      );
      expect(
        Agent.fromJson({
          'id': 'a',
          'launch': {'state': 'failed', 'detail': '   '},
        }).launchDetail,
        isNull,
      );
      expect(
        Agent.fromJson({
          'id': 'a',
          'launch': {'state': 'failed', 'detail': 'x' * 600},
        }).launchDetail!.length,
        500,
      );
    });

    test(
      'a name somebody chose is kept; a made-up one gives way to the title',
      () {
        const chosen = Agent(id: 'a', name: 'api work');
        const made = Agent(id: 'a', name: 'harness-3', title: 'Fix the dial');
        const untitled = Agent(id: 'a', name: 'harness-3');

        expect(chosen.displayName, 'api work');
        expect(made.displayName, 'Fix the dial');
        expect(untitled.displayName, kUntitledPane);
        expect(isAutomaticHarnessName('Claude harness 9-23 13:52'), isTrue);
      },
    );

    test('the last use is the later of activity and opening', () {
      final early = DateTime(2026, 9, 1);
      final late = DateTime(2026, 9, 2);

      expect(Agent(id: 'a', name: 'a', updatedAt: early).lastUsedAt, early);
      expect(Agent(id: 'a', name: 'a', lastOpenedAt: late).lastUsedAt, late);
      expect(
        Agent(
          id: 'a',
          name: 'a',
          updatedAt: late,
          lastOpenedAt: early,
        ).lastUsedAt,
        late,
      );
      expect(
        Agent(
          id: 'a',
          name: 'a',
          updatedAt: early,
          lastOpenedAt: late,
        ).lastUsedAt,
        late,
      );
    });

    test('a project is labelled as the person chose it', () {
      const plain = AgentProject(name: 'work', cwd: '/work');
      const sub = AgentProject(
        name: 'repo',
        cwd: '/w/repo/packages/app/',
        root: '/w/repo',
        branch: ' Detached 6528156 ',
      );
      const same = AgentProject(name: 'repo', cwd: '/w/repo/', root: '/w/repo');
      const pending = AgentProject(
        name: 'r',
        cwd: '/r',
        branch: 'main',
        branchPending: true,
      );

      expect(plain.label, 'work');
      expect(sub.label, 'app');
      expect(same.label, 'repo');
      expect(sub.detached, isTrue);
      expect(sub.shownBranch, isNull);
      expect(sub.branchDetail, 'No branch: on commit 6528156');
      expect(pending.shownBranch, isNull);
      expect(pending.branchDetail, 'Branch: main');
      expect(plain.branchDetail, isNull);
      expect(
        const AgentProject(name: 'r', cwd: '/r', branch: '  ').branchLabel,
        isNull,
      );
      expect(plain.identity('m'), 'folder:m:/work');
      expect(
        const AgentProject(name: 'r', cwd: '/r', remote: 'git@x').identity('m'),
        'repo:git@x',
      );
      expect(plain, const AgentProject(name: 'work', cwd: '/work'));
      expect(
        plain.hashCode,
        const AgentProject(name: 'work', cwd: '/work').hashCode,
      );
      expect(AgentProject.fromJson({'name': 'n', 'cwd': 'a\u0001'}), isNull);
    });

    test('grid answers: web search, sections and who may run locally', () {
      expect(GridWebSearch.on.sentence, isNull);
      expect(GridWebSearch.unsupported.sentence, contains('not supported'));
      expect(GridWebSearch.fromWire('new-word'), isNull);
      expect(GridCli.parse('path'), GridCli.path);
      expect(GridCli.parse('missing'), GridCli.missing);

      const own = GridModels(
        gridName: 'mine',
        models: [GridModel(id: 'q', node: 'mac')],
      );
      expect(own.sections.single.own, isTrue);
      expect(const GridModels(gridName: null, models: []).sections, isEmpty);
      expect(own.canRunLocally('anything'), isTrue);
      const limited = GridModels(
        gridName: 'mine',
        models: [],
        localModelEngines: {'codex'},
      );
      expect(limited.canRunLocally(' Codex '), isTrue);
      expect(limited.canRunLocally('claude'), isFalse);
      expect(limited.canRunLocally(null), isFalse);
      expect(const GridModels.unreachable().reachable, isFalse);
    });

    test('output stats keep an edit pair whole, or not at all', () {
      expect(AgentOutputStats.fromJson('x'), isNull);
      expect(AgentOutputStats.fromJson({'linesAdded': 3}), isNull);
      final stats = AgentOutputStats.fromJson({
        'linesAdded': 3,
        'linesRemoved': 1,
        'pullRequestsCreated': 2,
        'updatedAt': '2026-09-27T10:00:00Z',
      })!;
      expect(stats.hasEdits, isTrue);
      expect(
        stats,
        AgentOutputStats.fromJson({
          'linesAdded': 3,
          'linesRemoved': 1,
          'pullRequestsCreated': 2,
          'updatedAt': '2026-09-27T10:00:00Z',
        }),
      );
      expect(stats.hashCode, isA<int>());
      expect(wireCount(-1), isNull);
      expect(wireCount(1.5), isNull);
    });

    test('a project folder request says what the machine should make', () {
      expect(const ProjectFolderRequest.newProject().payload, {
        'projectSource': 'new',
      });
      expect(
        const ProjectFolderRequest.branch(
          '/w',
          'refs/heads/x',
          newBranch: 'x',
        ).payload,
        {
          'projectSource': 'branch',
          'gitSource': '/w',
          'branchRef': 'refs/heads/x',
          'branchName': 'x',
        },
      );
    });
  });

  group('what search reads', () {
    test('a conversation Harness did not start, as a person says it', () {
      const ext = ExternalSessionRef(
        sessionId: 's',
        engine: 'codex',
        cwd: '/w/app/',
        origin: 'codex-app',
      );

      expect(ext.originLabel, 'Codex app');
      expect(ext.engineLabel, 'Codex');
      expect(ext.folderName, 'app');
      expect(
        const ExternalSessionRef(
          sessionId: 's',
          engine: 'gemini',
          cwd: '/',
          origin: 'editor',
        ).engineLabel,
        'gemini',
      );
      expect(
        const ExternalSessionRef(
          sessionId: 's',
          engine: 'claude',
          cwd: '/',
          origin: 'claude-app',
        ).originLabel,
        'Claude app',
      );
      expect(
        const ExternalSessionRef(
          sessionId: 's',
          engine: 'claude',
          cwd: '/',
          origin: 'editor',
        ).originLabel,
        'editor',
      );
      expect(externalDestinationId('m', 's'), 'external:m:s');
    });

    test(
      'a hit on a conversation Harness did not start, and a long snippet',
      () {
        final hits = SessionContentHit.listFromReply('m', {
          'hits': [
            {
              'agentId': '',
              'sessionId': 's-ext',
              'engine': 'claude',
              'snippet': 'x' * 700,
              'lastAt': 1790000000000,
              'external': {'cwd': '/w/app', 'title': 'Fix', 'open': true},
            },
            {
              'agentId': '',
              'sessionId': 's-bad',
              'engine': 'claude',
              'external': {'cwd': 'relative'},
            },
          ],
        });

        final hit = hits.single;
        expect(hit.snippet.length, 600);
        expect(hit.lastAt, DateTime.fromMillisecondsSinceEpoch(1790000000000));
        expect(hit.external!.origin, 'terminal');
        expect(hit.external!.open, isTrue);
        expect(hit.destinationId, 'external:m:s-ext');
        expect(SessionContentHit.listFromReply('m', {'error': 'OLD'}), isEmpty);
      },
    );

    test('an earlier answer vouches only where a word begins', () async {
      final search = SessionContentSearch(
        machines: () => ['m'],
        debounce: Duration.zero,
        ask: (_, query, _) async => query == 'po'
            ? [
                SessionContentHit(
                  machineId: 'm',
                  agentId: 'a',
                  sessionId: 's',
                  field: 'ask',
                  snippet: 'support the port',
                  together: true,
                  score: 1,
                ),
              ]
            : null,
      );
      addTearDown(search.dispose);
      search.search('po');
      await Future<void>.delayed(const Duration(milliseconds: 20));

      search.search('port');
      expect(search.hitsFor('port'), hasLength(1));
    });

    test('a later, closer conversation of one harness wins its row', () async {
      SessionContentHit hit(int position, {bool together = false}) =>
          SessionContentHit(
            machineId: 'm',
            agentId: 'a',
            sessionId: 's$position',
            field: 'ask',
            snippet: 'dial',
            together: together,
            score: 1,
            position: position,
          );
      final search = SessionContentSearch(
        machines: () => ['m', 'n'],
        debounce: Duration.zero,
        ask: (machine, _, _) async =>
            machine == 'm' ? [hit(3), hit(1)] : [hit(5, together: true)],
      );
      addTearDown(search.dispose);

      search.search('dial');
      await Future<void>.delayed(const Duration(milliseconds: 20));

      expect(search.hits.values.single.together, isTrue);
    });

    test('"this month" runs from the first to now', () {
      final now = DateTime(2026, 9, 27, 12);

      final read = parseSearchWhen('dial this month', now);

      expect(read.words, 'dial');
      expect(read.when!.from, DateTime(2026, 9));
      expect(read.when!.to, now);
    });
  });

  group('kept between launches', () {
    test(
      'agent recency migrates the old preference and survives reopening',
      () async {
        final storage = MemoryKeyValueStore()
          ..values['new_agent_engine'] = 'claude';
        final preference = AgentPreference(storage);
        await preference.load();
        expect(preference.recent, ['claude']);
        await preference.select('codex');
        await preference.select('opencode');
        await preference.select('codex');
        final reopened = AgentPreference(storage);
        await reopened.load();
        expect(reopened.value, 'codex');
        expect(reopened.recent, ['codex', 'opencode', 'claude']);
      },
    );

    test('bad agent history keeps the saved default usable', () async {
      final storage = MemoryKeyValueStore()
        ..values['new_agent_engine'] = 'codex'
        ..values['new_agent_engine_history_v1'] = '{broken';
      final preference = AgentPreference(storage);
      await preference.load();
      expect(preference.recent, ['codex']);
      await preference.select('claude');
      expect(preference.recent, ['claude', 'codex']);
    });

    test(
      'failed persistence keeps agent recency for the current run',
      () async {
        final preference = AgentPreference(_Broken());
        await preference.select('claude');
        await preference.select('codex');
        expect(preference.value, 'codex');
        expect(preference.recent, ['codex', 'claude']);
      },
    );

    test('recent folders, per machine, newest first and valid only', () async {
      final storage = MemoryKeyValueStore()
        ..values['new_agent_projects_v1'] = jsonEncode({
          'm': {
            'selected': '/w/b',
            'recent': ['/w/b', '/w/a', 'relative', 3, '/w/a'],
          },
          'n': {'selected': 'relative', 'recent': 'nope'},
          '': 7,
        });
      final history = ProjectHistory(storage);

      await history.load();
      expect(history.recent('m'), ['/w/b', '/w/a']);
      expect(history.selected('m'), '/w/b');
      expect(history.hasSelection('n'), isFalse);

      await history.select('m', '/w/c');
      await history.select('m', 'relative');
      expect(history.recent('m'), ['/w/c', '/w/b', '/w/a']);

      final again = ProjectHistory(storage);
      await again.load();
      expect(again.recent('m'), ['/w/c', '/w/b', '/w/a']);
      await again.select('m', null);
      expect(again.selected('m'), isNull);
      expect(again.hasSelection('m'), isTrue);
    });

    test(
      'recent folders survive a store that cannot be read or written',
      () async {
        final history = ProjectHistory(_Broken());

        await history.select('m', '/w/a');

        expect(history.recent('m'), ['/w/a']);
        expect(ProjectHistory(null).recent('m'), isEmpty);
        final garbled = ProjectHistory(
          MemoryKeyValueStore()..values['new_agent_projects_v1'] = '[1]',
        );
        await garbled.load();
        expect(garbled.recent('m'), isEmpty);
      },
    );

    test('search visits, most recent first, written once they settle', () {
      fakeAsync((async) {
        final storage = MemoryKeyValueStore()
          ..values['phone_recent_agents_v1'] = jsonEncode([
            'agent:m:a',
            'not-an-agent',
            'agent:m:a',
            7,
          ])
          ..values['phone_recent_commands_v1'] = '{broken';
        final history = PhoneSearchHistory(storage);

        history.load();
        async.flushMicrotasks();
        expect(history.recent, ['agent:m:a']);
        expect(history.recentCommands, isEmpty);

        history.remember('agent:m:b');
        history.remember('agent:m:b');
        history.rememberCommand('cmd:new');
        async.elapse(const Duration(milliseconds: 300));
        expect(storage.values['phone_recent_agents_v1'], contains('agent:m:a'));
        expect(jsonDecode(storage.values['phone_recent_agents_v1']!), [
          'agent:m:a',
          'not-an-agent',
          'agent:m:a',
          7,
        ], reason: 'not yet: visits come in bursts');

        async.elapse(const Duration(milliseconds: 400));
        expect(jsonDecode(storage.values['phone_recent_agents_v1']!), [
          'agent:m:b',
          'agent:m:a',
        ]);
        expect(jsonDecode(storage.values['phone_recent_commands_v1']!), [
          'cmd:new',
        ]);

        for (var i = 0; i < 40; i++) {
          history.remember('agent:m:$i');
        }
        expect(history.recent, hasLength(32));
        history.dispose();
        async.elapse(const Duration(seconds: 1));
      });
    });

    test('search visits with nowhere to keep them, or a store that fails', () {
      fakeAsync((async) {
        final memory = PhoneSearchHistory(null)..remember('agent:m:a');
        expect(memory.recent, ['agent:m:a']);

        final broken = PhoneSearchHistory(_Broken());
        broken.load();
        broken.remember('agent:m:a');
        async.elapse(const Duration(seconds: 1));
        expect(broken.recent, ['agent:m:a']);
      });
    });
  });

  group('the state file', () {
    late Directory dir;

    setUp(() => dir = Directory.systemTemp.createTempSync('harness_store'));
    tearDown(() => dir.deleteSync(recursive: true));

    test('keys round-trip, alone and together, and deletes stick', () async {
      final store = HarnessFileStore(directory: dir);

      await store.write('a', '1');
      await store.write('b', '2');
      expect(await store.read('a'), '1');
      expect(await store.readMany(['a', 'b', 'c']), {
        'a': '1',
        'b': '2',
        'c': null,
      });
      expect(await store.readMany(const []), isEmpty);

      await store.delete('a');
      await store.delete('never-there');
      expect(await HarnessFileStore(directory: dir).read('a'), isNull);
      expect(await HarnessFileStore(directory: dir).read('b'), '2');
    });

    test('a corrupt file is moved aside and read as empty', () async {
      final store = HarnessFileStore(directory: dir);
      store.stateFile.writeAsStringSync('{not json');

      expect(await store.read('a'), isNull);

      expect(
        dir.listSync().map((f) => f.path.split('/').last),
        contains(startsWith('state.corrupt-')),
      );
    });

    test('every wrong shape is corruption', () async {
      final store = HarnessFileStore(directory: dir);
      for (final document in [
        '[]',
        '{"version": 1}',
        '{"version": 0, "values": {}}',
        '{"version": 1, "values": {"a": 3}}',
      ]) {
        store.stateFile.writeAsStringSync(document);
        expect(await store.read('a'), isNull, reason: document);
      }
      expect(
        dir.listSync().where((f) => f.path.contains('state.corrupt-')),
        hasLength(4),
      );
    });

    test(
      'a newer build\'s file is refused, and left exactly as it was',
      () async {
        final store = HarnessFileStore(directory: dir);
        const newer = '{"version": 99, "values": {"a": "1"}}';
        store.stateFile.writeAsStringSync(newer);

        await expectLater(
          store.read('a'),
          throwsA(isA<UnsupportedStateVersionException>()),
        );
        await expectLater(store.write('a', '2'), throwsA(anything));
        expect(store.stateFile.readAsStringSync(), newer);
        expect(
          const UnsupportedStateVersionException(99).toString(),
          contains('refusing to overwrite'),
        );
      },
    );

    test(
      'on a phone the document is held, and a failed write drops it',
      () async {
        final store = HarnessFileStore(directory: dir, cacheableForTest: true);
        final outside = HarnessFileStore(directory: dir);
        await store.write('a', '1');

        // Changed behind its back: the held copy answers, as it may where it is
        // the only writer.
        await outside.write('a', 'outside');
        expect(await store.read('a'), '1');
        expect(await store.readMany(['a']), {'a': '1'});

        // A write that cannot land: its rename meets a directory.
        store.stateFile.deleteSync();
        Directory('${store.stateFile.path}/blocker')
            .createSync(recursive: true);
        await expectLater(store.write('b', '2'), throwsA(anything));
        Directory(store.stateFile.path).deleteSync(recursive: true);
        await outside.write('a', 'on disk');

        // Forgotten, so the next read goes and looks.
        expect(await store.read('a'), 'on disk');
      },
    );

    test('a home is required, and the sibling is named', () {
      expect(
        HarnessFileStore.defaultDirectoryPath(
          environment: {'HOME': '/Users/pat'},
          name: 'machines',
        ),
        '/Users/pat/.harness/machines',
      );
      expect(
        () => HarnessFileStore.defaultDirectoryPath(environment: const {}),
        throwsStateError,
      );
    });
  });

  group('the phone\'s own name', () {
    const channel = MethodChannel('harness/device_name');
    TestWidgetsFlutterBinding.ensureInitialized();

    tearDown(() {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
      NativeDeviceInfo.setForTest(null);
    });

    test('is asked of the OS once, and kept', () async {
      var asked = 0;
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, (call) async {
            asked++;
            return {'name': "Pat's iPhone", 'modelCode': 'iPhone16,1'};
          });

      final first = NativeDeviceInfo.describe();
      final second = NativeDeviceInfo.describe();
      expect((await first)?.name, "Pat's iPhone");
      await second;
      await NativeDeviceInfo.describe();

      expect(asked, 1);
      expect(NativeDeviceInfo.cached?.modelCode, 'iPhone16,1');
    });

    test('a platform with no answer, or a failing one, has no name', () async {
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(
            channel,
            (call) async => throw PlatformException(code: 'nope'),
          );

      expect(await NativeDeviceInfo.describe(), isNull);

      NativeDeviceInfo.setForTest(null);
      TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(channel, null);
      expect(await NativeDeviceInfo.describe(), isNull);
      expect(DeviceInfo.fromMap('junk'), isNull);
    });
  });
}

class _Broken implements LocalKeyValueStore {
  @override
  Future<String?> read(String key) async => throw StateError('locked');

  @override
  Future<void> write(String key, String value) async =>
      throw StateError('locked');

  @override
  Future<void> delete(String key) async => throw StateError('locked');
}
