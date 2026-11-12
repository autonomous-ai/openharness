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
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';
import 'swarm_new_project_fixture.dart';

/// Review screenshots of Your Team on Home and of an agent's own chat under
/// its name and where it runs, in both phone themes at phone width, from
/// made-up data only, to `SWARM_TEAM_SHOTS`.
final shots = Platform.environment['SWARM_TEAM_SHOTS'];

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

  const web = 'project-2';
  const studyChat = 'chat-a-study';

  /// One of the person's agents, [name], on the Mac Studio, with its chat.
  Map<String, dynamic> mine(String id, String name, {String? kind}) => {
    ...agent(id, displayName: name, machineId: 'mac-studio'),
    'kind': ?kind,
    'chatId': 'chat-$id',
  };

  /// Mobile and Web; the person's Dale (Mobile's Product Manager), Devon,
  /// Nova and Study, Dale and Devon with something new; someone else's Theo.
  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
    final agents = [
      mine('a-dale', 'Dale', kind: 'pm'),
      mine('a-devon', 'Devon'),
      mine('a-nova', 'Nova'),
      mine('a-study', 'Study'),
      {
        ...agent('a-theo', displayName: 'Theo'),
        'contributorId': 'person-other',
      },
    ];
    const unread = {'a-dale', 'a-devon'};
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      head: headData(
        projects: [
          swarmProject(project, 'Mobile', repo: harnessRepo),
          swarmProject(web, 'Web'),
        ],
      ),
      agents: agents,
      machines: [
        {'machineId': 'mac-studio', 'name': 'Mac Studio'},
      ],
      groups: [
        {
          ...groupData('lead-$web', title: 'Web', lastMessageSequence: 2),
          'projectId': web,
        },
        for (final a in agents)
          if (a['chatId'] case final String chat)
            {
              ...groupData(
                chat,
                title: 'Chat',
                kind: 'agent-chat',
                agentIds: [a['id'] as String],
                lastMessageSequence: 2,
              ),
              'projectId': null,
            },
      ],
      derived: {
        'readMarks': {
          'lead-$web': 2,
          for (final a in agents)
            if (a['chatId'] case final String chat)
              chat: unread.contains(a['id']) ? 1 : 2,
        },
      },
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    final at = DateTime.now().toUtc();
    fake.routes['/api/super-tabs/$tab/conversations/$studyChat/messages'] =
        (_) => {
          'messages': [
            {
              'id': 'm1',
              'conversationId': studyChat,
              'text': 'Can you check the sign-in copy on the phone?',
              'sequence': 1,
              'author': {'kind': 'person', 'id': me, 'name': 'tony'},
              'createdAt': at
                  .subtract(const Duration(minutes: 3))
                  .toIso8601String(),
            },
            {
              'id': 'm2',
              'conversationId': studyChat,
              'text': 'On it. The button says "Sign in" on both screens now.',
              'sequence': 2,
              'author': {'kind': 'agent', 'id': 'a-study', 'name': 'Study'},
              'createdAt': at.toIso8601String(),
            },
          ],
          'next': null,
        };
    return fake;
  }

  testWidgets('Your Team and an agent chat, in both themes', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final shown = [
      for (final screen in ['home', 'agent-chat'])
        for (final palette in [HarnessPalette.graphite, HarnessPalette.paper])
          (screen, palette),
    ];
    for (final (screen, palette) in shown) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final fake = backend();
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        readMarks: MemoryKeyValueStore(),
      )..foreground = false;
      await tester.runAsync(() => host.session!.inbox.refresh());
      final boundary = GlobalKey();
      await tester.pumpWidget(
        RepaintBoundary(
          key: boundary,
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: buildAppTheme(brightness: brightness),
            builder: (_, child) => SwarmScope(notifier: host, child: child!),
            home: screen == 'home'
                // Half an hour after the fixture's parts last changed: no
                // project folds as quiet.
                ? SwarmPage(
                    now: () => DateTime.fromMillisecondsSinceEpoch(
                      0,
                      isUtc: true,
                    ).add(const Duration(minutes: 30)),
                  )
                : const SwarmConversationPage(
                    swarmId: tab,
                    conversationId: studyChat,
                  ),
          ),
        ),
      );
      for (var i = 0; i < 5; i++) {
        await tester.runAsync(pumpEventQueue);
        await tester.pump(const Duration(milliseconds: 100));
      }
      if (screen == 'home') {
        expect(find.text('Your Team'), findsOneWidget);
        expect(find.text('Theo'), findsNothing);
      } else {
        expect(find.text('Mac Studio · Claude Code'), findsOneWidget);
      }
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/your-team-$screen-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}
