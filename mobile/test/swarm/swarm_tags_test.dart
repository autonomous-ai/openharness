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
import 'package:harness_mobile/swarm/model.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Tags are words in the sentence, as people tag in Slack (Dee, 10-30): the
/// phone pills the same words the backend and Desktop read as tags, and a
/// message that tags the reader stands out, for that reader alone.
final shots = Platform.environment['SWARM_TAG_SHOTS'];

/// The table of tags and non-tags the backend and Desktop pass too.
final table = jsonDecode(
  File('test/fixtures/tag_fixture.json').readAsStringSync(),
) as Map<String, dynamic>;

/// The texts painted as tag pills, in order.
List<String> pills(WidgetTester tester) => [
  for (final rich in tester.widgetList<RichText>(find.byType(RichText)))
    ..._pills(rich.text, null),
];

Iterable<String> _pills(InlineSpan span, TextStyle? inherited) sync* {
  if (span is! TextSpan) return;
  final style = inherited?.merge(span.style) ?? span.style;
  if (span.text case final text?
      when style?.backgroundColor == AppSurface.accentWash &&
          style?.color == AppPalette.accentOnSurface) {
    yield text;
  }
  for (final child in span.children ?? const <InlineSpan>[]) {
    yield* _pills(child, style);
  }
}

Future<void> showRow(
  WidgetTester tester,
  String text, {
  List<String> tagged = const [],
  List<String> mentions = const [],
  String readerId = '',
}) async {
  await tester.binding.setSurfaceSize(const Size(390, 844));
  addTearDown(() => tester.binding.setSurfaceSize(null));
  final message = SuperTabMessage.fromJson({
    'id': 'm1',
    'conversationId': 'g1',
    'text': text,
    'sequence': 1,
    'mentions': mentions,
    'author': {'kind': 'person', 'id': me, 'name': 'owner'},
    'createdAt': DateTime.utc(2026, 10, 30, 9, 8).toIso8601String(),
  });
  await tester.pumpWidget(
    MaterialApp(
      home: Scaffold(
        body: ListView(
          children: [
            SwarmMessageRow(
              message: message,
              name: 'owner',
              look: (picture: null, status: null),
              role: null,
              mentions: SwarmMentions(const []),
              tagged: tagged,
              readerId: readerId,
              grouped: false,
              lit: false,
              quote: null,
              actions: false,
              onTap: () {},
              onReply: null,
            ),
          ],
        ),
      ),
    ),
  );
  await tester.pump();
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

  group('the shared table', () {
    for (final row in (table['cases'] as List).cast<Map>()) {
      testWidgets('finds the tags in ${jsonEncode(row['text'])}', (
        tester,
      ) async {
        await showRow(
          tester,
          row['text'] as String,
          tagged: (table['names'] as List).cast<String>(),
        );
        expect([
          for (final pill in pills(tester)) pill.substring(1).toLowerCase(),
        ], row['tags']);
      });
    }
  });

  testWidgets('a person\'s tag is the Desktop pill', (tester) async {
    await showRow(tester, '@diego can you look?', tagged: ['diego']);
    final pill = tester
        .widgetList<RichText>(find.byType(RichText))
        .expand((rich) => _styled(rich.text, null))
        .firstWhere((run) => run.$1 == '@diego')
        .$2;
    expect(pill?.color, AppPalette.accentOnSurface);
    expect(pill?.backgroundColor, AppSurface.accentWash);
    expect(pill?.fontWeight, FontWeight.w600);
  });

  testWidgets('a name the message does not tag is no pill', (tester) async {
    await showRow(tester, '@diego and @ken, look', tagged: ['diego']);
    expect(pills(tester), ['@diego']);
  });

  testWidgets('a long tagged name wraps at 390 points', (tester) async {
    final name = 'a-very-long-username-${'x' * 60}';
    await showRow(
      tester,
      '@$name can you free some memory on your Pro-10?',
      tagged: [name],
      mentions: ['someone'],
      readerId: 'someone',
    );
    expect(tester.takeException(), isNull);
    expect(pills(tester), ['@$name']);
    for (final rich in find.byType(RichText).evaluate()) {
      expect(rich.size!.width, lessThanOrEqualTo(390));
    }
  });

  for (final palette in [HarnessPalette.graphite, HarnessPalette.paper]) {
    testWidgets('a message that tags you stands out, for you alone '
        '(${palette.brightness.name})', (tester) async {
      final before = (AppTheme.palette.value, AppTheme.brightness.value);
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = palette.brightness;
      addTearDown(() {
        AppTheme.palette.value = before.$1;
        AppTheme.brightness.value = before.$2;
      });
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      Finder tagged(String id) => find.byKey(ValueKey('swarm-tagged-you-$id'));

      await showChat(tester, reader: 'diego', brightness: palette.brightness);
      await shot(tester, 'phone-tagged-you-${palette.brightness.name}');
      expect(tagged('m1'), findsOneWidget);
      expect(tagged('m2'), findsNothing);
      final row = tester.widget<Container>(tagged('m1'));
      expect((row.decoration! as BoxDecoration).color, AppSurface.accentWash);
      final bar =
          (row.foregroundDecoration! as BoxDecoration).border! as Border;
      expect(bar.left.width, 3);
      expect(bar.left.color, AppPalette.accentOnSurface);
      expect(pills(tester), contains('@diego'));

      // The same message, read by someone else: plain, its tag still a pill.
      await showChat(tester, reader: 'ken', brightness: palette.brightness);
      await shot(tester, 'phone-tagged-other-${palette.brightness.name}');
      expect(tagged('m1'), findsNothing);
      expect(pills(tester), contains('@diego'));
      await closeChat(tester);
    });
  }
}

