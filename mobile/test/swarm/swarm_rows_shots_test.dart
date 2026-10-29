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
import 'package:harness_mobile/swarm/swarm_attachment_store.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_attachment_fakes.dart';
import 'swarm_fixture.dart';

/// Review screenshots of the phone chat's rows as Slack shows them (Dee,
/// 10-29): a picture at its own shape, a code block with Copy, a file chip,
/// and a post that was not sent, in both phone themes, from made-up data.
final shots = Platform.environment['SWARM_ROW_SHOTS'];

/// A 1440×900 stand-in for a pasted screenshot: a window with a sidebar.
Future<List<int>> _screenshot() async {
  final recorder = ui.PictureRecorder();
  final canvas = Canvas(recorder)
    ..drawRect(
      const Rect.fromLTWH(0, 0, 1440, 900),
      Paint()..color = const Color(0xFFF2F4F8),
    )
    ..drawRect(
      const Rect.fromLTWH(0, 0, 320, 900),
      Paint()..color = const Color(0xFF2B3442),
    );
  for (var i = 0; i < 6; i++) {
    canvas.drawRRect(
      RRect.fromLTRBR(
        400,
        80.0 + i * 120,
        1360,
        160.0 + i * 120,
        const Radius.circular(16),
      ),
      Paint()..color = const Color(0xFFDCE3EE),
    );
  }
  final image = await recorder.endRecording().toImage(1440, 900);
  final data = await image.toByteData(format: ui.ImageByteFormat.png);
  return data!.buffer.asUint8List();
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

  testWidgets('the chat rows, in both phone themes', (tester) async {
    const messages = '/api/super-tabs/$tab/conversations/g1/messages';
    const commands = '/api/super-tabs/$tab/commands';
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final root = Directory.systemTemp.createTempSync('swarm-row-shots-');
    addTearDown(() => root.deleteSync(recursive: true));
    final storage = FakeFileStorage()
      ..bytes = (await tester.runAsync(_screenshot))!;
    final original = swarmAttachments;
    swarmAttachments = storeIn(root, storage);
    addTearDown(() => swarmAttachments = original);
    await tester.runAsync(() => swarmAttachments.keepOnly(me));

    for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
      final brightness = palette.brightness;
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      final fake = FakeSwarm();
      fake.routes['/api/super-tabs/list'] = (_) => {
        'tabs': [
          {'id': tab, 'name': 'OpenHarness', 'ownerId': me},
        ],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [
            groupData(
              'g1',
              title: 'Pilot',
              agentIds: ['agent-lead'],
              lastMessageSequence: 2,
            ),
          ],
        ),
        'members': [part(me, 1, person(me))],
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
          changes(cursor: 'c2');
      fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
        'decisions': <Object>[],
      };
      fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
        'mentions': <Object>[],
      };
      fake.routes[messages] = (_) => {
        'messages': [
          {
            'id': 'm1',
            'conversationId': 'g1',
            'text': 'this is so confusing. how do i create a new project now?',
            'sequence': 1,
            'author': {'kind': 'person', 'id': me, 'name': 'dee'},
            'attachments': [
              {
                'id': 'f1',
                'name': 'projects.png',
                'mime': 'image/png',
                'size': 182 * 1024,
                'url': 'https://$swarmAttachmentHost/f1/projects.png',
              },
            ],
            'createdAt': DateTime.utc(2026, 10, 29, 11, 57).toIso8601String(),
          },
          {
            'id': 'm2',
            'conversationId': 'g1',
            'text':
                'New Project is in the sidebar now. The setting it reads:\n'
                '```main.dart\nfinal project = Project.create(name: name);\n'
                'await sidebar.select(project);\n```',
            'sequence': 2,
            'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'River'},
            'attachments': [
              {
                'id': 'f2',
                'name': 'report.pdf',
                'mime': 'application/pdf',
                'size': 120 * 1024,
                'url': 'https://$swarmAttachmentHost/f2/report.pdf',
              },
            ],
            'createdAt': DateTime.utc(2026, 10, 29, 11, 58).toIso8601String(),
          },
        ],
        'next': null,
      };
      fake.routes[commands] = (_) =>
          throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
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
      final picture = find.byKey(const ValueKey('swarm-attachment-preview-f1'));
      for (var i = 0; i < 100; i++) {
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 20)),
        );
        await tester.pump();
        if (picture.evaluate().isNotEmpty &&
            find
                .descendant(of: picture, matching: find.byType(RawImage))
                .evaluate()
                .any((e) => (e.widget as RawImage).image != null)) {
          break;
        }
      }
      await tester.enterText(find.byType(TextField), 'Can it be the default?');
      await tester.pump();
      await tester.tap(find.byKey(const ValueKey('swarm-send')));
      for (var i = 0; i < 20; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      expect(find.text('Not sent'), findsOneWidget);
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.pump(const Duration(milliseconds: 300));

      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/phone-rows-${brightness.name}.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
      host.dispose();
      await tester.pump(const Duration(minutes: 1));
    }
  }, skip: shots == null);
}
