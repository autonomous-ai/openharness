// A new project's name the person typed whose folder is already there is
// refused, never quietly changed (PROJECT_EXISTS). That refusal was 4 of 7
// failed starts on Oct 18 (CLI 0.4.18), all from the apps, and it left only
// retyping the name as a path. The form now offers "Use the existing folder",
// which starts there only once it is pressed.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/widgets/new_harness_form.dart';
import 'package:harness/ws/ws_conn.dart';
import 'package:path/path.dart' as p;

const _folder = '/home/lee/harnesses/payments';

/// A machine whose `agent_create` refuses a new project with [refusal].
class _Machine extends WsConn {
  _Machine(String id)
    : super(
        wsBaseUrl: 'ws://fixture.invalid',
        autonomousEnv: 'test',
        machineId: id,
        accessTokenProvider: (_, _) async => '',
        onAuthFailure: (_) {},
        onEvent: (_) {},
        onStatus: (_) {},
      );
  final creates = <Map<String, dynamic>>[];

  /// The failure a create with `projectSource` gets; null starts it.
  Map<String, dynamic>? refusal = {
    'code': 'PROJECT_EXISTS',
    'detail':
        '“payments” already exists. Select that folder from your projects.',
    'existingFolder': _folder,
  };

  @override
  Future<Map<String, dynamic>> request(
    String type, {
    Map<String, dynamic> payload = const {},
    Duration timeout = const Duration(seconds: 20),
  }) async {
    switch (type) {
      case 'engines_probe':
        return {
          'engines': [
            {'engine': 'codex', 'installed': true},
          ],
        };
      case 'dsh_list':
        return {'dsh': []};
      case 'fs_list_dir':
        return {'path': payload['path'] ?? '/home/lee', 'entries': []};
      case 'agent_create':
        creates.add(Map.of(payload));
        if (payload['projectSource'] != null && refusal != null) {
          return {
            'creationId': payload['creationId'],
            'state': 'failed',
            'failure': refusal,
          };
        }
        return {
          'creationId': payload['creationId'],
          'state': 'created',
          'agent': {
            'id': 'made-${creates.length}',
            'name': 'Payments',
            'engine': 'codex',
          },
        };
      default:
        return {};
    }
  }
}

