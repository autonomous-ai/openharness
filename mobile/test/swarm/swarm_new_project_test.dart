import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_new_project_sheet.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';
import 'swarm_new_project_fixture.dart';

void main() {
  group('swarmLeadMachines', () {
    List<SwarmLeadMachine> machines(
      List<Map<String, dynamic>> pools, {
      bool paused = false,
      Map<String, String> modelList = const {},
    }) => swarmLeadMachines(
      leadSnapshot(
        pools,
        paused: paused,
        people: [person('person-ken', role: 'collaborator')],
      ),
      me,
      now: newProjectNow,
      modelList: modelList,
    );

    test('lists the person\'s own machine that can start a Product Manager '
        'with the first engine it runs, by its name without .local', () {
      final [studio] = machines([leadPool('mac-1', name: 'Studio.local')]);
      expect(studio.name, 'Studio');
      expect(studio.startable, isTrue);
      expect(studio.engine, 'claude');
      expect(studio.detail, 'Claude Code · 2 agents free');
    });

    test('a machine of theirs whose Harness cannot start a Product Manager '
        'says to update it, as the start would refuse it', () {
      final [old] = machines([leadPool('mac-1', capable: false)]);
      expect(old.startable, isFalse);
      expect(
        old.detail,
        'Update Harness on mac-1 to run a Product Manager there.',
      );
    });

    test('an engine not offered, not installed, signed out, out of quota or '
        'suspended is ruled out with why; one left runs', () {
      final [codexOnly] = machines([
        leadPool(
          'mac-1',
          readiness: [
            {'engine': 'claude', 'installed': true, 'signedIn': false},
          ],
        ),
      ]);
      expect(codexOnly.engine, 'codex');
      expect(codexOnly.engineRefusals, {
        'claude': 'Claude Code isn’t signed in',
      });

      final [none] = machines([
        leadPool(
          'mac-1',
          engines: ['claude'],
          quotas: [
            {
              'engine': 'claude',
              'known': true,
              'windows': [
                {'usedPercent': 100},
              ],
            },
          ],
        ),
      ]);
      expect(none.startable, isFalse);
      expect(
        none.detail,
        'Can’t run a Product Manager: Claude Code has no quota left until it '
        'resets, Codex isn’t offered here',
      );

      final [suspended] = machines([
        leadPool(
          'mac-1',
          engines: ['claude'],
          suspended: {'claude': 'Claude Code failed to start twice'},
        ),
      ]);
      expect(suspended.startable, isFalse);
      expect(suspended.engineRefusals['claude'], contains('failed to start'));
    });

    test('the Swarm\'s model list rules an engine out on every machine', () {
      final [studio] = machines(
        [leadPool('mac-1')],
        modelList: swarmLeadModelListRefusals({
          'models': [
            {'engine': 'claude', 'model': 'opus', 'enabled': false},
            {'engine': 'codex', 'model': 'gpt-5', 'enabled': true},
          ],
        }),
      );
      expect(studio.engine, 'codex');
      expect(
        studio.engineRefusals['claude'],
        'The Swarm’s model list has no enabled Claude model',
      );
      expect(swarmLeadModelListRefusals(null), isEmpty);
    });

    test('a teammate\'s machine runs it as the server decided for each '
        'engine, and says the server\'s reason when it cannot', () {
      final [team, refused] = machines([
        leadPool(
          'mac-ken',
          name: 'Ken Mac',
          contributor: 'person-ken',
          lead: {
            'claude': {'refused': 'Claude Code isn’t signed in on Ken Mac.'},
            'codex': {'machineId': 'team-ken'},
          },
        ),
        leadPool(
          'mac-dee',
          name: 'Dee Mac',
          contributor: 'person-ken',
          lead: {
            'claude': {'refused': 'Paused in this Swarm.'},
            'codex': {'refused': 'Paused in this Swarm.'},
          },
        ),
      ]);
      expect(team.name, 'Ken Mac');
      expect(team.engine, 'codex');
      expect(team.inTeam('codex'), isTrue);
      expect(team.own, isFalse);
      expect(refused.startable, isFalse);
      expect(
        refused.detail,
        'Can’t run a Product Manager: Paused in this Swarm',
      );
    });

    test('a paused Swarm, an offline machine and a full one cannot take it; '
        'the ones that can come first', () {
      final listed = machines([
        leadPool('full', slots: 0),
        leadPool('off', ago: const Duration(minutes: 2)),
        leadPool('ok', name: 'Zed'),
        leadPool('laptop', name: 'Air', deviceType: 'MacBook Air'),
      ]);
      expect([for (final m in listed) m.id], ['ok', 'laptop', 'full', 'off']);
      expect(listed[1].detail, 'Claude Code · 2 agents free · May sleep');
      expect(listed[2].detail, 'Claude Code · No agents free');
      expect(listed[3].detail, 'Offline');

      final [paused] = machines([leadPool('mac-1')], paused: true);
      expect(paused.unavailable, swarmLeadSwarmPaused);
      expect(
        swarmLeadMachineRefusal([paused], 'mac-1'),
        'mac-1: New work is paused in this Swarm. Choose another machine.',
      );
      expect(
        swarmLeadMachineRefusal([paused], 'elsewhere'),
        'Choose one of this Swarm’s machines.',
      );
    });
  });

  group('repositories', () {
    test('a link is taken as the server takes it', () {
      for (final ok in [
        'https://github.com/owner/name',
        'http://git.example.com/a/b.git',
        'ssh://git@github.com/owner/name.git',
        'git@github.com:owner/name.git',
        'git://example.com/a',
      ]) {
        expect(swarmRepositoryUrlValid(ok), isTrue, reason: ok);
      }
      for (final no in [
        '',
        'owner/name',
        'https://user:secret@github.com/a/b',
        'https://user@github.com/a/b',
        'ssh://root@github.com/a/b',
        'ftp://example.com/a',
        'https://github.com/a b',
        'file:///tmp/repo',
        'https://${'a' * 4100}.com/x',
      ]) {
        expect(swarmRepositoryUrlValid(no), isFalse, reason: no);
      }
      expect(
        swarmRepositoryLink('  github.com/Owner/Name  '),
        'https://github.com/Owner/Name',
      );
      expect(swarmRepositoryLink('not a link'), isNull);
    });

    test('a repository is named and keyed however its address is spelled', () {
      expect(
        swarmRepositoryName('git@github.com:a/openharness.git'),
        'openharness',
      );
      expect(
        swarmRepositoryKey('https://github.com/A/B.git/'),
        'github.com/a/b',
      );
      expect(swarmRepositoryName('https://github.com/'), 'github.com');
    });

    test('the Swarm\'s repositories come once each, the most recently active '
        'project\'s first', () async {
      final fake = FakeSwarm();
      NewProjectSwarm(
          projects: [
            swarmProject(project, 'Mobile', repo: harnessRepo),
            swarmProject('project-2', 'Lamp', repo: lampRepo),
            swarmProject('project-3', 'Copy', repo: '$harnessRepo.git'),
            swarmProject('project-4', 'None'),
            swarmProject('project-5', 'Bad', repo: 'https://me:pw@x.com/a'),
          ],
        )
        ..activity['project-2'] = 2000
        ..activity['project-5'] = 3000
        ..install(fake);
      final reader = SwarmReader(
        tabId: tab,
        accountId: me,
        request: fake.request,
      );
      addTearDown(reader.dispose);
      await reader.refresh();
      // Lamp's chat moved last; Bad's link is not one the server takes.
      expect(swarmProjectRepositories(reader), [lampRepo, harnessRepo]);
    });
  });

  group('SwarmNewProjectSteps', () {
    late FakeSwarm fake;
    late NewProjectSwarm swarm;
    late SwarmReader reader;

    setUp(() async {
      fake = FakeSwarm();
      swarm = NewProjectSwarm()..install(fake);
      reader = SwarmReader(tabId: tab, accountId: me, request: fake.request);
      await reader.refresh();
    });
    tearDown(() => reader.dispose());

    Future<String> run(
      SwarmNewProjectSteps steps, {
      String brief = 'Ship the phone flow',
      String machineId = 'mac-1',
      String repositoryUrl = harnessRepo,
      bool Function()? live,
    }) => steps.run(
      brief: brief,
      visibility: 'private',
      machineId: machineId,
      repositoryUrl: repositoryUrl,
      live: live ?? () => true,
      machinesOf: (snapshot) =>
          swarmLeadMachines(snapshot, me, now: newProjectNow),
    );

    test('creates the project, posts its brief, starts its Product Manager '
        'on the machine picked, then names it after its repository', () async {
      final steps = SwarmNewProjectSteps(reader);
      final made = await run(steps);

      expect(
        [for (final b in swarm.sent) (b['command'] as Map)['type']],
        ['project.create', 'message.send', 'lead.start', 'project.rename'],
      );
      final create = swarm.commands('project.create').single;
      expect(create['command'], {
        'type': 'project.create',
        'name': 'New project',
        'visibility': 'private',
        'brief': 'Ship the phone flow',
      });
      expect(made, 'p-${create['operationId']}');
      expect(swarm.commands('message.send').single['command'], {
        'type': 'message.send',
        'conversationId': 'project-$made',
        'text': 'Ship the phone flow',
        'replyTo': null,
        'recipientIds': <String>[],
      });
      expect(swarm.commands('lead.start').single['command'], {
        'type': 'lead.start',
        'projectId': made,
        'machineId': 'mac-1',
        'engine': 'claude',
        'repositoryUrl': harnessRepo,
      });
      final rename = swarm.commands('project.rename').single;
      expect(rename['command'], {
        'type': 'project.rename',
        'projectId': made,
        'name': 'openharness',
      });
      expect(rename['operationId'], '${create['operationId']}-name');
      expect(reader.snapshot!.projectById(made)?.name, 'openharness');
      final ids = [for (final b in swarm.sent) b['operationId']];
      expect(ids.toSet(), hasLength(4), reason: 'one operation per step');
    });

    test('no brief posts nothing in its chat', () async {
      await run(SwarmNewProjectSteps(reader), brief: '   ');
      expect(swarm.commands('message.send'), isEmpty);
      expect(
        (swarm.commands('project.create').single['command'] as Map)['brief'],
        '',
      );
    });

    test('a brief at the limit round-trips whole; a longer one is cut at a '
        'rune, never inside one, and fits what the server takes', () async {
      const smile = '😀';
      final atLimit = smile * swarmNewProjectBriefRunes;
      await run(SwarmNewProjectSteps(reader), brief: atLimit);
      final brief =
          (swarm.commands('project.create').single['command'] as Map)['brief']
              as String;
      expect(brief, atLimit);
      expect(brief.length, lessThanOrEqualTo(8000), reason: 'server max');
      expect(
        (swarm.commands('message.send').single['command'] as Map)['text'],
        atLimit,
      );

      swarm.sent.clear();
      await run(SwarmNewProjectSteps(reader), brief: '${atLimit}x$smile');
      final cut =
          (swarm.commands('project.create').single['command'] as Map)['brief']
              as String;
      expect(cut, atLimit);
      expect(cut.runes.length, swarmNewProjectBriefRunes);
    });

    test('a create whose answer was lost is sent again under the same '
        'operation, so the Swarm makes one project', () async {
      var lose = true;
      swarm.answer = (command) {
        if (command['type'] == 'project.create' && lose) {
          lose = false;
          throw const SuperTabFailure('NETWORK', 'The Swarm didn’t answer.');
        }
        return null;
      };
      final steps = SwarmNewProjectSteps(reader);
      await expectLater(run(steps), throwsA(isA<SuperTabFailure>()));
      expect(steps.sent, isTrue, reason: 'its fields stay as sent');
      expect(steps.projectId, isNull);
      await run(steps);

      final creates = swarm.commands('project.create');
      expect(creates, hasLength(2));
      expect(creates[0]['operationId'], creates[1]['operationId']);
      expect(creates[0]['command'], creates[1]['command']);
      expect(
        swarm.projects.where((p) => p['name'] == 'openharness'),
        hasLength(1),
      );
    });

    test(
      'a refused start keeps the project; Create again starts it on '
      'another machine as a new request and makes no second project',
      () async {
        swarm.machines = [
          leadPool('mac-1', name: 'Studio'),
          leadPool('mac-2', name: 'Mini'),
        ];
        await reader.refresh();
        var refuse = true;
        swarm.answer = (command) {
          if (command['type'] == 'lead.start' && refuse) {
            refuse = false;
            throw const SuperTabFailure(
              'HOST_OUTDATED',
              'Update Harness on Studio to run a Product Manager there.',
              statusCode: 409,
            );
          }
          return null;
        };
        final steps = SwarmNewProjectSteps(reader);
        await expectLater(
          run(steps),
          throwsA(
            isA<SuperTabFailure>().having(
              (f) => f.code,
              'code',
              'HOST_OUTDATED',
            ),
          ),
        );
        expect(steps.projectId, isNotNull);
        expect(steps.starting, isFalse, reason: 'a refusal drops the start');
        expect(
          reader.snapshot!.projectById(steps.projectId!),
          isNotNull,
          reason: 'the project stays, in the list',
        );

        await run(steps, machineId: 'mac-2');
        expect(swarm.commands('project.create'), hasLength(1));
        expect(swarm.commands('message.send'), hasLength(1));
        final starts = swarm.commands('lead.start');
        expect(starts, hasLength(2));
        expect(
          starts[0]['operationId'],
          isNot(starts[1]['operationId']),
          reason: 'a new request',
        );
        expect((starts[1]['command'] as Map)['machineId'], 'mac-2');
      },
    );

    test('a start whose answer was lost is repeated as it was sent, on its '
        'machine, under its operation', () async {
      var lose = true;
      swarm.answer = (command) {
        if (command['type'] == 'lead.start' && lose) {
          lose = false;
          throw const SuperTabFailure(
            'SERVER_ERROR',
            'Try again.',
            statusCode: 502,
          );
        }
        return null;
      };
      final steps = SwarmNewProjectSteps(reader);
      await expectLater(run(steps), throwsA(isA<SuperTabFailure>()));
      expect(steps.starting, isTrue);
      expect(steps.startMachine, 'mac-1');

      await run(steps, machineId: 'elsewhere');
      final starts = swarm.commands('lead.start');
      expect(starts, hasLength(2));
      expect(starts[0]['operationId'], starts[1]['operationId']);
      expect((starts[1]['command'] as Map)['machineId'], 'mac-1');
    });

    test('a machine that can no longer take it on a fresh read is refused '
        'with why, and no start is sent', () async {
      final steps = SwarmNewProjectSteps(reader);
      swarm.machines = [leadPool('mac-1', name: 'Studio', slots: 0)];
      await expectLater(
        run(steps),
        throwsA(
          isA<SuperTabFailure>().having(
            (f) => f.message,
            'message',
            'Studio has no free agents. Choose another machine.',
          ),
        ),
      );
      expect(swarm.commands('lead.start'), isEmpty);
      expect(swarm.commands('project.create'), hasLength(1));
    });

    test('a fresh read that fails sends no start and says so; once the Swarm '
        'answers again, Create again starts it', () async {
      final steps = SwarmNewProjectSteps(reader);
      final changes = fake.routes['/api/super-tabs/$tab/changes']!;
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          throw const SuperTabFailure('NETWORK', 'Offline.');
      await expectLater(
        run(steps),
        throwsA(
          isA<SuperTabFailure>().having(
            (f) => f.code,
            'code',
            'SWARM_UNREADABLE',
          ),
        ),
      );
      expect(swarm.commands('lead.start'), isEmpty);

      fake.routes['/api/super-tabs/$tab/changes'] = changes;
      await run(steps);
      expect(swarm.commands('lead.start'), hasLength(1));
      expect(swarm.commands('project.create'), hasLength(1));
    });

    test(
      'once the sheet goes, an answer that arrives sends nothing more',
      () async {
        var live = true;
        final held = Completer<Object?>();
        swarm.answer = (command) =>
            command['type'] == 'project.create' ? held.future : null;
        final steps = SwarmNewProjectSteps(reader);
        final running = run(steps, live: () => live);
        await settle();
        live = false;
        held.complete(null);
        await expectLater(running, throwsA(isA<SwarmNewProjectGone>()));
        expect(
          [for (final b in swarm.sent) (b['command'] as Map)['type']],
          ['project.create'],
        );
      },
    );
  });

  group('Swarm Home', () {
    /// Swarm Home over [swarms], on an iPhone's screen, as the person [me].
    Future<SwarmHost> pump(
      WidgetTester tester,
      List<NewProjectSwarm> swarms, {
      ValueNotifier<String?>? account,
    }) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final signedIn = account ?? ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => signedIn.value,
        account: signedIn,
        request: newProjectBackend(swarms).request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      addTearDown(host.dispose);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          onGenerateRoute: (_) => CupertinoPageRoute<void>(
            builder: (_) => SwarmPage(now: () => newProjectNow),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return host;
    }

    Finder key(String value) => find.byKey(ValueKey(value));

    Future<void> tap(WidgetTester tester, String k) async {
      await tester.ensureVisible(key(k));
      await tester.pumpAndSettle();
      await tester.tap(key(k));
      await tester.pumpAndSettle();
    }

    Future<void> pickMachine(WidgetTester tester, String id) async {
      await tap(tester, 'swarm-new-project-machine');
      await tap(tester, 'swarm-new-project-pick-machine-$id');
    }

    testWidgets('+ New project is the last row of Projects for someone who '
        'may write in the Swarm', (tester) async {
      await pump(tester, [NewProjectSwarm()]);
      expect(key('swarm-new-project'), findsOneWidget);
      expect(find.text('New project'), findsOneWidget);
      final rows = [
        key('swarm-project-$tab-$project'),
        key('swarm-project-$tab-project-2'),
      ];
      for (final row in rows) {
        expect(
          tester.getTopLeft(row).dy,
          lessThan(tester.getTopLeft(key('swarm-new-project')).dy),
        );
      }
    });

    testWidgets('a collaborator has it; a viewer does not', (tester) async {
      await pump(tester, [NewProjectSwarm(role: 'collaborator')]);
      expect(key('swarm-new-project'), findsOneWidget);
    });

    testWidgets('a viewer has no + New project', (tester) async {
      await pump(tester, [NewProjectSwarm(role: 'viewer')]);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      expect(key('swarm-new-project'), findsNothing);
    });

    testWidgets('a Swarm whose first read failed offers it once its read '
        'recovers', (tester) async {
      final swarm = NewProjectSwarm()..unreadable = true;
      final host = await pump(tester, [swarm]);
      expect(key('swarm-projects-error-$tab'), findsOneWidget);
      expect(key('swarm-new-project'), findsNothing);

      swarm.unreadable = false;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(key('swarm-new-project'), findsOneWidget);
      await tap(tester, 'swarm-new-project');
      expect(key('swarm-new-project-sheet'), findsOneWidget);
    });

    testWidgets('on All Swarms the sheet asks which Swarm, offering only '
        'those the person may write in', (tester) async {
      await pump(tester, [
        NewProjectSwarm(),
        NewProjectSwarm(id: 'tab-viewed', name: 'Viewed', role: 'viewer'),
        NewProjectSwarm(id: 'tab-2', name: 'Lamp Swarm', role: 'collaborator'),
      ]);
      await tap(tester, 'swarm-new-project');
      expect(key('swarm-new-project-sheet'), findsOneWidget);
      expect(key('swarm-new-project-swarm'), findsOneWidget);
      await tap(tester, 'swarm-new-project-swarm');
      expect(key('swarm-new-project-pick-swarm-$tab'), findsOneWidget);
      expect(key('swarm-new-project-pick-swarm-tab-2'), findsOneWidget);
      expect(key('swarm-new-project-pick-swarm-tab-viewed'), findsNothing);
      expect(
        find.descendant(
          of: key('swarm-new-project-sheet'),
          matching: find.text('Viewed'),
        ),
        findsNothing,
      );
    });

    testWidgets('one Swarm shown: no Swarm row', (tester) async {
      await pump(tester, [NewProjectSwarm()]);
      await tap(tester, 'swarm-new-project');
      expect(key('swarm-new-project-swarm'), findsNothing);
    });

    testWidgets('the repository is the most recently active project\'s, '
        'others and a link a tap away; a link the server would refuse is '
        'not taken', (tester) async {
      await pump(tester, [NewProjectSwarm()]);
      await tap(tester, 'swarm-new-project');
      expect(
        find.descendant(
          of: key('swarm-new-project-repository'),
          matching: find.text('openharness'),
        ),
        findsOneWidget,
      );
      await tap(tester, 'swarm-new-project-repository');
      expect(key('swarm-new-project-pick-repo-$lampRepo'), findsOneWidget);
      await tap(tester, 'swarm-new-project-pick-link');
      await tester.enterText(
        key('swarm-new-project-link'),
        'https://me:secret@github.com/a/b',
      );
      await tap(tester, 'swarm-new-project-link-use');
      expect(key('swarm-new-project-link-error'), findsOneWidget);
      await tester.enterText(key('swarm-new-project-link'), 'github.com/a/b');
      await tap(tester, 'swarm-new-project-link-use');
      expect(
        find.descendant(
          of: key('swarm-new-project-repository'),
          matching: find.text('b'),
        ),
        findsOneWidget,
      );
    });

    testWidgets('PM runs on lists only machines that can run it; with none, '
        'each says why', (tester) async {
      final swarm = NewProjectSwarm(
        machines: [
          leadPool('mac-1', name: 'Studio'),
          leadPool('mac-2', name: 'Old', capable: false),
          leadPool('mac-3', name: 'Full', slots: 0),
        ],
      );
      final host = await pump(tester, [swarm]);
      await tap(tester, 'swarm-new-project');
      expect(find.text(swarmLeadChooseMachine), findsOneWidget);
      await tap(tester, 'swarm-new-project-machine');
      expect(key('swarm-new-project-pick-machine-mac-1'), findsOneWidget);
      expect(key('swarm-new-project-pick-machine-mac-2'), findsNothing);
      expect(key('swarm-new-project-pick-machine-mac-3'), findsNothing);
      await tap(tester, 'swarm-new-project-back');

      // None can now: each says why, and Create says so.
      swarm.machines = [
        leadPool('mac-2', name: 'Old', capable: false),
        leadPool('mac-3', name: 'Full', slots: 0),
      ];
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.text(swarmLeadNoMachine), findsOneWidget);
      await tap(tester, 'swarm-new-project-machine');
      expect(key('swarm-new-project-no-machine'), findsOneWidget);
      expect(
        find.text('Update Harness on Old to run a Product Manager there.'),
        findsOneWidget,
      );
      expect(find.text('Claude Code · No agents free'), findsOneWidget);
      await tester.tap(key('swarm-new-project-pick-machine-mac-2'));
      await tester.pumpAndSettle();
      expect(
        key('swarm-new-project-no-machine'),
        findsOneWidget,
        reason: 'not taken',
      );
    });

    testWidgets('Create makes the project, starts its Product Manager on the '
        'machine picked and opens its project screen', (tester) async {
      final swarm = NewProjectSwarm();
      await pump(tester, [swarm]);
      await tap(tester, 'swarm-new-project');
      await tester.enterText(
        key('swarm-new-project-brief'),
        'Phone New project',
      );
      await pickMachine(tester, 'mac-1');
      await tap(tester, 'swarm-new-project-create');

      expect(swarm.commands('project.create'), hasLength(1));
      final start = swarm.commands('lead.start').single['command'] as Map;
      expect(start['machineId'], 'mac-1');
      expect(start['repositoryUrl'], harnessRepo);
      expect(key('swarm-new-project-sheet'), findsNothing);
      expectHomeCProject('openharness');
    });

    testWidgets('a refused start keeps the project, in the list, says why, '
        'and Create again starts it without a second project', (tester) async {
      final swarm = NewProjectSwarm(
        machines: [
          leadPool('mac-1', name: 'Studio'),
          leadPool('mac-2', name: 'Mini'),
        ],
      );
      var refuse = true;
      swarm.answer = (command) {
        if (command['type'] == 'lead.start' && refuse) {
          refuse = false;
          throw const SuperTabFailure(
            'TEAM_ACCOUNT_BUSY',
            'Studio is busy.',
            statusCode: 409,
          );
        }
        return null;
      };
      await pump(tester, [swarm]);
      await tap(tester, 'swarm-new-project');
      await pickMachine(tester, 'mac-1');
      await tap(tester, 'swarm-new-project-create');

      expect(
        find.text(
          'The project is made. Its Product Manager didn’t start: '
          'Studio is busy.',
        ),
        findsOneWidget,
      );
      final made = swarm.projects.last['id'] as String;
      expect(key('swarm-project-$tab-$made'), findsOneWidget);
      expect(find.text('Try again'), findsOneWidget);

      await pickMachine(tester, 'mac-2');
      await tap(tester, 'swarm-new-project-create');
      expect(swarm.commands('project.create'), hasLength(1));
      expect(swarm.commands('lead.start'), hasLength(2));
      expectHomeCProject('openharness');
    });

    testWidgets('a create whose answer was lost is sent again under its '
        'operation on Try again', (tester) async {
      final swarm = NewProjectSwarm();
      var lose = true;
      swarm.answer = (command) {
        if (command['type'] == 'project.create' && lose) {
          lose = false;
          throw const SuperTabFailure('NETWORK', 'The Swarm didn’t answer.');
        }
        return null;
      };
      await pump(tester, [swarm]);
      await tap(tester, 'swarm-new-project');
      await pickMachine(tester, 'mac-1');
      await tap(tester, 'swarm-new-project-create');
      expect(key('swarm-new-project-error'), findsOneWidget);
      await tap(tester, 'swarm-new-project-create');

      final creates = swarm.commands('project.create');
      expect(creates, hasLength(2));
      expect(creates[0]['operationId'], creates[1]['operationId']);
      expect(
        swarm.projects.where((p) => p['name'] == 'openharness'),
        hasLength(1),
      );
    });

    testWidgets('its Swarm\'s read taken away while it is open closes it at '
        'once', (tester) async {
      final swarm = NewProjectSwarm();
      final host = await pump(tester, [swarm]);
      await tap(tester, 'swarm-new-project');
      expect(key('swarm-new-project-sheet'), findsOneWidget);
      swarm.revoked = true;
      await host.session!.inbox.reader(tab)!.refresh();
      expect(host.session!.inbox.reader(tab)!.accessRevoked, isTrue);
      await tester.pump();
      expect(key('swarm-new-project-sheet'), findsNothing, reason: 'blank');
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
    });

    testWidgets('made a viewer while it is open closes it', (tester) async {
      final swarm = NewProjectSwarm();
      final host = await pump(tester, [swarm]);
      await tap(tester, 'swarm-new-project');
      swarm.role = 'viewer';
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(key('swarm-new-project'), findsNothing);
    });

    testWidgets('signing out while it is open closes it', (tester) async {
      final account = ValueNotifier<String?>(me);
      await pump(tester, [NewProjectSwarm()], account: account);
      await tap(tester, 'swarm-new-project');
      account.value = null;
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(key('swarm-new-project-sheet'), findsNothing);
    });

    testWidgets('access taken away while a create is on its way: its answer '
        'opens nothing and nothing more is sent', (tester) async {
      final swarm = NewProjectSwarm();
      final held = Completer<Object?>();
      swarm.answer = (command) =>
          command['type'] == 'project.create' ? held.future : null;
      final host = await pump(tester, [swarm]);
      await tap(tester, 'swarm-new-project');
      await pickMachine(tester, 'mac-1');
      await tester.tap(key('swarm-new-project-create'));
      await tester.pump();
      expect(swarm.commands('project.create'), hasLength(1));

      swarm.revoked = true;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      held.complete(null);
      await tester.pumpAndSettle();
      expect(
        [for (final b in swarm.sent) (b['command'] as Map)['type']],
        ['project.create'],
      );
      expect(find.text('#openharness'), findsNothing);
      expect(find.byType(SwarmPage), findsOneWidget);
    });
  });
}
