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
import 'package:harness_mobile/swarm/swarm_agents.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_devices_page.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';
import 'package:harness_mobile/swarm/swarm_start.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of what each agent does on Your Team, its Pause one
/// long press away, and the same words on its machine's sheet and in the @
/// picker, in both phone themes at phone width, from made-up data only, to
/// `SWARM_AGENT_STATE_SHOTS`.
final shots = Platform.environment['SWARM_AGENT_STATE_SHOTS'];

/// The person's computers: Dale has a question on its screen, Devon works.
class _Computers extends ChangeNotifier
    implements SwarmComputers, SwarmAgentsSource {
  @override
  List<SwarmComputer>? get computers => const [
    (name: 'Mac Studio', away: false),
  ];

  @override
  List<SwarmOwnComputer> get own => const [];

  @override
  bool get rechecking => false;

  @override
  Future<Map<String, dynamic>> ask(
    String machineId,
    Map<String, dynamic> payload,
  ) async => throw UnimplementedError();

  @override
  Future<void> recheck() async {}

  @override
  void add(BuildContext context) {}

  @override
  final _Agents agents = _Agents();
}

class _Agents extends ChangeNotifier implements SwarmAgents {
  static const _activities = {
    'mac-studio/harness-a-dale': SwarmHarnessActivity.needsInput,
    'mac-studio/harness-a-devon': SwarmHarnessActivity.working,
  };

  @override
  int? get working => 1;

  @override
  SwarmHarnessActivity? activityOf(String machineId, String harnessId) =>
      _activities['$machineId/$harnessId'];

  @override
  void openList(BuildContext context) {}
}

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

  const devonChat = 'chat-a-devon';

  /// One of the person's agents, [name], on the Mac Studio, with its chat.
  Map<String, dynamic> mine(
    String id,
    String name, [
    Map<String, dynamic> fields = const {},
  ]) => {
    ...agent(id, displayName: name, machineId: 'mac-studio'),
    'chatId': 'chat-$id',
    ...fields,
  };

  /// The person's Dale (Mobile's Product Manager, a question waiting),
  /// Devon (working), Nova (paused), Study (out of quota for an hour), Kai
  /// (its session gone) and Wren (nothing known).
  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
    final at = DateTime.now().toUtc();
    final agents = [
      mine('a-dale', 'Dale', {'kind': 'pm'}),
      mine('a-devon', 'Devon'),
      mine('a-kai', 'Kai', {
        'downSince': at.subtract(const Duration(minutes: 20)).toIso8601String(),
      }),
      mine('a-nova', 'Nova', {'pausedAt': at.toIso8601String()}),
      mine('a-study', 'Study', {
        'limitedUntil': at.add(const Duration(hours: 1)).toIso8601String(),
      }),
      mine('a-wren', 'Wren'),
    ];
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      agents: agents,
      machines: [
        {
          'machineId': 'mac-studio',
          'name': 'Mac Studio',
          'contributorId': me,
          'engines': ['claude', 'codex'],
        },
      ],
      groups: [
        for (final a in agents)
          {
            ...groupData(
              a['chatId'] as String,
              title: 'Chat',
              kind: 'agent-chat',
              agentIds: [a['id'] as String],
              lastMessageSequence: 1,
              audience: [me],
            ),
            'projectId': null,
          },
      ],
      derived: {
        'readMarks': {for (final a in agents) a['chatId'] as String: 1},
      },
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/$devonChat/messages'] =
        (_) => {
          'messages': [
            {
              'id': 'm1',
              'conversationId': devonChat,
              'text': 'Can you check the sign-in copy on the phone?',
              'sequence': 1,
              'author': {'kind': 'person', 'id': me, 'name': 'tony'},
              'createdAt': at.toIso8601String(),
            },
          ],
          'next': null,
        };
    return fake;
  }

  testWidgets('agent states on Your Team, its menu, its machine and the @ '
      'picker, in both themes', (tester) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final shown = [
      for (final screen in ['home', 'menu', 'machine', 'picker'])
        for (final palette in [HarnessPalette.graphite, HarnessPalette.paper])
          (screen, palette),
    ];
    Future<void> settle() async {
      for (var i = 0; i < 5; i++) {
        await tester.runAsync(pumpEventQueue);
        await tester.pump(const Duration(milliseconds: 100));
      }
    }

    for (final (screen, palette) in shown) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final fake = backend();
      final account = ValueNotifier<String?>(me);
      final computers = _Computers();
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
          ..value = {PhoneExperiment.swarm},
        computers: computers,
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
            home: switch (screen) {
              'machine' => const SwarmDevicesPage(),
              'picker' => const SwarmConversationPage(
                swarmId: tab,
                conversationId: devonChat,
              ),
              _ => const SwarmPage(),
            },
          ),
        ),
      );
      await settle();
      switch (screen) {
        case 'home':
          expect(find.text('needs you'), findsOneWidget);
          expect(find.text('working'), findsOneWidget);
          expect(find.text('paused'), findsOneWidget);
          expect(find.text('offline'), findsOneWidget);
          expect(find.textContaining('limited until '), findsOneWidget);
        case 'menu':
          await tester.longPress(
            find.byKey(const ValueKey('swarm-agent-$tab-a-devon')),
          );
          await settle();
          expect(find.text('Pause'), findsOneWidget);
        case 'machine':
          await tester.tap(
            find.byKey(const ValueKey('swarm-machine-$tab-mac-studio')),
          );
          await settle();
          await tester.ensureVisible(find.text('Dev · paused'));
          await settle();
          expect(find.text('Dev · working'), findsOneWidget);
        case 'picker':
          await tester.enterText(find.byType(TextField), '@');
          await settle();
          expect(
            find.byKey(const ValueKey('swarm-mention-state-a-devon')),
            findsOneWidget,
          );
      }
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/agent-state-$screen-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 1));
      host.dispose();
      computers.agents.dispose();
      computers.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}
