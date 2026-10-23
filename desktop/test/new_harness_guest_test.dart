import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/guest_folders.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/state/retarget_refusal.dart';
import 'package:harness/widgets/new_harness_form.dart';

/// A machine another account shares with this one: this person is a guest there
/// (docs/plans/2026-10-19-guest-machine-sharing-plan.md). Its daemon starts Claude Code or Codex in
/// the guest's own space, on its owner's plans, and answers a guest nothing of the owner's.
class _GuestApp extends AppNotifier {
  _GuestApp()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      ) {
    final state = MachineState(
      const Machine(
        machineId: 'dee',
        name: 'Dee’s Studio',
        authMode: MachineAuthMode.remote,
        machineShare: MachineShare(
          ownerName: 'Dee',
          ownerEmail: 'dee@acme.io',
          via: 'email',
          added: true,
        ),
      ),
    )..nodeOnline = true;
    // What the owner has installed says nothing of the guest's own space.
    state.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: false),
      EngineAvailability(engine: 'codex', installed: true),
      EngineAvailability(engine: 'opencode', installed: true),
    ]);
    machineStates['dee'] = state;
  }

  /// Everything asked of the machine that a guest would be refused.
  final refusedAsks = <String>[];

  /// Where the machine says this guest may start: its workspace, and the folders its owner shares.
  GuestFolders? places = const GuestFolders(
    workspace: '/Users/Shared/HarnessGuests/hg_0/work',
  );

  @override
  Future<GuestFolders?> guestFolders(String machineId) async => places;
  final launches = <Map<String, Object?>>[];

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<void> probeDsh(
    String machineId, {
    bool force = false,
    bool userAction = false,
  }) async => refusedAsks.add('dsh_list');

  @override
  Future<Map<String, dynamic>> listRemoteFolder(
    String machineId,
    String? path,
  ) async {
    refusedAsks.add('fs_list_dir');
    return {'error': 'GUEST_NOT_ALLOWED'};
  }

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String? folder,
    bool bypassPermission = false,
    String? permissionMode,
    String? codexHome,
    String? dsh,
    String? swarmRole,
    String? swarmSkillMode,
    GridModel? model,
    String? prompt,
    String? name,
    String? agent,
    ProjectFolderRequest? projectFolder,
    String? swarmId,
    PaneSplitRequest? split,
    AgentCreationAttempt? attempt,
    HarnessPlacement? placement,
  }) async {
    launches.add({
      'machine': machineId,
      'engine': engine,
      'folder': folder,
      'projectFolder': projectFolder,
      'dsh': dsh,
      'model': model,
      'codexHome': codexHome,
      'prompt': prompt,
    });
    return null;
  }
}

