import 'package:file_selector_platform_interface/file_selector_platform_interface.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/widgets/swarm_dialogs.dart';
import 'package:harness/ws/local_cli_discovery.dart';

import 'swarm_state_test.dart' show createApp;

class _Folders extends FileSelectorPlatform {
  @override
  Future<String?> getDirectoryPath({
    String? initialDirectory,
    String? confirmButtonText,
  }) async => '/work/autonomous-harness/';
}

void main() {
  test(
    'an explicitly added folder names the group across aliased checkouts',
    () {
      final app = createApp();
      app.machineStates['m']!.localEndpoint = LocalCliEndpoint(
        computerId: 'local',
        wsUri: Uri.parse('ws://fixture.invalid'),
        protocolVersion: 1,
        terminalProtocolVersion: 3,
        agentProjects: const {
          'a0': AgentProject(
            name: 'harness-app-v2',
            cwd: '/work/harness-app-v2',
            remote: 'https://github.com/autonomous-ai/openharness.git',
          ),
          'a1': AgentProject(
            name: 'autonomous-harness',
            cwd: '/work/autonomous-harness',
            remote: 'https://github.com/autonomous-ai/openharness.git',
          ),
        },
      );
      final groups = swarmProjects(app, const [
        SavedSwarmProject(
          machineId: 'm',
          path: '/work/autonomous-harness',
          name: 'autonomous-harness',
        ),
      ]);
      expect(groups, hasLength(1));
      expect(groups.single.name, 'autonomous-harness');
      expect(groups.single.agents.map((a) => a.agent.id), ['a0', 'a1']);
      app.dispose();
    },
  );

  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'adding a project derives its name from the selected folder at ${scale}x text',
      (tester) async {
        tester.view.physicalSize = const Size(640, 420);
        tester.view.devicePixelRatio = 1;
        addTearDown(tester.view.resetPhysicalSize);
        addTearDown(tester.view.resetDevicePixelRatio);
        final original = FileSelectorPlatform.instance;
        FileSelectorPlatform.instance = _Folders();
        addTearDown(() => FileSelectorPlatform.instance = original);
        final app = createApp();
        app.machineStates['m']!.localEndpoint = LocalCliEndpoint(
          computerId: 'local',
          wsUri: Uri.parse('ws://fixture.invalid'),
          protocolVersion: 1,
          terminalProtocolVersion: 3,
        );
        SavedSwarmProject? saved;
        await tester.pumpWidget(
          MaterialApp(
            builder: (context, child) => MediaQuery(
              data: MediaQuery.of(context)
                  .copyWith(textScaler: TextScaler.linear(scale)),
              child: child!,
            ),
            home: Builder(
              builder: (context) => TextButton(
                onPressed: () async {
                  saved = await showSwarmProjectDialog(context, app);
                },
                child: const Text('Open'),
              ),
            ),
          ),
        );
        await tester.tap(find.text('Open'));
        await tester.pumpAndSettle();
        expect(find.byType(TextField), findsNothing);
        await tester.ensureVisible(find.text('Choose folder'));
        await tester.tap(find.text('Choose folder'));
        await tester.pumpAndSettle();
        await tester.tap(find.widgetWithText(FilledButton, 'Add project'));
        await tester.pumpAndSettle();
        expect(saved!.name, 'autonomous-harness');
        expect(saved!.path, '/work/autonomous-harness/');
        expect(tester.takeException(), isNull);
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      },
    );
  }
}
