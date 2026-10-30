import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/voice_input_controller.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of New message (Tony, 10-30: as Slack Mobile starts
/// one): Home with its floating +, the sheet it opens, narrowed by To:, a
/// chat picked with a message typed, and a send refused — in both phone
/// themes, 390 points wide and on a small phone, 320, from made-up Swarm
/// data only, to the folder `SWARM_NEW_MESSAGE_SHOTS` names.
final shots = Platform.environment['SWARM_NEW_MESSAGE_SHOTS'];
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

  testWidgets('Home, New message and a send refused, in both phone themes, '
      'at 390 and 320 points', (tester) async {
    Map<String, dynamic> projectOf(String id, String name) => {
      'id': id,
      'name': name,
      'ownerId': me,
      'leadConversationId': 'lead-$id',
      'visibility': 'public',
      'members': <Object>[],
      'updateMinutes': 5,
    };
    Map<String, dynamic> chatOf(String projectId, String name) => {
      ...groupData('lead-$projectId', title: name),
      'projectId': projectId,
    };
    const projects = {
      'p-oh': 'openharness',
      'p-desk': 'desktop-app',
      'p-web': 'web-dashboard',
      'p-phone': 'Điện thoại',
      'p-docs': 'docs',
    };

    for (final (width, height) in [(390.0, 844.0), (320.0, 568.0)]) {
      for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
        await tester.binding.setSurfaceSize(Size(width, height));
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
        final now = DateTime.now();
        fake.routes['/api/super-tabs/$tab/parts'] = (_) {
          final load = firstLoad(
            head: headData(
              projects: [
                for (final MapEntry(:key, :value) in projects.entries)
                  projectOf(key, value),
              ],
            ),
            agents: [
              {
                ...agent('agent-lead', name: 'Lead', displayName: 'River'),
                'projectId': 'p-oh',
              },
              {
                ...buddyData('agent-wren', displayName: 'Wren'),
                'projectId': 'p-oh',
              },
            ],
            groups: [
              for (final MapEntry(:key, :value) in projects.entries)
                chatOf(key, value),
              {
                ...buddyChatData('buddy-oh', agentIds: ['agent-wren']),
                'projectId': 'p-oh',
              },
            ],
          );
          // Each project last moved a while ago, the first most lately.
          return {
            ...load,
            'groups': [
              for (final (i, row) in (load['groups'] as List).indexed)
                {
                  ...row as Map<String, dynamic>,
                  'changedAt': now
                      .subtract(Duration(minutes: 3 + i * 17))
                      .millisecondsSinceEpoch,
                },
            ],
          };
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
        fake.routes['/api/super-tabs/$tab/commands'] = (_) =>
            throw const SuperTabFailure(
              'INVALID',
              'This chat takes no new messages.',
              statusCode: 400,
            );

        final features = ExperimentalFeaturesStore(
          storage: MemoryKeyValueStore(),
        )..value = {PhoneExperiment.swarm};
        final account = ValueNotifier<String?>(me);
        final host = SwarmHost(
          accountId: () => me,
          account: account,
          request: fake.request,
          notices: SilentSystemNotices(),
          features: features,
          readMarks: MemoryKeyValueStore(),
          voice: () => VoiceInputController(
            transcriber: FakeTranscriber().call,
            recorder: FakeVoiceRecorder(),
            language: ValueNotifier('en'),
          ),
        )..foreground = false;
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: buildAppTheme(brightness: brightness),
              builder: (_, child) => SwarmScope(notifier: host, child: child!),
              home: const SwarmPage(),
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
          await File(
            '$shots/new-message-$name-${width.toInt()}-${brightness.name}.png',
          ).writeAsBytes(png!.buffer.asUint8List());
          image.dispose();
        });
        Finder key(String value) => find.byKey(ValueKey(value));
        final field = find.descendant(
          of: key('swarm-new-message-field'),
          matching: find.byType(TextField),
        );

        await capture('home');
        await tester.tap(key('swarm-new-message'));
        await tester.pumpAndSettle();
        await capture('sheet');

        await tester.enterText(key('swarm-new-message-to'), 'open');
        await tester.pumpAndSettle();
        await capture('search');

        await tester.enterText(key('swarm-new-message-to'), '');
        await tester.tap(key('swarm-new-message-$tab-lead-p-oh'));
        await tester.pump();
        await tester.enterText(field, 'Can we ship the floating + today?');
        await tester.pumpAndSettle();
        await capture('picked');

        await tester.tap(key('swarm-new-message-send'));
        await tester.pumpAndSettle();
        await capture('refused');

        await tester.pumpWidget(const SizedBox());
        host.dispose();
        account.dispose();
      }
    }
    await tester.binding.setSurfaceSize(null);
    AppTheme.palette.value = HarnessPalette.graphite;
    AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null);
}
