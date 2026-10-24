// The pane header on a phone browser (WorkspaceChrome.compactPaneHeaderAt,
// audit findings S2 and S1): the harness name first, its state in words,
// agent and model behind one menu, and controls a finger can hit. A narrow
// Desktop window keeps today's header.

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/widgets/box_chrome.dart' show kWorkspaceInset;
import 'package:harness/widgets/pane_grid.dart';

import 'support/real_fonts.dart';
import 'swarm_state_test.dart' show createApp;

const _name = 'Fix checkout flow tests';
const _titleKey = ValueKey('terminal-pane-title');

AppNotifier _app({
  ConnectionStatus connection = ConnectionStatus.connected,
  bool online = true,
  bool viewOnly = false,
  TerminalSessionStatus status = TerminalSessionStatus.controlling,
}) {
  final app = createApp(connected: true);
  app.machineStates['m']!
    ..connectionStatus = connection
    ..nodeOnline = online;
  app.adoptSessionForTest(
    TerminalSession(
        machineId: 'm',
        agentId: 'a0',
        agentName: _name,
        engineId: 'claude',
        readOnly: viewOnly,
        send: (_, _) async => true,
        sendBinary: (_) async => true,
      )
      ..status = status
      ..streamId = 'stream-a0',
  );
  addTearDown(app.dispose);
  return app;
}

