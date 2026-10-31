import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/widgets/harness_activity_mark.dart';
import 'package:harness/super_tabs/buddies.dart' show kBuddyEngineRefusals;
import 'package:harness/super_tabs/buddy_machines.dart' show kBuddyNoMachine;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/pm_chat_fixture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Buddies (Ken's spec, 10-28): a person's private agent per project. Since
/// 10-29 they are on in every Swarm and replace Chat with PM: each person's
/// Buddy chat is where the PM's private lines to them land.
void main() {
  List<Map<String, dynamic>> commands(ConversationServer server, String type) =>
      [
        for (final post in server.posts)
          if ((post['command'] as Map)['type'] == type)
            Map<String, dynamic>.from(post['command'] as Map),
      ];

  group('the controller', () {
    test("the reader's Buddy chat and Buddy are theirs, whatever an older server says of Buddies", () async {
      final server = buddySwarm(enabled: false);
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(c.buddyChat('lead')?.id, 'buddy-peer-lead');
      expect(c.buddy('lead')?.id, 'wren');
    });

    test("another person's Buddy is not the reader's", () async {
      final server = buddySwarm();
      giveBuddy(server, person: 'owner', id: 'moss', name: 'Moss');
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(c.buddy('lead'), isNull);
      expect(c.buddyChat('lead'), isNull);
    });

    test(
      'adding a Buddy sends the project, machine and engine and opens its chat',
      () async {
        final server = buddySwarm();
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();

        expect(
          await c.addBuddy(
            projectId: 'lead',
            machineId: 'ken-mac',
            engine: 'claude',
          ),
          isTrue,
        );

        expect(commands(server, 'buddy.create'), [
          {
            'type': 'buddy.create',
            'projectId': 'lead',
            'machineId': 'ken-mac',
            'engine': 'claude',
          },
        ]);
        expect(c.buddy('lead'), isNotNull);
        expect(c.selectedId, 'buddy-peer-lead');
      },
    );

    test('a Codex Buddy is refused, as the backend does for now', () async {
      final server = buddySwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(
        await c.addBuddy(
          projectId: 'lead',
          machineId: 'ken-mac',
          engine: 'codex',
        ),
        isFalse,
      );
      expect(c.operationError, kBuddyEngineRefusals['codex']);
      expect(c.buddy('lead'), isNull);
    });

    test('a refused add says why and opens nothing', () async {
      final server = buddySwarm();
      server.refuse = {
        'code': 'BUDDY_EXISTS',
        'message': 'You already have a Buddy in this project.',
      };
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      final before = c.selectedId;

      expect(
        await c.addBuddy(
          projectId: 'lead',
          machineId: 'ken-mac',
          engine: 'claude',
        ),
        isFalse,
      );
      expect(c.operationError, 'You already have a Buddy in this project.');
      expect(c.selectedId, before);
    });

    test('adding a second Buddy while one runs in the project is refused, as the backend does', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(
        await c.addBuddy(
          projectId: 'lead',
          machineId: 'studio',
          engine: 'claude',
        ),
        isFalse,
      );
      expect(c.operationError, 'You already have a Buddy in this project.');
      expect(c.buddy('lead')?.id, 'wren');
    });

    test('removing a Buddy sends its project and keeps its chat', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(await c.removeBuddy('lead'), isTrue);

      expect(commands(server, 'buddy.remove'), [
        {'type': 'buddy.remove', 'projectId': 'lead'},
      ]);
      expect(c.buddy('lead'), isNull);
      expect(c.buddyChat('lead'), isNotNull);
    });

    test(
      'renaming the Buddy sends its chat and the name, and the Swarm shows it',
      () async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();

        expect(await c.renameBuddy('lead', '  Sparky '), isTrue);

        expect(commands(server, 'buddy.rename'), [
          {
            'type': 'buddy.rename',
            'conversationId': 'buddy-peer-lead',
            'name': 'Sparky',
          },
        ]);
        expect(c.snapshot!.agentName('wren'), 'Sparky');
        expect(c.buddyChat('lead')?.buddyName, 'Sparky');
      },
    );

    test('clearing the name sends none, for the default', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.renameBuddy('lead', 'Sparky');

      expect(await c.renameBuddy('lead', '   '), isTrue);

      expect(commands(server, 'buddy.rename').last['name'], isNull);
      expect(c.snapshot!.agentName('wren'), "ken.tran's Buddy");
      expect(c.buddyChat('lead')?.buddyName, isNull);
    });

    test('a refused rename says why and keeps the name', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      server.refuse = {
        'code': 'BUDDY_NAME_TAKEN',
        'message': 'Lead is taken in this Swarm. Choose another.',
      };

      expect(await c.renameBuddy('lead', 'Lead'), isFalse);

      expect(c.operationError, 'Lead is taken in this Swarm. Choose another.');
      expect(c.snapshot!.agentName('wren'), 'Wren');
    });

    test('the shortcut opens the Buddy chat and never creates a private conversation', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(await c.openCurrentBuddyChat(), isTrue);

      expect(c.selectedId, 'buddy-peer-lead');
      expect(commands(server, 'conversation.create'), isEmpty);
    });

    test('with no Buddy chat yet, the shortcut opens one on the server, with no Buddy in it', () async {
      final server = buddySwarm();
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(await c.openCurrentBuddyChat(), isTrue);

      expect(commands(server, 'buddy.chat'), [
        {'type': 'buddy.chat', 'projectId': 'lead'},
      ]);
      expect(c.selectedId, 'buddy-peer-lead');
      expect(c.buddy('lead'), isNull);
      expect(commands(server, 'conversation.create'), isEmpty);
      expect(commands(server, 'buddy.create'), isEmpty);
    });

    /// Ken's Chat with PM from before Buddies replaced it, with an unread PM
    /// reply, as a server from before 10-29 still sends it.
    Future<(ConversationServer, SuperTabController, String)> oldPmChat() async {
      final server = buddySwarm(enabled: false);
      (server.state['conversations'] as List).add({
        ...conversationFixture('old-pm-chat', 'ken.tran'),
        'projectId': 'lead',
        'leadId': 'lead-agent',
        'agentIds': ['lead-agent'],
        'audience': {
          'people': [
            {'id': 'peer', 'generation': 'fixture'},
          ],
        },
      });
      pmReply(server, 'old-pm-chat', 'Earlier answer from the PM');
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      return (server, c, 'old-pm-chat');
    }

    test(
      'an old Chat with PM opened by id opens the project chat instead',
      () async {
        final (_, c, id) = await oldPmChat();

        expect(await c.select(id), isTrue);

        expect(c.selectedId, 'lead');
      },
    );

    test('an old Chat with PM counts nothing on the Swarm tab', () async {
      final (_, c, _) = await oldPmChat();
      expect(c.buddyUnread, 0);
    });

    test(
      "the PM's unread lines in the reader's Buddy chat count on the Swarm tab",
      () async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();
        await c.select('lead');
        pmReply(server, 'buddy-peer-lead', 'Your fix is merged.');
        pmReply(server, 'buddy-peer-lead', 'And released.');
        await c.refresh();

        expect(c.buddyUnread, 2);
      },
    );
  });

  group('the sidebar', () {
    Future<SuperTabController> show(
      WidgetTester tester,
      ConversationServer server, {
      String account = 'peer',
      Brightness brightness = Brightness.light,
      AppNotifier? app,
    }) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final c = server.controller(account: account);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              app: app,
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Team Mac',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return c;
    }

    Future<void> close(WidgetTester tester, SuperTabController c) async {
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }

    final pmEntry = find.byKey(const ValueKey('super-pm-chat-lead'));
    final buddyEntry = find.byKey(const ValueKey('super-buddy-lead'));
    final addBuddy = find.byTooltip('Add a Buddy');

    testWidgets(
      'a Buddies section with + and a row for each project from the start, and no Chat with PM, whatever the server says of Buddies',
      (tester) async {
        for (final enabled in [true, false]) {
          final c = await show(tester, buddySwarm(enabled: enabled));
          expect(find.text('Buddies'), findsOneWidget);
          expect(addBuddy, findsOneWidget);
          expect(find.text('Direct messages'), findsNothing);
          expect(pmEntry, findsNothing);
          expect(
            find.descendant(of: buddyEntry, matching: find.text('Buddy')),
            findsOneWidget,
          );
          expect(
            find.descendant(of: buddyEntry, matching: find.text('not started')),
            findsOneWidget,
          );
          await close(tester, c);
        }
      },
    );

    testWidgets('a row with new lines shows its name in bold, with no count', (
      tester,
    ) async {
      final server = buddySwarm();
      giveBuddy(server);
      pmReply(server, 'buddy-peer-lead', 'Your fix is merged.');
      pmReply(server, 'buddy-peer-lead', 'And released.');
      final c = await show(tester, server);
      // Bold as an unread project row is (design system: Unread).
      final name = tester.widget<Text>(
        find.descendant(of: buddyEntry, matching: find.text('Wren')),
      );
      expect(name.style?.fontWeight, grid.AppFont.semibold);
      expect(
        find.descendant(of: buddyEntry, matching: find.text('2')),
        findsNothing,
      );
      await close(tester, c);
    });

    testWidgets(
      'the reader\'s Buddy is listed by name, without its project while it is their only one',
      (tester) async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = await show(tester, server);
        expect(
          find.descendant(of: buddyEntry, matching: find.text('Wren')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: buddyEntry, matching: find.text('(Pilot)')),
          findsNothing,
        );

        await tester.tap(buddyEntry);
        await tester.pumpAndSettle();
        expect(c.selectedId, 'buddy-peer-lead');
        // The chat is its own row, never listed among the workgroups.
        expect(
          find.byKey(const ValueKey('super-group-buddy-peer-lead')),
          findsNothing,
        );
        await close(tester, c);
      },
    );

    testWidgets(
      'the reader\'s Buddy row says where it runs; other people\'s Buddies appear nowhere',
      (tester) async {
        final server = buddySwarm();
        giveBuddy(server);
        giveBuddy(
          server,
          person: 'owner',
          id: 'moss',
          name: 'Moss',
          machineId: 'studio',
          machineOwnerId: 'owner',
        );
        final c = await show(tester, server);
        expect(
          find.descendant(
            of: buddyEntry,
            matching: find.text('Pilot · Claude on Kens-MacBook'),
          ),
          findsOneWidget,
        );
        expect(find.text('Moss'), findsNothing);
        expect(find.textContaining('Claude on Studio'), findsNothing);
        await close(tester, c);
      },
    );

    testWidgets(
      'the reader\'s Buddy row marks what it is doing, and offline once it is down',
      (tester) async {
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final server = buddySwarm();
        giveBuddy(server, machineId: 'm');
        app.stateOf('m')!
          ..agents = [
            const Agent(
              id: 'h-wren',
              name: 'Wren',
              engine: 'claude',
              terminalAvailable: true,
            ),
          ]
          ..processingAgentIds.add('h-wren');
        final c = await show(tester, server, app: app);
        HarnessActivity mark() => tester
            .widget<ActivityMark>(
              find.descendant(
                of: buddyEntry,
                matching: find.byType(ActivityMark),
              ),
            )
            .activity;
        expect(mark(), HarnessActivity.working);

        ((server.state['agents'] as List).last as Map)['downSince'] =
            '2026-10-28T09:00:00Z';
        await c.refresh();
        await tester.pumpAndSettle();
        expect(mark(), HarnessActivity.offline);
        expect(
          find.descendant(of: buddyEntry, matching: find.text('offline')),
          findsOneWidget,
        );
        await close(tester, c);
      },
    );

    testWidgets('with two Buddies, each row names its project', (tester) async {
      final server = buddySwarm();
      server.state['projects'] = [
        projectFixture('lead', 'openharness', 'lead'),
        projectFixture('web', 'web-2', 'web-lead'),
      ];
      (server.state['conversations'] as List).add({
        ...conversationFixture('web-lead', 'Lead'),
        'projectId': 'web',
      });
      giveBuddy(server);
      giveBuddy(server, projectId: 'web', id: 'moss', name: 'Moss');
      final c = await show(tester, server);

      expect(
        find.descendant(of: buddyEntry, matching: find.text('(openharness)')),
        findsOneWidget,
      );
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('super-buddy-web')),
          matching: find.text('(web-2)'),
        ),
        findsOneWidget,
      );
      await close(tester, c);
    });

    testWidgets(
      'a removed Buddy keeps its chat, plainly named, and can be started again',
      (tester) async {
        final server = buddySwarm();
        giveBuddy(server);
        (server.state['agents'] as List).removeWhere(
          (a) => (a as Map)['id'] == 'wren',
        );
        final c = await show(tester, server);
        expect(
          find.descendant(of: buddyEntry, matching: find.text('Buddy')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: buddyEntry, matching: find.text('not started')),
          findsOneWidget,
        );
        await tester.tap(buddyEntry);
        await tester.pumpAndSettle();
        expect(find.text('Your Buddy'), findsOneWidget);
        expect(find.textContaining("peer's Buddy"), findsNothing);
        await close(tester, c);
      },
    );

    testWidgets(
      'a removed Buddy with a chosen name keeps it in the sidebar and its chat\'s header',
      (tester) async {
        final server = buddySwarm();
        giveBuddy(server);
        (server.state['agents'] as List).removeWhere(
          (a) => (a as Map)['id'] == 'wren',
        );
        final chat = (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((g) => g['id'] == 'buddy-peer-lead');
        chat
          ..['buddyName'] = 'Sparky'
          ..['title'] = 'Sparky';
        final c = await show(tester, server);
        expect(
          find.descendant(of: buddyEntry, matching: find.text('Sparky')),
          findsOneWidget,
        );
        expect(
          find.descendant(of: buddyEntry, matching: find.text('Buddy')),
          findsNothing,
        );
        await tester.tap(buddyEntry);
        await tester.pumpAndSettle();

        expect(find.text('Sparky · Your Buddy'), findsOneWidget);
        expect(find.text('Message Sparky'), findsOneWidget);
        await close(tester, c);
      },
    );

    testWidgets('a Buddy whose session is down says offline', (tester) async {
      final server = buddySwarm();
      giveBuddy(server);
      ((server.state['agents'] as List).last as Map)['downSince'] =
          '2026-10-28T09:00:00Z';
      final c = await show(tester, server);
      expect(
        find.descendant(of: buddyEntry, matching: find.text('offline')),
        findsOneWidget,
      );
      await close(tester, c);
    });

    testWidgets(
      'the shortcut with no Buddy in the project opens its chat, which offers to start one',
      (tester) async {
        final server = buddySwarm();
        final c = await show(tester, server);
        expect(await c.buddyChatOpener!('lead'), isTrue);
        await tester.pumpAndSettle();
        expect(c.selectedId, 'buddy-peer-lead');
        expect(
          find.text('Start your Buddy to brainstorm here'),
          findsOneWidget,
        );
        expect(find.text('Add a Buddy'), findsNothing);
        expect(commands(server, 'conversation.create'), isEmpty);
        await close(tester, c);
      },
    );

    group('Add a Buddy', () {
      final machine = find.byKey(const ValueKey('super-buddy-machine'));
      final submit = find.widgetWithText(FilledButton, 'Add Buddy');

      Future<void> open(WidgetTester tester) async {
        await tester.tap(addBuddy);
        await tester.pumpAndSettle();
        expect(find.text('Add a Buddy'), findsWidgets);
      }

      testWidgets(
        'starts on the reader\'s own machine and Claude, and adds it',
        (tester) async {
          final server = buddySwarm();
          final c = await show(tester, server);
          await open(tester);
          expect(
            find.descendant(of: machine, matching: find.text('Kens-MacBook')),
            findsOneWidget,
          );
          expect(
            find.textContaining(
              'posts to the Product Manager only when you ask.',
            ),
            findsOneWidget,
          );

          await tester.tap(submit);
          await tester.pumpAndSettle();

          expect(commands(server, 'buddy.create'), [
            {
              'type': 'buddy.create',
              'projectId': 'lead',
              'machineId': 'ken-mac',
              'engine': 'claude',
            },
          ]);
          expect(find.text('Add a Buddy'), findsNothing);
          expect(c.selectedId, 'buddy-peer-lead');
          await close(tester, c);
        },
      );

      testWidgets(
        'lists only the reader\'s own machines: not teammates\', not a Team account (Ken, 10-28)',
        (tester) async {
          final server = buddySwarm();
          (server.state['machines'] as List).addAll([
            {
              'machineId': 'ken-mini',
              'name': 'Kens-Mini.local',
              'contributorId': 'peer',
              'scope': 'swarm',
              'observation': {
                'receivedAt': DateTime.now().millisecondsSinceEpoch,
              },
            },
            {
              'machineId': 'ken-team',
              'name': 'Kens-MacBook.local',
              'contributorId': 'peer',
              'scope': 'swarm',
              'hostMachineId': 'ken-mac',
            },
          ]);
          final c = await show(tester, server);
          await open(tester);
          // Studio, the owner's, is in the sidebar's Machines; the menu adds
          // no row for it.
          final studio = find.text('Studio').evaluate().length;
          final macbook = find.text('Kens-MacBook').evaluate().length;
          await tester.tap(machine);
          await tester.pumpAndSettle();

          expect(find.text('Studio').evaluate(), hasLength(studio));
          // One row for the MacBook: its Team account is not offered apart.
          expect(find.text('Kens-MacBook').evaluate(), hasLength(macbook + 1));
          expect(find.text('Kens-Mini'), findsWidgets);
          await tester.tap(find.text('Kens-Mini').last);
          await tester.pumpAndSettle();
          await tester.tap(submit);
          await tester.pumpAndSettle();
          expect(commands(server, 'buddy.create').single, {
            'type': 'buddy.create',
            'projectId': 'lead',
            'machineId': 'ken-mini',
            'engine': 'claude',
          });
          await close(tester, c);
        },
      );

      testWidgets('with no machine of their own, it says so and cannot add', (
        tester,
      ) async {
        final server = buddySwarm();
        (server.state['machines'] as List).removeWhere(
          (m) => (m as Map)['contributorId'] == 'peer',
        );
        final c = await show(tester, server);
        await open(tester);

        expect(find.text(kBuddyNoMachine), findsOneWidget);
        expect(tester.widget<FilledButton>(submit).onPressed, isNull);
        await close(tester, c);
      });

      testWidgets(
        'if their only machine goes while the dialog is open, Add Buddy turns off',
        (tester) async {
          final server = buddySwarm();
          final c = await show(tester, server);
          await open(tester);
          expect(tester.widget<FilledButton>(submit).onPressed, isNotNull);

          (server.state['machines'] as List).removeWhere(
            (m) => (m as Map)['machineId'] == 'ken-mac',
          );
          await c.refresh();
          await tester.pumpAndSettle();

          expect(find.text(kBuddyNoMachine), findsOneWidget);
          expect(tester.widget<FilledButton>(submit).onPressed, isNull);
          await close(tester, c);
        },
      );

      testWidgets('a refusal shows in the dialog, which keeps the choices', (
        tester,
      ) async {
        final server = buddySwarm();
        server.refuse = {
          'code': 'MACHINE_UNAVAILABLE',
          'message': 'That machine is offline.',
        };
        final c = await show(tester, server);
        await open(tester);
        await tester.tap(submit);
        await tester.pumpAndSettle();

        expect(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.text('That machine is offline.'),
          ),
          findsOneWidget,
        );
        expect(find.text('Add a Buddy'), findsWidgets);
        expect(
          find.descendant(of: machine, matching: find.text('Kens-MacBook')),
          findsOneWidget,
        );
        await tester.tap(submit);
        await tester.pumpAndSettle();
        expect(commands(server, 'buddy.create').last['engine'], 'claude');
        await close(tester, c);
      });

      testWidgets('offers Codex turned off, saying why, and starts Claude', (
        tester,
      ) async {
        final server = buddySwarm();
        final c = await show(tester, server);
        await open(tester);

        final codex = find.widgetWithText(RadioListTile<String>, 'Codex');
        expect(tester.widget<RadioListTile<String>>(codex).enabled, isFalse);
        expect(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.text(kBuddyEngineRefusals['codex']!),
          ),
          findsOneWidget,
        );
        await tester.tap(codex);
        await tester.pumpAndSettle();
        await tester.tap(submit);
        await tester.pumpAndSettle();
        expect(commands(server, 'buddy.create').single['engine'], 'claude');
        await close(tester, c);
      });

      testWidgets(
        'a project that already has the reader\'s Buddy is not offered; with none left, there is no +',
        (tester) async {
          final server = buddySwarm();
          server.state['projects'] = [
            projectFixture('lead', 'openharness', 'lead'),
            projectFixture('web', 'web-2', 'web-lead'),
          ];
          (server.state['conversations'] as List).add({
            ...conversationFixture('web-lead', 'Lead'),
            'projectId': 'web',
          });
          giveBuddy(server);
          final c = await show(tester, server);
          await open(tester);
          // The project the dialog starts on is the one without a Buddy.
          final project = find.byKey(const ValueKey('super-buddy-project'));
          expect(
            find.descendant(of: project, matching: find.text('web-2')),
            findsOneWidget,
          );
          final shown = find.text('openharness').evaluate().length;
          await tester.tap(project);
          await tester.pumpAndSettle();
          // Its menu adds no row for the project that has one.
          expect(find.text('openharness').evaluate(), hasLength(shown));
          await tester.tap(find.text('Cancel'));
          await tester.pumpAndSettle();

          giveBuddy(server, projectId: 'web', id: 'moss', name: 'Moss');
          await c.refresh();
          await tester.pumpAndSettle();
          expect(addBuddy, findsNothing);
          await close(tester, c);
        },
      );
    });

    group('the Buddy chat', () {
      testWidgets(
        "before a Buddy runs, it offers Start on the reader's own machine with Claude, and Start adds one in this chat",
        (tester) async {
          final server = buddySwarm();
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();
          expect(c.selectedId, 'buddy-peer-lead');

          expect(
            find.text('Start your Buddy to brainstorm here'),
            findsOneWidget,
          );
          expect(
            find.descendant(
              of: find.byKey(const ValueKey('super-buddy-start-machine')),
              matching: find.text('Kens-MacBook'),
            ),
            findsOneWidget,
          );
          expect(
            find.descendant(
              of: find.byKey(const ValueKey('super-buddy-start-engine')),
              matching: find.text('Claude'),
            ),
            findsOneWidget,
          );
          await tester.tap(find.widgetWithText(FilledButton, 'Start'));
          await tester.pumpAndSettle();

          expect(commands(server, 'buddy.create').single, {
            'type': 'buddy.create',
            'projectId': 'lead',
            'machineId': 'ken-mac',
            'engine': 'claude',
          });
          expect(c.selectedId, 'buddy-peer-lead');
          expect(
            find.text('Start your Buddy to brainstorm here'),
            findsNothing,
          );
          await close(tester, c);
        },
      );

      testWidgets(
        'the Start bar offers no Codex while the server refuses it, saying why, as Add a Buddy does (#2087)',
        (tester) async {
          final c = await show(tester, buddySwarm());
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          final engine = find.byKey(const ValueKey('super-buddy-start-engine'));
          await tester.tap(engine);
          await tester.pumpAndSettle();
          expect(find.text('Codex'), findsNothing);
          await tester.tapAt(Offset.zero);
          await tester.pumpAndSettle();
          expect(find.text(kBuddyEngineRefusals['codex']!), findsOneWidget);
          await close(tester, c);
        },
      );

      testWidgets(
        "the PM's lines read as lines to the reader, which the PM writes but cannot read",
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          pmReply(server, 'buddy-peer-lead', 'Your fix is merged.');
          buddyReply(server, 'buddy-peer-lead', 'Shall we plan the next one?');
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          expect(find.text('Lead (PM) → you'), findsOneWidget);
          expect(find.text('Wren'), findsWidgets);
          expect(find.textContaining('Wren (PM)'), findsNothing);
          await close(tester, c);
        },
      );

      testWidgets(
        "the coordinator's lines carry the badge of the role it goes by",
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          (server.state['agents'] as List).first['roleName'] = 'Coordinator';
          server.state['projects'] = [
            {
              ...projectFixture('lead', 'openharness', 'lead'),
              'coordinatorName': 'Coordinator',
            },
          ];
          pmReply(server, 'buddy-peer-lead', 'Your fix is merged.');
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          expect(find.text('Lead (Coordinator) → you'), findsOneWidget);
          expect(find.textContaining('(PM)'), findsNothing);
          await close(tester, c);
        },
      );

      testWidgets('its header names the Buddy and where it runs', (
        tester,
      ) async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = await show(tester, server);
        await tester.tap(buddyEntry);
        await tester.pumpAndSettle();

        expect(find.text('Wren · Your Buddy'), findsOneWidget);
        expect(
          find.text(
            'Claude on Kens-MacBook · #Pilot · only you can read this chat',
          ),
          findsOneWidget,
        );
        expect(find.text('Message Wren'), findsOneWidget);
        await close(tester, c);
      });

      testWidgets(
        'on someone else\'s machine, the header says they can see its terminal',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server, machineId: 'studio', machineOwnerId: 'owner');
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          expect(
            find.text('Claude on Studio · #Pilot · owner can see its terminal'),
            findsOneWidget,
          );
          await close(tester, c);
        },
      );

      testWidgets(
        'a Buddy that is down offers Start again on the same machine',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server, engine: 'claude');
          ((server.state['agents'] as List).last as Map)['downSince'] =
              '2026-10-28T09:00:00Z';
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          expect(
            find.text('Wren is offline. Your chat stays.'),
            findsOneWidget,
          );
          await tester.tap(find.widgetWithText(TextButton, 'Start again'));
          await tester.pumpAndSettle();
          expect(commands(server, 'buddy.create').single, {
            'type': 'buddy.create',
            'projectId': 'lead',
            'machineId': 'ken-mac',
            'engine': 'claude',
          });
          // The new Buddy replaces the down one: one Buddy, running.
          expect(c.operationError, isNull);
          expect(
            c.snapshot!.agents.where((a) => a.buddyOf == 'peer'),
            hasLength(1),
          );
          expect(c.buddy('lead')!.downSince, isNull);
          expect(find.text('Wren is offline. Your chat stays.'), findsNothing);
          await close(tester, c);
        },
      );

      testWidgets(
        'a down Codex Buddy offers Claude Code in its place, on the same machine (review 2 of #2087)',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server, engine: 'codex');
          ((server.state['agents'] as List).last as Map)['downSince'] =
              '2026-10-28T09:00:00Z';
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          expect(find.widgetWithText(TextButton, 'Start again'), findsNothing);
          await tester.tap(
            find.widgetWithText(TextButton, 'Start with Claude Code'),
          );
          await tester.pumpAndSettle();
          expect(commands(server, 'buddy.create').single, {
            'type': 'buddy.create',
            'projectId': 'lead',
            'machineId': 'ken-mac',
            'engine': 'claude',
          });
          expect(c.operationError, isNull);
          await close(tester, c);
        },
      );

      testWidgets(
        'a Codex Buddy whose start failed offers Claude Code in its place (review 2 of #2087)',
        (tester) async {
          final server = buddySwarm();
          startBuddy(
            server,
            engine: 'codex',
            error: 'Its machine did not start it within 3 minutes.',
          );
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          await tester.tap(
            find.widgetWithText(TextButton, 'Start with Claude Code'),
          );
          await tester.pumpAndSettle();
          expect(commands(server, 'buddy.create').single['engine'], 'claude');
          await close(tester, c);
        },
      );

      testWidgets(
        'a message to the Buddy never reads as having no Lead: a Buddy chat has none',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          server.append('Hello Wren', conversationId: 'buddy-peer-lead');
          server.messages.last['author'] = {
            'kind': 'person',
            'id': 'peer',
            'name': 'ken.tran@example.com',
          };
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          expect(find.text('Hello Wren'), findsOneWidget);
          expect(find.text('Not sent · this chat has no Lead'), findsNothing);
          expect(find.text('Add a Lead'), findsNothing);
          await close(tester, c);
        },
      );

      testWidgets('the empty Buddy chat text keeps the pane\'s side padding', (
        tester,
      ) async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = await show(tester, server);
        await tester.tap(buddyEntry);
        await tester.pumpAndSettle();

        final text = tester.getRect(find.textContaining('Only you and Wren'));
        final composer = tester.getRect(
          find.byKey(const ValueKey('super-message-composer-row')),
        );
        // The composer row spans the pane; its field is inset by the panel
        // padding, and so is the empty text.
        expect(
          text.left,
          greaterThanOrEqualTo(composer.left + grid.AppDesktop.panelPadding),
        );
        expect(
          text.right,
          lessThanOrEqualTo(composer.right - grid.AppDesktop.panelPadding),
        );
        await close(tester, c);
      });

      testWidgets(
        'an empty Buddy chat says who reads it and how to reach the coordinator',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          var c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          expect(
            find.text(
              "Only you and Wren read this chat. Say what you want to build; say 'send to the Product Manager' when it's ready.",
            ),
            findsOneWidget,
          );
          await close(tester, c);

          // Called what its project calls it.
          server.state['projects'] = [
            {
              ...projectFixture('lead', 'openharness', 'lead'),
              'coordinatorName': 'Coordinator',
            },
          ];
          c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();
          expect(
            find.text(
              "Only you and Wren read this chat. Say what you want to build; say 'send to the Coordinator' when it's ready.",
            ),
            findsOneWidget,
          );
          await close(tester, c);
        },
      );

      testWidgets(
        'the decisions asked of the reader show above the Buddy chat',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          server.decisions.add({
            'id': 'd1',
            'projectId': 'lead',
            'projectName': 'Pilot',
            'conversationId': 'lead',
            'conversationTitle': 'Lead',
            'askerName': 'Lead',
            'question': 'Ship the Buddy?',
            'options': ['Yes', 'No'],
            'recommended': 0,
            'unblocks': 'The release',
            'createdAt': '2026-10-28T09:00:00Z',
          });
          server.state['decisionsWaiting'] = 1;
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          expect(find.text('Ship the Buddy?'), findsOneWidget);
          await close(tester, c);
        },
      );

      testWidgets(
        'Remove Buddy asks first, then removes it and keeps the chat',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          await tester.tap(find.byTooltip('Buddy options'));
          await tester.pumpAndSettle();
          await tester.tap(find.text('Remove Buddy'));
          await tester.pumpAndSettle();
          expect(commands(server, 'buddy.remove'), isEmpty);
          await tester.tap(find.widgetWithText(FilledButton, 'Remove'));
          await tester.pumpAndSettle();

          expect(commands(server, 'buddy.remove'), hasLength(1));
          expect(c.buddyChat('lead'), isNotNull);
          await close(tester, c);
        },
      );
    });

    group('Rename Buddy (mockup confirmed by Diego, 10-29)', () {
      Future<void> openRename(WidgetTester tester) async {
        await tester.tap(buddyEntry);
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Buddy options'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Rename Buddy…'));
        await tester.pumpAndSettle();
      }

      final nameField = find.byKey(const ValueKey('super-buddy-name'));

      testWidgets('names the Buddy for everyone, and its header shows it', (
        tester,
      ) async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = await show(tester, server);
        await openRename(tester);

        expect(find.text('Rename your Buddy'), findsOneWidget);
        expect(
          find.text('Everyone in this Swarm sees this name.'),
          findsOneWidget,
        );
        await tester.enterText(nameField, 'Sparky');
        await tester.tap(find.widgetWithText(FilledButton, 'Save'));
        await tester.pumpAndSettle();

        expect(commands(server, 'buddy.rename'), [
          {
            'type': 'buddy.rename',
            'conversationId': 'buddy-peer-lead',
            'name': 'Sparky',
          },
        ]);
        expect(find.text('Rename your Buddy'), findsNothing);
        expect(find.text('Sparky · Your Buddy'), findsOneWidget);
        await close(tester, c);
      });

      testWidgets(
        'starts from the chosen name; empty goes back to the default, as it says',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          final c = await show(tester, server);
          await c.renameBuddy('lead', 'Sparky');
          await openRename(tester);

          expect(
            tester.widget<TextField>(nameField).controller!.text,
            'Sparky',
          );
          expect(
            find.text('Leave it empty to go back to "ken.tran\'s Buddy".'),
            findsOneWidget,
          );
          await tester.enterText(nameField, '');
          await tester.tap(find.widgetWithText(FilledButton, 'Save'));
          await tester.pumpAndSettle();

          expect(commands(server, 'buddy.rename').last['name'], isNull);
          expect(find.text("ken.tran's Buddy · Your Buddy"), findsOneWidget);
          await close(tester, c);
        },
      );

      testWidgets('a refusal shows in the dialog, which keeps the name typed', (
        tester,
      ) async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = await show(tester, server);
        await openRename(tester);
        server.refuse = {
          'code': 'BUDDY_NAME_TAKEN',
          'message': 'Lead is taken in this Swarm. Choose another.',
        };
        await tester.enterText(nameField, 'Lead');
        await tester.tap(find.widgetWithText(FilledButton, 'Save'));
        await tester.pumpAndSettle();

        expect(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.text('Lead is taken in this Swarm. Choose another.'),
          ),
          findsOneWidget,
        );
        expect(tester.widget<TextField>(nameField).controller!.text, 'Lead');
        expect(find.text('Wren · Your Buddy'), findsOneWidget);
        server.refuse = null;
        await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
        await tester.pumpAndSettle();
        await close(tester, c);
      });

      testWidgets(
        'says Saving… while the server answers, and takes no second Save',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          final c = await show(tester, server);
          await openRename(tester);
          await tester.enterText(nameField, 'Sparky');
          final hold = server.holdCommands = Completer<void>();
          await tester.tap(find.widgetWithText(FilledButton, 'Save'));
          await tester.pump();

          expect(find.widgetWithText(FilledButton, 'Saving…'), findsOneWidget);
          await tester.tap(find.widgetWithText(FilledButton, 'Saving…'));
          await tester.pump();
          expect(commands(server, 'buddy.rename'), hasLength(1));
          hold.complete();
          server.holdCommands = null;
          await tester.pumpAndSettle();
          expect(find.text('Rename your Buddy'), findsNothing);
          await close(tester, c);
        },
      );

      testWidgets('scrolls in a short window, as Add a Buddy does', (
        tester,
      ) async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = await show(tester, server);
        await openRename(tester);
        server.refuse = {
          'code': 'BUDDY_NAME_TAKEN',
          'message': 'Lead is taken in this Swarm. Choose another.',
        };
        await tester.enterText(nameField, 'Lead');
        await tester.tap(find.widgetWithText(FilledButton, 'Save'));
        await tester.pumpAndSettle();
        server.refuse = null;
        await tester.binding.setSurfaceSize(const Size(1280, 330));
        await tester.pumpAndSettle();

        // Nothing overflows: the dialog's content scrolls instead.
        expect(tester.takeException(), isNull);
        final dialog = find.byType(AlertDialog);
        await tester.dragUntilVisible(
          find.descendant(
            of: dialog,
            matching: find.text('Lead is taken in this Swarm. Choose another.'),
          ),
          find.descendant(of: dialog, matching: find.byType(Scrollable)).first,
          const Offset(0, -40),
        );
        await tester.binding.setSurfaceSize(const Size(1280, 800));
        await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
        await tester.pumpAndSettle();
        await close(tester, c);
      });

      testWidgets('is offered before any Buddy runs', (tester) async {
        final server = buddySwarm();
        giveBuddy(server);
        (server.state['agents'] as List).removeWhere(
          (a) => (a as Map)['id'] == 'wren',
        );
        final c = await show(tester, server);
        await openRename(tester);
        await tester.enterText(nameField, 'Early');
        await tester.tap(find.widgetWithText(FilledButton, 'Save'));
        await tester.pumpAndSettle();

        expect(find.text('Early · Your Buddy'), findsOneWidget);
        await close(tester, c);
      });
    });

    testWidgets(
      'the Buddy chat lists the whole Swarm, never its Buddy, and offers no Add agent',
      (tester) async {
        final server = buddySwarm();
        giveBuddy(server);
        final c = await show(tester, server);
        expect(
          find.byKey(const ValueKey('super-person-owner')),
          findsOneWidget,
        );
        await tester.tap(buddyEntry);
        await tester.pumpAndSettle();

        // The same people and agents as every chat (Dee, 2026-10-31).
        expect(find.byKey(const ValueKey('super-person-peer')), findsOneWidget);
        expect(
          find.byKey(const ValueKey('super-person-owner')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('super-member-lead-agent')),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('super-member-wren')), findsNothing);
        expect(find.byTooltip('Add agent'), findsNothing);
        await close(tester, c);
      },
    );

    group('a Buddy being added', () {
      testWidgets('says it is starting, in the sidebar and its chat', (
        tester,
      ) async {
        final server = buddySwarm();
        startBuddy(server);
        final c = await show(tester, server);
        expect(
          find.descendant(of: buddyEntry, matching: find.text('starting')),
          findsOneWidget,
        );
        await tester.tap(buddyEntry);
        await tester.pumpAndSettle();
        expect(find.text('Starting Claude on Kens-MacBook…'), findsOneWidget);
        expect(find.widgetWithText(TextButton, 'Start again'), findsNothing);
        await close(tester, c);
      });

      testWidgets(
        'whose start failed says why and starts again with the same choices',
        (tester) async {
          final server = buddySwarm();
          startBuddy(
            server,
            error: 'Its machine did not start it within 3 minutes.',
          );
          final c = await show(tester, server);
          expect(
            find.descendant(of: buddyEntry, matching: find.text('not started')),
            findsOneWidget,
          );
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();
          expect(
            find.text(
              "Couldn't start: Its machine did not start it within 3 minutes.",
            ),
            findsOneWidget,
          );
          await tester.tap(find.widgetWithText(TextButton, 'Start again'));
          await tester.pumpAndSettle();
          expect(commands(server, 'buddy.create').single, {
            'type': 'buddy.create',
            'projectId': 'lead',
            'machineId': 'ken-mac',
            'engine': 'claude',
          });
          await close(tester, c);
        },
      );
    });

    group('no Chat with PM', () {
      Future<(ConversationServer, SuperTabController)> withHistory(
        WidgetTester tester,
      ) async {
        // Ken's Chat with PM from before Buddies replaced it, as a server
        // from before 10-29 still sends it.
        final server = buddySwarm(enabled: false);
        const id = 'old-pm-chat';
        (server.state['conversations'] as List).add({
          ...conversationFixture(id, 'ken.tran'),
          'projectId': 'lead',
          'leadId': 'lead-agent',
          'agentIds': ['lead-agent'],
          'audience': {
            'people': [
              {'id': 'peer', 'generation': 'fixture'},
            ],
          },
        });
        pmReply(server, id, 'Earlier answer from the PM');
        server.tag('message-${server.revision}', conversationId: id);
        server.ask(['Ship it?'], conversationId: id);
        giveBuddy(server);
        return (server, await show(tester, server));
      }

      testWidgets('no other private chat is listed or opened either', (
        tester,
      ) async {
        final server = buddySwarm();
        giveBuddy(server);
        (server.state['conversations'] as List).add({
          ...conversationFixture('private', 'Pricing talk'),
          'projectId': 'lead',
          'agentIds': ['lead-agent'],
          'audience': {
            'people': [
              {'id': 'peer', 'generation': 'fixture'},
              {'id': 'owner', 'generation': 'fixture'},
            ],
          },
        });
        final c = await show(tester, server);
        if (!c.expandedProjects.contains('lead')) c.toggleProject('lead');
        await tester.pumpAndSettle();

        expect(
          find.byKey(const ValueKey('super-group-offline')),
          findsOneWidget,
        );
        expect(find.byKey(const ValueKey('super-group-private')), findsNothing);
        expect(find.text('Pricing talk'), findsNothing);
        expect(await c.select('private'), isTrue);
        expect(c.selectedId, 'lead');
        await close(tester, c);
      });

      testWidgets(
        'Notifications keep Decisions, for anyone with or without a Buddy',
        (tester) async {
          final server = buddySwarm();
          server.ask(['Ship it?']);
          final c = await show(tester, server);
          await tester.tap(find.byKey(const ValueKey('super-activity')));
          await tester.pumpAndSettle();

          expect(find.text('Decisions'), findsOneWidget);
          expect(find.text('Ship it?'), findsOneWidget);
          await close(tester, c);
        },
      );

      testWidgets('the Buddy menu offers none', (tester) async {
        final (_, c) = await withHistory(tester);
        await tester.tap(buddyEntry);
        await tester.pumpAndSettle();
        await tester.tap(find.byTooltip('Buddy options'));
        await tester.pumpAndSettle();

        expect(find.text('Remove Buddy'), findsOneWidget);
        expect(find.text('Earlier Chat with PM'), findsNothing);
        expect(find.textContaining('Chat with PM'), findsNothing);
        await close(tester, c);
      });

      testWidgets(
        'a tag from the old Chat with PM is placed in the project chat and opens it',
        (tester) async {
          final (_, c) = await withHistory(tester);
          await tester.tap(find.byKey(const ValueKey('super-activity')));
          await tester.pumpAndSettle();

          expect(find.textContaining('Chat with PM'), findsNothing);
          await tester.tap(
            find.byKey(const ValueKey('super-mention-mention-1')),
          );
          await tester.pumpAndSettle();

          expect(c.selectedId, 'lead');
          expect(find.text('Earlier answer from the PM'), findsNothing);
          await close(tester, c);
        },
      );
    });

    group('a proposal in the project chat', () {
      testWidgets(
        "is labelled from the server's tag, with whose behalf it is on",
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          buddyReply(
            server,
            'lead',
            'Proposal from ken.tran\'s Buddy, on ken.tran\'s behalf\nGoal: Offline mode\nScope: Desktop only\nPriority: high',
            source: {
              'kind': 'buddy-proposal',
              'personId': 'peer',
              'ownerMessageId': 'message-1',
            },
          );
          // A Buddy's ordinary message carries no label, whatever it says.
          buddyReply(server, 'lead', 'Proposal · on ken.tran\'s behalf');
          final c = await show(tester, server);
          await c.select('lead');
          await tester.pumpAndSettle();

          expect(
            find.byKey(const ValueKey('super-proposal-label')),
            findsOneWidget,
          );
          expect(
            find.descendant(
              of: find.byKey(const ValueKey('super-proposal-label')),
              matching: find.text("Proposal · on ken.tran's behalf"),
            ),
            findsOneWidget,
          );
          await close(tester, c);
        },
      );
    });
  });
}
