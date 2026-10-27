import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/teams.dart';

import 'super_tab_sidebar_test.dart' show disposeSidebar, pumpSidebar;
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

// Teams above Swarms (docs/plans/2026-10-27-swarm-teams.md): the menu names the
// open Swarm's Team and lists the person's Teams with their Swarms; owners and
// admins manage the Team's people from it.

/// A Swarm server that also answers the Team routes, recording each call.
class TeamServer extends ConversationServer {
  TeamServer({this.role = 'member'}) {
    state['orgId'] = 'org-a';
  }
  String role;
  final calls = <String>[];
  final bodies = <Map<String, dynamic>?>[];
  SuperTabFailure? refuseJoin;
  List<Map<String, dynamic>> members = [
    {'userId': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    {'userId': 'boss', 'email': 'boss@example.com', 'role': 'admin'},
    {'userId': 'mate', 'email': 'mate@example.com', 'role': 'member'},
    {'userId': 'visitor', 'email': 'visitor@example.com', 'role': 'guest'},
  ];

  Map<String, dynamic> get teams => {
    'orgs': [
      {
        'id': 'org-a',
        'name': 'Device',
        'role': role,
        'revision': 0,
        'swarms': [
          {
            'id': 'tab',
            'name': 'Pilot',
            'orgVisibility': 'invite-only',
            'member': true,
          },
          {
            'id': 'firmware',
            'name': 'Firmware',
            'orgVisibility': 'invite-only',
            'member': true,
          },
          {
            'id': 'open-work',
            'name': 'Open work',
            'orgVisibility': 'org',
            'member': false,
          },
        ],
      },
      {
        'id': 'org-b',
        'name': 'Mobile',
        'role': 'guest',
        'revision': 0,
        'swarms': [
          {
            'id': 'phone',
            'name': 'Phone',
            'orgVisibility': 'invite-only',
            'member': true,
          },
        ],
      },
    ],
  };

  @override
  Future<Map<String, dynamic>> request(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final team =
        path.startsWith('/api/super-tabs/orgs') ||
        path.endsWith('/org-join') ||
        path.endsWith('/org-visibility');
    if (!team) return super.request(method, path, body: body);
    calls.add('$method $path');
    bodies.add(body);
    if (path == '/api/super-tabs/orgs') return teams;
    if (path == '/api/super-tabs/orgs/org-a/members') {
      return {'members': members, 'invitations': <dynamic>[]};
    }
    if (path.endsWith('/org-join')) {
      if (refuseJoin case final refusal?) throw refusal;
      return {
        'id': 'open-work',
        'role': 'collaborator',
        'alreadyMember': false,
      };
    }
    return <String, dynamic>{};
  }
}

Future<void> pumpMenu(
  WidgetTester tester,
  SuperTabController controller,
  void Function(String id, String name) onOpenSwarm, {
  Size size = const Size(320, 900),
}) async {
  await tester.binding.setSurfaceSize(size);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Align(
          alignment: Alignment.topLeft,
          child: SizedBox(
            width: 280,
            child: SuperTabTeamMenu(
              controller: controller,
              onOpenSwarm: onOpenSwarm,
            ),
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<SuperTabController> opened(
  TeamServer server, {
  String account = 'owner',
}) async {
  final controller = server.controller(account: account);
  await controller.refresh();
  return controller;
}

void main() {
  testWidgets(
    'names the open Swarm\'s Team and switches to a Swarm of any Team',
    (tester) async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = TeamServer();
      final controller = await opened(server);
      final opens = <(String, String)>[];
      await pumpMenu(tester, controller, (id, name) => opens.add((id, name)));

      expect(find.text('Device'), findsOneWidget);
      await tester.tap(find.byKey(const ValueKey('super-team-menu')));
      await tester.pumpAndSettle();
      for (final name in ['Mobile', 'Firmware', 'Phone', 'Open work']) {
        expect(find.text(name), findsOneWidget, reason: name);
      }
      // A member manages nothing, so there is no settings entry.
      expect(find.text('$kTeamLabel settings'), findsNothing);

      await tester.tap(find.byKey(const ValueKey('super-team-swarm-phone')));
      await tester.pumpAndSettle();
      expect(opens, [('phone', 'Phone')]);
      expect(server.calls.where((c) => c.startsWith('POST')), isEmpty);
    },
  );

  testWidgets(
    'joins a Swarm open to the Team before opening it, and says why when it cannot',
    (tester) async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = TeamServer();
      final controller = await opened(server);
      final opens = <String>[];
      await pumpMenu(tester, controller, (id, _) => opens.add(id));

      server.refuseJoin = const SuperTabFailure(
        'FORBIDDEN',
        'This Swarm is not open to its Team.',
        statusCode: 403,
      );
      await tester.tap(find.byKey(const ValueKey('super-team-menu')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('super-team-swarm-open-work')),
      );
      await tester.pumpAndSettle();
      expect(opens, isEmpty);
      expect(find.text('This Swarm is not open to its Team.'), findsOneWidget);

      server.refuseJoin = null;
      await tester.tap(find.byKey(const ValueKey('super-team-menu')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('super-team-swarm-open-work')),
      );
      await tester.pumpAndSettle();
      expect(server.calls.last, 'POST /api/super-tabs/open-work/org-join');
      expect(server.bodies.last!['operationId'], isA<String>());
      expect(opens, ['open-work']);
    },
  );

  testWidgets(
    'lets an admin invite, change and remove members and guests, and open this Swarm to the Team',
    (tester) async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = TeamServer(role: 'admin');
      final controller = await opened(server, account: 'boss');
      await pumpMenu(tester, controller, (_, _) {}, size: const Size(900, 900));
      await tester.tap(find.byKey(const ValueKey('super-team-menu')));
      await tester.pumpAndSettle();
      await tester.ensureVisible(
        find.byKey(const ValueKey('super-team-settings')),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-team-settings')));
      await tester.pumpAndSettle();

      for (final email in [
        'owner@example.com',
        'boss@example.com',
        'mate@example.com',
        'visitor@example.com',
      ]) {
        expect(find.text(email), findsOneWidget, reason: email);
      }
      // Neither the owner nor another admin (here, the admin themselves) can be changed by an admin.
      expect(find.byKey(const ValueKey('team-role-owner')), findsNothing);
      expect(find.byKey(const ValueKey('team-role-boss')), findsNothing);
      expect(find.byKey(const ValueKey('team-remove-owner')), findsNothing);

      await tester.enterText(
        find.byKey(const ValueKey('team-invite-email')),
        'new@example.com',
      );
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('team-invite-send')));
      await tester.pumpAndSettle();
      expect(
        server.calls,
        contains('POST /api/super-tabs/orgs/org-a/invitations'),
      );
      expect(
        server.bodies[server.calls.indexOf(
          'POST /api/super-tabs/orgs/org-a/invitations',
        )],
        {'email': 'new@example.com', 'role': 'member'},
      );

      await tester.tap(find.byKey(const ValueKey('team-role-visitor')));
      await tester.pumpAndSettle();
      await tester.tap(find.text('Member').last);
      await tester.pumpAndSettle();
      expect(
        server.calls,
        contains('POST /api/super-tabs/orgs/org-a/members/visitor'),
      );
      expect(
        server.bodies[server.calls.indexOf(
          'POST /api/super-tabs/orgs/org-a/members/visitor',
        )],
        {'role': 'member'},
      );

      // Removing takes the person out of every Swarm of the Team, so it asks once more.
      await tester.tap(find.byKey(const ValueKey('team-remove-mate')));
      await tester.pumpAndSettle();
      expect(
        server.calls,
        isNot(contains('POST /api/super-tabs/orgs/org-a/members/mate/remove')),
      );
      await tester.tap(find.byKey(const ValueKey('team-remove-confirm-mate')));
      await tester.pumpAndSettle();
      expect(
        server.calls,
        contains('POST /api/super-tabs/orgs/org-a/members/mate/remove'),
      );

      await tester.tap(find.byKey(const ValueKey('team-swarm-open')));
      await tester.pumpAndSettle();
      final open = server.calls.indexOf(
        'POST /api/super-tabs/tab/org-visibility',
      );
      expect(open, isNot(-1));
      expect(server.bodies[open], {'visibility': 'org'});
    },
  );

  testWidgets('the sidebar shows the Team menu only for a Swarm in a Team', (
    tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final server = TeamServer();
    final controller = await opened(server);
    await pumpSidebar(tester, controller, app);
    expect(find.byKey(const ValueKey('super-team-menu')), findsOneWidget);
    await disposeSidebar(tester, controller);

    final before = TeamServer()..state.remove('orgId');
    final legacy = await opened(before);
    await pumpSidebar(tester, legacy, app);
    expect(find.byKey(const ValueKey('super-team-menu')), findsNothing);
    expect(before.calls, isEmpty);
    await disposeSidebar(tester, legacy);
  });

  test('a machine row says when its Team account serves another Team', () {
    expect(
      superTabTeammatesPaused('MACHINE_IN_OTHER_TEAM'),
      "Teammates' agents paused: also serves another $kTeamLabel",
    );
  });
}
