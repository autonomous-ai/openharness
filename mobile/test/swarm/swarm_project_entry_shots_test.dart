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
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of a project opened the way the app opens it: from
/// Swarm Home's row, and from a chat (the PM's line in the person's Buddy
/// chat, answered in #Mobile). Both land on Swarm Home C's project screen.
/// On a 390-point phone in both phone themes, from made-up data only, to
/// the folder `SWARM_PROJECT_ENTRY_SHOTS` names.
final shots = Platform.environment['SWARM_PROJECT_ENTRY_SHOTS'];
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

  testWidgets('a project opened from Home and from a chat, in both phone '
      'themes', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    // An iPhone's status bar and home indicator.
    tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
    addTearDown(tester.view.resetPadding);
    const buddyChat = 'buddy-me';
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final now = DateTime.now().toUtc();
      Map<String, dynamic> said(
        String chat,
        String id,
        int sequence,
        String text, {
        String author = 'agent-lead',
        String name = 'River',
        int minutesAgo = 10,
      }) => {
        'id': id,
        'conversationId': chat,
        'text': text,
        'sequence': sequence,
        'author': {'kind': 'agent', 'id': author, 'name': name},
        'attachments': <Object>[],
        'reactions': <Object>[],
        'createdAt': now
            .subtract(Duration(minutes: minutesAgo))
            .toIso8601String(),
      };
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          agents: [
            agent('agent-lead', name: 'Lead', displayName: 'River'),
            agent('agent-builder', displayName: 'Nova'),
            buddyData('agent-wren', displayName: 'Wren'),
          ],
          groups: [
            groupData(
              'g1',
              title: 'Home C from every entry point',
              number: 2297,
              agentIds: ['agent-lead', 'agent-builder'],
              status: 'working',
              workerId: 'agent-builder',
              lastMessageSequence: 2,
            ),
            buddyChatData(
              buddyChat,
              agentIds: ['agent-wren'],
              lastMessageSequence: 2,
            ),
          ],
        ),
        'members': [
          part(me, 1, person(me)),
          part('diego', 1, person('diego', role: 'collaborator')),
        ],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/conversations/'] = (_) => {
        'messages': <Object>[],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/conversations/$leadChat/messages'] =
          (_) => {
            'messages': [
              said(
                leadChat,
                'p2',
                2,
                'Nova is on #2297: every way into a project opens this '
                    'screen.',
                minutesAgo: 4,
              ),
              said(
                leadChat,
                'p1',
                1,
                'Morning all. TestFlight build goes out after #2297.',
                minutesAgo: 30,
              ),
            ],
            'next': null,
          };
      fake.routes['/api/super-tabs/$tab/conversations/$buddyChat/messages'] =
          (_) => {
            'messages': [
              said(
                buddyChat,
                'b2',
                2,
                'Should the TestFlight build wait for #2297?',
                minutesAgo: 6,
              ),
              said(
                buddyChat,
                'b1',
                1,
                'Your Home is up to date.',
                author: 'agent-wren',
                name: 'Wren',
                minutesAgo: 20,
              ),
            ],
            'next': null,
          };
      fake.routes['/api/super-tabs/$tab/commands'] = (_) => {
        'result': <String, dynamic>{},
      };
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => me,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            onGenerateRoute: (_) =>
                CupertinoPageRoute<void>(builder: (_) => const SwarmPage()),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> capture(String name) => tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/project-entry-$name-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      Finder key(String value) => find.byKey(ValueKey(value));

      // From Home: the project's row.
      await tester.tap(key('swarm-project-$tab-$project'));
      await tester.pumpAndSettle();
      expectHomeCProject('Mobile');
      await capture('from-home');
      await tester.tap(key('tty-back'));
      await tester.pumpAndSettle();

      // From a chat: the PM's line in the person's Buddy chat, answered in
      // the project.
      openSwarmConversation(
        tester.element(find.byType(SwarmPage)),
        tab,
        buddyChat,
      );
      await tester.pumpAndSettle();
      await capture('buddy-chat');
      await tester.tap(find.text('Answer in #Mobile'));
      await tester.pumpAndSettle();
      expectHomeCProject('Mobile');
      await capture('from-chat');

      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 30));
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}
