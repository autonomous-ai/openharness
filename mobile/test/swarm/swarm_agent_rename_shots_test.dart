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

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of Rename agent in a person's own chat with their
/// agent: the dialog its name opens, and ⋮ with Rename, in both phone themes
/// at phone width, from made-up data only, to `SWARM_AGENT_RENAME_SHOTS`.
final shots = Platform.environment['SWARM_AGENT_RENAME_SHOTS'];

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

  const chat = 'chat-nova';

  /// The person's Nova on the Mac Studio, with its own chat and two
  /// messages in it.
  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      agents: [
        agent('agent-lead', name: 'Lead', displayName: 'River'),
        {
          ...agent('agent-nova', displayName: 'Nova', machineId: 'mac-studio'),
          'chatId': chat,
        },
      ],
      machines: [
        {'machineId': 'mac-studio', 'name': 'Mac Studio'},
      ],
      groups: [
        {
          ...groupData(
            chat,
            title: 'Chat',
            kind: 'agent-chat',
            agentIds: ['agent-nova'],
            lastMessageSequence: 2,
            audience: [me],
          ),
          'projectId': null,
        },
      ],
      derived: {
        'readMarks': {chat: 2},
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
    fake.routes['/api/super-tabs/$tab/conversations/$chat/messages'] = (_) => {
      'messages': [
        {
          'id': 'm1',
          'conversationId': chat,
          'text': 'Can you check the sign-in copy on the phone?',
          'sequence': 1,
          'author': {'kind': 'person', 'id': me, 'name': 'tony'},
          'createdAt': at
              .subtract(const Duration(minutes: 3))
              .toIso8601String(),
        },
        {
          'id': 'm2',
          'conversationId': chat,
          'text': 'On it. The button says "Sign in" on both screens now.',
          'sequence': 2,
          'author': {'kind': 'agent', 'id': 'agent-nova', 'name': 'Nova'},
          'createdAt': at.toIso8601String(),
        },
      ],
      'next': null,
    };
    return fake;
  }

  testWidgets('Rename agent, in both themes', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final shown = [
      for (final screen in ['dialog', 'menu'])
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
            home: const SwarmConversationPage(
              swarmId: tab,
              conversationId: chat,
            ),
          ),
        ),
      );
      for (var i = 0; i < 5; i++) {
        await tester.runAsync(pumpEventQueue);
        await tester.pump(const Duration(milliseconds: 100));
      }
      await tester.tap(
        find.byKey(
          ValueKey(
            screen == 'dialog' ? 'swarm-title-rename' : 'swarm-chat-menu',
          ),
        ),
      );
      for (var i = 0; i < 5; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      if (screen == 'dialog') {
        expect(find.text('Rename agent'), findsOneWidget);
      } else {
        expect(find.text('Rename'), findsOneWidget);
        expect(find.text('Archive'), findsNothing);
      }
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/rename-agent-$screen-${brightness.name}.png')
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
