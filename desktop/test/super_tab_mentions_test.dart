import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math' as math;
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/notify/system_notifications.dart';
import 'package:harness/state/harness_activity.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/message_text.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/notifications.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'support/super_tab_swarm.dart' show addAskingAgent;
import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show MemoryStore;

/// What would have reached the operating system.
class ShownNotices implements SystemNotifier {
  final shown = <({String title, String body})>[];
  final routes = <(String, String)>[];
  @override
  bool get supported => true;
  @override
  bool get clickOpensAgent => false;
  @override
  String get deniedAdvice => '';
  @override
  Future<NotificationPermission> authorize() async =>
      NotificationPermission.granted;
  @override
  Future<NotificationPermission> show({
    required String id,
    required String title,
    required String body,
    required String machineId,
    required String agentId,
  }) async {
    shown.add((title: title, body: body));
    routes.add((machineId, agentId));
    return NotificationPermission.granted;
  }

  @override
  Future<void> withdraw(String id) async {}
  @override
  set onTap(void Function(String machineId, String agentId)? handler) {}
}

Map<String, dynamic> messageRow({Object? mentions}) => {
  'id': 'm1',
  'conversationId': 'lead',
  'sequence': 1,
  'text': 'Please confirm the release.',
  'author': {'kind': 'agent', 'id': 'lead-agent', 'name': 'Lead'},
  'mentions': ?mentions,
};

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_MENTION_SHOTS'];
final _picture = GlobalKey();

Future<void> shot(WidgetTester tester, String name) async {
  if (shots == null) return;
  await tester.runAsync(() async {
    final boundary =
        _picture.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage();
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(shots!).create(recursive: true);
    await File('$shots/$name.png').writeAsBytes(bytes!.buffer.asUint8List());
    image.dispose();
  });
}

