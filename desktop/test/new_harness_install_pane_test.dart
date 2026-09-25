// New Harness lists every harness the machine's catalog has — recent ones,
// then coding agents, then installed, then the rest of the Store — opens on the last
// harness and agent used, and installs a missing harness on the way to
// starting, narrating that install in the right pane on the form's grid.
import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/dsh_catalog.dart';
import 'package:harness/core/engine_availability.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/project_folder.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/state/pane_arrangement.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/shortcuts/keymap_host.dart';

import 'keymap_host_test.dart' show MemoryKeymap, key;

DshEntry _entry(String id, String name, {required bool installed}) => DshEntry(
  id: id,
  name: name,
  engine: 'claude',
  engines: const ['claude', 'codex'],
  description: '$name, as its manifest says',
  installed: installed,
);

final _blender = _entry(
  'autonomous/autonomous-blender',
  'Autonomous Blender',
  installed: true,
);
final _circuit = _entry(
  'autonomous/autonomous-circuit',
  'Autonomous Circuit',
  installed: false,
);
final _workshop = _entry(
  'autonomous/autonomous-workshop',
  'Autonomous Workshop',
  installed: true,
);
final _solid = _entry(
  'autonomous/autonomous-solid',
  'Autonomous Solid',
  installed: false,
);

class _Notifier extends AppNotifier {
  _Notifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );

  final installs = <String>[];
  final launches = <Map<String, Object?>>[];
  Completer<String?>? pendingInstall;

  /// The folder is not a Git checkout, so start has no branch to wait on.
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

  /// The machine's side of an install: a fresh run, then whatever the test
  /// narrates through [narrate], then [pendingInstall]'s answer.
  @override
  Future<String?> installDsh(String machineId, String id) async {
    installs.add(id);
    final machine = machineStates[machineId]!;
    machine.dsh.runs.remove(id);
    machine.dsh.applyInstall(DshInstallProgress(id: id, phase: 'clone'));
    notifyListeners();
    final error = await (pendingInstall?.future ?? Future.value(null));
    if (error == null) {
      if (machine.dsh.runs[id]?.done != true) {
        machine.dsh.applyInstall(DshInstallProgress(id: id, phase: 'done'));
      }
      machine.dsh.replace([
        for (final entry in machine.dsh.entries)
          entry.id == id
              ? _entry(entry.id, entry.name, installed: true)
              : entry,
      ]);
    } else {
      // As the app closes a run the machine already failed: keep its phases.
      machine.dsh.failInstall(id, error);
    }
    notifyListeners();
    return error;
  }

  void narrate(
    String id,
    String phase, {
    String? line,
    String? code,
    DateTime? at,
  }) {
    machineStates['machine-1']!.dsh.applyInstall(
      DshInstallProgress(id: id, phase: phase, line: line, code: code),
      now: at,
    );
    notifyListeners();
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
    launches.add({'engine': engine, 'dsh': dsh});
    return 'Test launch refused.';
  }
}

