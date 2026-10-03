import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/session_content_search.dart';
import 'package:harness/state/swarm_navigation.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/store/store_mark.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/desktop_chrome.dart';
import 'package:harness/widgets/swarm_search_preview.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show key;
import 'session_search_rendering_test.dart' show TailConnection;
import 'swarm_screen_test.dart' show terminal;
import 'swarm_search_preview_test.dart' show seedPreviews;
import 'swarm_state_test.dart' show createApp;

class _ReviewPalette {
  _ReviewPalette(this.search);

  final SwarmSearchController search;
  final editor = TextEditingController();
  final focus = FocusNode();
  final chosen = <SwarmSearchSelection>[];

  void dispose() {
    search.dispose();
    editor.dispose();
    focus.dispose();
  }
}

const _inputKey = ValueKey('review-search-input');
final _input = find.byKey(_inputKey);

Future<_ReviewPalette> _mount(
  WidgetTester tester,
  SwarmSearchController search, {
  bool desktop = false,
  bool bios = false,
  bool showPreview = true,
}) async {
  final fixture = _ReviewPalette(search);
  addTearDown(fixture.dispose);
  tester.view.physicalSize = const Size(1000, 780);
  tester.view.devicePixelRatio = 1;
  addTearDown(tester.view.resetPhysicalSize);
  addTearDown(tester.view.resetDevicePixelRatio);
  final content = SwarmSearchKeys(
    search: search,
    desktop: desktop,
    editing: fixture.editor,
    onChoose: fixture.chosen.add,
    onClose: () {},
    onRefocus: fixture.focus.requestFocus,
    child: Column(
      children: [
        TextField(
          key: _inputKey,
          controller: fixture.editor,
          focusNode: fixture.focus,
          autofocus: true,
          onChanged: search.setQuery,
        ),
        Expanded(
          child: SwarmSearchResults(
            search: search,
            terminal: true,
            bios: bios,
            showPreview: showPreview,
            onChoose: fixture.chosen.add,
            onRefocus: fixture.focus.requestFocus,
          ),
        ),
      ],
    ),
  );
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: Scaffold(
        body: Center(
          child: SizedBox(
            width: 620,
            height: 720,
            child: desktop ? DesktopChrome(child: content) : content,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  addTearDown(() async {
    await tester.pumpWidget(const SizedBox());
    await tester.pump();
  });
  return fixture;
}

Future<void> _query(WidgetTester tester, String value) async {
  await tester.enterText(_input, value);
  await tester.pump(const Duration(milliseconds: 200));
  await tester.pump(const Duration(milliseconds: 160));
  await tester.pumpAndSettle();
}

void main() {
  testWidgets(
    'terminal command preview keeps context and invokes only on Enter',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      final command = SwarmDestination(
        id: 'command:release.check',
        commandId: 'release.check',
        title: 'Check release',
        detail: 'Inspect the release configuration',
        shortcut: '⌘⇧R',
        swarmId: null,
        current: false,
      );
      final fixture = await _mount(
        tester,
        SwarmSearchController(
          app,
          const [],
          activityFirst: true,
          commands: () => [command],
        ),
      );
      await _query(tester, '> release');
      final preview = find.byType(SwarmSearchPreview);
      expect(preview, findsOneWidget);
      for (final text in [command.title, command.detail, command.shortcut!]) {
        final label = find.descendant(of: preview, matching: find.text(text));
        expect(label, findsOneWidget);
        expect(
          tester.widget<Text>(label).style!.fontFamily,
          terminalContentStyle().fontFamily,
        );
      }
      expect(fixture.chosen, isEmpty);
      await key(tester, LogicalKeyboardKey.enter);
      expect(fixture.chosen.single.destination.commandId, 'release.check');
      expect(fixture.editor.text, '> release');
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'dated older content matches remain distinct from the latest turn',
    (tester) async {
      final earlier = DateTime.now().subtract(
        const Duration(hours: 18, minutes: 5),
      );
      final connection = TailConnection(
        {
          'retention cohorts': [
            {
              'agentId': 'a7',
              'sessionId': 's7',
              'field': 'ask',
              'turn': 2,
              'at': earlier.millisecondsSinceEpoch,
              'snippet':
                  'Compare ${kSnippetMarkOpen}retention$kSnippetMarkClose by cohort',
              'together': true,
              'score': .9,
            },
          ],
        },
        tail: (_) => {
          'rows': [
            {
              'turn': 10,
              'at': DateTime.now().millisecondsSinceEpoch,
              'ask': 'Verify the latest report',
              'answer': 'Newest report verified.',
              'tools': '',
            },
          ],
          'hasMore': false,
          'total': 11,
        },
      );
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = [
        const Agent(
          id: 'a7',
          sessionId: 's7',
          name: 'Cohort report',
          engine: 'codex',
          terminalAvailable: true,
        ),
      ];
      final fixture = await _mount(
        tester,
        SwarmSearchController(app, const [], adding: true, activityFirst: true),
      );
      await _query(tester, 'retention cohorts');
      final preview = find.byType(SwarmSearchPreview);
      expect(find.text('Matched earlier · 18h ago'), findsOneWidget);
      expect(
        find.descendant(
          of: preview,
          matching: find.textContaining(
            'Compare retention by cohort',
            findRichText: true,
          ),
        ),
        findsOneWidget,
      );
      expect(
        find.textContaining('Newest report verified.', findRichText: true),
        findsOneWidget,
      );
      expect(fixture.search.selected!.agentId, 'a7');
      expect(fixture.focus.hasFocus, isTrue);
      expect(fixture.chosen, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'terminal preview explains an external conversation that is open elsewhere',
    (tester) async {
      final connection = TailConnection(
        {
          'retention cohorts': [
            {
              'agentId': '',
              'sessionId': 'external-session',
              'engine': 'codex',
              'field': 'ask',
              'snippet': 'Review retention cohorts',
              'score': .9,
              'external': {
                'title': 'External cohort report',
                'cwd': '/work/cohorts',
                'origin': 'codex-app',
                'open': true,
                'openIn': 'app',
              },
            },
          ],
        },
        tail: (_) => {
          'rows': [],
          'hasMore': false,
          'external': {'open': true, 'openIn': 'app'},
        },
      );
      final app = createApp(
        connected: true,
        connectionForTest: (_) => connection,
      );
      addTearDown(app.dispose);
      final fixture = await _mount(
        tester,
        SwarmSearchController(app, const [], adding: true, activityFirst: true),
      );
      await _query(tester, 'retention cohorts');
      expect(fixture.search.selected!.external!.sessionId, 'external-session');
      final warning = find.text(
        'Open in the Codex app. Close it there to open it here.',
      );
      expect(warning, findsOneWidget);
      expect(
        tester.widget<Text>(warning).style!.color,
        terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        ).yellow,
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(fixture.chosen, isEmpty);
      expect(fixture.editor.text, 'retention cohorts');
      expect(fixture.focus.hasFocus, isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  for (final bios in [false, true]) {
    testWidgets('legacy empty results recover after editing (bios=$bios)', (
      tester,
    ) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final fixture = await _mount(
        tester,
        SwarmSearchController(
          app,
          const [],
          adding: true,
          offersHarnessCreate: false,
        ),
        bios: bios,
        showPreview: false,
      );
      await _query(tester, 'unmatched-999999');
      final message = find.text('No matching harnesses');
      expect(message, findsOneWidget);
      expect(fixture.search.selected, isNull);
      await key(tester, LogicalKeyboardKey.enter);
      expect(fixture.chosen, isEmpty);
      await _query(tester, 'Agent 1');
      expect(message, findsNothing);
      expect(fixture.search.selected, isNotNull);
      await key(tester, LogicalKeyboardKey.enter);
      expect(fixture.chosen.single.destination.agentId, 'a1');
      expect(tester.takeException(), isNull);
    });
  }

  testWidgets(
    'bottom-up terminal results keep the preview above and keyboard scrolling independent',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      await seedPreviews(app);
      for (final agentId in ['a1', 'a2']) {
        await app.handleEventForTest('m', {
          'type': 'turn_ended',
          'payload': {'agentId': agentId, 'sessionId': 'session-$agentId'},
        });
      }
      final agent = app.machineStates['m']!.agents.first;
      app.sessionPreviews.read(app.previewKey('m', agent))!.completedText =
          List.generate(60, (i) => 'Explanation line $i').join('\n');
      final fixture = await _mount(
        tester,
        SwarmSearchController(
          app,
          const [],
          adding: true,
          resultsFromBottom: true,
        ),
      );
      await _query(tester, 'Checkout retries');
      final preview = find.byType(SwarmSearchPreview);
      final results = find.byWidgetPredicate(
        (widget) =>
            widget is Semantics && widget.properties.label == 'Search results',
      );
      expect(tester.getRect(results).top - tester.getRect(preview).bottom, 8);
      final scrolling = tester
          .state<ScrollableState>(
            find
                .descendant(of: preview, matching: find.byType(Scrollable))
                .first,
          )
          .position;
      final selected = fixture.search.selected!.id;
      await key(tester, LogicalKeyboardKey.arrowDown, shift: true);
      expect(scrolling.pixels, greaterThan(0));
      expect(fixture.search.selected!.id, selected);
      expect(fixture.editor.text, 'Checkout retries');
      expect(fixture.focus.hasFocus, isTrue);
      expect(fixture.chosen, isEmpty);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'desktop history gives the Store its own mark and activates its existing tab',
    (tester) async {
      final app = createApp();
      addTearDown(app.dispose);
      app.openStore();
      final storeId = app.activeSwarmId;
      app.newSwarm(name: 'Work');
      final history = SwarmNavigationHistory();
      addTearDown(history.dispose);
      app.selectSwarm(storeId);
      history.record(app);
      final fixture = await _mount(
        tester,
        SwarmSearchController(app, history.recent, history: history),
        desktop: true,
        showPreview: false,
      );
      await _query(tester, 'Harness Store');
      expect(fixture.search.selected!.isStore, isTrue);
      final row = find.byKey(ValueKey(swarmDestinationId(storeId)));
      expect(
        find.descendant(of: row, matching: find.byType(StoreMark)),
        findsOneWidget,
      );
      await tester.tap(row);
      await tester.pump();
      expect(fixture.chosen.single.destination.swarmId, storeId);
      expect(fixture.chosen.single.destination.isStore, isTrue);
      expect(tester.takeException(), isNull);
    },
  );

  testWidgets(
    'a full desktop tab explains recovery and a new tab can open a result',
    (tester) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      app.machineStates['m']!.agents = app.machineStates['m']!.agents
          .take(AppNotifier.maxPanes)
          .toList();
      for (var i = 0; i < AppNotifier.maxPanes; i++) {
        app.adoptSessionForTest(terminal('a$i', []));
      }
      final fullTab = app.activeSwarm;
      final full = await _mount(
        tester,
        SwarmSearchController(
          app,
          const [],
          adding: true,
          offersHarnessCreate: false,
        ),
        desktop: true,
        showPreview: false,
      );
      expect(full.search.capacity, 0);
      expect(full.search.rows, isEmpty);
      expect(
        find.text(
          'This tab is full (${AppNotifier.maxPanes} panes). Open a new tab to add more.',
        ),
        findsOneWidget,
      );
      await key(tester, LogicalKeyboardKey.enter);
      expect(full.chosen, isEmpty);
      expect(fullTab.panes, hasLength(AppNotifier.maxPanes));

      app.newSwarm(name: 'Another task');
      final available = await _mount(
        tester,
        SwarmSearchController(
          app,
          const [],
          adding: true,
          offersHarnessCreate: false,
        ),
        desktop: true,
        showPreview: false,
      );
      await _query(tester, 'Agent 0');
      expect(available.search.capacity, AppNotifier.maxPanes);
      expect(find.textContaining('This tab is full'), findsNothing);
      await key(tester, LogicalKeyboardKey.enter);
      expect(available.chosen.single.destination.agentId, 'a0');
      expect(available.search.targetId, app.activeSwarmId);
      expect(fullTab.panes, hasLength(AppNotifier.maxPanes));
      expect(tester.takeException(), isNull);
    },
  );
}
