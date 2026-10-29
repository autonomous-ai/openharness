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
      integration: HarnessLaunchIntegration(
        creationId: 'swarm-form-fixture',
        actionLabel: 'New Project',
        projectVisibility: 'public',
        projectVisibilityLocked: visibilityLocked,
        prepare: (_, task) async => task,
        beforeSubmit: (_, _) async {},
        complete: (_, _) async {},
      )..leadMachines = leadMachines,
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
              'Product Manager: Mac Studio · ${box.agentLabel}',
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
        matching: find.textContaining('Product Manager: Ken MacBook'),
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
        matching: find.textContaining('Product Manager: Ken MacBook'),
      ),
      findsOneWidget,
    );
    await unmount(tester);
  });

  for (final brightness in Brightness.values) {
    testWidgets(
      'With no machine free New Project says so and waits in ${brightness.name}',
      (tester) async {
        final (box, boundary) = await mount(
          tester,
          brightness: brightness,
          leadMachines: [
            const LeadMachine(
              id: 'm',
              name: 'Mac Studio',
              online: true,
              freeAgents: 0,
            ),
            rig,
          ],
        );
        expect(
          find.text(
            'No machine of yours in this Swarm is free. New Project can start once one is.',
          ),
          findsOneWidget,
        );
        expect(tester.widget<FilledButton>(_start).onPressed, isNull);
        box.setTask('Plan the launch');
        await tester.pump();
        expect(tester.widget<FilledButton>(_start).onPressed, isNull);
        await shot(
          tester,
          boundary,
          'new-project-lead-${brightness.name}-waiting',
        );
        await unmount(tester);
      },
    );
  }

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