Iterable<(String, TextStyle?)> _styled(
  InlineSpan span,
  TextStyle? inherited,
) sync* {
  if (span is! TextSpan) return;
  final style = inherited?.merge(span.style) ?? span.style;
  if (span.text case final text?) yield (text, style);
  for (final child in span.children ?? const <InlineSpan>[]) {
    yield* _styled(child, style);
  }
}

final _boundary = GlobalKey();
SwarmHost? _host;

/// Closes the chat and ends its host's timers.
Future<void> closeChat(WidgetTester tester) async {
  await tester.pumpWidget(const SizedBox());
  _host?.dispose();
  _host = null;
  await tester.pump(const Duration(minutes: 1));
}

Future<void> shot(WidgetTester tester, String name) async {
  if (shots == null) return;
  await tester.runAsync(() async {
    final image =
        await (_boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary)
            .toImage(pixelRatio: 3);
    final png = await image.toByteData(format: ui.ImageByteFormat.png);
    await Directory(shots!).create(recursive: true);
    await File('$shots/$name.png').writeAsBytes(png!.buffer.asUint8List());
    image.dispose();
  });
}

/// The project chat as [reader] reads it: the owner's message that tags
/// diego, then one that tags nobody.
Future<void> showChat(
  WidgetTester tester, {
  required String reader,
  required Brightness brightness,
}) async {
  if (_host != null) await closeChat(tester);
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  Map<String, dynamic> member(String id, String role) => {
    ...person(id, role: role),
    'username': id == me ? 'owner' : id,
  };
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
    'members': [
      part(me, 1, member(me, 'owner')),
      part('diego', 1, member('diego', 'collaborator')),
      part('ken', 1, member('ken', 'collaborator')),
    ],
  };
  fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
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
        'text':
            '@diego can you free some memory on your Pro-10? '
            'Reviews are waiting on it.',
        'sequence': 1,
        'mentions': ['diego'],
        'author': {'kind': 'person', 'id': me, 'name': 'owner'},
        'createdAt': DateTime.utc(2026, 10, 30, 9, 8).toIso8601String(),
      },
      {
        'id': 'm2',
        'conversationId': 'g1',
        'text': 'Thanks, the review queue is moving again.',
        'sequence': 2,
        'author': {'kind': 'person', 'id': me, 'name': 'owner'},
        'createdAt': DateTime.utc(2026, 10, 30, 9, 12).toIso8601String(),
      },
    ],
    'next': null,
  };
  final host = SwarmHost(
    accountId: () => reader,
    account: ValueNotifier<String?>(reader),
    request: fake.request,
    notices: SilentSystemNotices(),
    features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm},
    readMarks: MemoryKeyValueStore(),
  )..foreground = false;
  _host = host;
  await tester.pumpWidget(
    RepaintBoundary(
      key: _boundary,
      child: MaterialApp(
        key: ValueKey('chat-$reader-$brightness'),
        debugShowCheckedModeBanner: false,
        theme: buildAppTheme(brightness: brightness),
        builder: (_, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
      ),
    ),
  );
  for (var i = 0; i < 40; i++) {
    await tester.runAsync(
      () => Future<void>.delayed(const Duration(milliseconds: 10)),
    );
    await tester.pump();
    if (find
        .textContaining('Reviews are waiting', findRichText: true)
        .evaluate()
        .isNotEmpty) {
      break;
    }
  }
}
