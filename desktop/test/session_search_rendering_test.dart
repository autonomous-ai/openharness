import 'support/open_harness.dart';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/session_content_search.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'session_content_search_test.dart' show SearchConnection;
import 'swarm_state_test.dart' show createApp;

void main() {
  testWidgets(
    'a harness found by what was said in it shows where, in place of its context',
    (tester) async {
      final connection = SearchConnection({
        'retention cohorts': [
          {
            'agentId': 'a7',
            'sessionId': 's7',
            'field': 'ask',
            'snippet':
                'compare ${kSnippetMarkOpen}retention$kSnippetMarkClose by '
                '$kSnippetMarkOpen${'cohort'}$kSnippetMarkClose',
            'together': true,
            'score': .9,
          },
        ],
      });
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      final map = MemoryKeymap();
      final projects = SwarmProjectStore();
      addTearDown(map.dispose);
      addTearDown(projects.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (_, child) => grid.BrightnessScope(
            child: KeymapProvider(keymap: map, child: child!),
          ),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await openHarnessPicker(tester);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'retention cohorts',
      );
      // Past the pause-in-typing debounce, then the reply.
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(milliseconds: 50));
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      expect(search.selected!.agentId, 'a7');
      final snippet = find.byKey(
        ValueKey('session-snippet:${agentDestinationId('m', 'a7')}'),
      );
      expect(snippet, findsOneWidget);
      expect(
        tester.widget<Text>(snippet).textSpan!.toPlainText(),
        '> compare retention by cohort',
      );
      final found = find.byKey(
        ValueKey('preview-found:${agentDestinationId('m', 'a7')}'),
      );
      expect(found, findsOneWidget);
      final foundText = find.descendant(of: found, matching: find.byType(Text));
      expect(
        tester.widget<Text>(foundText).textSpan!.toPlainText(),
        '> compare retention by cohort',
      );
      expect(tester.widget<Text>(foundText).maxLines, isNull);
      expect(find.text('Found in what you asked'), findsOneWidget);
      app.dispose();
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'a session previews its latest turns from the bottom up, and pages up for older ones',
    variant: TargetPlatformVariant.only(TargetPlatform.macOS),
    (tester) async {
      final tails = <int?>[];
      Map<String, dynamic> row(int turn) => {
        'turn': turn,
        'at': DateTime.now()
            .subtract(Duration(hours: 20 - turn))
            .millisecondsSinceEpoch,
        'ask': 'step $turn of the retention report',
        'answer': [
          'answer $turn',
          for (var line = 0; line < 12; line++) 'line $line of turn $turn',
        ].join('\n'),
        'tools': 'Bash python3 cohorts.py --turn $turn',
      };
      final connection = TailConnection(
        {
          'retention cohorts': [
            {
              'agentId': 'a7',
              'sessionId': 's7',
              'field': 'ask',
              'turn': 2,
              'snippet':
                  'compare ${kSnippetMarkOpen}retention$kSnippetMarkClose',
              'together': true,
              'score': .9,
            },
          ],
        },
        tail: (payload) {
          final before = payload['beforeTurn'] as int?;
          tails.add(before);
          return before == null
              ? {
                  'rows': [for (var turn = 10; turn < 15; turn++) row(turn)],
                  'hasMore': true,
                  'total': 15,
                  'lastAsk': row(14),
                }
              : {
                  'rows': [for (var turn = 5; turn < before; turn++) row(turn)],
                  'hasMore': false,
                  'total': 15,
                };
        },
      );
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      final machine = app.machineStates['m']!;
      machine.agents = [
        for (final agent in machine.agents)
          agent.id == 'a7'
              ? Agent(
                  id: 'a7',
                  sessionId: 's7',
                  name: 'Agent 7',
                  engine: 'codex',
                  terminalAvailable: true,
                  lastActivityAt: DateTime.now().subtract(
                    const Duration(seconds: 20),
                  ),
                )
              : agent,
      ];
      // At work: its preview is still fetched once, never refreshed.
      machine.processingAgentIds.add('a7');
      final map = MemoryKeymap();
      final projects = SwarmProjectStore();
      addTearDown(map.dispose);
      addTearDown(projects.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (_, child) => grid.BrightnessScope(
            child: KeymapProvider(keymap: map, child: child!),
          ),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await openHarnessPicker(tester);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'retention cohorts',
      );
      await tester.pump(const Duration(milliseconds: 200));
      await tester.pump(const Duration(milliseconds: 50));
      // The selected row's latest turns, a moment after it stays selected.
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 50));
      expect(tails, [null]);
      await tester.pump(const Duration(seconds: 10));
      expect(tails, [null], reason: 'nothing refreshes while Cmd-P is open');
      expect(find.text('Working'), findsOneWidget);
      // Under a minute old reads "now", not "0m".
      expect(find.text('now'), findsOneWidget);
      expect(find.text('0m'), findsNothing);

      final list = find.byKey(const ValueKey('session-tail:m:s7'));
      expect(list, findsOneWidget);
      // Newest at the bottom, the turn before it above.
      final newest = find.textContaining(
        'line 11 of turn 14',
        findRichText: true,
      );
      final before = find.textContaining('answer 13', findRichText: true);
      expect(newest, findsOneWidget);
      final listBox = tester.getRect(list);
      expect(
        tester.getBottomLeft(newest).dy,
        lessThanOrEqualTo(listBox.bottom),
      );
      // The match was older than what is shown: where it was, above.
      expect(find.text('Matched earlier · 20h ago'), findsNothing);
      expect(find.textContaining('Matched earlier'), findsOneWidget);
      // The searched words stand out in the turns.
      final ask = tester.widget<RichText>(
        find.descendant(
          of: list,
          matching: find.byWidgetPredicate(
            (widget) =>
                widget is RichText &&
                widget.text.toPlainText().contains('step 14 of the retention'),
          ),
        ),
      );
      final bold = <String>[];
      ask.text.visitChildren((span) {
        if (span is TextSpan &&
            span.style?.fontWeight == FontWeight.w700 &&
            span.text != null) {
          bold.add(span.text!);
        }
        return true;
      });
      expect(bold, ['retention']);

      // One scrollbar, on the turns alone: macOS gives every list its own,
      // and none may wrap the whole preview besides.
      expect(
        find.descendant(
          of: find.ancestor(of: list, matching: find.byType(Semantics)).first,
          matching: find.byType(Scrollbar),
        ),
        findsOneWidget,
      );
      expect(
        find.ancestor(of: list, matching: find.byType(Scrollbar)),
        findsNothing,
      );

      // The long answer fills the viewport; the latest ask stays readable
      // in the pinned header even while its original turn is above the fold.
      expect(find.byKey(const ValueKey('preview-last-ask')), findsOneWidget);

      // Shift-Up scrolls toward older turns, Shift-Down back.
      final controller = tester.widget<ListView>(list).controller!;
      expect(controller.position.pixels, 0);
      // The latest long answer can fill the viewport. Reveal the preceding
      // turn before checking order instead of depending on modal geometry.
      await tester.scrollUntilVisible(
        before,
        80,
        scrollable: find.descendant(
          of: list,
          matching: find.byType(Scrollable),
        ),
      );
      expect(before, findsOneWidget);
      expect(
        tester.getTopLeft(before).dy,
        lessThan(tester.getTopLeft(newest).dy),
      );
      controller.jumpTo(0);
      await tester.pump();
      await key(tester, LogicalKeyboardKey.arrowUp, shift: true);
      await tester.pump();
      expect(controller.position.pixels, greaterThan(0));
      await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
      await tester.pump();
      expect(controller.position.pixels, 0);

      // Near the top, the page above is asked for and joins beneath it.
      controller.jumpTo(controller.position.maxScrollExtent);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 50));
      expect(tails, [null, 10]);
      // Scrolled away from it, the latest ask is pinned above the turns.
      expect(find.byKey(const ValueKey('preview-last-ask')), findsOneWidget);
      expect(
        find.descendant(
          of: find.byKey(const ValueKey('preview-last-ask')),
          matching: find.textContaining('step 14 of the retention report'),
        ),
        findsOneWidget,
      );
      await tester.scrollUntilVisible(
        find.text('Start of conversation'),
        160,
        scrollable: find.descendant(
          of: list,
          matching: find.byType(Scrollable),
        ),
      );
      expect(
        find.textContaining('answer 5', findRichText: true),
        findsOneWidget,
      );
      expect(find.text('Start of conversation'), findsOneWidget);

      app.dispose();
      await tester.pumpWidget(const SizedBox());
    },
  );

  testWidgets(
    'a conversation Harness did not start is found, previewed, and opened as a harness resuming it',
    (tester) async {
      const session = '01a0c4ad-de5e-7000-8000-000000000001';
      const busy = '01a0c4ad-de5e-7000-8000-000000000002';
      const movable = '01a0c4ad-de5e-7000-8000-000000000003';
      const binding = '01a0c4ad-de5e-7000-8000-000000000004';
      const inApp = '01a0c4ad-de5e-7000-8000-000000000005';
      const maybe = '01a0c4ad-de5e-7000-8000-000000000006';
      Map<String, dynamic> external(
        String id, {
        required bool open,
        String? openIn,
      }) => {
        'agentId': '',
        'sessionId': id,
        'engine': 'codex',
        'field': 'ask',
        'snippet':
            'compare ${kSnippetMarkOpen}retention$kSnippetMarkClose by cohort',
        'together': true,
        'score': .9,
        'lastAt': DateTime.now()
            .subtract(const Duration(days: 2))
            .millisecondsSinceEpoch,
        'external': {
          'title': open ? 'Retention, still open' : 'Retention cohorts',
          'cwd': '/work/cohorts',
          'origin': open ? 'terminal' : 'codex-app',
          'open': open,
          'openIn': ?openIn,
        },
      };
      final connection = TailConnection(
        {
          'retention cohorts': [
            external(session, open: false),
            external(busy, open: true),
            external(movable, open: true, openIn: 'terminal'),
            external(binding, open: true, openIn: 'harness'),
            external(inApp, open: true, openIn: 'app'),
            external(maybe, open: true, openIn: 'maybe'),
          ],
        },
        tail: (payload) => {
          'rows': [
            {
              'turn': 0,
              'at': DateTime.now()
                  .subtract(const Duration(days: 2))
                  .millisecondsSinceEpoch,
              'ask': 'compare retention by cohort',
              'answer': 'Day-7 retention is 35%.',
              'tools': '',
            },
          ],
          'hasMore': false,
          'total': 1,
          'external': {'open': payload['sessionId'] == busy},
        },
        create: (payload) => {
          'creationId': payload['creationId'],
          'state': 'failed',
          'failure': {
            'code': 'SESSION_OPEN_ELSEWHERE',
            'detail': 'It is open in another terminal or app. Close it there, then open it here.',
          },
        },
      );
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      final map = MemoryKeymap();
      final projects = SwarmProjectStore();
      addTearDown(map.dispose);
      addTearDown(projects.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          builder: (_, child) => grid.BrightnessScope(
            child: KeymapProvider(keymap: map, child: child!),
          ),
          home: SwarmScreen(
            notifier: app,
            nativeTabs: false,
            projectStore: projects,
          ),
        ),
      );
      await tester.pump(const Duration(milliseconds: 100));
      await openHarnessPicker(tester);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'retention cohorts',
      );
      for (var i = 0; i < 4; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      // Found by what was said in it, as a row of its own.
      final row = search.rows.firstWhere(
        (row) => row.external?.sessionId == session,
      );
      expect(row.title, 'Retention cohorts');
      expect(row.detail, 'Codex · Codex app · cohorts · not in Harness');
      expect(search.canSubmit(row), isTrue);
      final open = search.rows.firstWhere(
        (row) => row.external?.sessionId == busy,
      );
      expect(search.canSubmit(open), isFalse);
      expect(
        search.sessionUnavailable(open),
        contains('Open in another terminal'),
      );
      // A machine that can take one over from its terminal says so: it opens.
      final inTerminal = search.rows.firstWhere(
        (row) => row.external?.sessionId == movable,
      );
      expect(search.sessionUnavailable(inTerminal), isNull);
      expect(search.canSubmit(inTerminal), isTrue);
      // One of Harness's own panes has it (an agent still being bound), or an app does: not here.
      final bound = search.rows.firstWhere(
        (row) => row.external?.sessionId == binding,
      );
      expect(search.sessionUnavailable(bound), 'Already in Harness');
      expect(search.canSubmit(bound), isFalse);
      final heldByApp = search.rows.firstWhere(
        (row) => row.external?.sessionId == inApp,
      );
      expect(search.sessionUnavailable(heldByApp), 'Open in an app');
      final guessed = search.rows.firstWhere(
        (row) => row.external?.sessionId == maybe,
      );
      expect(search.sessionUnavailable(guessed), 'May be open in a terminal');
      expect(search.canSubmit(guessed), isFalse);

      // Previewed like any session: what it is, where it ran, its latest turn.
      while (search.selected?.id != row.id) {
        search.move(1);
      }
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 50));
      expect(
        find.text('Codex · Codex app · cohorts · not in Harness'),
        findsWidgets,
      );
      expect(
        find.textContaining('Day-7 retention is 35%', findRichText: true),
        findsOneWidget,
      );

      // Enter opens a harness resuming it; the machine's refusal is said as it said it.
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pump(const Duration(milliseconds: 100));
      await tester.pump(const Duration(milliseconds: 100));
      expect(connection.creates, hasLength(1));
      expect(
        connection.creates.single,
        containsPair('resumeSessionId', session),
      );
      expect(connection.creates.single, containsPair('engine', 'codex'));
      expect(connection.creates.single, containsPair('cwd', '/work/cohorts'));
      expect(
        connection.creates.single,
        containsPair('name', 'Retention cohorts'),
      );
      expect(
        find.text(
          'It is open in another terminal or app. Close it there, then open it here.',
        ),
        findsOneWidget,
      );
      expect(find.text('Start New Conversation'), findsNothing);

      app.dispose();
      await tester.pumpWidget(const SizedBox());
    },
  );
}

/// A machine that searches and previews: `session_tail` answered by [tail].
class TailConnection extends SearchConnection {
  TailConnection(super.answers, {required this.tail, this.create});

  final Map<String, dynamic> Function(Map<String, dynamic> payload) tail;

  /// How `agent_create` is answered; each payload is kept in [creates].
  final Map<String, dynamic> Function(Map<String, dynamic> payload)? create;
  final creates = <Map<String, dynamic>>[];

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    if (type == 'session_tail') return tail(payload);
    if (type == 'agent_create' && create != null) {
      creates.add(payload);
      return create!(payload);
    }
    return super.request(type, payload: payload, timeout: timeout);
  }
}
