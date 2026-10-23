import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/swarm_switcher.dart';
import 'package:harness/widgets/workspace_welcome.dart';

class _App extends AppNotifier {
  _App()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  bool loaded = false;
  @override
  bool get machineInventoryLoaded => loaded;

  /// The quiet machine-list reads asked for while waiting on a computer.
  var rereads = 0;
  @override
  Future<void> rereadMachines() async => rereads++;
}

const _connectPage = Key('connect-page');

/// A host with a connect page (the browser's) shows it over the workspace
/// while no computer is connected, and never opens the machine picker unasked.
void main() {
  Future<_App> mount(
    WidgetTester tester, {
    MachineState Function(_App app)? machine,
    bool pane = false,
    bool answers = true,
    bool connectPage = true,
  }) async {
    final app = _App();
    app.currentUser = const CurrentUserProfile(email: 'new@example.test');
    machine?.call(app);
    app.newSwarm(newTabPage: true);
    if (pane) {
      app.adoptSessionForTest(
        TerminalSession(
          machineId: 'mac',
          agentId: 'a1',
          agentName: 'Fix checkout flow',
          engineId: 'claude',
          send: (_, _) async => true,
          sendBinary: (_) async => true,
        ),
      );
    }
    tester.view.physicalSize = const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: SwarmScreen(
          notifier: app,
          chrome: connectPage
              ? WorkspaceChrome(
                  leadingWidth: (_) => 0,
                  leading: (_, _) => const SizedBox(),
                  firstMachine: (_) => const SizedBox(key: _connectPage),
                )
              : null,
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 200));
    if (!answers) return app;
    app.loaded = true;
    app.notifyListeners();
    await tester.pump(const Duration(milliseconds: 200));
    await tester.pump();
    return app;
  }

  MachineState Function(_App) computer({
    String id = 'mac',
    String name = 'Mac',
    bool needsLink = false,
    bool? online = true,
    ConnectionStatus status = ConnectionStatus.disconnected,
  }) => (app) {
    final machine = Machine(
      machineId: id,
      name: name,
      authMode: MachineAuthMode.remote,
    );
    app.machines.add(machine);
    return app.machineStates[id] = MachineState(machine)
      ..needsLink = needsLink
      ..nodeOnline = online
      ..connectionStatus = status;
  };

  /// The only computer, set up once and now asleep.
  final asleep = computer(online: false);

  /// The canvas's own New tab page, where a person can see it.
  Finder newTabPage() => find.byType(WorkspaceWelcome);

  /// Every label in the window's accessibility tree.
  List<String> spoken(WidgetTester tester) {
    final labels = <String>[];
    bool visit(SemanticsNode node) {
      if (node.label.isNotEmpty) labels.add(node.label);
      node.visitChildren(visit);
      return true;
    }

    visit(tester.getSemantics(find.byType(SwarmScreen)));
    return labels;
  }

  /// The New tab page's controls that Tab could still reach.
  List<FocusNode> reachableUnderPage() {
    final welcome = find
        .byType(WorkspaceWelcome, skipOffstage: false)
        .evaluate()
        .single;
    bool under(BuildContext context) {
      var found = false;
      context.visitAncestorElements((ancestor) {
        found = ancestor == welcome;
        return !found;
      });
      return found;
    }

    return [
      for (final node in FocusManager.instance.rootScope.descendants)
        if (node.context case final context?
            when under(context) && node.canRequestFocus)
          node,
    ];
  }

  Future<void> unmount(WidgetTester tester, _App app) async {
    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox.shrink());
    app.dispose();
  }

  testWidgets('no computer at all: the connect page, no picker', (
    tester,
  ) async {
    final app = await mount(tester);

    expect(find.byKey(_connectPage), findsOneWidget);
    expect(find.byType(SwarmSearchResults), findsNothing);
    await unmount(tester, app);
  });

  testWidgets('one waiting to be linked: the connect page, no picker', (
    tester,
  ) async {
    final app = await mount(tester, machine: computer(needsLink: true));

    expect(find.byKey(_connectPage), findsOneWidget);
    expect(find.byType(SwarmSearchResults), findsNothing);
    await unmount(tester, app);
  });

  testWidgets('one coming online: no page flashes over it', (tester) async {
    final app = await mount(
      tester,
      machine: computer(status: ConnectionStatus.connecting),
    );

    expect(find.byKey(_connectPage), findsNothing);
    await unmount(tester, app);
  });

  testWidgets('one connected: the workspace itself', (tester) async {
    final app = await mount(
      tester,
      machine: computer(status: ConnectionStatus.connected),
    );

    expect(find.byKey(_connectPage), findsNothing);
    await unmount(tester, app);
  });

  testWidgets(
    'the only computer offline: its pane stays, under a band naming it',
    (tester) async {
      final app = await mount(tester, machine: asleep, pane: true);

      expect(find.byKey(_connectPage), findsNothing);
      expect(find.text('Mac is offline'), findsOneWidget);
      expect(
        find.byTooltip('Mac is offline. Retained output is read only.'),
        findsOneWidget,
      );
      await unmount(tester, app);
    },
  );

  testWidgets('it comes back: the band goes', (tester) async {
    final app = await mount(tester, machine: asleep, pane: true);
    expect(find.text('Mac is offline'), findsOneWidget);

    app.machineStates['mac']!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    app.notifyListeners();
    await tester.pump();

    expect(find.text('Mac is offline'), findsNothing);
    expect(find.byKey(_connectPage), findsNothing);
    await unmount(tester, app);
  });

  // One timer asks for the machine list, every four seconds, while the
  // connect page or the asleep band shows: a second one would double the
  // reads, and one left running would read forever.
  const every = Duration(seconds: 4);

  testWidgets('the connect page: one read every four seconds', (tester) async {
    final app = await mount(tester);
    final before = app.rereads;

    await tester.pump(every * 3);

    expect(app.rereads - before, 3);
    await unmount(tester, app);
  });

  testWidgets('the band: one read every four seconds, none once it is back', (
    tester,
  ) async {
    final app = await mount(tester, machine: asleep, pane: true);
    final before = app.rereads;

    await tester.pump(every * 3);
    expect(app.rereads - before, 3);

    app.machineStates['mac']!
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    app.notifyListeners();
    await tester.pump();
    final woken = app.rereads;
    await tester.pump(every * 3);
    expect(app.rereads, woken);
    await unmount(tester, app);
  });

  testWidgets('no read once the workspace is gone', (tester) async {
    final app = await mount(tester, machine: asleep, pane: true);
    await tester.pumpWidget(const SizedBox.shrink());
    final gone = app.rereads;

    await tester.pump(every * 3);

    expect(app.rereads, gone);
    app.dispose();
  });

  testWidgets('two asleep: the band names both', (tester) async {
    final app = await mount(
      tester,
      machine: (app) {
        asleep(app);
        return computer(id: 'box', name: 'Build box', online: false)(app);
      },
    );

    expect(find.text('Mac and Build box are offline'), findsOneWidget);
    await unmount(tester, app);
  });

  testWidgets('one asleep, another connected: no band, as before', (
    tester,
  ) async {
    final app = await mount(
      tester,
      machine: (app) {
        asleep(app);
        return computer(
          id: 'box',
          name: 'Build box',
          status: ConnectionStatus.connected,
        )(app);
      },
    );

    expect(find.textContaining('is offline'), findsNothing);
    expect(find.byKey(_connectPage), findsNothing);
    await unmount(tester, app);
  });

  testWidgets('one asleep, one waiting on this browser: the connect page', (
    tester,
  ) async {
    final app = await mount(
      tester,
      machine: (app) {
        asleep(app);
        return computer(id: 'box', name: 'Build box', needsLink: true)(app);
      },
    );

    expect(find.byKey(_connectPage), findsOneWidget);
    expect(find.textContaining('is offline'), findsNothing);
    await unmount(tester, app);
  });

  testWidgets('only a computer taken out of the account: the connect page', (
    tester,
  ) async {
    final app = await mount(
      tester,
      machine: (app) {
        app.removedMachines = {'mac': 1};
        return asleep(app);
      },
    );

    expect(find.byKey(_connectPage), findsOneWidget);
    expect(find.textContaining('is offline'), findsNothing);
    await unmount(tester, app);
  });

  testWidgets(
    'before the machine list answers: the page, not the New tab page',
    (tester) async {
      final app = await mount(tester, answers: false);

      expect(find.byKey(_connectPage), findsOneWidget);
      expect(newTabPage(), findsNothing);
      await unmount(tester, app);
    },
  );

  testWidgets('connected before the list answers: the workspace, no page', (
    tester,
  ) async {
    final app = await mount(
      tester,
      machine: computer(status: ConnectionStatus.connected),
      answers: false,
    );

    expect(find.byKey(_connectPage), findsNothing);
    await unmount(tester, app);
  });

  testWidgets('the covered workspace is out of the tree and out of focus', (
    tester,
  ) async {
    final handle = tester.ensureSemantics();
    final app = await mount(tester);
    expect(find.byKey(_connectPage), findsOneWidget);

    expect(newTabPage(), findsNothing);
    expect(spoken(tester), isNot(anyElement(contains('Start a harness'))));
    expect(reachableUnderPage(), isEmpty);
    handle.dispose();
    await unmount(tester, app);
  });

  testWidgets('the footer counts one linked machine in the singular', (
    tester,
  ) async {
    final app = await mount(
      tester,
      machine: computer(status: ConnectionStatus.connected),
    );

    expect(
      find.byWidgetPredicate(
        (widget) =>
            widget is Tooltip &&
            (widget.message ?? '').startsWith('1 linked machine · '),
      ),
      findsOneWidget,
    );
    await unmount(tester, app);
  });

  group('Desktop, with no connect page', () {
    testWidgets('the only computer offline: its pane, and no band', (
      tester,
    ) async {
      final app = await mount(
        tester,
        machine: asleep,
        pane: true,
        connectPage: false,
      );

      expect(find.text('Mac is offline'), findsNothing);
      expect(
        find.byTooltip('Mac is offline. Retained output is read only.'),
        findsOneWidget,
      );
      await unmount(tester, app);
    });

    testWidgets('no machine-list reads', (tester) async {
      final app = await mount(tester, machine: asleep, connectPage: false);
      final before = app.rereads;

      await tester.pump(every * 3);

      expect(app.rereads, before);
      await unmount(tester, app);
    });

    testWidgets('before the machine list answers: the New tab page', (
      tester,
    ) async {
      final handle = tester.ensureSemantics();
      final app = await mount(tester, answers: false, connectPage: false);

      expect(newTabPage(), findsOneWidget);
      expect(spoken(tester), anyElement(contains('Start a harness')));
      expect(reachableUnderPage(), isNotEmpty);
      handle.dispose();
      await unmount(tester, app);
    });
  });
}
