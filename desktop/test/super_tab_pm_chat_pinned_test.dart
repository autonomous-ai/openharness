import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keyboard_practice.dart';
import 'package:harness/shortcuts/keymap.dart';
import 'package:harness/shortcuts/keymap_commands.dart';
import 'package:harness/shortcuts/keymap_edit.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/pm_chat.dart';
import 'package:harness/super_tabs/pm_chat_shortcut.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'swarm_screen_test.dart' show mount;
import 'support/pm_chat_fixture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_PM_CHAT_SHOTS'];

/// Chat with PM pinned at the top of the Swarm sidebar, with its unread count
/// on the row, the project and the Swarm tab, and a shortcut that opens it.
void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  /// [account]'s controller with their PM chat opened once and then left for
  /// a workgroup, so the Product Manager's replies arrive unread.
  Future<(SuperTabController, String)> awayFromChat(
    ConversationServer server, {
    String account = 'peer',
  }) async {
    final c = server.controller(account: account);
    addTearDown(c.dispose);
    await c.refresh();
    await c.openPmChat('lead');
    final chat = c.pmChat('lead')!.id;
    await c.select('offline');
    await pumpEventQueue();
    return (c, chat);
  }

  /// A second project, Mobile, whose Product Manager is Wren.
  void secondProject(ConversationServer server) {
    server.state['projects'] = [
      projectFixture('lead', 'Pilot', 'lead'),
      projectFixture('mobile', 'Mobile', 'mobile-lead'),
    ];
    (server.state['agents'] as List).add({
      'id': 'mobile-pm',
      'name': 'Lead',
      'displayName': 'Wren',
      'machineId': 'm1',
      'harnessId': 'h2',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude', 'model': 'opus'},
    });
    (server.state['conversations'] as List).add({
      ...conversationFixture('mobile-lead', 'Lead'),
      'projectId': 'mobile',
      'leadId': 'mobile-pm',
      'agentIds': ['mobile-pm'],
    });
  }

  /// [pmChatSwarm] with its Product Manager called River.
  ConversationServer riverSwarm() {
    final server = pmChatSwarm();
    (server.state['agents'] as List).first['displayName'] = 'River';
    return server;
  }

  group('the unread count', () {
    test("counts the Product Manager's new messages", () async {
      final server = pmChatSwarm();
      final (c, chat) = await awayFromChat(server);

      pmReply(server, chat, 'Here is the plan.');
      pmReply(server, chat, 'The build is green.');
      pmReply(server, chat, 'Shall I ship it?');
      await c.refresh();
      await pumpEventQueue();

      expect(c.unreadCount(c.pmChat('lead')!), 3);
      expect(c.pmUnread, 3);
    });

    test('ignores the reader\'s own messages and clears once read', () async {
      final server = pmChatSwarm();
      final (c, chat) = await awayFromChat(server);
      pmReply(server, chat, 'Here is the plan.');
      server.append('Sent from my phone', conversationId: chat);
      server.messages.last['author'] = {
        'kind': 'person',
        'id': 'peer',
        'name': 'ken.tran@example.com',
      };
      await c.refresh();
      await pumpEventQueue();
      expect(c.unreadCount(c.pmChat('lead')!), 1);

      await c.select(chat);
      await pumpEventQueue();
      c.markRead(chat);

      expect(c.unreadCount(c.pmChat('lead')!), 0);
      expect(c.pmUnread, 0);
    });

    test(
      'reads only a PM chat with news, and nothing when nothing changed',
      () async {
        final server = pmChatSwarm();
        final (c, chat) = await awayFromChat(server);
        final reads = <String>[];
        server.onRead = reads.add;
        bool readOf(String path, String id) =>
            path.contains('/conversations/$id/');

        pmReply(server, chat, 'Here is the plan.');
        server.append('A note in the project', conversationId: 'lead');
        await c.refresh();
        await pumpEventQueue();
        expect(reads.where((p) => readOf(p, chat)), hasLength(1));
        expect(reads.where((p) => readOf(p, 'lead')), isEmpty);

        reads.clear();
        await c.refresh();
        await pumpEventQueue();
        expect(reads.where((p) => readOf(p, chat)), isEmpty);
      },
    );

    test("never counts another person's chat, the owner's included", () async {
      final server = pmChatSwarm();
      final (_, peerChat) = await awayFromChat(server);
      final owner = server.controller(account: 'owner');
      addTearDown(owner.dispose);
      await owner.refresh();
      final reads = <String>[];
      server.onRead = reads.add;

      pmReply(server, peerChat, 'Only for Ken.');
      await owner.refresh();
      await pumpEventQueue();

      expect(owner.pmUnread, 0);
      expect(reads.where((p) => p.contains(peerChat)), isEmpty);
    });
  });

  group('the unread count past a page', () {
    /// [awayFromChat] with one reply read first, so the read mark sits at it,
    /// and pages of [page] messages.
    Future<(SuperTabController, String)> readOnce(
      ConversationServer server, {
      int page = 10,
    }) async {
      server.messagePage = page;
      final (c, chat) = await awayFromChat(server);
      pmReply(server, chat, 'Earlier, already read.');
      await c.refresh();
      await c.select(chat);
      await pumpEventQueue(times: 100);
      c.markRead(chat);
      await c.select('offline');
      return (c, chat);
    }

    List<String> readsOf(ConversationServer server, String chat) {
      final reads = <String>[];
      server.onRead = (path) {
        if (path.contains('/conversations/$chat/')) reads.add(path);
      };
      return reads;
    }

    test('counts every unread message of a chat not held yet, then reads nothing more', () async {
      final server = pmChatSwarm();
      final (c, chat) = await readOnce(server);
      for (var i = 1; i <= 25; i++) {
        pmReply(server, chat, 'Update $i');
      }
      await c.flush();
      // Another window: the same read mark, no messages held.
      final fresh = server.controller(account: 'peer', initial: server.saved);
      addTearDown(fresh.dispose);
      final reads = readsOf(server, chat);

      await fresh.refresh();
      await pumpEventQueue(times: 100);
      expect(fresh.unreadCount(fresh.pmChat('lead')!), 25);
      expect(reads, hasLength(3));

      reads.clear();
      await fresh.refresh();
      await pumpEventQueue(times: 100);
      expect(fresh.unreadCount(fresh.pmChat('lead')!), 25);
      expect(reads, isEmpty);
    });

    test(
      'counts a burst of new messages past a page, then reads nothing more',
      () async {
        final server = pmChatSwarm();
        final (c, chat) = await readOnce(server);
        final reads = readsOf(server, chat);
        for (var i = 1; i <= 25; i++) {
          pmReply(server, chat, 'Update $i');
        }

        await c.refresh();
        await pumpEventQueue(times: 100);
        expect(c.unreadCount(c.pmChat('lead')!), 25);
        expect(reads, hasLength(3));

        reads.clear();
        await c.refresh();
        await pumpEventQueue(times: 100);
        expect(reads, isEmpty);
      },
    );

    test('stops at 99+ rather than reading a whole history it has no read mark for', () async {
      final server = pmChatSwarm();
      server.messagePage = 10;
      final (c, chat) = await awayFromChat(server);
      for (var i = 1; i <= 150; i++) {
        pmReply(server, chat, 'Update $i');
      }
      await c.flush();
      final fresh = server.controller(account: 'peer');
      addTearDown(fresh.dispose);
      final reads = readsOf(server, chat);

      await fresh.refresh();
      await pumpEventQueue(times: 200);
      final count = fresh.unreadCount(fresh.pmChat('lead')!);
      expect(count, greaterThanOrEqualTo(100));
      expect(pmUnreadLabel(count), '99+ new in Chat with PM');
      expect(reads, hasLength(10));

      reads.clear();
      await fresh.refresh();
      await pumpEventQueue(times: 100);
      expect(reads, isEmpty);
    });
  });

  group('the current project', () {
    test("is the selected conversation's, else the first", () async {
      final server = pmChatSwarm();
      secondProject(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      // The Product Managers' conversation belongs to no project.
      await c.select('offline');
      expect(c.currentProjectId, 'lead');
      await c.select('mobile-lead');
      expect(c.currentProjectId, 'mobile');
    });

    test('opening its chat creates and selects it', () async {
      final server = pmChatSwarm();
      secondProject(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.select('mobile-lead');

      expect(await c.openCurrentPmChat(), isTrue);

      expect(c.selectedId, c.pmChat('mobile')!.id);
      expect(c.pmChat('lead'), isNull);
    });
  });

  group('the sidebar', () {
    Future<SuperTabController> show(
      WidgetTester tester,
      ConversationServer server, {
      String account = 'peer',
    }) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final c = server.controller(account: account);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
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

    final entry = find.byKey(const ValueKey('super-pm-chat-lead'));
    final sidebar = find.byType(ProjectSidebar);
    final projectRow = find.byKey(const ValueKey('super-group-lead'));

    testWidgets(
      'pins Chat with PM as a direct message above the projects, shown with the project and the list collapsed',
      (tester) async {
        final c = await show(tester, riverSwarm());
        expect(c.expandedProjects, isNot(contains('lead')));
        // Listed by the Product Manager's name and avatar, like a direct message.
        expect(
          find.descendant(of: entry, matching: find.text('River')),
          findsOne,
        );
        expect(
          find.descendant(of: entry, matching: find.byType(SuperTabAvatar)),
          findsOne,
        );
        expect(
          find.descendant(of: entry, matching: find.byTooltip('Chat with PM')),
          findsOne,
        );
        expect(
          tester.getTopLeft(find.text('Direct messages')).dy,
          lessThan(tester.getTopLeft(entry).dy),
        );
        expect(
          tester.getTopLeft(find.text('Direct messages')).dx,
          tester.getTopLeft(find.text('Projects')).dx,
        );
        expect(
          tester.getTopLeft(entry).dy,
          lessThan(tester.getTopLeft(find.text('Projects')).dy),
        );

        c.toggleProjectsGroup();
        await tester.pumpAndSettle();
        expect(c.projectsGroupOpen, isFalse);
        expect(entry, findsOneWidget);

        // Opening the project does not list it a second time.
        c.toggleProjectsGroup();
        c.toggleProject('lead');
        await tester.pumpAndSettle();
        expect(
          find.descendant(of: sidebar, matching: find.text('River')),
          findsOneWidget,
        );
        await close(tester, c);
      },
    );

    testWidgets(
      'lists projects as channels: a # before the name, open or not',
      (tester) async {
        final c = await show(tester, riverSwarm());
        expect(
          find.descendant(of: projectRow, matching: find.text('#')),
          findsOne,
        );
        expect(
          find.descendant(
            of: projectRow,
            matching: find.byIcon(AppIcons.folder),
          ),
          findsNothing,
        );
        c.toggleProject('lead');
        await tester.pumpAndSettle();
        expect(
          find.descendant(of: projectRow, matching: find.text('#')),
          findsOne,
        );
        expect(
          find.descendant(
            of: projectRow,
            matching: find.byIcon(AppIcons.folderOpen),
          ),
          findsNothing,
        );
        await close(tester, c);
      },
    );

    testWidgets('shows a workgroup by its number in grey, with no #', (
      tester,
    ) async {
      final server = riverSwarm();
      (server.state['conversations'] as List).last['number'] = 196;
      final c = await show(tester, server);
      c.toggleProject('lead');
      await tester.pumpAndSettle();
      final row = find.byKey(const ValueKey('super-group-offline'));
      final name = find.descendant(
        of: row,
        matching: find.text('196  Offline editing'),
      );
      expect(name, findsOne);
      expect(
        find.descendant(of: row, matching: find.textContaining('#')),
        findsNothing,
      );
      final number =
          (tester.widget<Text>(name).textSpan! as TextSpan).children!.first;
      expect(number.toPlainText(), '196  ');
      expect(number.style?.color, DesktopChrome.muted);
      await close(tester, c);
    });

    testWidgets(
      'the shortcut leaves Notifications for the chat, first opened or already selected',
      (tester) async {
        final c = await show(tester, riverSwarm());
        Future<void> shortcutOverNotifications() async {
          await tester.tap(find.byKey(const ValueKey('super-notifications')));
          await tester.pumpAndSettle();
          expect(find.text('Message Product Manager'), findsNothing);
          // What ⇧⌘K runs (openActivePmChat).
          expect(await c.openCurrentPmChat(), isTrue);
          await tester.pumpAndSettle();
          expect(c.selectedId, c.pmChat('lead')?.id);
          expect(find.text('Message Product Manager'), findsOneWidget);
        }

        await shortcutOverNotifications();
        await shortcutOverNotifications();
        await close(tester, c);
      },
    );

    testWidgets(
      'the header names a workgroup as the sidebar does: its number in grey, no #',
      (tester) async {
        final server = riverSwarm();
        (server.state['conversations'] as List).last['number'] = 196;
        final c = await show(tester, server);
        await c.select('offline');
        await tester.pumpAndSettle();

        expect(find.text('#196 Offline editing'), findsNothing);
        final names = find.text('196  Offline editing');
        // The header's and the sidebar row's.
        expect(names, findsNWidgets(2));
        for (final name in tester.widgetList<Text>(names)) {
          final number = (name.textSpan! as TextSpan).children!.first;
          expect(number.style?.color, DesktopChrome.muted);
        }
        await close(tester, c);
      },
    );

    testWidgets('names the Product Manager role while a project has none', (
      tester,
    ) async {
      final c = await show(tester, ConversationServer(), account: 'owner');
      expect(
        find.descendant(of: entry, matching: find.text('Product Manager')),
        findsOne,
      );
      await close(tester, c);
    });

    testWidgets('the first open leaves Notifications for the new chat', (
      tester,
    ) async {
      final c = await show(tester, pmChatSwarm());
      await tester.tap(find.byKey(const ValueKey('super-notifications')));
      await tester.pumpAndSettle();
      expect(find.text('Message Product Manager'), findsNothing);

      await tester.tap(entry);
      await tester.pumpAndSettle();

      expect(c.selectedId, c.pmChat('lead')!.id);
      expect(find.text('Message Product Manager'), findsOneWidget);
      await close(tester, c);
    });

    testWidgets('has one row per project, with its project named', (
      tester,
    ) async {
      final server = riverSwarm();
      secondProject(server);
      final c = await show(tester, server);
      final mobile = find.byKey(const ValueKey('super-pm-chat-mobile'));

      for (final (row, pm, project) in [
        (entry, 'River', 'Pilot'),
        (mobile, 'Wren', 'Mobile'),
      ]) {
        expect(find.descendant(of: row, matching: find.text(pm)), findsOne);
        expect(
          find.descendant(of: row, matching: find.text(project)),
          findsOne,
        );
        expect(
          find.descendant(
            of: row,
            matching: find.byTooltip('Chat with PM · $project'),
          ),
          findsOne,
        );
      }

      await tester.tap(find.byKey(const ValueKey('super-pm-chat-mobile')));
      await tester.pumpAndSettle();
      expect(c.selectedId, c.pmChat('mobile')!.id);
      await close(tester, c);
    });

    testWidgets(
      "shows the count on the row and the project, and the project's count opens the chat",
      (tester) async {
        final server = pmChatSwarm();
        final c = await show(tester, server);
        await tester.tap(entry);
        await tester.pumpAndSettle();
        final chat = c.pmChat('lead')!.id;
        await tester.tap(find.byKey(const ValueKey('super-group-lead')));
        await tester.pumpAndSettle();

        pmReply(server, chat, 'Here is the plan.');
        pmReply(server, chat, 'Shall I ship it?');
        await c.refresh();
        await tester.pumpAndSettle();

        final projectCount = find.byKey(
          const ValueKey('super-project-pm-unread-lead'),
        );
        expect(find.descendant(of: entry, matching: find.text('2')), findsOne);
        expect(
          find.descendant(of: projectCount, matching: find.text('2')),
          findsOne,
        );
        expect(find.byTooltip('2 new in Chat with PM'), findsNWidgets(2));

        await tester.tap(projectCount);
        await tester.pumpAndSettle();
        expect(c.selectedId, chat);
        expect(
          find.descendant(of: entry, matching: find.text('2')),
          findsNothing,
        );
        expect(projectCount, findsNothing);
        await close(tester, c);
      },
    );

    testWidgets("never shows another person's chat or its count", (
      tester,
    ) async {
      final server = pmChatSwarm();
      final peer = server.controller(account: 'peer');
      await peer.refresh();
      await peer.openPmChat('lead');
      final peerChat = peer.pmChat('lead')!.id;
      peer.dispose();
      pmReply(server, peerChat, 'Only for Ken.');

      final c = await show(tester, server, account: 'owner');

      expect(entry, findsOneWidget);
      expect(c.pmChat('lead'), isNull);
      expect(
        find.byKey(const ValueKey('super-project-pm-unread-lead')),
        findsNothing,
      );
      expect(
        find.descendant(of: sidebar, matching: find.text('ken.tran')),
        findsNothing,
      );
      await close(tester, c);
    });
  });

  group('the Swarm tab', () {
    test(
      'counts unread PM messages beside its tags, with its own label',
      () async {
        final f = SuperTabLaunchFixture(local: true);
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
        final server = f.connection.server;
        final c = await f.app.superTabs.open(tabId);
        await c.refresh();
        await c.openPmChat('lead');
        final chat = c.pmChat('lead')!.id;
        await c.select('lead');
        final tab = f.app.activeSwarm;
        expect(tabWaiting(f.app, tab), 0);
        expect(tabWaitingLabel(f.app, tab), isNull);

        pmReply(server, chat, 'Here is the plan.');
        pmReply(server, chat, 'Shall I ship it?');
        await c.refresh();
        await pumpEventQueue();
        expect(tabPmWaiting(f.app, tab), 2);
        expect(tabWaiting(f.app, tab), 2);
        expect(tabWaitingLabel(f.app, tab), '2 new in Chat with PM');

        server.tag('message-1');
        await c.refresh();
        expect(tabWaiting(f.app, tab), 3);
        expect(
          tabWaitingLabel(f.app, tab),
          'Tagged in 1 message · 2 new in Chat with PM',
        );
      },
    );
  });

  for (final native in [false, true]) {
    testWidgets('a Swarm tab behind another counts unread PM messages '
        '(native=$native)', (tester) async {
      final updates = <Map>[];
      const channel = MethodChannel('harness/swarm_tabs');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final f = SuperTabLaunchFixture(local: true);
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final swarm = f.app.activeSwarm;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await c.openPmChat('lead');
      final chat = c.pmChat('lead')!.id;
      await c.select('lead');
      pmReply(f.connection.server, chat, 'Here is the plan.');
      pmReply(f.connection.server, chat, 'Shall I ship it?');
      await c.refresh();
      await tester.runAsync(pumpEventQueue);
      f.app.newSwarm(name: 'other');
      await mount(tester, f.app, nativeTabs: native);
      await tester.pump(const Duration(milliseconds: 100));
      if (native) {
        final tab = (updates.last['tabs'] as List).cast<Map>().singleWhere(
          (t) => t['id'] == swarm.id,
        );
        expect(tab['attention'], 2);
      } else {
        expect(
          tester
              .widget<Text>(find.byKey(ValueKey('tab-tags:${swarm.id}')))
              .data,
          '2',
        );
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      f.dispose();
    });
  }

  testWidgets(
    "machines read as '~ name', with the name the person gave it when set",
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      const renamed = Machine(
        machineId: 'm2',
        authMode: MachineAuthMode.remote,
        name: "Diego's Mac",
      );
      f.app.machines = [...f.app.machines, renamed];
      f.app.machineStates['m2'] = MachineState(renamed)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      f.connection.server.state['machines'] = [
        {
          'machineId': 'm2',
          'name': 'MacBookPro2021.local',
          'contributorId': 'owner',
        },
        // A teammate's: only the Swarm's name for it is known here.
        {
          'machineId': 'studio',
          'name': 'Studio.local',
          'contributorId': 'owner',
        },
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SuperTabMachines(
              controller: c,
              app: f.app,
              onAddAgent: (_) {},
            ),
          ),
        ),
      );
      await tester.pump();

      String name(String id) => tester
          .widget<Text>(find.byKey(ValueKey('super-machine-name-$id')))
          .data!;
      expect(name('m2'), "Diego's Mac");
      expect(name('studio'), 'Studio');
      final row = find.byKey(const ValueKey('super-machine-m2'));
      expect(find.descendant(of: row, matching: find.text('~')), findsOne);
      expect(
        find.descendant(of: row, matching: find.byIcon(AppIcons.monitor)),
        findsNothing,
      );
      expect(
        find.descendant(of: row, matching: find.byType(SuperTabMachineDot)),
        findsOne,
      );
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
    },
  );

  group('the shortcut', () {
    HarnessCommand command() =>
        harnessCommands.singleWhere((c) => c.id == 'swarm.chat_with_pm');

    test('is ⇧⌘K, listed as Chat with PM in the shortcuts help', () {
      expect(command().label, 'Chat with PM');
      expect(command().keys, ['cmd+shift+k']);
      final lesson = keyboardLessons(AppKeymap())
          .singleWhere((l) => l.command == 'swarm.chat_with_pm');
      expect(lesson.label, 'Chat with PM');
      expect(lesson.group, 'Workspace');
      expect(lesson.bindings.map((b) => b.sequence), ['cmd+shift+k']);
    });

    // A browser binds as Linux does (Alt for ⌘); the VM cannot be one.
    for (final platform in [
      TargetPlatform.macOS,
      TargetPlatform.linux,
      TargetPlatform.windows,
    ]) {
      test('clashes with nothing on ${platform.name}', () {
        debugDefaultTargetPlatformOverride = platform;
        addTearDown(() => debugDefaultTargetPlatformOverride = null);
        final keys = command().keys;
        expect(keys, hasLength(1));

        final clash = findShortcutConflict(
          harnessDefaultKeymap,
          command: 'swarm.chat_with_pm',
          context: KeymapContext.workspace,
          keys: [KeyStroke.parse(keys.single)],
          label: (id) => id,
          linux: platform == TargetPlatform.linux,
        );
        expect(clash, isNull, reason: '${keys.single}: ${clash?.label}');
      });
    }

    test("opens the active Swarm tab's current project chat, and nothing elsewhere", () async {
      final f = SuperTabLaunchFixture(local: true);
      final plain = f.app.activeSwarmId;
      expect(await openActivePmChat(f.app), isFalse);

      f.app.bindSuperTab(plain, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await c.select('offline');

      expect(await openActivePmChat(f.app), isTrue);
      expect(c.selectedId, c.pmChat('lead')!.id);
    });
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      final picture = GlobalKey();
      final server = riverSwarm();
      (server.state['conversations'] as List).last['number'] = 196;
      server.state['machines'] = [
        {'machineId': 'diego', 'name': "Diego's Mac", 'contributorId': 'owner'},
      ];
      secondProject(server);
      final c = server.controller(account: 'peer');
      addTearDown(c.dispose);
      await c.refresh();
      await c.openPmChat('lead');
      final chat = c.pmChat('lead')!.id;
      await c.select('offline');
      pmReply(server, chat, 'Here is the plan.');
      pmReply(server, chat, 'Shall I ship it?');
      await c.refresh();
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = Brightness.light);
      await tester.binding.setSurfaceSize(const Size(1200, 760));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              RepaintBoundary(key: picture, child: child),
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

      Future<void> shot(String name) => tester.runAsync(() async {
        final boundary =
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary;
        final image = await boundary.toImage(pixelRatio: 1.5);
        final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/pm-chat-$name-${brightness.name}.png')
            .writeAsBytes(bytes!.buffer.asUint8List());
        image.dispose();
      });

      c.expandedProjects.clear();
      if (c.projectsGroupOpen) c.toggleProjectsGroup();
      await tester.pumpAndSettle();
      await shot('collapsed');
      c.toggleProjectsGroup();
      c.toggleProject('lead');
      await tester.pumpAndSettle();
      await shot('expanded');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
    }, skip: shots == null);
  }
}