Future<SuperTabController> showView(
  WidgetTester tester,
  ConversationServer server, {
  String account = 'owner',
  Brightness brightness = Brightness.dark,
  bool board = true,
}) async {
  await tester.binding.setSurfaceSize(const Size(1200, 900));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final before = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = before);
  final c = server.controller(account: account);
  await c.refresh();
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => RepaintBoundary(key: _picture, child: child),
      home: Scaffold(
        body: SuperTabView(
          controller: c,
          onAddAgent: (_) {},
          onOpenTerminal: (_) {},
          machineName: (_) => 'Team Mac',
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  addTearDown(c.dispose);
  return c;
}

String minutesAgo(int minutes) => DateTime.now()
    .toUtc()
    .subtract(Duration(minutes: minutes))
    .toIso8601String();

/// The texts painted as tags, in order.
List<String> tagRuns(WidgetTester tester) => [
  for (final (text, _) in tagStyles(tester)) text,
];

/// Each tag painted, with its ink.
List<(String, Color?)> tagStyles(WidgetTester tester) => [
  for (final rich in tester.widgetList<RichText>(find.byType(RichText)))
    ..._tagRuns(rich.text, null),
];

Iterable<(String, Color?)> _tagRuns(
  InlineSpan span,
  TextStyle? inherited,
) sync* {
  if (span is! TextSpan) return;
  final style = inherited?.merge(span.style) ?? span.style;
  if (span.text case final text?
      when style?.backgroundColor == grid.AppSurface.accentWash &&
          style?.fontWeight == FontWeight.w600) {
    yield (text, style?.color);
  }
  for (final child in span.children ?? const <InlineSpan>[]) {
    yield* _tagRuns(child, style);
  }
}

/// WCAG contrast of [a] on [b].
double contrast(Color a, Color b) {
  final (x, y) = (a.computeLuminance(), b.computeLuminance());
  return (math.max(x, y) + 0.05) / (math.min(x, y) + 0.05);
}

/// The table of tags and non-tags the backend and the phone pass too.
final tagTable = jsonDecode(
  File('test/fixtures/tag_fixture.json').readAsStringSync(),
) as Map<String, dynamic>;

/// A Swarm with diego and ken in it, and two messages from its owner: one
/// that tags diego, one that tags nobody.
ConversationServer taggedChat() {
  final server = ConversationServer.chat();
  for (final name in ['diego', 'ken']) {
    (server.state['people'] as List).add({
      'id': name,
      'email': '$name@example.com',
      'role': 'collaborator',
      'username': name,
    });
  }
  server
    ..append(
      '@diego can you free some memory on your Pro-10? Reviews are waiting on it.',
    )
    ..append('Thanks, the review queue is moving again.');
  server.messages.first['mentions'] = ['diego'];
  return server;
}

/// The styles of every run of [text] painted in the tree.
List<TextStyle?> runsOf(WidgetTester tester, String text) => [
  for (final rich in tester.widgetList<RichText>(find.byType(RichText)))
    ..._runs(rich.text, null, text),
];

Iterable<TextStyle?> _runs(
  InlineSpan span,
  TextStyle? inherited,
  String text,
) sync* {
  if (span is! TextSpan) return;
  final style = inherited?.merge(span.style) ?? span.style;
  if (span.text == text) yield style;
  for (final child in span.children ?? const <InlineSpan>[]) {
    yield* _runs(child, style, text);
  }
}

Future<void> showText(
  WidgetTester tester,
  String text,
  List<String> names, {
  Map<String, String> addresses = const {},
}) => tester.pumpWidget(
  MaterialApp(
    theme: grid.buildAppTheme(brightness: Brightness.dark),
    home: Scaffold(
      body: SuperTabMessageText(text, mentions: names, addresses: addresses),
    ),
  ),
);

Finder notificationsEntry() => find.byKey(const ValueKey('super-mentions'));

/// A Swarm whose reader is the peer, with the Lead and the peer's own Buddy
/// chat in the first project, where the PM's private lines reach them.
ConversationServer swarm() {
  final server = ConversationServer.chat();
  server.state['projects'] = [projectFixture('lead', 'web-project', 'lead')];
  server.state['people'] = [
    {'id': 'owner', 'email': 'owner@example.com', 'role': 'owner'},
    {'id': 'peer', 'email': 'ken.tran@example.com', 'role': 'collaborator'},
  ];
  server.state['conversations'] = [
    conversationFixture('lead', 'Lead'),
    {
      ...conversationFixture('buddy-peer-lead', "ken.tran's Buddy"),
      'projectId': 'lead',
      'kind': 'agent-chat',
    },
  ];
  return server;
}

void main() {
  setUpAll(() async {
    if (shots != null) await loadPreviewFonts();
  });

  group('mention fields', () {
    test('a message names the people it tags', () {
      final message = SuperTabMessage.fromJson(
        messageRow(mentions: ['owner', 'dee']),
      );
      expect(message.mentions, ['owner', 'dee']);
    });

    test('a message from an older backend tags nobody', () {
      expect(SuperTabMessage.fromJson(messageRow()).mentions, isEmpty);
    });
  });

  group('tags in messages', () {
    testWidgets('a tagged name reads highlighted where the text says it', (
      tester,
    ) async {
      await showText(tester, 'Please @dee confirm, not @bob.', ['dee']);
      final dee = runsOf(tester, '@dee').single;
      expect(dee?.color, grid.AppPalette.accentOnSurface);
      expect(dee?.backgroundColor, isNotNull);
      // One paragraph: the name does not break the line it is in.
      expect(
        find.text('Please @dee confirm, not @bob.', findRichText: true),
        findsOneWidget,
      );
      final bob = runsOf(tester, '@bob');
      expect(bob.every((s) => s?.backgroundColor == null), isTrue);
    });

    testWidgets('a name ending a sentence is still the name', (tester) async {
      await showText(tester, 'Over to @dee.', ['dee']);
      expect(runsOf(tester, '@dee').single?.backgroundColor, isNotNull);
      expect(find.text('Over to @dee.', findRichText: true), findsOneWidget);
      // Not shown again before the text, as if the text had not said it.
      expect(find.text('@dee', findRichText: true), findsNothing);
    });

    // lampOS's PM is "first builder" and the sandbox has "a2a swarm": a tag of one read as plain text, and a post to one
    // opened with its tag a second time (2026-11-11).
    testWidgets('an agent whose name is several words is its tag, whole', (
      tester,
    ) async {
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: const Scaffold(
            body: SuperTabMessageText(
              '@First Builder heads up on #3706. Not @first, and not @first builders.',
              agents: ['first builder', 'second'],
              addressed: ['first builder'],
            ),
          ),
        ),
      );
      expect(
        runsOf(tester, '@First Builder').single?.backgroundColor,
        isNotNull,
      );
      // Said once, as written: the post it is to does not open with the tag again.
      expect(
        find.text(
          '@First Builder heads up on #3706. Not @first, and not @first builders.',
          findRichText: true,
        ),
        findsOneWidget,
      );
      expect(runsOf(tester, '@first'), isEmpty);
    });

    testWidgets('a full address is the same person', (tester) async {
      await showText(tester, 'Ask @dee@example.com first.', ['dee']);
      expect(
        runsOf(tester, '@dee@example.com').single?.backgroundColor,
        isNotNull,
      );
    });

    testWidgets('a tag the text does not say opens its first line', (
      tester,
    ) async {
      await showText(tester, 'Please confirm the release.', ['dee']);
      expect(runsOf(tester, '@dee').single?.backgroundColor, isNotNull);
      // Same line as the text, as a person types it; never a line of its own.
      expect(
        find.text('@dee Please confirm the release.', findRichText: true),
        findsOneWidget,
      );
      expect(find.text('@dee', findRichText: true), findsNothing);
    });

    testWidgets('several unsaid tags open the first line of a longer text', (
      tester,
    ) async {
      await showText(
        tester,
        '\nShipped this morning:\n- Desktop 1.3.41\n- web 1.3.82',
        ['ken', 'dee'],
      );
      expect(
        find.text('@ken @dee Shipped this morning:', findRichText: true),
        findsOneWidget,
      );
      expect(find.text('Desktop 1.3.41', findRichText: true), findsOneWidget);
    });

    test('a tag joins the first line unless the text opens with a block', () {
      String tagged(String text) =>
          SuperTabMessageText.withTags(['@dee'], text);
      expect(tagged('#2259 merged.'), '@dee #2259 merged.');
      expect(tagged('-5 degrees'), '@dee -5 degrees');
      expect(tagged('2026 plan'), '@dee 2026 plan');
      expect(tagged('Hi'), '@dee Hi');
      expect(tagged('***Important*** now'), '@dee ***Important*** now');
      expect(tagged('__init__ runs'), '@dee __init__ runs');
      expect(
        tagged('[link](https://example.com) here'),
        '@dee [link](https://example.com) here',
      );
      // A list, heading, quote, table or code keeps rendering as one.
      for (final block in [
        '- one\n- two',
        '* one',
        '1. one',
        '# Title',
        '> quoted',
        '| a | b |\n|---|---|',
        '```\ncode\n```',
        '    indented code',
        '---',
        '***',
        '- - -',
        '-\nnext',
        '1.\nnext',
        '[1]: https://example.com',
      ]) {
        expect(tagged(block), '@dee\n\n$block', reason: block);
      }
      expect(SuperTabMessageText.withTags(const [], 'Hi'), 'Hi');
    });

    testWidgets('a text that opens with a list keeps its list', (tester) async {
      await showText(tester, '- one\n- two', ['dee']);
      expect(find.text('one', findRichText: true), findsOneWidget);
      expect(find.text('@dee', findRichText: true), findsOneWidget);
      expect(runsOf(tester, '@dee').single?.backgroundColor, isNotNull);
    });

    testWidgets('a tag in code stays code', (tester) async {
      await showText(tester, 'Run `ping @dee` now.', ['dee']);
      expect(runsOf(tester, 'ping @dee'), isNotEmpty);
    });

    for (final row in (tagTable['cases'] as List).cast<Map>()) {
      testWidgets('finds the tags in ${jsonEncode(row['text'])}', (
        tester,
      ) async {
        final names = (tagTable['names'] as List).cast<String>();
        final tags = (row['tags'] as List).cast<String>();
        await showText(tester, row['text'] as String, names);
        // A tagged name the text does not say opens it (withTags), so each
        // name the table has no tag for in this text is shown first.
        final said = {for (final tag in tags) tag.split('@').first};
        expect(
          [for (final tag in tagRuns(tester)) tag.substring(1).toLowerCase()],
          [
            for (final name in names)
              if (!said.contains(name)) name,
            ...tags,
          ],
        );
      });
    }

    test('reads a 32,000-character text of unclosed link brackets in '
        'linear time', () {
      // Each `](` without a `)` once scanned to the end: about 3 s to draw.
      final watch = Stopwatch()..start();
      expect(SuperTabMessageText.tagsIn('${'](' * 15995}@dee.'), ['dee']);
      // Leave room for shared runners; the regression this guards took about 3 s (#2331).
      expect(watch.elapsedMilliseconds, lessThan(500));
    });

    testWidgets('a tag by its full address is said, and is its pill', (
      tester,
    ) async {
      await showText(
        tester,
        '@diego.n@x.com look',
        ['diego'],
        addresses: {'diego': 'diego.n@x.com'},
      );
      expect(
        find.text('@diego.n@x.com look', findRichText: true),
        findsOneWidget,
      );
      expect(tagRuns(tester), ['@diego.n@x.com']);
    });

    testWidgets('another address is no tag of them', (tester) async {
      await showText(
        tester,
        '@diego@other.com look',
        ['diego'],
        addresses: {'diego': 'diego.n@x.com'},
      );
      expect(
        find.text('@diego @diego@other.com look', findRichText: true),
        findsOneWidget,
      );
      expect(tagRuns(tester), ['@diego']);
    });

    testWidgets('the conversation knows the address of each person tagged', (
      tester,
    ) async {
      final server = taggedChat();
      (server.state['people'] as List).cast<Map>().firstWhere(
        (p) => p['id'] == 'diego',
      )['email'] = 'diego.n@x.com';
      server.messages.first['text'] = '@diego.n@x.com can you look?';
      await showView(tester, server, account: 'ken');
      expect(
        find.text('@diego.n@x.com can you look?', findRichText: true),
        findsOneWidget,
      );
      expect(tagRuns(tester), ['@diego.n@x.com']);
    });

    for (final brightness in Brightness.values) {
      testWidgets('a message that tags you stands out, for you alone '
          '(${brightness.name})', (tester) async {
        Finder tagged(String id) =>
            find.byKey(ValueKey('super-tagged-you-$id'));
        final server = taggedChat();
        await showView(
          tester,
          server,
          account: 'diego',
          brightness: brightness,
        );
        await shot(tester, 'tagged-you-${brightness.name}');
        expect(tagged('message-1'), findsOneWidget);
        expect(tagged('message-2'), findsNothing);
        final row = tester.widget<DecoratedBox>(tagged('message-1'));
        expect(
          (row.decoration as BoxDecoration).color,
          grid.AppSurface.accentWash,
        );
        final bar = tester.getSize(
          find.byKey(const ValueKey('super-tagged-bar-message-1')),
        );
        expect(bar.width, 3);
        expect(bar.height, greaterThan(20));
        expect(
          tester
              .widget<ColoredBox>(
                find.byKey(const ValueKey('super-tagged-bar-message-1')),
              )
              .color,
          grid.AppPalette.accentOnSurface,
        );
        // The tag in the text stays its pill, its ink readable on the pill
        // over the wash (WCAG AA for text, 4.5:1).
        final (tag, ink) = tagStyles(tester).single;
        expect(tag, '@diego');
        final behind = Color.alphaBlend(
          grid.AppSurface.accentWash,
          Color.alphaBlend(
            grid.AppSurface.accentWash,
            grid.AppTheme.surfacePalette.background,
          ),
        );
        expect(contrast(ink!, behind), greaterThanOrEqualTo(4.5));

        // The same message, read by someone else: plain.
        await showView(tester, server, account: 'ken', brightness: brightness);
        await shot(tester, 'tagged-other-${brightness.name}');
        expect(tagged('message-1'), findsNothing);
        // A tag in a message that is not yours keeps the pill it had.
        expect(tagStyles(tester).single.$2, grid.AppPalette.accentOnSurface);
        expect(
          find.byKey(const ValueKey('super-tagged-bar-message-1')),
          findsNothing,
        );
      });
    }

    testWidgets('the conversation highlights the people a message tags', (
      tester,
    ) async {
      final server = ConversationServer.chat()..append('Can you confirm?');
      server.messages.last['mentions'] = ['owner'];
      await showView(tester, server);
      expect(runsOf(tester, '@owner').single?.backgroundColor, isNotNull);
    });
  });

  group('tab and system notice', () {
    // Diego (11-03): the chat notice named no Swarm or chat, so the macOS
    // runner dropped its click and Linux had nothing to open.
    test(
      'a chat notice names its Swarm and chat, so a click opens it',
      () async {
        final notices = ShownNotices();
        final store = DesktopNotificationStore(storage: MemoryStore());
        await store.set(true);
        final system = SystemNotifications(store: store, notifier: notices);
        expect(superTabChatNotice(system, web: true), isNull);
        superTabChatNotice(system, web: false)!(
          'tab-1',
          SuperTabConversation.fromJson(
            conversationFixture('offline', 'Offline editing'),
          ),
          7,
        );
        await pumpEventQueue();
        expect(notices.shown, [
          (title: 'Offline editing', body: 'New messages'),
        ]);
        expect(notices.routes, [('@chat', 'tab-1/offline')]);
      },
    );
  });

  for (final native in [false, true]) {
    testWidgets('a Swarm tab behind another counts its agents that ask '
        'its person (native=$native)', (tester) async {
      final updates = <Map>[];
      const channel = MethodChannel('harness/swarm_tabs');
      tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
        call,
      ) async {
        if (call.method == 'update') updates.add(call.arguments as Map);
        return true;
      });
      addTearDown(
        () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          null,
        ),
      );
      final f = SuperTabLaunchFixture(local: true);
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final swarm = f.app.activeSwarm;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      // Two agents of the reader each wrote in their own chat (Swarm v4: what asks the person).
      for (final name in ['kai', 'quinn']) {
        addAskingAgent(f.connection.server, name);
      }
      await c.refresh();
      expect(tabAgentsAsking(f.app, swarm), 2);
      f.app.newSwarm(name: 'other');
      await mount(tester, f.app, nativeTabs: native);
      await tester.pump(const Duration(milliseconds: 100));
      if (native) {
        final tab = (updates.last['tabs'] as List).cast<Map>().singleWhere(
          (t) => t['id'] == swarm.id,
        );
        expect(tab['attention'], 2);
      } else {
        // A Swarm's tab is its name, bold when something there waits, with
        // no count (Quiet Swarm, screen 0).
        expect(find.byKey(ValueKey('tab-tags:${swarm.id}')), findsNothing);
        expect(find.byKey(ValueKey('tab-activity:${swarm.id}')), findsNothing);
        expect(
          tester
              .widget<Text>(find.byKey(ValueKey('tab-label:${swarm.id}')))
              .style
              ?.fontWeight,
          grid.AppFont.semibold,
        );
      }
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      f.dispose();
    });
  }
}
