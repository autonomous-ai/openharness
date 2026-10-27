import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/machine_status.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/section_heading.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

Finder inRow(String key, Finder finder) =>
    find.descendant(of: find.byKey(ValueKey(key)), matching: finder);

Finder unreadDot(String groupId) => inRow(
  'super-group-$groupId',
  find.byWidgetPredicate(
    (w) => w is Semantics && w.properties.label == 'Unread messages',
  ),
);

Material rowMaterial(WidgetTester tester, String key) => tester.widget(
  find
      .ancestor(of: find.byKey(ValueKey(key)), matching: find.byType(Material))
      .first,
);

Future<void> pumpSidebar(
  WidgetTester tester,
  SuperTabController controller,
  AppNotifier app, {
  double width = 280,
  double scale = 1,
  bool devices = true,
  VoidCallback? onNewProject,
  VoidCallback? onYourDevices,
  DateTime Function()? now,
  Future<MachineResources?> Function(String)? readLocal,
}) async {
  await tester.binding.setSurfaceSize(Size(width, 1000));
  await tester.pumpWidget(
    MaterialApp(
      theme: grid.buildAppTheme(brightness: Brightness.dark),
      builder: (context, child) => MediaQuery(
        data: MediaQuery.of(context)
            .copyWith(textScaler: TextScaler.linear(scale)),
        child: child!,
      ),
      home: Scaffold(
        body: ListenableBuilder(
          listenable: controller,
          builder: (context, _) => ProjectSidebar(
            controller: controller,
            app: app,
            onAddAgent: (_) {},
            needsHuman: (_) => 0,
            onSelect: controller.select,
            onNewProject: onNewProject ?? () {},
            onYourDevices: devices
                ? () {
                    onYourDevices?.call();
                    controller.selectDevices();
                  }
                : null,
            devicesSelected: controller.devicesSelected,
            readLocal: readLocal,
            now: now ?? DateTime.now,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

Future<void> disposeSidebar(
  WidgetTester tester,
  SuperTabController controller,
) async {
  await tester.pumpWidget(const SizedBox());
  await controller.flush();
  controller.dispose();
}

Future<SuperTabController> projectSidebar(ConversationServer server) async {
  server.state['projects'] = [
    projectFixture('lead', 'web-project', 'lead'),
    projectFixture(
      'empty',
      'sample-project',
      'empty-lead',
      visibility: 'private',
    ),
  ];
  (server.state['conversations'] as List)[1]
    ..['projectId'] = 'lead'
    ..['number'] = 12
    ..['lastMessageSequence'] = 5;
  (server.state['conversations'] as List).add({
    ...conversationFixture('empty-lead', 'Lead'),
    'projectId': 'empty',
  });
  final controller = server.controller();
  await controller.refresh();
  return controller;
}

void main() {
  for (final scale in [1.0, 2.0]) {
    testWidgets('flat navigation shares text and selection bounds; a project row '
        'opens its chat and shows its workgroups at ${scale}x', (tester) async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final server = ConversationServer();
      final controller = await projectSidebar(server);
      var created = 0;
      var openedDevices = 0;
      await pumpSidebar(
        tester,
        controller,
        app,
        scale: scale,
        onNewProject: () => created++,
        onYourDevices: () => openedDevices++,
      );
      final project = find.byKey(const ValueKey('super-group-lead'));
      final empty = find.byKey(const ValueKey('super-group-empty-lead'));
      final devices = find.byKey(const ValueKey('super-your-devices'));
      final newProject = find.byKey(const ValueKey('super-new-project'));
      expect(find.byType(OutlinedButton), findsNothing);
      expect(
        tester.getBottomLeft(devices).dy,
        lessThan(tester.getTopLeft(find.text('Projects')).dy),
      );
      expect(
        tester.getBottomLeft(newProject).dy,
        lessThan(tester.getTopLeft(devices).dy),
      );
      expect(inRow('super-group-lead', find.text('#')), findsOneWidget);

      // Its name in the Projects list, not its direct message's grey tag.
      final sample = inRow(
        'super-group-empty-lead',
        find.text('sample-project'),
      );
      await tester.tap(sample);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'empty-lead');
      await tester.tap(project);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'lead');
      expect(inRow('super-group-lead', find.text('#')), findsOneWidget);
      final work = find.byKey(const ValueKey('super-group-offline'));
      expect(work, findsOneWidget);
      final textX = tester
          .getTopLeft(inRow('super-group-lead', find.text('web-project')))
          .dx;
      for (final label in [
        find.text('New project'),
        find.text('Your devices'),
        sample,
        // A workgroup's number is grey, with no #: it is no channel.
        inRow('super-group-offline', find.text('12  Offline editing')),
      ]) {
        expect(tester.getTopLeft(label).dx, textX, reason: '$label');
      }
      expect(
        tester.getCenter(unreadDot('offline')).dx,
        tester.getCenter(unreadDot('lead')).dx,
      );
      for (final row in [newProject, devices, work]) {
        final bounds = tester.getRect(row);
        final projectBounds = tester.getRect(
          find.byKey(const ValueKey('super-group-lead')),
        );
        expect(bounds.left, projectBounds.left);
        expect(bounds.right, projectBounds.right);
      }

      await tester.tap(work);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'offline');
      await tester.tap(empty);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'empty-lead');
      expect(find.text('No workgroups yet'), findsOneWidget);
      expect(tester.getTopLeft(find.text('No workgroups yet')).dx, textX);
      // A second click on the open project hides its workgroups again.
      await tester.tap(empty);
      await tester.pumpAndSettle();
      expect(controller.selectedId, 'empty-lead');
      expect(find.text('No workgroups yet'), findsNothing);

      // The plain top actions retain keyboard operation and do not create tabs.
      Focus.of(tester.element(find.text('New project'))).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(created, 1);
      await tester.tap(find.byTooltip('New project'));
      await tester.pumpAndSettle();
      expect(created, 2);
      final tabsBefore = app.swarms.length;
      Focus.of(tester.element(find.text('Your devices'))).requestFocus();
      await tester.pump();
      await tester.sendKeyEvent(LogicalKeyboardKey.enter);
      await tester.pumpAndSettle();
      expect(openedDevices, 1);
      expect(controller.devicesSelected, isTrue);
      expect(controller.selectedId, 'empty-lead');
      expect(app.swarms, hasLength(tabsBefore));
      expect(
        rowMaterial(tester, 'super-your-devices').color,
        grid.AppSurface.selectedFill,
      );
      expect(
        rowMaterial(tester, 'super-group-offline').color,
        Colors.transparent,
      );

      // Returning to the already selected workgroup still leaves Devices.
      await tester.tap(work);
      await tester.pumpAndSettle();
      expect(controller.devicesSelected, isFalse);
      expect(controller.selectedId, 'offline');
      expect(
        rowMaterial(tester, 'super-group-offline').color,
        grid.AppSurface.selectedFill,
      );
      expect(
        rowMaterial(tester, 'super-your-devices').color,
        Colors.transparent,
      );
      expect(tester.takeException(), isNull);
      await disposeSidebar(tester, controller);
    });
  }

  testWidgets('reads like a chat app: utilities, Projects A to Z with their '
      'workgroups and # product-managers, Direct messages, then Machines', (
    tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final server = ConversationServer();
    (server.state['conversations'] as List).add({
      ...conversationFixture('leads', 'Leads'),
      'kind': 'leads',
    });
    server.state['leadsConversationId'] = 'leads';
    final controller = await projectSidebar(server);
    controller
      ..toggleProject('lead')
      ..toggleProject('empty');
    await pumpSidebar(tester, controller, app);

    final order = [
      find.byKey(const ValueKey('super-new-project')),
      find.byKey(const ValueKey('super-local-models')),
      find.byKey(const ValueKey('super-your-devices')),
      find.text('Projects'),
      find.byKey(const ValueKey('super-group-leads')),
      find.byKey(const ValueKey('super-group-empty-lead')),
      find.text('No workgroups yet'),
      find.byKey(const ValueKey('super-group-lead')),
      find.byKey(const ValueKey('super-group-offline')),
      find.text('Direct messages'),
      find.byKey(const ValueKey('super-pm-chat-lead')),
      find.byKey(const ValueKey('super-pm-chat-empty')),
      find.text('Machines'),
    ];
    for (var i = 1; i < order.length; i++) {
      expect(
        tester.getTopLeft(order[i - 1]).dy,
        lessThan(tester.getTopLeft(order[i]).dy),
        reason: '${order[i - 1]} above ${order[i]}',
      );
    }
    for (final (key, name) in [
      ('leads', 'product-managers'),
      ('empty-lead', 'sample-project'),
      ('lead', 'web-project'),
    ]) {
      expect(inRow('super-group-$key', find.text('#')), findsOneWidget);
      expect(inRow('super-group-$key', find.text(name)), findsOneWidget);
    }
    // The product managers' channel has no workgroups to disclose.
    expect(
      inRow('super-group-leads', find.byIcon(AppIcons.chevronRight)),
      findsNothing,
    );
    expect(
      inRow('super-pm-chat-lead', find.text('(web-project)')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await disposeSidebar(tester, controller);
  });

  testWidgets('section disclosure follows its label and + aligns with the '
      'rows\' right status column', (tester) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final controller = await projectSidebar(ConversationServer());
    for (final width in [180.0, 280.0, 420.0]) {
      await pumpSidebar(tester, controller, app, width: width);
      for (final title in ['Projects', 'Machines']) {
        final heading = find.ancestor(
          of: find.text(title),
          matching: find.byType(SuperTabSectionHeading),
        );
        final label = tester.getRect(find.text(title));
        final chevron = tester.getRect(
          find.descendant(
            of: heading,
            matching: find.byIcon(AppIcons.chevronDown),
          ),
        );
        expect(chevron.left, closeTo(label.right + 4, .01));
        expect(
          tester.getCenter(find.byTooltip('New project')).dx,
          tester.getCenter(find.byTooltip('Add machine')).dx,
        );
      }
      expect(
        tester.getCenter(find.byTooltip('New project')).dx,
        tester.getRect(find.byKey(const ValueKey('super-group-lead'))).right -
            16,
      );
      expect(tester.takeException(), isNull);
    }
    await disposeSidebar(tester, controller);
  });

  testWidgets(
    'narrow panes and large text retain top navigation and a readable '
    'heading while machines reconnect',
    (tester) async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final server = ConversationServer();
      final controller = await projectSidebar(server);
      for (final unreachable in [false, true]) {
        DateTime Function()? now;
        if (unreachable) {
          server.failReads = true;
          await controller.refresh();
          final pinned = controller.unreachableSince!.add(
            const Duration(minutes: 12),
          );
          now = () => pinned;
        }
        for (final width in [180.0, 240.0]) {
          for (final scale in [1.0, 2.0]) {
            await pumpSidebar(
              tester,
              controller,
              app,
              width: width,
              scale: scale,
              now: now,
            );
            final reason = '$width px, ${scale}x, unreachable=$unreachable';
            expect(tester.takeException(), isNull, reason: reason);
            expect(find.text('Your devices'), findsOneWidget, reason: reason);
            expect(
              find.byTooltip('Add machine'),
              findsOneWidget,
              reason: reason,
            );
            expect(
              find.byType(SuperTabMachinesPill),
              unreachable ? findsOneWidget : findsNothing,
              reason: reason,
            );
            if (unreachable) {
              final pill = tester.getRect(find.byType(SuperTabMachinesPill));
              final add = tester.getRect(find.byTooltip('Add machine'));
              expect(pill.right, lessThanOrEqualTo(add.left), reason: reason);
              expect(
                find.byTooltip('Reconnecting · 12m').evaluate().isNotEmpty ||
                    find.text('Reconnecting · 12m').evaluate().isNotEmpty,
                isTrue,
                reason: reason,
              );
            }
          }
        }
      }
      await pumpSidebar(tester, controller, app, devices: false);
      expect(find.byKey(const ValueKey('super-your-devices')), findsNothing);
      expect(find.byTooltip('Add machine'), findsOneWidget);
      await disposeSidebar(tester, controller);
    },
  );

  testWidgets('the left Machines group repaints on a live app change alone', (
    tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final server = ConversationServer();
    server.state['agents'] = [
      {
        'id': 'agent-0',
        'name': 'Lead',
        'displayName': 'Atlas',
        'machineId': 'm',
        'harnessId': 'a0',
        'contributorId': 'owner',
        'configuration': {'engine': 'claude'},
      },
    ];
    final controller = server.controller();
    await controller.refresh();
    await pumpSidebar(
      tester,
      controller,
      app,
      readLocal: (_) async => const MachineResources(cpuPercent: 10),
    );
    await tester.pump();
    await tester.pump();
    final dot = inRow('super-machine-m', find.byType(SuperTabMachineDot));
    expect(
      tester.widget<SuperTabMachineDot>(dot).status,
      isNot(SuperTabMachineStatus.offline),
    );

    await app.handleEventForTest('m', {'type': 'node_status', 'online': false});
    await tester.pump();
    expect(find.byKey(const ValueKey('super-machine-m')), findsOneWidget);
    expect(
      tester.widget<SuperTabMachineDot>(dot).status,
      SuperTabMachineStatus.offline,
    );
    await disposeSidebar(tester, controller);
  });

  testWidgets('section collapse persists and keeps top navigation available', (
    tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final server = ConversationServer();
    final controller = await projectSidebar(server);
    await pumpSidebar(tester, controller, app);
    const machinesBody = 'Add a machine for the product manager to use.';
    expect(inRow('super-group-lead', find.text('web-project')), findsOneWidget);
    expect(find.text(machinesBody), findsOneWidget);

    await tester.tap(find.byTooltip('Collapse Projects'));
    await tester.pumpAndSettle();
    expect(inRow('super-group-lead', find.text('web-project')), findsNothing);
    expect(controller.projectsGroupOpen, isFalse);
    await tester.tap(find.byTooltip('Collapse Machines'));
    await tester.pumpAndSettle();
    expect(find.text(machinesBody), findsNothing);
    expect(controller.machinesGroupOpen, isFalse);
    expect(find.text('New project'), findsOneWidget);
    expect(find.text('Your devices'), findsOneWidget);

    await controller.flush();
    final saved = server.saved!;
    expect(saved['projectsGroupOpen'], isFalse);
    expect(saved['machinesGroupOpen'], isFalse);
    final reopened = server.controller(initial: saved);
    await reopened.refresh();
    expect(reopened.projectsGroupOpen, isFalse);
    expect(reopened.machinesGroupOpen, isFalse);

    Focus.of(tester.element(find.text('Projects'))).requestFocus();
    await tester.pump();
    await tester.sendKeyEvent(LogicalKeyboardKey.enter);
    await tester.pumpAndSettle();
    expect(inRow('super-group-lead', find.text('web-project')), findsOneWidget);
    await disposeSidebar(tester, controller);
    await reopened.flush();
    reopened.dispose();
  });

  group('Local models', () {
    const swarmGrid = 'swarm-0123456789ab';
    Map<String, dynamic> machine({
      List<Map<String, dynamic>> served = const [],
      int? receivedAt,
    }) => {
      'machineId': 'studio',
      'name': 'Studio.local',
      'contributorId': 'owner',
      'observation': {
        'receivedAt': receivedAt ?? DateTime.now().millisecondsSinceEpoch,
        'localModels': served,
      },
    };
    Future<void> mount(WidgetTester tester, SuperTabController c) async {
      await tester.binding.setSurfaceSize(const Size(900, 1000));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: c,
              builder: (context, _) => ProjectSidebar(
                controller: c,
                onAddAgent: (_) {},
                needsHuman: (_) => 0,
                onSelect: c.select,
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
    }

    final open = find.byKey(const ValueKey('super-local-models'));
    final setUp = find.byKey(const ValueKey('super-local-models-setup'));

    testWidgets(
      'the owner sets models up from Your models; there is no switch',
      (tester) async {
        final server = ConversationServer();
        server.state['machines'] = [machine()];
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        expect(find.text('Your models'), findsOneWidget);
        await tester.tap(open);
        await tester.pumpAndSettle();
        // The page is titled as the row that opens it.
        expect(find.text('Your models'), findsNWidgets(2));
        expect(find.byType(Switch), findsNothing);
        expect(
          find.textContaining('Set up connects this computer to the Swarm'),
          findsOneWidget,
        );
        await tester.tap(setUp);
        await tester.pumpAndSettle();
        expect(
          server.posts
              .map((p) => p['command'])
              .where((cmd) => (cmd as Map)['type'] == 'localModels.set')
              .single,
          {'type': 'localModels.set', 'enabled': true},
        );
        await tester.tap(
          find.byKey(const ValueKey('super-local-models-close')),
        );
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    testWidgets(
      'everyone sees Your models; before it is set up a member is told the owner sets it up',
      (tester) async {
        final server = ConversationServer();
        (server.state['people'] as List).add({
          'id': 'peer',
          'email': 'peer@example.com',
          'role': 'collaborator',
        });
        server.state['machines'] = [machine()];
        final c = server.controller(account: 'peer');
        await c.refresh();
        await mount(tester, c);
        await tester.tap(open);
        await tester.pumpAndSettle();
        expect(
          find.text('The Swarm owner has not set up models yet.'),
          findsOneWidget,
        );
        expect(setUp, findsNothing);
        await tester.tap(
          find.byKey(const ValueKey('super-local-models-close')),
        );
        await tester.pumpAndSettle();

        // Being set up: it says so, and still offers nothing to press.
        server.state['localModels'] = {'grid': swarmGrid, 'enabled': true};
        server.revision++;
        await c.refresh();
        await tester.pumpAndSettle();
        await tester.tap(open);
        await tester.pumpAndSettle();
        expect(
          find.text('Being set up on the owner\'s computer.'),
          findsOneWidget,
        );
        expect(setUp, findsNothing);
        await tester.tap(
          find.byKey(const ValueKey('super-local-models-close')),
        );
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    testWidgets(
      'a failed set up says grid\'s words and offers Try again to the owner',
      (tester) async {
        final server = ConversationServer();
        server.state['localModels'] = {
          'grid': swarmGrid,
          'enabled': true,
          'ready': false,
          'error': 'Free plan allows one network',
        };
        final c = server.controller();
        await c.refresh();
        await mount(tester, c);
        await tester.tap(open);
        await tester.pumpAndSettle();
        expect(
          find.text('Could not set up: Free plan allows one network.'),
          findsOneWidget,
        );
        expect(find.text('Try again'), findsOneWidget);
        await tester.tap(
          find.byKey(const ValueKey('super-local-models-close')),
        );
        await tester.pumpAndSettle();
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      },
    );

    test(
      'lists only fresh readings, once each, and none while the add-on is off',
      () {
        final now = DateTime.fromMillisecondsSinceEpoch(1000000);
        SuperTabSnapshot snapshot({bool enabled = true, int at = 990000}) =>
            SuperTabSnapshot.fromJson({
              'version': 1,
              'id': 'tab',
              'name': 'Swarm',
              'ownerId': 'owner',
              'people': <Object>[],
              'agents': <Object>[],
              'conversations': <Object>[],
              'invitations': <Object>[],
              'localModels': {'grid': swarmGrid, 'enabled': enabled},
              'machines': [
                {'machineId': 'a', 'observation': 'junk'},
                {
                  'machineId': 'b',
                  'observation': {
                    'receivedAt': at,
                    'localModels': [
                      {'grid': swarmGrid, 'model': 'm'},
                      {'grid': 'team', 'model': 'n'},
                      {'grid': swarmGrid, 'model': 7},
                      'junk',
                    ],
                  },
                },
              ],
            });
        expect(superTabLocalModelRows(snapshot(), now: now), [
          (
            grid: swarmGrid,
            model: 'm',
            name: 'm',
            machine: 'A machine',
            kind: 'local',
          ),
          (
            grid: 'team',
            model: 'n',
            name: 'n',
            machine: 'A machine',
            kind: 'shared',
          ),
        ]);
        expect(superTabLocalModelRows(snapshot(at: 900000), now: now), isEmpty);
        expect(
          superTabLocalModelRows(snapshot(enabled: false), now: now),
          isEmpty,
        );
        expect(superTabLocalModelRows(null, now: now), isEmpty);
      },
    );
  });
}