class _App extends AppNotifier {
  _App(this.root, Map<String, _Machine> connections)
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
        connectionForTest: (id) => connections[id]!,
      ) {
    machines = [
      for (final id in connections.keys)
        Machine(machineId: id, name: id, authMode: MachineAuthMode.remote),
    ];
    for (final machine in machines) {
      machineStates[machine.machineId] = MachineState(machine)
        ..localOnly = machine.machineId == 'local'
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded;
    }
    gitProjectReaderForTest = (_, _) async => {'isGit': false};
    status = AppStatus.authenticated;
  }
  final String root;
  @override
  Future<String> prepareLocalProjectFolder(
    ProjectFolderRequest request, {
    String label = 'harness',
  }) => request.prepareLocal(projectHome: root, label: label);
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  late Directory home;
  late _App app;
  late Map<String, _Machine> machines;
  setUp(() async {
    home = await Directory.systemTemp.createTemp('harness-project-exists-');
    machines = {
      for (final id in ['local', 'office']) id: _Machine(id),
    };
    app = _App(p.join(home.path, 'harnesses'), machines);
  });
  tearDown(() async {
    app.dispose();
    for (final machine in machines.values) {
      await machine.close();
    }
    await home.delete(recursive: true);
  });

  NewHarnessController box(String machine, {String? name = 'payments'}) {
    final box = NewHarnessController(
      app,
      machineId: machine,
      engine: 'codex',
      projectName: name,
      home: home.path,
      placement: HarnessPlacement.newTab,
    );
    addTearDown(box.dispose);
    return box;
  }

  test('a typed name another machine already has offers its folder, and starts there only once chosen', () async {
    final draft = box('office');
    expect(await draft.create(), NewHarnessOutcome.failed);
    expect(
      draft.error,
      '“payments” already exists on office. '
      'Choose another name, or use the existing folder.',
    );
    expect(draft.existingFolder, _folder);
    // Offered, not taken: nothing else was asked of the machine.
    expect(machines['office']!.creates, hasLength(1));
    expect(draft.project.name, 'payments');

    expect(await draft.useExistingFolder(), NewHarnessOutcome.created);
    final started = machines['office']!.creates.last;
    expect(started['cwd'], _folder);
    expect(started.containsKey('projectSource'), isFalse);
    expect(started.containsKey('projectName'), isFalse);
    expect(machines['office']!.creates, hasLength(2));
    expect(draft.project.folder, _folder);
    expect(draft.existingFolder, isNull);
  });

  test('a Windows machine offers an existing folder by its name', () async {
    const folder = r'C:\Users\lee\harnesses\payments';
    machines['office']!.refusal = {
      'code': 'PROJECT_EXISTS',
      'existingFolder': folder,
    };
    final draft = box('office');
    expect(await draft.create(), NewHarnessOutcome.failed);
    expect(draft.error, contains('“payments” already exists on office.'));
    expect(draft.existingFolder, folder);
    expect(await draft.useExistingFolder(), NewHarnessOutcome.created);
    expect(machines['office']!.creates.last['cwd'], folder);
  });

  test('a Windows machine offers an existing folder under a network home', () async {
    const folder = r'\\server\share\harnesses\payments';
    machines['office']!.refusal = {
      'code': 'PROJECT_EXISTS',
      'existingFolder': folder,
    };
    final draft = box('office');
    expect(await draft.create(), NewHarnessOutcome.failed);
    expect(draft.error, contains('“payments” already exists on office.'));
    expect(draft.existingFolder, folder);
    expect(await draft.useExistingFolder(), NewHarnessOutcome.created);
    expect(machines['office']!.creates.last['cwd'], folder);
  });

  test('nothing is offered for a refusal with no folder to start in, or any other refusal', () async {
    // What is there is a file, or the machine predates naming the folder.
    machines['office']!.refusal = {
      'code': 'PROJECT_EXISTS',
      'detail':
          '“payments” already exists. Select that folder from your projects.',
    };
    final file = box('office');
    expect(await file.create(), NewHarnessOutcome.failed);
    expect(file.error, contains('already exists'));
    expect(file.existingFolder, isNull);
    expect(await file.useExistingFolder(), NewHarnessOutcome.failed);
    expect(machines['office']!.creates, hasLength(1));

    machines['office']!.refusal = {
      'code': 'INVALID_DSH',
      'detail': 'Install it first.',
      'existingFolder': _folder,
    };
    final other = box('office');
    expect(await other.create(), NewHarnessOutcome.failed);
    expect(other.existingFolder, isNull);
  });

  test('a clone refused for its destination offers nothing: only a typed name does', () async {
    final draft = box('office', name: null);
    draft.focusField(NewHarnessField.projectRepository);
    draft.setQuery('owner/payments');
    draft.accept();
    expect(draft.project.repository?.name, 'payments');
    expect(await draft.create(), NewHarnessOutcome.failed);
    expect(machines['office']!.creates.single['repositoryUrl'], isNotNull);
    expect(draft.existingFolder, isNull);
  });

  test('another name, or another machine, takes the offer away', () async {
    final draft = box('office');
    await draft.create();
    expect(draft.existingFolder, _folder);
    draft.focusField(NewHarnessField.machine);
    draft.setQuery('local');
    draft.accept();
    expect(draft.machineId, 'local');
    expect(draft.existingFolder, isNull);
    draft.focusField(NewHarnessField.machine);
    draft.setQuery('office');
    draft.accept();
    expect(draft.machineId, 'office');
    draft.focusField(NewHarnessField.projectName);
    draft.setQuery('refunds');
    draft.accept();
    expect(draft.project.name, 'refunds');
    expect(draft.existingFolder, isNull);
    expect(await draft.useExistingFolder(), NewHarnessOutcome.failed);
    expect(machines['office']!.creates, hasLength(1));
  });

  test('this computer refuses a typed name the same way, and starts in that folder once chosen', () async {
    final existing = Directory(p.join(app.root, 'payments'));
    await existing.create(recursive: true);
    final keep = File(p.join(existing.path, 'keep.txt'));
    await keep.writeAsString('untouched');
    final draft = box('local');
    expect(await draft.create(), NewHarnessOutcome.failed);
    expect(draft.error, contains('“payments” already exists on local.'));
    expect(draft.existingFolder, existing.path);
    expect(machines['local']!.creates, isEmpty);

    expect(await draft.useExistingFolder(), NewHarnessOutcome.created);
    expect(machines['local']!.creates.single['cwd'], existing.path);
    expect(await keep.readAsString(), 'untouched');
    expect(
      await Directory(app.root).list().map((e) => p.basename(e.path)).toList(),
      ['payments'],
    );
  });

  test(
    'on this computer a file with that name is no folder to offer',
    () async {
      await Directory(app.root).create(recursive: true);
      await File(p.join(app.root, 'payments')).writeAsString('notes');
      final draft = box('local');
      expect(await draft.create(), NewHarnessOutcome.failed);
      expect(
        draft.error,
        '“payments” already exists. Choose it as an existing project.',
      );
      expect(draft.existingFolder, isNull);
      expect(machines['local']!.creates, isEmpty);
    },
  );

  for (final desktop in [true, false]) {
    testWidgets(
      'the ${desktop ? 'desktop' : 'line'} form shows Use the existing folder after the refusal, and pressing it starts there',
      (tester) async {
        final draft = box('office');
        var created = 0;
        await tester.pumpWidget(
          MaterialApp(
            theme: ThemeData.dark(),
            home: Scaffold(
              body: Center(
                child: SizedBox(
                  width: 1000,
                  height: 700,
                  child: NewHarnessForm(
                    controller: draft,
                    onClose: () {},
                    onCreated: () => created++,
                    desktop: desktop,
                    embedded: desktop,
                  ),
                ),
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        final offer = find.byKey(const ValueKey('use-existing-folder'));
        expect(offer, findsNothing);

        expect(await draft.create(), NewHarnessOutcome.failed);
        await tester.pumpAndSettle();
        expect(
          find.text(
            '“payments” already exists on office. '
            'Choose another name, or use the existing folder.',
          ),
          findsOneWidget,
        );
        expect(offer, findsOneWidget);
        expect(
          find.descendant(
            of: offer,
            matching: find.text('Use the existing folder'),
          ),
          findsOneWidget,
        );
        expect(created, 0);

        await tester.ensureVisible(offer);
        await tester.tap(offer);
        await tester.pumpAndSettle();
        expect(created, 1);
        expect(machines['office']!.creates.last['cwd'], _folder);
        expect(machines['office']!.creates, hasLength(2));
      },
    );
  }
}
