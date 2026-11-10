import 'dart:async';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/agent_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/github_issues.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/message_row.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
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

  /// [who]'s post in the Swarm's channel; a reply in [thread] (a message's id) when it has one.
  void say(
    ConversationServer server,
    String who,
    String text, {
    String? thread,
  }) {
    server.append(text, conversationId: 'lead', agent: true);
    server.messages.last['author'] = {'kind': 'agent', 'id': who, 'name': who};
    if (thread != null) server.messages.last['thread'] = thread;
  }

  /// lampOS's Swarm (the person is Dee: first builder is their PM, second and third their builders, reviewer-two their
  /// reader), with `third` offline, a free post of `second`'s, and `reviewer-two`'s latest post not a free one. The fake `gh`
  /// has `first builder` on #5759.
  ConversationServer world() {
    final server = swarmV4Server();
    final agents = (server.state['agents'] as List)
        .cast<Map<String, dynamic>>();
    agents.firstWhere((a) => a['id'] == 'third')['downSince'] =
        '2026-11-09T05:00:00Z';
    say(server, 'third', 'Read posted on #3913: no source P1.');
    say(server, 'second', 'free: second');
    say(server, 'reviewer-two', 'free: reviewer-two');
    say(server, 'reviewer-two', 'Taking #3543 next.');
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

  /// Waits until [states] has nothing waiting to start and nothing being read: what the last change asked for is done.
  Future<void> idle(SwarmAgentStates states) async {
    for (var turn = 0; states.busy && turn < 5000; turn++) {
      await Future<void>.delayed(Duration.zero);
    }
    expect(states.busy, isFalse, reason: 'the reader never rested');
  }

  /// Waits for [done], at most five seconds.
  Future<void> until(bool Function() done) async {
    for (var i = 0; i < 500 && !done(); i++) {
      await Future<void>.delayed(const Duration(milliseconds: 10));
    }
    expect(done(), isTrue, reason: 'it did not happen in five seconds');
  }

  /// The reader of the view on screen settles and reads, and the rows draw what it found. A view with no reader, or whose left
  /// pane is a drawer not opened, has nothing to wait for. Each round lets real time pass too: a change made inside
  /// `runAsync` starts the reader's wait in real time.
  Future<void> settled(WidgetTester tester) async {
    final sidebar = find.byType(ProjectSidebar);
    bool busy() => switch (sidebar.evaluate().isEmpty
        ? null
        : tester.widget<ProjectSidebar>(sidebar).agentStates) {
      final states? => states.busy,
      null => false,
    };
    for (var round = 0; round < 100; round++) {
      await tester.runAsync(
        () => Future<void>.delayed(const Duration(milliseconds: 20)),
      );
      await tester.pump(const Duration(milliseconds: 500));
      if (!busy()) {
        // What the last frame asked for in turn (a read mark saved a moment later) is done too.
        await tester.pump(const Duration(milliseconds: 500));
        return;
      }
    }
    fail('the reader never rested');
  }

  int channelReads(List<String> paths) =>
      paths.where((p) => p.contains('/conversations/lead/messages')).length;

  group('the reader', () {
    SwarmAgentStates reader(
      SuperTabController c, {
      SwarmGitHub? github,
      Duration? boardEvery = const Duration(minutes: 1),
    }) {
      final states = SwarmAgentStates(
        controller: c,
        github: github ?? swarmV4GitHub(),
        boardEvery: boardEvery,
        settle: Duration.zero,
      );
      addTearDown(states.dispose);
      return states;
    }

    String? stateOf(
      SwarmAgentStates states,
      SuperTabController c,
      String agent,
    ) => states.of(c.snapshot!.agent(agent)!);

    test(
      'says offline before on #N before free, and nothing for the rest',
      () async {
        final c = await read(world());
        final states = reader(c);
        await idle(states);
        // Their PM is on a task the board says it took; second's last post said it is free; third is down.
        expect(stateOf(states, c, 'first builder'), 'on #5759');
        expect(stateOf(states, c, 'second'), 'free');
        expect(stateOf(states, c, 'third'), 'offline');
        // reviewer-two posted that it was free, then took something else: its latest post decides.
        expect(stateOf(states, c, 'reviewer-two'), isNull);
      },
    );

    test(
      'an agent that holds a task is not free, and a down one is only offline',
      () async {
        final server = world();
        // first builder says it is free too; second is down.
        say(server, 'first builder', 'free: first builder');
        final agents = (server.state['agents'] as List)
            .cast<Map<String, dynamic>>();
        agents.firstWhere((a) => a['id'] == 'second')['downSince'] =
            '2026-11-09T06:00:00Z';
        final c = await read(server);
        final states = reader(c);
        await idle(states);
        expect(stateOf(states, c, 'first builder'), 'on #5759');
        expect(stateOf(states, c, 'second'), 'offline');
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
          final states = reader(c, github: swarmV4GitHub(calls: calls));
          await idle(states);
          expect(channelReads(paths), 1);
          expect(calls, hasLength(1));
          final before = (channelReads(paths), calls.length);

          // The Swarm changes in ways that leave the channel and the board as they were: nothing more is read.
          await c.refresh();
          await c.refresh();
          await idle(states);
          expect((channelReads(paths), calls.length), before);

          // second takes a task: its next post is read, from where the last one ended.
          say(server, 'second', 'Taking #5760.');
          await c.refresh();
          await idle(states);
          expect(channelReads(paths), 2);
          expect(
            paths.where(
              (p) => p.contains('/conversations/lead/messages?after='),
            ),
            hasLength(1),
          );
          expect(stateOf(states, c, 'second'), isNull);
          expect(
            calls.length,
            before.$2,
            reason: 'the board is not read again within its minute',
          );

          // A minute later the board is asked again; the channel, unmoved, is not.
          now = now.add(const Duration(minutes: 2));
          await c.refresh();
          await idle(states);
          expect(calls.length, before.$2 + 1);
          expect(channelReads(paths), 2);
        });
      },
    );

    test(
      'a board is read again when its time is up, with nothing else asking',
      () async {
        final c = await read(world());
        final calls = <List<String>>[];
        final states = reader(
          c,
          github: swarmV4GitHub(calls: calls),
          boardEvery: const Duration(milliseconds: 60),
        );
        await idle(states);
        expect(calls, hasLength(1));
        await until(() => calls.length >= 2);
      },
    );

    test('a board is read once when it has no time', () async {
      final c = await read(world());
      final calls = <List<String>>[];
      final states = reader(
        c,
        github: swarmV4GitHub(calls: calls),
        boardEvery: null,
      );
      await idle(states);
      // The Swarm moves on and on: the board, with no time of its own, is not asked again.
      for (var i = 0; i < 3; i++) {
        await c.refresh();
        await idle(states);
      }
      expect(calls, hasLength(1));
    });

    test('a reply in a thread is not an agent\'s latest word, unless it is also in the chat', () async {
      final server = world();
      final free =
          server.messages.firstWhere((m) => m['text'] == 'free: second')['id']
              as String;
      final c = await read(server);
      final states = reader(c);
      await idle(states);
      expect(stateOf(states, c, 'second'), 'free');
      // It answers someone in a thread under its post: nothing changed in what it is doing, as the channel shows it.
      say(server, 'second', 'Taking #5760.', thread: free);
      await c.refresh();
      await idle(states);
      expect(stateOf(states, c, 'second'), 'free');
      // The same reply, shown in the chat too, is as good as a post.
      say(server, 'second', 'Taking #5761.', thread: free);
      server.messages.last['alsoInChat'] = true;
      await c.refresh();
      await idle(states);
      expect(stateOf(states, c, 'second'), isNull);
    });

    test('more posts than a page since the last read: the latest page says where things stand', () async {
      final server = world();
      final paths = <String>[];
      server.onRead = paths.add;
      final c = await read(server);
      final states = reader(c);
      await idle(states);
      expect(stateOf(states, c, 'second'), 'free');
      expect(stateOf(states, c, 'reviewer-two'), isNull);
      // Three posts come at a page of two: the page after the last read ends before the third, which is where
      // reviewer-two stopped being free.
      server.messagePage = 2;
      say(server, 'reviewer-two', 'free: reviewer-two');
      say(server, 'second', 'free: second');
      say(server, 'reviewer-two', 'Taking #3600.');
      await c.refresh();
      await idle(states);
      expect(stateOf(states, c, 'reviewer-two'), isNull);
      expect(stateOf(states, c, 'second'), 'free');
      final reads = paths.where(
        (p) => p.contains('/conversations/lead/messages'),
      );
      expect(reads.where((p) => p.contains('?after=')), hasLength(1));
      expect(reads.where((p) => !p.contains('?after=')), hasLength(2));
      // The channel is read to its end: nothing more is asked while it stands.
      await c.refresh();
      await idle(states);
      expect(channelReads(paths), 3);
    });

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
        final states = reader(c, github: swarmV4GitHub(calls: calls));
        await idle(states);
        expect(calls, isEmpty);
        expect(channelReads(paths), 0);
      },
    );

    test('a folded Your Team reads nothing, and opening it reads', () async {
      final server = world();
      final paths = <String>[];
      server.onRead = paths.add;
      final c = await read(server);
      c.toggleAgentsGroup();
      expect(c.agentsGroupOpen, isFalse);
      final calls = <List<String>>[];
      final states = reader(c, github: swarmV4GitHub(calls: calls));
      await idle(states);
      await c.refresh();
      await idle(states);
      expect(calls, isEmpty);
      expect(channelReads(paths), 0);
      expect(stateOf(states, c, 'second'), isNull);
      c.toggleAgentsGroup();
      await idle(states);
      expect(calls, hasLength(1));
      expect(channelReads(paths), 1);
      expect(stateOf(states, c, 'second'), 'free');
    });

    test('a Swarm that is not on screen reads nothing until it is', () async {
      final server = world();
      final paths = <String>[];
      server.onRead = paths.add;
      final c = await read(server);
      c.away = true;
      final states = reader(c);
      await idle(states);
      await c.refresh();
      await idle(states);
      expect(channelReads(paths), 0);
      c.away = false;
      await c.refresh();
      await idle(states);
      expect(channelReads(paths), 1);
      expect(stateOf(states, c, 'second'), 'free');
    });

    test('what was read of a project the person\'s agents left is forgotten: it is read as new when they come back', () async {
      final server = world();
      final paths = <String>[];
      server.onRead = paths.add;
      final c = await read(server);
      final states = reader(c);
      await idle(states);
      expect(channelReads(paths), 1);
      expect(stateOf(states, c, 'second'), 'free');
      final agents = (server.state['agents'] as List)
          .cast<Map<String, dynamic>>();
      final own = agents.where((a) => a['myAgent'] == true).toList();
      agents.removeWhere((a) => a['myAgent'] == true);
      await c.refresh();
      await idle(states);
      expect(channelReads(paths), 1, reason: 'nothing is read for no agents');
      agents.addAll(own);
      await c.refresh();
      await idle(states);
      expect(channelReads(paths), 2);
      expect(stateOf(states, c, 'second'), 'free');
    });

    test('a board that cannot be read leaves the other states alone', () async {
      final c = await read(world());
      final states = reader(
        c,
        github: SwarmGitHub(
          run: (_) async => ProcessResult(1, 1, '', 'gh auth login'),
        ),
      );
      await idle(states);
      expect(stateOf(states, c, 'first builder'), isNull);
      expect(stateOf(states, c, 'second'), 'free');
      expect(stateOf(states, c, 'third'), 'offline');
    });

    test('a channel that cannot be read shows nothing for it, and is asked again after a wait', () async {
      final server = world();
      var down = true;
      final paths = <String>[];
      server.onRead = (path) {
        paths.add(path);
        if (down && path.contains('/conversations/lead/messages')) {
          throw StateError('Offline');
        }
      };
      final c = await read(server);
      var now = DateTime(2026, 11, 9, 9);
      await withClock(Clock(() => now), () async {
        final states = reader(c);
        await idle(states);
        expect(channelReads(paths), 1);
        expect(stateOf(states, c, 'second'), isNull);
        // What does not need the channel is as it was.
        expect(stateOf(states, c, 'first builder'), 'on #5759');
        expect(stateOf(states, c, 'third'), 'offline');
        // The Swarm moves on: within the wait the channel is not asked again.
        say(server, 'second', 'free: second');
        await c.refresh();
        await idle(states);
        expect(channelReads(paths), 1);
        // After it, it is; and what it says shows.
        down = false;
        now = now.add(const Duration(minutes: 2));
        await c.refresh();
        await idle(states);
        expect(channelReads(paths), 2);
        expect(stateOf(states, c, 'second'), 'free');
      });
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
        settle: Duration.zero,
      );
      states.dispose();
      expect(states.busy, isFalse);
      // A few turns of the event loop: a read still due would have started in them.
      for (var turn = 0; turn < 20; turn++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(calls, isEmpty);
      expect(channelReads(paths), 0);
    });

    test('disposed while it reads, it reads nothing more', () async {
      final server = world();
      final c = await read(server);
      final calls = <List<String>>[];
      final hold = Completer<void>();
      server.holdReads = hold;
      final states = SwarmAgentStates(
        controller: c,
        github: swarmV4GitHub(calls: calls),
        settle: Duration.zero,
      );
      await until(() => states.busy);
      states.dispose();
      server.holdReads = null;
      hold.complete();
      for (var turn = 0; turn < 50 && calls.isEmpty; turn++) {
        await Future<void>.delayed(Duration.zero);
      }
      expect(calls, isEmpty, reason: 'its board is not read after it ended');
      expect(states.busy, isFalse);
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
      final states = reader(c);
      await idle(states);
      expect(stateOf(states, c, 'second'), 'free');
      final second = (server.state['agents'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((a) => a['id'] == 'second');
      second['downSince'] = '2026-11-09T08:00:00Z';
      await c.refresh();
      expect(stateOf(states, c, 'second'), 'offline');
      second.remove('downSince');
      await c.refresh();
      expect(stateOf(states, c, 'second'), 'free');
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
      final states = reader(c, github: swarmV4GitHub(calls: calls));
      await idle(states);
      expect(calls, hasLength(1));
      expect(stateOf(states, c, 'first builder'), 'on #5759');
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
      final states = reader(c);
      await idle(states);
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
      bool withApp = true,
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
              app: withApp ? createApp() : null,
              onAddAgent: (_) {},
              onOpenTerminal: (_) {},
              machineName: (_) => 'Mac Studio',
              github: swarmV4GitHub(),
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
      'with no app to read with, an agent that is down still says offline and the rest say nothing',
      (tester) async {
        await show(tester, withApp: false);
        expect(detail('super-agent-third'), 'offline');
        expect(
          inRow('super-agent-third', key('super-face-offline')),
          findsOneWidget,
        );
        for (final other in ['first builder', 'second', 'reviewer-two']) {
          expect(detail('super-agent-$other'), '', reason: other);
        }
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
        say(server, 'second', 'Taking #5760.');
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
