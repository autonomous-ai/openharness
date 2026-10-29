import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/state/harness_attachments.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/state/harness_launch_integration.dart';
import 'package:harness/state/lead_placement.dart';
import 'package:harness/state/new_harness.dart';
import 'package:harness/super_tabs/project_visibility.dart';
import 'package:harness/widgets/new_harness_form.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture;

final _visibility = find.byKey(
  const ValueKey('new-harness-project-visibility'),
);
final _start = find.byKey(const ValueKey('new-harness-field-start'));
final _composer = find.byKey(const ValueKey('new-harness-composer'));

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();
  final capture = Platform.environment['HARNESS_SWARM_FORM_CAPTURE'];
  final previousShadows = debugDisableShadows;
  setUpAll(() async {
    if (capture == null || !Platform.isMacOS) return;
    final bytes = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(bytes))).load();
    }
    await (FontLoader('packages/lucide_icons_flutter/Lucide400')..addFont(
          rootBundle.load(
            'packages/lucide_icons_flutter/assets/build_font/LucideVariable-w400.ttf',
          ),
        ))
        .load();
  });
  tearDownAll(() => debugDisableShadows = previousShadows);

  Future<(NewHarnessController, GlobalKey)> mount(
    WidgetTester tester, {
    Brightness brightness = Brightness.dark,
    double width = 760,
    double textScale = 1,
    bool attachments = true,
    bool visibilityLocked = false,
    bool otherRequest = false,
    List<LeadMachine>? leadMachines,
    LeadModelList? leadModels,
    void Function(SuperTabLaunchFixture f)? setup,
  }) async {
    final oldBrightness = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = oldBrightness);
    debugDefaultTargetPlatformOverride = TargetPlatform.macOS;
    addTearDown(() => debugDefaultTargetPlatformOverride = null);
    if (capture != null) debugDisableShadows = false;
    addTearDown(() => debugDisableShadows = previousShadows);
    tester.view.physicalSize = Size(width, 600);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.resetPhysicalSize);
    addTearDown(tester.view.resetDevicePixelRatio);
    final f = SuperTabLaunchFixture();
    setup?.call(f);
    final files = attachments ? HarnessAttachments() : null;
    final box = NewHarnessController(
      f.app,
      machineId: 'm',
      engine: 'codex',
      folder: '/work/lamp-os',
      attachments: files,
      integration:
          HarnessLaunchIntegration(
              creationId: 'swarm-form-fixture',
              actionLabel: 'New Project',
              projectVisibility: 'public',
              projectVisibilityLocked: visibilityLocked,
              prepare: (_, task, _) async => task,
              beforeSubmit: (_, _) async {},
              complete: (_, _) async {},
            )
            ..leadMachines = leadMachines
            ..leadModels = leadModels,
    )..linkingProfile = otherRequest;
    addTearDown(box.dispose);
    final boundary = GlobalKey();
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context)
                .copyWith(textScaler: TextScaler.linear(textScale)),
            child: child!,
          ),
          home: Scaffold(
            body: NewHarnessForm(
              controller: box,
              desktop: true,
              embedded: true,
              onClose: () {},
              onCreated: () {},
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (box, boundary);
  }

  Future<void> unmount(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    debugDefaultTargetPlatformOverride = null;
    debugDisableShadows = previousShadows;
  }

  Future<void> shot(
    WidgetTester tester,
    GlobalKey boundary,
    String name,
  ) async {
    if (capture == null) return;
    await tester.runAsync(
      () => precacheImage(
        const AssetImage('assets/engine-icons/codex.png'),
        tester.element(find.byType(NewHarnessForm)),
      ),
    );
    await tester.pump();
    await tester.runAsync(() async {
      final render =
          boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary;
      final image = await render.toImage(pixelRatio: 1.5);
      final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
      await Directory(capture).create(recursive: true);
      await File('$capture/$name.png')
          .writeAsBytes(bytes!.buffer.asUint8List());
      image.dispose();
    });
  }

  for (final brightness in Brightness.values) {
    testWidgets(
      'New Project keeps visibility beside its action in ${brightness.name}',
      (tester) async {
        final (box, boundary) = await mount(tester, brightness: brightness);
        expect(
          find.descendant(of: _composer, matching: _visibility),
          findsOneWidget,
        );
        expect(
          tester.getRect(_visibility).right,
          lessThan(tester.getRect(_start).left),
        );
        expect(
          tester.getCenter(_visibility).dy,
          closeTo(tester.getCenter(_start).dy, 1),
        );
        expect(find.text('New Project'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('new-harness-attach')),
          findsOneWidget,
        );
        await shot(tester, boundary, 'new-project-${brightness.name}');
        await tester.tap(find.text('Public'));
        await tester.pumpAndSettle();
        expect(find.byType(AppMenuItem), findsNWidgets(2));
        expect(find.text('Everyone in this swarm'), findsOneWidget);
        expect(
          find.text('Only people you invite to this project'),
          findsOneWidget,
        );
        expect(find.byIcon(AppIcons.check), findsOneWidget);
        final publicRow = find.widgetWithText(AppMenuItem, 'Public');
        expect(
          tester.getRect(find.byIcon(AppIcons.check)).right,
          greaterThan(tester.getRect(publicRow).right - 24),
        );
        await shot(
          tester,
          boundary,
          'new-project-${brightness.name}-visibility',
        );
        await tester.tap(find.text('Private'));
        await tester.pumpAndSettle();
        expect(box.integration!.projectVisibility, 'private');
        expect(find.byType(AppMenuItem), findsNothing);
        expect(find.text('Private'), findsOneWidget);
        expect(tester.takeException(), isNull);
        await unmount(tester);
      },
    );
  }

  testWidgets(
    'Visibility works without attachments and has keyboard focus continuity',
    (tester) async {
      final (box, _) = await mount(tester, attachments: false);
      await tester.tap(find.text('Public'));
      await tester.pumpAndSettle();
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      expect(find.byType(AppMenuItem), findsNothing);
      final trigger = find.descendant(
        of: _visibility,
        matching: find.byType(TextButton),
      );
      expect(tester.widget<TextButton>(trigger).focusNode!.hasFocus, isTrue);
      await tester.sendKeyEvent(LogicalKeyboardKey.arrowDown);
      await tester.pumpAndSettle();
      expect(find.byType(AppMenuItem), findsNWidgets(2));
      await tester.tap(find.text('Private'));
      await tester.pumpAndSettle();
      expect(box.integration!.projectVisibility, 'private');
      await unmount(tester);
    },
  );

  for (final otherRequest in [false, true]) {
    testWidgets(
      'Locked visibility explains its ${otherRequest ? 'current' : 'creation'} request',
      (tester) async {
        await mount(
          tester,
          visibilityLocked: !otherRequest,
          otherRequest: otherRequest,
        );
        final visibility = tester.widget<ProjectVisibility>(_visibility);
        expect(visibility.onChanged, isNull);
        expect(
          find.byTooltip(
            otherRequest
                ? 'Finish the current request before changing visibility.'
                : 'Project creation has started. Visibility is fixed for this request.',
          ),
          findsOneWidget,
        );
        await tester.tap(find.text('Public'));
        await tester.pumpAndSettle();
        expect(find.byType(AppMenuItem), findsNothing);
        await unmount(tester);
      },
    );
  }

  for (final brightness in Brightness.values) {
    testWidgets(
      'New Project remains usable at 2x text in a compact ${brightness.name} window',
      (tester) async {
        final (_, boundary) = await mount(
          tester,
          brightness: brightness,
          width: 420,
          textScale: 2,
        );
        expect(
          find.descendant(of: _composer, matching: _visibility),
          findsOneWidget,
        );
        expect(
          tester.getRect(_start).right,
          lessThanOrEqualTo(tester.getRect(_composer).right),
        );
        await shot(tester, boundary, 'new-project-${brightness.name}-compact');
        await tester.tap(find.text('Public'));
        await tester.pumpAndSettle();
        expect(find.byType(AppMenuItem), findsNWidgets(2));
        await unmount(tester);
      },
    );
  }

  const studio = LeadMachine(
    id: 'm',
    name: 'Mac Studio',
    online: true,
    freeAgents: 9,
    repositories: {'github.com/autonomous-ai/autonomous-os'},
  );
  const rig = LeadMachine(
    id: 'rig',
    name: '2x 4090 Rig',
    online: true,
    freeAgents: 14,
    unavailable: 'Another person’s machine',
  );
  const laptop = LeadMachine(
    id: 'laptop',
    name: 'Ken MacBook',
    online: true,
    freeAgents: 2,
    maySleep: true,
  );
  void addLaptop(SuperTabLaunchFixture f) {
    const machine = Machine(
      machineId: 'laptop',
      authMode: MachineAuthMode.remote,
      name: 'Ken MacBook',
    );
    f.app.machines = [...f.app.machines, machine];
    f.app.machineStates['laptop'] = MachineState(machine)
      ..nodeOnline = true
      ..connectionStatus = ConnectionStatus.connected
      ..agentLoadStatus = AgentLoadStatus.loaded
      ..agents = [];
  }

  void agentIn(
    SuperTabLaunchFixture f, {
    String? model,
    String remote = 'git@github.com:autonomous-ai/lamp-os.git',
  }) => f.app.machineStates['m']!.agents = [
    Agent(
      id: 'earlier',
      name: 'Earlier',
      engine: 'codex',
      modelName: model,
      terminalAvailable: true,
      project: AgentProject(
        name: 'lamp-os',
        cwd: '/work/lamp-os',
        root: '/work/lamp-os',
        remote: remote,
      ),
    ),
  ];

  final leadLine = find.byKey(const ValueKey('new-harness-lead-line'));
  final change = find.byKey(const ValueKey('new-harness-lead-change'));

  for (final brightness in Brightness.values) {
    testWidgets(
      'New Project in a Swarm asks only task, repo and visibility in ${brightness.name}',
      (tester) async {
        final (box, boundary) = await mount(
          tester,
          brightness: brightness,
          leadMachines: [studio, rig],
        );
        expect(
          find.descendant(
            of: leadLine,
            matching: find.textContaining(
              'Product Manager on Mac Studio · ${box.agentLabel}',
            ),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: _composer, matching: leadLine),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: _composer,
            matching: find.byKey(const ValueKey('new-harness-field-project')),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: _composer, matching: _visibility),
          findsOneWidget,
        );
        for (final hidden in [
          'agent',
          'machine',
          'model',
          'worktree',
          'branch',
          'approvals',
          'profile',
        ]) {
          expect(
            find.byKey(ValueKey('new-harness-field-$hidden')),
            findsNothing,
            reason: hidden,
          );
        }
        expect(
          tester.getCenter(leadLine).dy,
          closeTo(tester.getCenter(_start).dy, 4),
        );
        await shot(tester, boundary, 'new-project-lead-${brightness.name}');

        await tester.tap(change);
        await tester.pumpAndSettle();
        final studioRow = find.byKey(
          const ValueKey('new-harness-lead-machine-m'),
        );
        final rigRow = find.byKey(
          const ValueKey('new-harness-lead-machine-rig'),
        );
        expect(studioRow, findsOneWidget);
        expect(rigRow, findsOneWidget);
        expect(
          find.descendant(
            of: studioRow,
            matching: find.text('Online · 9 agents free · Has repo'),
          ),
          findsNothing,
          reason: 'has repo is only known for a known repository',
        );
        expect(
          find.descendant(
            of: studioRow,
            matching: find.textContaining('Online · 9 agents free'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(of: studioRow, matching: find.byIcon(AppIcons.check)),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: rigRow,
            matching: find.text('Another person’s machine'),
          ),
          findsOneWidget,
        );
        expect(
          tester
              .widget<Semantics>(
                find
                    .descendant(of: rigRow, matching: find.byType(Semantics))
                    .first,
              )
              .properties
              .enabled,
          isFalse,
        );
        await shot(
          tester,
          boundary,
          'new-project-lead-${brightness.name}-change',
        );

        await tester.tap(
          find.byKey(const ValueKey('new-harness-lead-advanced')),
        );
        await tester.pumpAndSettle();
        expect(
          find.byKey(const ValueKey('new-harness-field-agent')),
          findsOneWidget,
        );
        expect(
          find.byKey(const ValueKey('new-harness-field-model')),
          findsOneWidget,
        );
        expect(find.text('Engine'), findsOneWidget);
        expect(find.text('Model'), findsOneWidget);
        expect(
          find.byKey(const ValueKey('new-harness-field-worktree')),
          findsNothing,
        );
        await shot(
          tester,
          boundary,
          'new-project-lead-${brightness.name}-advanced',
        );
        expect(tester.takeException(), isNull);
        await unmount(tester);
      },
    );
  }

  testWidgets('The Swarm places the Product Manager on the best machine', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      setup: addLaptop,
      leadMachines: rankLeadMachines([laptop, rig], null),
    );
    expect(box.machineId, 'laptop');
    expect(
      find.descendant(
        of: leadLine,
        matching: find.textContaining('Product Manager on Ken MacBook'),
      ),
      findsOneWidget,
    );
    await unmount(tester);
  });

  testWidgets('Choosing another of your machines moves the Product Manager', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      setup: addLaptop,
      leadMachines: [studio, laptop, rig],
    );
    expect(box.machineId, 'm');
    await tester.tap(change);
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('new-harness-lead-machine-rig')),
    );
    await tester.pumpAndSettle();
    expect(
      box.machineId,
      'm',
      reason: 'another person’s machine is not a choice',
    );
    await tester.tap(
      find.byKey(const ValueKey('new-harness-lead-machine-laptop')),
    );
    await tester.pumpAndSettle();
    expect(box.machineId, 'laptop');
    expect(
      find.descendant(
        of: leadLine,
        matching: find.textContaining('Product Manager on Ken MacBook'),
      ),
      findsOneWidget,
    );
    await unmount(tester);
  });

  const studioFull = LeadMachine(
    id: 'm',
    name: 'Mac Studio',
    online: true,
    freeAgents: 0,
  );
  const diegoTeam = LeadMachine(
    id: 'diego-mac',
    name: 'Diego MacBook',
    online: true,
    freeAgents: 3,
    own: false,
    native: false,
    team: true,
  );

  for (final brightness in Brightness.values) {
    testWidgets(
      'With no machine free New Project queues the PM in ${brightness.name}',
      (tester) async {
        final (box, boundary) = await mount(
          tester,
          brightness: brightness,
          leadMachines: [studioFull, rig],
          setup: agentIn,
        );
        expect(box.leadQueued, isTrue);
        expect(box.leadThroughSwarm, isTrue);
        expect(
          find.text(
            'All Swarm machines are busy. The project starts on the first one that frees up.',
          ),
          findsOneWidget,
        );
        box.setTask('Plan the launch');
        await tester.pump();
        expect(tester.widget<FilledButton>(_start).onPressed, isNotNull);
        await shot(
          tester,
          boundary,
          'new-project-lead-${brightness.name}-waiting',
        );
        await unmount(tester);
      },
    );
  }

  testWidgets('A queued PM needs a repo the Swarm can clone', (tester) async {
    final (box, _) = await mount(tester, leadMachines: [studioFull, rig]);
    expect(
      box.leadBlocked,
      'Choose a repo with a remote, so the Swarm can clone it for the Product Manager.',
    );
    expect(tester.widget<FilledButton>(_start).onPressed, isNull);
    await unmount(tester);
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'A teammate’s Team account takes the PM when yours are full in ${brightness.name}',
      (tester) async {
        final (box, boundary) = await mount(
          tester,
          brightness: brightness,
          leadMachines: [studioFull, diegoTeam],
          setup: agentIn,
        );
        expect(box.leadThroughSwarm, isTrue);
        expect(box.leadQueued, isFalse);
        expect(box.leadSwarmMachine, 'diego-mac');
        // The repo stays the one chosen on your machine; Diego's Mac clones it.
        expect(box.machineId, 'm');
        final line = find.descendant(of: leadLine, matching: find.byType(Text));
        expect(
          tester.widget<Text>(line.first).data,
          'Product Manager on Diego MacBook’s Team account · Codex · '
          'Default model',
        );
        expect(
          tester.widget<Text>(line.at(1)).data,
          'Clones lamp-os there first',
        );
        box.setTask('Plan the launch');
        await tester.pump();
        expect(tester.widget<FilledButton>(_start).onPressed, isNotNull);
        await tester.tap(change);
        await tester.pumpAndSettle();
        expect(
          find.descendant(
            of: find.byKey(
              const ValueKey('new-harness-lead-machine-diego-mac'),
            ),
            matching: find.byIcon(AppIcons.check),
          ),
          findsOneWidget,
        );
        await tester.tap(
          find.byKey(const ValueKey('new-harness-lead-advanced')),
        );
        await tester.pumpAndSettle();
        // Your machine's account and branches say nothing about Diego's Mac.
        expect(
          find.byKey(const ValueKey('new-harness-field-profile')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('new-harness-field-branch')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('new-harness-field-agent')),
          findsOneWidget,
        );
        await shot(
          tester,
          boundary,
          'new-project-lead-${brightness.name}-team',
        );
        await unmount(tester);
      },
    );
  }

  testWidgets('Choosing your machine again starts the PM here', (tester) async {
    final (box, _) = await mount(
      tester,
      leadMachines: [studio, diegoTeam],
      setup: agentIn,
    );
    expect(box.leadThroughSwarm, isFalse);
    await tester.tap(change);
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('new-harness-lead-machine-diego-mac')),
    );
    await tester.pumpAndSettle();
    expect(box.leadSwarmMachine, 'diego-mac');
    await tester.tap(find.byKey(const ValueKey('new-harness-lead-machine-m')));
    await tester.pumpAndSettle();
    expect(box.leadThroughSwarm, isFalse);
    expect(box.leadSwarmMachine, isNull);
    expect(box.machineId, 'm');
    await unmount(tester);
  });

  testWidgets(
    'The Product Manager line stays usable at 2x text in a compact window',
    (tester) async {
      final (_, boundary) = await mount(
        tester,
        width: 420,
        textScale: 2,
        leadMachines: [studio, rig],
      );
      expect(tester.takeException(), isNull);
      expect(
        tester.getRect(_start).right,
        lessThanOrEqualTo(tester.getRect(_composer).right),
      );
      expect(
        tester.getRect(_visibility).right,
        lessThanOrEqualTo(tester.getRect(_composer).right),
      );
      // Too narrow to share a line: the Product Manager line gets its own.
      expect(
        tester.getRect(leadLine).bottom,
        lessThanOrEqualTo(tester.getRect(_start).top),
      );
      expect(
        tester.getSize(leadLine).width,
        greaterThan(tester.getSize(_composer).width / 2),
      );
      await tester.tap(change);
      await tester.pumpAndSettle();
      expect(tester.takeException(), isNull);
      await shot(tester, boundary, 'new-project-lead-compact');
      await unmount(tester);
    },
  );

  testWidgets('The line never guesses the model from other agents', (
    tester,
  ) async {
    await mount(
      tester,
      leadMachines: [studio],
      setup: (f) => agentIn(f, model: 'GPT-5.5'),
    );
    final line = find.descendant(of: leadLine, matching: find.byType(Text));
    expect(
      tester.widget<Text>(line.first).data,
      'Product Manager on Mac Studio · Codex · Default model',
    );
    await unmount(tester);
  });

  testWidgets('A saved “no worktree” still gives the PM its own worktree', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      leadMachines: [studio],
      setup: (f) {
        f.app.agentPreference.successfulWorktree = false;
        f.app.gitProjectReaderForTest = (_, _) async => {
          'isGit': true,
          'branch': 'main',
          'branches': [
            {'ref': 'refs/heads/main', 'name': 'main'},
          ],
        };
      },
    );
    await tester.pumpAndSettle();
    expect(box.isGitProject, isTrue);
    expect(box.worktree, isTrue);
    // Forced for the PM, so not saved over the person's own setting.
    expect(box.worktreeToRemember, isNull);
    await unmount(tester);
  });

  testWidgets('An ordinary launch still saves its worktree setting', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      setup: (f) => f.app.gitProjectReaderForTest = (_, _) async => {
        'isGit': true,
        'branch': 'main',
        'branches': [
          {'ref': 'refs/heads/main', 'name': 'main'},
        ],
      },
    );
    await tester.pumpAndSettle();
    expect(box.placesLead, isFalse);
    expect(box.worktreeToRemember, box.worktree);
    box.toggleWorktree();
    expect(box.worktreeToRemember, box.worktree);
    await unmount(tester);
  });

  testWidgets('Moving the PM reads the new machine’s branches', (tester) async {
    final reads = <(String, String)>[];
    final (box, _) = await mount(
      tester,
      setup: (f) {
        addLaptop(f);
        agentIn(f);
        f.app.gitProjectReaderForTest = (machine, folder) async {
          reads.add((machine, folder));
          return {
            'isGit': true,
            'branch': 'main',
            'branches': [
              {'ref': 'refs/heads/main', 'name': 'main'},
              {'ref': 'refs/heads/$machine-only', 'name': '$machine-only'},
            ],
          };
        };
      },
      leadMachines: [
        studio,
        const LeadMachine(
          id: 'laptop',
          name: 'Ken MacBook',
          online: true,
          freeAgents: 2,
          maySleep: true,
          folders: {
            'github.com/autonomous-ai/lamp-os': '/Users/ken/swarm/lamp-os',
          },
        ),
      ],
    );
    await tester.pumpAndSettle();
    box.focusField(NewHarnessField.branch);
    box.accept(box.options.firstWhere((o) => o.id == 'refs/heads/m-only'));
    expect(box.branchRef, 'refs/heads/m-only');
    await tester.tap(change);
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('new-harness-lead-machine-laptop')),
    );
    await tester.pumpAndSettle();
    expect(reads.last, ('laptop', '/Users/ken/swarm/lamp-os'));
    expect(box.branchRef, isNot('refs/heads/m-only'));
    // Start from offers that machine's branches, not the other one's.
    box.focusField(NewHarnessField.branch);
    await tester.pumpAndSettle();
    final offered = box.options.map((o) => o.id).toSet();
    expect(offered, contains('refs/heads/laptop-only'));
    expect(offered, isNot(contains('refs/heads/m-only')));
    await unmount(tester);
  });

  testWidgets('Moving the PM drops the old machine’s branch at once', (
    tester,
  ) async {
    final reads = <(String, String)>[];
    final (box, _) = await mount(
      tester,
      setup: (f) {
        addLaptop(f);
        agentIn(f);
        f.app.gitProjectReaderForTest = (machine, folder) async {
          reads.add((machine, folder));
          return {
            'isGit': true,
            'branch': 'main',
            'branches': [
              {'ref': 'refs/heads/main', 'name': 'main'},
              {'ref': 'refs/heads/$machine-only', 'name': '$machine-only'},
            ],
          };
        };
      },
      leadMachines: [
        studio,
        const LeadMachine(
          id: 'laptop',
          name: 'Ken MacBook',
          online: true,
          freeAgents: 2,
          folders: {
            'github.com/autonomous-ai/lamp-os': '/Users/ken/swarm/lamp-os',
          },
        ),
      ],
    );
    await tester.pumpAndSettle();
    box.focusField(NewHarnessField.branch);
    box.accept(box.options.firstWhere((o) => o.id == 'refs/heads/m-only'));
    final before = reads.length;
    // No frame and no refresh in between: the move itself re-reads Git.
    box.chooseLeadMachine('laptop');
    expect(box.branchRef, isNot('refs/heads/m-only'));
    expect(box.checkingGit, isTrue);
    await tester.pumpAndSettle();
    expect(reads.skip(before).first, ('laptop', '/Users/ken/swarm/lamp-os'));
    await unmount(tester);
  });

  testWidgets('Moving the PM drops a branch of the old machine, repo unknown', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      setup: (f) {
        addLaptop(f);
        f.app.gitProjectReaderForTest = (machine, folder) async => {
          'isGit': true,
          'branch': 'main',
          'branches': [
            {'ref': 'refs/heads/main', 'name': 'main'},
            {'ref': 'refs/heads/$machine-only', 'name': '$machine-only'},
          ],
        };
      },
      leadMachines: [studio, laptop],
    );
    await tester.pumpAndSettle();
    box.focusField(NewHarnessField.branch);
    box.accept(box.options.firstWhere((o) => o.id == 'refs/heads/m-only'));
    expect(box.branchRef, 'refs/heads/m-only');
    await tester.tap(change);
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('new-harness-lead-machine-laptop')),
    );
    await tester.pumpAndSettle();
    expect(box.machineId, 'laptop');
    expect(box.branchRef, isNot('refs/heads/m-only'));
    await unmount(tester);
  });

  testWidgets('The model list disables an engine it turns off, with why', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      leadMachines: [studio],
      leadModels: const LeadModelList(disabledEngines: {'codex'}),
    );
    box.focusField(NewHarnessField.agent);
    final codex = box.options.where((o) => o.id == 'codex').single;
    expect(codex.enabled, isFalse);
    expect(codex.why, 'The Swarm’s model list has no enabled Codex model.');
    expect(box.options.where((o) => o.id == 'claude').single.enabled, isTrue);
    await unmount(tester);
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'With no machine able to run a PM, the box says why and how to fix it '
      'in ${brightness.name}',
      (tester) async {
        const signedOut = LeadMachine(
          id: 'rig',
          name: '2x 4090 Rig',
          online: true,
          freeAgents: 16,
          engineRefusals: {
            'claude': 'Claude Code isn’t offered here',
            'codex': 'Codex isn’t signed in',
          },
        );
        const kens = LeadMachine(
          id: 'studio',
          name: 'Mac Studio',
          online: true,
          freeAgents: 20,
          own: false,
          unavailable:
              'ken15’s personal account: runs only ken15’s projects. Yours '
              'need your own computer or a Team account machine',
        );
        final (box, boundary) = await mount(
          tester,
          brightness: brightness,
          leadMachines: [signedOut, kens],
        );
        expect(box.leadNone, isTrue);
        expect(
          find.descendant(
            of: leadLine,
            matching: find.text('No machine can run the Product Manager now.'),
          ),
          findsOneWidget,
        );
        expect(tester.widget<FilledButton>(_start).onPressed, isNull);
        final action = find.descendant(
          of: change,
          matching: find.text('See why'),
        );
        expect(action, findsOneWidget);
        await shot(tester, boundary, 'new-project-none-${brightness.name}');
        await tester.tap(change);
        await tester.pumpAndSettle();
        const engines =
            'Can’t run a Product Manager: Claude Code isn’t offered here, '
            'Codex isn’t signed in';
        for (final (id, why) in [
          ('rig', engines),
          ('studio', kens.unavailable!),
        ]) {
          final row = find.byKey(ValueKey('new-harness-lead-machine-$id'));
          // Greyed out, and says why under its name and on hover.
          expect(
            find.descendant(of: row, matching: find.text(why)),
            findsOneWidget,
          );
          expect(
            find.descendant(of: row, matching: find.byTooltip(why)),
            findsOneWidget,
          );
          expect(
            tester
                .widget<Semantics>(
                  find
                      .descendant(of: row, matching: find.byType(Semantics))
                      .first,
                )
                .properties
                .enabled,
            isFalse,
          );
        }
        await shot(tester, boundary, 'new-project-none-${brightness.name}-why');
        expect(tester.takeException(), isNull);
        await unmount(tester);
      },
    );
  }

  testWidgets('The reasons and the clone note fit at 200% text, narrow', (
    tester,
  ) async {
    const signedOut = LeadMachine(
      id: 'rig',
      name: '2x 4090 Rig',
      online: true,
      freeAgents: 16,
      engineRefusals: {
        'claude': 'Claude Code isn’t offered here',
        'codex': 'Codex isn’t signed in',
      },
    );
    final (box, boundary) = await mount(
      tester,
      width: 520,
      textScale: 2,
      leadMachines: [signedOut],
    );
    expect(box.leadNone, isTrue);
    await tester.tap(change);
    await tester.pumpAndSettle();
    expect(tester.takeException(), isNull);
    await shot(tester, boundary, 'new-project-none-200');
    await unmount(tester);
    final (_, teamBoundary) = await mount(
      tester,
      width: 520,
      textScale: 2,
      leadMachines: [studioFull, diegoTeam],
      setup: agentIn,
    );
    expect(find.text('Clones lamp-os there first'), findsOneWidget);
    expect(tester.takeException(), isNull);
    await shot(tester, teamBoundary, 'new-project-team-200');
    await unmount(tester);
  });

  testWidgets('A paused Swarm gives the pause as the reason', (tester) async {
    final (_, _) = await mount(
      tester,
      leadMachines: [
        const LeadMachine(
          id: 'm',
          name: 'Mac Studio',
          online: true,
          freeAgents: 9,
          unavailable: kLeadSwarmPaused,
        ),
      ],
    );
    expect(
      find.text(
        'New work is paused in this Swarm. New Project can start once it resumes.',
      ),
      findsOneWidget,
    );
    expect(tester.widget<FilledButton>(_start).onPressed, isNull);
    await unmount(tester);
  });

  testWidgets('A ruled-out engine keeps New Project waiting with the rule', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      leadMachines: [studio],
      leadModels: const LeadModelList(disabledEngines: {'codex'}),
    );
    expect(box.engine, 'codex');
    expect(
      box.leadBlocked,
      'The Swarm’s model list has no enabled Codex model. Choose another engine under Advanced.',
    );
    expect(tester.widget<FilledButton>(_start).onPressed, isNull);
    await unmount(tester);
  });

  testWidgets('With no model reported the line says the default model', (
    tester,
  ) async {
    await mount(tester, leadMachines: [studio]);
    final line = find.descendant(of: leadLine, matching: find.byType(Text));
    expect(
      tester.widget<Text>(line.first).data,
      'Product Manager on Mac Studio · Codex · Default model',
    );
    await unmount(tester);
  });

  testWidgets('Switching machines keeps the repo, found by its remote', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      setup: (f) {
        addLaptop(f);
        agentIn(f);
      },
      leadMachines: [
        studio,
        const LeadMachine(
          id: 'laptop',
          name: 'Ken MacBook',
          online: true,
          freeAgents: 2,
          maySleep: true,
          repositories: {'github.com/autonomous-ai/lamp-os'},
          folders: {
            'github.com/autonomous-ai/lamp-os': '/Users/ken/swarm/lamp-os',
          },
        ),
      ],
    );
    expect(box.project.folder, '/work/lamp-os');
    await tester.tap(change);
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('new-harness-lead-machine-laptop')),
    );
    await tester.pumpAndSettle();
    expect(box.machineId, 'laptop');
    expect(box.project.folder, '/Users/ken/swarm/lamp-os');
    expect(find.textContaining('there first'), findsNothing);
    await unmount(tester);
  });

  testWidgets('A machine without the repo will clone it, and says so', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      setup: (f) {
        addLaptop(f);
        agentIn(f);
      },
      leadMachines: [studio, laptop],
    );
    await tester.tap(change);
    await tester.pumpAndSettle();
    await tester.tap(
      find.byKey(const ValueKey('new-harness-lead-machine-laptop')),
    );
    await tester.pumpAndSettle();
    expect(box.machineId, 'laptop');
    // Cloned by the address the person's own checkout uses.
    expect(
      box.project.repository?.url,
      'git@github.com:autonomous-ai/lamp-os.git',
    );
    expect(
      find.descendant(
        of: find.byKey(const ValueKey('new-harness-field-project')),
        matching: find.text('lamp-os'),
      ),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: leadLine,
        matching: find.text('Clones lamp-os there first'),
      ),
      findsOneWidget,
    );
    await unmount(tester);
  });

  testWidgets('The Product Manager always starts in its own worktree', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      leadMachines: [studio],
      setup: (f) => f.app.gitProjectReaderForTest = (_, _) async => {
        'isGit': true,
        'branch': 'main',
        'branches': [
          {'ref': 'refs/heads/main', 'name': 'main'},
        ],
      },
    );
    await tester.pumpAndSettle();
    expect(box.isGitProject, isTrue);
    box.toggleWorktree();
    expect(box.worktree, isTrue);
    await unmount(tester);
  });
}
