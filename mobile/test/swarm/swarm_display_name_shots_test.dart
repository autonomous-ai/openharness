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
import 'package:harness_mobile/swarm/swarm_you_page.dart';
import 'package:harness_mobile/terminal/terminal_font_store.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of the name a person sets (plan
/// 2026-11-03-person-display-name, Task 6): You headed by that name, and a
/// chat whose author and tag read by it beside one who set none. On a
/// 390-point phone in both phone themes, from made-up data only, to the
/// folder `SWARM_DISPLAY_NAME_SHOTS` names.
final shots = Platform.environment['SWARM_DISPLAY_NAME_SHOTS'];
void main() {
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

  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  final mine = {
    ...person(me),
    'email': 'tony@example.com',
    'username': 'tony',
    'name': 'Tony Tran',
  };
  final ken = {
    ...person('ken', role: 'collaborator'),
    'username': 'wkpnjjhbnm',
    'name': 'Minh Nguyen',
  };

  FakeSwarm backend() {
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
            title: 'Fix login',
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            lastMessageSequence: 2,
          ),
        ],
      ),
      'members': [
        part(me, 1, mine),
        part('ken', 1, ken),
        // One who set no name reads by username, as today.
        part('dee', 1, person('dee', role: 'collaborator')),
      ],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    Map<String, dynamic> said(
      String id,
      int sequence,
      String author,
      String text, {
      List<String> mentions = const [],
    }) => {
      'id': id,
      'conversationId': 'g1',
      'text': text,
      'sequence': sequence,
      'mentions': mentions,
      'author': {'kind': 'person', 'id': author, 'name': '$author@example.com'},
      'attachments': <Object>[],
      'reactions': <Object>[],
      'createdAt': DateTime.utc(
        2026,
        11,
        3,
        3,
        40 + sequence,
      ).toIso8601String(),
    };
    fake.routes[messages] = (_) => {
      'messages': [
        said(
          'm2',
          2,
          'dee',
          'Thanks @wkpnjjhbnm, I will check it on the phone.',
          mentions: ['ken'],
        ),
        said('m1', 1, 'ken', 'The login fix is ready for a look.'),
      ],
      'next': null,
      'threads': <Object>[],
    };
    return fake;
  }

  testWidgets('You with a name, and a chat by a named author, in both '
      'phone themes', (tester) async {
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
      for (final (shot, page) in [
        ('you', const SwarmYouPage() as Widget),
        (
          'chat',
          const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
        ),
      ]) {
        final fake = backend();
        final account = ValueNotifier<String?>(me);
        final host = SwarmHost(
          accountId: () => me,
          account: account,
          request: fake.request,
          notices: SilentSystemNotices(),
          features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
            ..value = {PhoneExperiment.swarm},
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
              home: page,
            ),
          ),
        );
        await host.session!.inbox.refresh();
        await tester.pumpAndSettle();
        if (shot == 'you') {
          expect(find.text('Tony Tran'), findsWidgets);
        } else {
          expect(find.text('Minh Nguyen'), findsWidgets);
        }
        if (shots != null) {
          await tester.runAsync(() async {
            final image =
                await (boundary.currentContext!.findRenderObject()!
                        as RenderRepaintBoundary)
                    .toImage(pixelRatio: 3);
            final png = await image.toByteData(format: ui.ImageByteFormat.png);
            await File('$shots/display-name-390-$shot-${brightness.name}.png')
                .writeAsBytes(png!.buffer.asUint8List());
            image.dispose();
          });
        }
        await tester.pumpWidget(const SizedBox());
        host.dispose();
      }
    }
    debugDisableShadows = true;
  }, skip: shots == null);
}
