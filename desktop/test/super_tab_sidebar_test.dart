import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/machine_resources.dart';
import 'package:harness/screens/swarm_screen.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shortcuts/app_keymap.dart';
import 'package:harness/state/swarm_catalog.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/attention.dart';
import 'package:harness/super_tabs/machines.dart';
import 'package:harness/super_tabs/manage_page.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/places.dart';
import 'package:harness/super_tabs/project_sidebar.dart';
import 'package:harness/super_tabs/section_heading.dart';

import 'keymap_host_test.dart' show MemoryKeymap;
import 'super_tab_launch_test.dart' show SuperTabLaunchFixture, tabId;
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

Finder inRow(String key, Finder finder) =>
    find.descendant(of: find.byKey(ValueKey(key)), matching: finder);

/// A drawn unread dot; unread is now a bold name, heard as "Unread messages".
Finder unreadDot(String groupId) => inRow(
  'super-group-$groupId',
  find.byWidgetPredicate(
    (w) =>
        w is Container &&
        w.decoration is BoxDecoration &&
        (w.decoration! as BoxDecoration).shape == BoxShape.circle &&
        // A dot holds nothing; an avatar holds its initial.
        w.child == null,
  ),
);

Material rowMaterial(WidgetTester tester, String key) => tester.widget(
  find
      .ancestor(of: find.byKey(ValueKey(key)), matching: find.byType(Material))
      .first,
);

/// The sidebar, with Manage opening Devices, one of its pages: [onManage] and
/// the row's selection follow the controller as they do in the view.
Future<void> pumpSidebar(
  WidgetTester tester,
  SuperTabController controller,
  AppNotifier app, {
  double width = 280,
  double scale = 1,
  VoidCallback? onNewProject,
  VoidCallback? onManage,
  ValueChanged<SwarmPage>? onPage,
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
            attention: SuperTabAttention.of(controller),
            onSelect: controller.select,
            onNewProject: onNewProject ?? () {},
            onPage: onPage ?? (_) {},
            onManage: () {
              onManage?.call();
              controller.selectDevices();
            },
            manageSelected: controller.devicesSelected,
          ),
        ),
      ),
    ),
  );
  await tester.pumpAndSettle();
}