/// A second computer, still connected, so an offline one keeps its pane.
void _withSecondComputer(AppNotifier app) {
  const machine = Machine(
    machineId: 'm2',
    authMode: MachineAuthMode.remote,
    name: 'Build server',
  );
  app.machines = [...app.machines, machine];
  app.machineStates['m2'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected;
}

Future<void> _mount(
  WidgetTester tester,
  AppNotifier app, {
  WorkspaceChrome? chrome,
  Size size = const Size(390, 844),
  void Function(int paneId, String machineId, String agentId)? onOpenModels,
}) async {
  tester.view.devicePixelRatio = 1;
  tester.view.physicalSize = size;
  addTearDown(tester.view.reset);
  final grid = PaneGrid(
    notifier: app,
    swarmMode: true,
    onOpenModels: onOpenModels ?? (_, _, _) {},
  );
  // Inset as the workspace insets its grid, so the pane is as wide as a
  // phone's.
  final inset = Padding(
    padding: const EdgeInsets.symmetric(horizontal: kWorkspaceInset),
    child: grid,
  );
  await tester.pumpWidget(
    MaterialApp(
      home: chrome == null
          ? inset
          : WorkspaceChromeScope(chrome: chrome, child: inset),
    ),
  );
  await tester.pump();
}

/// How wide "Fix checkout flo…" is in the title's own style: sixteen
/// characters and the ellipsis a cut name ends in.
double _sixteenCharacters(WidgetTester tester) {
  final style = tester.widget<Text>(find.byKey(_titleKey)).style;
  final painter = TextPainter(
    text: TextSpan(text: '${_name.substring(0, 16)}…', style: style),
    textDirection: TextDirection.ltr,
  )..layout();
  final width = painter.width;
  painter.dispose();
  return width;
}

void main() {
  // Widths are the point here: measured in real fonts, not the test font's
  // one-em squares.
  setUpAll(loadRealFonts);

  testWidgets('at 390 the name keeps at least sixteen characters', (
    tester,
  ) async {
    final app = _app(connection: ConnectionStatus.reconnecting);

    await _mount(tester, app, chrome: webWorkspaceChrome(app));

    expect(
      tester.getSize(find.byKey(_titleKey)).width,
      greaterThanOrEqualTo(_sixteenCharacters(tester)),
    );
    await tester.pumpWidget(const SizedBox());
  });

  for (final (word, app) in <(String, AppNotifier Function())>[
    ('Connecting', () => _app(status: TerminalSessionStatus.opening)),
    ('Reconnecting…', () => _app(connection: ConnectionStatus.reconnecting)),
    ('Offline', () => _app(online: false)..let(_withSecondComputer)),
    ('View only', () => _app(viewOnly: true)),
  ]) {
    testWidgets('at 390 "$word", which nothing here fixes, is a label', (
      tester,
    ) async {
      final semantics = tester.ensureSemantics();
      final notifier = app();

      await _mount(tester, notifier, chrome: webWorkspaceChrome(notifier));

      final status = find.byKey(const ValueKey('pane-header-status'));
      expect(
        find.descendant(of: status, matching: find.byType(ButtonStyleButton)),
        findsNothing,
      );
      expect(
        tester
            .getSemantics(
              find.descendant(of: status, matching: find.text(word)),
            )
            .flagsCollection
            .isButton,
        isFalse,
      );
      await tester.pumpWidget(const SizedBox());
      semantics.dispose();
    });
  }

  for (final (word, app) in <(String, AppNotifier Function())>[
    ('Connecting', () => _app(status: TerminalSessionStatus.opening)),
    ('Reconnecting…', () => _app(connection: ConnectionStatus.reconnecting)),
    ('Offline', () => _app(online: false)..let(_withSecondComputer)),
    ('View only', () => _app(viewOnly: true)),
    ('Take control', () => _app(status: TerminalSessionStatus.takenOver)),
  ]) {
    testWidgets('at 390 the header says "$word" in words', (tester) async {
      final notifier = app();

      await _mount(tester, notifier, chrome: webWorkspaceChrome(notifier));

      expect(
        find.descendant(
          of: find.byKey(const ValueKey('pane-header-status')),
          matching: find.text(word),
        ),
        findsOneWidget,
      );
      expect(
        tester.getSize(find.byKey(_titleKey)).width,
        greaterThanOrEqualTo(_sixteenCharacters(tester)),
      );
      await tester.pumpWidget(const SizedBox());
    });
  }

  testWidgets('agent and model share one menu that runs both pickers', (
    tester,
  ) async {
    final semantics = tester.ensureSemantics();
    final app = _app();
    final agentPicks = <(String, String)>[];
    app.openAgentPicker = (machine, agent) => agentPicks.add((machine, agent));
    final modelPicks = <int>[];
    await _mount(
      tester,
      app,
      chrome: webWorkspaceChrome(app),
      onOpenModels: (pane, _, _) => modelPicks.add(pane),
    );
    expect(find.bySemanticsLabel(RegExp('^Agent: ')), findsNothing);
    expect(find.bySemanticsLabel(RegExp('^Model: ')), findsNothing);

    await tester.tap(find.bySemanticsLabel('Agent and model'));
    await tester.pump();
    await tester.tap(find.text('Agent'));
    await tester.pump();
    expect(agentPicks, [('m', 'a0')]);

    await tester.tap(find.bySemanticsLabel('Agent and model'));
    await tester.pump();
    await tester.tap(find.text('Model'));
    await tester.pump();
    expect(modelPicks, [app.panes.single.id]);

    await tester.pumpWidget(const SizedBox());
    semantics.dispose();
  });

  testWidgets('header controls are a finger wide on a phone', (tester) async {
    final semantics = tester.ensureSemantics();
    final app = _app();

    await _mount(tester, app, chrome: webWorkspaceChrome(app));

    for (final label in ['Close Pane', 'Agent and model']) {
      final size = tester.getSize(find.bySemanticsLabel(label));
      expect(size.width, greaterThanOrEqualTo(44), reason: label);
      expect(size.height, greaterThanOrEqualTo(44), reason: label);
    }
    await tester.pumpWidget(const SizedBox());
    semantics.dispose();
  });

  testWidgets('a status that can be pressed is a finger tall', (tester) async {
    final app = _app(status: TerminalSessionStatus.takenOver);

    await _mount(tester, app, chrome: webWorkspaceChrome(app));

    final chip = find.descendant(
      of: find.byKey(const ValueKey('pane-header-status')),
      matching: find.byType(TextButton),
    );
    expect(tester.getSize(chip).height, greaterThanOrEqualTo(44));
    await tester.pumpWidget(const SizedBox());
  });

  testWidgets('a 390 px Desktop window keeps today\'s header', (tester) async {
    final semantics = tester.ensureSemantics();
    final app = _app();

    await _mount(tester, app);

    expect(find.bySemanticsLabel(RegExp('^Agent: ')), findsOneWidget);
    expect(find.bySemanticsLabel(RegExp('^Model: ')), findsOneWidget);
    expect(find.bySemanticsLabel('Agent and model'), findsNothing);
    expect(tester.getSize(find.bySemanticsLabel('Close Pane')).width, 28);
    await tester.pumpWidget(const SizedBox());
    semantics.dispose();
  });
}

extension<T> on T {
  T let(void Function(T) f) {
    f(this);
    return this;
  }
}
