import 'dart:async';
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
import 'package:harness_mobile/swarm/swarm_lead_start.dart';
import 'package:harness_mobile/swarm/swarm_project_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_computers_fake.dart';
import 'swarm_fixture.dart';
import 'swarm_lead_start_fixture.dart';

/// The person's computers, as Swarm's screens and the Start Lead card read
/// them.
class _Computers extends FakeComputers implements SwarmLeadComputers {
  _Computers(this.lead) : super(const [(name: 'Studio', away: false)]);

  final FakeLeadComputers lead;

  @override
  List<SwarmLeadComputer> get leadComputers => lead.leadComputers;

  @override
  Future<SwarmLeadStarted> startLead(
    String machineId,
    SwarmLeadLaunch launch,
  ) => lead.startLead(machineId, launch);
}

/// Light and dark screenshots of the card, to the folder this names.
final shots = Platform.environment['LEAD_CARD_SHOTS'];

/// The phone's empty Personal project chat offers to start its Lead, as
/// Desktop's does (#2815): the person's computers and the engines signed in
/// on each, Start Lead, Starting…, and a failure's reason with Start Lead
/// again (task #2941, Huy 11-04).
void main() {
  late FakeSwarm swarm;
  late FakeLeadComputers lead;
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
    lead = FakeLeadComputers([
      computer('mac-1', 'Studio', folders: {repo: '/Users/me/games'}),
      computer('mac-2', 'Air', engines: ['claude']),
    ]);
    swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Personal', 'ownerId': me},
      ],
      'next': null,
    };
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => load ?? personalLoad();
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    swarm.routes['/api/super-tabs/$tab/leaderboard'] = (_) =>
        leaderboardData(people: const []);
    swarm.routes['/api/super-tabs/$tab/conversations/$personalChat/messages'] =
        (_) => {'messages': <Object>[], 'next': null};
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
      final command = body!['command'] as Map<String, dynamic>;
      return switch (command['type']) {
        'lead.claim' => {
          'result': {'leadStart': 'start'},
        },
        _ => {'result': <String, Object>{}},
      };
    };
    final account = ValueNotifier<String?>(me);
    host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: swarm.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      computers: _Computers(lead),
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
                  conversationId: personalChat,
                ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  /// The start's requests answered: a few frames, since Starting… spins
  /// until the Lead joins and never settles.
  Future<void> frames(WidgetTester tester) async {
    for (var i = 0; i < 5; i++) {
      await tester.pump(const Duration(milliseconds: 50));
    }
  }

  List<String> sent() => [for (final c in swarm.commands) c['type'] as String];

  Future<void> capture(WidgetTester tester, String name) async {
    if (shots == null) return;
    await tester.runAsync(() async {
      final image =
          await (boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary)
              .toImage(pixelRatio: 3);
      final png = await image.toByteData(format: ui.ImageByteFormat.png);
      await File('$shots/lead-start-$name.png')
          .writeAsBytes(png!.buffer.asUint8List());
      image.dispose();
    });
  }

  testWidgets('an empty Personal project chat shows the Start card with the '
      'person\'s computers and signed-in engines', (tester) async {
    await pump(tester);

    expect(key('swarm-lead-start'), findsOneWidget);
    expect(find.text('This project has no Lead yet'), findsOneWidget);
    expect(find.text('No messages yet.'), findsNothing);
    expect(
      find.descendant(
        of: key('swarm-lead-start-machine'),
        matching: find.text('Studio'),
      ),
      findsOneWidget,
    );
    expect(key('swarm-lead-start-engine-claude'), findsOneWidget);
    expect(key('swarm-lead-start-engine-codex'), findsOneWidget);
    expect(find.text('Folder: /Users/me/games'), findsOneWidget);
    expect(find.text('Start Lead'), findsOneWidget);
    expect(
      find.text('Or send a message below: the Lead reads it when it starts.'),
      findsOneWidget,
    );

    // The machine sheet lists both computers; the Air has Claude Code only.
    await tester.tap(key('swarm-lead-start-machine'));
    await tester.pumpAndSettle();
    expect(find.text('Studio'), findsWidgets);
    await tester.tap(find.text('Air').last);
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: key('swarm-lead-start-machine'),
        matching: find.text('Air'),
      ),
      findsOneWidget,
    );
    expect(key('swarm-lead-start-engine-claude'), findsOneWidget);
    expect(key('swarm-lead-start-engine-codex'), findsNothing);
    expect(
      find.text('A new folder in your Harness projects folder'),
      findsOneWidget,
    );
  });

  testWidgets('Start sends Desktop\'s start and shows Starting…', (
    tester,
  ) async {
    await pump(tester);
    lead.held = Completer();
    await tester.tap(key('swarm-lead-start-engine-codex'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-lead-start-button'));
    await tester.pump();
    await tester.pump();

    expect(find.text('Starting…'), findsOneWidget);
    expect(sent(), ['lead.claim']);
    expect(lead.starts.single.$1, 'mac-1');
    expect(lead.starts.single.$2.engine, 'codex');
    // A second tap while it starts starts nothing more.
    await tester.tap(key('swarm-lead-start-button'));
    await tester.pump();

    lead.held!.complete();
    await frames(tester);
    expect(sent(), ['lead.claim', 'agent.add']);
    expect(lead.starts, hasLength(1));
    expect(swarm.commands.last['lead'], isTrue);
  });

  testWidgets('a failed start shows its reason and Start Lead tries again', (
    tester,
  ) async {
    await pump(tester);
    lead.failure = const SuperTabFailure(
      'CREATE_FAILED',
      'Codex isn’t signed in.',
    );
    await tester.tap(key('swarm-lead-start-button'));
    await tester.pumpAndSettle();
    expect(
      find.text('Couldn’t start a Lead: Codex isn’t signed in'),
      findsOneWidget,
    );
    expect(find.text('Start Lead'), findsOneWidget);

    lead.failure = null;
    await tester.tap(key('swarm-lead-start-button'));
    await frames(tester);
    expect(lead.starts, hasLength(2));
    expect(sent(), ['lead.claim', 'lead.claim', 'agent.add']);
  });

  testWidgets('after a failed join the card keeps the computer the agent '
      'started on', (tester) async {
    await pump(tester);
    final routes = swarm.routes['/api/super-tabs/$tab/commands']!;
    swarm.routes['/api/super-tabs/$tab/commands'] = (body) {
      final command = body!['command'] as Map<String, dynamic>;
      if (command['type'] == 'agent.add') {
        throw const SuperTabFailure('UNAVAILABLE', 'The Swarm did not answer.');
      }
      return routes(body);
    };
    await tester.tap(key('swarm-lead-start-button'));
    await tester.pumpAndSettle();
    expect(
      find.text('Couldn’t start a Lead: The Swarm did not answer'),
      findsOneWidget,
    );
    // Its agent runs on Studio: no other computer is offered until it joins.
    await tester.tap(key('swarm-lead-start-machine'));
    await tester.pumpAndSettle();
    expect(find.text('Air'), findsNothing);
  });

  testWidgets('no computer online: the button says to open Harness on '
      'their Mac, and starts nothing (task #3042)', (tester) async {
    await pump(tester);
    lead.leadComputers = [];
    // The card reads the computers as it draws.
    (host.computers! as ChangeNotifier).notifyListeners();
    await tester.pumpAndSettle();
    expect(key('swarm-lead-start-button'), findsNothing);
    final offline = key('swarm-lead-start-offline');
    expect(
      find.descendant(
        of: offline,
        matching: find.text('Open Harness on your Mac to start'),
      ),
      findsOneWidget,
    );
    expect(
      find.textContaining('none of your computers is online'),
      findsNothing,
    );
    await tester.tap(offline);
    await tester.pumpAndSettle();
    expect(sent(), isEmpty);
    expect(lead.starts, isEmpty);
    // Once a computer is on, the card offers its start again.
    lead.leadComputers = [
      computer('mac-1', 'Studio', folders: {repo: '/Users/me/games'}),
    ];
    (host.computers! as ChangeNotifier).notifyListeners();
    await tester.pumpAndSettle();
    expect(key('swarm-lead-start-button'), findsOneWidget);
    expect(offline, findsNothing);
  });

  testWidgets('a Team Swarm\'s project chat shows no card', (tester) async {
    await pump(tester, load: personalLoad(name: 'Phone Swarm'));
    expect(key('swarm-lead-start'), findsNothing);
    expect(find.text('No messages yet.'), findsOneWidget);
  });

  testWidgets('a project with a Lead shows no card', (tester) async {
    await pump(tester, load: personalLoad(leadId: 'agent-lead'));
    expect(key('swarm-lead-start'), findsNothing);
  });

  testWidgets('screenshots of the card in both phone themes', (tester) async {
    if (shots == null) return;
    await tester.binding.setSurfaceSize(const Size(390, 844));
    tester.view.physicalSize = const Size(390 * 3, 844 * 3);
    tester.view.devicePixelRatio = 3;
    addTearDown(tester.view.reset);
    for (final brightness in Brightness.values) {
      // As the person opens it: the project, its chat filling the screen.
      await pump(
        tester,
        brightness: brightness,
        home: SwarmProjectPage(swarmId: tab, projectId: personal),
      );
      expect(key('swarm-lead-start'), findsOneWidget);
      await capture(tester, 'ready-${brightness.name}');
      lead.held = Completer();
      await tester.tap(key('swarm-lead-start-button'));
      await tester.pump();
      await tester.pump();
      await capture(tester, 'starting-${brightness.name}');
      lead.failure = const SuperTabFailure(
        'CREATE_FAILED',
        'Codex isn’t signed in on Studio.',
      );
      lead.held!.complete();
      await tester.pumpAndSettle();
      await capture(tester, 'failed-${brightness.name}');
      await tester.pumpWidget(const SizedBox.shrink());
    }
  });
}
