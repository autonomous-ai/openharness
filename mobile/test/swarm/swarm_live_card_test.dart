import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/theme/color_palette.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_live_card.dart';
import 'package:harness_mobile/swarm/swarm_message_row.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_fixture.dart';

/// Set to a folder to write the phone cards' screenshots there (run this file
/// alone, on a Mac). Scripted data only.
final shots = Platform.environment['SWARM_CARD_SHOTS'];

const pr = 'https://github.com/example/app/pull/7';
const other = 'https://github.com/example/app/pull/8';

/// The phone's live cards (Slack parity, #2212): a task's brief and the first
/// message linking each PR are cards that change in place as the Swarm's state
/// does. The phone reads no GitHub (Lead, 10-29), so a card shows what the
/// Swarm knows: the task, its checks, the verdict, a recorded merge, the link.
void main() {
  // Real faces for the screenshots, read outside a test's fake clock.
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

  const messages = '/api/super-tabs/$tab/conversations/g1/messages';

  Map<String, dynamic> message(
    String id,
    int sequence,
    String text, {
    String author = 'agent-builder',
  }) => {
    'id': id,
    'conversationId': 'g1',
    'text': text,
    'sequence': sequence,
    'thread': id,
    'author': {
      'kind': 'agent',
      'id': author,
      'name': author == 'agent-lead' ? 'River' : 'Nova',
    },
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 10, 29, 1, sequence).toIso8601String(),
  };

  /// Chat g1, "#12 Fix login": River's brief is its task card, Nova's
  /// "Opened" its PR card; one of its two checks passed.
  Map<String, dynamic> work({
    String status = 'working',
    int? mergedAt,
    List<String> prs = const [pr],
  }) => {
    ...groupData(
      'g1',
      title: 'Fix login',
      number: 12,
      agentIds: ['agent-lead', 'agent-builder'],
      status: status,
      lastMessageSequence: 3,
    ),
    'checks': [
      {'id': 'a', 'description': 'Tests pass', 'evidence': 'ok'},
      {'id': 'b', 'description': 'Screens', 'evidence': null},
    ],
    'pullRequestUrls': prs,
    'cards': {
      'task': 'm1',
      'pullRequests': [
        {'url': pr, 'messageId': 'm2', 'mergedAt': ?mergedAt},
      ],
    },
  };

  /// Ivy reviewed #12 in the review chat g2 of [projectId].
  Map<String, dynamic> review({String projectId = project}) => {
    ...groupData(
      'g2',
      title: 'Review: Fix login',
      number: 13,
      agentIds: ['agent-review'],
      status: 'done',
      workerId: 'agent-review',
    ),
    'projectId': projectId,
    'reviewOf': 'g1',
    'assignment': {
      'id': 'attempt-g2',
      'agentId': 'agent-review',
      'status': 'done',
      'result': 'Ready: no — revision 050bab807. Two findings.',
    },
  };

  FakeSwarm backend({List<Map<String, dynamic>>? groups}) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      groups: groups ?? [work(), review()],
      agents: [
        agent('agent-lead', name: 'Lead', displayName: 'River'),
        agent('agent-builder', displayName: 'Nova'),
        {...agent('agent-review', displayName: 'Ivy'), 'role': 'reviewer'},
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': [
        message('m3', 3, 'CI is running on $pr'),
        message('m2', 2, 'Opened $pr'),
        message('m1', 1, 'Add a sign-in screen.', author: 'agent-lead'),
      ],
      'next': null,
      'threads': <Object>[],
    };
    return fake;
  }

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    Brightness brightness = Brightness.dark,
    double textScale = 1,
    Key? boundary,
  }) async {
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm},
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(textScale)),
            child: SwarmScope(notifier: host, child: child!),
          ),
          home: const SwarmConversationPage(swarmId: tab, conversationId: 'g1'),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  /// The Swarm's next read brings [groups].
  Future<void> change(
    WidgetTester tester,
    SwarmHost host,
    FakeSwarm fake,
    List<Map<String, dynamic>> groups,
  ) async {
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c3', lastChangedAt: 200, groups: groups);
    await host.session!.inbox.reader(tab)!.refresh();
    await tester.pumpAndSettle();
  }

  Finder card(String messageId) =>
      find.byKey(ValueKey('swarm-card-$messageId'));
  Finder inCard(String messageId, String text) =>
      find.descendant(of: card(messageId), matching: find.text(text));

  testWidgets('a task card shows its title, status, checks, PRs and the '
      'verdict from the review chat', (tester) async {
    await pump(tester, backend());
    expect(card('m1'), findsOneWidget);
    expect(inCard('m1', '#12 Fix login'), findsOneWidget);
    expect(inCard('m1', 'Working · 1 of 2 checks passed'), findsOneWidget);
    expect(inCard('m1', 'app · PR #7'), findsOneWidget);
    expect(
      inCard('m1', 'Reviewer: Ivy · Ready: no on 050bab807'),
      findsOneWidget,
    );
    // A later link of the same PR stays a plain message.
    expect(card('m3'), findsNothing);
  });

  testWidgets('a PR card updates in place when its merge is recorded', (
    tester,
  ) async {
    final fake = backend();
    final host = await pump(tester, fake);
    expect(inCard('m2', 'app · PR #7'), findsOneWidget);
    expect(inCard('m2', 'Merged'), findsNothing);
    final built = <String>[];
    final before = debugOnRebuildDirtyWidget;
    debugOnRebuildDirtyWidget = (element, _) {
      if (element.widget case SwarmMessageRow(:final message)) {
        built.add(message.id);
      }
    };
    try {
      await change(tester, host, fake, [part('g1', 9, work(mergedAt: 5))]);
    } finally {
      debugOnRebuildDirtyWidget = before;
    }
    // Both cards show the merge; the plain message is drawn as it was.
    expect(built.toSet(), {'m1', 'm2'});
    expect(inCard('m2', 'Merged'), findsOneWidget);
    expect(inCard('m1', 'Merged'), findsOneWidget);
    expect(card('m2'), findsOneWidget);
  });

  testWidgets('a task card follows its task in place', (tester) async {
    final fake = backend();
    final host = await pump(tester, fake);
    await change(tester, host, fake, [part('g1', 9, work(status: 'review'))]);
    expect(inCard('m1', 'In review · 1 of 2 checks passed'), findsOneWidget);
    await change(tester, host, fake, [
      part('g1', 10, work(status: 'done', prs: [pr, other])),
    ]);
    expect(inCard('m1', 'Done · 1 of 2 checks passed'), findsOneWidget);
    expect(inCard('m1', 'app · PR #8'), findsOneWidget);
  });

  testWidgets('a group taken away while open leaves no card behind', (
    tester,
  ) async {
    final fake = backend();
    final host = await pump(tester, fake);
    expect(card('m1'), findsOneWidget);
    await change(tester, host, fake, [
      {'key': 'g1', 'version': 9, 'changedAt': 9, 'deleted': true},
    ]);
    expect(card('m1'), findsNothing);
    expect(card('m2'), findsNothing);
    expect(find.text('#12 Fix login'), findsNothing);
  });

  testWidgets('a review chat of another project is never read for a card', (
    tester,
  ) async {
    await pump(
      tester,
      backend(
        groups: [
          work(),
          review(projectId: 'other'),
        ],
      ),
    );
    expect(inCard('m1', '#12 Fix login'), findsOneWidget);
    expect(find.textContaining('Ivy'), findsNothing);
    expect(find.textContaining('050bab807'), findsNothing);
  });

  testWidgets('screenshots for review: 375 points, both themes, large text', (
    tester,
  ) async {
    await tester.binding.setSurfaceSize(const Size(375, 812));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final shotsOf = [
      (HarnessPalette.paper, 1.0, 'light'),
      (HarnessPalette.graphite, 1.0, 'dark'),
      (HarnessPalette.graphite, 1.75, 'dark-175'),
    ];
    for (final (palette, scale, name) in shotsOf) {
      grid.AppTheme.palette.value = palette;
      grid.AppTheme.brightness.value = palette.brightness;
      final boundary = GlobalKey();
      final fake = backend(
        groups: [
          work(mergedAt: 5, prs: [pr, other]),
          review(),
        ],
      );
      await pump(
        tester,
        fake,
        brightness: palette.brightness,
        textScale: scale,
        boundary: boundary,
      );
      await tester.runAsync(() async {
        final image =
            await (boundary.currentContext!.findRenderObject()!
                    as RenderRepaintBoundary)
                .toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await File('$shots/phone-cards-$name.png')
            .writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      await tester.pumpWidget(const SizedBox());
    }
    grid.AppTheme.palette.value = HarnessPalette.graphite;
    grid.AppTheme.brightness.value = Brightness.dark;
  }, skip: shots == null || !Platform.isMacOS);

  test("a task's status reads in the desktop's words", () {
    final desktop = File('../desktop/lib/super_tabs/live_card.dart')
        .readAsStringSync();
    final words = {
      for (final m in RegExp(
        r"((?:'\w+'(?: \|\| )?)+) => '([^']+)'",
      ).allMatches(desktop))
        for (final status in RegExp(r"'(\w+)'").allMatches(m.group(1)!))
          status.group(1)!: m.group(2)!,
    };
    expect(words, isNotEmpty);
    for (final MapEntry(key: status, value: word) in words.entries) {
      expect(swarmCardStatus({'status': status}), word, reason: status);
    }
    expect(swarmCardStatus(null), 'Not started');
  });
}
