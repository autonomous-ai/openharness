// New Harness with files: the task waits for them, and the files still follow
// a harness whose box closed while it was being created.
import 'dart:typed_data';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';

class _Notifier extends AppNotifier {
  _Notifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final prompts = <String?>[];

  /// Runs while the machine is creating, the way a new pane replacing the
  /// start page disposes its box.
  void Function()? duringCreate;

  @override
  Future<Map<String, dynamic>> readGitProject(
    String machineId,
    String path, {
    bool refresh = false,
  }) async => {'isGit': false};

  @override
  Future<void> probeEngines(String machineId, {bool force = false}) async {}

  @override
  Future<void> probeDsh(String machineId, {bool force = false}) async {}

  @override
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async => {'profiles': <dynamic>[]};

  @override
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String? folder,
    bool bypassPermission = false,
    String? permissionMode,
    String? codexHome,
    String? dsh,
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
    prompts.add(prompt);
    duringCreate?.call();
    return null;
  }
}

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  _Notifier app({bool canPasteFiles = true}) {
    final notifier = _Notifier();
    addTearDown(notifier.dispose);
    notifier.machineStates['box'] =
        MachineState(
            const Machine(
              machineId: 'box',
              name: 'Box',
              authMode: MachineAuthMode.remote,
            ),
          )
          ..localOnly = true
          ..terminalPasteFileAvailable = canPasteFiles
          ..terminalPasteRawAvailable = true;
    notifier.machineStates['box']!.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: true),
    ]);
    return notifier;
  }

  test('a box closed mid-create still hands its files on', () async {
    final notifier = app();
    final problems = <String>[];
    final files = HarnessAttachments(onDeliveryProblem: problems.add)
      ..add([HarnessAttachment('shot.png', Uint8List(4))]);
    final box = NewHarnessController(
      notifier,
      machineId: 'box',
      engine: 'claude',
      folder: '/work/desk',
      task: 'đọc ảnh',
      attachments: files,
    );
    notifier.duringCreate = box.dispose;
    await box.create();
    // The task waits for the files instead of launching with the engine.
    expect(notifier.prompts, [null]);
    // Past the disposed box, the files step ran: this fake reports no agent
    // id, which is the one outcome a test can see without a machine.
    expect(problems.single, contains('without its files'));
  });

  test('without files the task still launches with the engine', () async {
    final notifier = app();
    final box = NewHarnessController(
      notifier,
      machineId: 'box',
      engine: 'claude',
      folder: '/work/desk',
      task: 'đọc ảnh',
      attachments: HarnessAttachments(),
    );
    addTearDown(box.dispose);
    await box.create();
    expect(notifier.prompts, ['đọc ảnh']);
  });

  test('a machine that cannot paste files refuses before creating', () async {
    final notifier = app(canPasteFiles: false);
    final box = NewHarnessController(
      notifier,
      machineId: 'box',
      engine: 'claude',
      folder: '/work/desk',
      task: 'đọc ảnh',
      attachments: HarnessAttachments()
        ..add([HarnessAttachment('shot.png', Uint8List(4))]),
    );
    addTearDown(box.dispose);
    await box.create();
    expect(notifier.prompts, isEmpty);
    expect(box.error, contains('to attach files'));
  });
}
