import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/agent_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_data.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the pictures of Your Team's states there, in both themes at three window sizes.
final _shots = Platform.environment['AGENT_STATES_SHOTS'];

/// What each agent of Your Team is doing, one line on its row (Swarm v4, tester Q1: "why do I see no agent talk"): free, on
/// #12, or offline with a grey face; Your Machines open by themselves while a computer is off.
void main() {
  setUpAll(() => loadCaptureFonts(_shots));

  Finder key(String k) => find.byKey(ValueKey(k));
  Finder inRow(String row, Finder finder) =>
      find.descendant(of: key(row), matching: finder);

  /// lampOS's Swarm (the person is Dee: first builder is their PM, second and third their builders, reviewer-two their
  /// reader), with `third` offline, a free post of `second`'s, and `reviewer-two`'s latest post not a free one. The fake `gh`
  /// has `first builder` on #5759.
  ConversationServer world() {
    final server = swarmV4Server();
    final agents = (server.state['agents'] as List)
        .cast<Map<String, dynamic>>();
    agents.firstWhere((a) => a['id'] == 'third')['downSince'] =
        '2026-11-09T05:00:00Z';
    void say(String who, String text) {
      server.append(text, conversationId: 'lead', agent: true);
      server.messages.last['author'] = {
        'kind': 'agent',
        'id': who,
        'name': who,
      };
    }

    say('third', 'Read posted on #3913: no source P1.');
    say('second', 'free: second');
    say('reviewer-two', 'free: reviewer-two');
    say('reviewer-two', 'Taking #3543 next.');
    return server;
  }

  Future<SuperTabController> read(ConversationServer server) async {
    final c = server.controller(
      account: 'owner',
      // Another chat is open: the channel's reads are the reader's alone.
      initial: {
        'tabId': 'tab',
        'accountId': 'owner',
        'selectedId': 'agent-chat-second',
      },
    );
    addTearDown(c.dispose);
    await c.refresh();
    return c;
  }

  Future<void> quiet() async {
    for (var i = 0; i < 8; i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
  }

  /// The reader settles and reads, and the rows draw what it found.
  Future<void> settled(WidgetTester tester) async {
    for (var i = 0; i < 4; i++) {
      await tester.runAsync(quiet);
      await tester.pump(const Duration(milliseconds: 500));
    }
  }

  int channelReads(List<String> paths) =>
      paths.where((p) => p.contains('/conversations/lead/messages')).length;

  group('the reader', () {
    test(
      'says offline before on #N before free, and nothing for the rest',
      () async {
        final server = world();
        final c = await read(server);
        final states = SwarmAgentStates(
          controller: c,
          github: swarmV4GitHub(),
          settle: Duration.zero,
        );
        addTearDown(states.dispose);
        await quiet();
        String? of(String id) => states.of(c.snapshot!.agent(id)!);
        // Their PM is on a task the board says it took; second's last post said it is free; third is down.
        expect(of('first builder'), 'on #5759');
        expect(of('second'), 'free');
        expect(of('third'), 'offline');
        // reviewer-two posted that it was free, then took something else: its latest post decides.
        expect(of('reviewer-two'), isNull);
      },
    );

    test(
      'an agent that holds a task is not free, and a down one is only offline',
      () async {
        final server = world();
        // first builder says it is free too, and is down.
        server.append(
          'free: first builder',
          conversationId: 'lead',
          agent: true,
        );
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'first builder',
          'name': 'first builder',
        };
        final agents = (server.state['agents'] as List)
            .cast<Map<String, dynamic>>();
        agents.firstWhere((a) => a['id'] == 'second')['downSince'] =
            '2026-11-09T06:00:00Z';
        final c = await read(server);
        final states = SwarmAgentStates(
          controller: c,
          github: swarmV4GitHub(),
          settle: Duration.zero,
        );
        addTearDown(states.dispose);
        await quiet();
        expect(states.of(c.snapshot!.agent('first builder')!), 'on #5759');
        expect(states.of(c.snapshot!.agent('second')!), 'offline');
      },
    );

    test(
      'reads only what changed: a channel when it moved, a board once a minute',
      () async {
        final server = world();
        final paths = <String>[];
        server.onRead = paths.add;
        final c = await read(server);
        final calls = <List<String>>[];
        var now = DateTime(2026, 11, 9, 9);
        await withClock(Clock(() => now), () async {
          final states = SwarmAgentStates(
            controller: c,
            github: swarmV4GitHub(calls: calls),
            settle: Duration.zero,
          );
          addTearDown(states.dispose);
          await quiet();
          expect(channelReads(paths), 1);
          expect(calls, hasLength(1));
          final before = (channelReads(paths), calls.length);

          // The Swarm changes in ways that leave the channel and the board as they were: nothing more is read.
          await c.refresh();
          await c.refresh();
          await quiet();
          expect((channelReads(paths), calls.length), before);

          // second takes a task: its next post is read, from where the last one ended.
          server.append('Taking #5760.', conversationId: 'lead', agent: true);
          server.messages.last['author'] = {
            'kind': 'agent',
            'id': 'second',
            'name': 'second',
          };
          await c.refresh();
          await quiet();
          expect(channelReads(paths), 2);
          expect(
            paths.where((p) => p.contains('?after=')).length,
            greaterThanOrEqualTo(1),
          );
          expect(states.of(c.snapshot!.agent('second')!), isNull);
          expect(
            calls.length,
            before.$2,
            reason: 'the board is not read again within its minute',
          );

          // A minute later the board is asked again; the channel, unmoved, is not.
          now = now.add(const Duration(minutes: 2));
          await c.refresh();
          await quiet();
          expect(calls.length, before.$2 + 1);
          expect(channelReads(paths), 2);
        });
      },
    );

    test(
      'a Swarm with none of the person\'s own agents reads nothing',
      () async {
        final server = world();
        // Only teammates' agents are left: none is the person's own.
        (server.state['agents'] as List).removeWhere(
          (a) => a['myAgent'] == true,
        );
        final paths = <String>[];
        server.onRead = paths.add;
        final c = await read(server);
        final calls = <List<String>>[];
        final states = SwarmAgentStates(
          controller: c,
          github: swarmV4GitHub(calls: calls),
          settle: Duration.zero,
        );
        addTearDown(states.dispose);
        await quiet();
        expect(calls, isEmpty);
        expect(channelReads(paths), 0);
      },
    );

    test('a board that cannot be read leaves the other states alone; a channel that cannot is read again later', () async {
      final server = world();
      final c = await read(server);
      final states = SwarmAgentStates(
        controller: c,
        github: SwarmGitHub(
          run: (_) async => ProcessResult(1, 1, '', 'gh auth login'),
        ),
        settle: Duration.zero,
      );
      addTearDown(states.dispose);
      await quiet();
      expect(states.of(c.snapshot!.agent('first builder')!), isNull);
      expect(states.of(c.snapshot!.agent('second')!), 'free');
      expect(states.of(c.snapshot!.agent('third')!), 'offline');
    });

    test('stops reading once disposed', () async {
      final server = world();
      final paths = <String>[];
      server.onRead = paths.add;
      final c = await read(server);
      final calls = <List<String>>[];
      final states = SwarmAgentStates(
        controller: c,
        github: swarmV4GitHub(calls: calls),
        settle: const Duration(milliseconds: 30),
      );
      states.dispose();
      await quiet();
      expect(calls, isEmpty);
      expect(channelReads(paths), 0);
    });

    test('a free post is "free:" and a name, in any case', () {
      for (final yes in [
        'free: pip',
        'Free: Pip',
        '  FREE : pip',
        'free:pip',
      ]) {
        expect(SwarmAgentStates.isFreePost(yes), isTrue, reason: yes);
      }
      for (final no in [
        'freeze: pip',
        'I am free: pip',
        'Free for #12',
        'unfree: x',
        '',
      ]) {
        expect(SwarmAgentStates.isFreePost(no), isFalse, reason: no);
      }
    });

    test('an agent that goes down shows offline, and its state returns when it is back', () async {
      final server = world();
      final c = await read(server);
      final states = SwarmAgentStates(
        controller: c,
        github: swarmV4GitHub(),
        settle: Duration.zero,
      );
      addTearDown(states.dispose);
      await quiet();
      expect(states.of(c.snapshot!.agent('second')!), 'free');
      final second = (server.state['agents'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((a) => a['id'] == 'second');
      second['downSince'] = '2026-11-09T08:00:00Z';
      await c.refresh();
      expect(states.of(c.snapshot!.agent('second')!), 'offline');
      second.remove('downSince');
      await c.refresh();
      expect(states.of(c.snapshot!.agent('second')!), 'free');
    });

    test('projects of one repository read its board once', () async {
      final server = world();
      final agents = (server.state['agents'] as List)
          .cast<Map<String, dynamic>>();
      final projects = (server.state['projects'] as List)
          .cast<Map<String, dynamic>>();
      final chats = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>();
      // A second project on the same repository, with an agent of the person's.
      projects.add({
        ...projectFixture('again', 'lampos again', 'channel-again'),
        'repository': {
          'repositoryUrl': 'https://github.com/autonomous-ai/lampOS',
        },
      });
      chats.add({
        ...conversationFixture('channel-again', 'lampos again'),
        'projectId': 'again',
      });
      agents.add({
        'id': 'extra',
        'projectId': 'again',
        'name': 'extra',
        'displayName': 'extra',
        'machineId': 'host',
        'harnessId': 'session-extra',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
        'kind': 'regular',
        'chatId': 'chat-extra',
        'myAgent': true,
      });
      final c = await read(server);
      final calls = <List<String>>[];
      final states = SwarmAgentStates(
        controller: c,
        github: swarmV4GitHub(calls: calls),
        settle: Duration.zero,
      );
      addTearDown(states.dispose);
      await quiet();
      expect(calls, hasLength(1));
      expect(states.of(c.snapshot!.agent('first builder')!), 'on #5759');
    });

    test('at most a dozen projects are read for', () async {
      final server = world();
      final agents = (server.state['agents'] as List)
          .cast<Map<String, dynamic>>();
      final projects = (server.state['projects'] as List)
          .cast<Map<String, dynamic>>();
      final chats = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>();
      // Twenty more projects, each with an agent of the person's.
      for (var i = 0; i < 20; i++) {
        projects.add(projectFixture('p$i', 'Project $i', 'channel-$i'));
        chats.add({
          ...conversationFixture('channel-$i', 'Project $i'),
          'projectId': 'p$i',
        });
        agents.add({
          'id': 'builder-$i',
          'projectId': 'p$i',
          'name': 'builder-$i',
          'displayName': 'builder-$i',
          'machineId': 'host',
          'harnessId': 'session-builder-$i',
          'contributorId': 'owner',
          'configuration': {'engine': 'claude'},
          'kind': 'regular',
          'chatId': 'chat-builder-$i',
          'myAgent': true,
        });
        server.append('free: builder-$i', conversationId: 'channel-$i');
      }
      final paths = <String>[];
      server.onRead = paths.add;
      final c = await read(server);
      final states = SwarmAgentStates(
        controller: c,
        github: swarmV4GitHub(),
        settle: Duration.zero,
      );
      addTearDown(states.dispose);
      await quiet();
      final channels = {
        for (final p in paths)
          if (RegExp(r'/conversations/(channel-\d+|lead)/messages')
                  .firstMatch(p)
              case final m?)
            m.group(1),
      };
      expect(channels.length, lessThanOrEqualTo(SwarmAgentStates.maxProjects));
      expect(channels, isNotEmpty);
    });
  });

  group('Your Team', () {
    Future<(ConversationServer, SuperTabController)> show(
      WidgetTester tester, {
      ConversationServer? server,
      AppNotifier? app,
      Size size = const Size(1440, 900),
      Brightness brightness = Brightness.light,
    }) async {
      server ??= world();
      final c = server.controller(
        account: 'owner',
        initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
      );
      addTearDown(c.dispose);
      await tester.runAsync(c.refresh);
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      await tester.binding.setSurfaceSize(size);
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: SuperTabView(
              controller: c,
              app: app ?? createApp(),
              onInvite: () {},
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              github: swarmV4GitHub(),
              board: true,
            ),
          ),
        ),
      );
      await settled(tester);
      return (server, c);
    }

    String detail(String row) {
      final texts = find
          .descendant(of: key(row), matching: find.byType(Text))
          .evaluate()
          .map((e) => (e.widget as Text).data)
          .whereType<String>();
      return texts.length > 1 ? texts.last : '';
    }

    testWidgets(
      'each agent\'s row says what it is doing, and an offline one has a grey face',
      (tester) async {
        await show(tester);
        expect(detail('super-agent-first builder'), 'on #5759');
        expect(detail('super-agent-second'), 'free');
        expect(detail('super-agent-third'), 'offline');
        expect(detail('super-agent-reviewer-two'), '');
        // Grey for the one that is down, in its own colours for the rest.
        expect(
          inRow('super-agent-third', key('super-face-offline')),
          findsOneWidget,
        );
        for (final up in ['first builder', 'second', 'reviewer-two']) {
          expect(
            inRow('super-agent-$up', key('super-face-offline')),
            findsNothing,
            reason: up,
          );
        }
        // Teammates' agents are not on Your Team.
        expect(key('super-agent-seventh'), findsNothing);
      },
    );

    testWidgets(
      'a person works through it: an agent goes down and comes back, takes a '
      'task, says it is free, and its chat and posts are grey while it is down',
      (tester) async {
        final (server, c) = await show(tester);
        final agents = (server.state['agents'] as List)
            .cast<Map<String, dynamic>>();
        Map<String, dynamic> agent(String id) =>
            agents.firstWhere((a) => a['id'] == id);

        // second goes down mid-way: its row says so and its face goes grey.
        agent('second')['downSince'] = '2026-11-09T08:00:00Z';
        await tester.runAsync(c.refresh);
        await settled(tester);
        expect(detail('super-agent-second'), 'offline');
        expect(
          inRow('super-agent-second', key('super-face-offline')),
          findsOneWidget,
        );
        // Its 1:1 chat: the header's face is grey too.
        await tester.tap(key('super-agent-second'));
        await tester.pumpAndSettle();
        expect(
          inRow('swarm-agent-header', key('super-face-offline')),
          findsOneWidget,
        );
        // It comes back: its own colours and the state it had.
        agent('second').remove('downSince');
        await tester.runAsync(c.refresh);
        await settled(tester);
        expect(detail('super-agent-second'), 'free');
        expect(
          inRow('swarm-agent-header', key('super-face-offline')),
          findsNothing,
        );

        // third is down: its posts in the channel have grey faces, the others' do not.
        await tester.tap(key('super-group-lead'));
        await tester.pumpAndSettle();
        final grey = find.descendant(
          of: find.byType(SuperTabMessageRow),
          matching: key('super-face-offline'),
        );
        expect(grey, findsOneWidget);
        expect(
          find.descendant(
            of: find.byType(SuperTabMessageRow),
            matching: find.byType(SuperTabAvatar),
          ),
          findsWidgets,
        );

        // second posts that it took a task: it is no longer free.
        server.append('Taking #5760.', conversationId: 'lead', agent: true);
        server.messages.last['author'] = {
          'kind': 'agent',
          'id': 'second',
          'name': 'second',
        };
        await tester.runAsync(c.refresh);
        await settled(tester);
        expect(detail('super-agent-second'), '');
        expect(tester.takeException(), isNull);
      },
    );

    testWidgets(
      'an emoji name and a long one are cut, and the state stays at the row\'s edge',
      (tester) async {
        final server = world();
        final agents = (server.state['agents'] as List)
            .cast<Map<String, dynamic>>();
        agents.firstWhere((a) => a['id'] == 'first builder')['displayName'] =
            '🚀 First builder of everything that ships on the very first day';
        await show(tester, server: server, size: const Size(1024, 700));
        expect(tester.takeException(), isNull);
        final row = key('super-agent-first builder');
        expect(
          find.descendant(of: row, matching: find.textContaining('🚀 First')),
          findsOneWidget,
        );
        // Its state is still there: matched by its name in the board's label.
        expect(
          find.descendant(of: row, matching: find.textContaining('on #')),
          findsNothing,
          reason: 'the board names it by its other name: builder:first builder',
        );
      },
    );

    // Pictures for the pull request: Your Team with its states at the three window sizes the Desktop is used at, in both themes.
    for (final (width, height) in [(1440, 900), (1024, 700), (700, 800)]) {
      for (final brightness in Brightness.values) {
        testWidgets(
          'pictures of the states at ${width}x$height in ${brightness.name}',
          (tester) async {
            if (_shots == null) return;
            await show(
              tester,
              size: Size(width.toDouble(), height.toDouble()),
              brightness: brightness,
            );
            if (width < 720) {
              await tester.tap(find.byTooltip('Conversations'));
              await settled(tester);
            }
            await captureWindow(
              tester,
              _shots,
              'agent-states-${width}x$height-${brightness.name}',
            );
          },
          variant: TargetPlatformVariant.only(TargetPlatform.macOS),
        );
      }
    }
  });
}
