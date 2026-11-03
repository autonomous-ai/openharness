import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/phone_shell_scope.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_invites_sheet.dart';
import 'package:harness_mobile/swarm/swarm_leaderboard.dart';
import 'package:harness_mobile/swarm/swarm_project_details.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_project_status.dart';
import 'package:harness_mobile/swarm/swarm_project_tabs.dart';
import 'package:harness_mobile/swarm/swarm_project_team.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// A project's details from a tap on its #name in its chat's header, as a
/// channel's name opens them in Slack (Tony, 2026-11-03): #name over who is
/// on it; Notifications, Invite for the Swarm's owner, Open terminal; then
/// Status, Work, Team and Leaderboard, each opening what the ⋮ menu's row
/// opens. Over one Swarm whose project Mobile has River, its PM, on mac-1.
void main() {
  const changesPath = '/api/super-tabs/$tab/changes';

  FakeSwarm backend({
    String role = 'owner',
    String owner = me,
    String leadOf = 'agent-lead',
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': owner},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) {
      final read = firstLoad(
        head: headData(ownerId: owner),
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          agent('agent-builder', displayName: 'Nova'),
        ],
      );
      (read['groups'] as List)[0] = part(
        leadChat,
        1,
        groupData(
          leadChat,
          title: 'Mobile',
          agentIds: [leadOf],
          leadId: leadOf,
        ),
      );
      return {
        ...read,
        'members': [part(me, 1, person(me, role: role))],
      };
    };
    fake.routes[changesPath] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] = (
      _,
    ) => {'messages': <Object>[], 'next': null};
    fake.routes['/api/super-tabs/$tab/leaderboard'] = (_) =>
        leaderboardData(people: [scoreData(me, points: 10, rank: 1)]);
    fake.routes['/api/super-tabs/$tab/invitations'] = (_) => {
      'invitations': <Object>[],
    };
    return fake;
  }

  late List<(String, String)> opened;
  late Set<String> opens;

  setUp(() {
    opened = [];
    opens = {'mac-1'};
  });

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    ValueNotifier<String?>? account,
    List<SwarmProjectTab> tabs = SwarmProjectTab.homeC,
  }) async {
    account ??= ValueNotifier<String?>(me);
    final computers = FakeComputers(const [])
      ..own = const [(id: 'mac-1', name: 'Tonys-MacBook-Pro', away: false)];
    addTearDown(computers.dispose);
    final host = SwarmHost(
      accountId: () => account!.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      computers: computers,
      readMarks: MemoryKeyValueStore(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => PhoneShellScope(
          onMachineLinked: (_) {},
          onOpenAgent: (machine, agent) => opened.add((machine, agent)),
          canOpenMachine: opens.contains,
          child: SwarmScope(notifier: host, child: child!),
        ),
        home: SwarmProjectPage(swarmId: tab, projectId: project, tabs: tabs),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));
  Finder detail(String name) => key('swarm-project-details-$name');
  bool detailsOpen() =>
      find.byType(SwarmProjectDetailsSheet).evaluate().isNotEmpty;

  Future<void> openDetails(WidgetTester tester) async {
    await tester.tap(key('swarm-title-button'));
    await tester.pumpAndSettle();
  }

  group('the header', () {
    testWidgets("the #name is one button, heard as the project's details, "
        'and a thumb tall', (tester) async {
      final semantics = tester.ensureSemantics();
      await pump(tester, backend());

      expect(
        find.descendant(
          of: key('swarm-title-button'),
          matching: find.text('#Mobile'),
        ),
        findsOneWidget,
      );
      expect(
        tester.getSemantics(key('swarm-title-button')),
        isSemantics(
          label: '#Mobile, project details',
          isButton: true,
          hasTapAction: true,
        ),
      );
      expect(
        tester.getSize(key('swarm-title-button')).height,
        greaterThanOrEqualTo(44),
      );
      semantics.dispose();
    });

    testWidgets('a tap opens the details; ⋮ is still there', (tester) async {
      await pump(tester, backend());
      expect(key('swarm-project-menu'), findsOneWidget);

      await openDetails(tester);

      expect(detailsOpen(), isTrue);
    });
  });

  group('what they hold', () {
    testWidgets('#name over who is on it; Notifications, Invite and Open '
        'terminal; then Status, Work, Team and Leaderboard, in that order', (
      tester,
    ) async {
      await pump(tester, backend());
      await openDetails(tester);

      expect(
        find.descendant(
          of: detail('title'),
          matching: find.text('#Mobile'),
          matchRoot: true,
        ),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byType(SwarmProjectDetailsSheet),
          matching: find.text('1 human · 2 agents'),
        ),
        findsNWidgets(2),
        reason: 'under the name, and at the end of Team',
      );
      final quick = [
        for (final name in ['notifications', 'invite', 'terminal'])
          tester.getTopLeft(detail(name)),
      ];
      expect(quick.map((o) => o.dy).toSet(), hasLength(1), reason: 'a row');
      expect(quick[0].dx, lessThan(quick[1].dx));
      expect(quick[1].dx, lessThan(quick[2].dx));
      final rows = [
        for (final name in ['status', 'work', 'team', 'leaderboard'])
          tester.getTopLeft(detail(name)).dy,
      ];
      expect(rows, [...rows]..sort());
      expect(rows.first, greaterThan(quick.first.dy));
    });

    testWidgets("Invite is the Swarm owner's alone", (tester) async {
      await pump(tester, backend(role: 'collaborator', owner: 'person-ken'));
      await openDetails(tester);

      expect(detail('invite'), findsNothing);
      expect(detail('notifications'), findsOneWidget);
      expect(detail('terminal'), findsOneWidget);
    });

    testWidgets('a viewer has no Open terminal', (tester) async {
      await pump(tester, backend(role: 'viewer', owner: 'person-ken'));
      await openDetails(tester);

      expect(detail('terminal'), findsNothing);
      expect(detail('status'), findsOneWidget);
    });
  });

  group('Open terminal', () {
    testWidgets("opens the PM's terminal at once, the details gone", (
      tester,
    ) async {
      await pump(tester, backend());
      await openDetails(tester);

      await tester.tap(detail('terminal'));
      await tester.pumpAndSettle();

      expect(opened, [('mac-1', 'harness-agent-lead')]);
      expect(detailsOpen(), isFalse);
    });

    testWidgets('no PM: greyed, why heard, and a tap does nothing', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      await pump(tester, backend(leadOf: 'agent-gone'));
      await openDetails(tester);

      expect(
        tester.getSemantics(detail('terminal')),
        isSemantics(
          label: 'Open terminal, Stopped',
          isButton: true,
          hasEnabledState: true,
          isEnabled: false,
        ),
      );
      await tester.tap(detail('terminal'));
      await tester.pumpAndSettle();

      expect(opened, isEmpty);
      expect(detailsOpen(), isTrue);
      semantics.dispose();
    });

    testWidgets(
      "its machine linked here but not answering: greyed, Offline, as the menu's",
      (tester) async {
        opens = {};
        final semantics = tester.ensureSemantics();
        await pump(tester, backend());
        await openDetails(tester);

        expect(
          tester.getSemantics(detail('terminal')).label,
          'Open terminal, Offline',
        );
        semantics.dispose();
      },
    );
  });

  group('each row opens its sheet once the details are gone', () {
    for (final (name, type) in [
      ('status', SwarmProjectStatusSheet),
      ('work', SwarmProjectSheet),
      ('team', SwarmProjectTeamSheet),
      ('leaderboard', SwarmLeaderboardPage),
      ('invite', SwarmInvitesSheet),
    ]) {
      testWidgets(name, (tester) async {
        await pump(tester, backend());
        await openDetails(tester);

        await tester.tap(detail(name));
        await tester.pumpAndSettle();

        expect(detailsOpen(), isFalse);
        expect(find.byType(type), findsOneWidget);
      });
    }

    testWidgets("notifications: the project chat's", (tester) async {
      await pump(tester, backend());
      await openDetails(tester);

      await tester.tap(detail('notifications'));
      await tester.pumpAndSettle();

      expect(detailsOpen(), isFalse);
      expect(find.text('All new messages'), findsOneWidget);
    });

    testWidgets('a sheet opened from the details closes with back, and the '
        'title opens the details again', (tester) async {
      await pump(tester, backend());
      await openDetails(tester);
      await tester.tap(detail('team'));
      await tester.pumpAndSettle();

      await tester.tapAt(const Offset(200, 40));
      await tester.pumpAndSettle();
      expect(find.byType(SwarmProjectTeamSheet), findsNothing);

      await openDetails(tester);
      expect(detailsOpen(), isTrue);
    });
  });

  group('lifecycle', () {
    testWidgets('access lost with the details open closes them', (
      tester,
    ) async {
      final host = await pump(tester, backend());
      await openDetails(tester);

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pumpAndSettle();

      expect(detailsOpen(), isFalse);
      expect(opened, isEmpty);
    });

    testWidgets('signing out with the details open closes them', (
      tester,
    ) async {
      final account = ValueNotifier<String?>(me);
      await pump(tester, backend(), account: account);
      await openDetails(tester);

      account.value = null;
      await tester.pumpAndSettle();

      expect(detailsOpen(), isFalse);
    });

    testWidgets('the project taken off the Swarm with them open closes them', (
      tester,
    ) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await openDetails(tester);

      fake.routes[changesPath] = (_) => {
        ...changes(cursor: 'c3', lastChangedAt: 200),
        'head': part('head', 2, headData(projects: [])),
      };
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(detailsOpen(), isFalse);
    });
  });
}
