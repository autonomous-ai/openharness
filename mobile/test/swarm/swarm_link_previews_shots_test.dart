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
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of message link previews and a fetched quote in the real
/// chat, 390 points wide in both phone themes, from made-up data, to the folder
/// `SWARM_LINK_PREVIEW_SHOTS` names: a message this chat holds, one in another
/// chat, one the reader may not read, and a reply whose original is not loaded.
final shots = Platform.environment['SWARM_LINK_PREVIEW_SHOTS'];

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

  Map<String, dynamic> message(
    String id,
    int sequence,
    String text, {
    String conversation = 'g1',
    String? replyTo,
  }) => {
    'id': id,
    'conversationId': conversation,
    'text': text,
    'sequence': sequence,
    'replyTo': ?replyTo,
    'author': {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.now()
        .subtract(Duration(minutes: 30 - sequence))
        .toUtc()
        .toIso8601String(),
  };

  testWidgets('Link previews and a fetched quote, in both phone themes', (
    tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    String one(String chat, String id) =>
        '/api/super-tabs/$tab/conversations/$chat/messages?messageId=$id';
    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      await tester.binding.setSurfaceSize(const Size(390, 640));
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'OpenHarness', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            agentIds: ['agent-lead', 'agent-builder'],
            status: 'working',
            lastMessageSequence: 3,
          ),
          groupData('g2', title: 'Release notes', agentIds: ['agent-builder']),
        ],
      );
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/conversations/g1/messages'] = (_) => {
        'messages': [
          message(
            'm3',
            3,
            'Thanks, that matches what I saw.',
            replyTo: 'older',
          ),
          message(
            'm2',
            2,
            'Three places to read before we ship:\n'
                'harness://swarm/$tab/g1/m1\n'
                'harness://swarm/$tab/g2/notes\n'
                'harness://swarm/$tab/g2/secret',
          ),
          message('m1', 1, 'Sign-in fails when the token has just expired.'),
        ],
        'next': null,
        'threads': <Object>[],
      };
      fake.routes[one('g2', 'notes')] = (_) => {
        'messages': [
          message(
            'notes',
            1,
            'Drafted the release notes.\nThe sign-in fix goes first.',
            conversation: 'g2',
          ),
        ],
      };
      fake.routes[one('g2', 'secret')] = (_) =>
          throw const SuperTabFailure('FORBIDDEN', 'No access.');
      fake.routes[one('g1', 'older')] = (_) => {
        'messages': [message('older', 0, 'It only happens after a restart.')],
      };
      final host = SwarmHost(
        accountId: () => me,
        account: ValueNotifier<String?>(me),
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
            home: const SwarmConversationPage(
              swarmId: tab,
              conversationId: 'g1',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Message unavailable'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/phone-link-previews-${brightness.name}-390.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      await tester.pump(const Duration(minutes: 1));
    }
  }, skip: shots == null);
}
