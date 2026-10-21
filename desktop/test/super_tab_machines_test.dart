import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

Future<void> _openAddMachineDialog(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  dynamic c, {
  Brightness brightness = Brightness.dark,
  double textScale = 1,
}) async {
  final previousBrightness = grid.AppTheme.brightness.value;
  grid.AppTheme.brightness.value = brightness;
  addTearDown(() => grid.AppTheme.brightness.value = previousBrightness);
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: brightness),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(textScale)),
        child: child!,
      ),
      home: Scaffold(
        body: SizedBox(
          width: 300,
          height: 400,
          child: SuperTabMachines(
            controller: c,
            app: f.app,
            onAddAgent: (_) {},
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
  await tester.tap(find.byTooltip('Add machine'));
  await tester.pumpAndSettle();
}

final _picker = find.byKey(const ValueKey('swarm-machine-picker'));
Finder _option(String id) => find.byKey(ValueKey('swarm-machine-option-$id'));

void main() {
  test('shared repository metadata excludes embedded credentials', () {
    expect(
      superTabRepositoryUrl('https://token@github.com/example/project'),
      isNull,
    );
    expect(
      superTabRepositoryUrl('ssh://git:secret@github.com/example/project'),
      isNull,
    );
    expect(
      superTabRepositoryUrl('git@github.com:example/project.git'),
      'git@github.com:example/project.git',
    );
    expect(
      superTabRepositoryUrl('https://github.com/example/project'),
      'https://github.com/example/project',
    );
  });
  testWidgets(
    'Add machine has one field and contributes the prepared project and installed engines',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'scope': 'swarm',
        'repositoryUrl': null,
      };
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 300,
              height: 400,
              child: SuperTabMachines(
                controller: c,
                app: f.app,
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Add machine'));
      await tester.pumpAndSettle();
      expect(_picker, findsOneWidget);
      expect(
        find.text('This Mac (${f.app.stateOf('m')!.machine.displayName})'),
        findsOneWidget,
      );
      expect(find.byType(Checkbox), findsNothing);
      expect(find.text('Choose project folder'), findsNothing);
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(f.connection.server.posts.single['command'], {
        'type': 'machine.contribute',
        'machineId': 'm',
        'name': f.app.stateOf('m')!.machine.displayName,
        'cwd': '/work/project',
        'scope': 'swarm',
        'engines': ['claude', 'codex', 'pi'],
        'maxAgents': 4,
      });
      expect(f.connection.calls.where((c) => c.$1 == 'agent_create'), isEmpty);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: the lead runs on This Mac but it is not contributed yet, so "+" still offers it',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['agents'] = [
        {
          'id': 'lead-agent',
          'name': 'Lead',
          'machineId': 'm',
          'harnessId': 'native-lead',
          'contributorId': 'owner',
          'configuration': {'engine': 'codex'},
        },
      ];
      (f.connection.server.state['conversations'] as List)[0]['leadId'] =
          'lead-agent';
      (f.connection.server.state['conversations'] as List)[0]['agentIds'] = [
        'lead-agent',
      ];
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'repositoryUrl': null,
      };
      // No 'machines' entry: an agent running on This Mac does not mean it
      // was ever contributed to this tab.
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(
        find.text('This Mac (${f.app.stateOf('m')!.machine.displayName})'),
        findsOneWidget,
      );
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Add machine'),
      );
      expect(button.onPressed, isNotNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: already-contributed machines remain visible but cannot be added again',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(find.text('Choose a machine'), findsOneWidget);
      expect(
        tester
            .widget<FilledButton>(
              find.widgetWithText(FilledButton, 'Add machine'),
            )
            .onPressed,
        isNull,
      );
      expect(find.textContaining('Already in this tab:'), findsNothing);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(_option('m')).onPressed, isNull);
      expect(find.byTooltip('Already in this Swarm'), findsOneWidget);
      await tester.tap(_option('m'));
      await tester.pumpAndSettle();
      expect(find.text('Choose a machine'), findsOneWidget);
      expect(f.connection.server.posts, isEmpty);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: an available owned machine is selected ahead of an already-contributed one',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      const other = Machine(
        machineId: 'm2',
        authMode: MachineAuthMode.remote,
        name: 'Other Mac',
      );
      f.app.machines = [...f.app.machines, other];
      f.app.machineStates['m2'] = MachineState(other)
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(find.text('Other Mac'), findsOneWidget);
      expect(
        find.text('This Mac (${f.app.stateOf('m')!.machine.displayName})'),
        findsNothing,
      );
      expect(find.textContaining('Already in this tab:'), findsNothing);
      final button = tester.widget<FilledButton>(
        find.widgetWithText(FilledButton, 'Add machine'),
      );
      expect(button.onPressed, isNotNull);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(_option('m')).onPressed, isNull);
      expect(tester.widget<MenuItemButton>(_option('m2')).onPressed, isNotNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add machine: offline and unlinked owned machines are disabled with status tooltips; shared machines stay excluded',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      const offline = Machine(
        machineId: 'm3',
        authMode: MachineAuthMode.remote,
        name: 'macbok test local',
      );
      f.app.machines = [...f.app.machines, offline];
      f.app.machineStates['m3'] = MachineState(offline)
        ..nodeOnline = false
        ..connectionStatus = ConnectionStatus.disconnected
        ..agentLoadStatus = AgentLoadStatus.loaded;
      const unlinked = Machine(
        machineId: 'm4',
        authMode: MachineAuthMode.remote,
        name: 'Studio Mac',
      );
      const sharedHarness = Machine(
        machineId: 'm5',
        authMode: MachineAuthMode.remote,
        name: 'Another account’s harness',
        isShared: true,
      );
      const sharedMachine = Machine(
        machineId: 'm6',
        authMode: MachineAuthMode.remote,
        name: 'Another account’s computer',
        machineShare: MachineShare(
          ownerName: 'Another owner',
          ownerEmail: 'another@example.com',
          via: 'email',
          added: true,
        ),
      );
      for (final machine in [unlinked, sharedHarness, sharedMachine]) {
        f.app.machineStates[machine.machineId] = MachineState(machine)
          ..nodeOnline = true
          ..connectionStatus = ConnectionStatus.connected;
      }
      f.app.machineStates['m4']!.needsLink = true;
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(_picker, findsOneWidget);
      expect(find.text('macbok test local'), findsNothing);
      expect(find.textContaining('Offline:'), findsNothing);
      expect(find.textContaining('Not linked:'), findsNothing);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      expect(tester.widget<MenuItemButton>(_option('m3')).onPressed, isNull);
      expect(tester.widget<MenuItemButton>(_option('m4')).onPressed, isNull);
      expect(_option('m5'), findsNothing);
      expect(_option('m6'), findsNothing);
      const offlineHint = 'Offline. Open Harness on this computer to add it.';
      expect(find.byTooltip(offlineHint), findsOneWidget);
      expect(
        find.byTooltip('Not linked. Link this computer from Machines.'),
        findsOneWidget,
      );
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(find.byTooltip(offlineHint)));
      await tester.pumpAndSettle(const Duration(milliseconds: 800));
      expect(find.text(offlineHint), findsOneWidget);
      await tester.tap(_option('m3'));
      await tester.pumpAndSettle();
      expect(
        find.descendant(
          of: _picker,
          matching: find.text(
            'This Mac (${f.app.stateOf('m')!.machine.displayName})',
          ),
        ),
        findsOneWidget,
      );
      expect(f.connection.server.posts, isEmpty);
      await mouse.removePointer();

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Machine picker skips unavailable rows with the keyboard and returns focus to the field',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      for (final (id, name, online) in [
        ('m2', 'Offline Mac', false),
        ('m3', 'Studio Mac', true),
      ]) {
        final machine = Machine(
          machineId: id,
          authMode: MachineAuthMode.remote,
          name: name,
        );
        f.app.machineStates[id] = MachineState(machine)
          ..nodeOnline = online
          ..connectionStatus = online
              ? ConnectionStatus.connected
              : ConnectionStatus.disconnected;
      }
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);
      await tester.tap(_picker);
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(
        find.descendant(of: _picker, matching: find.text('Studio Mac')),
        findsOneWidget,
      );
      expect(f.connection.server.posts, isEmpty);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pumpAndSettle();
      expect(_option('m2'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(_option('m2'), findsNothing);
      expect(tester.widget<TextButton>(_picker).focusNode!.hasFocus, isTrue);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'A machine that goes offline while the form is open cannot be submitted',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);
      f.app.machineStates['m']!.nodeOnline = false;
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await tester.pumpAndSettle();
      expect(f.connection.server.posts, isEmpty);
      expect(
        f.connection.calls.where(
          (call) =>
              call.$1 == 'super_tabs' &&
              call.$2['action'] == 'prepareContribution',
        ),
        isEmpty,
      );
      expect(find.byType(AlertDialog), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  for (final brightness in Brightness.values) {
    testWidgets(
      'Machine picker handles unavailable long names at 2x text in ${brightness.name}',
      (tester) async {
        tester.view.physicalSize = const Size(540, 800);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final f = SuperTabLaunchFixture();
        f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
        f.app.machineStates['m']!.nodeOnline = false;
        const unlinked = Machine(
          machineId: 'studio',
          authMode: MachineAuthMode.remote,
          name: 'Design Studio’s MacBook Pro with a long custom machine name',
        );
        f.app.machineStates['studio'] = MachineState(unlinked)
          ..nodeOnline = true
          ..needsLink = true;
        final c = await f.app.superTabs.open(tabId);
        await c.refresh();
        await _openAddMachineDialog(
          tester,
          f,
          c,
          brightness: brightness,
          textScale: 2,
        );
        expect(
          tester
              .widget<FilledButton>(
                find.widgetWithText(FilledButton, 'Add machine'),
              )
              .onPressed,
          isNull,
        );
        await tester.tap(_picker);
        await tester.pumpAndSettle();
        expect(tester.widget<MenuItemButton>(_option('m')).onPressed, isNull);
        expect(
          tester.widget<MenuItemButton>(_option('studio')).onPressed,
          isNull,
        );
        expect(tester.takeException(), isNull);

        await tester.pumpWidget(const SizedBox());
        await c.flush();
        f.app.superTabs.dispose();
        await tester.pump();
      },
    );
  }

  testWidgets(
    'Configure on a machine card reads as editing: title "Configure machine", button "Save"',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: SizedBox(
              width: 300,
              height: 400,
              child: SuperTabMachines(
                controller: c,
                app: f.app,
                onAddAgent: (_) {},
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-machine-m')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Configure'));
      await tester.pumpAndSettle();

      expect(find.text('Configure machine'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Save'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Add machine'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );
}
