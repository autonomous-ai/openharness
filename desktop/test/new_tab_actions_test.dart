// The web New tab page: plain buttons under the New Harness box, in place of
// the key chords a mouse-first web does not advertise (audit findings S7, B2).

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/web/shell/web_chrome.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/widgets/workspace_welcome.dart';

const _buttons = {
  'Open Harness': 'harnesses.list',
  'Machines': 'machines.list',
  'New Swarm': 'super_tab.new',
  'Store': 'app.store',
};

/// What the web chrome sets, and nothing else.
final _web = WorkspaceChrome(
  leadingWidth: (_) => 0,
  leading: (_, _) => const SizedBox.shrink(),
  showsKeyHints: false,
);

class _Account extends AppNotifier {
  _Account()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  @override
  bool get machineInventoryLoaded => true;
}

/// The New tab page with the box under [chrome] (none is Desktop), each
/// button's command recorded in [ran].
Future<void> _welcome(
  WidgetTester tester, {
  WorkspaceChrome? chrome,
  required List<String> ran,
  bool swarmDraft = false,
}) => tester.pumpWidget(
  MaterialApp(
    theme: grid.buildAppTheme(brightness: Brightness.dark),
    home: WorkspaceChromeScope(
      chrome: chrome,
      child: WorkspaceWelcome(
        onCommand: ran.add,
        swarmDraft: swarmDraft,
        composerBuilder: (recent) =>
            Column(children: [const Text('the box'), ?recent]),
      ),
    ),
  ),
);

/// The browser workspace in box mode, as people get it, for an account with
/// one connected computer; [newTabPage] is a tab opened with +, otherwise an
/// empty tab.
Future<AppNotifier> _workspace(
  WidgetTester tester, {
  required Size size,
  required bool newTabPage,
}) async {
  final app = _Account()..newSwarm(newTabPage: newTabPage);
  addTearDown(app.dispose);
  const machine = Machine(
    machineId: 'm',
    name: 'box',
    authMode: MachineAuthMode.remote,
  );
  app.machines.add(machine);
  app.machineStates['m'] = MachineState(machine)
    ..nodeOnline = true
    ..connectionStatus = ConnectionStatus.connected
    ..agents = [const Agent(id: 'a0', name: 'Agent 0')];
  tester.view
    ..devicePixelRatio = 1
    ..physicalSize = size;
  addTearDown(tester.view.reset);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      home: SwarmScreen(
        notifier: app,
        nativeTabs: false,
        chrome: webWorkspaceChrome(app),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 200));
  return app;
}

void main() {
  testWidgets('with key hints off, each button runs its command', (
    tester,
  ) async {
    final ran = <String>[];
    await _welcome(tester, chrome: _web, ran: ran);
    expect(find.text('the box'), findsOneWidget);
    for (final MapEntry(key: label, value: command) in _buttons.entries) {
      ran.clear();
      await tester.tap(find.text(label));
      await tester.pump();
      // New Swarm is super_tab.new, the command Alt+S is bound to
      // (keymap_host_test), so the button and the key do one thing.
      expect(ran, [command], reason: label);
    }
  });

  testWidgets('a Swarm draft leaves out New Swarm, the thing it starts', (
    tester,
  ) async {
    final ran = <String>[];
    await _welcome(tester, chrome: _web, ran: ran, swarmDraft: true);
    expect(find.text('New Swarm'), findsNothing);
    for (final label in ['Open Harness', 'Machines', 'Store']) {
      expect(find.text(label), findsOneWidget, reason: label);
    }
  });

  testWidgets('Desktop keeps the box alone', (tester) async {
    await _welcome(tester, ran: []);
    expect(find.text('the box'), findsOneWidget);
    for (final label in _buttons.keys) {
      expect(find.text(label), findsNothing, reason: label);
    }
  });

  group('in the browser workspace', () {
    setUp(() => newHarnessOpensInBox = true);
    tearDown(() => newHarnessOpensInBox = false);

    for (final size in [const Size(390, 844), const Size(1440, 900)]) {
      testWidgets('an empty tab and a new tab show the same buttons at '
          '${size.width}', (tester) async {
        for (final newTabPage in [false, true]) {
          await _workspace(tester, size: size, newTabPage: newTabPage);
          expect(find.byType(NewHarnessForm), findsOneWidget);
          for (final label in _buttons.keys) {
            expect(
              find.descendant(
                of: find.byType(WorkspaceWelcome),
                matching: find.text(label),
              ),
              findsOneWidget,
              reason: '$label, newTabPage: $newTabPage',
            );
          }
          await tester.pumpWidget(const SizedBox.shrink());
        }
      });

      testWidgets('New Swarm opens a new Swarm at ${size.width}', (
        tester,
      ) async {
        final app = await _workspace(tester, size: size, newTabPage: true);
        final tabs = app.swarms.length;
        await tester.tap(
          find.descendant(
            of: find.byType(WorkspaceWelcome),
            matching: find.text('New Swarm'),
          ),
        );
        await tester.pump(const Duration(milliseconds: 200));
        expect(app.swarms, hasLength(tabs + 1));
        expect(app.activeSwarm.isSuperTab, isTrue);
        // The draft's own page offers the other three, not New Swarm again.
        Finder onPage(String label) => find.descendant(
          of: find.byType(WorkspaceWelcome),
          matching: find.text(label),
        );
        expect(onPage('New Swarm'), findsNothing);
        for (final label in ['Open Harness', 'Machines', 'Store']) {
          expect(onPage(label), findsOneWidget, reason: label);
        }
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox.shrink());
      });
    }
  });
}
