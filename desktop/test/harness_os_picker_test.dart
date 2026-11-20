// Machines (`@`) is where an Intern 3 is set up and managed: Add machine offers Intern 3 beside App
// and CLI, a machine running Harness OS shows its release and Wi-Fi and offers Manage, and one that
// waits at its disk's password after a restart offers Unlock. Every `os_device` answer is canned.
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/account_devices.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/widgets/desktop_chrome.dart';

import 'support/devices_app.dart';
import 'support/resource_picker.dart';
import 'support/workspace_tools.dart';

const _boxId = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';
const _macId = 'cccccccccccccccccccccccccccccccc';

class _App extends FakeDevicesApp {
  final asked = <(String, Map<String, dynamic>)>[];

  @override
  Future<Map<String, dynamic>> osDevice(
    String machineId,
    Map<String, dynamic> payload, {
    Duration timeout = const Duration(seconds: 25),
  }) async {
    asked.add((machineId, payload));
    if (machineId != _boxId) return {'error': 'UNSUPPORTED_OS'};
    return {
      'harnessOs': true,
      'hotspot': 'Harness-AB12',
      'encrypted': true,
      'wifi': {'ssid': 'Home'},
      'features': ['password', 'ssh'],
      'update': {
        'available': true,
        'parts': {
          'os': {
            'running': '0.1.8.r1.gabc-1',
            'next': '0.1.9.r2.gdef-1',
            'available': true,
          },
        },
      },
    };
  }

  void add(String id, String name) {
    machineStates[id] =
        MachineState(
            Machine(
              machineId: id,
              name: name,
              authMode: MachineAuthMode.remote,
            ),
          )
          ..nodeOnline = true
          ..needsLink = false
          ..agentLoadStatus = AgentLoadStatus.loaded
          ..connectionStatus = ConnectionStatus.connected;
    machines = machineStates.values.map((s) => s.machine).toList();
    notifyListeners();
  }
}

void main() {
  late _App app;

  setUp(() {
    app = _App()
      ..add(_boxId, 'Den box')
      ..add(_macId, 'Build Mac');
    app.devices = AccountDevices(devices: const [], historyAvailable: true);
  });
  tearDown(() => app.dispose());

  Future<void> mount(WidgetTester tester) async {
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = const Size(1280, 900);
    addTearDown(tester.view.reset);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: SwarmScreen(notifier: app, nativeTabs: false),
      ),
    );
    await tester.pumpAndSettle();
    await openWorkspaceManagement(tester, 'machines');
    await tester.pumpAndSettle();
  }

  Finder pill(String label) => find.widgetWithText(DesktopPill, label);

  testWidgets('Add machine offers Intern 3, which opens its setup', (
    tester,
  ) async {
    await mount(tester);
    final search = resourceSearch(tester);
    final create = search.rows.indexWhere((row) => row.isCreate);
    search.move(create - search.cursor);
    await tester.pumpAndSettle();
    expect(pill('App'), findsOneWidget);
    expect(pill('CLI'), findsOneWidget);
    await tester.tap(pill('Intern 3'));
    await tester.pumpAndSettle();
    expect(find.text('Set up Intern 3'), findsOneWidget);
    await tester.tap(find.byKey(const Key('intern-setup-close')));
    await tester.pumpAndSettle();
    expect(find.text('Set up Intern 3'), findsNothing);
  });

  testWidgets(
    'an Intern 3 online: its release, Wi-Fi and update, and Manage; another computer offers none',
    (tester) async {
      await mount(tester);
      await selectResource(tester, 'machine:$_boxId');
      await tester.pumpAndSettle();
      expect(app.asked.where((a) => a.$1 == _boxId).map((a) => a.$2), [
        {'action': 'status'},
      ]);
      expect(find.text('Harness OS 0.1.8'), findsOneWidget);
      expect(find.text('Home'), findsOneWidget);
      expect(find.text('New version'), findsOneWidget);
      await tester.tap(pill('Manage'));
      await tester.pumpAndSettle();
      expect(find.text('Den box'), findsWidgets);
      expect(find.text('Password'), findsWidgets);
      expect(find.text('SSH'), findsOneWidget);
      // Its status says nothing of GitHub: no row for it.
      expect(find.text('GitHub'), findsNothing);
      await tester.tap(find.text('Close').last);
      await tester.pumpAndSettle();

      await selectResource(tester, 'machine:$_macId');
      await tester.pumpAndSettle();
      expect(app.asked.map((a) => a.$1), contains(_macId));
      expect(pill('Manage'), findsNothing);
      expect(find.text('Harness OS 0.1.8'), findsNothing);
    },
  );

  testWidgets(
    'an Intern 3 offline after a restart: it waits for its password, and Unlock opens over its hotspot',
    (tester) async {
      await mount(tester);
      await selectResource(tester, 'machine:$_boxId');
      await tester.pumpAndSettle();
      app.machineStates[_boxId]!.nodeOnline = false;
      app.notifyListeners();
      await tester.pumpAndSettle();
      expect(pill('Manage'), findsNothing);
      expect(
        find.text(
          'If it restarted, it waits for its password. Unlock it over its Wi-Fi “Harness-AB12”.',
        ),
        findsOneWidget,
      );
      await tester.tap(pill('Unlock'));
      await tester.pump();
      expect(find.textContaining('Harness-AB12'), findsWidgets);
      await tester.tap(find.text('Close').last);
      await tester.pumpAndSettle();
    },
  );
}
