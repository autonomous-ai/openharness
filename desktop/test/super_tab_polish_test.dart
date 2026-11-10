import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/open_in_browser.dart';
import 'package:harness/super_tabs/message_text.dart';

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
}
