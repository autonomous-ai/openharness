import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/recording_notice.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';

const gapText =
    'Some terminal activity could not be recorded. '
    'Check the native session for the full conversation.';
final longUrl =
    'https://github.com/example/lamp/compare/main...offline?body='
    '${Uri.encodeComponent('Checked reconnect and local edits. ' * 40)}';

void gap(ConversationServer server, {String author = 'lead-agent'}) {
  server.append(gapText);
  server.messages.last
    ..['author'] = <String, dynamic>{
      'kind': 'agent',
      'id': author,
      'name': 'Lead',
      'displayName': author == 'lead-agent' ? 'Atlas' : 'Sage',
    }
    ..['source'] = {'kind': 'native', 'phase': 'gap'};
}

ConversationServer polishFixture() {
  final server = ConversationServer();
  server.state['projects'] = [
    projectFixture('lead', 'Lamp OS', 'lead'),
    projectFixture(
      'design',
      'Design system',
      'design-lead',
      visibility: 'private',
    ),
    projectFixture('long', 'claude-2026-10-20-14-13', 'long-lead'),
  ];
  server.state['people'] = [
    {'id': 'owner', 'email': 'dee@example.com', 'role': 'owner'},
    {'id': 'leo', 'email': 'leo@example.com', 'role': 'collaborator'},
    {'id': 'daniel', 'email': 'daniel@example.com', 'role': 'collaborator'},
  ];
  server.state['agents'] = [
    for (final pair in [
      ('lead-agent', 'Lead'),
      ('builder', 'Builder'),
      ('reviewer', 'Reviewer'),
    ])
      {
        'id': pair.$1,
        'name': pair.$2,
        'displayName': switch (pair.$1) {
          'lead-agent' => 'Atlas',
          'builder' => 'Nova',
          _ => 'Sage',
        },
        'projectId': 'lead',
        'machineId': 'm',
        'harnessId': pair.$1,
        'contributorId': 'owner',
        'configuration': {'engine': pair.$1 == 'builder' ? 'codex' : 'claude'},
      },
  ];
  (server.state['conversations'] as List)[0]
    ..['leadId'] = 'lead-agent'
    ..['agentIds'] = ['lead-agent'];
  (server.state['conversations'] as List)[1]
    ..['number'] = 12
    ..['agentIds'] = ['lead-agent', 'builder']
    ..['assignment'] = {'agentId': 'builder', 'status': 'working'};
  (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
    {
      ...conversationFixture('review', 'Reconnect review'),
      'number': 13,
      'agentIds': ['reviewer'],
      'assignment': {'agentId': 'reviewer', 'status': 'working'},
    },
    {...conversationFixture('design-lead', 'Lead'), 'projectId': 'design'},
    {...conversationFixture('long-lead', 'Lead'), 'projectId': 'long'},
  ]);
  server.state['machines'] = [
    {
      'machineId': 'offline',
      'name': 'MacBooks-MacBook-Pro-19.local',
      'contributorId': 'leo',
    },
    {
      'machineId': 'm',
      'name': 'M2',
      'contributorId': 'owner',
      'engines': ['claude', 'codex'],
      'observation': {
        'receivedAt': DateTime.now().millisecondsSinceEpoch,
        'runningHarnessIds': ['lead-agent', 'builder', 'reviewer'],
        'resources': {
          'cpuPercent': 27,
          'gpuPercent': 7,
          'memoryTotalBytes': 64000000000,
          'memoryUsedBytes': 36000000000,
          'diskTotalBytes': 1000000000000,
          'diskFreeBytes': 141000000000,
        },
        'quotas': [
          for (final engine in ['claude', 'codex'])
            {
              'engine': engine,
              'known': true,
              'accountName': engine,
              'windows': [
                {'name': '5-hour', 'usedPercent': engine == 'claude' ? 50 : 30},
              ],
            },
        ],
      },
    },
  ];
  void lead(String text) {
    server.append(text);
    server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'lead-agent',
      'name': 'Lead',
    };
  }

  server.append('How is offline editing coming along?');
  lead(
    'The implementation is ready. Nova is checking reconnects, '
    'and Sage is testing restart recovery.',
  );
  lead(
    '**Progress**\n- Edits survive a restart.\n- Reconnecting syncs each edit once.\n\n'
    'The work is in #12; the independent review is in #13.',
  );
  lead('Changes ready for review: $longUrl');
  for (var i = 0; i < 6; i++) {
    gap(server);
  }
  lead('I’ll post the final result once the review finishes.');
  return server;
}