/// The Machines group on its own, heading included.
Future<void> pumpMachines(
  WidgetTester tester,
  SuperTabController controller,
  AppNotifier app, {
  double width = 280,
  double scale = 1,
  DateTime Function()? now,
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
          builder: (context, _) => SuperTabMachines(
            controller: controller,
            app: app,
            onAddAgent: (_) {},
            embedded: true,
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
  testWidgets(
    'private projects use a leading lock and keep notifications at the right',
    (tester) async {
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final server = ConversationServer();
      final controller = await projectSidebar(server);
      server.tag('message-1', conversationId: 'lead');
      await controller.refresh();
      final attention = SuperTabAttention.of(controller);
      await attention.mentions.load();
      await controller.setNotify('empty-lead', SuperTabNotify.muted);
      await pumpSidebar(tester, controller, app);

      final privateRow = find.byKey(const ValueKey('super-group-empty-lead'));
      final privateLock = inRow(
        'super-group-empty-lead',
        find.byIcon(AppIcons.lock),
      );
      final privateName = inRow(
        'super-group-empty-lead',
        find.text('sample-project'),
      );
      final publicName = inRow('super-group-lead', find.text('web-project'));
      final badge = inRow(
        'super-group-lead',
        find.byKey(const ValueKey('super-mentions-lead')),
      );
      final muted = inRow(
        'super-group-empty-lead',
        find.byKey(const ValueKey('super-muted-empty-lead')),
      );

      expect(privateRow, findsOneWidget);
      expect(privateLock, findsOneWidget);
      expect(
        inRow('super-group-empty-lead', find.byTooltip('Private project')),
        findsOneWidget,
      );
      expect(inRow('super-group-empty-lead', find.text('#')), findsNothing);
      expect(inRow('super-group-lead', find.text('#')), findsOneWidget);
      expect(badge, findsOneWidget);
      expect(muted, findsOneWidget);
      expect(
        tester.getCenter(privateLock).dx,
        lessThan(tester.getCenter(privateName).dx),
      );
      expect(
        tester.getCenter(badge).dx,
        greaterThan(tester.getCenter(publicName).dx),
      );
      expect(
        tester.getCenter(muted).dx,
        greaterThan(tester.getCenter(privateName).dx),
      );

      await disposeSidebar(tester, controller);
    },
  );

  for (final scale in [1.0, 2.0]) {
    testWidgets(
      'flat navigation shares text and selection bounds; a project row '
      'opens its chat on every click and lists no tasks at ${scale}x',
      (tester) async {
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        final server = ConversationServer();
        final controller = await projectSidebar(server);
        var created = 0;
        var openedManage = 0;
        var openedActivity = 0;
        await pumpSidebar(
          tester,
          controller,
          app,
          scale: scale,
          onNewProject: () => created++,
          onManage: () => openedManage++,
          onPage: (_) => openedActivity++,
        );
        final project = find.byKey(const ValueKey('super-group-lead'));
        final empty = find.byKey(const ValueKey('super-group-empty-lead'));
        final manage = find.byKey(const ValueKey('super-manage'));
        final activity = find.byKey(const ValueKey('super-decisions'));
        expect(find.byType(OutlinedButton), findsNothing);
        expect(
          tester.getBottomLeft(activity).dy,
          lessThan(tester.getTopLeft(find.text('Projects')).dy),
        );
        expect(
          tester.getTopLeft(manage).dy,
          greaterThan(tester.getBottomLeft(empty).dy),
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
        // A second click keeps its chat and lists no tasks: they are in the
        // project's Tasks view (task #2569).
        await tester.tap(project);
        await tester.pumpAndSettle();
        expect(controller.selectedId, 'lead');
        expect(find.byKey(const ValueKey('super-group-offline')), findsNothing);
        final textX = tester
            .getTopLeft(inRow('super-group-lead', find.text('web-project')))
            .dx;
        for (final label in [
          find.text('Decisions'),
          find.text('Manage'),
          sample,
        ]) {
          expect(tester.getTopLeft(label).dx, textX, reason: '$label');
        }
        // Unread is a bold name, with no dot (Dee, 2026-10-29).
        expect(unreadDot('lead'), findsNothing);
        for (final row in [activity, manage, empty]) {
          final bounds = tester.getRect(row);
          expect(bounds.left, tester.getRect(project).left);
          expect(bounds.right, tester.getRect(project).right);
        }

        await controller.select('offline');
        await tester.pumpAndSettle();
        await tester.tap(empty);
        await tester.pumpAndSettle();
        expect(controller.selectedId, 'empty-lead');
        for (var click = 0; click < 2; click++) {
          await tester.tap(empty);
          await tester.pumpAndSettle();
          expect(controller.selectedId, 'empty-lead');
          expect(find.text('No workgroups yet'), findsNothing);
        }

        // The plain rows retain keyboard operation and do not create tabs.
        Focus.of(tester.element(find.text('Decisions'))).requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(openedActivity, 1);
        await tester.tap(find.byTooltip('New project'));
        await tester.pumpAndSettle();
        expect(created, 1);
        final tabsBefore = app.swarms.length;
        Focus.of(tester.element(find.text('Manage'))).requestFocus();
        await tester.pump();
        await tester.sendKeyEvent(LogicalKeyboardKey.enter);
        await tester.pumpAndSettle();
        expect(openedManage, 1);
        expect(controller.devicesSelected, isTrue);
        expect(controller.selectedId, 'empty-lead');
        expect(app.swarms, hasLength(tabsBefore));
        expect(
          rowMaterial(tester, 'super-manage').color,
          grid.AppSurface.selectedFill,
        );
        expect(
          rowMaterial(tester, 'super-group-empty-lead').color,
          Colors.transparent,
        );

        // Returning to the already selected chat still leaves it.
        await tester.tap(empty);
        await tester.pumpAndSettle();
        expect(controller.devicesSelected, isFalse);
        expect(controller.selectedId, 'empty-lead');
        expect(
          rowMaterial(tester, 'super-group-empty-lead').color,
          grid.AppSurface.selectedFill,
        );
        expect(rowMaterial(tester, 'super-manage').color, Colors.transparent);
        expect(tester.takeException(), isNull);
        await disposeSidebar(tester, controller);
      },
    );
  }

  testWidgets('project A to Z ignores # and stays fixed after new activity', (
    tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final server = ConversationServer();
    final controller = await projectSidebar(server);
    server.state['projects'] = [
      projectFixture('lead', '# Zebra', 'lead'),
      projectFixture('empty', 'alpha', 'empty-lead'),
    ];
    await controller.refresh();
    await pumpSidebar(tester, controller, app);
    for (final updated in [false, true]) {
      if (updated) {
        final lead = (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>()
            .firstWhere((c) => c['id'] == 'lead');
        lead['lastMessageSequence'] = 99;
        lead['changedAt'] = DateTime.utc(2030).millisecondsSinceEpoch;
        await controller.refresh();
        await tester.pumpAndSettle();
      }
      expect(
        tester.getTopLeft(find.byKey(const ValueKey('super-project-empty'))).dy,
        lessThan(
          tester
              .getTopLeft(find.byKey(const ValueKey('super-project-lead')))
              .dy,
        ),
      );
      expect(superTabSidebarOrder(controller).take(2), ['empty-lead', 'lead']);
    }
    expect(tester.takeException(), isNull);
    await disposeSidebar(tester, controller);
  });

  testWidgets('reads like a chat app: Activity, Projects A to Z, Buddies, '
      'then Manage; no # product-managers, no tasks', (tester) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final server = ConversationServer();
    // An older server still sends the Leads conversation; it is gone
    // (Dee, 2026-10-31).
    (server.state['conversations'] as List).add({
      ...conversationFixture('leads', 'Leads'),
      'kind': 'leads',
    });
    server.state['leadsConversationId'] = 'leads';
    final controller = await projectSidebar(server);
    await pumpSidebar(tester, controller, app);

    final order = [
      find.byKey(const ValueKey('super-decisions')),
      find.text('Projects'),
      find.byKey(const ValueKey('super-group-empty-lead')),
      find.byKey(const ValueKey('super-group-lead')),
      find.text('Buddies'),
      find.byKey(const ValueKey('super-buddy-lead')),
      find.byKey(const ValueKey('super-buddy-empty')),
      find.byKey(const ValueKey('super-manage')),
    ];
    for (var i = 1; i < order.length; i++) {
      expect(
        tester.getTopLeft(order[i - 1]).dy,
        lessThan(tester.getTopLeft(order[i]).dy),
        reason: '${order[i - 1]} above ${order[i]}',
      );
    }
    for (final (key, name, isPrivate) in [
      ('empty-lead', 'sample-project', true),
      ('lead', 'web-project', false),
    ]) {
      expect(
        inRow(
          'super-group-$key',
          isPrivate ? find.byIcon(AppIcons.lock) : find.text('#'),
        ),
        findsOneWidget,
      );
      expect(inRow('super-group-$key', find.text(name)), findsOneWidget);
    }
    expect(find.byKey(const ValueKey('super-group-leads')), findsNothing);
    expect(find.text('product-managers'), findsNothing);
    // Tasks are in each project's Tasks view (task #2569).
    expect(find.byKey(const ValueKey('super-group-offline')), findsNothing);
    expect(find.text('No workgroups yet'), findsNothing);
    expect(
      inRow('super-buddy-lead', find.text('(web-project)')),
      findsOneWidget,
    );
    expect(tester.takeException(), isNull);
    await disposeSidebar(tester, controller);
  });

  testWidgets('section disclosure follows its label and the +s line up', (
    tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final controller = await projectSidebar(ConversationServer());
    for (final width in [180.0, 280.0, 420.0]) {
      await pumpSidebar(tester, controller, app, width: width);
      // Projects no longer folds (task #2996); Buddies does.
      for (final title in ['Buddies']) {
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
          tester.getCenter(find.byTooltip('Add a Buddy')).dx,
        );
      }
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
            final reason = '$width px, ${scale}x, unreachable=$unreachable';
            await pumpSidebar(
              tester,
              controller,
              app,
              width: width,
              scale: scale,
            );
            expect(tester.takeException(), isNull, reason: reason);
            expect(find.text('Manage'), findsOneWidget, reason: reason);

            await pumpMachines(
              tester,
              controller,
              app,
              width: width,
              scale: scale,
              now: now,
            );
            expect(tester.takeException(), isNull, reason: reason);
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
      await disposeSidebar(tester, controller);
    },
  );

  testWidgets('Manage\'s Machines read a live app change when the workspace '
      'rebuilds', (tester) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.binding.setSurfaceSize(const Size(800, 700));
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
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        home: Scaffold(
          // The workspace rebuilds on the app; the next test holds it to that.
          body: ListenableBuilder(
            listenable: app,
            builder: (context, _) => SuperTabManagePage(
              controller: controller,
              app: app,
              tab: SuperTabManageTab.machines,
              onAddAgent: (_) {},
              readLocal: (_) async => const MachineResources(cpuPercent: 10),
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    await tester.pump();
    await tester.pump();
    final entry = find.byKey(const ValueKey('super-machine-entry-m'));
    expect(
      find.descendant(of: entry, matching: find.text('offline')),
      findsNothing,
    );

    await app.handleEventForTest('m', {'type': 'node_status', 'online': false});
    await tester.pump();
    expect(find.byKey(const ValueKey('super-machine-m')), findsOneWidget);
    expect(
      find.descendant(of: entry, matching: find.text('offline')),
      findsOneWidget,
    );
    await disposeSidebar(tester, controller);
  });

  testWidgets(
    'the workspace rebuilds Manage\'s Machines on a live app change',
    (tester) async {
      final f = SuperTabLaunchFixture();
      f.app.bindSuperTab(f.app.activeSwarmId, tabId, 'Pilot');
      final c = await f.app.superTabs.open(tabId);
      await c.refresh();
      final map = MemoryKeymap();
      addTearDown(map.dispose);
      final projects = SwarmProjectStore();
      addTearDown(projects.dispose);
      tester.view.devicePixelRatio = 1;
      tester.view.physicalSize = const Size(1280, 800);
      addTearDown(tester.view.resetPhysicalSize);
      addTearDown(tester.view.resetDevicePixelRatio);
      await tester.pumpWidget(
        MaterialApp(
          builder: (context, child) =>
              KeymapProvider(keymap: map, child: child!),
          home: SwarmScreen(
            notifier: f.app,
            nativeTabs: false,
            projectStore: projects,
          ),
        ),
      );
      await tester.pumpAndSettle();
      await tester.tap(find.byKey(const ValueKey('super-manage')));
      await tester.pumpAndSettle();
      final machines = find.byType(SuperTabMachines);
      final before = tester.widget(machines);
      await f.app.handleEventForTest('m', {
        'type': 'node_status',
        'online': false,
      });
      await tester.pump();
      expect(tester.widget(machines), isNot(same(before)));
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      f.dispose();
    },
  );

  testWidgets('section collapse persists and keeps top navigation available', (
    tester,
  ) async {
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final server = ConversationServer();
    final controller = await projectSidebar(server);
    await pumpSidebar(tester, controller, app);
    final buddy = find.byKey(const ValueKey('super-buddy-lead'));
    expect(inRow('super-group-lead', find.text('web-project')), findsOneWidget);
    expect(buddy, findsOneWidget);

    // Projects no longer folds (anh Dee, 11-05, task #2996).
    expect(find.byTooltip('Collapse Projects'), findsNothing);
    await tester.tap(find.byTooltip('Collapse Buddies'));
    await tester.pumpAndSettle();
    expect(buddy, findsNothing);
    expect(controller.buddiesGroupOpen, isFalse);
    expect(find.text('Decisions'), findsOneWidget);
    expect(find.text('Manage'), findsOneWidget);

    await controller.flush();
    final saved = server.saved!;
    expect(saved['buddiesGroupOpen'], isFalse);
    final reopened = server.controller(initial: saved);
    await reopened.refresh();
    expect(reopened.buddiesGroupOpen, isFalse);

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
            body: SuperTabManagePage(
              controller: c,
              tab: SuperTabManageTab.models,
              onAddAgent: (_) {},
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
        expect(find.text('Your models…'), findsOneWidget);
        await tester.tap(open);
        await tester.pumpAndSettle();
        // The page is titled as the action that opens it.
        expect(find.text('Your models'), findsOneWidget);
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

    test('lists only fresh readings, once per machine, and none while the add-on is off', () {
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
          machineId: 'b',
          machine: 'A machine',
          kind: 'local',
        ),
        (
          grid: 'team',
          model: 'n',
          name: 'n',
          machineId: 'b',
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
    });
  });
}
