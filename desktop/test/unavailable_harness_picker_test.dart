import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_sessions.dart';
import 'package:harness/state/swarm_search.dart';
import 'package:harness/terminal/terminal_text.dart';
import 'package:harness/terminal/terminal_theme_store.dart';
import 'package:harness/widgets/search_result_text.dart';
import 'package:harness/widgets/swarm_resource_preview.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;

import 'keymap_host_test.dart' show key;
import 'resource_picker_test.dart' show fixture, field, search, capture;
import 'support/open_harness.dart';
import 'support/real_fonts.dart';
import 'swarm_screen_test.dart' show mount;
import 'swarm_state_test.dart' show createApp;

void main() {
  setUpAll(loadRealFonts);

  test('availability follows the machine and resumable terminal state', () {
    const machineInfo = Machine(
      machineId: 'm',
      name: 'Test host',
      authMode: MachineAuthMode.remote,
    );
    final machine = MachineState(machineInfo)
      ..connectionStatus = ConnectionStatus.connected;
    const ready = Agent(id: 'a', name: 'Ready', terminalAvailable: true);
    const paused = Agent(
      id: 'a',
      name: 'Paused',
      status: 'stopped',
      resumeMode: 'conversation',
    );
    expect(harnessSessionUnavailable(machine, ready), isNull);
    expect(harnessSessionUnavailable(machine, paused), isNull);
    expect(harnessSessionUnavailable(null, ready), 'Unavailable');
    expect(harnessSessionUnavailable(machine, null), 'Unavailable');
    for (final status in ConnectionStatus.values) {
      machine.connectionStatus = status;
      expect(
        harnessSessionUnavailable(machine, ready),
        status == ConnectionStatus.connected ? isNull : 'Not connected',
      );
    }
    machine.connectionStatus = ConnectionStatus.connected;
    machine.needsLink = true;
    expect(harnessSessionUnavailable(machine, ready), 'Link required');
    machine.nodeOnline = false;
    expect(harnessSessionUnavailable(machine, ready), 'Offline');
    machine
      ..needsLink = false
      ..nodeOnline = true
      ..machine = const Machine(
        machineId: 'm',
        status: 'offline',
        authMode: MachineAuthMode.remote,
      );
    expect(harnessSessionUnavailable(machine, ready), 'Offline');
    // The local computer does not inherit stale cloud presence.
    machine.localOnly = true;
    expect(harnessSessionUnavailable(machine, ready), isNull);
    machine
      ..localOnly = false
      ..machine = machineInfo;
    for (final (launchState, label) in [
      ('ready', 'Unavailable'),
      ('starting', 'Starting'),
      ('failed', 'Start failed'),
    ]) {
      expect(
        harnessSessionUnavailable(
          machine,
          Agent(id: 'a', name: 'Not ready', launchState: launchState),
        ),
        label,
      );
    }
    expect(
      harnessSessionUnavailable(
        machine,
        const Agent(id: 'a', name: 'Cannot resume', status: 'stopped'),
      ),
      'Unavailable',
    );
    // Shared live terminals can be viewed without a private machine socket,
    // but cannot be resumed by the viewer.
    machine
      ..machine = const Machine(
        machineId: 'm',
        isShared: true,
        authMode: MachineAuthMode.remote,
      )
      ..connectionStatus = ConnectionStatus.disconnected;
    expect(harnessSessionUnavailable(machine, ready), isNull);
    expect(harnessSessionUnavailable(machine, paused), 'Unavailable');
  });

  test('Cmd-P rechecks stale choices and refreshes on connection changes', () {
    final app = createApp();
    addTearDown(app.dispose);
    final machine = app.stateOf('m')!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    final controller = SwarmSearchController(
      app,
      const [],
      adding: true,
      activityFirst: true,
    )..setQuery('Agent 1');
    addTearDown(controller.dispose);
    final row = controller.selected!;
    final order = controller.rows.map((row) => row.id).toList();
    expect(controller.submit(row), isNotNull);
    var changes = 0;
    controller.addListener(() => changes++);
    // No notification yet: acceptance still reads the current connection.
    machine.connectionStatus = ConnectionStatus.reconnecting;
    expect(controller.canSubmit(row), isFalse);
    expect(controller.canAdd(row), isFalse);
    expect(controller.submit(row), isNull);
    expect(controller.addHere(), isNull);
    app.notifyListeners();
    expect(changes, 1);
    expect(controller.selected!.id, row.id);
    expect(controller.rows.map((row) => row.id), order);
    expect(controller.sessionUnavailable(row), 'Not connected');
    machine.connectionStatus = ConnectionStatus.connected;
    app.notifyListeners();
    expect(changes, 2);
    expect(controller.submit(row), isNotNull);
    machine.agents = [];
    expect(controller.submit(row), isNull);
    app.machineStates.remove('m');
    expect(controller.sessionUnavailable(row), 'Unavailable');
    expect(controller.submit(row), isNull);
  });

  testWidgets('unavailable rows stay selectable for preview but cannot open', (
    tester,
  ) async {
    final app = await fixture();
    final machine = app.stateOf('m')!;
    final originalFont = terminalFontStore.value;
    final originalTheme = terminalThemeStore.value;
    addTearDown(() {
      terminalFontStore.value = originalFont;
      terminalThemeStore.value = originalTheme;
    });
    await mount(tester, app);
    await openHarnessPicker(tester);
    await tester.enterText(field, 'Checkout');
    await tester.pump();
    final controller = search(tester);
    final id = controller.selected!.id;
    final row = find.byKey(ValueKey(id));
    final preview = find.byType(SwarmResourcePreview);
    final originalPanes = app.allPanes.toList();
    final input = tester.widget<TextField>(field).controller;
    final semantics = tester.ensureSemantics();
    for (final (label, update) in <(String, VoidCallback)>[
      ('Offline', () => machine.nodeOnline = false),
      (
        'Not connected',
        () {
          machine.nodeOnline = true;
          machine.connectionStatus = ConnectionStatus.reconnecting;
        },
      ),
      ('Link required', () => machine.needsLink = true),
    ]) {
      update();
      app.notifyListeners();
      await tester.pump();
      expect(controller.selected!.id, id);
      expect(controller.canAccept, isFalse);
      expect(
        find.descendant(of: row, matching: find.text(label)),
        findsOneWidget,
      );
      expect(
        find.descendant(of: row, matching: find.text('33m')),
        findsNothing,
      );
      expect(
        find.descendant(of: preview, matching: find.textContaining(label)),
        findsWidgets,
      );
      expect(
        tester.getSemantics(row).getSemanticsData().label,
        contains(label),
      );
      final title = tester.widget<SearchResultText>(
        find.descendant(of: row, matching: find.byType(SearchResultText)),
      );
      expect(title.style.color!.a, closeTo(.28, .01));
      expect(find.textContaining('No room'), findsNothing);
      await key(tester, LogicalKeyboardKey.enter);
      await key(tester, LogicalKeyboardKey.enter, cmd: true);
      await tester.tap(row, warnIfMissed: false);
      await tester.pump();
      expect(field, findsOneWidget);
      expect(app.allPanes.toList(), originalPanes);
      expect(app.resumes, 0);
      expect(tester.widget<TextField>(field).controller, same(input));
      expect(tester.widget<TextField>(field).focusNode!.hasFocus, isTrue);
      expect(tester.takeException(), isNull);
    }
    machine
      ..needsLink = false
      ..nodeOnline = false;
    app.notifyListeners();
    await tester.pump();
    await capture(tester, 'unavailable-sessions');
    tester.view.physicalSize = const Size(480, 600);
    terminalFontStore.value = const TerminalStyle(
      fontSize: 18,
      fontFamily: 'Menlo',
      height: 1.4,
    );
    terminalThemeStore.value = TerminalThemeChoice.tango;
    await tester.pump();
    expect(tester.takeException(), isNull);
    expect(
      tester.getSize(row).height,
      closeTo(terminalCellSizeOf(tester.element(field)).height, .01),
    );
    await capture(tester, 'unavailable-sessions-narrow');
    machine
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    app.notifyListeners();
    await tester.pump();
    expect(controller.selected!.id, id);
    expect(controller.canAccept, isTrue);
    expect(
      find.descendant(of: row, matching: find.text('Offline')),
      findsNothing,
    );
    await key(tester, LogicalKeyboardKey.enter);
    expect(field, findsNothing);
    expect(app.focusedPane!.agentId, 'a0');
    semantics.dispose();
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });
}
