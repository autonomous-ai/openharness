import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/core/relative_time.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/agent_details.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/roster.dart';
import 'package:harness/widgets/engine_identity.dart';
import 'package:harness/widgets/harness_activity_mark.dart';

import 'harness_activity_test.dart' show activityQuestion;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

class RosterFixture {
  RosterFixture({this.account = 'owner'});
  final String account;
  final app = createApp(connected: true);
  final server = ConversationServer();
  late final controller = server.controller(account: account);
  SuperTabAgent? opened;
  SuperTabConversation? added;
  final boundary = GlobalKey();
  bool disposed = false;

  Future<void> initialize() async {
    if (account != 'owner') {
      (server.state['people'] as List).add({
        'id': account,
        'email': '$account@example.com',
        'role': 'collaborator',
      });
    }
    server.state['projects'] = [
      projectFixture('lead', 'openharness', 'lead'),
      projectFixture('os', 'autonomous-os', 'os-lead'),
    ];
    server.state['agents'] = [
      for (var i = 0; i < 4; i++)
        {
          'id': 'agent-$i',
          'projectId': i == 2 ? 'os' : 'lead',
          'name': ['Lead', 'Multiply', 'Lead', 'Divide'][i],
          'displayName': ['Atlas', 'Sage', 'Nova', 'Finn'][i],
          'machineId': 'm',
          'harnessId': 'a$i',
          'contributorId': 'owner',
          'configuration': {'engine': i == 1 ? 'claude' : 'codex'},
        },
    ];
    (server.state['conversations'] as List)[0]['leadId'] = 'agent-0';
    (server.state['conversations'] as List).add({
      ...conversationFixture('os-lead', 'Lead'),
      'projectId': 'os',
      'leadId': 'agent-2',
    });
    await controller.refresh();
  }

  Future<void> show(
    WidgetTester tester, {
    bool nativeState = true,
    Brightness brightness = Brightness.dark,
    double scale = 1,
  }) async {
    await tester.pumpWidget(
      RepaintBoundary(
        key: boundary,
        child: MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          builder: (context, child) => MediaQuery(
            data: MediaQuery.of(context).copyWith(
              textScaler: TextScaler.linear(scale),
              highContrast: scale > 1,
              disableAnimations: true,
            ),
            child: child!,
          ),
          home: Scaffold(
            body: SuperTabRoster(
              controller: controller,
              app: nativeState ? app : null,
              onInvite: () {},
              onAddAgent: (group) => added = group,
              onAnswer: (_) {},
              onOpenAgent: (agent) => opened = agent,
            ),
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
  }

  Finder row(int i) => find.byKey(ValueKey('super-member-agent-$i'));
  Finder inRow(int i, Finder child) =>
      find.descendant(of: row(i), matching: child);

  /// The row's one line: state, machine, model and effort (team glance, 2026-10-27).
  Finder line(int i) => find.byKey(ValueKey('super-member-line-agent-$i'));
  String lineText(WidgetTester tester, int i) =>
      tester.widget<Text>(line(i)).data!;
  HarnessActivity activity(WidgetTester tester, int i) =>
      tester.widget<ActivityMark>(inRow(i, find.byType(ActivityMark))).activity;

  void dispose() {
    if (disposed) return;
    disposed = true;
    controller.dispose();
    app.dispose();
  }

  Future<void> close(WidgetTester tester) async {
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    dispose();
  }
}

void main() {
  final captureDir = Platform.environment['HARNESS_ROSTER_CAPTURE_DIR'];
  setUpAll(() async {
    await loadCaptureFonts(captureDir);
    if (captureDir != null && Platform.isMacOS) {
      for (final font in [
        ('.AppleSystemUIFontMonospaced', '/System/Library/Fonts/SFNSMono.ttf'),
        ('Menlo', '/System/Library/Fonts/Menlo.ttc'),
        ('Apple Symbols', '/System/Library/Fonts/Apple Symbols.ttf'),
      ]) {
        final bytes = ByteData.sublistView(await File(font.$2).readAsBytes());
        await (FontLoader(font.$1)..addFont(Future.value(bytes))).load();
      }
    }
  });

  Future<RosterFixture> fixture(
    WidgetTester tester, {
    String account = 'owner',
  }) async {
    await tester.binding.setSurfaceSize(const Size(280, 700));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final f = RosterFixture(account: account);
    await f.initialize();
    addTearDown(f.dispose);
    return f;
  }

  Future<void> openRemoval(
    WidgetTester tester,
    RosterFixture f, {
    int agent = 1,
  }) async {
    await tester.tap(f.row(agent), buttons: kSecondaryMouseButton);
    await tester.pumpAndSettle();
    await tester.tap(find.text('Remove from Swarm'));
    await tester.pumpAndSettle();
  }

  String rowTooltip(WidgetTester tester, RosterFixture f, int agent) => tester
      .widgetList<Tooltip>(
        find.ancestor(of: f.row(agent), matching: find.byType(Tooltip)),
      )
      .single
      .message!;

  testWidgets(
    'an agent whose screen showed a usage limit reads "Limited until" its reset, in local time, until it passes',
    (tester) async {
      final f = await fixture(tester);
      final agents = f.server.state['agents'] as List;
      // Working on a task, so its status would otherwise say so.
      (f.server.state['conversations'] as List)[1]['assignment'] = {
        'agentId': 'agent-1',
        'status': 'working',
      };
      agents[1]['limitedUntil'] = DateTime(
        2099,
        1,
        2,
        9,
        5,
      ).toUtc().toIso8601String();
      await f.controller.refresh();
      await f.show(tester);
      expect(f.lineText(tester, 1), 'Limited until 09:05 · Test host');
      expect(rowTooltip(tester, f, 1), contains('Limited until 09:05'));
      await captureBoundary(
        tester,
        f.boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary,
        captureDir,
        'roster-limited',
      );
      // A reset already past, or none, is no limit.
      for (final until in [DateTime(2000).toUtc().toIso8601String(), null]) {
        if (until == null) {
          (agents[1] as Map).remove('limitedUntil');
        } else {
          agents[1]['limitedUntil'] = until;
        }
        await f.controller.refresh();
        await tester.pumpAndSettle();
        expect(find.textContaining('Limited until'), findsNothing);
        expect(f.lineText(tester, 1), 'Assigned · Test host');
        expect(
          rowTooltip(tester, f, 1),
          contains('Assigned to "Offline editing"'),
        );
      }
      await f.close(tester);
    },
  );

  testWidgets(
    'agent tooltip combines known model, machine, task and activity',
    (tester) async {
      final f = await fixture(tester);
      final lastActive = DateTime.now().subtract(const Duration(hours: 2));
      (f.server.state['agents'] as List)[1]['configuration'] = {
        'engine': 'claude',
        'model': 'opus',
      };
      (f.server.state['conversations'] as List)[1]['assignment'] = {
        'agentId': 'agent-1',
        'status': 'working',
      };
      f.app.stateOf('m')!.agents = [
        Agent(
          id: 'a1',
          name: 'Multiply',
          engine: 'claude',
          lastActivityAt: lastActive,
        ),
      ];
      f.app.stateOf('m')!.processingAgentIds.add('a1');
      await f.controller.refresh();
      await f.show(tester);
      expect(
        rowTooltip(tester, f, 1),
        contains(
          'Claude opus · Test host · Working on "Offline editing" · Last active 2 hours ago',
        ),
      );
      expect(
        rowTooltip(tester, f, 1),
        contains('Sage · Engineer · openharness'),
      );
      expect(f.lineText(tester, 1), 'Working · Test host · opus unknown');
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(f.row(1)));
      await tester.pumpAndSettle(const Duration(milliseconds: 800));
      expect(find.text(rowTooltip(tester, f, 1)), findsOneWidget);
      await mouse.removePointer();
      await f.close(tester);
    },
  );

  testWidgets('agent tooltip omits data that neither state nor host knows', (
    tester,
  ) async {
    final f = await fixture(tester);
    await f.show(tester, nativeState: false);
    expect(
      rowTooltip(tester, f, 0),
      contains('Atlas · Product Manager · openharness'),
    );
    expect(rowTooltip(tester, f, 0), contains('Codex'));
    // No native state and no task: idle as far as the Swarm's work goes; the tooltip says what is not known.
    expect(f.lineText(tester, 0), 'Idle');
    expect(rowTooltip(tester, f, 0), contains('Status unavailable'));
    expect(rowTooltip(tester, f, 0), isNot(contains('Last active')));
    await tester.tap(f.row(0));
    await tester.pumpAndSettle();
    for (final absent in [
      'Model',
      'Task',
      'Latest PR',
      'Machine',
      'Working folder',
      'Permission mode',
      'Started',
      'Who can answer',
    ]) {
      expect(find.text(absent), findsNothing);
    }
    await f.close(tester);
  });

  testWidgets('agent tooltip keeps native input need above active work', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['conversations'] as List)[1]['assignment'] = {
      'agentId': 'agent-1',
      'status': 'working',
    };
    f.app.stateOf('m')!.agents = const [
      Agent(
        id: 'a1',
        name: 'Multiply',
        engine: 'claude',
        launchState: 'failed',
        launchError: 'RESUME_UNCONFIRMED',
      ),
    ];
    await f.controller.refresh();
    await f.show(tester);
    expect(f.activity(tester, 1), HarnessActivity.needsInput);
    expect(f.lineText(tester, 1), 'Waiting · Test host');
    expect(rowTooltip(tester, f, 1), contains('Needs input'));
    expect(rowTooltip(tester, f, 1), isNot(contains('Working on')));
    await f.close(tester);
  });

