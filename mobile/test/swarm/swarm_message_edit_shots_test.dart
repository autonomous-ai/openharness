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
import 'package:harness_mobile/swarm/swarm_chat_cache.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of editing and deleting your own message (task #2746):
/// the long-press sheet with Edit message and Delete message, the edit
/// sheet, the delete question, and the chat with an "(edited)" row and a
/// deleted root that keeps its thread. On a 390-point phone in both phone
/// themes, from made-up data only, to the folder `SWARM_MESSAGE_EDIT_SHOTS`
/// names.
final shots = Platform.environment['SWARM_MESSAGE_EDIT_SHOTS'];

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

  Map<String, dynamic> row(
    String id,
    int sequence,
    String text, {
    String author = me,
    String? thread,
    String? editedAt,
    String? deletedAt,
  }) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'thread': ?thread,
    'editedAt': ?editedAt,
    'deletedAt': ?deletedAt,
    'author': author == me
        ? {'kind': 'person', 'id': me, 'name': 'tony'}
        : {'kind': 'agent', 'id': author, 'name': 'River'},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 11, 4, 1, sequence).toIso8601String(),
  };

  testWidgets('Edit message, Delete message and the rows they leave, in both '
      'phone themes', (tester) async {
    addTearDown(tester.view.reset);
    addTearDown(SwarmChatCache.clear);
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(SystemChannels.platform, (_) async => null);
    addTearDown(
      () => TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
          .setMockMethodCallHandler(SystemChannels.platform, null),
    );
    debugDisableShadows = false;
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    addTearDown(tester.view.resetPadding);
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      SwarmChatCache.clear();
      const size = Size(390, 844);
      tester.view
        ..physicalSize = size * 3
        ..devicePixelRatio = 3;
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Autonomous', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [
            groupData(
              'g1',
              title: 'Fix login flake',
              number: 7,
              agentIds: ['agent-lead'],
              lastMessageSequence: 4,
            ),
          ],
        ),
        'members': [part(me, 1, person(me))],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes[messages] = (_) => {
        'messages': [
          row(
            'm4',
            4,
            'Can we ship the retry fix today? The flake shows on every '
                'third run.',
          ),
          row(
            'm3',
            3,
            'The login test waits for the banner now.',
            editedAt: DateTime.utc(2026, 11, 4, 2).toIso8601String(),
          ),
          row(
            'm2',
            2,
            'This message was deleted.',
            thread: 'm2',
            deletedAt: DateTime.utc(2026, 11, 4, 2).toIso8601String(),
          ),
          row('m1', 1, 'Looking at the CI logs.', author: 'agent-lead'),
        ],
        'next': null,
        'reactionSeq': 0,
        'threads': [
          {
            'id': 'm2',
            'replies': 2,
            'lastSequence': 4,
            'lastAt': DateTime.utc(2026, 11, 4, 1, 4).toIso8601String(),
            'authors': [
              {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
            ],
            'people': <String>[],
          },
        ],
      };
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
        'result': {'changed': true},
      };
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
      )..foreground = false;
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: const Scaffold(
              body: SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> capture(String name) async {
        await tester.runAsync(() async {
          final image =
              await (boundary.currentContext!.findRenderObject()!
                      as RenderRepaintBoundary)
                  .toImage(pixelRatio: 3);
          final png = await image.toByteData(format: ui.ImageByteFormat.png);
          await File('$shots/message-edit-390-$name-${brightness.name}.png')
              .writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
      }

      expect(find.text('(edited)'), findsOneWidget);
      expect(find.text('This message was deleted.'), findsOneWidget);
      await capture('rows');

      await tester.longPress(find.textContaining('ship the retry fix'));
      await tester.pumpAndSettle();
      expect(find.text('Edit message'), findsOneWidget);
      await capture('sheet');

      await tester.tap(find.byKey(const ValueKey('swarm-edit-message')));
      await tester.pumpAndSettle();
      expect(find.byKey(const ValueKey('swarm-edit-field')), findsOneWidget);
      await capture('edit');
      await tester.tap(find.byKey(const ValueKey('swarm-edit-cancel')));
      await tester.pumpAndSettle();

      await tester.longPress(find.textContaining('ship the retry fix'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('swarm-delete-message')));
      await tester.pumpAndSettle();
      expect(find.text('Delete message?'), findsOneWidget);
      await capture('delete');
      await tester.tap(find.widgetWithText(FilledButton, 'Cancel'));
      await tester.pumpAndSettle();
      expect(fake.commands, isEmpty);

      await tester.pumpWidget(const SizedBox());
      host.dispose();
    }
    debugDisableShadows = true;
  }, skip: shots == null);
}
