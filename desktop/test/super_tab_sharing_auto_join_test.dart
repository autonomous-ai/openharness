import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/manage_page.dart';
import 'package:harness/super_tabs/sharing.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'swarm_sharing_test.dart' show SwarmSharingServer;
import 'swarm_state_test.dart' show createApp;

/// People at the owner's email domain join a Swarm by themselves
/// (docs/specs/2026-11-03-swarm-domain-auto-join.md, "Copy and screens").
class AutoJoinServer extends SwarmSharingServer {
  AutoJoinServer({
    this.ownDomain = 'acme.com',
    this.ownDomainPublic = false,
    this.autoJoinFull = false,
    this.turnedOffDomain,
  }) {
    final people = state['people'] as List;
    (people.first as Map)['email'] = 'ken@$ownDomain';
  }

  String ownDomain;
  bool ownDomainPublic, autoJoinFull;
  String? turnedOffDomain;

  @override
  Map<String, dynamic> get settings => {
    ...super.settings,
    'ownDomain': ownDomain,
    'ownDomainPublic': ownDomainPublic,
    'autoJoinFull': autoJoinFull,
    'turnedOffDomain': ?turnedOffDomain,
  };
}

const _help =
    'Anyone who signs in with an @acme.com email joins this Swarm. You can remove anyone.';
const _partner =
    'Automatic joins work only for @acme.com, your own domain. People at partner.com join with the link.';
const _public =
    'Not available for @gmail.com: anyone can make an address there. Invite people or share a link.';
const _full = 'Automatic joins stopped: this Swarm has 200 people.';
const _turnedOff =
    'Sharing with @gmail.com was turned off: anyone can make an address there.';
const _notBack =
    "You won't be added back automatically. Ask the owner to invite you if you want to return.";

Future<SuperTabController> _open(
  WidgetTester tester,
  SwarmSharingServer server, {
  String account = 'owner',
}) async {
  await tester.binding.setSurfaceSize(const Size(900, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final controller = server.controller(account: account);
  await controller.refresh();
  controller.select('offline');
  addTearDown(controller.dispose);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Builder(
          builder: (context) => TextButton(
            onPressed: () => showSuperTabSharing(context, controller),
            child: const Text('Share'),
          ),
        ),
      ),
    ),
  );
  await tester.tap(find.text('Share'));
  await tester.pumpAndSettle();
  return controller;
}

Future<void> _choose(WidgetTester tester, String key, String label) async {
  await tester.ensureVisible(find.byKey(Key(key)));
  await tester.tap(find.byKey(Key(key)));
  await tester.pumpAndSettle();
  await tester.tap(find.text(label).last);
  await tester.pumpAndSettle();
}

Finder get _autoJoin => find.byKey(const Key('swarm-sharing-auto-join'));

CheckboxListTile _toggle(WidgetTester tester) =>
    tester.widget<CheckboxListTile>(_autoJoin);

Color? _titleColor(WidgetTester tester) =>
    tester.widget<Text>(find.text('Add them automatically')).style?.color;

Future<void> _save(WidgetTester tester) async {
  await tester.tap(find.byKey(const Key('swarm-sharing-save')));
  await tester.pumpAndSettle();
}

