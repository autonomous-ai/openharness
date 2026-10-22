import 'dart:io';
import 'dart:ui' show PointerDeviceKind;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/machine_details.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/widgets/engine_identity.dart';

import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

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
  final capture = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];
  setUpAll(() => loadCaptureFonts(capture));
  test(
    'generated computer names are readable and custom names stay intact',
    () {
      for (final hostname in [
        'MacBookPro2021.local',
        'MacBooks-MacBook-Pro-19.local',
        'MacbookPro.local',
      ]) {
        expect(superTabMachineName(hostname), 'MacBook Pro');
      }
      expect(superTabMachineName('Mac-mini.local'), 'Mac mini');
      expect(superTabMachineName('build-server.local'), 'build-server');
      for (final name in [
        'Ada’s Mac',
        'M2',
        'MacBook Pro lab',
        'Build server',
      ]) {
        expect(superTabMachineName(name), name);
      }
    },
  );
  testWidgets(
    'machine rows show known capacity and allowances, and an offline machine keeps its old readings dimmed',
    (tester) async {
      await tester.binding.setSurfaceSize(const Size(280, 700));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final server = ConversationServer();
      final now = DateTime.now().millisecondsSinceEpoch;
      server.state['machines'] = [
        for (final live in [true, false])
          {
            'machineId': live ? 'online' : 'offline',
            'name': live ? 'Studio Mac' : 'M2',
            'contributorId': 'owner',
            'observation': {
              'receivedAt': now - (live ? 0 : 60000),
              'resources': {
                'cpuPercent': 0,
                'memoryTotalBytes': 32000000000,
                'memoryUsedBytes': 32000000000,
                'diskTotalBytes': 1000000000000,
                'diskFreeBytes': 141000000000,
              },
              'quotas': [
                {'engine': 'claude', 'known': false, 'windows': []},
                {
                  'engine': 'codex',
                  'known': true,
                  'windows': [
                    {'name': '5-hour', 'usedPercent': 0},
                  ],
                },
              ],
            },
          },
      ];
      final c = server.controller();
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.dark),
          home: Scaffold(
            body: SuperTabMachines(controller: c, onAddAgent: (_) {}),
          ),
        ),
      );
      await tester.pumpAndSettle();
      final offline = find.byKey(const ValueKey('super-machine-offline'));
      final online = find.byKey(const ValueKey('super-machine-online'));
      // Offline: said by the row's tooltip, and its old numbers stay, dimmed, instead of being blanked.
      expect(find.byTooltip('Offline · last seen 1 min ago'), findsOneWidget);
      expect(
        find.descendant(of: offline, matching: find.textContaining('CPU')),
        findsOneWidget,
      );
      expect(
        find.descendant(of: offline, matching: find.byType(EngineMark)),
        findsOneWidget,
      );
      double dimmest(Finder row) => tester
          .widgetList<Opacity>(
            find.descendant(of: row, matching: find.byType(Opacity)),
          )
          .map((o) => o.opacity)
          .fold(1.0, (a, b) => a < b ? a : b);
      expect(dimmest(offline), lessThan(1));
      expect(dimmest(online), 1);
      expect(find.text('CPU 100%'), findsNWidgets(2));
      expect(find.text('RAM 0 GB'), findsNWidgets(2));
      expect(find.text('SSD 141 GB'), findsNWidgets(2));
      expect(find.byType(EngineMark), findsNWidgets(2));
      // The entire row opens its details, including keyboard activation.
      Focus.of(tester.element(find.text('Studio Mac'))).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(find.text('Available capacity'), findsOneWidget);
      expect(find.text('CPU'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(SuperTabMachineDetails),
          matching: find.text('100%'),
        ),
        findsOneWidget,
      );
      expect(find.text('0 GB of 32 GB'), findsOneWidget);
      expect(find.text('141 GB of 1000 GB'), findsOneWidget);
      expect(find.textContaining('GPU'), findsNothing);
      expect(find.text('—'), findsNothing);
      expect(find.text('100% left'), findsOneWidget);
      expect(
        tester
            .widget<EngineMark>(
              find.descendant(
                of: find.byType(AlertDialog),
                matching: find.byType(EngineMark),
              ),
            )
            .engine,
        'codex',
      );
      await tester.tap(find.text('Close'));
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-machine-offline')));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      expect(
        (tester.widget<AlertDialog>(find.byType(AlertDialog)).title! as Text)
            .data,
        'M2',
      );
      expect(find.text('Available capacity'), findsNothing);
      expect(find.text('Model allowances'), findsNothing);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    },
  );

  for (final brightness in [Brightness.dark, Brightness.light]) {
    for (final textScale in [1.0, 2.0]) {
      for (final width in [280.0, 380.0]) {
        testWidgets(
          'machine identity, full-row target and details fit ${brightness.name} ${textScale}x at $width',
          (tester) async {
            await tester.binding.setSurfaceSize(const Size(900, 850));
            addTearDown(() => tester.binding.setSurfaceSize(null));
            final previousBrightness = grid.AppTheme.brightness.value;
            grid.AppTheme.brightness.value = brightness;
            addTearDown(
              () => grid.AppTheme.brightness.value = previousBrightness,
            );
            final server = ConversationServer();
            server.state['people'] = [
              {'id': 'owner', 'email': 'dee@example.com', 'role': 'owner'},
            ];
            server.state['agents'] = [
              for (var i = 0; i < 8; i++)
                {
                  'id': 'agent-$i',
                  'name': 'Harness $i',
                  'displayName': i == 0 ? 'Atlas' : 'Engineer $i',
                  'machineId': 'm',
                  'harnessId': 'native-$i',
                  'contributorId': 'owner',
                  'configuration': {'engine': 'codex'},
                },
            ];
            (server.state['conversations'] as List)[0]
              ..['leadId'] = 'agent-0'
              ..['agentIds'] = ['agent-0'];
            server.state['machines'] = [
              {
                'machineId': 'm',
                'name': 'M2',
                'contributorId': 'owner',
                'paused': true,
                'engines': ['claude', 'codex'],
                'cwd': '/work/a-very-long-project-folder-without-spaces/checked-out-project',
                'observation': {
                  'receivedAt': DateTime.now().millisecondsSinceEpoch,
                  'resources': {
                    'deviceType': 'MacBook Pro',
                    'chip': 'Apple M2 Max',
                    'os': 'macOS',
                    'cpuPercent': 27,
                    'gpuPercent': 7,
                    'memoryTotalBytes': 64000000000,
                    'memoryUsedBytes': 36000000000,
                    'diskTotalBytes': 1000000000000,
                    'diskFreeBytes': 141000000000,
                  },
                  'quotas': [
                    {'engine': 'claude', 'known': false, 'windows': []},
                    {
                      'engine': 'codex',
                      'known': true,
                      'windows': [
                        {
                          'name': '5-hour',
                          'usedPercent': 30,
                          'resetsAt': DateTime.now()
                              .add(const Duration(hours: 2))
                              .millisecondsSinceEpoch,
                        },
                        {
                          'name': 'Weekly',
                          'usedPercent': 10,
                          'resetsAt': DateTime.now()
                              .add(const Duration(days: 3))
                              .millisecondsSinceEpoch,
                        },
                      ],
                    },
                  ],
                },
              },
            ];
            final c = server.controller();
            await c.refresh();
            final machineBoundary = GlobalKey();
            await tester.pumpWidget(
              MaterialApp(
                debugShowCheckedModeBanner: false,
                theme: grid.buildAppTheme(brightness: brightness),
                builder: (context, child) => MediaQuery(
                  data: MediaQuery.of(context)
                      .copyWith(textScaler: TextScaler.linear(textScale)),
                  child: child!,
                ),
                home: Scaffold(
                  body: Align(
                    alignment: Alignment.topLeft,
                    child: RepaintBoundary(
                      key: machineBoundary,
                      child: Material(
                        color: grid.AppDesktop.surface,
                        child: SizedBox(
                          width: width,
                          child: SuperTabMachines(
                            controller: c,
                            embedded: true,
                            onAddAgent: (_) {},
                          ),
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            );
            await tester.pumpAndSettle();
            if (capture != null) {
              // A frame can settle before asynchronous bitmap decoding has
              // finished. Wait for the real asset before photographing it.
              await tester.runAsync(
                () => precacheImage(
                  AssetImage(engineIdentity('codex').asset!),
                  tester.element(find.byType(EngineMark).first),
                ).timeout(const Duration(seconds: 10)),
              );
              await tester.pumpAndSettle();
            }
            final row = find.byKey(const ValueKey('super-machine-m'));
            final header = find.byKey(const ValueKey('super-machine-header-m'));
            final avatars = tester
                .widgetList<SuperTabAvatar>(
                  find.descendant(
                    of: header,
                    matching: find.byType(SuperTabAvatar),
                  ),
                )
                .toList();
            expect(avatars.first.identity, 'person:owner');
            expect(avatars.first.name, 'dee');
            expect(avatars[1].identity, 'agent:agent-0');
            expect(avatars[1].name, 'Atlas');
            expect(
              find.byTooltip('dee@example.com\nMachine owner'),
              findsOneWidget,
            );
            expect(find.byTooltip('Atlas\nProduct Manager'), findsOneWidget);
            expect(find.byTooltip('New work paused'), findsOneWidget);
            expect(find.textContaining('agents'), findsNothing);
            expect(find.text('dee'), findsNothing);
            final hiddenAgents = 8 - (avatars.length - 1);
            expect(
              find.text('+$hiddenAgents'),
              hiddenAgents == 0 ? findsNothing : findsOneWidget,
            );
            if (width == 280) expect(hiddenAgents, greaterThan(0));
            for (final value in [
              'CPU 73%',
              'GPU 93%',
              'RAM 28 GB',
              'SSD 141 GB',
              '70%',
            ]) {
              expect(find.text(value), findsOneWidget);
            }
            final rowRect = tester.getRect(row);
            final ink = find.descendant(
              of: row,
              matching: find.byType(InkWell),
            );
            expect(tester.getRect(ink), rowRect);
            expect(rowRect.width, width);
            final headerRect = tester.getRect(header);
            for (final avatar
                in find
                    .descendant(
                      of: header,
                      matching: find.byType(SuperTabAvatar),
                    )
                    .evaluate()) {
              final rect = tester.getRect(find.byWidget(avatar.widget));
              expect(rect.center.dy, closeTo(headerRect.center.dy, .1));
              expect(rect.right, lessThanOrEqualTo(rowRect.right - 16));
            }
            expect(tester.takeException(), isNull);

            // The blank right edge and all capacity/allowance lines belong to
            // the same hover and click target as the machine's name.
            final mouse = await tester.createGesture(
              kind: PointerDeviceKind.mouse,
            );
            await mouse.addPointer(
              location: Offset(rowRect.right + 20, rowRect.center.dy),
            );
            await tester.pump();
            await mouse.moveTo(Offset(rowRect.right - 2, rowRect.center.dy));
            await tester.pumpAndSettle();
            final captureName =
                '${brightness.name}-${textScale}x-${width.toInt()}';
            await captureBoundary(
              tester,
              machineBoundary.currentContext!.findRenderObject()!
                  as RenderRepaintBoundary,
              capture,
              'machine-hover-$captureName',
            );
            await tester.tapAt(Offset(rowRect.right - 2, rowRect.center.dy));
            await mouse.removePointer();
            await tester.pumpAndSettle();
            final dialog = find.byType(AlertDialog);
            final details = find.byType(SuperTabMachineDetails);
            expect(dialog, findsOneWidget);
            expect(details, findsOneWidget);
            expect(
              find.descendant(
                of: details,
                matching: find.text('28 GB of 64 GB'),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.text('141 GB of 1000 GB'),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.textContaining(
                  '5-hour: 70% remaining\nResets in ',
                ),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(
                of: details,
                matching: find.textContaining(
                  'Weekly: 90% remaining\nResets in ',
                ),
              ),
              findsOneWidget,
            );
            expect(
              find.descendant(of: details, matching: find.text('—')),
              findsNothing,
            );
            expect(tester.takeException(), isNull);
            await captureWindow(
              tester,
              capture,
              'machine-details-$captureName',
            );
            if (capture != null && textScale > 1) {
              await Scrollable.ensureVisible(
                tester.element(find.text('Model allowances')),
                alignment: 0,
              );
              await tester.pumpAndSettle();
              await captureWindow(
                tester,
                capture,
                'machine-details-more-$captureName',
              );
            }
            await tester.tap(find.widgetWithText(TextButton, 'Close'));
            await tester.pumpAndSettle();
            expect(tester.takeException(), isNull);
            await tester.pumpWidget(const SizedBox());
            await c.flush();
            c.dispose();
          },
        );
      }
    }
  }

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
  test('a daemon\'s canonical remote is shared as an HTTPS repository', () {
    // The CLI daemon reports `origin` as host/owner/repo, without a scheme.
    expect(
      superTabRepositoryUrl('github.com/autonomous-ai/openharness'),
      'https://github.com/autonomous-ai/openharness',
    );
    expect(
      superTabRepositoryUrl('gitlab.example.co.uk/team/group/project'),
      'https://gitlab.example.co.uk/team/group/project',
    );
    // A canonical port may be SSH's; it is not guessed as HTTPS.
    expect(superTabRepositoryUrl('git.example.com:2222/team/project'), isNull);
    // Local and relative remotes are not shareable repositories.
    expect(superTabRepositoryUrl('../project'), isNull);
    expect(superTabRepositoryUrl('/Users/me/project.git'), isNull);
    expect(superTabRepositoryUrl('github.com'), isNull);
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

  testWidgets('Machine details omit unknown subscription allowances', (
    tester,
  ) async {
    final f = SuperTabLaunchFixture();
    f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
    f.connection.server.state['machines'] = [
      {
        'machineId': 'm',
        'contributorId': 'owner',
        'observation': {
          'receivedAt': DateTime.now().millisecondsSinceEpoch,
          'quotas': [
            for (final engine in ['claude', 'codex', 'opencode', 'cursor'])
              {
                'engine': engine,
                'known': engine == 'claude',
                'windows': [
                  {'name': '5-hour', 'usedPercent': 40},
                ],
              },
          ],
        },
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
    expect(find.byType(EngineMark), findsOneWidget);
    expect(tester.widget<EngineMark>(find.byType(EngineMark)).engine, 'claude');
    await tester.tap(find.byKey(const ValueKey('super-machine-m')));
    await tester.pumpAndSettle();
    expect(
      tester
          .widgetList<EngineMark>(find.byType(EngineMark))
          .map((mark) => mark.engine)
          .toSet(),
      {'claude'},
    );

    await tester.pumpWidget(const SizedBox());
    await c.flush();
    f.app.superTabs.dispose();
    await tester.pump();
  });

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
