import 'dart:async';

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppFont;
import 'package:harness_mobile/shared/widgets/skeleton.dart';
import 'package:harness_mobile/swarm/swarm_home_list.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';
import 'package:harness_mobile/swarm/swarm_inbox.dart';
import 'package:harness_mobile/swarm/swarm_agents.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_row.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';
import 'package:harness_mobile/swarm/swarm_style.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// The person's computers as a test sets them.
class _Computers extends ChangeNotifier implements SwarmComputers {
  @override
  List<SwarmOwnComputer> get own => const [];

  @override
  Future<Map<String, dynamic>> ask(
    String machineId,
    Map<String, dynamic> payload,
  ) async => throw UnimplementedError();

  _Computers(this.computers);

  @override
  List<SwarmComputer>? computers;

  @override
  bool get rechecking => false;

  void set(List<SwarmComputer>? next) {
    computers = next;
    notifyListeners();
  }

  @override
  Future<void> recheck() async {}

  @override
  void add(BuildContext context) {}
}

/// The person's agents as a test sets them: two working.
class _Agents extends ChangeNotifier implements SwarmAgents {
  @override
  int? get working => 2;

  var lists = 0;

  @override
  void openList(BuildContext context) => lists++;
}

/// Computers that also have the person's agents, as the app's do.
class _AgentComputers extends _Computers implements SwarmAgentsSource {
  _AgentComputers() : super(const [(name: 'MacBook Pro', away: false)]);

  @override
  final _Agents agents = _Agents();
}

/// Half an hour after the fixture's parts last changed (epoch milliseconds
/// 1 and on): every project moved 30 minutes ago, and none is quiet.
DateTime _halfHourIn() => DateTime.fromMillisecondsSinceEpoch(
  0,
  isUtc: true,
).add(const Duration(minutes: 30, seconds: 1));

/// Half a second of frames, for a screen that cannot settle.
Future<void> frames(WidgetTester tester) async {
  for (var i = 0; i < 5; i++) {
    await tester.pump(const Duration(milliseconds: 100));
  }
}

