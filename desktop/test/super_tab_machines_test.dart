import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/shared/widgets/app_select_field.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;

Future<void> _openAddMachineDialog(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  dynamic c,
) async {
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
}

Future<void> _openConfigureDialog(
  WidgetTester tester,
  SuperTabLaunchFixture f,
  dynamic c,
) async {
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
}

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
      expect(find.byType(AppSelectField<String>), findsOneWidget);
      expect(
        find.text('This computer (${f.app.stateOf('m')!.machine.displayName})'),
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
    'Add machine: the lead runs on this computer but it is not contributed yet, so "+" still offers it',
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
      // No 'machines' entry: an agent running on this computer does not mean it
      // was ever contributed to this tab.
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(find.byType(AppSelectField<String>), findsOneWidget);
      expect(
        find.text('This computer (${f.app.stateOf('m')!.machine.displayName})'),
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
    'Add machine: only this computer, already in the tab, offers no picker and no Add machine button',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(find.byType(AppSelectField<String>), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Add machine'), findsNothing);
      expect(
        find.text(
          'This computer (${f.app.stateOf('m')!.machine.displayName}) is already in this tab.',
        ),
        findsOneWidget,
      );
      expect(
        find.textContaining('connect it first in Machines'),
        findsOneWidget,
      );
      expect(find.widgetWithText(TextButton, 'Close'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Cancel'), findsNothing);
      expect(find.widgetWithText(TextButton, 'Open Machines'), findsOneWidget);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets('Add machine: with this computer already in the tab, the picker offers only another online own '
      'machine, preselected, and keeps Add machine enabled', (tester) async {
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

    expect(find.byType(AppSelectField<String>), findsOneWidget);
    expect(find.text('Other Mac'), findsOneWidget);
    expect(
      find.text('This computer (${f.app.stateOf('m')!.machine.displayName})'),
      findsNothing,
    );
    expect(find.textContaining('Already in this tab:'), findsOneWidget);
    expect(find.widgetWithText(TextButton, 'Cancel'), findsOneWidget);
    final button = tester.widget<FilledButton>(
      find.widgetWithText(FilledButton, 'Add machine'),
    );
    expect(button.onPressed, isNotNull);

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'Add machine: Cancel closes the dialog without sending any command',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      expect(find.byType(AppSelectField<String>), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();

      expect(find.byType(AlertDialog), findsNothing);
      expect(f.connection.server.posts, isEmpty);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets('Add machine: an offline own machine is not offered in the picker and is named as offline '
      'with a next step', (tester) async {
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
    final c = await f.app.superTabs.open(tabId);
    await c.refresh();
    await _openAddMachineDialog(tester, f, c);

    expect(find.byType(AppSelectField<String>), findsOneWidget);
    expect(find.text('macbok test local'), findsNothing);
    expect(
      find.text('Offline: macbok test local. Start Harness on it to add it.'),
      findsOneWidget,
    );

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'The machine card reads "Add machine", not "Configure", for the lead\'s own '
    'not-yet-contributed computer, and opens Add mode with it preselected',
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
      // No 'machines' entry: an agent running on this computer does not mean
      // it was ever contributed to this tab.
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
      expect(find.widgetWithText(TextButton, 'Configure'), findsNothing);
      expect(find.widgetWithText(TextButton, 'Add machine'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Add machine'));
      await tester.pumpAndSettle();

      expect(find.text('Add machine'), findsWidgets);
      expect(find.text('Configure machine'), findsNothing);
      expect(find.byType(AppSelectField<String>), findsOneWidget);
      expect(
        find.text('This computer (${f.app.stateOf('m')!.machine.displayName})'),
        findsOneWidget,
      );
      expect(find.widgetWithText(FilledButton, 'Add machine'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Update'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Configure shows the machine as text, explains the update, and has Cancel and Update',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(tester, f, c);

      expect(find.text('Configure machine'), findsOneWidget);
      // No picker: the machine cannot be swapped for another one here.
      expect(find.byType(AppSelectField<String>), findsNothing);
      expect(
        find.text('This computer (${f.app.stateOf('m')!.machine.displayName})'),
        findsOneWidget,
      );
      expect(find.textContaining('Checks its project folder'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Update'), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Cancel'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Save'), findsNothing);
      expect(find.widgetWithText(FilledButton, 'Add machine'), findsNothing);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Configure: Cancel closes the dialog without sending any command',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(tester, f, c);

      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();

      expect(find.byType(AlertDialog), findsNothing);
      expect(f.connection.server.posts, isEmpty);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Add: Cancel is disabled and the button shows Preparing… while the dialog is busy',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'repositoryUrl': null,
      };
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openAddMachineDialog(tester, f, c);

      f.connection.holdPrepareContribution = true;
      await tester.tap(find.widgetWithText(FilledButton, 'Add machine'));
      await tester.pump();

      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Cancel'))
            .onPressed,
        isNull,
      );
      expect(find.text('Preparing…'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Add machine'), findsNothing);

      f.connection.holdPrepareContribution = false;
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets(
    'Configure: Cancel is disabled and the button shows Updating… while the dialog is busy',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'repositoryUrl': null,
      };
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(tester, f, c);

      f.connection.holdPrepareContribution = true;
      await tester.tap(find.widgetWithText(FilledButton, 'Update'));
      await tester.pump();

      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Cancel'))
            .onPressed,
        isNull,
      );
      expect(find.text('Updating…'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Update'), findsNothing);

      f.connection.holdPrepareContribution = false;
      await tester.pump(const Duration(seconds: 2));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsNothing);
      expect(tester.takeException(), isNull);

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );

  testWidgets('Configure on a contributed machine missing from machineStates, or offline, falls back to '
      'a sensible name with no picker', (tester) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    const offline = Machine(
      machineId: 'm3',
      authMode: MachineAuthMode.remote,
      name: 'Offline Contributed',
    );
    f.app.machines = [...f.app.machines, offline];
    f.app.machineStates['m3'] = MachineState(offline)
      ..nodeOnline = false
      ..connectionStatus = ConnectionStatus.disconnected
      ..agentLoadStatus = AgentLoadStatus.loaded;
    f.connection.server.state['machines'] = [
      {'machineId': 'm2', 'contributorId': 'owner', 'name': 'Ghost Box'},
      {
        'machineId': 'm3',
        'contributorId': 'owner',
        'name': 'Offline Contributed',
      },
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

    Future<void> checkConfigure(String id, String expectedLabel) async {
      await tester.tap(find.byKey(ValueKey('super-machine-$id')));
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(TextButton, 'Configure'));
      await tester.pumpAndSettle();
      expect(find.text('Configure machine'), findsOneWidget);
      expect(find.byType(AppSelectField<String>), findsNothing);
      expect(find.text(expectedLabel), findsOneWidget);
      expect(find.widgetWithText(TextButton, 'Cancel'), findsOneWidget);
      expect(find.widgetWithText(FilledButton, 'Update'), findsOneWidget);
      await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
      await tester.pumpAndSettle();
    }

    await checkConfigure('m2', 'Ghost Box');
    await checkConfigure('m3', 'Offline Contributed');

    expect(tester.takeException(), isNull);
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

  testWidgets(
    'Configure updates the project folder and installed engines for the existing machine',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      f.connection.server.state['machines'] = [
        {'machineId': 'm', 'contributorId': 'owner'},
      ];
      f.connection.server.state['project'] = {
        'machineId': 'm',
        'cwd': '/work/project',
        'repositoryUrl': null,
      };
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      await _openConfigureDialog(tester, f, c);

      await tester.tap(find.widgetWithText(FilledButton, 'Update'));
      await tester.pumpAndSettle();

      expect(find.byType(AlertDialog), findsNothing);
      expect(f.connection.server.posts.single['command'], {
        'type': 'machine.contribute',
        'machineId': 'm',
        'name': f.app.stateOf('m')!.machine.displayName,
        'cwd': '/work/project',
        'engines': ['claude', 'codex', 'pi'],
        'maxAgents': 4,
      });

      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      await tester.pump();
    },
  );
}