const _machine = Machine(
  machineId: 'machine-1',
  authMode: MachineAuthMode.remote,
  name: 'harness-remote-box',
);

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  Future<_Notifier> app({
    bool loaded = true,
    List<DshEntry>? catalog,
    Future<void> Function(_Notifier)? remember,
  }) async {
    final notifier = _Notifier();
    addTearDown(notifier.dispose);
    final state = MachineState(_machine)..localOnly = true;
    state.engines.replace(const [
      EngineAvailability(engine: 'claude', installed: true),
      EngineAvailability(engine: 'codex', installed: true),
    ]);
    if (loaded) {
      state.dsh.replace(catalog ?? [_blender, _circuit, _workshop, _solid]);
    }
    notifier.machineStates['machine-1'] = state;
    await remember?.call(notifier);
    return notifier;
  }

  NewHarnessController controller(_Notifier notifier, {String? harnessId}) {
    final box = NewHarnessController(
      notifier,
      machineId: 'machine-1',
      folder: '/work/air-monitor',
      harnessId: harnessId,
    );
    addTearDown(box.dispose);
    return box;
  }

  Future<NewHarnessController> mount(
    WidgetTester tester,
    _Notifier notifier, {
    double width = 900,
  }) async {
    final box = controller(notifier);
    final keymap = MemoryKeymap();
    await tester.pumpWidget(
      MaterialApp(
        theme: ThemeData.dark(),
        home: KeymapProvider(
          keymap: keymap,
          child: KeymapHost(
            keymap: keymap,
            enabled: () => true,
            actions: const {},
            child: Scaffold(
              body: Center(
                child: SizedBox(
                  width: width,
                  height: 520,
                  child: NewHarnessForm(
                    controller: box,
                    onClose: () {},
                    onCreated: () {},
                  ),
                ),
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return box;
  }

  List<String> harnessList(NewHarnessController box) {
    box.focusField(NewHarnessField.harness);
    return [for (final option in box.options) option.id];
  }

  group('the harness list', () {
    test(
      'recent harnesses, then coding agents, then installed, then the Store',
      () async {
        final notifier = await app(
          remember: (n) async {
            await n.agentPreference.remember('claude', harnessId: _solid.id);
            await n.agentPreference.remember('codex', harnessId: _workshop.id);
          },
        );
        final ids = harnessList(controller(notifier));
        expect(ids.where(_isHarnessRow).toList(), [
          _workshop.id, // most recent first
          _solid.id, // recent, though not installed
          _blender.id, // installed
          _circuit.id, // the rest of the Store
        ]);
      },
    );

    test(
      'with no history, Claude Code leads and every harness is listed',
      () async {
        final ids = harnessList(controller(await app()));
        expect(ids.first, 'claude');
        expect(
          ids,
          containsAllInOrder([
            _blender.id,
            _workshop.id,
            _circuit.id,
            _solid.id,
          ]),
          reason: 'installed before not installed, catalog order within each',
        );
      },
    );

    test('a harness that is not installed is searchable and says so', () async {
      final box = controller(await app());
      box.focusField(NewHarnessField.harness);
      box.setQuery('circuit');
      expect(box.options.first.id, _circuit.id);
      expect(box.options.first.detail, contains('installs first'));
    });

    test('a recent harness is listed once, not again among the rest', () async {
      final notifier = await app(
        remember: (n) =>
            n.agentPreference.remember('claude', harnessId: _blender.id),
      );
      final ids = harnessList(controller(notifier));
      expect(ids.where((id) => id == _blender.id), hasLength(1));
      expect(ids.first, _blender.id);
    });
  });

  group('what the form opens on', () {
    test('Code and Claude Code when nothing was used before', () async {
      final box = controller(await app());
      await Future<void>.delayed(Duration.zero);
      expect(box.harnessId, isNull);
      expect(box.harnessLabel, 'Code');
      expect(box.engine, 'claude');
    });

    test('the last harness, with the agent last used on it', () async {
      final notifier = await app(
        remember: (n) async {
          await n.agentPreference.remember('codex', harnessId: _blender.id);
        },
      );
      final box = controller(notifier);
      await Future<void>.delayed(Duration.zero);
      expect(box.harnessId, _blender.id);
      expect(box.engine, 'codex');
    });
  });

  group('edge cases', () {
    const gone = 'autonomous/autonomous-retired';
    const viewer = DshEntry(
      id: 'autonomous/autonomous-viewer',
      name: 'Autonomous Viewer',
      engine: 'claude',
      kind: 'viewer',
      installed: true,
    );

    test('a remembered harness the Store dropped opens as Code', () async {
      final notifier = await app(
        remember: (n) => n.agentPreference.remember('codex', harnessId: gone),
      );
      final box = controller(notifier);
      await Future<void>.delayed(Duration.zero);
      expect(box.harnessId, isNull);
      expect(box.harnessLabel, 'Code');
      expect(
        box.engine,
        'codex',
        reason: 'Code keeps the agent last used, which Code can run',
      );
      expect(harnessList(box), isNot(contains(gone)));
    });

    test('a remembered viewer package opens as Code too', () async {
      final notifier = await app(
        catalog: [_blender, viewer],
        remember: (n) =>
            n.agentPreference.remember('claude', harnessId: viewer.id),
      );
      final box = controller(notifier);
      await Future<void>.delayed(Duration.zero);
      expect(box.harnessId, isNull);
      expect(harnessList(box), isNot(contains(viewer.id)));
    });

    test('before the catalog answers, recents are kept as they are', () async {
      final notifier = await app(
        loaded: false,
        remember: (n) => n.agentPreference.remember('claude', harnessId: gone),
      );
      final box = controller(notifier);
      await Future<void>.delayed(Duration.zero);
      expect(box.harnessId, gone, reason: 'nothing says it is gone yet');
      final ids = harnessList(box);
      expect(ids.first, gone);
      expect(ids[1], 'claude');
    });

    test(
      'a harness asked for by name keeps its row even if unlisted',
      () async {
        final box = controller(await app(), harnessId: gone);
        await Future<void>.delayed(Duration.zero);
        expect(box.harnessId, gone);
        expect(harnessList(box), contains(gone));
      },
    );

    test('a remembered agent the harness cannot run falls back', () async {
      final only = DshEntry(
        id: _blender.id,
        name: _blender.name,
        engine: 'claude',
        engines: const ['claude'],
        installed: true,
      );
      final notifier = await app(
        catalog: [only],
        remember: (n) async {
          // Codex was remembered for it before the harness narrowed.
          await n.agentPreference.remember('codex', harnessId: only.id);
        },
      );
      final box = controller(notifier);
      await Future<void>.delayed(Duration.zero);
      expect(box.harnessId, only.id);
      expect(box.engine, 'claude');
    });
  });

  group('installing on the way to start', () {
    testWidgets('the right pane narrates the machine, step by step', (
      tester,
    ) async {
      final notifier = await app();
      notifier.pendingInstall = Completer<String?>();
      final box = await mount(tester, notifier);
      box.focusField(NewHarnessField.harness);
      box.applyOption(box.options.firstWhere((o) => o.id == _circuit.id));
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter, shift: true);
      await tester.pump();

      expect(notifier.installs, [_circuit.id]);
      final pane = find.byKey(const ValueKey('new-harness-install'));
      expect(pane, findsOneWidget);
      expect(
        find.descendant(
          of: pane,
          matching: find.text(
            'Installing Autonomous Circuit on harness-remote-box',
          ),
        ),
        findsOneWidget,
      );
      expect(find.text('Fetch Autonomous Circuit'), findsOneWidget);
      expect(find.text('>'), findsWidgets, reason: 'fetch is the live step');

      final fetching = box.installRun!.phases.first.at;
      notifier.narrate(
        _circuit.id,
        'setup',
        line: 'npm ci --silent',
        at: fetching.add(const Duration(seconds: 75)),
      );
      await tester.pump(const Duration(milliseconds: 150));
      expect(find.text('✓'), findsOneWidget, reason: 'fetch is done');
      expect(find.text('1:15'), findsOneWidget, reason: 'what fetch took');
      expect(
        find.descendant(of: pane, matching: find.text('npm ci --silent')),
        findsWidgets,
        reason: 'the line the machine is on, under the live step',
      );

      for (var i = 1; i <= 8; i++) {
        notifier.narrate(_circuit.id, 'setup', line: 'added package $i');
      }
      await tester.pump(const Duration(milliseconds: 150));
      expect(find.text('added package 2'), findsNothing);
      expect(
        find.text('added package 3'),
        findsOneWidget,
        reason: 'the last six lines of the log, no more',
      );

      notifier.narrate(_circuit.id, 'done');
      await tester.pump(const Duration(milliseconds: 150));
      expect(
        find.text('Autonomous Circuit installed on harness-remote-box'),
        findsOneWidget,
      );
      expect(find.text('Starting the harness…'), findsOneWidget);
      expect(find.text('✓'), findsNWidgets(3));

      notifier.pendingInstall!.complete(null);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 150));
      expect(notifier.launches.single['dsh'], _circuit.id);
      expect(
        find.byKey(const ValueKey('new-harness-install')),
        findsNothing,
        reason: 'once installed, the pane goes back to its choices',
      );
      expect(tester.takeException(), isNull);
    });

    testWidgets('a failed install stays on screen, with how to retry', (
      tester,
    ) async {
      final notifier = await app();
      notifier.pendingInstall = Completer<String?>();
      final box = await mount(tester, notifier, width: 500);
      box.focusField(NewHarnessField.harness);
      box.applyOption(box.options.firstWhere((o) => o.id == _circuit.id));
      await tester.pump();
      await key(tester, LogicalKeyboardKey.enter, shift: true);
      await tester.pump();
      notifier.narrate(_circuit.id, 'setup', line: 'npm ci');
      notifier.narrate(_circuit.id, 'failed', code: 'DSH_BUSY');
      notifier.pendingInstall!.complete('another install holds the lock');
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 150));

      expect(notifier.launches, isEmpty);
      final pane = find.byKey(const ValueKey('new-harness-install'));
      expect(pane, findsOneWidget, reason: 'compact windows show it too');
      expect(
        find.text('Autonomous Circuit did not install on harness-remote-box'),
        findsOneWidget,
      );
      expect(find.text('✗'), findsOneWidget);
      expect(
        find.text('Already installing Autonomous Circuit on this machine.'),
        findsOneWidget,
      );
      expect(find.text('another install holds the lock'), findsOneWidget);
      expect(find.text('Wait for it to finish.'), findsOneWidget);
      expect(find.textContaining('tries again'), findsOneWidget);
      expect(
        find.byKey(const ValueKey('new-harness-status')),
        findsNothing,
        reason: 'the pane says it; the status line would say it twice',
      );

      box.focusField(NewHarnessField.harness);
      box.applyOption(box.options.firstWhere((o) => o.id == 'claude'));
      await tester.pump();
      expect(box.installRun, isNull, reason: 'another choice clears it');
      expect(tester.takeException(), isNull);
    });

    testWidgets('an installed harness starts without the pane', (tester) async {
      final notifier = await app(
        remember: (n) =>
            n.agentPreference.remember('claude', harnessId: _blender.id),
      );
      await mount(tester, notifier);
      await key(tester, LogicalKeyboardKey.enter, shift: true);
      await tester.pump();
      expect(notifier.installs, isEmpty);
      expect(find.byKey(const ValueKey('new-harness-install')), findsNothing);
      expect(notifier.launches.single['dsh'], _blender.id);
    });
  });
}

/// A harness row, as opposed to a door such as the Store's.
bool _isHarnessRow(String id) =>
    id.contains('/') || id == NewHarnessController.codingId;
