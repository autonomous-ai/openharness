import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/real_fonts.dart';
import 'support/super_tab_fixture.dart';
import 'support/super_tab_members.dart';

/// Switch PM (spec 2026-11-02-pm-switch-engine-account-design.md, section 8):
/// who is offered it, what its dialog lists and what Confirm sends.
void main() {
  setUpAll(loadRealFonts);

  // sha256('m:claude:default') and sha256('m:codex:default'), first 16 hex.
  const claudeDefault = '71dc90339553114c', codexDefault = '07f54db4cdffbb30';
  ConversationServer swarm({Map<String, dynamic> pm = const {}}) {
    final server = ConversationServer();
    server.state['people'] = [
      {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
      {'id': 'mac', 'email': 'mac@example.com', 'role': 'collaborator'},
      {'id': 'member', 'email': 'member@example.com', 'role': 'member'},
    ];
    server.state['machines'] = [
      {
        'machineId': 'm',
        'name': 'Team Mac',
        'contributorId': 'mac',
        'engines': ['claude', 'codex'],
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'capabilities': ['leadStart', 'leadSwitch'],
          'profiles': [
            {
              'engine': 'claude',
              'id': claudeDefault,
              'label': 'Default',
              'leftPercent': 40,
              'resetsAt': null,
            },
            {
              'engine': 'claude',
              'id': 'aaaaaaaaaaaaaaaa',
              'label': 'Work',
              'leftPercent': 0,
              'resetsAt': '2099-01-02T15:00:00.000Z',
            },
            {
              'engine': 'codex',
              'id': codexDefault,
              'label': 'Default',
              'leftPercent': 90,
              'resetsAt': null,
            },
            {
              'engine': 'codex',
              'id': 'bbbbbbbbbbbbbbbb',
              'label': 'Side',
              'leftPercent': 70,
              'resetsAt': null,
            },
          ],
        },
      },
    ];
    server.state['agents'] = [
      {
        'id': 'pm',
        'name': 'Lead',
        'displayName': 'Wren',
        'machineId': 'm',
        'harnessId': 'pm',
        'contributorId': 'mac',
        'machineOwnerId': 'mac',
        'configuration': {'engine': 'claude'},
        ...pm,
      },
    ];
    ((server.state['conversations'] as List)[0] as Map)['leadId'] = 'pm';
    return server;
  }

  Future<SuperTabController> mount(
    WidgetTester tester,
    ConversationServer server,
    String account,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1400, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final c = server.controller(account: account);
    await c.refresh();
    addTearDown(c.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            onNewProject: () {},
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> openMenu(WidgetTester tester) async {
    await tester.tap(find.byTooltip('Project options'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(AppMenuItem, 'Project settings…'));
    await tester.pumpAndSettle();
  }

  final item = find.text('Switch PM…');

  // Task #3194: Project settings shows each row's value.
  testWidgets('Switch PM… shows the PM\'s name', (tester) async {
    await mount(tester, swarm(), 'owner');
    await openMenu(tester);
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('super-project-setting-Switch PM…')),
        matching: find.text('Wren'),
      ),
      findsOneWidget,
    );
  });

  // Screenshots for the pull request, written only when asked: rasterized
  // text differs between machines, so they are not compared here.
  final renderDir = Platform.environment['SWITCH_PM_RENDER_DIR'];
  Future<void> capture(WidgetTester tester, String name) async {
    if (renderDir == null) return;
    await expectLater(
      find.byType(AlertDialog),
      matchesGoldenFile(Uri.file('$renderDir/$name.png')),
    );
  }

  Future<void> finish(WidgetTester tester) async {
    await tester.pump(const Duration(milliseconds: 250));
    await tester.pumpWidget(const SizedBox());
  }

  testWidgets(
    'the project owner and the PM machine\'s owner see Switch PM…; a member does not',
    (tester) async {
      for (final (account, shown) in [
        ('owner', true),
        ('mac', true),
        ('member', false),
      ]) {
        await mount(tester, swarm(), account);
        await openMenu(tester);
        expect(item, shown ? findsOneWidget : findsNothing, reason: account);
        await finish(tester);
      }
    },
  );

  testWidgets('the menu item is gone while the PM is switching', (
    tester,
  ) async {
    final server = swarm(
      pm: {
        'switchRequest': {
          'id': 'r',
          'engine': 'codex',
          'profileId': 'bbbbbbbbbbbbbbbb',
          'requestedBy': 'owner',
          'at': 1,
        },
      },
    );
    await mount(tester, server, 'owner');
    await openMenu(tester);
    expect(item, findsNothing);
    await finish(tester);
  });

  testWidgets(
    'the dialog lists the PM machine\'s profiles with % left, marks the current one and disables 0%',
    (tester) async {
      await mount(tester, swarm(), 'owner');
      await openMenu(tester);
      await tester.tap(item);
      await tester.pumpAndSettle();
      expect(find.text('Claude Code · Default'), findsOneWidget);
      expect(find.text('Current · 40% left'), findsOneWidget);
      expect(find.text('Claude Code · Work'), findsOneWidget);
      expect(find.textContaining('0% left · resets '), findsOneWidget);
      expect(find.text('Codex · Side'), findsOneWidget);
      expect(find.text('Codex · Default'), findsOneWidget);
      expect(find.text('70% left'), findsOneWidget);
      expect(
        find.text(
          'The new session starts fresh and reads a handoff note. Tasks and chat stay.',
        ),
        findsOneWidget,
      );
      ListTile row(String key) =>
          tester.widget<ListTile>(find.byKey(ValueKey(key)));
      expect(row('switch-pm-claude-$claudeDefault').enabled, isFalse);
      expect(row('switch-pm-claude-aaaaaaaaaaaaaaaa').enabled, isFalse);
      expect(row('switch-pm-codex-bbbbbbbbbbbbbbbb').enabled, isTrue);
      await tester.tap(find.text('Cancel'));
      await finish(tester);
    },
  );

  testWidgets(
    'the dialog says only offered accounts are listed on a machine the reader does not own',
    (tester) async {
      const line = 'Only accounts its owner offered are listed.';
      for (final (account, shown) in [('owner', true), ('mac', false)]) {
        await mount(tester, swarm(), account);
        await openMenu(tester);
        await tester.tap(item);
        await tester.pumpAndSettle();
        expect(find.text(line), shown ? findsOneWidget : findsNothing);
        await tester.tap(find.text('Cancel'));
        await finish(tester);
      }
    },
  );

  testWidgets(
    'a machine that reports no profiles offers each engine\'s default',
    (tester) async {
      final server = swarm();
      ((server.state['machines'] as List).first as Map).remove('observation');
      await mount(tester, server, 'owner');
      await openMenu(tester);
      await tester.tap(item);
      await tester.pumpAndSettle();
      expect(find.text('Codex · Default'), findsOneWidget);
      expect(find.text('Current'), findsOneWidget);
      expect(
        tester
            .widget<ListTile>(
              find.byKey(const ValueKey('switch-pm-codex-default')),
            )
            .enabled,
        isTrue,
      );
      await tester.tap(find.text('Cancel'));
      await finish(tester);
    },
  );

  testWidgets('confirm sends lead.switch with engine and profileId', (
    tester,
  ) async {
    final server = swarm();
    await mount(tester, server, 'owner');
    await openMenu(tester);
    await tester.tap(item);
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Switch'))
          .onPressed,
      isNull,
    );
    await tester.tap(find.text('Codex · Side'));
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Switch'));
    await tester.pumpAndSettle();
    final sent = [
      for (final post in server.posts)
        if ((post['command'] as Map?)?['type'] == 'lead.switch')
          post['command'] as Map,
    ];
    expect(sent, hasLength(1));
    expect(sent.single['projectId'], 'lead');
    expect(sent.single['engine'], 'codex');
    expect(sent.single['profileId'], 'bbbbbbbbbbbbbbbb');
    expect(find.byType(AlertDialog), findsNothing);
    await finish(tester);
  });

  testWidgets('the dialog switches machine, account and model together', (
    tester,
  ) async {
    final server = swarm();
    server.state['machines'] = [
      ...(server.state['machines'] as List),
      {
        'machineId': 'target',
        'name': 'Mac Two',
        'contributorId': 'mac',
        'teamWork': {'allowed': true},
        'engines': ['claude', 'codex'],
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'capabilities': ['leadStart', 'leadSwitch'],
          'profiles': [
            {
              'engine': 'codex',
              'id': 'cccccccccccccccc',
              'label': 'Default',
              'leftPercent': 80,
              'resetsAt': null,
            },
          ],
        },
      },
    ];
    server.routingPolicy = {
      'catalog': {
        'models': [
          {'engine': 'codex', 'model': 'gpt-6.1-sol', 'offered': true},
          {'engine': 'claude', 'model': 'sonnet', 'offered': true},
        ],
      },
    };
    await mount(tester, server, 'owner');
    await openMenu(tester);
    await tester.tap(item);
    await tester.pumpAndSettle();
    expect(find.text('Machine'), findsOneWidget);
    await capture(tester, 'switch-pm-machine-model');
    await tester.tap(find.byKey(const ValueKey('switch-pm-machine')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Mac Two').last);
    await tester.pumpAndSettle();
    expect(find.text('Codex · Default'), findsOneWidget);
    await tester.tap(find.text('Codex · Default'));
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('switch-pm-model')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('gpt-6.1-sol').last);
    await tester.pumpAndSettle();
    await tester.tap(find.widgetWithText(FilledButton, 'Switch'));
    await tester.pumpAndSettle();
    final sent = [
      for (final post in server.posts)
        if ((post['command'] as Map?)?['type'] == 'lead.switch')
          post['command'] as Map,
    ];
    expect(sent.single['machineId'], 'target');
    expect(sent.single['engine'], 'codex');
    expect(sent.single['profileId'], 'cccccccccccccccc');
    expect(sent.single['model'], 'gpt-6.1-sol');
    await finish(tester);
  });

  testWidgets('the dialog explains when no destination can change', (
    tester,
  ) async {
    final server = swarm();
    final currentPool = (server.state['machines'] as List).first as Map;
    currentPool['engines'] = ['claude'];
    currentPool['observation'] = {
      'receivedAt': DateTime.now().millisecondsSinceEpoch,
      'capabilities': ['leadStart', 'leadSwitch'],
      'profiles': [],
    };
    await mount(tester, server, 'owner');
    await openMenu(tester);
    await tester.tap(item);
    await tester.pumpAndSettle();
    expect(
      find.text(
        'No other machine or account can run a Product Manager right now.',
      ),
      findsOneWidget,
    );
    expect(find.byKey(const ValueKey('switch-pm-machine')), findsOneWidget);
    await capture(tester, 'switch-pm-no-choice');
    await tester.tap(find.text('Cancel'));
    await finish(tester);
  });

  testWidgets('an outdated machine stays listed with its reason and disabled', (
    tester,
  ) async {
    final server = swarm();
    server.state['machines'] = [
      ...(server.state['machines'] as List),
      {
        'machineId': 'old',
        'name': 'Old Mac',
        'contributorId': 'owner',
        'engines': ['claude'],
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'capabilities': ['leadStart'],
          'profiles': [],
        },
      },
    ];
    await mount(tester, server, 'owner');
    await openMenu(tester);
    await tester.tap(item);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('switch-pm-machine')));
    await tester.pumpAndSettle();
    final reason = find.textContaining('Update Harness on Old Mac');
    expect(reason, findsOneWidget);
    final old = tester.widget<AppMenuItem>(
      find.ancestor(of: reason, matching: find.byType(AppMenuItem)),
    );
    expect(old.onPressed, isNull);
    await finish(tester);
  });

  // Security reviews of #2705: the PM machine's owner switches its engine or
  // account there, and only the project's owner moves it to another machine.
  testWidgets(
    'the PM machine\'s owner sees other machines disabled with the reason',
    (tester) async {
      final server = swarm();
      server.state['machines'] = [
        ...(server.state['machines'] as List),
        {
          'machineId': 'target',
          'name': 'Mac Two',
          'contributorId': 'mac',
          'engines': ['codex'],
          'observation': {
            'receivedAt': DateTime.now().millisecondsSinceEpoch,
            'capabilities': ['leadStart', 'leadSwitch'],
            'profiles': [],
          },
        },
      ];
      await mount(tester, server, 'mac');
      await openMenu(tester);
      await tester.tap(item);
      await tester.pumpAndSettle();
      // Its own machine's accounts stay open to it.
      expect(
        tester
            .widget<ListTile>(
              find.byKey(const ValueKey('switch-pm-codex-bbbbbbbbbbbbbbbb')),
            )
            .enabled,
        isTrue,
      );
      await tester.tap(find.byKey(const ValueKey('switch-pm-machine')));
      await tester.pumpAndSettle();
      final reason = find.textContaining(
        'Only the project’s owner moves its PM to another machine.',
      );
      expect(reason, findsOneWidget);
      final other = tester.widget<AppMenuItem>(
        find.ancestor(of: reason, matching: find.byType(AppMenuItem)),
      );
      expect(other.onPressed, isNull);
      await finish(tester);
    },
  );

  testWidgets('a destination that goes stale cannot be submitted', (
    tester,
  ) async {
    final server = swarm();
    server.state['machines'] = [
      ...(server.state['machines'] as List),
      {
        'machineId': 'target',
        'name': 'Mac Two',
        'contributorId': 'owner',
        'engines': ['codex'],
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'capabilities': ['leadStart', 'leadSwitch'],
          'profiles': [
            {
              'engine': 'codex',
              'id': 'cccccccccccccccc',
              'label': 'Default',
              'leftPercent': 80,
              'resetsAt': null,
            },
          ],
        },
      },
    ];
    final c = await mount(tester, server, 'owner');
    await openMenu(tester);
    await tester.tap(item);
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('switch-pm-machine')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('Mac Two').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Codex · Default'));
    await tester.pumpAndSettle();
    final target = (server.state['machines'] as List).last as Map;
    (target['observation'] as Map)['capabilities'] = ['leadStart'];
    await c.refresh();
    await tester.pumpAndSettle();
    expect(
      tester
          .widget<FilledButton>(find.widgetWithText(FilledButton, 'Switch'))
          .onPressed,
      isNull,
    );
    expect(
      server.posts.where(
        (post) => (post['command'] as Map?)?['type'] == 'lead.switch',
      ),
      isEmpty,
    );
    await tester.tap(find.text('Cancel'));
    await finish(tester);
  });

  testWidgets(
    'the PM\'s own profileId marks its row; no id means its engine\'s default',
    (tester) async {
      await mount(
        tester,
        swarm(pm: {'profileId': 'aaaaaaaaaaaaaaaa'}),
        'owner',
      );
      await openMenu(tester);
      await tester.tap(item);
      await tester.pumpAndSettle();
      ListTile row(String key) =>
          tester.widget<ListTile>(find.byKey(ValueKey(key)));
      expect(row('switch-pm-claude-$claudeDefault').enabled, isTrue);
      expect(
        (row('switch-pm-claude-aaaaaaaaaaaaaaaa').subtitle as Text).data,
        startsWith('Current'),
      );
      await tester.tap(find.text('Cancel'));
      await finish(tester);
    },
  );

  testWidgets('a lent machine\'s borrower does not see Switch PM…', (
    tester,
  ) async {
    final server = swarm(pm: {'machineOwnerId': 'ken'});
    await mount(tester, server, 'mac');
    await openMenu(tester);
    expect(item, findsNothing);
    await finish(tester);
  });

  testWidgets('the PM row shows Switching… while switchRequest is set', (
    tester,
  ) async {
    final server = swarm(
      pm: {
        'switchRequest': {
          'id': 'r',
          'engine': 'codex',
          'profileId': 'bbbbbbbbbbbbbbbb',
          'requestedBy': 'owner',
          'at': 1,
        },
      },
    );
    await mount(tester, server, 'owner');
    await openSuperTabMembers(tester);
    // The row's state word (Quiet Swarm).
    expect(find.text('switching…'), findsWidgets);
    await finish(tester);
  });
}