  testWidgets(
    'a one-line activity keeps its full task title available on hover',
    (tester) async {
      final f = await fixture(tester);
      await tester.binding.setSurfaceSize(const Size(1000, 700));
      final title = 'A long task title ' * 12;
      (f.server.state['conversations'] as List)[1]
        ..['title'] = title
        ..['assignment'] = {'agentId': 'agent-1', 'status': 'working'};
      f.app.stateOf('m')!.processingAgentIds.add('a1');
      await f.controller.refresh();
      await f.show(tester);
      final tooltip = rowTooltip(tester, f, 1);
      expect(tooltip, contains(title));
      expect(f.lineText(tester, 1), 'Working · Test host');
      expect(tester.getSize(f.line(1)).height, lessThan(30));
      final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
      await mouse.addPointer(location: Offset.zero);
      await mouse.moveTo(tester.getCenter(f.row(1)));
      await tester.pumpAndSettle(const Duration(milliseconds: 800));
      final text = find.text(tooltip);
      expect(text, findsOneWidget);
      expect(tester.getSize(text).width, lessThanOrEqualTo(820));
      await mouse.removePointer();
      await f.close(tester);
    },
  );

  testWidgets('agent details link the held task and latest group PR', (
    tester,
  ) async {
    final f = await fixture(tester);
    final started = DateTime.utc(2026, 10, 21, 9, 15);
    (f.server.state['conversations'] as List)[1]['assignment'] = {
      'agentId': 'agent-1',
      'status': 'working',
    };
    f.server.append(
      'Earlier PR https://github.com/acme/project/pull/41',
      conversationId: 'offline',
    );
    f.server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'agent-1',
      'name': 'Multiply',
    };
    f.server.append(
      'Current PR https://github.com/acme/project/pull/42',
      conversationId: 'offline',
    );
    f.server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'agent-1',
      'name': 'Multiply',
    };
    f.app.stateOf('m')!.agents = [
      Agent(
        id: 'a1',
        name: 'Multiply',
        engine: 'claude',
        project: const AgentProject(name: 'project', cwd: '/work/project'),
        permissionMode: 'auto',
        createdAt: started,
      ),
    ];
    await f.controller.refresh();
    await f.show(tester);
    await tester.tap(f.row(1));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
    expect(find.widgetWithText(TextButton, 'Offline editing'), findsOneWidget);
    expect(
      find.byTooltip('https://github.com/acme/project/pull/42'),
      findsOneWidget,
    );
    expect(
      find.byTooltip('https://github.com/acme/project/pull/41'),
      findsNothing,
    );
    expect(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Test host'),
      ),
      findsOneWidget,
    );
    expect(find.text('/work/project'), findsOneWidget);
    expect(find.text('Auto-approve'), findsOneWidget);
    expect(find.text(fullDateTime(started)), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Offline editing'));
    await tester.pumpAndSettle();
    expect(f.controller.selectedId, 'offline');
    expect(find.byType(AlertDialog), findsNothing);
    await f.close(tester);
  });

  testWidgets('current task result PR beats older group messages', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['conversations'] as List)[1]['assignment'] = {
      'agentId': 'agent-1',
      'status': 'working',
      'result': 'https://github.com/acme/project/pull/42',
    };
    f.server.append(
      'Old PR https://github.com/acme/project/pull/41',
      conversationId: 'offline',
    );
    await f.controller.refresh();
    await f.show(tester);
    await tester.tap(f.row(1));
    await tester.pumpAndSettle();
    expect(
      find.byTooltip('https://github.com/acme/project/pull/42'),
      findsOneWidget,
    );
    expect(
      find.byTooltip('https://github.com/acme/project/pull/41'),
      findsNothing,
    );
    await f.close(tester);
  });

  testWidgets('details find a PR in older group message pages', (tester) async {
    final f = await fixture(tester);
    (f.server.state['conversations'] as List)[1]['assignment'] = {
      'agentId': 'agent-1',
      'status': 'working',
    };
    f.server.append(
      'PR https://github.com/acme/project/pull/42',
      conversationId: 'offline',
    );
    f.server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'agent-1',
      'name': 'Multiply',
    };
    for (var i = 0; i < 105; i++) {
      f.server.append('Update $i', conversationId: 'offline');
    }
    await f.controller.refresh();
    await f.show(tester);
    await tester.tap(f.row(1));
    await tester.pumpAndSettle();
    expect(
      find.byTooltip('https://github.com/acme/project/pull/42'),
      findsOneWidget,
    );
    await f.close(tester);
  });

  testWidgets('details ignore another agent’s later PR in the same group', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['conversations'] as List)[1]['assignment'] = {
      'agentId': 'agent-1',
      'status': 'working',
    };
    f.server.append(
      'My PR https://github.com/acme/project/pull/42',
      conversationId: 'offline',
    );
    f.server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'agent-1',
      'name': 'Multiply',
    };
    f.server.append(
      'Other PR https://github.com/acme/project/pull/43',
      conversationId: 'offline',
    );
    f.server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'agent-3',
      'name': 'Divide',
    };
    await f.controller.refresh();
    await f.show(tester);
    await tester.tap(f.row(1));
    await tester.pumpAndSettle();
    expect(
      find.byTooltip('https://github.com/acme/project/pull/42'),
      findsOneWidget,
    );
    expect(
      find.byTooltip('https://github.com/acme/project/pull/43'),
      findsNothing,
    );
    await f.close(tester);
  });

  testWidgets('details stop paging when no PR belongs to this agent', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['conversations'] as List)[1]['assignment'] = {
      'agentId': 'agent-1',
      'status': 'working',
    };
    f.server.append(
      'Other PR https://github.com/acme/project/pull/43',
      conversationId: 'offline',
    );
    f.server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'agent-3',
      'name': 'Divide',
    };
    for (var i = 0; i < 350; i++) {
      f.server.append('Update $i', conversationId: 'offline');
    }
    await f.controller.refresh();
    await f.show(tester);
    await tester.tap(f.row(1));
    await tester.pumpAndSettle();
    expect(find.text('Latest PR'), findsNothing);
    expect(f.controller.messages('offline').length, 300);
    expect(f.controller.hasOlder('offline'), isTrue);
    await f.close(tester);
  });

  testWidgets('unknown permission mode gets plain wording', (tester) async {
    final f = await fixture(tester);
    f.app.stateOf('m')!.agents = const [
      Agent(
        id: 'a1',
        name: 'Multiply',
        engine: 'claude',
        permissionMode: 'unmapped-mode-id',
      ),
    ];
    (f.server.state['agents'] as List)[1]['configuration'] = {
      'engine': 'claude',
      'contextWindow': 200000,
      'engineVersion': '1.0',
    };
    await f.controller.refresh();
    await f.show(tester);
    await tester.tap(f.row(1));
    await tester.pumpAndSettle();
    expect(find.text('Unrecognized setting'), findsOneWidget);
    expect(find.text('unmapped-mode-id'), findsNothing);
    expect(find.text('Agent name'), findsOneWidget);
    expect(find.text('Harness'), findsNothing);
    expect(find.text('Context'), findsNothing);
    expect(find.text('Version'), findsNothing);
    await f.close(tester);
  });

  testWidgets(
    'question details name the machine owner only for an on-screen question',
    (tester) async {
      final f = await fixture(tester);
      (f.server.state['conversations'] as List)[1]['assignment'] = {
        'agentId': 'agent-1',
        'status': 'needs_human',
        'execution': {'machineOwnerId': 'owner'},
      };
      f.app.stateOf('m')!.blockedAgents['a1'] = activityQuestion('a1');
      await f.controller.refresh();
      await f.show(tester);
      expect(
        rowTooltip(tester, f, 1),
        contains('Waiting for a person to answer'),
      );
      await tester.tap(f.row(1));
      await tester.pumpAndSettle();
      expect(find.text('Who can answer'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.text('owner'),
        ),
        // The Owner row and Who can answer both name the machine owner.
        findsNWidgets(2),
      );
      await tester.tap(find.widgetWithText(TextButton, 'Close'));
      await tester.pumpAndSettle();
      f.app.stateOf('m')!.blockedAgents.clear();
      await f.show(tester);
      await tester.tap(f.row(1));
      await tester.pumpAndSettle();
      expect(find.text('Who can answer'), findsNothing);
      await f.close(tester);
    },
  );

  group('agent details Owner', () {
    Future<void> openDetails(WidgetTester tester, RosterFixture f) async {
      await f.show(tester);
      await tester.tap(f.row(1));
      await tester.pumpAndSettle();
    }

    Finder inDialog(String text) => find.descendant(
      of: find.byType(AlertDialog),
      matching: find.text(text),
    );

    testWidgets('names a teammate who owns the machine, under Machine', (
      tester,
    ) async {
      final f = await fixture(tester, account: 'ann');
      (f.server.state['agents'] as List)[1]['machineOwnerId'] = 'ann';
      await f.controller.refresh();
      await openDetails(tester, f);
      expect(inDialog('Owner'), findsOneWidget);
      expect(inDialog('ann'), findsOneWidget);
      expect(
        tester.getTopLeft(inDialog('Owner')).dy,
        greaterThan(tester.getTopLeft(inDialog('Machine')).dy),
      );
      await f.close(tester);
    });

    testWidgets('names the current user the same way', (tester) async {
      final f = await fixture(tester);
      (f.server.state['agents'] as List)[1]['machineOwnerId'] = 'owner';
      await f.controller.refresh();
      await openDetails(tester, f);
      expect(inDialog('Owner'), findsOneWidget);
      expect(inDialog('owner'), findsOneWidget);
      await f.close(tester);
    });

    testWidgets('hides the row when the owner is unknown', (tester) async {
      final f = await fixture(tester);
      (f.server.state['agents'] as List)[1]['machineOwnerId'] = 'ghost';
      await f.controller.refresh();
      await openDetails(tester, f);
      expect(inDialog('Machine'), findsOneWidget);
      expect(inDialog('Owner'), findsNothing);
      await f.close(tester);
    });
  });

  testWidgets('a replaced member keeps its identity and shows its new engine', (
    tester,
  ) async {
    final f = await fixture(tester);
    await f.show(tester);
    final agents = f.server.state['agents'] as List;
    agents[0]['harnessId'] = 'replacement';
    agents[0]['configuration'] = {'engine': 'claude', 'model': 'sonnet'};
    await f.controller.refresh();
    await tester.pumpAndSettle();
    expect(f.controller.snapshot!.agents.first.id, 'agent-0');
    expect(f.controller.snapshot!.agents.first.harnessId, 'replacement');
    expect(f.controller.snapshot!.agents.first.engine, 'claude');
    await tester.tap(f.row(0));
    await tester.pumpAndSettle();
    expect(find.text('Claude'), findsOneWidget);
    expect(find.text('sonnet'), findsOneWidget);
    await tester.tap(find.widgetWithText(TextButton, 'Close'));
    await tester.pumpAndSettle();
    await f.close(tester);
  });

  testWidgets(
    'owner confirms Remove from Swarm without stopping the native session',
    (tester) async {
      final f = await fixture(tester);
      f.app.stateOf('m')!.agents = const [
        Agent(id: 'a1', name: 'Multiply', engine: 'claude'),
      ];
      await f.show(tester);
      await openRemoval(tester, f);
      expect(find.text('Remove Sage from this Swarm?'), findsOneWidget);
      expect(
        find.descendant(
          of: find.byType(AlertDialog),
          matching: find.textContaining('Test host'),
        ),
        findsOneWidget,
      );
      expect(f.server.posts, isEmpty);
      expect(
        tester
            .widget<TextButton>(find.widgetWithText(TextButton, 'Cancel'))
            .autofocus,
        isTrue,
      );
      await tester.tap(find.widgetWithText(FilledButton, 'Remove from Swarm'));
      await tester.pumpAndSettle();
      expect(f.server.posts.single['command'], {
        'type': 'agent.remove',
        'agentId': 'agent-1',
      });
      expect(find.byType(AlertDialog), findsNothing);
      expect(f.app.stateOf('m')!.agents.single.id, 'a1');
      await f.close(tester);
    },
  );

  testWidgets('cancelling Remove from Swarm sends nothing', (tester) async {
    final f = await fixture(tester);
    await f.show(tester);
    await openRemoval(tester, f);
    await tester.tap(find.widgetWithText(TextButton, 'Cancel'));
    await tester.pumpAndSettle();
    expect(f.server.posts, isEmpty);
    expect(find.byType(AlertDialog), findsNothing);
    await f.close(tester);
  });

  testWidgets('project Product Manager cannot be removed from the roster', (
    tester,
  ) async {
    final f = await fixture(tester);
    await f.show(tester);
    await tester.tap(f.row(0), buttons: kSecondaryMouseButton);
    await tester.pumpAndSettle();
    final remove = find.widgetWithText(
      PopupMenuItem<String>,
      'Remove from Swarm',
    );
    expect(remove, findsOneWidget);
    expect(tester.widget<PopupMenuItem<String>>(remove).enabled, isFalse);
    expect(
      find.text(
        'Atlas is the Product Manager of project openharness. Delete the project first.',
      ),
      findsOneWidget,
    );
    expect(f.server.posts, isEmpty);
    await f.close(tester);
  });

  testWidgets(
    'Remove from Swarm is hidden from unrelated people and shown for their own contribution',
    (tester) async {
      final f = await fixture(tester, account: 'peer');
      await f.show(tester);
      await tester.tap(f.row(1), buttons: kSecondaryMouseButton);
      await tester.pumpAndSettle();
      expect(find.text('Remove from Swarm'), findsNothing);
      expect(find.text('Details'), findsOneWidget);
      await tester.sendKeyEvent(LogicalKeyboardKey.escape);
      await tester.pumpAndSettle();
      (f.server.state['agents'] as List)[1]['contributorId'] = 'peer';
      await f.controller.refresh();
      await tester.pumpAndSettle();
      await openRemoval(tester, f);
      await tester.tap(find.widgetWithText(FilledButton, 'Remove from Swarm'));
      await tester.pumpAndSettle();
      expect(f.server.posts.single['command'], {
        'type': 'agent.remove',
        'agentId': 'agent-1',
      });
      await f.close(tester);
    },
  );

  testWidgets('Remove from Swarm keeps the server refusal visible', (
    tester,
  ) async {
    final f = await fixture(tester);
    f.server.refuse = {
      'code': 'FORBIDDEN',
      'message': 'Only its contributor can remove this agent.',
    };
    await f.show(tester);
    await openRemoval(tester, f);
    await tester.tap(find.widgetWithText(FilledButton, 'Remove from Swarm'));
    await tester.pumpAndSettle();
    expect(
      find.text('Only its contributor can remove this agent.'),
      findsOneWidget,
    );
    expect(find.byType(AlertDialog), findsOneWidget);
    await f.close(tester);
  });

  testWidgets(
    'Remove from Swarm retries a lost reply with the same operation',
    (tester) async {
      final f = await fixture(tester);
      f.server.loseReply = true;
      await f.show(tester);
      await openRemoval(tester, f);
      await tester.tap(find.widgetWithText(FilledButton, 'Remove from Swarm'));
      await tester.pumpAndSettle();
      expect(f.controller.hasPendingAction, isTrue);
      (f.server.state['agents'] as List).removeWhere(
        (a) => a['id'] == 'agent-1',
      );
      await f.controller.refresh();
      await tester.pumpAndSettle();
      await tester.tap(find.widgetWithText(FilledButton, 'Retry'));
      await tester.pumpAndSettle();
      expect(f.server.posts, hasLength(2));
      expect(f.server.posts[1], f.server.posts[0]);
      expect(find.byType(AlertDialog), findsNothing);
      await f.close(tester);
    },
  );

  testWidgets('Remove from Swarm cannot submit after access is revoked', (
    tester,
  ) async {
    final f = await fixture(tester);
    await f.show(tester);
    await openRemoval(tester, f);
    f.controller.revokeAccess('Access removed');
    await tester.pumpAndSettle();
    expect(
      find.widgetWithText(FilledButton, 'Remove from Swarm'),
      findsNothing,
    );
    expect(f.server.posts, isEmpty);
    await f.close(tester);
  });

  testWidgets('an agent row shows its engine icon, not its project name', (
    tester,
  ) async {
    final f = await fixture(tester);
    await f.show(tester);
    EngineMark mark(int i) =>
        tester.widget<EngineMark>(f.inRow(i, find.byType(EngineMark)));
    expect(mark(0).engine, 'codex');
    expect(mark(1).engine, 'claude');
    expect(f.inRow(1, find.text('openharness')), findsNothing);
    f.controller.select('os-lead');
    await tester.pumpAndSettle();
    expect(f.inRow(2, find.text('autonomous-os')), findsNothing);
    await f.close(tester);
  });

  testWidgets('a reviewer reads Rev; an agent without a role stays Dev', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['agents'] as List)[1]['role'] = 'reviewer';
    await f.controller.refresh();
    await f.show(tester);
    expect(f.inRow(1, find.text('Rev')), findsOneWidget);
    expect(
      f.inRow(
        1,
        find.byWidgetPredicate(
          (w) => w is Semantics && w.properties.label == 'Reviewer',
        ),
      ),
      findsOneWidget,
    );
    expect(f.inRow(1, find.text('Dev')), findsNothing);
    expect(f.inRow(3, find.text('Dev')), findsOneWidget);
    expect(f.inRow(0, find.text('PM')), findsOneWidget);
    await f.close(tester);
  });

  testWidgets('custom role name appears in the roster and agent details', (
    tester,
  ) async {
    final f = await fixture(tester);
    final project = (f.server.state['projects'] as List).first as Map;
    project['skillSet'] = 'custom';
    project['roles'] = [
      {
        'id': 'lead',
        'name': 'Product Manager',
        'kind': 'lead',
        'version': 'v1',
      },
      {
        'id': 'research',
        'name': 'Research Engineer',
        'kind': 'builder',
        'version': 'v1',
      },
    ];
    (f.server.state['agents'] as List)[1]['roleId'] = 'research';
    await f.controller.refresh();
    await f.show(tester);
    expect(f.inRow(1, find.text('Research Engineer')), findsOneWidget);
    expect(f.inRow(1, find.text('Dev')), findsNothing);
    final details = showSuperTabAgentDetails(
      tester.element(f.row(1)),
      f.controller,
      f.app,
      f.controller.snapshot!.agent('agent-1')!,
      (_) {},
    );
    await tester.pumpAndSettle();
    expect(find.text('Research Engineer'), findsWidgets);
    await tester.tap(find.widgetWithText(TextButton, 'Close'));
    await tester.pumpAndSettle();
    await details;
    await f.close(tester);
  });

  Future<RosterFixture> fixtureWithPeople(
    WidgetTester tester,
    int count,
  ) async {
    final f = await fixture(tester);
    (f.server.state['people'] as List).addAll([
      for (var i = 1; i < count; i++)
        {'id': 'p$i', 'email': 'p$i@example.com', 'role': 'collaborator'},
    ]);
    await f.controller.refresh();
    await f.show(tester);
    return f;
  }

  Finder person(int i) =>
      find.byKey(ValueKey('super-person-${i == 0 ? 'owner' : 'p$i'}'));

  testWidgets('three people all show with no More row', (tester) async {
    final f = await fixtureWithPeople(tester, 3);
    for (var i = 0; i < 3; i++) {
      expect(person(i), findsOneWidget);
    }
    expect(find.textContaining('Show '), findsNothing);
    await f.close(tester);
  });

  testWidgets('eight people all show, with no More row', (tester) async {
    final f = await fixtureWithPeople(tester, 8);
    for (var i = 0; i < 8; i++) {
      expect(person(i), findsOneWidget);
    }
    expect(find.textContaining('Show '), findsNothing);
    await f.close(tester);
  });

  testWidgets('roster lists only the selected project’s agents', (
    tester,
  ) async {
    final f = await fixture(tester);
    await f.show(tester);
    for (final i in [0, 1, 3]) {
      expect(f.row(i), findsOneWidget);
      expect(f.inRow(i, find.byType(EngineMark)), findsOneWidget);
    }
    expect(f.row(2), findsNothing);

    f.controller.select('os-lead');
    await tester.pumpAndSettle();
    for (final i in [0, 1, 3]) {
      expect(f.row(i), findsNothing);
    }
    expect(f.row(2), findsOneWidget);
    expect(f.inRow(2, find.byType(EngineMark)), findsOneWidget);
    expect(f.inRow(2, find.text('PM')), findsOneWidget);

    f.controller.select('offline');
    await tester.pumpAndSettle();
    for (final i in [0, 1, 3]) {
      expect(f.row(i), findsOneWidget);
      expect(f.inRow(i, find.byType(EngineMark)), findsOneWidget);
    }
    expect(f.row(2), findsNothing);
    await f.close(tester);
  });

  testWidgets(
    'authorized roster stays stable across workgroups in one project',
    (tester) async {
      final f = await fixture(tester);
      f.app.stateOf('m')!.agents = const [
        Agent(
          id: 'a0',
          name: 'native',
          engine: 'codex',
          title: 'Join Super Tab roster',
        ),
        Agent(id: 'outside', name: 'Not in this Swarm', engine: 'codex'),
      ];
      (f.server.state['conversations'] as List).add({
        ...conversationFixture('os-work', 'OS work'),
        'projectId': 'os',
        'agentIds': ['agent-2'],
      });
      await f.controller.refresh();
      await f.show(tester);
      expect(f.row(2), findsNothing);
      for (final i in [0, 1, 3]) {
        expect(f.inRow(i, find.byType(SuperTabAvatar)), findsOneWidget);
        expect(f.inRow(i, find.text(i == 0 ? 'PM' : 'Dev')), findsOneWidget);
        expect(f.inRow(i, find.byType(EngineMark)), findsOneWidget);
      }
      expect(find.text('Join Super Tab roster'), findsNothing);
      expect(find.text('Not in this Swarm'), findsNothing);
      expect(find.text('Ready'), findsNothing);
      final nameX = tester.getTopLeft(f.inRow(0, find.text('Atlas'))).dx;
      final engine = tester.getRect(f.inRow(0, find.byType(EngineMark)));
      final name = tester.getRect(f.inRow(0, find.text('Atlas')));
      final status = tester.getRect(f.line(0));
      final mark = tester.getRect(f.inRow(0, find.byType(ActivityMark)));
      expect(engine.left, greaterThan(name.right));
      expect(engine.center.dy, closeTo(name.center.dy, 2));
      expect(mark.left, nameX);
      expect(status.left, greaterThan(mark.right));
      expect(status.top, greaterThanOrEqualTo(name.bottom));
      expect(tester.getSize(f.row(0)).height, lessThanOrEqualTo(60));
      expect(
        tester.getTopLeft(find.text('owner').first).dx,
        nameX,
        reason: 'People and agent identity use the same text column',
      );
      final rows = {
        for (final i in [0, 1, 3]) i: tester.getRect(f.row(i)),
      };
      final people = tester.getRect(find.text('owner'));
      for (final selected in ['lead', 'offline']) {
        f.controller.select(selected);
        await tester.pumpAndSettle();
        for (final i in [0, 1, 3]) {
          expect(tester.getRect(f.row(i)), rows[i]);
          expect(f.inRow(i, find.byType(ActivityMark)), findsOneWidget);
        }
        expect(tester.getRect(find.text('owner')), people);
        await tester.tap(find.byTooltip('Add agent'));
        expect(f.added?.id, selected);
      }
      f.controller.select('os-lead');
      await tester.pumpAndSettle();
      for (final i in [0, 1, 3]) {
        expect(f.row(i), findsNothing);
      }
      expect(f.inRow(2, find.byType(EngineMark)), findsOneWidget);
      f.controller.selectDevices();
      await tester.pumpAndSettle();
      expect(f.controller.devicesSelected, isTrue);
      expect(f.row(0), findsNothing);
      expect(f.row(2), findsOneWidget);
      expect(tester.getRect(find.text('owner')), people);
      f.controller.select('offline');
      await tester.pumpAndSettle();
      expect(
        tester.getTopLeft(f.row(0)).dy,
        lessThan(tester.getTopLeft(f.row(1)).dy),
      );
      expect(
        tester.getTopLeft(f.row(1)).dy,
        lessThan(tester.getTopLeft(f.row(3)).dy),
      );
      await tester.tap(f.row(1));
      await tester.pumpAndSettle();
      expect(find.byType(AlertDialog), findsOneWidget);
      await tester.tap(find.widgetWithText(FilledButton, 'Open terminal'));
      await tester.pumpAndSettle();
      expect(f.opened?.harnessId, 'a1');
      expect(f.controller.selectedId, 'offline');
      expect(f.server.posts, isEmpty);
      await f.close(tester);
    },
  );

  for (final legacyAgent in [1, 2]) {
    testWidgets(
      'an agent with no project uses its group project (agent $legacyAgent)',
      (tester) async {
        final f = await fixture(tester);
        (f.server.state['agents'] as List)[legacyAgent].remove('projectId');
        if (legacyAgent == 1) {
          (f.server.state['conversations'] as List).add({
            ...conversationFixture('os-work', 'OS work'),
            'projectId': 'os',
            'agentIds': ['agent-1'],
          });
        }
        await f.controller.refresh();
        // Other callers still see the legacy default even when the roster resolves the group.
        expect(
          f.controller.snapshot!.agent('agent-$legacyAgent')!.projectId,
          'lead',
        );
        await f.show(tester);
        expect(f.row(legacyAgent), findsNothing);
        f.controller.select('os-lead');
        await tester.pumpAndSettle();
        expect(f.inRow(legacyAgent, find.byType(EngineMark)), findsOneWidget);
        await f.close(tester);
      },
    );
  }

  testWidgets('an explicit agent project takes precedence over its group', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['conversations'] as List).add({
      ...conversationFixture('os-work', 'OS work'),
      'projectId': 'os',
      'agentIds': ['agent-1'],
    });
    await f.controller.refresh();
    await f.show(tester);
    expect(f.inRow(1, find.byType(EngineMark)), findsOneWidget);
    f.controller.select('os-lead');
    await tester.pumpAndSettle();
    expect(f.row(1), findsNothing);
    await f.close(tester);
  });

  testWidgets('no selected project still shows the authorized directory', (
    tester,
  ) async {
    final f = await fixture(tester);
    f.controller.selectedId = 'missing';
    await f.show(tester);
    for (var i = 0; i < 4; i++) {
      expect(f.row(i), findsOneWidget);
    }
    expect(find.text('owner'), findsOneWidget);
    expect(find.byTooltip('Add agent'), findsNothing);
    await f.close(tester);
  });

  testWidgets('assigned work is visible without invented activity durations', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['conversations'] as List)[1]
      ..['title'] = 'Polish navigation'
      ..['assignment'] = {'agentId': 'agent-1', 'status': 'planned'};
    await f.controller.refresh();
    await f.show(tester, nativeState: false);
    expect(f.lineText(tester, 1), 'Assigned');
    expect(
      rowTooltip(tester, f, 1),
      contains('Assigned to "Polish navigation"'),
    );
    expect(f.lineText(tester, 0), 'Idle');
    expect(f.activity(tester, 1), HarnessActivity.unknown);
    final copy = tester
        .widgetList<Text>(
          find.descendant(of: f.row(1), matching: find.byType(Text)),
        )
        .map((text) => text.data ?? '')
        .join(' ');
    expect(
      copy,
      isNot(matches(RegExp(r'\b\d+\s*(seconds?|minutes?|hours?|tokens?)\b'))),
    );
    expect(rowTooltip(tester, f, 1), isNot(contains('Last active')));
    await f.close(tester);
  });

  testWidgets(
    'retained working tasks need native activity before claiming work',
    (tester) async {
      final f = await fixture(tester);
      (f.server.state['conversations'] as List)[1]
        ..['title'] = 'Polish navigation'
        ..['assignment'] = {'agentId': 'agent-1', 'status': 'working'};
      await f.controller.refresh();
      final machine = f.app.stateOf('m')!;
      for (final activity in [
        HarnessActivity.idle,
        HarnessActivity.done,
        HarnessActivity.unknown,
        HarnessActivity.working,
      ]) {
        machine.processingAgentIds.clear();
        machine.unknownActivityAgentIds.clear();
        f.app.markAgentSeen('m', 'a1');
        switch (activity) {
          case HarnessActivity.done:
            f.app.agentUnread.mark('m', 'a1', AlertKind.done);
          case HarnessActivity.unknown:
            machine.unknownActivityAgentIds.add('a1');
          case HarnessActivity.working:
            machine.processingAgentIds.add('a1');
          default:
            break;
        }
        await f.show(tester);
        final status = activity == HarnessActivity.working
            ? 'Working on "Polish navigation"'
            : 'Assigned to "Polish navigation"';
        expect(f.activity(tester, 1), activity);
        expect(
          f.lineText(tester, 1),
          activity == HarnessActivity.working
              ? 'Working · Test host'
              : 'Assigned · Test host',
        );
        expect(rowTooltip(tester, f, 1), contains(status));
        if (activity != HarnessActivity.working) {
          expect(rowTooltip(tester, f, 1), isNot(contains('Working on')));
        }
      }
      await f.show(tester, nativeState: false);
      expect(f.activity(tester, 1), HarnessActivity.unknown);
      expect(f.lineText(tester, 1), 'Assigned');
      await f.close(tester);
    },
  );

  testWidgets('cancelled work cannot hide a later current assignment', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['conversations'] as List)[1]
      ..['title'] = 'Cancelled task'
      ..['assignment'] = {'agentId': 'agent-1', 'status': 'cancelled'};
    final currentTask = {
      ...conversationFixture('current-task', 'Polish navigation'),
      'assignment': {'agentId': 'agent-1', 'status': 'planned'},
    };
    (f.server.state['conversations'] as List).add(currentTask);
    await f.controller.refresh();
    await f.show(tester, nativeState: false);
    expect(f.lineText(tester, 1), 'Assigned');
    expect(
      rowTooltip(tester, f, 1),
      contains('Assigned to "Polish navigation"'),
    );
    expect(rowTooltip(tester, f, 1), isNot(contains('Cancelled task')));

    (currentTask['assignment'] as Map)['status'] = 'cancelled';
    await f.controller.refresh();
    await tester.pumpAndSettle();
    expect(f.lineText(tester, 1), 'Idle');
    expect(rowTooltip(tester, f, 1), isNot(contains('Polish navigation')));
    expect(rowTooltip(tester, f, 1), isNot(contains('Working on')));
    await f.close(tester);
  });

  testWidgets('explicit task states remain visible without a native turn', (
    tester,
  ) async {
    final f = await fixture(tester);
    for (final (status, activity, label, line) in [
      (
        'blocked',
        HarnessActivity.needsInput,
        'Needs input',
        'Stuck · Test host',
      ),
      (
        'review',
        HarnessActivity.idle,
        'Waiting for review on "Polish navigation"',
        'In review · Test host',
      ),
      (
        'reconciling',
        HarnessActivity.idle,
        'Checking "Polish navigation"',
        'Checking · Test host',
      ),
    ]) {
      (f.server.state['conversations'] as List)[1]
        ..['title'] = 'Polish navigation'
        ..['assignment'] = {'agentId': 'agent-1', 'status': status};
      await f.controller.refresh();
      await f.show(tester);
      expect(f.activity(tester, 1), activity);
      expect(f.lineText(tester, 1), line);
      expect(rowTooltip(tester, f, 1), contains(label));
      expect(rowTooltip(tester, f, 1), isNot(contains('Working on')));
    }
    await f.close(tester);
  });

  testWidgets('agent facts use native activity when no override is supplied', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['conversations'] as List)[1]
      ..['title'] = 'Polish navigation'
      ..['assignment'] = {'agentId': 'agent-1', 'status': 'working'};
    await f.controller.refresh();
    final machine = f.app.stateOf('m')!;
    final agent = f.controller.snapshot!.agent('agent-1')!;
    String? status() => SuperTabAgentInfo(f.controller, f.app, agent).status;
    expect(status(), 'Assigned to "Polish navigation"');
    machine.processingAgentIds.add('a1');
    expect(status(), 'Working on "Polish navigation"');
    machine.agents = const [
      Agent(id: 'a1', name: 'Sage', engine: 'claude', status: 'stopped'),
    ];
    expect(status(), 'Stopped');
    machine.connectionStatus = ConnectionStatus.disconnected;
    expect(status(), 'Offline');
    await f.close(tester);
  });

  testWidgets(
    'lifecycle status takes precedence over a retained working task',
    (tester) async {
      final f = await fixture(tester);
      (f.server.state['conversations'] as List)[1]['assignment'] = {
        'agentId': 'agent-1',
        'status': 'working',
      };
      await f.controller.refresh();
      final machine = f.app.stateOf('m')!;
      for (final (activity, status, line, data) in [
        (HarnessActivity.offline, 'Offline', 'Down', <String, dynamic>{}),
        (HarnessActivity.paused, 'Stopped', 'Stopped', {'status': 'stopped'}),
        (
          HarnessActivity.starting,
          'Starting',
          'Starting',
          {'launchState': 'starting'},
        ),
        (HarnessActivity.failed, 'Failed', 'Down', {'launchState': 'failed'}),
        (
          HarnessActivity.needsInput,
          'Needs input',
          'Waiting',
          {'launchState': 'failed', 'launchError': 'RESUME_UNCONFIRMED'},
        ),
      ]) {
        machine
          ..connectionStatus = activity == HarnessActivity.offline
              ? ConnectionStatus.disconnected
              : ConnectionStatus.connected
          ..agents = [
            Agent(
              id: 'a1',
              name: 'Sage',
              engine: 'claude',
              status: data['status'] as String? ?? 'active',
              launchState: data['launchState'] as String? ?? 'ready',
              launchError: data['launchError'] as String?,
            ),
          ];
        await f.show(tester);
        expect(f.activity(tester, 1), activity);
        expect(f.lineText(tester, 1), '$line · Test host');
        expect(rowTooltip(tester, f, 1), contains(status));
        expect(f.inRow(1, find.textContaining('Working')), findsNothing);
        expect(rowTooltip(tester, f, 1), isNot(contains('Working on')));
      }
      await f.close(tester);
    },
  );

  for (final width in [220.0, 280.0]) {
    for (final scale in [1.0, 2.0]) {
      testWidgets('agent identity and status fit $width pixels at ${scale}x', (
        tester,
      ) async {
        final f = await fixture(tester);
        await tester.binding.setSurfaceSize(Size(width, 700));
        const longName = 'Alexandria Montgomery';
        const longProject = 'an-extremely-long-project-identifier';
        (f.server.state['agents'] as List)[0]['displayName'] = longName;
        (f.server.state['projects'] as List)[0]['name'] = longProject;
        await f.controller.refresh();
        await f.show(tester, nativeState: false, scale: scale);
        final row = tester.getRect(f.row(0));
        final name = tester.getRect(f.inRow(0, find.text(longName)));
        final badgeFinder = f.inRow(0, find.text('PM'));
        final badge = tester.getRect(badgeFinder);
        final status = tester.getRect(f.line(0));
        final mark = tester.getRect(f.inRow(0, find.byType(ActivityMark)));
        expect(name.left, tester.getTopLeft(find.text('owner')).dx);
        expect(mark.left, name.left);
        expect(name.right, lessThan(badge.left));
        expect(status.top, greaterThanOrEqualTo(name.bottom));
        for (final bounds in [name, badge, status, mark]) {
          expect(bounds.left, greaterThanOrEqualTo(row.left));
          expect(bounds.right, lessThanOrEqualTo(row.right));
          expect(bounds.bottom, lessThanOrEqualTo(row.bottom));
        }
        expect(
          tester.renderObject<RenderParagraph>(badgeFinder).didExceedMaxLines,
          isFalse,
        );
        expect(
          tester.widget<Text>(badgeFinder).style!.fontSize,
          greaterThanOrEqualTo(12),
        );
        final tooltip = rowTooltip(tester, f, 0);
        for (final fact in [
          longName,
          'Product Manager',
          longProject,
          'Status unavailable',
        ]) {
          expect(tooltip, contains(fact));
        }
        expect(tester.takeException(), isNull);
        await f.close(tester);
      });
    }
  }

  testWidgets('live turns and unread changes update the same status cell', (
    tester,
  ) async {
    final f = await fixture(tester);
    await f.show(tester);
    expect(f.activity(tester, 0), HarnessActivity.idle);
    expect(f.inRow(0, find.text('○')), findsOneWidget);
    final mark = f.inRow(0, find.byType(ActivityMark));
    final position = tester.getTopLeft(mark);
    await f.app.handleEventForTest('m', {
      'type': 'turn_started',
      'agentId': 'a0',
    });
    await tester.pump();
    expect(f.activity(tester, 0), HarnessActivity.working);
    expect(f.inRow(0, find.text('○')), findsNothing);
    f.app.agentUnread.mark('m', 'a0', AlertKind.done);
    await tester.pump();
    expect(f.activity(tester, 0), HarnessActivity.working);
    await f.app.handleEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a0',
    });
    await tester.pump();
    expect(f.activity(tester, 0), HarnessActivity.done);
    expect(f.inRow(0, find.text('✓')), findsOneWidget);
    expect(f.inRow(0, find.text('○')), findsNothing);
    expect(rowTooltip(tester, f, 0), contains('Finished'));
    expect(f.inRow(0, find.byType(Tooltip)), findsNothing);
    f.app.markAgentSeen('m', 'a0');
    await tester.pump();
    expect(f.activity(tester, 0), HarnessActivity.idle);
    expect(f.inRow(0, find.text('○')), findsOneWidget);
    expect(tester.getTopLeft(mark), position);
    f.app.agentUnread.mark('m', 'a0', AlertKind.done);
    await tester.pump();
    expect(f.activity(tester, 0), HarnessActivity.done);
    await f.close(tester);
  });

  testWidgets(
    'workgroup questions survive missing native data without stale working claims',
    (tester) async {
      final f = await fixture(tester);
      (f.server.state['conversations'] as List)[1]['assignment'] = {
        'agentId': 'agent-1',
        'status': 'working',
      };
      (f.server.state['conversations'] as List).add({
        ...conversationFixture('question', 'Review'),
        'assignment': {'agentId': 'agent-1', 'status': 'needs_human'},
      });
      await f.controller.refresh();
      await f.show(tester, nativeState: false);
      expect(f.activity(tester, 0), HarnessActivity.unknown);
      expect(f.activity(tester, 1), HarnessActivity.needsInput);
      f.app.stateOf('m')!.connectionStatus = ConnectionStatus.disconnected;
      await f.show(tester);
      expect(f.activity(tester, 1), HarnessActivity.offline);
      f.app.stateOf('m')!
        ..connectionStatus = ConnectionStatus.connected
        ..agents = const [
          Agent(
            id: 'a1',
            name: 'Multiply',
            engine: 'claude',
            status: 'stopped',
          ),
        ];
      await f.show(tester);
      expect(f.activity(tester, 1), HarnessActivity.paused);
      await f.close(tester);
    },
  );

  for (final brightness in Brightness.values) {
    for (final scale in [1.0, 2.0]) {
      testWidgets(
        'roster marks remain legible in ${brightness.name} at ${scale}x',
        (tester) async {
          final f = await fixture(tester);
          (f.server.state['agents'] as List)[2]['projectId'] = 'lead';
          await f.controller.refresh();
          (f.server.state['conversations'] as List)[0]
            ..['title'] = 'Polish sidebar navigation'
            ..['assignment'] = {'agentId': 'agent-0', 'status': 'working'};
          await f.controller.refresh();
          final previous = grid.AppTheme.brightness.value;
          grid.AppTheme.brightness.value = brightness;
          addTearDown(() => grid.AppTheme.brightness.value = previous);
          f.app.stateOf('m')!
            ..processingAgentIds.add('a0')
            ..blockedAgents['a2'] = activityQuestion('a2')
            ..agents = const [
              Agent(id: 'a0', name: 'Lead', engine: 'codex'),
              Agent(id: 'a1', name: 'Multiply', engine: 'claude'),
              Agent(id: 'a2', name: 'Lead', engine: 'codex'),
              Agent(
                id: 'a3',
                name: 'Divide',
                engine: 'codex',
                status: 'stopped',
              ),
            ];
          f.app.agentUnread.mark('m', 'a1', AlertKind.done);
          await f.show(tester, brightness: brightness, scale: scale);
          expect(f.activity(tester, 0), HarnessActivity.working);
          expect(f.activity(tester, 1), HarnessActivity.done);
          expect(f.activity(tester, 2), HarnessActivity.needsInput);
          expect(f.activity(tester, 3), HarnessActivity.paused);
          final semantics = tester.ensureSemantics();
          await tester.pump();
          expect(
            find.bySemanticsLabel(RegExp('Needs your input')),
            findsWidgets,
          );
          semantics.dispose();
          for (var i = 0; i < 4; i++) {
            final bounds = tester.getRect(f.row(i));
            final status = tester.getRect(
              f.inRow(i, find.byType(ActivityMark)),
            );
            expect(bounds.contains(status.center), isTrue);
          }
          expect(tester.takeException(), isNull);
          await captureBoundary(
            tester,
            f.boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary,
            captureDir,
            'roster-${brightness.name}-${scale}x',
          );
          await f.close(tester);
        },
      );
    }
  }
}
