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
import 'package:harness/super_tabs/identity.dart' show SuperTabAvatar;
import 'package:harness/super_tabs/model.dart' show SuperTabPerson;
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
    // The machine its person chooses for the Product Manager, when the list
    // can start it there.
    String? lead = 'm',
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
    if (leadMachines?.any((m) => m.id == lead && m.startable) ?? false) {
      box.chooseLeadMachine(lead!);
      await tester.pumpAndSettle();
    }
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

  final machineChip = find.byKey(const ValueKey('new-harness-field-machine'));
  final blockedLine = find.byKey(const ValueKey('new-harness-lead-blocked'));
  Finder leadRow(String id) =>
      find.byKey(ValueKey('new-harness-lead-machine-$id'));
  Future<void> openMachines(WidgetTester tester) async {
    await tester.tap(machineChip);
    await tester.pumpAndSettle();
  }

  String? chipLabel(WidgetTester tester, String field) => tester
      .widget<Text>(
        find
            .descendant(
              of: find.byKey(ValueKey('new-harness-field-$field')),
              matching: find.byType(Text),
            )
            .first,
      )
      .data;
  bool rowEnabled(WidgetTester tester, String id) =>
      tester
          .widget<MenuItemButton>(
            find.descendant(
              of: leadRow(id),
              matching: find.byType(MenuItemButton),
            ),
          )
          .onPressed !=
      null;

  // Dee, 10-29: New Project is the New Harness form again, as before #2083:
  // the engine, machine and repo chips, the model under the box, visibility
  // beside New Project. No Product Manager sentence, no Change link.
  for (final brightness in Brightness.values) {
    testWidgets(
      'New Project is the New Harness form, on your last-used machine, in ${brightness.name}',
      (tester) async {
        final (box, boundary) = await mount(
          tester,
          brightness: brightness,
          leadMachines: [studio, rig],
          lead: null,
        );
        // Your last-used machine (the form's), chosen as New Harness does.
        expect(box.leadMachine?.id, 'm');
        for (final field in ['agent', 'machine', 'project']) {
          expect(
            find.byKey(ValueKey('new-harness-field-$field')),
            findsOneWidget,
            reason: field,
          );
          expect(
            find.descendant(
              of: _composer,
              matching: find.byKey(ValueKey('new-harness-field-$field')),
            ),
            findsNothing,
            reason: '$field sits in the top row, as in New Harness',
          );
        }
        expect(chipLabel(tester, 'machine'), 'Mac Studio');
        expect(chipLabel(tester, 'model'), 'Default model');
        expect(
          find.descendant(of: _composer, matching: _visibility),
          findsOneWidget,
        );
        expect(find.textContaining('Product Manager'), findsNothing);
        expect(
          find.byKey(const ValueKey('new-harness-lead-change')),
          findsNothing,
        );
        expect(blockedLine, findsNothing);
        // A Product Manager always gets its own worktree: no toggle.
        expect(
          find.byKey(const ValueKey('new-harness-field-worktree')),
          findsNothing,
        );
        await shot(tester, boundary, 'new-project-${brightness.name}-default');
        await openMachines(tester);
        expect(find.text('Your machines'), findsOneWidget);
        expect(
          find.descendant(
            of: leadRow('m'),
            matching: find.byIcon(AppIcons.check),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: leadRow('rig'),
            matching: find.text('unavailable'),
          ),
          findsOneWidget,
        );
        expect(rowEnabled(tester, 'rig'), isFalse);
        expect(find.text('Another person’s machine'), findsNothing);
        expect(tester.takeException(), isNull);
        await unmount(tester);
      },
    );
  }

  // A Swarm like Ken's: five machines of yours, two teammates' (Dee, 10-29:
  // each row its machine's own name, a teammate's wears their avatar, one
  // status word only when needed).
  final diego = SuperTabPerson.fromJson({
    'id': 'diego',
    'email': 'diego@example.com',
    'role': 'collaborator',
  });
  final tony = SuperTabPerson.fromJson({
    'id': 'tony',
    'email': 'tony@example.com',
    'role': 'collaborator',
  });
  final swarm = [
    studio,
    laptop,
    const LeadMachine(
      id: 'mini',
      name: 'Mac mini',
      online: false,
      freeAgents: 4,
    ),
    const LeadMachine(
      id: 'linux',
      name: 'Build box',
      online: true,
      freeAgents: 0,
    ),
    const LeadMachine(
      id: 'gpu',
      name: '2x 4090 Rig',
      online: true,
      freeAgents: 14,
    ),
    LeadMachine(
      id: 'diego-mac',
      name: 'Diego MacBook',
      online: true,
      freeAgents: 3,
      own: false,
      native: false,
      team: true,
      owner: diego,
    ),
    LeadMachine(
      id: 'tony-mini',
      name: 'Tony Mac mini',
      online: false,
      freeAgents: 4,
      own: false,
      native: false,
      owner: tony,
    ),
  ];

  for (final brightness in Brightness.values) {
    testWidgets(
      'The machine menu lists your machines, then team machines, by name, in ${brightness.name}',
      (tester) async {
        final (box, boundary) = await mount(
          tester,
          brightness: brightness,
          leadMachines: swarm,
          setup: addLaptop,
        );
        await openMachines(tester);
        final yours = tester.getTopLeft(find.text('Your machines')).dy;
        final team = tester.getTopLeft(find.text('Team machines')).dy;
        expect(yours, lessThan(team));
        for (final id in ['m', 'laptop', 'mini', 'linux', 'gpu']) {
          expect(
            tester.getTopLeft(leadRow(id)).dy,
            inExclusiveRange(yours, team),
            reason: id,
          );
        }
        for (final id in ['diego-mac', 'tony-mini']) {
          expect(
            tester.getTopLeft(leadRow(id)).dy,
            greaterThan(team),
            reason: id,
          );
        }
        // Each row is the machine's own name, and one word only when needed.
        final words = {
          'mini': 'offline',
          'linux': 'busy',
          'tony-mini': 'offline',
        };
        for (final machine in swarm) {
          // The avatar's initial is the avatar's, not the row's words.
          final avatar = tester
              .widgetList<Text>(
                find.descendant(
                  of: find.descendant(
                    of: leadRow(machine.id),
                    matching: find.byType(SuperTabAvatar),
                  ),
                  matching: find.byType(Text),
                ),
              )
              .toSet();
          final texts = tester
              .widgetList<Text>(
                find.descendant(
                  of: leadRow(machine.id),
                  matching: find.byType(Text),
                ),
              )
              .where((t) => !avatar.contains(t))
              .map((t) => t.data)
              .toList();
          expect(texts, [machine.name, ?words[machine.id]], reason: machine.id);
        }
        // A teammate's machine wears its owner's avatar.
        expect(
          find.descendant(
            of: leadRow('diego-mac'),
            matching: find.byType(SuperTabAvatar),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: leadRow('gpu'),
            matching: find.byType(SuperTabAvatar),
          ),
          findsNothing,
        );
        await shot(tester, boundary, 'new-project-${brightness.name}-machines');
        // An offline machine cannot be picked.
        expect(rowEnabled(tester, 'mini'), isFalse);
        await tester.tap(leadRow('mini'));
        await tester.pumpAndSettle();
        expect(box.leadMachine?.id, 'm');
        // A teammate's can, and the repo stays the one chosen here.
        await tester.tap(leadRow('diego-mac'));
        await tester.pumpAndSettle();
        expect(box.leadSwarmMachine, 'diego-mac');
        expect(box.machineId, 'm');
        expect(box.project.folder, '/work/lamp-os');
        expect(chipLabel(tester, 'machine'), 'Diego MacBook');
        expect(tester.takeException(), isNull);
        await unmount(tester);
      },
    );
  }

  // Review of #2237: each row keeps its button for assistive technology, the
  // press action and the enabled state with it; only its label says more.
  testWidgets(
    'Assistive technology can press a machine row, and not an offline or busy one',
    (tester) async {
      final handle = tester.ensureSemantics();
      final (box, _) = await mount(
        tester,
        leadMachines: swarm,
        setup: addLaptop,
      );
      await openMachines(tester);
      SemanticsNode node(String id) => tester.getSemantics(
        find.descendant(of: leadRow(id), matching: find.byType(MenuItemButton)),
      );
      expect(
        node('laptop'),
        matchesSemantics(
          label: 'Ken MacBook',
          hasEnabledState: true,
          isEnabled: true,
          hasSelectedState: true,
          isFocusable: true,
          hasTapAction: true,
          hasFocusAction: true,
        ),
      );
      for (final (id, why) in [
        ('mini', 'Offline'),
        ('linux', 'Online · No agents free'),
      ]) {
        final row = node(id);
        expect(row.getSemanticsData().label, contains(why), reason: id);
        expect(
          row,
          matchesSemantics(
            label: row.getSemanticsData().label,
            hasEnabledState: true,
            isEnabled: false,
            hasSelectedState: true,
          ),
          reason: id,
        );
        expect(
          row.getSemanticsData().hasAction(SemanticsAction.tap),
          isFalse,
          reason: id,
        );
      }
      // Pressed through its semantics, the enabled row is chosen.
      tester.semantics.tap(find.semantics.byLabel('Ken MacBook'));
      await tester.pumpAndSettle();
      expect(box.leadMachine?.id, 'laptop');
      handle.dispose();
      await unmount(tester);
    },
  );

  testWidgets('Nothing moves the Product Manager to a machine by itself', (
    tester,
  ) async {
    final (box, _) = await mount(
      tester,
      setup: addLaptop,
      leadMachines: rankLeadMachines([laptop, rig], null),
      lead: null,
    );
    expect(box.machineId, 'm');
    expect(box.leadMachine, isNull);
    expect(chipLabel(tester, 'machine'), 'Choose machine');
    // The chip asks; no line repeats it.
    expect(blockedLine, findsNothing);
    expect(tester.widget<FilledButton>(_start).onPressed, isNull);
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
    await openMachines(tester);
    await tester.tap(leadRow('rig'));
    await tester.pumpAndSettle();
    expect(
      box.machineId,
      'm',
      reason: 'another person’s machine is not a choice',
    );
    await tester.tap(leadRow('laptop'));
    await tester.pumpAndSettle();
    expect(box.machineId, 'laptop');
    expect(chipLabel(tester, 'machine'), 'Ken MacBook');
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
      'With your last-used machine unable to take the PM, the chip asks in ${brightness.name}',
      (tester) async {
        final (box, boundary) = await mount(
          tester,
          brightness: brightness,
          leadMachines: [studioFull, laptop, rig],
          setup: (f) {
            addLaptop(f);
            agentIn(f);
          },
          lead: null,
        );
        expect(box.leadPicked, isFalse);
        expect(chipLabel(tester, 'machine'), 'Choose machine');
        box.setTask('Plan the launch');
        await tester.pump();
        expect(tester.widget<FilledButton>(_start).onPressed, isNull);
        await shot(tester, boundary, 'new-project-${brightness.name}-choose');
        await openMachines(tester);
        // Full: one word, and it cannot be picked.
        expect(
          find.descendant(of: leadRow('m'), matching: find.text('busy')),
          findsOneWidget,
        );
        expect(rowEnabled(tester, 'm'), isFalse);
        await tester.tap(leadRow('laptop'));
        await tester.pumpAndSettle();
        expect(box.leadPicked, isTrue);
        expect(tester.widget<FilledButton>(_start).onPressed, isNotNull);
        await unmount(tester);
      },
    );
  }

  testWidgets('A full machine cannot be chosen for the PM', (tester) async {
    final (box, _) = await mount(
      tester,
      setup: addLaptop,
      leadMachines: [studioFull, laptop, rig],
      lead: null,
    );
    expect(box.leadPicked, isFalse);
    expect(box.leadBlocked, 'Choose the machine the Product Manager runs on.');
    box.chooseLeadMachine('m');
    expect(box.leadPicked, isFalse);
    expect(box.leadBlocked, 'Choose the machine the Product Manager runs on.');
    await tester.pump();
    expect(tester.widget<FilledButton>(_start).onPressed, isNull);
    // With every machine full or ruled out, it says none can run it now.
    await unmount(tester);
    final (none, _) = await mount(tester, leadMachines: [studioFull, rig]);
    expect(none.leadNone, isTrue);
    expect(none.leadBlocked, 'No machine can run the Product Manager now.');
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
          lead: 'diego-mac',
        );
        expect(box.leadThroughSwarm, isTrue);
        expect(box.leadSwarmMachine, 'diego-mac');
        // The repo stays the one chosen on your machine; Diego's Mac clones it.
        expect(box.machineId, 'm');
        // Its own name only: no owner, no "Team account" words.
        expect(chipLabel(tester, 'machine'), 'Diego MacBook');
        expect(find.textContaining('there first'), findsNothing);
        box.setTask('Plan the launch');
        await tester.pump();
        expect(tester.widget<FilledButton>(_start).onPressed, isNotNull);
        // Your machine's account and branches say nothing about Diego's Mac.
        expect(
          find.byKey(const ValueKey('new-harness-field-profile')),
          findsNothing,
        );
        expect(
          find.byKey(const ValueKey('new-harness-field-branch')),
          findsNothing,
        );
        await openMachines(tester);
        expect(find.text('Team machines'), findsOneWidget);
        expect(
          find.descendant(
            of: leadRow('diego-mac'),
            matching: find.byIcon(AppIcons.check),
          ),
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
    await openMachines(tester);
    await tester.tap(leadRow('diego-mac'));
    await tester.pumpAndSettle();
    expect(box.leadSwarmMachine, 'diego-mac');
    await openMachines(tester);
    await tester.tap(leadRow('m'));
    await tester.pumpAndSettle();
    expect(box.leadThroughSwarm, isFalse);
    expect(box.leadSwarmMachine, isNull);
    expect(box.machineId, 'm');
    await unmount(tester);
  });

  testWidgets('New Project stays usable at 2x text in a compact window', (
    tester,
  ) async {
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
    await openMachines(tester);
    expect(tester.takeException(), isNull);
    await shot(tester, boundary, 'new-project-lead-compact');
    await unmount(tester);
  });

  testWidgets('The model chip never guesses the model from other agents', (
    tester,
  ) async {
    await mount(
      tester,
      leadMachines: [studio],
      setup: (f) => agentIn(f, model: 'GPT-5.5'),
    );
    expect(chipLabel(tester, 'model'), 'Default model');
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
    await openMachines(tester);
    await tester.tap(leadRow('laptop'));
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
    await openMachines(tester);
    await tester.tap(leadRow('laptop'));
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

  testWidgets(
    'New Project rules out no model when the Swarm sends its catalog',
    (tester) async {
      // The tab's routing-policy read: a policy that turns Codex off.
      final answer = {
        'policy': {
          'version': 1,
          'models': [
            {
              'engine': 'codex',
              'model': 'gpt-5',
              'effort': 'high',
              'enabled': false,
            },
            {
              'engine': 'claude',
              'model': 'opus',
              'effort': 'high',
              'enabled': true,
            },
          ],
        },
        'catalog': {'models': <Object>[]},
      };
      var (box, _) = await mount(
        tester,
        leadMachines: [studio],
        leadModels: LeadModelList.of(answer),
      );
      box.focusField(NewHarnessField.agent);
      var codex = box.options.where((o) => o.id == 'codex').single;
      expect(codex.enabled, isTrue);
      expect(codex.why, isNull);
      expect(box.leadBlocked ?? '', isNot(contains('model list')));
      expect(find.textContaining('model list'), findsNothing);
      await unmount(tester);

      // An older backend's answer (no catalog): that server still enforces
      // its list, so New Project says so, as today.
      (box, _) = await mount(
        tester,
        leadMachines: [studio],
        leadModels: LeadModelList.of({...answer}..remove('catalog')),
      );
      box.focusField(NewHarnessField.agent);
      codex = box.options.where((o) => o.id == 'codex').single;
      expect(codex.enabled, isFalse);
      expect(codex.why, 'The Swarm’s model list has no enabled Codex model.');
      await unmount(tester);
    },
  );

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
              'Update Harness on Mac Studio to run a Product Manager there.',
        );
        final (box, boundary) = await mount(
          tester,
          brightness: brightness,
          leadMachines: [signedOut, kens],
        );
        expect(box.leadNone, isTrue);
        // The one short line, only because it blocks.
        expect(
          tester.widget<Text>(blockedLine).data,
          'No machine can run the Product Manager now.',
        );
        expect(chipLabel(tester, 'machine'), 'Choose machine');
        expect(tester.widget<FilledButton>(_start).onPressed, isNull);
        await shot(tester, boundary, 'new-project-none-${brightness.name}');
        await openMachines(tester);
        for (final (id, why) in [
          (
            'rig',
            'Can’t run a Product Manager: Claude Code isn’t offered here, '
                'Codex isn’t signed in',
          ),
          ('studio', kens.unavailable!),
        ]) {
          // One word on the row; the reason only for assistive technology.
          expect(
            find.descendant(
              of: leadRow(id),
              matching: find.text('unavailable'),
            ),
            findsOneWidget,
          );
          expect(find.text(why), findsNothing);
          expect(
            tester
                .getSemantics(
                  find.descendant(
                    of: leadRow(id),
                    matching: find.byType(MenuItemButton),
                  ),
                )
                .getSemanticsData()
                .label,
            contains(why),
          );
          expect(rowEnabled(tester, id), isFalse);
        }
        await shot(tester, boundary, 'new-project-none-${brightness.name}-why');
        expect(tester.takeException(), isNull);
        await unmount(tester);
      },
    );
  }

  testWidgets('The machine menu fits at 200% text, narrow', (tester) async {
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
    await openMachines(tester);
    expect(tester.takeException(), isNull);
    await shot(tester, boundary, 'new-project-none-200');
    await unmount(tester);
    final (_, teamBoundary) = await mount(
      tester,
      width: 520,
      textScale: 2,
      leadMachines: [studioFull, diegoTeam],
      setup: agentIn,
      lead: 'diego-mac',
    );
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
      'The Swarm’s model list has no enabled Codex model. Choose another engine.',
    );
    expect(tester.widget<FilledButton>(_start).onPressed, isNull);
    await unmount(tester);
  });

  testWidgets('With no model reported the model chip says the default model', (
    tester,
  ) async {
    await mount(tester, leadMachines: [studio]);
    expect(chipLabel(tester, 'model'), 'Default model');
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
    await openMachines(tester);
    await tester.tap(leadRow('laptop'));
    await tester.pumpAndSettle();
    expect(box.machineId, 'laptop');
    expect(box.project.folder, '/Users/ken/swarm/lamp-os');
    expect(find.textContaining('there first'), findsNothing);
    await unmount(tester);
  });

  testWidgets('A machine without the repo clones it, silently', (tester) async {
    final (box, _) = await mount(
      tester,
      setup: (f) {
        addLaptop(f);
        agentIn(f);
      },
      leadMachines: [studio, laptop],
    );
    await openMachines(tester);
    await tester.tap(leadRow('laptop'));
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
    expect(find.textContaining('Clones'), findsNothing);
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