void main() {
  test('switching from an owned machine clears its folder and uses the guest workspace', () async {
    final app = _GuestApp();
    app.machineStates['own'] = MachineState(
      const Machine(
        machineId: 'own',
        name: 'My Mac',
        authMode: MachineAuthMode.self,
      ),
    )..nodeOnline = true;
    addTearDown(app.dispose);
    final box = NewHarnessController(
      app,
      machineId: 'own',
      engine: 'claude',
      folder: '/Users/me/private-project',
    );
    addTearDown(box.dispose);
    await pumpEventQueue();
    app.refusedAsks.clear();
    box.focusField(NewHarnessField.machine);
    box.accept(box.options.singleWhere((o) => o.id == 'dee'));
    await pumpEventQueue();
    expect(box.asGuest, isTrue);
    expect(box.projectLabel, 'My workspace');
    expect(app.refusedAsks, isEmpty);
    expect(await box.create(), isNot(NewHarnessOutcome.failed));
    // An empty folder asks the guest daemon to use its own workspace.
    expect(app.launches.single['folder'], '');
  });

  test('a guest starts Claude Code or Codex in its own space: no project, harness, model or folder to choose', () async {
    final app = _GuestApp();
    addTearDown(app.dispose);
    final box = NewHarnessController(
      app,
      machineId: 'dee',
      engine: 'claude',
      folder: '/Users/dee/secret',
      task: 'Fix the tests',
      // Offered to the owner's own machines; never to a guest.
      offersStore: true,
    );
    addTearDown(box.dispose);
    await pumpEventQueue();

    expect(box.asGuest, isTrue);
    expect(box.compatibleEngines, ['claude', 'codex']);
    // Nothing shared: no Project to pick, the workspace.
    expect(box.fields, isNot(contains(NewHarnessField.projectMenu)));
    expect(box.projectLabel, 'My workspace');
    // The agent menu offers what a guest can start: Claude Code and Codex.
    box.focusField(NewHarnessField.harness);
    expect(box.options.map((option) => option.id), ['claude', 'codex']);
    box.focusField(NewHarnessField.launch);
    expect(box.fields, isNot(contains(NewHarnessField.model)));
    expect(box.needsProject, isFalse);
    // Claude Code is missing among the owner's engines: the guest's own installs on Create.
    expect(box.requiredChoice, isNull);
    // Nothing of the owner's is asked for: no harnesses from the Store, no folders.
    expect(app.refusedAsks, isEmpty);

    final outcome = await box.create();
    expect(box.error, isNull);
    expect(outcome, isNot(NewHarnessOutcome.failed));
    expect(app.launches.single, {
      'machine': 'dee',
      'engine': 'claude',
      // The daemon starts it in the guest's workspace: no folder of the owner's is named.
      'folder': '',
      'projectFolder': null,
      'dsh': null,
      'model': null,
      'codexHome': null,
      'prompt': 'Fix the tests',
    });
  });

  testWidgets(
    'a guest\'s Codex shows no model or account to choose: it runs on the owner\'s subscription',
    (tester) async {
      final app = _GuestApp();
      addTearDown(app.dispose);
      final box = NewHarnessController(app, machineId: 'dee', engine: 'codex');
      addTearDown(box.dispose);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid
              .buildAppTheme(brightness: Brightness.dark)
              .copyWith(platform: TargetPlatform.macOS),
          home: Scaffold(
            body: NewHarnessForm(
              controller: box,
              desktop: true,
              onClose: () {},
              onCreated: () => fail('A guest fixture starts nothing'),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();

      expect(box.engine, 'codex');
      expect(
        find.byKey(const ValueKey('new-harness-field-approvals')),
        findsOneWidget,
      );
      // Each opened an empty menu on a shared machine ("No matches").
      expect(
        find.byKey(const ValueKey('new-harness-field-model')),
        findsNothing,
      );
      expect(
        find.byKey(const ValueKey('new-harness-field-profile')),
        findsNothing,
      );
    },
  );

  test('a guest picks among the folders the owner shares, which the daemon starts it in', () async {
    final app = _GuestApp()
      ..places = const GuestFolders(
        workspace: '/Users/Shared/HarnessGuests/hg_0/work',
        folders: [
          GuestFolder(path: '/Users/dee/code/app', write: true),
          GuestFolder(path: '/Users/dee/docs', write: false),
        ],
      );
    addTearDown(app.dispose);
    final box = NewHarnessController(app, machineId: 'dee', engine: 'codex');
    addTearDown(box.dispose);
    await pumpEventQueue();
    expect(box.fields, contains(NewHarnessField.projectMenu));
    expect(box.projectLabel, 'My workspace');
    box.focusField(NewHarnessField.projectMenu);
    expect(box.options.map((option) => (option.title, option.detail)), [
      ('My workspace', 'Your own folder on Dee’s Studio'),
      ('app', '/Users/dee/code/app · you can edit it'),
      ('docs', '/Users/dee/docs · read only'),
    ]);
    box.accept(box.options[2]);
    expect(box.projectLabel, '/Users/dee/docs');
    final outcome = await box.create();
    expect(box.error, isNull);
    expect(outcome, isNot(NewHarnessOutcome.failed));
    expect(app.launches.single['folder'], '/Users/dee/docs');
    expect(app.launches.single['projectFolder'], isNull);
    expect(app.refusedAsks, isEmpty);
  });

  test(
    'an agent a guest cannot start there gives way to Claude Code',
    () async {
      for (final (engine, harness) in [
        ('opencode', null),
        ('claude', 'autonomous/blender'),
      ]) {
        final app = _GuestApp();
        addTearDown(app.dispose);
        final box = NewHarnessController(
          app,
          machineId: 'dee',
          engine: engine,
          harnessId: harness,
        );
        addTearDown(box.dispose);
        await pumpEventQueue();
        expect(box.engine, 'claude', reason: '$engine $harness');
        // Codex there runs on the owner's subscription: no profile to choose.
        box.focusField(NewHarnessField.harness);
        box.accept(box.options.firstWhere((option) => option.id == 'codex'));
        expect(box.engine, 'codex');
        expect(box.usesProfile, isFalse);
        expect(box.hasProfile, isFalse);
        expect(box.fields, isNot(contains(NewHarnessField.profile)));
        expect(box.harnessId, isNull);
        expect(box.requiredChoice, isNull);
      }
    },
  );

  test('the app says in words what a guest cannot do to its harness', () {
    for (final code in ['GUEST_NOT_ALLOWED', 'GUEST_HARNESS']) {
      expect(
        retargetRefusalMessage(code, engineLabel: 'Claude Code'),
        'On a computer shared with you, a harness keeps the model it started with. Start a new one to use another.',
      );
    }
  });

  test('a guest\'s harness is never resumed, restarted, forked or moved to another agent', () async {
    final app = _GuestApp();
    addTearDown(app.dispose);
    app.machineStates['dee']!.agents.add(
      Agent.fromJson({
        'id': 'mine',
        'name': 'Mine',
        'engine': 'claude',
        'status': 'stopped',
        'createdAt': '2026-10-19T00:00:00.000Z',
      }),
    );
    final resumed = await app.resumeAgent('dee', 'mine');
    expect(resumed.error, contains('Start a new one'));
    expect(resumed.retryable, isFalse);
    expect(
      await app.changeAgent('dee', 'mine', 'codex'),
      'On a computer shared with you, a harness keeps the agent it started with. Start a new one.',
    );
  });
}