/// Swarm Home and its switcher, over a scripted backend: one Swarm with two
/// projects. Mobile has River as its Product Manager, Nova waiting on the
/// person in g1, Atlas down, and the person's old Chat with PM, which a
/// server before #2090 still sends; Web has Cleo as its Product Manager.
/// With [buddy], Mobile has the person's Buddy chat and their Buddy Wren
/// running in it; Web has no Buddy chat yet, and opening one opens
/// `buddy-web`.
void main() {
  const web = 'project-2';
  const webLead = 'group-lead-web';

  FakeSwarm backend({bool buddy = false}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    const derived = {'decisionsWaiting': 1, 'mentionsWaiting': 1};
    Map<String, dynamic> inWeb(Map<String, dynamic> row) => {
      ...row,
      'projectId': web,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      derived: derived,
      head: headData(
        projects: [
          {
            'id': project,
            'name': 'Mobile',
            'ownerId': me,
            'leadConversationId': leadChat,
            'visibility': 'public',
            'members': <Object>[],
            'updateMinutes': 5,
          },
          {
            'id': web,
            'name': 'Web',
            'ownerId': me,
            'leadConversationId': webLead,
            'visibility': 'public',
            'members': <Object>[],
            'updateMinutes': 5,
          },
        ],
      ),
      agents: [
        agent('agent-lead', name: 'Lead', displayName: 'River'),
        agent('agent-builder', displayName: 'Nova'),
        {
          ...agent('agent-atlas', displayName: 'Atlas'),
          'downSince': '2026-10-27T01:00:00.000Z',
        },
        inWeb(agent('agent-cleo', name: 'Lead', displayName: 'Cleo')),
        if (buddy) buddyData('agent-wren', displayName: 'Wren'),
      ],
      groups: [
        groupData(
          'g1',
          title: 'Fix login',
          number: 4,
          agentIds: ['agent-lead', 'agent-builder'],
          status: 'needs_human',
          lastMessageSequence: 9,
        ),
        groupData(
          'g-atlas',
          title: 'Search page',
          number: 5,
          agentIds: ['agent-atlas'],
          status: 'lost',
          workerId: 'agent-atlas',
          lastMessageSequence: 3,
        ),
        groupData('g-busy', title: 'Sync', lastMessageSequence: 20),
        groupData(
          'g-private',
          title: 'Their chat',
          audience: ['person-other', 'person-third'],
        ),
        groupData('g-pm', title: 'me', audience: [me]),
        if (buddy) buddyChatData('buddy-me', agentIds: ['agent-wren']),
        inWeb(
          groupData(
            webLead,
            title: 'Web',
            agentIds: ['agent-cleo'],
            leadId: 'agent-cleo',
          ),
        ),
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/commands'] = (body) => {
      'result': switch (body?['command']) {
        {'type': 'buddy.chat', 'projectId': web} => {
          'conversationId': 'buddy-web',
        },
        _ => <String, dynamic>{},
      },
    };
    fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  /// Swarm Home as the root of its own stack, Swarm on, on an iPhone's
  /// screen. Its route is the shell's kind, the kind of every page pushed
  /// over it: a push or pop builds nothing of Home again, as on the phone.
  /// [overPage] opens it over another page instead ([openSwarmHome]).
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    SwarmComputers? computers,
    bool settle = true,
    bool overPage = false,
    DateTime Function()? now,
    MemoryKeyValueStore? store,
  }) async {
    tester.view.physicalSize = const Size(1170, 2532);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      computers: computers,
      readMarks: store ?? MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        onGenerateRoute: (_) => CupertinoPageRoute<void>(
          builder: (_) => overPage
              ? const SizedBox(key: ValueKey('page-under'))
              : SwarmPage(now: now ?? _halfHourIn),
        ),
      ),
    );
    if (overPage) {
      openSwarmHome(tester.element(find.byKey(const ValueKey('page-under'))));
    }
    // A skeleton breathes for as long as it shows: nothing settles under it.
    settle ? await tester.pumpAndSettle() : await frames(tester);
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  double y(WidgetTester tester, String k) => tester.getTopLeft(key(k)).dy;
  Finder inside(String k, Finder matching) =>
      find.descendant(of: key(k), matching: matching);

  /// The Swarm switcher, from Home's title.
  Future<void> openSwitcher(WidgetTester tester) async {
    await tester.tap(key('swarm-title-button'));
    await tester.pumpAndSettle();
  }

  /// Mobile's chats in [backend].
  const mobileChats = [
    leadChat,
    'g1',
    'g-atlas',
    'g-busy',
    'g-private',
    'g-pm',
  ];

  /// [fake]'s first load with each of [at]'s chats last changed then, in
  /// epoch milliseconds.
  void timed(FakeSwarm fake, Map<String, int> at) {
    final load = fake.routes['/api/super-tabs/$tab/parts']!;
    fake.routes['/api/super-tabs/$tab/parts'] = (body) async {
      final answer = await load(body) as Map<String, dynamic>;
      return {
        ...answer,
        'groups': [
          for (final part in answer['groups'] as List)
            {...part as Map<String, dynamic>, 'changedAt': ?at[part['key']]},
        ],
      };
    };
  }

  /// The weight of the words in row [k] that hold [words].
  FontWeight? weightOf(WidgetTester tester, String k, String words) => tester
      .widget<Text>(inside(k, find.textContaining(words)))
      .style
      ?.fontWeight;

  /// A change read in which [groups] moved, by id.
  void moveOn(FakeSwarm fake, Map<String, Map<String, dynamic>> groups) =>
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        derived: const {'decisionsWaiting': 1, 'mentionsWaiting': 1},
        groups: [
          for (final MapEntry(:key, :value) in groups.entries)
            part(key, 30, value),
        ],
      );

  group("Home's top", () {
    testWidgets('as C1 draws it: the Swarm shown is the title, a button with '
        'its tile; the projects under it; no Jump to, no menu, no Needs you, '
        'no Buddies', (tester) async {
      await pump(tester, backend(buddy: true));

      expect(
        inside('swarm-title-button', find.text('Phone Swarm')),
        findsOneWidget,
      );
      expect(
        inside('swarm-title-button', find.byType(SwarmProjectTile)),
        findsOneWidget,
      );
      expect(
        inside('swarm-title-button', find.byIcon(LucideIcons.chevronDown300)),
        findsOneWidget,
      );
      expect(key('swarm-menu'), findsNothing);
      expect(key('tty-back'), findsNothing, reason: 'Home is the root');
      final size = tester.getSize(key('swarm-title-button'));
      expect(size.height, greaterThanOrEqualTo(44));
      expect(size.width, greaterThanOrEqualTo(44));
      expect(key('swarm-compose'), findsNothing);
      expect(key('swarm-new-message'), findsNothing);
      expect(key('swarm-home-search'), findsNothing);
      expect(
        y(tester, 'swarm-title-button'),
        lessThan(y(tester, 'swarm-project-$tab-$project')),
      );
      expect(find.text('Jump to…'), findsNothing);
      expect(find.text('Needs you'), findsNothing);
      expect(find.text('Ship it behind a flag?'), findsNothing);
      expect(key('swarm-need-line'), findsNothing);
      expect(find.text('Buddies'), findsNothing);
      expect(key('swarm-home-buddy-$tab-$project'), findsNothing);
      expect(find.text('Chat with PM'), findsNothing);
    });

    testWidgets('the title opens the switcher: the one Swarm ticked, no All '
        'Swarms over one, then Join or create, which says how', (tester) async {
      await pump(tester, backend());
      await openSwitcher(tester);

      expect(
        inside('swarm-switch-$tab', find.text('Phone Swarm')),
        findsOneWidget,
      );
      expect(
        inside('swarm-switch-$tab', find.byIcon(LucideIcons.check300)),
        findsOneWidget,
        reason: 'the only Swarm is the one Home shows',
      );
      expect(key('swarm-switch-all'), findsNothing);
      expect(
        y(tester, 'swarm-switch-$tab'),
        lessThan(y(tester, 'swarm-switch-join')),
      );
      for (final k in ['swarm-switch-$tab', 'swarm-switch-join']) {
        expect(
          tester.getSize(key(k)).height,
          greaterThanOrEqualTo(44),
          reason: k,
        );
      }

      await tester.tap(key('swarm-switch-join'));
      await tester.pumpAndSettle();

      expect(key('swarm-switch-$tab'), findsNothing, reason: 'it closed');
      expect(find.text('Join or create a Swarm'), findsOneWidget);
      expect(
        find.text('To join one, ask its owner to invite you. To start one:'),
        findsOneWidget,
      );
      await tester.tap(find.text('Got it'));
      await tester.pumpAndSettle();
      expect(find.text('Join or create a Swarm'), findsNothing);
    });

    testWidgets("the switcher's Agents row opens every agent on the person's "
        'computers, as the Agents tile did; with no agents to show, none', (
      tester,
    ) async {
      await pump(tester, backend());
      await openSwitcher(tester);
      expect(key('swarm-switch-agents'), findsNothing, reason: 'none known');
      await tester.tapAt(const Offset(195, 40));
      await tester.pumpAndSettle();

      final computers = _AgentComputers();
      addTearDown(computers.dispose);
      await pump(tester, backend(), computers: computers);
      await openSwitcher(tester);
      expect(
        y(tester, 'swarm-switch-$tab'),
        lessThan(y(tester, 'swarm-switch-agents')),
      );
      expect(inside('swarm-switch-agents', find.text('Agents')), findsOne);
      expect(
        tester.getSize(key('swarm-switch-agents')).height,
        greaterThanOrEqualTo(44),
      );

      await tester.tap(key('swarm-switch-agents'));
      await tester.pumpAndSettle();
      expect(computers.agents.lists, 1);
      expect(key('swarm-switch-$tab'), findsNothing, reason: 'it closed');
    });
  });

  group('a list that could not be read', () {
    const unread = 'Could not load your Swarms. Try again.';
    Never broken(_) => throw const FormatException('Bad answer');

    testWidgets('before any read, Home stays on its skeleton with no words, '
        'and the rows come once the list answers', (tester) async {
      final fake = backend();
      final listed = fake.routes['/api/super-tabs/list']!;
      fake.routes['/api/super-tabs/list'] = broken;
      final host = await pump(tester, fake, settle: false);

      expect(host.session!.inbox.error, unread);
      expect(key('swarm-projects-loading'), findsOneWidget);
      expect(find.text('Projects'), findsNothing, reason: 'no heading');
      expect(find.text(unread), findsNothing);

      fake.routes['/api/super-tabs/list'] = listed;
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(key('swarm-projects-loading'), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets("a server's own refusal is no line either", (tester) async {
      const moving = 'This Swarm is being moved. Try again in a moment.';
      final fake = backend()
        ..routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
          'SWARM_MIGRATING',
          moving,
          statusCode: 503,
        );
      await pump(tester, fake, settle: false);

      expect(key('swarm-projects-loading'), findsOneWidget);
      expect(find.text(moving), findsNothing);
    });

    testWidgets('once read, the rows stay with no line over them', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);

      fake.routes['/api/super-tabs/list'] = broken;
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(host.session!.inbox.error, unread);
      expect(find.text(unread), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets('a server with no list at all says so, quietly, as no read '
        'will bring its rows', (tester) async {
      final fake = backend()
        ..routes['/api/super-tabs/list'] = (_) => throw const SuperTabFailure(
          'NOT_FOUND',
          'This Super Tab is unavailable.',
          statusCode: 404,
        );
      await pump(tester, fake);

      expect(key('swarm-projects-loading'), findsNothing);
      expect(
        key('swarm-title-loading'),
        findsNothing,
        reason: 'none will come',
      );
      final line = tester.widget<Text>(key('swarm-too-old'));
      expect(line.data, swarmServerTooOld);
      expect(line.style?.color, isNot(AppColors.danger));
    });
  });

  group('Swarm Home', () {
    testWidgets("a project's row is one line: no count of who reads it nor "
        'of who is running, public or private (Slack\'s channels, '
        '2026-11-03)', (tester) async {
      final fake = backend();
      Map<String, dynamic> inProject(String id, String visibility) => {
        'id': id,
        'name': id,
        'ownerId': me,
        'leadConversationId': 'lead-$id',
        'visibility': visibility,
        'members': [
          {'id': 'person-other', 'generation': 'gen-person-other'},
        ],
        'updateMinutes': 5,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          head: headData(
            projects: [inProject(project, 'public'), inProject(web, 'private')],
          ),
          agents: [agent('agent-builder'), agent('agent-idle')],
          groups: [
            groupData(
              'g-work',
              title: 'Work',
              agentIds: ['agent-builder'],
              status: 'working',
              workerId: 'agent-builder',
            ),
          ],
        ),
        'members': [
          part(me, 1, person(me)),
          part('person-other', 1, person('person-other')),
          part('person-third', 1, person('person-third')),
        ],
      };
      await pump(tester, fake);

      const publicRow = 'swarm-project-$tab-$project';
      const privateRow = 'swarm-project-$tab-$web';
      for (final row in [publicRow, privateRow]) {
        expect(inside(row, find.textContaining('human')), findsNothing);
        expect(inside(row, find.textContaining('running')), findsNothing);
        expect(inside(row, find.byType(SwarmAvatar)), findsNothing);
        expect(tester.getSize(key(row)).height, SwarmHomeProjectRow.height);
      }
      expect(
        inside(publicRow, key('swarm-project-dot')),
        findsNothing,
        reason: 'who is running is not on the row, not even as a dot',
      );
    });

    testWidgets('projects with nothing new are quiet, each on one line, with no '
        'people and no time', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await pump(tester, backend());

      const mobileRow = 'swarm-project-$tab-$project';
      const webRow = 'swarm-project-$tab-$web';
      expect(weightOf(tester, mobileRow, 'Mobile'), isNot(AppFont.semibold));
      expect(weightOf(tester, webRow, 'Web'), isNot(AppFont.semibold));
      expect(inside(webRow, find.textContaining('@')), findsNothing);
      for (final row in [mobileRow, webRow]) {
        expect(inside(row, find.textContaining('human')), findsNothing);
      }
      expect(inside(mobileRow, find.text('30m')), findsNothing);
      expect(inside(mobileRow, find.text('#Mobile')), findsOneWidget);
      expect(inside(webRow, find.text('#Web')), findsOneWidget);
      for (final row in [mobileRow, webRow]) {
        expect(
          inside(row, key('swarm-project-dot')),
          findsNothing,
          reason: 'no dot, with someone down or all idle',
        );
      }
      expect(
        tester.getTopLeft(inside(webRow, find.text('#Web'))).dx,
        tester.getTopLeft(inside(mobileRow, find.text('#Mobile'))).dx,
        reason: 'the names stay in line',
      );
      semantics.dispose();
    });

    testWidgets(
      'a person writing in the project chat makes it bold, with a dot and no '
      'count',
      (tester) async {
        final fake = backend();
        final host = await pump(tester, fake);
        moveOn(fake, {
          webLead: {
            ...groupData(
              webLead,
              title: 'Web',
              agentIds: ['agent-cleo'],
              leadId: 'agent-cleo',
              lastMessageSequence: 1,
            ),
            'projectId': web,
            'lastPersonSequence': 1,
          },
        });
        await host.session!.inbox.refresh();
        await tester.pumpAndSettle();

        const webRow = 'swarm-project-$tab-$web';
        expect(weightOf(tester, webRow, 'Web'), AppFont.semibold);
        expect(inside(webRow, key('swarm-project-unread')), findsOneWidget);
        expect(inside(webRow, find.textContaining('@')), findsNothing);
      },
    );

    testWidgets(
      'projects stay alphabetical after new activity, the time off the row',
      (tester) async {
        final now = DateTime.utc(2026, 10, 29, 10);
        int ago(int minutes) =>
            now.subtract(Duration(minutes: minutes)).millisecondsSinceEpoch;
        final fake = backend();
        timed(fake, {
          for (final id in mobileChats) id: ago(9),
          webLead: ago(2),
        });
        final host = await pump(tester, fake, now: () => now);
        void alphabetical() => expect(
          y(tester, 'swarm-project-$tab-$project'),
          lessThan(y(tester, 'swarm-project-$tab-$web')),
        );
        alphabetical();
        moveOn(fake, {
          webLead: {
            ...groupData(webLead, title: 'Web', lastMessageSequence: 99),
            'projectId': web,
            'lastPersonSequence': 99,
            'changedAt': now.millisecondsSinceEpoch,
          },
        });
        await host.session!.inbox.refresh();
        await tester.pumpAndSettle();
        alphabetical();
        expect(
          inside('swarm-project-$tab-$web', key('swarm-project-unread')),
          findsOneWidget,
        );
        expect(
          inside('swarm-project-$tab-$web', find.text('2m')),
          findsNothing,
        );
        expect(
          inside('swarm-project-$tab-$project', find.text('9m')),
          findsNothing,
        );
      },
    );

    testWidgets('a project quiet for a day folds under Other projects, which '
        'a tap opens and closes', (tester) async {
      final now = DateTime.utc(2026, 10, 29, 10);
      int ago(int minutes) =>
          now.subtract(Duration(minutes: minutes)).millisecondsSinceEpoch;
      final fake = backend();
      timed(fake, {
        for (final id in mobileChats) id: ago(60 * 48),
        webLead: ago(5),
      });
      await pump(tester, fake, now: () => now);

      expect(key('swarm-project-$tab-$web'), findsOneWidget);
      expect(key('swarm-project-$tab-$project'), findsNothing);
      expect(
        inside('swarm-other-projects', find.text('Other projects · 1')),
        findsOneWidget,
      );
      expect(
        inside(
          'swarm-other-projects',
          find.byIcon(LucideIcons.chevronRight300),
        ),
        findsOneWidget,
      );
      expect(
        tester.getSize(key('swarm-other-projects')).height,
        greaterThanOrEqualTo(44),
      );

      await tester.tap(key('swarm-other-projects'));
      await tester.pumpAndSettle();
      expect(
        inside('swarm-other-projects', find.byIcon(LucideIcons.chevronDown300)),
        findsOneWidget,
        reason: 'the chevron turns as they open',
      );
      expect(
        y(tester, 'swarm-other-projects'),
        lessThan(y(tester, 'swarm-project-$tab-$project')),
      );
      expect(key('swarm-project-$tab-$project'), findsOneWidget);

      await tester.tap(key('swarm-other-projects'));
      await tester.pumpAndSettle();
      expect(key('swarm-project-$tab-$project'), findsNothing);
    });

    testWidgets('a long press pins a project at the top, with no Pinned '
        'heading (anh Dee, 2026-11-04); Unpin puts it back', (tester) async {
      final host = await pump(tester, backend());
      host.session!.home.setSort(SwarmHomeSort.newest);
      await tester.pumpAndSettle();
      double top(String id) => y(tester, 'swarm-project-$tab-$id');
      expect(top(web), lessThan(top(project)), reason: 'explicit newest first');

      await tester.longPress(key('swarm-project-$tab-$project'));
      await tester.pumpAndSettle();
      expect(inside('swarm-pin', find.text('Pin to top')), findsOneWidget);
      await tester.tap(key('swarm-pin'));
      await tester.pumpAndSettle();

      expect(find.text('Pinned'), findsNothing);
      expect(top(project), lessThan(top(web)));
      expect(host.session!.home.pinned(tab, project), isTrue);

      await tester.longPress(key('swarm-project-$tab-$project'));
      await tester.pumpAndSettle();
      expect(inside('swarm-pin', find.text('Unpin')), findsOneWidget);
      await tester.tap(key('swarm-pin'));
      await tester.pumpAndSettle();
      expect(top(web), lessThan(top(project)));
      expect(host.session!.home.pinned(tab, project), isFalse);
    });

    testWidgets("the prototype's top bar, captions and dots", (tester) async {
      await pump(tester, backend());

      expect(
        tester.getTopLeft(key('swarm-title-button')).dx,
        8,
        reason: "its ink 8 points in, the tile 4 in from it",
      );
      expect(tester.widget<Text>(key('swarm-title')).data, 'Phone Swarm');
      expect(find.text('Projects'), findsNothing, reason: 'no heading');
      expect(key('swarm-home-view'), findsNothing, reason: 'no filter icon');
      expect(key('swarm-needs-count'), findsNothing);
      expect(
        inside('swarm-project-$tab-$project', find.byType(SwarmProjectTile)),
        findsNothing,
        reason: "a project's dot, not its tile",
      );
      expect(
        inside('swarm-project-$tab-$project', key('swarm-project-dot')),
        findsNothing,
        reason: 'no dot before the name',
      );
    });

    testWidgets('back from a project, Home still has its title, and it opens '
        'the switcher', (tester) async {
      await pump(tester, backend());

      await tester.tap(key('swarm-project-$tab-$project'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectPage), findsOneWidget);

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectPage), findsNothing);
      expect(key('swarm-title-button'), findsOneWidget);
      expect(key('tty-back'), findsNothing, reason: 'Home is the root');

      await openSwitcher(tester);
      expect(key('swarm-switch-$tab'), findsOneWidget);
    });

    testWidgets('opened over another page, it has back instead of the '
        'switcher, and back goes to that page', (tester) async {
      await pump(tester, backend(), overPage: true);
      expect(find.byType(SwarmPage), findsOneWidget);
      expect(key('swarm-title-button'), findsNothing);

      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmPage), findsNothing);
      expect(key('page-under'), findsOneWidget);
    });

    testWidgets('a project opens its page', (tester) async {
      await pump(tester, backend());

      await tester.tap(key('swarm-project-$tab-$web'));
      await tester.pumpAndSettle();

      final page = tester.widget<SwarmProjectPage>(
        find.byType(SwarmProjectPage),
      );
      expect((page.swarmId, page.projectId), (tab, web));
      expectHomeCProject('Web');
    });
  });

  group('several Swarms', () {
    const second = 'tab-2';

    /// The Swarm of [backend], and Work Swarm, whose one project has the
    /// same id as Mobile's, named Backend, and asks nothing of the person.
    FakeSwarm two() {
      final fake = backend();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
          {'id': second, 'name': 'Work Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$second/parts'] = (_) => firstLoad(
        tabId: second,
        head: headData(
          id: second,
          name: 'Work Swarm',
          projects: [
            {
              'id': project,
              'name': 'Backend',
              'ownerId': me,
              'leadConversationId': leadChat,
              'visibility': 'public',
              'members': <Object>[],
            },
          ],
        ),
      );
      fake.routes['/api/super-tabs/$second/changes'] = (_) =>
          changes(cursor: 'c2');
      return fake;
    }

    testWidgets("every Swarm's projects on Home under one small heading, its "
        'name, and no row naming its Swarm (anh Dee, 2026-11-04); the same '
        'project id in two Swarms is two rows, pinned apart, a pin first in '
        'its own Swarm', (tester) async {
      final host = await pump(tester, two());

      const mobileRow = 'swarm-project-$tab-$project';
      const webRow = 'swarm-project-$tab-$web';
      const backendRow = 'swarm-project-$second-$project';
      expect(
        tester.widget<SwarmCaption>(key('swarm-heading-$tab')).text,
        'Phone Swarm',
      );
      expect(
        tester.widget<SwarmCaption>(key('swarm-heading-$second')).text,
        'Work Swarm',
      );
      final order = [
        'swarm-heading-$tab',
        mobileRow,
        webRow,
        'swarm-heading-$second',
        backendRow,
      ];
      for (final (i, k) in order.indexed.skip(1)) {
        expect(y(tester, order[i - 1]), lessThan(y(tester, k)), reason: k);
      }
      expect(inside(mobileRow, find.text('#Mobile')), findsOne);
      expect(inside(backendRow, find.text('#Backend')), findsOne);
      expect(
        inside(mobileRow, find.textContaining('Swarm', findRichText: true)),
        findsNothing,
      );

      for (final row in [backendRow, mobileRow]) {
        await tester.longPress(key(row));
        await tester.pumpAndSettle();
        await tester.tap(key('swarm-pin'));
        await tester.pumpAndSettle();
      }

      expect(host.session!.home.pins, {'$second/$project', '$tab/$project'});
      expect(y(tester, 'swarm-heading-$tab'), lessThan(y(tester, mobileRow)));
      expect(y(tester, mobileRow), lessThan(y(tester, webRow)));
      expect(
        y(tester, webRow),
        lessThan(y(tester, 'swarm-heading-$second')),
        reason: 'a pin stays in its Swarm',
      );
      expect(find.text('Pinned'), findsNothing);
    });

    testWidgets('over two Swarms the title is All Swarms; one picked in the '
        'switcher is Home alone, its name the title, ticked; All Swarms '
        'shows both again', (
      tester,
    ) async {
      final host = await pump(tester, two());
      expect(tester.widget<Text>(key('swarm-title')).data, 'All Swarms');
      expect(
        inside('swarm-title-button', find.byType(SwarmProjectTile)),
        findsNothing,
        reason: "a tile is one Swarm's",
      );
      await openSwitcher(tester);
      expect(
        inside('swarm-switch-all', find.byIcon(LucideIcons.check300)),
        findsOneWidget,
      );
      for (final id in [tab, second]) {
        expect(
          inside('swarm-switch-$id', find.byIcon(LucideIcons.check300)),
          findsNothing,
          reason: 'Home shows both',
        );
      }
      final order = [
        'swarm-switch-all',
        'swarm-switch-$tab',
        'swarm-switch-$second',
        'swarm-switch-join',
      ];
      for (final (i, k) in order.indexed.skip(1)) {
        expect(y(tester, order[i - 1]), lessThan(y(tester, k)), reason: k);
      }

      await tester.tap(key('swarm-switch-$second'));
      await tester.pumpAndSettle();

      expect(host.session!.home.swarmId, second);
      expect(key('swarm-switch-join'), findsNothing, reason: 'it closed');
      expect(tester.widget<Text>(key('swarm-title')).data, 'Work Swarm');
      expect(
        inside('swarm-title-button', find.byType(SwarmProjectTile)),
        findsOneWidget,
      );
      expect(key('swarm-project-$second-$project'), findsOneWidget);
      expect(key('swarm-project-$tab-$project'), findsNothing);
      expect(key('swarm-project-$tab-$web'), findsNothing);
      expect(
        inside(
          'swarm-project-$second-$project',
          find.textContaining('Work Swarm', findRichText: true),
        ),
        findsNothing,
        reason: 'one Swarm: its name is not on each row',
      );
      expect(
        key('swarm-heading-$second'),
        findsNothing,
        reason: 'one Swarm: the title names it',
      );

      await openSwitcher(tester);
      expect(
        inside('swarm-switch-$second', find.byIcon(LucideIcons.check300)),
        findsOneWidget,
      );
      expect(
        inside('swarm-switch-all', find.byIcon(LucideIcons.check300)),
        findsNothing,
      );
      expect(inside('swarm-switch-$tab', find.text('3')), findsNothing);

      await tester.tap(key('swarm-switch-all'));
      await tester.pumpAndSettle();
      expect(host.session!.home.swarmId, isNull);
      expect(tester.widget<Text>(key('swarm-title')).data, 'All Swarms');
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      expect(key('swarm-project-$second-$project'), findsOneWidget);
    });

    testWidgets('a Swarm the account loses while the switcher is open leaves '
        'it, and a tap on its row as it goes shows nothing of it', (
      tester,
    ) async {
      final fake = two();
      final host = await pump(tester, fake);
      await openSwitcher(tester);
      final stale = tester.widget<SwarmRow>(key('swarm-switch-$second')).onTap!;

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await tester.pump();
      expect(key('swarm-switch-$second'), findsNothing);
      expect(find.text('Work Swarm'), findsNothing);

      stale();
      await tester.pumpAndSettle();
      expect(host.session!.home.swarmId, isNull);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Phone Swarm');
      expect(key('swarm-project-$second-$project'), findsNothing);
    });

    testWidgets('a Swarm whose read is taken away while the switcher is open '
        'leaves it at once, though the list still has it, and a tap on its '
        'row as it goes picks nothing', (tester) async {
      final fake = two();
      final host = await pump(tester, fake);
      await openSwitcher(tester);
      final stale = tester.widget<SwarmRow>(key('swarm-switch-$second')).onTap!;

      Never refused(_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'You no longer have access to this Swarm.',
        statusCode: 403,
      );
      fake.routes['/api/super-tabs/$second/changes'] = refused;
      fake.routes['/api/super-tabs/$second/parts'] = refused;
      await host.session!.inbox.reader(second)!.refresh();
      expect(host.session!.inbox.reader(second)!.accessRevoked, isTrue);
      await tester.pump();
      expect(
        host.session!.inbox.swarms.map((swarm) => swarm.id),
        contains(second),
      );
      expect(key('swarm-switch-$second'), findsNothing);
      expect(find.text('Work Swarm'), findsNothing);

      stale();
      await tester.pumpAndSettle();
      expect(host.session!.home.swarmId, isNull);
      expect(tester.widget<Text>(key('swarm-title')).data, 'All Swarms');
      expect(find.text('Work Swarm'), findsNothing);
    });

    testWidgets("the Swarm picked, its read taken away: Home's title lets go "
        'of its name, and Home shows every Swarm again', (tester) async {
      final fake = two();
      final host = await pump(tester, fake);
      host.session!.home.show(second);
      await tester.pumpAndSettle();
      expect(tester.widget<Text>(key('swarm-title')).data, 'Work Swarm');

      Never refused(_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'You no longer have access to this Swarm.',
        statusCode: 403,
      );
      fake.routes['/api/super-tabs/$second/changes'] = refused;
      fake.routes['/api/super-tabs/$second/parts'] = refused;
      await host.session!.inbox.reader(second)!.refresh();
      expect(host.session!.inbox.reader(second)!.accessRevoked, isTrue);
      await tester.pumpAndSettle();

      expect(tester.widget<Text>(key('swarm-title')).data, 'All Swarms');
      expect(find.text('Work Swarm'), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
      expect(
        inside(
          'swarm-projects-error-$second',
          find.text('You no longer have access to this Swarm.'),
        ),
        findsOneWidget,
      );
    });

    testWidgets("the one Swarm's read taken away: the title says Swarm, never "
        'its name', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Phone Swarm');

      Never refused(_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'You no longer have access to this Swarm.',
        statusCode: 403,
      );
      fake.routes['/api/super-tabs/$tab/changes'] = refused;
      fake.routes['/api/super-tabs/$tab/parts'] = refused;
      await host.session!.inbox.reader(tab)!.refresh();
      expect(host.session!.inbox.reader(tab)!.accessRevoked, isTrue);
      await tester.pumpAndSettle();

      expect(tester.widget<Text>(key('swarm-title')).data, 'Swarm');
      expect(find.text('Phone Swarm'), findsNothing);
    });

    testWidgets('a Swarm the account loses while Home is open: its rows '
        'leave Home, and its pin and pick leave the phone', (tester) async {
      final fake = two();
      final host = await pump(tester, fake);
      host.session!.home
        ..pin(second, project, true)
        ..show(second);
      await tester.pumpAndSettle();
      expect(key('swarm-project-$second-$project'), findsOneWidget);

      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await tester.pumpAndSettle();

      expect(key('swarm-project-$second-$project'), findsNothing);
      expect(find.textContaining('Backend'), findsNothing);
      expect(find.text('Pinned'), findsNothing);
      expect(host.session!.home.pins, isEmpty);
      expect(host.session!.home.swarmId, isNull);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets("a project's pin sheet whose Swarm refuses its read while it "
        'is open shows nothing of it at once, closes and pins nothing', (
      tester,
    ) async {
      final fake = two();
      final host = await pump(tester, fake);
      await tester.longPress(key('swarm-project-$second-$project'));
      await tester.pumpAndSettle();
      expect(inside('swarm-pin', find.text('Pin to top')), findsOneWidget);
      expect(
        find.textContaining('Backend'),
        findsNWidgets(2),
        reason: 'row and sheet',
      );

      Never refused(_) => throw const SuperTabFailure(
        'FORBIDDEN',
        'You no longer have access to this Swarm.',
        statusCode: 403,
      );
      fake.routes['/api/super-tabs/$second/changes'] = refused;
      fake.routes['/api/super-tabs/$second/parts'] = refused;
      await host.session!.inbox.reader(second)!.refresh();
      expect(host.session!.inbox.reader(second)!.accessRevoked, isTrue);
      await tester.pump();
      expect(key('swarm-pin'), findsNothing, reason: 'blank at once');

      await tester.pumpAndSettle();
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.textContaining('Backend'), findsNothing);
      expect(host.session!.home.pins, isEmpty);
    });

    testWidgets('Pin tapped as its Swarm leaves the list pins nothing: the '
        'pin the list took away does not come back', (tester) async {
      final fake = two();
      final host = await pump(tester, fake);
      await tester.longPress(key('swarm-project-$second-$project'));
      await tester.pumpAndSettle();

      final press = await tester.startGesture(
        tester.getCenter(key('swarm-pin')),
      );
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      await host.session!.inbox.refresh();
      await press.up();
      await tester.pumpAndSettle();

      expect(host.session!.home.pins, isEmpty);
      expect(find.byType(BottomSheet), findsNothing);
      expect(find.textContaining('Backend'), findsNothing);
      expect(find.text('Pinned'), findsNothing);
    });

    testWidgets('a Swarm whose read is refused lists none of its projects '
        'and says why, with no row left on its way', (tester) async {
      final fake = two()
        ..routes['/api/super-tabs/$second/parts'] = (_) =>
            throw const SuperTabFailure(
              'FORBIDDEN',
              'You no longer have access to this Swarm.',
              statusCode: 403,
            );
      await pump(tester, fake);

      expect(key('swarm-project-$second-$project'), findsNothing);
      expect(find.textContaining('Backend'), findsNothing);
      expect(key('swarm-projects-loading-$second'), findsNothing);
      expect(
        inside(
          'swarm-projects-error-$second',
          find.text('You no longer have access to this Swarm.'),
        ),
        findsOneWidget,
      );
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });
  });

  group('while Home reads', () {
    /// [path] answers only once the returned gate is opened.
    Completer<void> hold(FakeSwarm fake, String path) {
      final gate = Completer<void>();
      final answer = fake.routes[path]!;
      fake.routes[path] = (body) async {
        await gate.future;
        return answer(body);
      };
      return gate;
    }

    double height(WidgetTester tester, String k) =>
        tester.getSize(key(k)).height;

    testWidgets('before the list answers, the title and its tile are '
        'skeletons; the Swarm then names them', (tester) async {
      final fake = backend();
      final listed = hold(fake, '/api/super-tabs/list');
      await pump(tester, fake, settle: false);

      expect(key('swarm-title-loading'), findsOneWidget);
      expect(key('swarm-title'), findsNothing);
      expect(inside('swarm-title-button', find.byType(Skeleton)), findsWidgets);
      expect(find.text('Swarm'), findsNothing, reason: 'no word for a name');

      listed.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-title-loading'), findsNothing);
      expect(tester.widget<Text>(key('swarm-title')).data, 'Phone Swarm');
      expect(
        inside('swarm-title-button', find.byType(SwarmProjectTile)),
        findsOneWidget,
      );
    });

    testWidgets(
      'a start screen has no Swarm coming: the title is no skeleton',
      (tester) async {
        final fake = backend();
        final listed = hold(fake, '/api/super-tabs/list');
        await pump(
          tester,
          fake,
          computers: _Computers(const []),
          settle: false,
        );

        expect(find.byType(SwarmStartView), findsOneWidget);
        expect(key('swarm-title-loading'), findsNothing);
        expect(tester.widget<Text>(key('swarm-title')).data, 'Swarm');

        listed.complete();
        await tester.pumpAndSettle();
      },
    );

    testWidgets('the switcher opened before the list answers has a row on its '
        'way, and the Swarm in its place after', (tester) async {
      final fake = backend();
      final listed = hold(fake, '/api/super-tabs/list');
      await pump(tester, fake, settle: false);

      await tester.tap(key('swarm-title-button'));
      await frames(tester);
      expect(key('swarm-switch-loading'), findsOneWidget);
      expect(key('swarm-switch-join'), findsOneWidget);

      listed.complete();
      await frames(tester);
      await frames(tester);
      expect(key('swarm-switch-loading'), findsNothing);
      expect(key('swarm-switch-$tab'), findsOneWidget);
    });

    testWidgets('before the list answers, the projects are skeleton rows, '
        'and nothing says it is reading', (tester) async {
      final fake = backend();
      final listed = hold(fake, '/api/super-tabs/list');
      await pump(tester, fake, settle: false);

      expect(key('swarm-projects-loading'), findsOneWidget);
      expect(find.text('Buddies'), findsNothing);
      expect(find.text('Projects'), findsNothing);
      expect(find.textContaining('Reading'), findsNothing);

      listed.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-projects-loading'), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    for (final scale in [1.0, 1.3]) {
      testWidgets('skeleton rows are as tall as the rows that replace them '
          '(text at $scale)', (tester) async {
        tester.platformDispatcher.textScaleFactorTestValue = scale;
        addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
        final fake = backend();
        final listed = hold(fake, '/api/super-tabs/list');
        await pump(tester, fake, settle: false);
        final row = height(tester, 'swarm-projects-loading-0');
        final loading = find.byKey(const ValueKey('swarm-projects-loading-0'));
        final title = tester.getTopLeft(
          find
              .descendant(of: loading, matching: find.byType(SkeletonText))
              .first,
        );

        listed.complete();
        await tester.pumpAndSettle();

        expect(
          height(tester, 'swarm-project-$tab-$web'),
          closeTo(row, .01),
          reason: 'its title and its team, as the skeleton draws them',
        );
        const webRow = 'swarm-project-$tab-$web';
        expect(
          tester.getTopLeft(inside(webRow, find.text('#Web'))).dx,
          closeTo(title.dx, .01),
          reason: 'the title stays where its bar was',
        );
      });
    }

    testWidgets('of two Swarms, the one still to be read has its rows on '
        'their way; the switcher lists both', (tester) async {
      const second = 'tab-2';
      final fake = backend();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
          {'id': second, 'name': 'Second Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$second/parts'] = (_) => firstLoad(
        tabId: second,
        head: headData(id: second, name: 'Second Swarm'),
      );
      final read = hold(fake, '/api/super-tabs/$tab/parts');
      await pump(tester, fake, settle: false);

      expect(key('swarm-project-$second-$project'), findsOneWidget);
      expect(key('swarm-projects-loading-$tab'), findsOneWidget);
      final order = [
        'swarm-heading-$tab',
        'swarm-projects-loading-$tab',
        'swarm-heading-$second',
        'swarm-project-$second-$project',
      ];
      for (final (i, k) in order.indexed.skip(1)) {
        expect(
          y(tester, order[i - 1]),
          lessThan(y(tester, k)),
          reason: 'each Swarm in its place, its rows on their way: $k',
        );
      }
      await tester.tap(key('swarm-title-button'));
      await frames(tester);
      expect(key('swarm-switch-$tab'), findsOneWidget);
      expect(key('swarm-switch-$second'), findsOneWidget);

      read.complete();
      await tester.pumpAndSettle();

      expect(key('swarm-projects-loading-$tab'), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets('a Swarm that could not be read stays on its way, saying '
        'nothing, until a read works', (tester) async {
      final fake = backend();
      final parts = fake.routes['/api/super-tabs/$tab/parts']!;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
          throw SuperTabFailure('INTERNAL', 'Broken', statusCode: 500);
      final host = await pump(tester, fake, settle: false);

      expect(host.session!.inbox.reader(tab)!.error, 'Broken');
      expect(key('swarm-projects-loading-$tab'), findsOneWidget);
      expect(key('swarm-projects-error-$tab'), findsNothing);
      expect(find.text('Broken'), findsNothing);

      fake.routes['/api/super-tabs/$tab/parts'] = parts;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(key('swarm-projects-loading-$tab'), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });
  });

  group('the start screens', () {
    const mac = (name: 'MacBook Pro', away: false);

    testWidgets('with no computer, Home draws its start screen in place of '
        'its body, under its own top bar', (tester) async {
      await pump(tester, backend(), computers: _Computers(const []));

      expect(find.byType(SwarmStartView), findsOneWidget);
      expect(
        key('swarm-title-button'),
        findsOneWidget,
        reason: 'the switcher stays',
      );
      expect(tester.widget<Text>(key('swarm-title')).data, 'Phone Swarm');
      expect(find.text('Projects'), findsNothing);
    });

    testWidgets('a computer coming back brings Home back', (tester) async {
      final computers = _Computers(const []);
      await pump(tester, backend(), computers: computers);
      expect(find.byType(SwarmStartView), findsOneWidget);

      computers.set(const [mac]);
      await tester.pumpAndSettle();

      expect(find.byType(SwarmStartView), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });

    testWidgets('with a computer and a Swarm, Home is as it was', (
      tester,
    ) async {
      await pump(tester, backend(), computers: _Computers(const [mac]));

      expect(find.byType(SwarmStartView), findsNothing);
      expect(key('swarm-project-$tab-$project'), findsOneWidget);
    });
  });
}
