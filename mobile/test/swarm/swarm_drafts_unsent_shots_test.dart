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
import 'package:harness_mobile/swarm/swarm_kept.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of a Not sent post and a draft kept across a restart, in
/// both phone themes, from made-up data only, to `SWARM_DRAFTS_SHOTS`.
final shots = Platform.environment['SWARM_DRAFTS_SHOTS'];

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

  testWidgets('Not sent and a kept draft, in both phone themes', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [
            groupData('g1', title: 'Fix login', agentIds: const ['agent-lead']),
          ],
        ),
        'members': [part(me, 1, person(me, role: 'owner'))],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/conversations/g1/messages'] = (_) => {
        'messages': <Object>[],
        'before': null,
      };
      fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
      final store = MemorySwarmKeptStore()
        ..heldBy = me
        ..held = {
          'drafts': [
            {'tab': tab, 'chat': 'g1', 'text': 'Half a thought, still here'},
          ],
          'posts': [
            {
              'tab': tab,
              'chat': 'g1',
              'posts': [
                {
                  'body': {
                    'operationId': 'op-1',
                    'command': {
                      'type': 'message.send',
                      'conversationId': 'g1',
                      'text': 'Ship the fix tonight?',
                    },
                  },
                  'messageId': 'kept-1',
                },
              ],
            },
          ],
        };
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = ValueNotifier<String?>(me);
      final host = SwarmHost(
        accountId: () => account.value,
        account: account,
        request: fake.request,
        notices: SilentSystemNotices(),
        features: features,
        readMarks: MemoryKeyValueStore(),
        kept: store,
      )..foreground = false;
      await host.session!.inbox.kept.ready;
      await host.session!.inbox.refresh();
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
              conversationId: 'g1',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Not sent'), findsOneWidget);
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/not-sent-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      account.dispose();
    }
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}