void main() {
  group('Share dialog, owner ken@acme.com', () {
    testWidgets(
      'Everyone at @acme.com replaces a typed domain; turning auto-join on saves it',
      (tester) async {
        final server = AutoJoinServer();
        await _open(tester, server);
        await tester.tap(find.byKey(const Key('swarm-general-access')));
        await tester.pumpAndSettle();
        expect(find.text('Anyone at a domain'), findsNothing);
        expect(find.text('Other domain…'), findsOneWidget);
        await tester.tap(find.text('Everyone at @acme.com').last);
        await tester.pumpAndSettle();
        expect(find.byKey(const Key('swarm-sharing-domain')), findsNothing);
        expect(find.text('Add them automatically'), findsOneWidget);
        expect(find.text(_help), findsOneWidget);
        expect(find.text('Private projects stay private.'), findsOneWidget);
        // The owner turns it on by hand.
        expect(_toggle(tester).value, isFalse);
        expect(_toggle(tester).onChanged, isNotNull);
        expect(_titleColor(tester), isNot(DesktopChrome.muted));
        await tester.tap(_autoJoin);
        await tester.pumpAndSettle();
        expect(_toggle(tester).value, isTrue);
        await _save(tester);
        expect(server.sharingPosts.single['access'], {
          'mode': 'domain',
          'role': 'collaborator',
          'domain': 'acme.com',
          'autoJoin': true,
        });
        expect(find.text('Everyone at @acme.com'), findsOneWidget);
        expect(_toggle(tester).value, isTrue);
        expect(find.byKey(const Key('swarm-sharing-save')), findsNothing);
      },
    );

    testWidgets('a saved auto-join shows on; turning it off saves false', (
      tester,
    ) async {
      final server = AutoJoinServer()
        ..access = {
          'mode': 'domain',
          'role': 'viewer',
          'domain': 'acme.com',
          'autoJoin': true,
        };
      await _open(tester, server);
      expect(find.text('Everyone at @acme.com'), findsOneWidget);
      expect(_toggle(tester).value, isTrue);
      expect(find.byKey(const Key('swarm-sharing-save')), findsNothing);
      expect(find.text(_full), findsNothing);
      await tester.tap(_autoJoin);
      await tester.pumpAndSettle();
      await _save(tester);
      expect(server.sharingPosts.single['access'], {
        'mode': 'domain',
        'role': 'viewer',
        'domain': 'acme.com',
        'autoJoin': false,
      });
      expect(_toggle(tester).value, isFalse);
    });

    testWidgets(
      'Other domain… keeps the typed field and disables auto-join with the partner copy',
      (tester) async {
        final server = AutoJoinServer();
        await _open(tester, server);
        await _choose(tester, 'swarm-general-access', 'Other domain…');
        final field = find.byKey(const Key('swarm-sharing-domain'));
        expect(field, findsOneWidget);
        await tester.enterText(field, 'partner.com');
        await tester.pumpAndSettle();
        expect(_toggle(tester).onChanged, isNull);
        // Reads as unavailable, not only its box.
        expect(_titleColor(tester), DesktopChrome.muted);
        expect(_toggle(tester).value, isFalse);
        expect(find.text(_partner), findsOneWidget);
        expect(find.text(_help), findsNothing);
        await _save(tester);
        expect(server.sharingPosts.single['access'], {
          'mode': 'domain',
          'role': 'collaborator',
          'domain': 'partner.com',
          'autoJoin': false,
        });
        // The saved partner share opens as Other domain… again.
        expect(find.text('Other domain…'), findsOneWidget);
        expect(tester.widget<TextField>(field).controller!.text, 'partner.com');
      },
    );

    testWidgets('an owner at a public domain cannot pick Everyone at it', (
      tester,
    ) async {
      final server = AutoJoinServer(
        ownDomain: 'gmail.com',
        ownDomainPublic: true,
      );
      await _open(tester, server);
      expect(find.text(_public), findsOneWidget);
      expect(find.text('Everyone at @gmail.com'), findsOneWidget);
      await tester.tap(find.text('Everyone at @gmail.com'));
      await tester.pumpAndSettle();
      expect(find.byKey(const Key('swarm-sharing-save')), findsNothing);
      await tester.tap(find.byKey(const Key('swarm-general-access')));
      await tester.pumpAndSettle();
      // In the open menu only the shown, unavailable one: no row to pick.
      expect(find.text('Everyone at @gmail.com'), findsOneWidget);
      expect(find.text('Other domain…'), findsOneWidget);
      await tester.tap(find.text('Invited people').last);
      await tester.pumpAndSettle();
      expect(_autoJoin, findsNothing);
      expect(server.sharingPosts, isEmpty);
    });

    testWidgets('a full Swarm says automatic joins stopped', (tester) async {
      final server = AutoJoinServer(autoJoinFull: true)
        ..access = {
          'mode': 'domain',
          'role': 'collaborator',
          'domain': 'acme.com',
          'autoJoin': true,
        };
      await _open(tester, server);
      expect(find.text(_full), findsOneWidget);
    });

    testWidgets('a share at a public domain that was turned off says so', (
      tester,
    ) async {
      final server = AutoJoinServer(turnedOffDomain: 'gmail.com');
      await _open(tester, server);
      expect(find.text('Invited people'), findsOneWidget);
      expect(find.text(_turnedOff), findsOneWidget);
      await _choose(tester, 'swarm-general-access', 'Anyone with the link');
      expect(find.text(_turnedOff), findsNothing);
    });

    testWidgets('an older server keeps the typed domain and no toggle', (
      tester,
    ) async {
      final server = SwarmSharingServer();
      await _open(tester, server);
      await _choose(tester, 'swarm-general-access', 'Anyone at a domain');
      expect(find.byKey(const Key('swarm-sharing-domain')), findsOneWidget);
      expect(_autoJoin, findsNothing);
      await _save(tester);
      expect(
        (server.sharingPosts.single['access'] as Map).containsKey('autoJoin'),
        isFalse,
      );
    });
  });

  group('People list', () {
    testWidgets('a person who came by domain says Joined with @their domain', (
      tester,
    ) async {
      final server = AutoJoinServer();
      (server.state['people'] as List)
        ..add({
          'id': 'lan',
          'email': 'lan@acme.com',
          'role': 'collaborator',
          'joinedVia': 'domain',
        })
        ..add({'id': 'leo', 'email': 'leo@partner.com', 'role': 'viewer'});
      await _open(tester, server);
      await tester.tap(find.byKey(const Key('swarm-sharing-people')));
      await tester.pumpAndSettle();
      expect(find.text('Joined with @acme.com'), findsOneWidget);
      expect(find.textContaining('Joined with'), findsOneWidget);
    });
  });

  group('Leave dialogs', () {
    Future<void> leaveFromSharing(
      WidgetTester tester, {
      required bool on,
    }) async {
      final server = AutoJoinServer();
      if (on) server.state['autoJoin'] = true;
      (server.state['people'] as List).add({
        'id': 'lan',
        'email': 'lan@acme.com',
        'role': 'collaborator',
        'joinedVia': 'domain',
      });
      await _open(tester, server, account: 'lan');
      await tester.tap(find.widgetWithText(TextButton, 'Leave'));
      await tester.pumpAndSettle();
      expect(find.text('Leave Swarm?'), findsOneWidget);
    }

    testWidgets('Share dialog: leaving a Swarm with auto-join on warns', (
      tester,
    ) async {
      await leaveFromSharing(tester, on: true);
      expect(find.text(_notBack), findsOneWidget);
    });

    testWidgets('Share dialog: without auto-join, no warning', (tester) async {
      await leaveFromSharing(tester, on: false);
      expect(find.text(_notBack), findsNothing);
    });

    testWidgets('the owner removing someone sees no auto-join warning', (
      tester,
    ) async {
      final server = AutoJoinServer()..state['autoJoin'] = true;
      (server.state['people'] as List).add({
        'id': 'lan',
        'email': 'lan@acme.com',
        'role': 'collaborator',
      });
      await _open(tester, server);
      await tester.tap(find.byKey(const Key('swarm-sharing-people')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Remove'));
      await tester.pumpAndSettle();
      expect(find.text('Remove lan@acme.com?'), findsOneWidget);
      expect(find.text(_notBack), findsNothing);
    });

    Future<void> leaveFromManage(
      WidgetTester tester, {
      required bool on,
    }) async {
      final server = AutoJoinServer();
      if (on) server.state['autoJoin'] = true;
      (server.state['people'] as List).add({
        'id': 'member',
        'email': 'member@acme.com',
        'role': 'collaborator',
        'generation': 'g',
      });
      final c = server.controller(account: 'member');
      await c.refresh();
      final AppNotifier app = createApp();
      addTearDown(app.dispose);
      await tester.binding.setSurfaceSize(const Size(800, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabManagePage(
              controller: c,
              app: app,
              tab: SuperTabManageTab.swarm,
              onAddAgent: (_) {},
            ),
          ),
        ),
      );
      await tester.pump();
      addTearDown(() async {
        await tester.pumpWidget(const SizedBox());
        c.dispose();
      });
      await tester.tap(find.byKey(const ValueKey('super-manage-leave')));
      await tester.pumpAndSettle();
      expect(find.text('Leave Swarm?'), findsOneWidget);
    }

    testWidgets('Manage: leaving a Swarm with auto-join on warns', (
      tester,
    ) async {
      await leaveFromManage(tester, on: true);
      expect(find.text(_notBack), findsOneWidget);
    });

    testWidgets('Manage: without auto-join, no warning', (tester) async {
      await leaveFromManage(tester, on: false);
      expect(find.text(_notBack), findsNothing);
    });
  });
}
