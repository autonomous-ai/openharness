import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of find in the open chat on the phone (task #2826):
/// the chat with find at "2 of 5", its ⋮ with Find in chat, and a thread
/// with find. On a 390-point phone in both phone themes, from made-up data
/// only, to the folder `SWARM_FIND_SHOTS` names.
final shots = Platform.environment['SWARM_FIND_SHOTS'];
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in {
      '.AppleSystemUIFont',
      'Roboto',
      AppFont.sans,
      ...AppFont.sansFallback,
    }) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    // The chat's title is set in the terminal's face.
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    final terminal = terminalFontStore.value;
    for (final family in {
      '.AppleSystemUIFontMonospaced',
      'monospace',
      AppFont.mono,
      ...AppFont.monoFallback,
      terminal.fontFamily,
      ...terminal.fontFamilyFallback,
    }) {
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

  Map<String, dynamic> said(
    String id,
    int sequence,
    String text, {
    String author = 'agent-builder',
    String? thread,
  }) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'thread': ?thread,
    if (thread != null && thread != id) 'replyTo': thread,
    'author': author == me
        ? {'kind': 'person', 'id': me, 'name': 'tony'}
        : {
            'kind': 'agent',
            'id': author,
            'name': author == 'agent-lead' ? 'River' : 'Nova',
          },
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime(2026, 11, 4, 9, sequence * 3).toIso8601String(),
  };

  final chat = [
    said('m1', 1, 'Starting on the login fix.', author: 'agent-lead'),
    said('m2', 2, 'The deploy to staging failed on the migration step.'),
    said('m3', 3, 'Which migration?', author: me),
    said('m4', 4, 'The one that adds the session index.'),
    said('m5', 5, 'Retrying the deploy with the index built online.'),
    said('m6', 6, 'Tests pass locally.', author: 'agent-lead'),
    said('m7', 7, 'Deploy is green on staging now.'),
    said('m8', 8, 'Great, ship it behind the flag.', author: me),
    said('m9', 9, 'Production deploy starts at 10:30.', author: 'agent-lead'),
    said('m10', 10, 'Watching the dashboards.'),
    said('m11', 11, 'Deploy finished, error rate flat.'),
  ];

  final thread = [
    said('t1', 20, 'Lỗi đăng nhập trên iOS sau bản cập nhật', thread: 't1'),
    said('t2', 21, 'Tôi thấy lỗi ở bước xác thực.', thread: 't1'),
    said('t3', 22, 'Đã sửa, đang chờ review.', thread: 't1'),
    said('t4', 23, 'Còn lỗi nào nữa không?', thread: 't1', author: me),
  ];

  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Autonomous', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      groups: [
        groupData(
          'g1',
          title: 'Fix login flake',
          number: 7,
          agentIds: ['agent-lead', 'agent-builder'],
          lastMessageSequence: 23,
        ),
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    final line = {
      'id': 't1',
      'replies': 3,
      'lastSequence': 23,
      'lastAt': DateTime(2026, 11, 4, 10, 9).toIso8601String(),
      'authors': [
        {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
      ],
      'people': [me],
    };
    fake.routes[messages] = (_) => {
      'messages': [thread.first, ...chat.reversed],
      'next': null,
      'threads': [line],
    };
    fake.routes['$messages?thread=t1'] = (_) => {
      'messages': thread.reversed.toList(),
      'next': null,
      'threads': [line],
    };
    return fake;
  }

  testWidgets('find in the chat, its ⋮ and a thread, in both phone themes', (
    tester,
  ) async {
    addTearDown(tester.view.reset);
    debugDisableShadows = false;
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    addTearDown(tester.view.resetPadding);
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      const size = Size(390, 844);
      tester.view
        ..physicalSize = size * 3
        ..devicePixelRatio = 3;
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: backend().request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
      )..foreground = false;
      final boundary = GlobalKey();
      Future<void> show({String? threadId}) async {
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildAppTheme(brightness: brightness),
              builder: (_, child) => SwarmScope(notifier: host, child: child!),
              home: SwarmConversationPage(
                key: ValueKey('shot-$threadId'),
                swarmId: tab,
                conversationId: 'g1',
                messageId: threadId,
                threadId: threadId,
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
      }

      Future<void> capture(String name) async {
        if (shots == null) return;
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File('$shots/find-in-chat-390-$name-${brightness.name}.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
      }

      Finder key(String value) => find.byKey(ValueKey(value));

      await show();
      await tester.tap(key('swarm-chat-menu'));
      await tester.pumpAndSettle();
      expect(find.text('Find in chat'), findsOneWidget);
      await capture('menu');
      await tester.tap(find.text('Find in chat'));
      await tester.pumpAndSettle();
      await tester.enterText(key('swarm-find-field'), 'deploy');
      await tester.pumpAndSettle();
      await tester.tap(key('swarm-find-older'));
      await tester.pumpAndSettle();
      expect(find.text('2 of 5'), findsOneWidget);
      await capture('chat');

      await show(threadId: 't1');
      await tester.tap(key('swarm-thread-find'));
      await tester.pumpAndSettle();
      await tester.enterText(key('swarm-find-field'), 'loi');
      await tester.pumpAndSettle();
      expect(find.text('1 of 3'), findsOneWidget);
      await capture('thread');

      await tester.pumpWidget(const SizedBox());
      host.dispose();
    }
    debugDisableShadows = true;
  }, skip: shots == null);
}
