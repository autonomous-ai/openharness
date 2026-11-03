import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/local_key_value_store.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/account_keys.dart';
import 'package:harness/super_tabs/leaderboard/model.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/roster_scope.dart';

import 'super_tab_roster_test.dart' show RosterFixture;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart' show projectFixture;

/// The roster's scope menu (Dee, 2026-11-02): the whole Swarm, or only the
/// project open in the chat, for Humans and Agents alike.
class _Memory implements LocalKeyValueStore {
  final values = <String, String>{};
  final writes = <String>[];

  /// Reads wait on this while set, as a slow disk does.
  Completer<void>? hold;
  bool failWrites = false;

  @override
  Future<String?> read(String key) async {
    // The value as it was when asked, however long the disk takes to answer.
    final value = values[key];
    await hold?.future;
    return value;
  }

  @override
  Future<void> write(String key, String value) async {
    if (failWrites) throw StateError('disk full');
    writes.add(key);
    values[key] = value;
  }

  @override
  Future<void> delete(String key) async => values.remove(key);
}

void main() {
  final captureDir = Platform.environment['HARNESS_ROSTER_CAPTURE_DIR'];
  setUpAll(() => loadCaptureFonts(captureDir));

  Finder person(String id) => find.byKey(ValueKey('super-person-$id'));
  Finder agent(int i) => find.byKey(ValueKey('super-member-agent-$i'));
  final scope = find.byKey(const ValueKey('roster-scope'));

  Map<String, dynamic> score(String id, int points, int rank) => {
    'personId': id,
    'points': points,
    'rank': rank,
    'medal': null,
    'shipped': {'count': 0, 'medianAskToShipMs': null},
    'unblocked': {'count': 0, 'agentMs': 0, 'medianAnswerMs': null},
    'lent': {'machines': 0, 'agentMs': 0},
    'streakDays': 0,
  };

  /// A Swarm of three people and two projects; only Ken and Dee can read
  /// openharness, Tony only autonomous-os (the board names the readers).
  Future<RosterFixture> swarm(
    WidgetTester tester, {
    _Memory? store,
    bool open = true,
    bool board = true,
  }) async {
    await tester.binding.setSurfaceSize(const Size(280, 760));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final f = RosterFixture();
    f.storage = store;
    await f.initialize();
    addTearDown(f.dispose);
    (f.server.state['people'] as List).addAll([
      {'id': 'dee', 'email': 'dee@example.com', 'role': 'collaborator'},
      {'id': 'tony', 'email': 'tony@example.com', 'role': 'collaborator'},
    ]);
    if (board) {
      f.server.leaderboard = {
        'projectId': 'lead',
        'week': DateTime.utc(2026, 10, 26).millisecondsSinceEpoch,
        'people': [score('owner', 30, 1), score('dee', 12, 2)],
        'waiting': {'total': 0, 'people': <Object>[]},
      };
    }
    await f.controller.refresh();
    if (open) await f.controller.select('lead');
    return f;
  }

  Future<void> choose(WidgetTester tester, String label) async {
    await tester.tap(scope);
    await tester.pumpAndSettle();
    await tester.tap(find.text(label).last);
    await tester.pumpAndSettle();
  }

  void expectWholeSwarm() {
    for (final id in ['owner', 'dee', 'tony']) {
      expect(person(id), findsOneWidget, reason: id);
    }
    for (var i = 0; i < 4; i++) {
      expect(agent(i), findsOneWidget, reason: 'agent-$i');
    }
  }

  testWidgets('starts on All projects: everyone and every agent, as before', (
    tester,
  ) async {
    final store = _Memory();
    final f = await swarm(tester, store: store);
    await f.show(tester);
    expectWholeSwarm();
    expect(
      find.descendant(of: scope, matching: find.text('All projects')),
      findsOneWidget,
    );
    expect(store.writes, isEmpty, reason: 'reading the default writes nothing');
    await f.close(tester);
  });

  testWidgets("the project's people and agents only, with its own points", (
    tester,
  ) async {
    final f = await swarm(tester);
    await f.show(tester);
    await choose(tester, 'This project');
    // The board of openharness names Ken and Dee; Tony cannot read it.
    expect(person('owner'), findsOneWidget);
    expect(person('dee'), findsOneWidget);
    expect(person('tony'), findsNothing);
    expect(
      find.descendant(of: person('dee'), matching: find.textContaining('12')),
      findsWidgets,
    );
    // Its agents: the PM and two others; the other project's PM is not listed.
    expect(agent(0), findsOneWidget);
    expect(agent(1), findsOneWidget);
    expect(agent(3), findsOneWidget);
    expect(agent(2), findsNothing);
    // And back to everyone.
    await choose(tester, 'All projects');
    expectWholeSwarm();
    await f.close(tester);
  });

  testWidgets('another project open lists only its own agents, never the first '
      "project's board", (tester) async {
    final f = await swarm(tester);
    await f.show(tester);
    await choose(tester, 'This project');
    await f.controller.select('os-lead');
    await tester.pumpAndSettle();
    // The scope follows the project now open: autonomous-os.
    expect(agent(2), findsOneWidget);
    expect(agent(0), findsNothing);
    expect(agent(1), findsNothing);
    expect(agent(3), findsNothing);
    // openharness's board never lends its Ken/Dee numbers or its member list
    // to this project (the board read is for the project open now).
    expect(
      f.server.leaderboardReads.last,
      contains('projectId=os'),
      reason: 'the board is re-read for the project now open',
    );
    await f.close(tester);
  });

  testWidgets(
    'remembered per account and Swarm, and restored after a restart',
    (tester) async {
      final store = _Memory();
      final f = await swarm(tester, store: store);
      await f.show(tester);
      await choose(tester, 'This project');
      final key = SuperTabRosterScopeChoice.keyFor('owner', f.controller.tabId);
      expect(store.values[key], 'project');
      // The web sweeps it with the account's other keys at sign-out.
      expect(swarmKeyAccount(key), 'owner');
      await f.close(tester);

      final again = await swarm(tester, store: store);
      await again.show(tester);
      expect(person('tony'), findsNothing);
      expect(agent(2), findsNothing);
      expect(
        find.descendant(of: scope, matching: find.text('This project')),
        findsOneWidget,
      );
      await again.close(tester);

      // Another Swarm of the same account keeps its own choice.
      expect(
        SuperTabRosterScopeChoice.keyFor('owner', 'other-tab'),
        isNot(key),
      );
    },
  );

  testWidgets('a choice made while the saved one is still loading wins', (
    tester,
  ) async {
    final store = _Memory();
    store.values[SuperTabRosterScopeChoice.keyFor('owner', 'tab')] = 'project';
    store.hold = Completer<void>();
    final f = await swarm(tester, store: store);
    await f.show(tester);
    expect(f.controller.tabId, 'tab');
    // All projects is picked (the project is not saved yet), then the disk answers.
    await choose(tester, 'This project');
    await choose(tester, 'All projects');
    store.hold!.complete();
    await tester.pumpAndSettle();
    expectWholeSwarm();
    expect(
      store.values[SuperTabRosterScopeChoice.keyFor('owner', 'tab')],
      'all',
    );
    await f.close(tester);
  });

  testWidgets('a project you cannot read any more falls back to All projects', (
    tester,
  ) async {
    final store = _Memory();
    final f = await swarm(tester, store: store);
    await f.show(tester);
    await choose(tester, 'This project');
    expect(person('tony'), findsNothing);
    // The Swarm stops sending the project and its chat (access revoked).
    (f.server.state['projects'] as List).removeWhere((p) => p['id'] == 'lead');
    (f.server.state['conversations'] as List).removeWhere(
      (g) => g['projectId'] == 'lead' || g['id'] == 'lead',
    );
    await f.controller.refresh();
    await tester.pumpAndSettle();
    for (final id in ['owner', 'dee', 'tony']) {
      expect(person(id), findsOneWidget, reason: id);
    }
    expect(
      find.text('openharness'),
      findsNothing,
      reason: 'no name left behind',
    );
    expect(scope, findsOneWidget);
    // The choice went back to All projects for good: it does not carry over to
    // the project the chat moved to, nor come back on its own.
    expect(agent(0), findsOneWidget);
    expect(agent(1), findsOneWidget);
    expect(agent(2), findsOneWidget);
    expect(agent(3), findsOneWidget);
    expect(
      store.values[SuperTabRosterScopeChoice.keyFor('owner', 'tab')],
      'all',
    );
    await f.close(tester);
  });

  testWidgets('no project open: the whole Swarm, and no scope menu', (
    tester,
  ) async {
    final f = await swarm(tester, open: false);
    f.controller.selectedId = 'missing';
    await f.show(tester);
    expect(scope, findsNothing);
    expectWholeSwarm();
    await f.close(tester);
  });

  testWidgets(
    'a failed board read does not strand the list: a public project keeps its people',
    (tester) async {
      final f = await swarm(tester, board: false);
      f.server.failLeaderboardReads = 1;
      await f.show(tester);
      await choose(tester, 'This project');
      expect(person('owner'), findsOneWidget);
      expect(person('dee'), findsOneWidget);
      expect(person('tony'), findsOneWidget, reason: 'public: everyone');
      expect(agent(2), findsNothing);
      await f.close(tester);
    },
  );

  testWidgets(
    'a failed board read on a private project lists only its owner and invited members',
    (tester) async {
      final f = await swarm(tester, board: false);
      final project = (f.server.state['projects'] as List).firstWhere(
        (p) => p['id'] == 'lead',
      );
      project['visibility'] = 'private';
      project['members'] = [
        {'id': 'dee'},
      ];
      await f.controller.refresh();
      await f.show(tester);
      await choose(tester, 'This project');
      expect(person('owner'), findsOneWidget);
      expect(person('dee'), findsOneWidget);
      expect(person('tony'), findsNothing);
      await f.close(tester);
    },
  );

  testWidgets(
    'a store that cannot write still lets the choice stand for this visit',
    (tester) async {
      final store = _Memory()..failWrites = true;
      final f = await swarm(tester, store: store);
      await f.show(tester);
      await choose(tester, 'This project');
      expect(person('tony'), findsNothing);
      expect(tester.takeException(), isNull);
      await f.close(tester);
    },
  );

  group('with the rolling periods', () {
    /// A server that answers by period: All projects sums to 90 for the owner,
    /// the open project to 30, and tony is listed only in the whole-Swarm sum.
    void rolling(RosterFixture f) => f.server.leaderboardAnswer = (path) {
      final all = path.contains('scope=all');
      final name = RegExp(r'period=(\w+)').firstMatch(path)?.group(1) ?? '7d';
      return {
        'projectId': 'lead',
        'week': DateTime.utc(2026, 10, 26).millisecondsSinceEpoch,
        'period': {'name': name, 'start': 1, 'end': 2},
        if (all) 'allProjects': true,
        'people': [
          score('owner', all ? 90 : 30, 1),
          if (all) score('tony', 40, 2),
          score('dee', 12, all ? 3 : 2),
        ],
        'waiting': {'total': 0, 'people': <Object>[]},
      };
    };

    Finder points(String id, String value) =>
        find.descendant(of: person(id), matching: find.textContaining(value));

    testWidgets('All projects shows Swarm-wide points for the last 7 days; '
        'a project its own', (tester) async {
      final f = await swarm(tester);
      rolling(f);
      await f.show(tester);
      expect(f.server.leaderboardReads.last, endsWith('&period=7d&scope=all'));
      expect(points('owner', '90'), findsWidgets);
      expect(points('tony', '40'), findsWidgets);
      // One period, the last 7 days, said on hover (Quiet Swarm).
      expect(find.byKey(const ValueKey('leaderboard-week')), findsNothing);
      expect(find.byKey(const ValueKey('leaderboard-period')), findsNothing);
      expect(find.byTooltip('Points in the last 7 days'), findsWidgets);

      await choose(tester, 'This project');
      expect(f.server.leaderboardReads.last, endsWith('&period=7d'));
      expect(points('owner', '30'), findsWidgets);
      expect(points('owner', '90'), findsNothing);
      expect(person('tony'), findsNothing);

      await choose(tester, 'All projects');
      expect(f.server.leaderboardReads.last, endsWith('&period=7d&scope=all'));
      expect(points('owner', '90'), findsWidgets);
      expect(person('tony'), findsOneWidget);
      await f.close(tester);
    });

    testWidgets('never lends whole-Swarm numbers or names to a project while '
        'its own read is out', (tester) async {
      final f = await swarm(tester);
      rolling(f);
      await f.show(tester);
      final gate = Completer<void>();
      f.server.leaderboardGate = gate.future;
      await tester.tap(scope);
      await tester.pumpAndSettle();
      await tester.tap(find.text('This project').last);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 300));
      expect(points('owner', '90'), findsNothing);
      gate.complete();
      await tester.pumpAndSettle();
      expect(points('owner', '30'), findsWidgets);
      await f.close(tester);
    });

    testWidgets('a project lost while narrowed goes back to All projects and '
        'reads it', (tester) async {
      final f = await swarm(tester);
      rolling(f);
      await f.show(tester);
      await choose(tester, 'This project');
      expect(f.server.leaderboardReads.last, isNot(contains('scope=all')));
      f.server.state['projects'] = (f.server.state['projects'] as List)
          .where((p) => (p as Map)['id'] != 'lead')
          .toList();
      await f.controller.refresh();
      await tester.pumpAndSettle();
      expect(points('owner', '30'), findsNothing);
      await f.close(tester);
    });

    testWidgets('light and dark, the scope menu and Swarm-wide points', (
      tester,
    ) async {
      final f = await swarm(tester);
      rolling(f);
      final saved = grid.AppTheme.brightness.value;
      addTearDown(() => grid.AppTheme.brightness.value = saved);
      for (final brightness in Brightness.values) {
        grid.AppTheme.brightness.value = brightness;
        await f.show(tester, brightness: brightness);
        FocusManager.instance.primaryFocus?.unfocus();
        await tester.pumpAndSettle();
        expect(tester.takeException(), isNull);
        expect(points('owner', '90'), findsWidgets);
        if (captureDir != null) {
          await captureBoundary(
            tester,
            f.boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary,
            captureDir,
            'roster-period-${brightness.name}',
          );
        }
      }
      await f.close(tester);
    });

    testWidgets('from a server before periods: this week, its own project '
        'as before', (tester) async {
      final f = await swarm(tester);
      await f.show(tester);
      expect(find.byKey(const ValueKey('leaderboard-week')), findsNothing);
      expect(find.byTooltip('Points this week'), findsWidgets);
      expect(find.byKey(const ValueKey('leaderboard-period')), findsNothing);
      expect(points('owner', '30'), findsWidgets);
      await f.close(tester);
    });
  });

  group(
    'This project: the active people, the rest under Others (Dee, 11-03)',
    () {
      final others = find.byKey(const ValueKey('super-members-others'));

      /// openharness's board names all three; Tony did nothing there yet.
      Future<RosterFixture> withIdlePerson(WidgetTester tester) async {
        final f = await swarm(tester);
        f.server.leaderboard = {
          ...f.server.leaderboard!,
          'people': [
            score('owner', 30, 1),
            score('dee', 12, 2),
            score('tony', 0, 3),
          ],
        };
        await f.controller.refresh();
        return f;
      }

      testWidgets(
        'lists the active people busiest first, the rest folded under '
        'Others',
        (tester) async {
          final f = await withIdlePerson(tester);
          await f.show(tester);
          await choose(tester, 'This project');
          expect(person('owner'), findsOneWidget);
          expect(person('dee'), findsOneWidget);
          expect(
            tester.getTopLeft(person('owner')).dy,
            lessThan(tester.getTopLeft(person('dee')).dy),
            reason: 'busiest first',
          );
          // Tony can read the project but did nothing in it: folded at first.
          expect(person('tony'), findsNothing);
          expect(
            find.descendant(of: others, matching: find.text('Others (1)')),
            findsOneWidget,
          );
          expect(
            tester.getTopLeft(others).dy,
            lessThan(tester.getTopLeft(find.text('Agents')).dy),
            reason: 'Others closes People, above Agents',
          );
          await tester.tap(others);
          await tester.pumpAndSettle();
          expect(person('tony'), findsOneWidget);
          expect(
            tester.getTopLeft(person('tony')).dy,
            greaterThan(tester.getTopLeft(others).dy),
          );
          await tester.tap(others);
          await tester.pumpAndSettle();
          expect(person('tony'), findsNothing);
          await f.close(tester);
        },
      );

      testWidgets('All projects folds nobody', (tester) async {
        final f = await withIdlePerson(tester);
        await f.show(tester);
        expectWholeSwarm();
        expect(others, findsNothing);
        await f.close(tester);
      });

      testWidgets(
        'while the board is not in, everyone who can read it is listed',
        (tester) async {
          final f = await swarm(tester, board: false);
          await f.show(tester);
          await choose(tester, 'This project');
          for (final id in ['owner', 'dee', 'tony']) {
            expect(person(id), findsOneWidget, reason: id);
          }
          expect(others, findsNothing);
          await f.close(tester);
        },
      );

      testWidgets(
        'a private project lists only its members, the idle ones under '
        'Others',
        (tester) async {
          final f = await swarm(tester, open: false);
          f.server.state['projects'] = [
            {
              ...projectFixture(
                'lead',
                'openharness',
                'lead',
                visibility: 'private',
              ),
              'members': [
                {'id': 'dee'},
              ],
            },
            projectFixture('os', 'autonomous-os', 'os-lead'),
          ];
          // The board names who can read it: the owner and Dee, never Tony.
          f.server.leaderboard = {
            ...f.server.leaderboard!,
            'people': [score('owner', 30, 1), score('dee', 0, 2)],
          };
          await f.controller.refresh();
          await f.controller.select('lead');
          await f.show(tester);
          await choose(tester, 'This project');
          expect(person('owner'), findsOneWidget);
          expect(person('dee'), findsNothing);
          expect(
            find.descendant(of: others, matching: find.text('Others (1)')),
            findsOneWidget,
          );
          await tester.tap(others);
          await tester.pumpAndSettle();
          expect(person('dee'), findsOneWidget);
          expect(
            person('tony'),
            findsNothing,
            reason: 'not a member: not even under Others',
          );
          await f.close(tester);
        },
      );

      test(
        'splitProjectPeople keeps the order and splits on points above 0',
        () {
          SuperTabPerson p(String id) =>
              SuperTabPerson.fromJson({'id': id, 'email': '$id@example.com'});
          final people = [p('a'), p('b'), p('c'), p('d')];
          final scores = {
            for (final (id, points) in [('a', 9), ('b', 0), ('c', 3)])
              id: SuperTabPersonScore.fromJson(score(id, points, 1)),
          };
          final split = splitProjectPeople(people, scores);
          expect(split.active.map((x) => x.id), ['a', 'c']);
          expect(split.others.map((x) => x.id), ['b', 'd']);
        },
      );

      testWidgets('light and dark, Others folded and open', (tester) async {
        final f = await withIdlePerson(tester);
        final saved = grid.AppTheme.brightness.value;
        addTearDown(() => grid.AppTheme.brightness.value = saved);
        for (final brightness in Brightness.values) {
          grid.AppTheme.brightness.value = brightness;
          await f.show(tester, brightness: brightness);
          await choose(tester, 'This project');
          for (final open in [false, true]) {
            FocusManager.instance.primaryFocus?.unfocus();
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
            if (captureDir != null) {
              await captureBoundary(
                tester,
                f.boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary,
                captureDir,
                'roster-others-${open ? 'open' : 'folded'}-${brightness.name}',
              );
            }
            if (!open) {
              await tester.tap(others);
              await tester.pumpAndSettle();
            }
          }
          await tester.tap(others);
          await tester.pumpAndSettle();
          await choose(tester, 'All projects');
        }
        await f.close(tester);
      });
    },
  );

  test("another project's board never decides who is in this one", () {
    final project = SuperTabProject.fromJson({
      ...projectFixture(
        'os',
        'autonomous-os',
        'os-lead',
        visibility: 'private',
      ),
      'members': [
        {'id': 'tony'},
      ],
    });
    final other = SuperTabLeaderboard.fromJson({
      'projectId': 'lead',
      'people': [score('dee', 1, 1)],
    });
    expect(personInProject(project, 'dee', board: other), isFalse);
    expect(personInProject(project, 'tony', board: other), isTrue);
    expect(personInProject(project, 'owner', board: other), isTrue);
  });

  testWidgets('light and dark, with the scope menu', (tester) async {
    final f = await swarm(tester);
    final saved = grid.AppTheme.brightness.value;
    addTearDown(() => grid.AppTheme.brightness.value = saved);
    for (final brightness in Brightness.values) {
      grid.AppTheme.brightness.value = brightness;
      await f.show(tester, brightness: brightness);
      await choose(tester, 'This project');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      if (captureDir != null) {
        await captureBoundary(
          tester,
          f.boundary.currentContext!.findRenderObject()!
              as RenderRepaintBoundary,
          captureDir,
          'roster-scope-${brightness.name}',
        );
      }
      await choose(tester, 'All projects');
    }
    await f.close(tester);
  });
}
