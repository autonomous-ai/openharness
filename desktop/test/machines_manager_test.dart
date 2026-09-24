import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/api/api_client.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/models/models_panel.dart';
import 'package:harness/models/local_model.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_box.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:xterm/xterm.dart';

import 'keymap_runtime_test.dart' show native;
import 'keymap_host_test.dart' show key;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;
import 'support/model_manager.dart';

class _MachineApi extends ApiClient {
  _MachineApi() : super(config: AppConfig.dev, session: AuthSession());
  final calls = <(String, String)>[];
  String? error;

  @override
  Future<String?> renameMachine({
    required String machineId,
    required String name,
  }) async {
    calls.add((machineId, name));
    if (error != null) throw ApiException(error!);
    return null;
  }
}

void main() {
  testWidgets('machine and model badges acknowledge independently', (
    tester,
  ) async {
    final app = ModelManagerTestApp(ModelManagerConnection());
    app.stateOf('m')!.nodeOnline = true;
    app.stateOf('other')!
      ..nodeOnline = true
      ..needsLink = true;
    app.machineStates['offline'] =
        MachineState(
            const Machine(
              machineId: 'offline',
              name: 'Offline',
              authMode: MachineAuthMode.remote,
            ),
          )
          ..nodeOnline = false
          ..needsLink = true;
    app.machineStates['shared'] =
        MachineState(
            const Machine(
              machineId: 'shared',
              name: 'Shared',
              authMode: MachineAuthMode.remote,
              isShared: true,
            ),
          )
          ..nodeOnline = true
          ..needsLink = true;
    final ready = <String, dynamic>{
      'id': 'ready',
      'name': 'Ready model',
      'state': 'running',
      'operation': <String, dynamic>{
        'id': 'download-1',
        'modelId': 'ready',
        'action': 'start',
        'stage': 'verifying',
        'phase': 'done',
      },
    };
    app.localInventory = {
      'models': [ready],
    };
    app.modelManager
      ..localModels = [LocalModel.fromJson(ready)]
      ..loaded = true;
    await mount(tester, app);
    await tester.pumpAndSettle();
    Badge badge(String name) =>
        tester.widget<Badge>(find.byKey(ValueKey('swarm-$name-badge')));
    expect(badge('machines').isLabelVisible, isTrue);
    expect((badge('machines').label as Text).data, '1');
    expect(badge('models').isLabelVisible, isTrue);
    await tester.tap(find.byKey(const ValueKey('swarm-machines-button')));
    await tester.pumpAndSettle();
    expect(badge('machines').isLabelVisible, isFalse);
    expect(badge('models').isLabelVisible, isTrue);
    await tester.tap(find.byKey(const ValueKey('swarm-models-button')));
    await tester.pumpAndSettle();
    expect(badge('models').isLabelVisible, isFalse);
    expect(find.text('Models'), findsOneWidget);
    await key(tester, LogicalKeyboardKey.escape);
    await tester.pumpAndSettle();
    app.localInventory = {
      'models': [
        ready,
        {'id': 'release', 'name': 'New release'},
      ],
    };
    await app.modelManager.refresh();
    await tester.pumpAndSettle();
    expect(badge('models').isLabelVisible, isFalse);
    await tester.tap(find.byKey(const ValueKey('swarm-models-button')));
    await tester.pumpAndSettle();
    expect(find.text('New'), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  for (final nativeTabs in [false, true]) {
    testWidgets(
      'toolbar panels switch in one click without stacking (native=$nativeTabs)',
      (tester) async {
        final app = createApp();
        app.stateOf('m')!.nodeOnline = true;
        final input = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(terminal('a0', input));
        await mount(tester, app, nativeTabs: nativeTabs);
        final buttons = {
          'machineList': find.byKey(const ValueKey('swarm-machines-button')),
          'models': find.byKey(const ValueKey('swarm-models-button')),
          'sessions': find.byTooltip('Harnesses'),
        };
        final panels = {
          'machineList': find.byKey(const ValueKey('machines-panel')),
          'models': find.byType(ModelsPanel),
          'sessions': find.byKey(const ValueKey('session-manager')),
        };
        Future<void> open(String command) async {
          if (nativeTabs) {
            final action = native(tester, command);
            await tester.pumpAndSettle();
            await action;
          } else {
            await tester.tap(buttons[command]!);
            await tester.pumpAndSettle();
          }
        }

        for (final from in panels.keys) {
          for (final to in panels.keys) {
            await open(from);
            await open(to);
            for (final entry in panels.entries) {
              expect(
                entry.value,
                from != to && entry.key == to ? findsOneWidget : findsNothing,
                reason: '$from → $to should leave only the chosen panel open',
              );
            }
            if (from != to) {
              await key(tester, LogicalKeyboardKey.escape);
              await tester.pumpAndSettle();
            }
            expect(tester.takeException(), isNull);
            expect(
              input.map((frame) => frame.bytes.toList()).toList(),
              isEmpty,
              reason: '$from → $to must not send panel keys to the terminal',
            );
          }
        }
        tester.testTextInput.enterText('x');
        await tester.idle();
        expect(String.fromCharCodes(input.single.bytes), 'x');
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  testWidgets('native Machines, Models, and Harnesses share one panel', (
    tester,
  ) async {
    const channel = MethodChannel('harness/swarm_tabs');
    final updates = <Map>[];
    tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(channel, (
      call,
    ) async {
      if (call.method == 'update') updates.add(call.arguments as Map);
      return null;
    });
    addTearDown(
      () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
        channel,
        null,
      ),
    );
    final app = createApp();
    app.stateOf('m')!.nodeOnline = true;
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app, nativeTabs: true);
    var action = native(tester, 'machineList');
    await tester.pumpAndSettle();
    await action;
    expect(find.byKey(const ValueKey('machines-panel')), findsOneWidget);
    expect(updates.last['enabled'], isTrue);
    expect(updates.last['machinesOpen'], isTrue);
    action = native(tester, 'machineList');
    await tester.pumpAndSettle();
    await action;
    expect(find.byKey(const ValueKey('machines-panel')), findsNothing);
    action = native(tester, 'machineList');
    await tester.pumpAndSettle();
    await action;
    action = native(tester, 'models');
    await tester.pumpAndSettle();
    await action;
    expect(find.byKey(const ValueKey('machines-panel')), findsNothing);
    expect(find.byType(ModelsPanel), findsOneWidget);
    expect(updates.last['machinesOpen'], isFalse);
    expect(updates.last['modelsOpen'], isTrue);
    action = native(tester, 'machineList');
    await tester.pumpAndSettle();
    await action;
    expect(find.byType(ModelsPanel), findsNothing);
    expect(find.byKey(const ValueKey('machines-panel')), findsOneWidget);
    expect(updates.last['modelsOpen'], isFalse);
    action = native(tester, 'sessions');
    await tester.pumpAndSettle();
    await action;
    expect(find.byKey(const ValueKey('machines-panel')), findsNothing);
    expect(find.byKey(const ValueKey('session-manager')), findsOneWidget);
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  testWidgets(
    'Cmd M and the toolbar open Machines and restore terminal input',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!.nodeOnline = true;
      final input = <TerminalBinaryFrame>[];
      app.adoptSessionForTest(terminal('a0', input));
      await mount(tester, app);
      await key(tester, LogicalKeyboardKey.keyM, cmd: true);
      await tester.pumpAndSettle();
      expect(find.text('Machines'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      final machines = find.byKey(const ValueKey('swarm-machines-button'));
      final models = find.byKey(const ValueKey('swarm-models-button'));
      expect(
        tester.getCenter(machines).dx,
        lessThan(tester.getCenter(models).dx),
      );
      expect(
        tester.getCenter(models).dx,
        lessThan(tester.getCenter(find.byTooltip('Harnesses')).dx),
      );
      await tester.tap(machines);
      await tester.pumpAndSettle();
      expect(find.text('Machines'), findsOneWidget);
      await key(tester, LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      tester.testTextInput.enterText('x');
      await tester.idle();
      expect(String.fromCharCodes(input.single.bytes), 'x');
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  testWidgets(
    'clicking a linked machine scopes work by ID even when names match',
    (tester) async {
      final app = createApp();
      app.stateOf('m')!
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected;
      app.machineStates['other'] =
          MachineState(
              const Machine(
                machineId: 'other',
                name: 'Test host',
                authMode: MachineAuthMode.remote,
              ),
            )
            ..nodeOnline = true
            ..connectionStatus = ConnectionStatus.connected
            ..agentLoadStatus = AgentLoadStatus.loaded
            ..agents = const [
              Agent(id: 'unrelated', name: 'Task from another Test host'),
            ];
      app.adoptSessionForTest(terminal('a0', []));
      await mount(tester, app);
      await tester.tap(find.byKey(const ValueKey('swarm-machines-button')));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('machine-m')));
      await tester.pumpAndSettle();
      expect(find.text('Machines'), findsNothing);
      final search = tester.widget<TextField>(
        find.byKey(const ValueKey('swarm-search-input')),
      );
      expect(search.controller!.text, isEmpty);
      expect(find.text('Harnesses · Test host'), findsOneWidget);
      expect(find.text('Task from another Test host'), findsNothing);
      await tester.enterText(
        find.byKey(const ValueKey('swarm-search-input')),
        'Task from another',
      );
      await tester.pumpAndSettle();
      expect(find.text('Task from another Test host'), findsNothing);
      expect(search.focusNode!.hasFocus, isTrue);
      await tester.pumpWidget(const SizedBox());
      app.dispose();
    },
  );

  for (final nativeTabs in [false, true]) {
    testWidgets(
      'New terminal without a machine opens setup and preserves the tab (native=$nativeTabs)',
      (tester) async {
        final app = createApp();
        app.machines = [];
        app.machineStates.clear();
        final tab = app.activeSwarm;
        await mount(tester, app, nativeTabs: nativeTabs);

        if (nativeTabs) {
          final action = native(tester, 'newTerminal');
          await tester.pumpAndSettle();
          await action;
        } else {
          await key(tester, LogicalKeyboardKey.keyT, cmd: true, shift: true);
          await tester.pumpAndSettle();
        }

        expect(find.byKey(const ValueKey('machines-panel')), findsOneWidget);
        expect(find.text('Add a second machine'), findsOneWidget);
        expect(app.activeSwarm, same(tab));
        expect(app.panes, isEmpty);
        expect(tester.takeException(), isNull);

        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.byKey(const ValueKey('machines-panel')), findsNothing);
        expect(app.activeSwarm, same(tab));
        expect(app.panes, isEmpty);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }

  testWidgets('a fresh machine opens creation with that machine selected', (
    tester,
  ) async {
    final previous = newHarnessOpensInBox;
    newHarnessOpensInBox = true;
    addTearDown(() => newHarnessOpensInBox = previous);
    final app = createApp();
    const fresh = Machine(
      machineId: 'fresh',
      name: 'New Mac mini',
      authMode: MachineAuthMode.remote,
    );
    app.machines = [...app.machines, fresh];
    app.machineStates['fresh'] = MachineState(fresh)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected;
    app.adoptSessionForTest(terminal('a0', []));
    await mount(tester, app);
    await tester.tap(find.byKey(const ValueKey('swarm-machines-button')));
    await tester.pumpAndSettle();
    await tester.tap(find.text('New harness'));
    await tester.pumpAndSettle();
    final box = tester.widget<NewHarnessBox>(find.byType(NewHarnessBox));
    expect(box.controller.machineId, 'fresh');
    expect(box.controller.placement, HarnessPlacement.currentTab);
    expect(app.panes.single.machineId, 'm', reason: 'Existing work stays open');
    await tester.pumpWidget(const SizedBox());
    app.dispose();
  });

  for (final fail in [false, true]) {
    testWidgets(
      'Machines toolbar opens Rename and updates names (failure=$fail)',
      (tester) async {
        const channel = MethodChannel('harness/swarm_tabs');
        final updates = <Map>[];
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          channel,
          (call) async {
            if (call.method == 'machinesState') {
              updates.add(call.arguments as Map);
            }
            return null;
          },
        );
        addTearDown(
          () => tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            channel,
            null,
          ),
        );
        final app = createApp();
        app.stateOf('m')!.nodeOnline = true;
        final api = _MachineApi();
        app.api = api;
        final input = <TerminalBinaryFrame>[];
        app.adoptSessionForTest(terminal('a0', input));
        await mount(tester, app, nativeTabs: true);
        // The native toolbar and View menu both open the simplified panel.
        final opened = native(tester, 'machineList');
        await tester.pumpAndSettle();
        await opened;
        expect(find.text('Machines'), findsOneWidget);
        await tester.tap(find.byTooltip('Options for Test host'));
        await tester.pumpAndSettle();
        await tester.tap(find.text('Rename'));
        await tester.pumpAndSettle();
        expect(find.text('Rename Machine'), findsOneWidget);
        final field = find.byType(TextField);
        await tester.enterText(field, '   ');
        await tester.testTextInput.receiveAction(TextInputAction.done);
        await tester.pump();
        expect(find.text('Name cannot be empty'), findsOneWidget);
        expect(api.calls, isEmpty);
        await tester.enterText(field, '  Office Mac  ');
        if (fail) api.error = 'Connection unavailable';
        await key(tester, LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(api.calls, [('m', 'Office Mac')]);
        if (fail) {
          expect(find.textContaining('Connection unavailable'), findsOneWidget);
          expect(app.stateOf('m')!.machine.displayName, isNot('Office Mac'));
          api.error = null;
          await key(tester, LogicalKeyboardKey.enter);
          await tester.pumpAndSettle();
        }
        expect(find.text('Rename Machine'), findsNothing);
        expect(
          find.descendant(
            of: find.byKey(const ValueKey('machine-m')),
            matching: find.text('Office Mac'),
          ),
          findsOneWidget,
        );
        expect(app.machines.single.displayName, 'Office Mac');
        expect((updates.last['machines'] as List).single['name'], 'Office Mac');
        await key(tester, LogicalKeyboardKey.escape);
        await tester.pumpAndSettle();
        expect(find.text('Machines'), findsNothing);
        expect(
          tester
              .widget<TerminalView>(find.byType(TerminalView))
              .focusNode!
              .hasFocus,
          isTrue,
        );
        tester.testTextInput.enterText('x');
        await tester.idle();
        expect(String.fromCharCodes(input.single.bytes), 'x');
        await tester.pumpWidget(const SizedBox());
        app.dispose();
        expect(tester.takeException(), isNull);
      },
    );
  }
}
