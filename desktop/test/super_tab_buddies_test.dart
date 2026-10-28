import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/pm_chat_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Buddies (Ken's spec, 10-28): with the Swarm's setting on, a person's
/// private agent per project takes Chat with PM's place in the sidebar.
void main() {
  List<Map<String, dynamic>> commands(ConversationServer server, String type) =>
      [
        for (final post in server.posts)
          if ((post['command'] as Map)['type'] == type)
            Map<String, dynamic>.from(post['command'] as Map),
      ];

  group('the controller', () {
    test('Buddies are off unless the Swarm turns them on', () async {
      final server = buddySwarm(enabled: false);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      expect(c.buddiesOn, isFalse);

      server.state['buddies'] = true;
      await c.refresh();
      expect(c.buddiesOn, isTrue);
    });

    test('a Buddy chat is never taken for Chat with PM, though only the reader reads both', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(c.buddyChat('lead')?.id, 'buddy-peer-lead');
      expect(c.pmChat('lead'), isNull);
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
            engine: 'codex',
          ),
          isTrue,
        );

        expect(commands(server, 'buddy.create'), [
          {
            'type': 'buddy.create',
            'projectId': 'lead',
            'machineId': 'ken-mac',
            'engine': 'codex',
          },
        ]);
        expect(c.buddy('lead'), isNotNull);
        expect(c.selectedId, 'buddy-peer-lead');
      },
    );

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

    test('with Buddies on, the Chat with PM shortcut opens the Buddy chat and never creates a Chat with PM', () async {
      final server = buddySwarm();
      giveBuddy(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();

      expect(await c.openCurrentPmChat(), isTrue);

      expect(c.selectedId, 'buddy-peer-lead');
      expect(commands(server, 'conversation.create'), isEmpty);
    });

    test(
      'with Buddies on and no Buddy, the shortcut creates nothing',
      () async {
        final server = buddySwarm();
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();

        expect(await c.openCurrentPmChat(), isFalse);
        expect(commands(server, 'conversation.create'), isEmpty);
      },
    );

    /// Ken has a Chat with PM from before Buddies, with an unread PM reply,
    /// and has it open; then the Swarm turns Buddies on.
    Future<(ConversationServer, SuperTabController, String)>
    pmChatThenBuddies() async {
      final server = buddySwarm(enabled: false);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.openPmChat('lead');
      final id = c.pmChat('lead')!.id;
      await c.select('lead');
      pmReply(server, id, 'Earlier answer from the PM');
      await c.refresh();
      expect(c.pmUnread, 1);
      server.state['buddies'] = true;
      giveBuddy(server);
      await c.refresh();
      return (server, c, id);
    }

    test('with Buddies on, opening the old Chat with PM by id opens the project chat instead', () async {
      final (_, c, id) = await pmChatThenBuddies();

      expect(await c.select(id), isTrue);

      expect(c.selectedId, 'lead');
    });

    test(
      'with Buddies on, a Chat with PM left open moves to the project chat',
      () async {
        final server = buddySwarm(enabled: false);
        final c = server.controller(account: 'peer');
        addTearDown(c.dispose);
        await c.refresh();
        await c.openPmChat('lead');
        expect(c.selectedId, c.pmChat('lead')!.id);

        server.state['buddies'] = true;
        await c.refresh();

        expect(c.selectedId, 'lead');
      },
    );

    test(
      'with Buddies on, the old Chat with PM counts nothing on the Swarm tab',
      () async {
        final (_, c, _) = await pmChatThenBuddies();
        expect(c.pmUnread, 0);
      },
    );
  });

  group('the sidebar', () {
    Future<SuperTabController> show(
      WidgetTester tester,
      ConversationServer server, {
      String account = 'peer',
      Brightness brightness = Brightness.light,
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

    testWidgets('with Buddies off, Direct messages and Chat with PM stay', (
      tester,
    ) async {
      final c = await show(tester, buddySwarm(enabled: false));
      expect(find.text('Direct messages'), findsOneWidget);
      expect(pmEntry, findsOneWidget);
      expect(find.text('Buddies'), findsNothing);
      expect(addBuddy, findsNothing);
      await close(tester, c);
    });

    testWidgets(
      'with Buddies on, a Buddies section with + replaces Chat with PM',
      (tester) async {
        final c = await show(tester, buddySwarm());
        expect(find.text('Buddies'), findsOneWidget);
        expect(addBuddy, findsOneWidget);
        expect(find.text('Direct messages'), findsNothing);
        expect(pmEntry, findsNothing);
        expect(buddyEntry, findsNothing);
        await close(tester, c);
      },
    );

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

    testWidgets('the shortcut with no Buddy in the project opens Add a Buddy', (
      tester,
    ) async {
      final server = buddySwarm();
      final c = await show(tester, server);
      expect(await c.pmChatOpener!('lead'), isFalse);
      await tester.pumpAndSettle();
      expect(find.text('Add a Buddy'), findsWidgets);
      expect(commands(server, 'conversation.create'), isEmpty);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      await close(tester, c);
    });

    group('Add a Buddy', () {
      final machine = find.byKey(const ValueKey('super-buddy-machine'));
      final submit = find.widgetWithText(FilledButton, 'Add Buddy');
      final notice = find.byKey(const ValueKey('super-buddy-machine-notice'));

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
          expect(notice, findsNothing);

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
        'says whose machine it runs on as soon as someone else\'s is picked',
        (tester) async {
          final server = buddySwarm();
          final c = await show(tester, server);
          await open(tester);
          await tester.tap(machine);
          await tester.pumpAndSettle();
          await tester.tap(find.text('Studio').last);
          await tester.pumpAndSettle();

          expect(notice, findsOneWidget);
          expect(
            find.descendant(
              of: notice,
              matching: find.text(
                'Runs on Studio, which belongs to owner. They can see its terminal.',
              ),
            ),
            findsOneWidget,
          );

          await tester.tap(find.text('Codex'));
          await tester.pumpAndSettle();
          await tester.tap(submit);
          await tester.pumpAndSettle();
          expect(commands(server, 'buddy.create').single, {
            'type': 'buddy.create',
            'projectId': 'lead',
            'machineId': 'studio',
            'engine': 'codex',
          });
          await close(tester, c);
        },
      );

      testWidgets('a refusal shows in the dialog, which keeps the choices', (
        tester,
      ) async {
        final server = buddySwarm();
        server.refuse = {
          'code': 'MACHINE_UNAVAILABLE',
          'message': 'That machine is not shared with you.',
        };
        final c = await show(tester, server);
        await open(tester);
        await tester.tap(machine);
        await tester.pumpAndSettle();
        await tester.tap(find.text('Studio').last);
        await tester.pumpAndSettle();
        await tester.tap(submit);
        await tester.pumpAndSettle();

        expect(
          find.descendant(
            of: find.byType(AlertDialog),
            matching: find.text('That machine is not shared with you.'),
          ),
          findsOneWidget,
        );
        expect(find.text('Add a Buddy'), findsWidgets);
        expect(
          find.descendant(of: machine, matching: find.text('Studio')),
          findsOneWidget,
        );
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
          giveBuddy(server, engine: 'codex');
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
            'engine': 'codex',
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
        'an empty Buddy chat says who reads it and how to reach the PM',
        (tester) async {
          final server = buddySwarm();
          giveBuddy(server);
          final c = await show(tester, server);
          await tester.tap(buddyEntry);
          await tester.pumpAndSettle();

          expect(
            find.text(
              "Only you and Wren read this chat. Say what you want to build; say 'send to the PM' when it's ready.",
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

    testWidgets(
      'the Buddy chat lists only its person and its Buddy, and offers no Add agent',
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

        expect(find.byKey(const ValueKey('super-person-peer')), findsOneWidget);
        expect(find.byKey(const ValueKey('super-person-owner')), findsNothing);
        expect(
          find.byKey(const ValueKey('super-member-lead-agent')),
          findsNothing,
        );
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
        expect(find.text('Starting Codex on Studio…'), findsOneWidget);
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
            'machineId': 'studio',
            'engine': 'codex',
          });
          await close(tester, c);
        },
      );
    });

    group('no Chat with PM', () {
      Future<(ConversationServer, SuperTabController)> withHistory(
        WidgetTester tester,
      ) async {
        final server = buddySwarm(enabled: false);
        final c = server.controller(account: 'peer');
        await c.refresh();
        await c.openPmChat('lead');
        final id = c.pmChat('lead')!.id;
        pmReply(server, id, 'Earlier answer from the PM');
        server.tag('message-${server.revision}', conversationId: id);
        server.ask(['Ship it?'], conversationId: id);
        c.dispose();
        server.state['buddies'] = true;
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
          await tester.tap(find.byKey(const ValueKey('super-notifications')));
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
          await tester.tap(find.byKey(const ValueKey('super-notifications')));
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
