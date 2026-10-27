
import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/gestures.dart' show kSecondaryMouseButton;
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/swarm_switcher.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;
import 'box_render_preview_test.dart' show loadPreviewFonts;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

void main() {
  setUpAll(() async {
    if (Platform.environment['SUPER_TAB_PICKER_SHOTS'] != null) {
      await loadPreviewFonts();
    }
  });
  final input = find.byKey(const ValueKey('swarm-search-input'));
  final picture = GlobalKey();

  Future<SuperTabLaunchFixture> open(
    WidgetTester tester, {
    Size size = const Size(1280, 800),
    Brightness brightness = Brightness.dark,
    double scale = 1,
    List<Agent> extraLocalAgents = const [],
  }) async {
    final oldEntry = newHarnessOpensInBox;
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = oldEntry);
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.server.state['agents'] = <dynamic>[
      {
        'id': 'remote-agent',
        'name': 'Teammate builder',
        'machineId': 'teammate-machine',
        'harnessId': 'teammate-session',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
    ];
    f.app.machineStates['m']!.agents = [
      const Agent(
        id: 'local-agent',
        name: 'Local builder',
        engine: 'codex',
        terminalAvailable: true,
      ),
      const Agent(
        id: 'stopped',
        name: 'Stopped builder',
        engine: 'codex',
        terminalAvailable: false,
      ),
      const Agent(
        id: 'shell',
        name: 'Plain shell',
        engine: 'terminal',
        terminalAvailable: true,
      ),
      ...extraLocalAgents,
    ];
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    c.select('offline');
    // The teammate's machine has no reading, so it sits under the closed "Offline" disclosure.
    c.offlineMachinesOpen = true;
    await f.app.agentPreference.remember('codex');
    await f.app.projectHistory.select('m', '/work/project');
    final map = MemoryKeymap();
    addTearDown(map.dispose);
    final projects = SwarmProjectStore();
    addTearDown(projects.dispose);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final oldBrightness = grid.AppTheme.brightness.value;
    final oldPalette = grid.AppTheme.palette.value;
    grid.AppTheme.brightness.value = brightness;
    grid.AppTheme.palette.value = grid.AppTheme.paletteFor(brightness);
    addTearDown(() {
      grid.AppTheme.brightness.value = oldBrightness;
      grid.AppTheme.palette.value = oldPalette;
    });
    await tester.pumpWidget(
      RepaintBoundary(
        key: picture,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => KeymapProvider(
            keymap: map,
            child: MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
          ),
          home: SwarmScreen(
            notifier: f.app,
            nativeTabs: false,
            projectStore: projects,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    final machine = find.byKey(
      const ValueKey('super-machine-teammate-machine'),
    );
    if (machine.evaluate().isEmpty &&
        find.byTooltip('Conversations').evaluate().isNotEmpty) {
      await tester.tap(find.byTooltip('Conversations'));
      await tester.pumpAndSettle();
    }
    // The sidebar builds only the rows near its view: at a large text size the
    // Machines group starts below it.
    final sidebar = find
        .descendant(
          of: find.byType(ProjectSidebar),
          matching: find.byType(Scrollable),
        )
        .first;
    // The teammate's machine is not online here, so it may sit under the closed "Offline" disclosure.
    final offline = find.byKey(const ValueKey('super-machines-offline'));
    for (
      var i = 0;
      i < 50 && machine.evaluate().isEmpty && offline.evaluate().isEmpty;
      i++
    ) {
      await tester.drag(sidebar, const Offset(0, -100));
      await tester.pumpAndSettle();
    }
    if (machine.evaluate().isEmpty && offline.evaluate().isNotEmpty) {
      await tester.ensureVisible(offline);
      await tester.tap(offline);
      await tester.pumpAndSettle();
    }
    await tester.ensureVisible(machine);
    await tester.pumpAndSettle();
    // A machine's details are in its right-click menu; a click expands it.
    await tester.tap(machine, buttons: kSecondaryMouseButton);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Details').last);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Attach running agent'));
    await tester.pumpAndSettle();
    return f;
  }

  for (final (name, brightness, size, scale) in [
    ('dark', Brightness.dark, const Size(1280, 800), 1.0),
    ('light', Brightness.light, const Size(1280, 800), 1.0),
    ('large', Brightness.dark, const Size(800, 480), 2.0),
  ]) {
    testWidgets('Add agent fits the app at $name', (tester) async {
      final f = await open(
        tester,
        size: size,
        brightness: brightness,
        scale: scale,
      );
      await tester.enterText(input, 'Teammate builder');
      await tester.pumpAndSettle();
      expect(find.text('Add agent to Pilot'), findsOneWidget);
      expect(tester.widget<TextField>(input).focusNode!.hasFocus, isTrue);
      final results = find.byType(SwarmSearchResults);
      expect(
        tester.widget<SwarmSearchResults>(results).search.hasPreview,
        isFalse,
      );
      final chosenName = find.descendant(
        of: results,
        matching: find.text('Teammate builder'),
      );
      expect(chosenName, findsOneWidget);
      final viewport = tester.getRect(results);
      final label = tester.getRect(chosenName);
      expect(label.top, greaterThanOrEqualTo(viewport.top));
      expect(label.bottom, lessThanOrEqualTo(viewport.bottom));
      expect(tester.takeException(), isNull);
      final directory = Platform.environment['SUPER_TAB_PICKER_SHOTS'];
      if (directory != null) {
        await tester.runAsync(() async {
          final boundary =
              picture.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary;
          final image = await boundary.toImage();
          final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
          await Directory(directory).create(recursive: true);
          await File('$directory/$name.png')
              .writeAsBytes(bytes!.buffer.asUint8List());
          image.dispose();
        });
      }
      await tester.pumpWidget(const SizedBox());
      await f.app.superTabs.peek(tabId)!.flush();
      f.app.superTabs.dispose();
    });
  }

  testWidgets(
    'Add agent names its group and reuses a teammate agent without machine access or another pane',
    (tester) async {
      final f = await open(tester);
      final shared = f.app.activeSwarm;
      expect(find.text('Add agent to Pilot'), findsOneWidget);
      expect(find.text('Starts in Offline editing.'), findsOneWidget);
      expect(find.text('Models'), findsNothing);
      expect(find.text('Store'), findsNothing);
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      final remote = search.rows.singleWhere(
        (row) => row.agentId == 'teammate-session',
      );
      expect(remote.isAgentChoice, isFalse);
      expect(search.canSubmit(remote), isTrue);
      expect(search.actionLabel(remote), 'Add agent');
      expect(search.rows.where((row) => row.agentId == 'stopped'), isEmpty);
      expect(
        search.canSubmit(
          search.rows.singleWhere((row) => row.agentId == 'shell'),
        ),
        isFalse,
      );
      expect(search.selected?.isCreate, isFalse);
      expect(f.app.stateOf('teammate-machine'), isNull);
      // Navigation underneath an open picker cannot change its contribution target.
      f.app.superTabs.peek(tabId)!.select('lead');
      await tester.enterText(input, 'Teammate builder');
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Add agent'));
      await tester.pumpAndSettle();
      expect(f.connection.server.posts.last['command'], {
        'type': 'conversation.agent',
        'conversationId': 'offline',
        'agentId': 'remote-agent',
        'present': true,
        'lead': false,
      });
      expect(f.app.activeSwarm, same(shared));
      expect(shared.panes, isEmpty);
      expect(
        f.connection.calls.where((call) => call.$1 == 'agent_create'),
        isEmpty,
      );
      expect(f.connection.joins, isEmpty);
      await key(tester, LogicalKeyboardKey.keyP, cmd: true);
      await tester.pumpAndSettle();
      final ordinary = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      expect(ordinary.harnessContext, isNull);
      expect(ordinary.placement, HarnessPlacement.newTab);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await f.app.superTabs.peek(tabId)!.flush();
      f.app.superTabs.dispose();
    },
  );

  testWidgets(
    'Add agent disables running engines outside Claude Code and Codex',
    (tester) async {
      final f = await open(
        tester,
        extraLocalAgents: const [
          Agent(
            id: 'open-code',
            name: 'OpenCode builder',
            engine: 'opencode',
            terminalAvailable: true,
          ),
          Agent(
            id: 'pi-agent',
            name: 'Pi builder',
            engine: 'pi',
            terminalAvailable: true,
          ),
        ],
      );
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      for (final id in ['open-code', 'pi-agent']) {
        final row = search.rows.singleWhere((row) => row.agentId == id);
        expect(
          search.sessionUnavailable(row),
          'Only Claude Code or Codex can join this Swarm.',
        );
        expect(search.canSubmit(row), isFalse);
      }
      expect(
        search.canSubmit(
          search.rows.singleWhere((row) => row.agentId == 'local-agent'),
        ),
        isTrue,
      );
      await tester.pumpWidget(const SizedBox());
      await f.app.superTabs.peek(tabId)!.flush();
      f.app.superTabs.dispose();
    },
  );

  testWidgets(
    'withdrawing conversation access closes Add agent without contributing',
    (tester) async {
      final f = await open(tester);
      f.app.superTabs.peek(tabId)!.revokeAccess('Access was removed.');
      await tester.pumpAndSettle();
      expect(input, findsNothing);
      expect(find.text('Add agent to Pilot'), findsNothing);
      expect(f.connection.server.posts, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await f.app.superTabs.peek(tabId)!.flush();
      f.app.superTabs.dispose();
    },
  );

  testWidgets(
    'a teammate added elsewhere cannot be added again from a stale picker',
    (tester) async {
      final f = await open(tester);
      await tester.enterText(input, 'Teammate builder');
      await tester.pumpAndSettle();
      final search = tester
          .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
          .search;
      expect(search.canAccept, isTrue);
      (f.connection.server.state['conversations'] as List)[1]['agentIds'] = [
        'remote-agent',
      ];
      await f.app.superTabs.peek(tabId)!.refresh();
      await tester.pumpAndSettle();
      expect(search.canAccept, isFalse);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Add agent'),
            )
            .onPressed,
        isNull,
      );
      expect(
        search.sessionUnavailable(search.selected),
        'Already in this conversation.',
      );
      await key(tester, LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(f.connection.server.posts, isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await f.app.superTabs.peek(tabId)!.flush();
      f.app.superTabs.dispose();
    },
  );

  testWidgets('archiving the target conversation closes Add agent', (
    tester,
  ) async {
    final f = await open(tester);
    (f.connection.server.state['conversations'] as List)[1]['archived'] = true;
    await f.app.superTabs.peek(tabId)!.refresh();
    await tester.pumpAndSettle();
    expect(input, findsNothing);
    expect(f.connection.server.posts, isEmpty);
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await f.app.superTabs.peek(tabId)!.flush();
    f.app.superTabs.dispose();
  });

  testWidgets('New Harness from Add agent retains the captured conversation', (
    tester,
  ) async {
    final f = await open(tester);
    final c = f.app.superTabs.peek(tabId)!;
    c.select('lead');
    final search = tester
        .widget<SwarmSearchResults>(find.byType(SwarmSearchResults))
        .search;
    final create = search.rows.singleWhere((row) => row.id == 'create:harness');
    search.move(search.rows.indexOf(create) - search.cursor);
    await key(tester, LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    final box = tester
        .widget<NewHarnessForm>(find.byType(NewHarnessForm))
        .controller;
    box.setFolder('/work/project');
    await tester.pumpAndSettle();
    await tester.tap(find.byKey(const ValueKey('new-harness-field-start')));
    await tester.pumpAndSettle();
    expect(box.error, isNull);
    expect(box.checking, isFalse);
    expect(
      f.connection.joins.single['command'],
      containsPair('conversationId', 'offline'),
    );
    expect(f.connection.joins.single['command'], containsPair('lead', false));
    expect(f.app.swarms, hasLength(1));
    expect(f.app.panes, isEmpty);
    // A successful join clears its journal; it was never a new Swarm.
    expect(
      f.store.values.entries
          .where((entry) => entry.key.startsWith('super_tab.launch.'))
          .map((entry) => jsonDecode(entry.value)),
      isEmpty,
    );
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
  });
}
