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
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';

/// Light and dark screenshots of the card, to the folder this names.
final shots = Platform.environment['PM_CHOOSE_SHOTS'];

const projectId = 'project-games';
const channel = 'project-games-chat';

/// A Swarm read with one project, owned by [ownerId], whose channel has
/// [leadId] as its PM, or none; [pmChat] is the PM's own chat New project
/// opened while that PM starts.
Map<String, dynamic> projectLoad({
  String name = 'Personal',
  String ownerId = me,
  String? leadId,
  String? pmChat,
  String role = 'owner',
}) => {
  ...firstLoad(
    head: headData(
      name: name,
      projects: [
        {
          'id': projectId,
          'name': 'games',
          'ownerId': ownerId,
          'leadConversationId': channel,
          'visibility': 'private',
          'members': <Object>[],
          'updateMinutes': 5,
          'skillMode': 'default',
          if (pmChat != null) 'pmChat': {'id': pmChat},
        },
      ],
    ),
    agents: [if (leadId != null) agent(leadId, name: 'Lead')],
    groups: [
      {
        ...groupData(
          channel,
          title: 'games',
          agentIds: [?leadId],
          leadId: leadId,
        ),
        'projectId': projectId,
      },
    ],
  ),
  'members': [part(me, 1, person(me, role: role))],
};

/// A project's empty channel with no Product Manager tells its owner so, in
/// Desktop's words (choose_pm.dart `SwarmPmChoose`, view.dart `_offersLead`);
/// everyone else, and a channel with a PM or one starting, reads Desktop's
/// empty channel line. The phone starts no PM: Start PM and its `lead.claim`
/// went with Desktop's (#4086).
void main() {
  late FakeSwarm swarm;
  late SwarmHost host;

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

  final boundary = GlobalKey();

  Future<void> pump(
    WidgetTester tester, {
    Map<String, dynamic>? load,
    Brightness brightness = Brightness.dark,
    Widget? home,
  }) async {
    swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Personal', 'ownerId': me},
      ],
      'next': null,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => load ?? projectLoad();
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/leaderboard'] = (_) =>
        leaderboardData(people: const []);
    swarm.routes['/api/super-tabs/$tab/conversations/$channel/messages'] = (
      _,
    ) => {'messages': <Object>[], 'next': null};
    swarm.routes['/api/super-tabs/$tab/commands'] = (_) => {
      'result': <String, Object>{},
    };
    final account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: swarm.request,
      notices: SilentSystemNotices(),
      computers: FakeComputers(const [(name: 'Studio', away: false)]),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
    )..foreground = false;
    addTearDown(host.dispose);
    final palette = brightness == Brightness.dark
        ? HarnessPalette.graphite
        : HarnessPalette.paper;
    AppTheme.palette.value = palette;
    AppTheme.brightness.value = brightness;
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: buildAppTheme(brightness: brightness),
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          home: Scaffold(
            body:
                home ??
                const SwarmConversationPage(
                  swarmId: tab,
                  conversationId: channel,
                ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  const noPm = 'This project has no Product Manager.';

  Future<void> capture(WidgetTester tester, String name) async {
    if (shots == null) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 3);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$shots/pm-choose-$name.png')
          .writeAsBytes(png!.buffer.asUint8List());
      image.dispose();
    });
  }

  testWidgets('the owner\'s empty channel with no PM says so, and starts '
      'nothing', (tester) async {
    await pump(tester);

    expect(key('swarm-pm-choose'), findsOneWidget);
    expect(find.text(noPm), findsOneWidget);
    expect(find.text(swarmEmptyChannel), findsNothing);
    // Start PM went with Desktop's: no computer, engine or start.
    expect(find.text('Start PM'), findsNothing);
    expect(key('swarm-lead-start'), findsNothing);
    expect(swarm.commands, isEmpty);
    // Only agents post in the channel.
    expect(key('swarm-field'), findsNothing);
    expect(key('swarm-agents-only'), findsOneWidget);
    expect(find.text(swarmAgentsOnlyLine), findsOneWidget);
  });

  testWidgets('any Swarm\'s project shows it to its owner, as on Desktop', (
    tester,
  ) async {
    await pump(tester, load: projectLoad(name: 'Phone Swarm'));
    expect(find.text(noPm), findsOneWidget);
  });

  testWidgets('someone else in the Swarm reads the empty channel line', (
    tester,
  ) async {
    await pump(
      tester,
      load: projectLoad(ownerId: 'someone-else', role: 'collaborator'),
    );
    expect(find.text(noPm), findsNothing);
    expect(find.text(swarmEmptyChannel), findsOneWidget);
  });

  testWidgets('a viewer, who may not write, reads the empty channel line', (
    tester,
  ) async {
    await pump(tester, load: projectLoad(role: 'viewer'));
    expect(find.text(noPm), findsNothing);
    expect(find.text(swarmEmptyChannel), findsOneWidget);
  });

  testWidgets('a project with a PM reads the empty channel line', (
    tester,
  ) async {
    await pump(tester, load: projectLoad(leadId: 'agent-lead'));
    expect(find.text(noPm), findsNothing);
    expect(find.text(swarmEmptyChannel), findsOneWidget);
  });

  testWidgets('a PM New project is starting is the one: nothing to say', (
    tester,
  ) async {
    await pump(tester, load: projectLoad(pmChat: 'pm-chat'));
    expect(find.text(noPm), findsNothing);
    expect(find.text(swarmEmptyChannel), findsOneWidget);
  });

  testWidgets('screenshots in both phone themes', (tester) async {
    if (shots == null) return;
    await tester.binding.setSurfaceSize(const Size(390, 844));
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    for (final brightness in Brightness.values) {
      // As the person opens it: the project, its channel filling the screen.
      await pump(
        tester,
        brightness: brightness,
        home: const SwarmProjectPage(swarmId: tab, projectId: projectId),
      );
      expect(find.text(noPm), findsOneWidget);
      await capture(tester, 'owner-${brightness.name}');
      await pump(
        tester,
        brightness: brightness,
        load: projectLoad(leadId: 'agent-lead'),
        home: const SwarmProjectPage(swarmId: tab, projectId: projectId),
      );
      expect(find.text(swarmEmptyChannel), findsOneWidget);
      await capture(tester, 'empty-${brightness.name}');
      await tester.pumpWidget(const SizedBox.shrink());
    }
  });
}