void main() {
  final capture = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() async {
    if (capture == null || !Platform.isMacOS) return;
    final bytes = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });

  testWidgets(
    'long raw links retain their destination; labels and code stay literal',
    (tester) async {
      final markdown = '$longUrl\n\n[Review changes]($longUrl)\n\n`$longUrl`';
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SingleChildScrollView(child: SuperTabMessageText(markdown)),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final links = <String>[];
      final opened = <Uri>[];
      final originalOpener = browserOpener;
      browserOpener = (uri) async {
        opened.add(uri);
        return true;
      };
      addTearDown(() => browserOpener = originalOpener);
      for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
        rich.text.visitChildren((span) {
          if (span is TextSpan && span.recognizer is TapGestureRecognizer) {
            links.add(span.toPlainText());
            (span.recognizer as TapGestureRecognizer).onTap!();
          }
          return true;
        });
      }
      expect(links, [
        'github.com/example/lamp/compare/main...offline?…',
        'Review changes',
      ]);
      expect(opened.map((uri) => uri.toString()), [longUrl, longUrl]);
      // Link destinations stay in the original Markdown; the AST label alone changes.
      expect(
        tester.widget<MarkdownBody>(find.byType(MarkdownBody)).data,
        markdown,
      );
      expect(find.textContaining(longUrl, findRichText: true), findsWidgets);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'bare encoded links retain punctuation boundaries and explicit destinations stay authoritative',
    (tester) async {
      const short = 'https://example.com/a_(b)?q=one%20two&next=%252F';
      const target = 'https://other.example/actual%2520destination';
      final originalOpener = browserOpener;
      final opened = <Uri>[];
      browserOpener = (uri) async {
        opened.add(uri);
        return true;
      };
      addTearDown(() => browserOpener = originalOpener);
      await tester.pumpWidget(
        const MaterialApp(
          home: Scaffold(
            body: SuperTabMessageText(
              '($short).\n\n[https://example.com/label]($target)\n\n`$short`\n\n```txt\n$short\n```',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      for (final rich in tester.widgetList<RichText>(find.byType(RichText))) {
        rich.text.visitChildren((span) {
          if (span is TextSpan && span.recognizer is TapGestureRecognizer) {
            (span.recognizer as TapGestureRecognizer).onTap!();
          }
          return true;
        });
      }
      expect(opened.map((uri) => uri.toString()), [short, target]);
      expect(tester.takeException(), isNull);
    },
  );

  test('recording notices preserve authors, generations, chronology, replies and delivery records', () {
    final server = ConversationServer();
    gap(server);
    gap(server);
    gap(server);
    server.append('A real update');
    gap(server);
    gap(server, author: 'builder');
    gap(server, author: 'builder');
    server.messages.last['author']['membershipGeneration'] = 2;
    gap(server, author: 'builder');
    server.messages.last['createdAt'] = '2026-10-19T00:00:00Z';
    gap(server, author: 'builder');
    server.messages.last['replyTo'] = 'message-4';
    gap(server, author: 'builder');
    server.messages.last['deliveries'] = [
      {'id': 'receipt', 'status': 'uncertain'},
    ];
    final messages = server.messages.map(SuperTabMessage.fromJson).toList();
    final entries = superTabTranscriptEntries(messages);
    expect(entries.map((e) => e.interruptions), [3, 0, 1, 1, 1, 1, 0, 0]);
    expect(entries.map((e) => e.message.id), [
      'message-1',
      'message-4',
      'message-5',
      'message-6',
      'message-7',
      'message-8',
      'message-9',
      'message-10',
    ]);
    expect(messages.length, 10);
  });

  for (final profile in [
    (
      name: 'dark',
      brightness: Brightness.dark,
      size: const Size(1440, 900),
      scale: 1.0,
    ),
    (
      name: 'light',
      brightness: Brightness.light,
      size: const Size(1280, 800),
      scale: 1.0,
    ),
    (
      name: 'large',
      brightness: Brightness.dark,
      size: const Size(800, 600),
      scale: 2.0,
    ),
  ]) {
    testWidgets(
      'Swarm navigation, resources and transcript remain usable in ${profile.name}',
      (tester) async {
        await tester.binding.setSurfaceSize(profile.size);
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final previous = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = profile.brightness;
        addTearDown(() => grid.AppTheme.brightness.value = previous);
        final server = polishFixture(), c = server.controller();
        await c.refresh();
        c.toggleProject('lead');
        var opened = '';
        final boundary = GlobalKey();
        await tester.pumpWidget(
          RepaintBoundary(
            key: boundary,
            child: MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: profile.brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context).copyWith(
                  textScaler: TextScaler.linear(profile.scale),
                  highContrast: profile.scale > 1,
                ),
                child: child!,
              ),
              home: Scaffold(
                body: SuperTabView(
                  controller: c,
                  onInvite: () {},
                  onAddAgent: (_) {},
                  onNewProject: () {},
                  onOpenTerminal: (agent) => opened = agent.id,
                  machineName: (_) => 'M2',
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        expect(find.byType(SuperTabRecordingNotice), findsOneWidget);
        await tester.ensureVisible(find.byType(SuperTabRecordingNotice));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Open terminal'));
        await tester.pumpAndSettle();
        expect(opened, 'lead-agent');
        expect(c.messages('lead').length, 11);
        expect(tester.takeException(), isNull);
        Future<void> shot(String suffix) async {
          if (capture == null) return;
          await tester.runAsync(
            () => precacheImage(
              const AssetImage('assets/engine-icons/codex.png'),
              tester.element(find.byType(SuperTabView)),
            ),
          );
          await tester.pump();
          final render =
              boundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          await tester.runAsync(() async {
            final image = await render.toImage(pixelRatio: 1.5);
            final bytes = await image.toByteData(
              format: ui.ImageByteFormat.png,
            );
            await Directory(capture).create(recursive: true);
            await File('$capture/polish-${profile.name}$suffix.png')
                .writeAsBytes(bytes!.buffer.asUint8List());
            image.dispose();
          });
        }

        await shot('');
        if (profile.scale > 1) {
          await tester.tap(find.byTooltip('Members and machines'));
          await tester.pumpAndSettle();
          await shot('-resources');
          expect(tester.takeException(), isNull);
          await tester.sendKeyEvent(LogicalKeyboardKey.escape);
          await tester.pumpAndSettle();
          await tester.tap(find.byTooltip('Conversations'));
          await tester.pumpAndSettle();
          expect(find.text('Machines'), findsOneWidget);
          expect(tester.takeException(), isNull);
          await shot('-projects');
          expect(tester.takeException(), isNull);
        } else {
          expect(find.text('Machines'), findsOneWidget);
          expect(find.text('Projects'), findsOneWidget);
          // The Machines group lives beside Projects in the left sidebar.
          expect(
            tester.getTopLeft(find.text('Machines')).dx,
            tester.getTopLeft(find.text('Projects')).dx,
          );
        }
        // Capture one row treatment across disclosure, label and nested work.
        final mouse = await tester.createGesture(
          kind: ui.PointerDeviceKind.mouse,
        );
        await mouse.addPointer(location: Offset.zero);
        for (final target in [
          ('project-hover', const ValueKey('super-group-lead')),
          ('disclosure-hover', const ValueKey('super-project-expand-lead')),
          ('workgroup-hover', const ValueKey('super-group-offline')),
        ]) {
          await mouse.moveTo(tester.getCenter(find.byKey(target.$2)));
          await tester.pump();
          await tester.pump(const Duration(milliseconds: 200));
          await shot('-${target.$1}');
        }
        c.select('offline');
        await tester.pumpAndSettle();
        await shot('-workgroup-selected');
        await mouse.removePointer();
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );
  }
}
