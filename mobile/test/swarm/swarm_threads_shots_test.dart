import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_threads_page.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Threads on the phone: Home's Threads row (new
/// replies, then read), Activity's top bar, the Threads page and a chat whose
/// followed thread says New, at 390 wide in both phone themes, with the app's
/// own fonts, from made-up data only, to the folder `SWARM_THREADS_SHOTS`
/// names.
final shots = Platform.environment['SWARM_THREADS_SHOTS'];
void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFontMonospaced', 'monospace']) {
      await (FontLoader(family)..addFont(Future.value(mono))).load();
    }
    final manifest =
        jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
    for (final entry in manifest.cast<Map<String, dynamic>>()) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in (entry['fonts'] as List).cast<Map>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  });

  const path = '/api/super-tabs/$tab';
  final now = DateTime.utc(2026, 11, 1, 9, 41);

  Map<String, dynamic> who(String id, String name) => {
    'kind': 'agent',
    'id': id,
    'name': name,
  };

  Map<String, dynamic> row(
    String chat,
    String root, {
    required Map<String, dynamic> author,
    required String text,
    required DateTime last,
    int unread = 0,
    int replies = 2,
  }) => {
    'conversationId': chat,
    'rootId': root,
    'root': {
      'id': root,
      'sequence': 1,
      'author': author,
      'text': text,
      'createdAt': last.subtract(const Duration(minutes: 40)).toIso8601String(),
    },
    'lastReplyAt': last.toIso8601String(),
    'lastReplySequence': 20,
    'unreadReplies': unread,
    'replies': replies,
    'follow': true,
  };

  Map<String, dynamic> reply(
    String id,
    int sequence,
    Map<String, dynamic> author,
    String text,
  ) => {
    'id': id,
    'conversationId': 'fix-login',
    'text': text,
    'sequence': sequence,
    'thread': 'm1',
    'author': author,
    'createdAt': now
        .subtract(Duration(minutes: 20 - sequence))
        .toIso8601String(),
  };

  /// [load] with each chat last changed a few minutes before [now].
  Map<String, dynamic> withTimes(Map<String, dynamic> load) => {
    ...load,
    'groups': [
      for (final g in load['groups'] as List)
        {
          ...g as Map<String, dynamic>,
          'changedAt': now
              .subtract(const Duration(minutes: 2))
              .millisecondsSinceEpoch,
        },
    ],
  };

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'autonomous.ai', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['$path/parts'] = (_) => {
      ...withTimes(
        firstLoad(
          head: headData(name: 'autonomous.ai'),
          groups: [
            groupData(leadChat, title: 'Mobile', lastMessageSequence: 9),
            groupData('fix-login', title: 'fix-login', lastMessageSequence: 21),
            groupData('api', title: 'api', lastMessageSequence: 20),
          ],
          agents: [
            agent('agent-lead', name: 'Lead', displayName: 'River'),
            agent('agent-builder', displayName: 'Nova'),
          ],
          derived: {
            'readMarks': {leadChat: 9, 'fix-login': 21, 'api': 20},
            'mentionsWaiting': 1,
          },
        ),
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['$path/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['$path/decisions'] = (_) => {'decisions': <Object>[]};
    fake.routes['$path/mentions'] = (_) => {
      'mentions': [
        {
          'id': 'tag-1',
          'projectId': project,
          'projectName': 'Mobile',
          'conversationId': 'fix-login',
          'conversationTitle': 'fix-login',
          'messageId': 'r19',
          'leadName': 'River',
          'text': '@me can you check this on the phone?',
          'createdAt': now.toIso8601String(),
          'threadId': 'm1',
          'messageSequence': 19,
        },
      ],
    };
    fake.routes['$path/threads'] = (_) => {
      'unread': [
        row(
          'fix-login',
          'm1',
          author: who('agent-builder', 'Nova'),
          text: 'Can we retry the token refresh once before signing out?',
          last: now.subtract(const Duration(minutes: 2)),
          unread: 2,
          replies: 5,
        ),
      ],
      'read': [
        row(
          'api',
          'm2',
          author: who('agent-lead', 'River'),
          text: 'Rate limits on the threads route: 30 reads a minute is fine.',
          last: now.subtract(const Duration(hours: 2)),
          replies: 4,
        ),
        row(
          'fix-login',
          'm3',
          author: who('agent-builder', 'Nova'),
          text: 'Screenshots for the sign-in error are in the PR.',
          last: now.subtract(const Duration(days: 1)),
          replies: 1,
        ),
      ],
      'more': false,
    };
    fake.routes['$path/conversations/'] = (_) => {'ok': true};
    fake.routes['$path/conversations/fix-login/messages?thread=m1'] = (_) => {
      'messages': [
        reply(
          'r20',
          20,
          who('agent-builder', 'Nova'),
          'Agreed. I will add a test for the second failure.',
        ),
        reply(
          'r19',
          19,
          who('agent-lead', 'River'),
          'Retry once, then sign out. @me can you check this on the phone?',
        ),
      ],
    };
    fake.routes['$path/conversations/fix-login/messages'] = (_) => {
      'messages': [
        {
          ...reply(
            'm4',
            21,
            who('agent-lead', 'River'),
            'Pushed the retry. Login is green on CI.',
          ),
          'thread': 'm4',
        },
        {
          ...reply(
            'm1',
            1,
            who('agent-builder', 'Nova'),
            'Can we retry the token refresh once before signing out?',
          ),
          'createdAt': now
              .subtract(const Duration(minutes: 40))
              .toIso8601String(),
        },
      ],
      'next': null,
      'threads': [
        {
          'id': 'm1',
          'replies': 5,
          'lastSequence': 20,
          'lastAt': now.subtract(const Duration(minutes: 2)).toIso8601String(),
          'authors': [
            who('agent-builder', 'Nova'),
            who('agent-lead', 'River'),
          ],
          'people': <String>[],
        },
      ],
    };
    fake.routes['$path/conversations/$leadChat/messages'] = (_) => {
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  testWidgets('Home\'s Threads row, Activity, the Threads page and New', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final boundary = GlobalKey();
      Future<void> capture(String name) => tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/threads-$name-390-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: backend().request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      // Home names Threads in a row of its own (anh Dee, 2026-11-06:
      // Activity's unlabelled button was missed).
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            key: const ValueKey('home'),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const SwarmPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('swarm-threads-row')), findsOneWidget);
      expect(
        find.byKey(const ValueKey('swarm-threads-unread')),
        findsOneWidget,
      );
      await capture('home');

      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            key: const ValueKey('chat'),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const SwarmConversationPage(
              swarmId: tab,
              conversationId: 'fix-login',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('swarm-thread-new-m1')), findsOneWidget);
      await capture('chat-new');

      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            onGenerateRoute: (_) => CupertinoPageRoute<void>(
              builder: (_) => const Scaffold(body: SwarmActivityView()),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(
        find.byKey(const ValueKey('swarm-activity-threads')),
        findsNothing,
      );
      await capture('activity');

      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            key: const ValueKey('threads-page'),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: SwarmThreadsPage(now: () => now),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('2 new replies'), findsOneWidget);
      await capture('page');

      // Read past the newest reply: the row goes quiet, the chat's line
      // says when the last came.
      host.session!.inbox
          .reader(tab)!
          .readMarks!
          .markThreadRead('fix-login', 'm1', 20);
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            key: const ValueKey('home-read'),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const SwarmPage(),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('swarm-threads-unread')), findsNothing);
      await capture('home-read');

      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            key: const ValueKey('chat-read'),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const SwarmConversationPage(
              swarmId: tab,
              conversationId: 'fix-login',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('swarm-thread-new-m1')), findsNothing);
      await capture('chat-read');

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 30));
      host.dispose();
    }
    await tester.binding.setSurfaceSize(null);
    tester.view.resetPadding();
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}
