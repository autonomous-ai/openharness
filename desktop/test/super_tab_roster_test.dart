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
import 'support/buddy_fixture.dart';
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
  String? answered;
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
    DateTime Function()? now,
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
              onAnswer: (id) => answered = id,
              onOpenAgent: (agent) => opened = agent,
              now: now ?? DateTime.now,
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

  /// The row's details line: its task and the time since its last progress,
  /// or its state in a word (Dee, 2026-10-30).
  Finder line(int i) => find.byKey(ValueKey('super-member-line-agent-$i'));
  String lineText(WidgetTester tester, int i) =>
      tester.widget<Text>(line(i)).data!;

  /// The hover's state line: state, machine, model and effort (team glance,
  /// 2026-10-27), on the row until 2026-10-30.
  String glanceText(WidgetTester tester, int i) => tester
      .widgetList<Tooltip>(
        find.ancestor(of: row(i), matching: find.byType(Tooltip)),
      )
      .single
      .message!
      .split('\n')[1];
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
      expect(f.glanceText(tester, 1), 'Limited until 09:05 · Test host');
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
        expect(f.glanceText(tester, 1), 'Assigned · Test host');
        expect(
          rowTooltip(tester, f, 1),
          contains('Assigned to "Offline editing"'),
        );
      }
      await f.close(tester);
    },
  );

  testWidgets('agent tooltip combines known model, machine, task and activity', (
    tester,
  ) async {
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
    // Who, then where and on what, then the task, then when (Dee, 2026-10-30).
    expect(
      rowTooltip(tester, f, 1),
      'Sage · Engineer · openharness · Claude\n'
      'Working · Test host · Opus\n'
      'Working on "Offline editing"\n'
      'Last active 2 hours ago',
    );
    expect(f.glanceText(tester, 1), 'Working · Test host · Opus');
    final mouse = await tester.createGesture(kind: PointerDeviceKind.mouse);
    await mouse.addPointer(location: Offset.zero);
    await mouse.moveTo(tester.getCenter(f.row(1)));
    await tester.pumpAndSettle(const Duration(milliseconds: 800));
    expect(find.text(rowTooltip(tester, f, 1)), findsOneWidget);
    await mouse.removePointer();
    await f.close(tester);
  });

  // The PM's row and details read the configuration's raw "opus" or "claude-opus-5-5" (2026-10-28): both name the
  // model as people know it.
  testWidgets('agent details name the model by its display name', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['agents'] as List)[1]['configuration'] = {
      'engine': 'claude',
      'model': 'claude-opus-5-5',
      'effort': 'auto',
    };
    await f.controller.refresh();
    await f.show(tester);
    expect(f.glanceText(tester, 1), contains('Opus 5.5'));
    expect(f.glanceText(tester, 1), isNot(contains('unknown')));
    await tester.longPress(f.row(1));
    await tester.pumpAndSettle();
    expect(
      find.descendant(
        of: find.byType(AlertDialog),
        matching: find.text('Opus 5.5'),
      ),
      findsOneWidget,
    );
    expect(find.textContaining('claude-opus-5-5'), findsNothing);
    await f.close(tester);
  });

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
    expect(f.glanceText(tester, 0), 'Idle');
    expect(rowTooltip(tester, f, 0), contains('Status unavailable'));
    expect(rowTooltip(tester, f, 0), isNot(contains('Last active')));
    await tester.longPress(f.row(0));
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
    expect(f.glanceText(tester, 1), 'Waiting · Test host');
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
      expect(f.glanceText(tester, 1), 'Working · Test host');
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
    await tester.longPress(f.row(1));
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
    await tester.longPress(f.row(1));
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
    await tester.longPress(f.row(1));
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
    await tester.longPress(f.row(1));
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
    await tester.longPress(f.row(1));
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
    await tester.longPress(f.row(1));
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
    'a Codex Buddy\'s mode, which New Harness does not offer, reads by name',
    (tester) async {
      final f = await fixture(tester);
      f.app.stateOf('m')!.agents = const [
        Agent(
          id: 'a1',
          name: 'Multiply',
          engine: 'codex',
          permissionMode: 'readOnlyAsk',
        ),
      ];
      (f.server.state['agents'] as List)[1]['configuration'] = {
        'engine': 'codex',
      };
      await f.controller.refresh();
      await f.show(tester);
      await tester.longPress(f.row(1));
      await tester.pumpAndSettle();
      expect(find.text('Read only, asks you'), findsOneWidget);
      expect(find.text('Unrecognized setting'), findsNothing);
      await f.close(tester);
    },
  );

  testWidgets(
    'a Claude Buddy\'s mode, which New Harness does not offer, reads by name',
    (tester) async {
      final f = await fixture(tester);
      f.app.stateOf('m')!.agents = const [
        Agent(
          id: 'a1',
          name: 'Multiply',
          engine: 'claude',
          permissionMode: 'buddy',
        ),
      ];
      (f.server.state['agents'] as List)[1]['configuration'] = {
        'engine': 'claude',
      };
      await f.controller.refresh();
      await f.show(tester);
      await tester.longPress(f.row(1));
      await tester.pumpAndSettle();
      expect(find.text('Reads only, never asks'), findsOneWidget);
      expect(find.text('Unrecognized setting'), findsNothing);
      await f.close(tester);
    },
  );

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
      await tester.longPress(f.row(1));
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
      await tester.longPress(f.row(1));
      await tester.pumpAndSettle();
      expect(find.text('Who can answer'), findsNothing);
      await f.close(tester);
    },
  );

  group('agent details Owner', () {
    Future<void> openDetails(WidgetTester tester, RosterFixture f) async {
      await f.show(tester);
      await tester.longPress(f.row(1));
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
    await tester.longPress(f.row(0));
    await tester.pumpAndSettle();
    expect(find.text('Claude'), findsOneWidget);
    expect(find.text('Sonnet'), findsOneWidget);
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

  testWidgets(
    'an agent row shows neither an engine icon nor its project name',
    (tester) async {
      final f = await fixture(tester);
      await f.show(tester);
      // Only the status mark stands at the right (Dee, 2026-10-29); the
      // model on the second line says which engine runs it.
      for (final i in [0, 1, 3]) {
        expect(f.inRow(i, find.byType(EngineMark)), findsNothing);
      }
      expect(f.inRow(1, find.text('openharness')), findsNothing);
      f.controller.select('os-lead');
      await tester.pumpAndSettle();
      expect(f.inRow(2, find.text('autonomous-os')), findsNothing);
      await f.close(tester);
    },
  );

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

  testWidgets(
    'Buddies are personal: with three running, nobody sees any in Agents, the reader\'s own included',
    (tester) async {
      for (final account in ['owner', 'maya']) {
        final f = await fixture(tester, account: account);
        final agents = f.server.state['agents'] as List;
        // The owner's Buddy and another person's, both in the project, and a third on the same machine.
        agents[1]['buddyOf'] = {'personId': 'owner', 'generation': 'fixture'};
        agents[3]['buddyOf'] = {'personId': 'maya', 'generation': 'fixture'};
        agents.add(<String, Object>{
          ...(agents[3] as Map<String, Object>),
          'id': 'agent-4',
          'harnessId': 'a4',
          'displayName': 'Echo',
          'buddyOf': {'personId': 'sam', 'generation': 'fixture'},
        });
        await f.controller.refresh();
        await f.show(tester);
        expect(f.row(0), findsOneWidget, reason: '$account sees the PM');
        for (final buddy in [1, 3, 4]) {
          expect(
            f.row(buddy),
            findsNothing,
            reason: '$account sees no Buddy (agent-$buddy)',
          );
        }
        expect(find.text('Buddy'), findsNothing);
        await f.close(tester);
      }
    },
  );

  testWidgets('shows the role an agent goes by', (tester) async {
    final f = await fixture(tester);
    final agents = f.server.state['agents'] as List;
    agents[1]['roleName'] = 'Tester';
    agents[3]['roleName'] = 'Quality assurance lead';
    // The coordinator's role name in the template.
    agents[0]['roleName'] = 'PM';
    await f.controller.refresh();
    await f.show(tester);
    expect(f.inRow(1, find.text('Tester')), findsOneWidget);
    expect(f.inRow(1, find.text('Dev')), findsNothing);
    expect(rowTooltip(tester, f, 1), startsWith('Sage · Tester · '));
    expect(
      f.inRow(
        1,
        find.byWidgetPredicate(
          (w) => w is Semantics && w.properties.label == 'Tester',
        ),
      ),
      findsOneWidget,
    );
    // A long name's badge is cut; the tooltip and the label keep it whole.
    expect(f.inRow(3, find.text('Quality ass…')), findsOneWidget);
    expect(rowTooltip(tester, f, 3), contains(' · Quality assurance lead · '));
    expect(f.inRow(0, find.text('PM')), findsOneWidget);
    final details = showSuperTabAgentDetails(
      tester.element(f.row(1)),
      f.controller,
      f.app,
      f.controller.snapshot!.agent('agent-1')!,
      (_) {},
    );
    await tester.pumpAndSettle();
    expect(find.text('Tester'), findsWidgets);
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

  testWidgets(
    'the roster lists the whole Swarm in every chat, in one order (Dee, 2026-10-31)',
    (tester) async {
      final f = await fixture(tester);
      (f.server.state['people'] as List).add({
        'id': 'mira',
        'email': 'mira@example.com',
        'role': 'collaborator',
      });
      (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
        // Finn waits on a person: first everywhere.
        {
          ...conversationFixture('ask', 'Pick a sign-in page'),
          'assignment': {'agentId': 'agent-3', 'status': 'needs_human'},
        },
        // As the backend sends it: no project, kind `leads`.
        {
          ...conversationFixture('leads', 'Leads'),
          'kind': 'leads',
          'agentIds': ['agent-0', 'agent-2'],
        },
      ]);
      f.server.state['leadsConversationId'] = 'leads';
      // The private conversation one opens: the owner's Buddy chat, which only
      // they and their Buddy read.
      giveBuddy(f.server, person: 'owner', machineOwnerId: 'owner');
      await f.controller.refresh();
      // Needs input first; then idle in today's order, the Leads first.
      const order = [3, 0, 2, 1];
      final saved = grid.AppTheme.brightness.value;
      addTearDown(() => grid.AppTheme.brightness.value = saved);
      for (final brightness in Brightness.values) {
        for (final chat in ['lead', 'os-lead', 'buddy-owner-lead', 'leads']) {
          f.controller.select(chat);
          // The app's tokens follow their own brightness, not the theme's.
          grid.AppTheme.brightness.value = brightness;
          await f.show(tester, nativeState: false, brightness: brightness);
          await captureBoundary(
            tester,
            f.boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary,
            captureDir,
            'roster-everywhere-$chat-${brightness.name}',
          );
          expect(f.controller.selectedId, chat);
          for (final i in order) {
            expect(f.row(i), findsOneWidget, reason: 'agent-$i in $chat');
          }
          final tops = [for (final i in order) tester.getTopLeft(f.row(i)).dy];
          expect(tops, [...tops]..sort(), reason: 'order in $chat');
          expect(tops.toSet(), hasLength(order.length), reason: chat);
          // A Buddy stays out, as today: it is listed under Buddies.
          expect(find.byKey(const ValueKey('super-member-wren')), findsNothing);
          for (final person in ['owner', 'mira']) {
            expect(
              find.byKey(ValueKey('super-person-$person')),
              findsOneWidget,
              reason: '$person in $chat',
            );
          }
        }
      }
      // The + keeps its rules: a project's shared chat only.
      for (final (chat, offered) in [
        ('lead', true),
        ('os-lead', true),
        ('buddy-owner-lead', false),
        ('leads', false),
      ]) {
        f.controller.select(chat);
        await tester.pumpAndSettle();
        expect(
          find.byTooltip('Add agent'),
          offered ? findsOneWidget : findsNothing,
          reason: chat,
        );
      }
      await f.close(tester);
    },
  );

  testWidgets(
    'a project the reader loses takes its agents out of the list in every chat',
    (tester) async {
      final f = await fixture(tester);
      await f.show(tester, nativeState: false);
      expect(f.row(2), findsOneWidget);
      // The server stops sending autonomous-os and its PM, as it does once
      // the reader may no longer read it.
      final state = f.server.state;
      (state['projects'] as List).removeWhere((p) => (p as Map)['id'] == 'os');
      (state['agents'] as List).removeWhere(
        (a) => (a as Map)['id'] == 'agent-2',
      );
      (state['conversations'] as List).removeWhere(
        (g) => (g as Map)['id'] == 'os-lead',
      );
      await f.controller.refresh();
      await tester.pumpAndSettle();
      expect(f.row(2), findsNothing);
      expect(find.text('Nova'), findsNothing);
      for (final i in [0, 1, 3]) {
        expect(f.row(i), findsOneWidget);
      }
      await f.close(tester);
    },
  );

  testWidgets('authorized roster stays stable across workgroups and projects', (
    tester,
  ) async {
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
    // autonomous-os's PM too, in openharness's chat (Dee, 2026-10-31).
    expect(f.inRow(2, find.text('PM')), findsOneWidget);
    for (final i in [0, 1, 3]) {
      expect(f.inRow(i, find.byType(SuperTabAvatar)), findsOneWidget);
      expect(f.inRow(i, find.text(i == 0 ? 'PM' : 'Dev')), findsOneWidget);
      expect(f.inRow(i, find.byType(ActivityMark)), findsOneWidget);
    }
    expect(find.text('Join Super Tab roster'), findsNothing);
    expect(find.text('Not in this Swarm'), findsNothing);
    expect(find.text('Ready'), findsNothing);
    final nameX = tester.getTopLeft(f.inRow(0, find.text('Atlas'))).dx;
    final name = tester.getRect(f.inRow(0, find.text('Atlas')));
    final badge = tester.getRect(f.inRow(0, find.text('PM')));
    final status = tester.getRect(f.line(0));
    final mark = tester.getRect(f.inRow(0, find.byType(ActivityMark)));
    // The status mark stands alone at the right, on the name's line (Dee, 2026-10-29); no engine icon.
    for (final i in [0, 1, 3]) {
      expect(f.inRow(i, find.byType(EngineMark)), findsNothing);
    }
    expect(mark.left, greaterThan(badge.right));
    expect(mark.right, closeTo(tester.getRect(f.row(0)).right - 8, 1));
    expect(mark.center.dy, closeTo(name.center.dy, 2));
    // The second line starts where the name does.
    expect(status.left, nameX);
    expect(status.top, greaterThanOrEqualTo(name.bottom));
    expect(tester.getSize(f.row(0)).height, lessThanOrEqualTo(60));
    expect(
      tester.getTopLeft(find.text('owner').first).dx,
      nameX,
      reason: 'People and agent identity use the same text column',
    );
    final rows = {for (var i = 0; i < 4; i++) i: tester.getRect(f.row(i))};
    final people = tester.getRect(find.text('owner'));
    // Every row stays where it was, in this project's chats and another's.
    for (final selected in ['lead', 'offline', 'os-lead']) {
      f.controller.select(selected);
      await tester.pumpAndSettle();
      for (var i = 0; i < 4; i++) {
        expect(tester.getRect(f.row(i)), rows[i], reason: selected);
        expect(f.inRow(i, find.byType(ActivityMark)), findsOneWidget);
      }
      expect(tester.getRect(find.text('owner')), people);
      await tester.tap(find.byTooltip('Add agent'));
      expect(f.added?.id, selected);
    }
    f.controller.selectDevices();
    await tester.pumpAndSettle();
    expect(f.controller.devicesSelected, isTrue);
    for (var i = 0; i < 4; i++) {
      expect(tester.getRect(f.row(i)), rows[i]);
    }
    expect(tester.getRect(find.text('owner')), people);
    f.controller.select('offline');
    await tester.pumpAndSettle();
    // Sage and Finn, which this computer cannot read, take their mark from
    // the Swarm: no task, so idle like Atlas. Equals keep their order, the
    // Lead first.
    for (final i in [0, 1, 3]) {
      expect(f.activity(tester, i), HarnessActivity.idle, reason: 'agent-$i');
    }
    expect(
      tester.getTopLeft(f.row(0)).dy,
      lessThan(tester.getTopLeft(f.row(1)).dy),
    );
    expect(
      tester.getTopLeft(f.row(1)).dy,
      lessThan(tester.getTopLeft(f.row(3)).dy),
    );
    await tester.longPress(f.row(1));
    await tester.pumpAndSettle();
    expect(find.byType(AlertDialog), findsOneWidget);
    await tester.tap(find.widgetWithText(FilledButton, 'Open terminal'));
    await tester.pumpAndSettle();
    expect(f.opened?.harnessId, 'a1');
    expect(f.controller.selectedId, 'offline');
    expect(f.server.posts, isEmpty);
    await f.close(tester);
  });

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
        // Listed in every chat; its hover names the project of its group.
        expect(f.inRow(legacyAgent, find.byType(ActivityMark)), findsOneWidget);
        expect(
          rowTooltip(tester, f, legacyAgent).split('\n').first,
          contains(' · autonomous-os'),
        );
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
    expect(f.inRow(1, find.byType(ActivityMark)), findsOneWidget);
    final hover = rowTooltip(tester, f, 1).split('\n').first;
    expect(hover, contains(' · openharness'));
    expect(hover, isNot(contains('autonomous-os')));
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
    expect(f.glanceText(tester, 1), 'Assigned');
    expect(
      rowTooltip(tester, f, 1),
      contains('Assigned to "Polish navigation"'),
    );
    expect(f.glanceText(tester, 0), 'Idle');
    // Unseen by this computer, the Swarm's held task gives the mark; the words
    // still say only Assigned.
    expect(f.activity(tester, 1), HarnessActivity.working);
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
    'a retained working task never shows working over a known idle turn',
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
        // A status this computer cannot read takes the Swarm's: the task.
        final shown = activity == HarnessActivity.unknown
            ? HarnessActivity.working
            : activity;
        final status = activity == HarnessActivity.working
            ? 'Working on "Polish navigation"'
            : 'Assigned to "Polish navigation"';
        expect(f.activity(tester, 1), shown);
        expect(
          f.glanceText(tester, 1),
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
      expect(f.activity(tester, 1), HarnessActivity.working);
      expect(f.glanceText(tester, 1), 'Assigned');
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
    expect(f.glanceText(tester, 1), 'Assigned');
    expect(
      rowTooltip(tester, f, 1),
      contains('Assigned to "Polish navigation"'),
    );
    expect(rowTooltip(tester, f, 1), isNot(contains('Cancelled task')));

    (currentTask['assignment'] as Map)['status'] = 'cancelled';
    await f.controller.refresh();
    await tester.pumpAndSettle();
    expect(f.glanceText(tester, 1), 'Idle');
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
        // In review waits on others whatever this Mac reads (Dee, 2026-10-30).
        HarnessActivity.done,
        'Waiting on others for "Polish navigation"',
        'Waiting on others · Test host',
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
      expect(f.glanceText(tester, 1), line);
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
        expect(f.glanceText(tester, 1), '$line · Test host');
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
        expect(status.left, name.left);
        expect(mark.left, greaterThanOrEqualTo(badge.right));
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

  testWidgets(
    'agents on another computer show their Swarm state with the tabs\' marks, most urgent first',
    (tester) async {
      final f = await fixture(tester);
      await tester.binding.setSurfaceSize(const Size(280, 540));
      final now = DateTime.now().millisecondsSinceEpoch;
      // This Mac reads neither computer itself: only the Swarm says how they are.
      f.server.state['machines'] = [
        {
          'machineId': 'far',
          'name': 'Mac mini',
          'contributorId': 'owner',
          'observation': {'receivedAt': now},
        },
        {
          'machineId': 'gone',
          'name': 'Old laptop',
          'contributorId': 'owner',
          'observation': {'receivedAt': now - 10 * 60 * 1000},
        },
      ];
      final agents = f.server.state['agents'] as List;
      final base = (agents[1] as Map).cast<String, Object>();
      for (final (i, name) in [
        (4, 'Juno'),
        (5, 'Iris'),
        (6, 'Orion'),
        (7, 'Vega'),
        (8, 'Lyra'),
        (9, 'Rhea'),
      ]) {
        agents.add({
          ...base,
          'id': 'agent-$i',
          'harnessId': 'a$i',
          'name': name,
          'displayName': name,
        });
      }
      for (final agent in agents) {
        (agent as Map)['machineId'] = 'far';
      }
      (agents[6] as Map)['machineId'] = 'gone';
      (agents[7] as Map)['downSince'] = '2026-10-29T12:00:00.000Z';
      Map<String, dynamic> work(String id, String agent, String status) => {
        ...conversationFixture(id, 'Task $id'),
        'assignment': {'agentId': agent, 'status': status},
      };
      (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
        work('t1', 'agent-1', 'working'),
        work('t3', 'agent-3', 'review'),
        work('t4', 'agent-4', 'needs_human'),
        work('t5', 'agent-5', 'blocked'),
        work('t6', 'agent-6', 'working'),
        work('t7', 'agent-7', 'needs_human'),
        {
          ...work('t8', 'agent-8', 'working'),
          'liveness': {
            'state': 'orphaned',
            'why': 'start-failed',
            'since': now,
          },
        },
      ]);
      await f.controller.refresh();
      await f.show(tester, brightness: Brightness.light);
      final expected = {
        4: HarnessActivity.needsInput,
        5: HarnessActivity.needsInput,
        8: HarnessActivity.failed,
        3: HarnessActivity.done,
        1: HarnessActivity.working,
        0: HarnessActivity.idle,
        9: HarnessActivity.idle,
        7: HarnessActivity.paused,
        6: HarnessActivity.offline,
      };
      for (final MapEntry(key: i, value: activity) in expected.entries) {
        expect(f.activity(tester, i), activity, reason: 'agent-$i');
      }
      // The tabs' order; equals keep today's order, the Lead first.
      final tops = [
        for (final i in expected.keys) tester.getTopLeft(f.row(i)).dy,
      ];
      expect(tops, [...tops]..sort());
      expect(tops.toSet(), hasLength(expected.length));
      // The words agree with the mark where something stops the agent; a task
      // with no turn seen still reads Assigned.
      expect(f.glanceText(tester, 6), startsWith('Down'));
      expect(f.glanceText(tester, 7), startsWith('Down'));
      expect(f.glanceText(tester, 8), startsWith('Down'));
      expect(f.glanceText(tester, 1), startsWith('Assigned'));
      final saved = grid.AppTheme.brightness.value;
      addTearDown(() => grid.AppTheme.brightness.value = saved);
      for (final brightness in Brightness.values) {
        grid.AppTheme.brightness.value = brightness;
        await f.show(tester, brightness: brightness);
        await captureBoundary(
          tester,
          f.boundary.currentContext!.findRenderObject()!
              as RenderRepaintBoundary,
          captureDir,
          'agents-swarm-states-${brightness.name}',
        );
      }
      await f.close(tester);
    },
  );

  testWidgets(
    "a Team account's agents follow the Team account's own reports, not its Mac's",
    (tester) async {
      final f = await fixture(tester);
      final now = DateTime.now().millisecondsSinceEpoch;
      // The Mac and its Harness Team account report on their own; the Swarm
      // shows them as one row, but each has its own heartbeat.
      void reports({required int mac, required int team}) =>
          f.server.state['machines'] = [
            {
              'machineId': 'mac',
              'name': 'Mac Studio',
              'contributorId': 'owner',
              'observation': {'receivedAt': mac},
            },
            {
              'machineId': 'team',
              'name': 'Harness Team',
              'contributorId': 'owner',
              'hostMachineId': 'mac',
              'observation': {'receivedAt': team},
            },
          ];
      for (final agent in f.server.state['agents'] as List) {
        (agent as Map)['machineId'] = 'team';
      }
      final silent = now - 10 * 60 * 1000;
      reports(mac: silent, team: now);
      await f.controller.refresh();
      await f.show(tester);
      expect(f.glanceText(tester, 1), startsWith('Idle · Mac Studio'));
      expect(f.activity(tester, 1), HarnessActivity.idle);
      reports(mac: now, team: silent);
      await f.controller.refresh();
      await f.show(tester);
      expect(f.activity(tester, 1), HarnessActivity.offline);
      expect(f.glanceText(tester, 1), startsWith('Down'));
      await f.close(tester);
    },
  );

  testWidgets(
    'a mark comes from any group the reader sees, never from a private or Buddy chat they cannot',
    (tester) async {
      final f = await fixture(tester);
      (f.server.state['people'] as List).add({
        'id': 'mira',
        'email': 'mira@example.com',
        'role': 'collaborator',
      });
      final conversations = f.server.state['conversations'] as List;
      // Sage, an openharness agent, reused for autonomous-os work: one agent,
      // one mark, from the group the reader can see.
      conversations.add({
        ...conversationFixture('os-task', 'OS task'),
        'projectId': 'os',
        'assignment': {'agentId': 'agent-1', 'status': 'working'},
      });
      // Finn's only questions are in Mira's private group and her Buddy chat.
      final private = {
        ...conversationFixture('private', 'Private plans'),
        'audience': {
          'people': [
            {'id': 'mira'},
          ],
        },
        'assignment': {'agentId': 'agent-3', 'status': 'needs_human'},
      };
      conversations.addAll(<Map<String, dynamic>>[
        private,
        {
          ...conversationFixture('buddy', 'Mira and Sparky'),
          'kind': 'buddy',
          'buddyOwnerId': 'mira',
          'assignment': {'agentId': 'agent-3', 'status': 'blocked'},
        },
      ]);
      await f.controller.refresh();
      await f.show(tester, nativeState: false);
      expect(f.activity(tester, 1), HarnessActivity.working);
      expect(f.activity(tester, 3), HarnessActivity.idle);
      // Nor its title, on the row's task line or on hover.
      expect(find.textContaining('Private plans'), findsNothing);
      expect(find.textContaining('Mira and Sparky'), findsNothing);
      expect(f.lineText(tester, 3), 'Idle');
      expect(rowTooltip(tester, f, 3), isNot(contains('Private plans')));
      // The same group, once the reader is in it, does change the mark.
      ((private['audience'] as Map)['people'] as List).add({'id': 'owner'});
      await f.controller.refresh();
      await f.show(tester, nativeState: false);
      expect(f.activity(tester, 3), HarnessActivity.needsInput);
      await f.close(tester);
    },
  );

  testWidgets(
    'orders agents most urgent first, as the tabs do, and a lost task shows Offline',
    (tester) async {
      final f = await fixture(tester);
      final agents = f.server.state['agents'] as List;
      agents.add({
        ...(agents[3] as Map).cast<String, Object>(),
        'id': 'agent-4',
        'harnessId': 'a4',
        'name': 'Juno',
        'displayName': 'Juno',
      });
      (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
        {
          ...conversationFixture('ask', 'Pick a sign-in page'),
          'assignment': {'agentId': 'agent-3', 'status': 'needs_human'},
        },
        {
          ...conversationFixture('gone', 'Old work'),
          'assignment': {'agentId': 'agent-4', 'status': 'lost'},
        },
      ]);
      await f.controller.refresh();
      final machine = f.app.stateOf('m')!;
      machine.agents = [
        for (final i in [0, 1, 3, 4])
          Agent(id: 'a$i', name: 'n$i', engine: 'codex'),
      ];
      machine.processingAgentIds.add('a1');
      await f.show(tester);
      expect(f.activity(tester, 3), HarnessActivity.needsInput);
      expect(f.activity(tester, 1), HarnessActivity.working);
      expect(f.activity(tester, 0), HarnessActivity.idle);
      // Lost work reads Lost on its line; its mark is the tabs' Offline.
      expect(f.activity(tester, 4), HarnessActivity.offline);
      expect(f.glanceText(tester, 4), startsWith('Lost'));
      final tops = [
        for (final i in [3, 1, 0, 4]) tester.getTopLeft(f.row(i)).dy,
      ];
      expect(tops, [...tops]..sort());
      expect(tops.toSet(), hasLength(4));
      await f.close(tester);
    },
  );

  testWidgets(
    'people and agents share one row shape: avatar column, name line, details line',
    (tester) async {
      final f = await fixture(tester);
      await tester.binding.setSurfaceSize(const Size(320, 560));
      final server = f.server;
      server.state['people'] = [
        {'id': 'owner', 'email': 'ken@example.com', 'role': 'owner'},
        {
          'id': 'dee',
          'email': 'dee@example.com',
          'role': 'collaborator',
          'status': {'text': 'Coffee break', 'emoji': '☕', 'until': null},
        },
        {'id': 'tony', 'email': 'tony@example.com', 'role': 'collaborator'},
      ];
      Map<String, dynamic> score(
        String id,
        String name,
        int points,
        int rank,
        int shipped,
        int unblocked,
        int lentHours,
      ) => {
        'personId': id,
        'displayName': name,
        'points': points,
        'rank': rank,
        'medal': null,
        'shipped': {'count': shipped, 'medianAskToShipMs': null},
        'unblocked': {'count': unblocked, 'agentMs': 0, 'medianAnswerMs': null},
        'lent': {
          'machines': lentHours > 0 ? 1 : 0,
          'agentMs': lentHours * 3600000,
        },
        'streakDays': 0,
      };
      server.leaderboard = {
        'projectId': 'lead',
        'week': DateTime.utc(2026, 10, 26).millisecondsSinceEpoch,
        'people': [
          score('owner', 'Ken Nguyen', 204, 1, 64, 10, 25),
          score('dee', 'Dee', 84, 2, 24, 9, 0),
          score('tony', 'Tony', 72, 3, 19, 15, 0),
        ],
        'waiting': {'total': 0, 'people': <Object>[]},
      };
      final agents = server.state['agents'] as List;
      for (final agent in agents) {
        (agent as Map)['configuration'] = {
          'engine': 'claude',
          'model': 'opus',
          'effort': 'high',
        };
      }
      agents.add({
        ...(agents[3] as Map).cast<String, Object>(),
        'id': 'agent-4',
        'harnessId': 'a4',
        'name': 'Juno',
        'displayName': 'Juno',
      });
      (server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
        {
          ...conversationFixture('ask', 'Pick a sign-in page'),
          'assignment': {'agentId': 'agent-3', 'status': 'needs_human'},
        },
        {
          ...conversationFixture('gone', 'Old work'),
          'assignment': {'agentId': 'agent-4', 'status': 'lost'},
        },
      ]);
      await f.controller.refresh();
      final machine = f.app.stateOf('m')!;
      machine.agents = [
        for (final i in [0, 1, 3, 4])
          Agent(id: 'a$i', name: 'n$i', engine: 'claude'),
      ];
      machine.processingAgentIds.add('a1');
      final saved = grid.AppTheme.brightness.value;
      addTearDown(() => grid.AppTheme.brightness.value = saved);
      for (final brightness in Brightness.values) {
        // The tokens follow the app's theme, as the app's scope sets them.
        grid.AppTheme.brightness.value = brightness;
        await f.show(tester, brightness: brightness);
        expect(find.text('Humans'), findsOneWidget);
        double avatar(Finder row) => tester
            .getTopLeft(
              find.descendant(of: row, matching: find.byType(SuperTabAvatar)),
            )
            .dx;
        final column = avatar(find.byKey(const ValueKey('super-person-owner')));
        for (final row in [
          find.byKey(const ValueKey('super-person-dee')),
          find.byKey(const ValueKey('super-person-tony')),
          for (final i in [0, 1, 3, 4]) f.row(i),
        ]) {
          expect(avatar(row), column);
        }
        // Points and marks end on one right edge.
        final right = tester
            .getTopRight(find.byKey(const ValueKey('leaderboard-points-owner')))
            .dx;
        for (final i in [0, 1, 3, 4]) {
          expect(
            tester.getTopRight(f.inRow(i, find.byType(ActivityMark))).dx,
            closeTo(right, 1),
          );
        }
        expect(
          find.byKey(const ValueKey('leaderboard-crown-owner')),
          findsOneWidget,
        );
        expect(tester.takeException(), isNull);
        await captureBoundary(
          tester,
          f.boundary.currentContext!.findRenderObject()!
              as RenderRepaintBoundary,
          captureDir,
          'left-pane-people-agents-${brightness.name}',
        );
      }
      await f.close(tester);
    },
  );

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
      expect(f.activity(tester, 0), HarnessActivity.idle);
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

  group('Swarm-first marks (Dee, 2026-10-30)', () {
    /// A task the Swarm holds for [agent], with its last progress [ago] and
    /// its lease, as the backend sends them (assignment.progressAt and
    /// leaseUntil, five minutes apart).
    Map<String, dynamic> task(
      String id,
      String title,
      String agent,
      String status, {
      required Duration ago,
      Duration lease = const Duration(minutes: 5),
    }) {
      final at = DateTime.now().subtract(ago).millisecondsSinceEpoch;
      return {
        ...conversationFixture(id, title),
        'assignment': {
          'agentId': agent,
          'status': status,
          'progressAt': at,
          'leaseUntil': at + lease.inMilliseconds,
        },
      };
    }

    /// This Mac sees the agents' machine (a shared one, as Dee's Mac sees the
    /// Mac Studio) and has no turn reported for any of them: it reads idle.
    void seenIdleHere(RosterFixture f) {
      f.app.stateOf('m')!.agents = [
        for (final i in [0, 1, 3])
          Agent(id: 'a$i', name: 'n$i', engine: 'codex'),
      ];
    }

    testWidgets(
      'an agent this Mac reads as idle shows the Swarm\'s fresh work: working and in review',
      (tester) async {
        final f = await fixture(tester);
        (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          task(
            't1',
            'Sidebar rescan fix',
            'agent-1',
            'working',
            ago: const Duration(minutes: 4, seconds: 10),
          ),
          task(
            't3',
            'Reviewer names',
            'agent-3',
            'review',
            ago: const Duration(minutes: 20, seconds: 10),
          ),
        ]);
        await f.controller.refresh();
        seenIdleHere(f);
        await f.show(tester);
        expect(f.activity(tester, 1), HarnessActivity.working);
        expect(f.activity(tester, 3), HarnessActivity.done);
        expect(f.activity(tester, 0), HarnessActivity.idle);
        // The details line: the task in plain words and the time since its
        // last progress; no task, the state in a word.
        expect(f.lineText(tester, 1), 'Sidebar rescan fix · 4m');
        expect(f.lineText(tester, 3), 'Reviewer names · 20m');
        expect(f.lineText(tester, 0), 'Idle');
        await f.close(tester);
      },
    );

    testWidgets(
      'a task past its lease is status unavailable; a done task waits for its merge',
      (tester) async {
        final f = await fixture(tester);
        final done =
            task(
                't3',
                'Reviewer names',
                'agent-3',
                'done',
                ago: const Duration(minutes: 30),
              )
              ..['cards'] = {
                'pullRequests': [
                  <String, Object>{
                    'url': 'https://github.com/o/r/pull/7',
                    'messageId': 'pr-card',
                  },
                ],
              };
        (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          task(
            't1',
            'Sidebar rescan fix',
            'agent-1',
            'working',
            ago: const Duration(minutes: 9),
          ),
          done,
        ]);
        await f.controller.refresh();
        await f.show(tester, nativeState: false);
        // Nothing has said how agent-1 is for longer than its lease.
        expect(f.activity(tester, 1), HarnessActivity.unknown);
        expect(f.lineText(tester, 1), 'Sidebar rescan fix · 9m');
        // Its pull request not merged yet: waiting, with the task it waits on.
        expect(f.activity(tester, 3), HarnessActivity.done);
        expect(f.lineText(tester, 3), 'Reviewer names · 30m');
        // Merged: nothing left for it, idle.
        ((done['cards'] as Map)['pullRequests'] as List).first['mergedAt'] =
            DateTime.now().millisecondsSinceEpoch;
        await f.controller.refresh();
        await tester.pumpAndSettle();
        expect(f.activity(tester, 3), HarnessActivity.idle);
        expect(f.lineText(tester, 3), 'Idle');
        await f.close(tester);
      },
    );

    testWidgets(
      'this Mac\'s reading wins only when it is live; past its lease a held task is status unavailable',
      (tester) async {
        final f = await fixture(tester);
        (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          task(
            't1',
            'Sidebar rescan fix',
            'agent-1',
            'working',
            ago: const Duration(minutes: 9),
          ),
          task(
            't3',
            'Reviewer names',
            'agent-3',
            'review',
            ago: const Duration(minutes: 2),
          ),
        ]);
        await f.controller.refresh();
        seenIdleHere(f);
        // A turn running here is fresher than a review status.
        f.app.stateOf('m')!.processingAgentIds.add('a3');
        await f.show(tester);
        expect(f.activity(tester, 3), HarnessActivity.working);
        // Past its lease, nobody vouches for it: a held task is never idle
        // while the Swarm holds it, and this Mac's idle is no live reading.
        expect(f.activity(tester, 1), HarnessActivity.unknown);
        await f.close(tester);
      },
    );

    testWidgets(
      'machine, engine, model and effort are on hover, not on the row; most recent progress first within a mark',
      (tester) async {
        final f = await fixture(tester);
        final agents = f.server.state['agents'] as List;
        (agents[1] as Map)['configuration'] = {
          'engine': 'claude',
          'model': 'opus',
          'effort': 'high',
        };
        f.server.state['machines'] = [
          {
            'machineId': 'm',
            'name': 'Mac Studio',
            'contributorId': 'owner',
            'observation': {
              'receivedAt': DateTime.now().millisecondsSinceEpoch,
            },
          },
        ];
        (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          task(
            't1',
            'Sidebar rescan fix',
            'agent-1',
            'working',
            ago: const Duration(minutes: 4),
          ),
          task(
            't3',
            'Reviewer names',
            'agent-3',
            'working',
            ago: const Duration(minutes: 1),
          ),
        ]);
        await f.controller.refresh();
        await f.show(tester, nativeState: false);
        final tip = rowTooltip(tester, f, 1);
        expect(tip, contains('Mac Studio'));
        expect(tip, contains('Claude'));
        expect(tip, contains('Opus'));
        expect(tip, contains('high'));
        expect(tip, contains('Sidebar rescan fix'));
        final line = f.lineText(tester, 1);
        for (final word in ['Claude', 'Opus', 'high', 'Mac Studio']) {
          expect(line, isNot(contains(word)));
        }
        // Both working: the one heard from a minute ago comes first.
        expect(
          tester.getTopLeft(f.row(3)).dy,
          lessThan(tester.getTopLeft(f.row(1)).dy),
        );
        expect(
          tester.getTopLeft(f.row(1)).dy,
          lessThan(tester.getTopLeft(f.row(0)).dy),
        );
        await f.close(tester);
      },
    );

    testWidgets(
      'clicking a row opens its task\'s conversation; a needs-you row its question; no task, its details',
      (tester) async {
        final f = await fixture(tester);
        (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          task(
            't1',
            'Sidebar rescan fix',
            'agent-1',
            'working',
            ago: const Duration(minutes: 1),
          ),
          task(
            't3',
            'Pick a sign-in page',
            'agent-3',
            'needs_human',
            ago: const Duration(minutes: 12),
          ),
        ]);
        await f.controller.refresh();
        await f.show(tester, nativeState: false);
        expect(f.activity(tester, 3), HarnessActivity.needsInput);
        await tester.tap(f.row(1));
        await tester.pumpAndSettle();
        expect(f.answered, 't1');
        await tester.tap(f.row(3));
        await tester.pumpAndSettle();
        expect(f.answered, 't3');
        f.answered = null;
        await tester.tap(f.row(0));
        await tester.pumpAndSettle();
        expect(f.answered, isNull);
        expect(find.widgetWithText(AlertDialog, 'Role'), findsOneWidget);
        await f.close(tester);
      },
    );

    testWidgets(
      'every mark, as a Mac that sees the agents\' machine only through sharing shows them (screenshots)',
      (tester) async {
        final f = await fixture(tester);
        await tester.binding.setSurfaceSize(const Size(340, 640));
        final now = DateTime.now().millisecondsSinceEpoch;
        // The agents run on the Mac Studio; this Mac reads it through sharing
        // and has no turn reported for any of them (Dee's view, 2026-10-30).
        f.server.state['machines'] = [
          {
            'machineId': 'm',
            'name': 'Mac Studio',
            'contributorId': 'owner',
            'observation': {'receivedAt': now},
          },
        ];
        final agents = f.server.state['agents'] as List;
        final base = (agents[1] as Map).cast<String, Object>();
        for (final (i, name) in [
          (4, 'Juno'),
          (5, 'Iris'),
          (6, 'Orion'),
          (7, 'Wren'),
          (8, 'Reed'),
          (9, 'Milo'),
        ]) {
          agents.add({
            ...base,
            'id': 'agent-$i',
            'harnessId': 'a$i',
            'name': name,
            'displayName': name,
          });
        }
        (agents[8] as Map)['downSince'] = '2026-10-30T01:00:00.000Z';
        final merge =
            task(
                't5',
                'Reviewer names in the Swarm',
                'agent-5',
                'done',
                ago: const Duration(minutes: 26),
              )
              ..['cards'] = <String, Object>{
                'pullRequests': [
                  <String, Object>{
                    'url': 'https://github.com/o/r/pull/7',
                    'messageId': 'pr-card',
                  },
                ],
              };
        (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          task(
            't1',
            'Sidebar rescan fix',
            'agent-1',
            'working',
            ago: const Duration(minutes: 4),
          ),
          task(
            't3',
            'Pick a sign-in page',
            'agent-3',
            'needs_human',
            ago: const Duration(minutes: 12),
          ),
          task(
            't4',
            'Agents list status marks',
            'agent-4',
            'review',
            ago: const Duration(minutes: 7),
          ),
          merge,
          task(
            't6',
            'Phone Home screen',
            'agent-6',
            'working',
            ago: const Duration(minutes: 11),
          ),
          task(
            't7',
            'Night digest',
            'agent-7',
            'lost',
            ago: const Duration(hours: 3),
          ),
          {
            ...task(
              't9',
              'Firmware build',
              'agent-9',
              'working',
              ago: const Duration(minutes: 2),
            ),
            'liveness': {
              'state': 'orphaned',
              'why': 'start-failed',
              'since': now,
            },
          },
        ]);
        await f.controller.refresh();
        f.app.stateOf('m')!.agents = [
          for (final i in [0, 1, 3, 4, 5, 7])
            Agent(id: 'a$i', name: 'n$i', engine: 'codex'),
        ];
        final expected = {
          3: HarnessActivity.needsInput,
          4: HarnessActivity.done,
          5: HarnessActivity.done,
          1: HarnessActivity.working,
          0: HarnessActivity.idle,
          7: HarnessActivity.offline,
        };
        final saved = grid.AppTheme.brightness.value;
        addTearDown(() => grid.AppTheme.brightness.value = saved);
        for (final brightness in Brightness.values) {
          grid.AppTheme.brightness.value = brightness;
          await f.show(tester, brightness: brightness);
          for (final MapEntry(key: i, value: activity) in expected.entries) {
            expect(f.activity(tester, i), activity, reason: 'agent-$i');
          }
          // Unseen here and past its lease: nobody can say; stopped; a failed
          // start.
          expect(f.activity(tester, 6), HarnessActivity.unknown);
          expect(f.activity(tester, 8), HarnessActivity.paused);
          expect(f.activity(tester, 9), HarnessActivity.failed);
          expect(f.lineText(tester, 1), 'Sidebar rescan fix · 4m');
          await captureBoundary(
            tester,
            f.boundary.currentContext!.findRenderObject()!
                as RenderRepaintBoundary,
            captureDir,
            'agents-every-mark-from-another-mac-${brightness.name}',
          );
        }
        await f.close(tester);
      },
    );

    /// The agents' machine as the Swarm last heard it, [ago] before [at]:
    /// which sessions run and each one's last screen change (backend
    /// observation, liveness.ts reportRenewedAt).
    void reports(
      RosterFixture f, {
      required DateTime at,
      Map<String, Duration> progress = const {},
      Duration ago = Duration.zero,
    }) => f.server.state['machines'] = [
      {
        'machineId': 'm',
        'name': 'Mac Studio',
        'contributorId': 'owner',
        'observation': {
          'receivedAt': at.subtract(ago).millisecondsSinceEpoch,
          'runningHarnessIds': [for (final id in progress.keys) id],
          'stoppedHarnessIds': <String>[],
          'harnessProgress': {
            for (final MapEntry(:key, :value) in progress.entries)
              key: at.subtract(value).millisecondsSinceEpoch,
          },
        },
      },
    ];

    testWidgets(
      'a quiet agent its machine still reports running is working, past the lease its last post set (review of #2281)',
      (tester) async {
        final f = await fixture(tester);
        // Its last status 9 minutes ago; its machine showed its screen change
        // a minute ago: the Swarm holds its task (liveness.ts leaseEnd).
        reports(
          f,
          at: DateTime.now(),
          progress: {'a1': const Duration(minutes: 1)},
        );
        (f.server.state['conversations'] as List).add(
          task(
            't1',
            'Long test suite',
            'agent-1',
            'working',
            ago: const Duration(minutes: 9),
          ),
        );
        await f.controller.refresh();
        seenIdleHere(f);
        await f.show(tester);
        expect(f.activity(tester, 1), HarnessActivity.working);
        await f.show(tester, nativeState: false);
        expect(f.activity(tester, 1), HarnessActivity.working);
        // A screen still for 26 minutes no longer renews it: 5 minutes after
        // its last renewal at 25, nobody vouches for it.
        reports(
          f,
          at: DateTime.now(),
          progress: {'a1': const Duration(minutes: 31)},
        );
        await f.controller.refresh();
        await f.show(tester);
        expect(f.activity(tester, 1), HarnessActivity.unknown);
        await f.close(tester);
      },
    );

    testWidgets(
      'work handed over for review waits (✓) while its status still says working',
      (tester) async {
        final f = await fixture(tester);
        final handed = task(
          't1',
          'Agents list marks',
          'agent-1',
          'working',
          ago: const Duration(minutes: 40),
        );
        (handed['assignment'] as Map)['result'] =
            'Ready for review: PR #2281 at b4c4fa903';
        (f.server.state['conversations'] as List).add(handed);
        await f.controller.refresh();
        seenIdleHere(f);
        await f.show(tester);
        expect(f.activity(tester, 1), HarnessActivity.done);
        // Its words say so too, as for work in review.
        expect(f.glanceText(tester, 1), startsWith('Waiting on others'));
        expect(
          rowTooltip(tester, f, 1),
          contains('Waiting on others for "Agents list marks"'),
        );
        expect(rowTooltip(tester, f, 1), isNot(contains('Assigned')));
        // Once a review finds problems, it is the Engineer's to fix again.
        (handed['assignment'] as Map)['reviewFoundAt'] =
            DateTime.now().millisecondsSinceEpoch;
        await f.controller.refresh();
        await tester.pumpAndSettle();
        expect(f.activity(tester, 1), HarnessActivity.unknown);
        await f.close(tester);
      },
    );

    testWidgets(
      'a project with instructions does not read "ready for review" as a hand-off',
      (tester) async {
        final f = await fixture(tester);
        (f.server.state['projects'] as List)[0]['coordinatorName'] =
            'Product Manager';
        final said = task(
          't1',
          'Agents list marks',
          'agent-1',
          'working',
          ago: const Duration(minutes: 40),
        );
        (said['assignment'] as Map)['result'] =
            'Ready for review: PR #2281 at b4c4fa903';
        (f.server.state['conversations'] as List).add(said);
        await f.controller.refresh();
        seenIdleHere(f);
        await f.show(tester);
        expect(f.activity(tester, 1), isNot(HarnessActivity.done));
        expect(f.glanceText(tester, 1), isNot(startsWith('Waiting on others')));
        await f.close(tester);
      },
    );

    testWidgets(
      'a Mac whose clock runs 5 minutes fast still reads a live lease by the Swarm\'s clock',
      (tester) async {
        final f = await fixture(tester);
        final server = DateTime.now();
        // The first report read is only a baseline; the next one, newer,
        // proves the server's time (review of #2281).
        reports(f, at: server.subtract(const Duration(seconds: 10)));
        await f.controller.refresh();
        await f.show(
          tester,
          nativeState: false,
          now: () => DateTime.now().add(const Duration(minutes: 5)),
        );
        reports(f, at: server);
        // A minute and a half of its five left by the server's clock.
        (f.server.state['conversations'] as List).add(
          task(
            't1',
            'Sidebar rescan fix',
            'agent-1',
            'working',
            ago: const Duration(minutes: 3, seconds: 30),
          ),
        );
        await f.controller.refresh();
        await f.show(
          tester,
          nativeState: false,
          now: () => DateTime.now().add(const Duration(minutes: 5)),
        );
        expect(f.activity(tester, 1), HarnessActivity.working);
        expect(f.lineText(tester, 1), 'Sidebar rescan fix · 3m');
        await f.close(tester);
      },
    );

    testWidgets(
      'a Swarm whose machines all went silent hours ago is read by this Mac\'s clock, not their last report',
      (tester) async {
        final f = await fixture(tester);
        final now = DateTime.now();
        reports(
          f,
          at: now.subtract(const Duration(hours: 2)),
          progress: {'a1': Duration.zero},
        );
        (f.server.state['conversations'] as List).add(
          task(
            't1',
            'Night digest',
            'agent-1',
            'working',
            ago: const Duration(hours: 2, minutes: 1),
          ),
        );
        await f.controller.refresh();
        await f.show(tester, nativeState: false);
        expect(f.activity(tester, 1), isNot(HarnessActivity.working));
        expect(f.lineText(tester, 1), 'Night digest · 2h');
        await f.close(tester);
      },
    );

    testWidgets(
      'on a quiet Swarm the list ticks: the age moves and an expired lease stops showing working',
      (tester) async {
        final f = await fixture(tester);
        var clock = DateTime.now();
        reports(f, at: clock);
        (f.server.state['conversations'] as List).add(
          task(
            't1',
            'Sidebar rescan fix',
            'agent-1',
            'working',
            ago: const Duration(minutes: 4, seconds: 50),
          ),
        );
        await f.controller.refresh();
        await f.show(tester, nativeState: false, now: () => clock);
        expect(f.activity(tester, 1), HarnessActivity.working);
        expect(f.lineText(tester, 1), 'Sidebar rescan fix · 4m');
        // Nothing changes in the Swarm; only time passes.
        clock = clock.add(const Duration(seconds: 30));
        await tester.pump(const Duration(seconds: 30));
        expect(f.activity(tester, 1), HarnessActivity.unknown);
        expect(f.lineText(tester, 1), 'Sidebar rescan fix · 5m');
        await f.close(tester);
      },
    );

    testWidgets(
      'a group a broken server sends that the viewer may not read gives no mark, title, click or details',
      (tester) async {
        final f = await fixture(tester);
        (f.server.state['people'] as List).add({
          'id': 'mira',
          'email': 'mira@example.com',
          'role': 'collaborator',
        });
        f.server.parts.leaksHiddenGroups = true;
        (f.server.state['conversations'] as List).addAll(<Map<String, dynamic>>[
          {
            ...task(
              'private',
              'Private plans',
              'agent-3',
              'working',
              ago: const Duration(minutes: 1),
            ),
            'audience': {
              'people': [
                {'id': 'mira'},
              ],
            },
          },
          {
            ...task(
              'buddy',
              'Mira and Sparky',
              'agent-1',
              'needs_human',
              ago: const Duration(minutes: 1),
            ),
            'kind': 'buddy',
            'buddyOwnerId': 'mira',
          },
        ]);
        await f.controller.refresh();
        // The broken server did send them.
        expect(
          f.controller.snapshot!.conversations.map((g) => g.id),
          containsAll(['private', 'buddy']),
        );
        await f.show(tester, nativeState: false);
        expect(f.activity(tester, 3), HarnessActivity.idle);
        expect(f.activity(tester, 1), HarnessActivity.idle);
        for (final title in ['Private plans', 'Mira and Sparky']) {
          expect(find.textContaining(title), findsNothing);
          expect(rowTooltip(tester, f, 3), isNot(contains(title)));
          expect(rowTooltip(tester, f, 1), isNot(contains(title)));
        }
        expect(
          SuperTabAgentInfo(
            f.controller,
            null,
            f.controller.snapshot!.agent('agent-3')!,
          ).taskGroup,
          isNull,
        );
        // No task it may read: a click opens the details, which name none.
        await tester.tap(f.row(3));
        await tester.pumpAndSettle();
        expect(f.answered, isNull);
        expect(find.widgetWithText(AlertDialog, 'Role'), findsOneWidget);
        expect(find.text('Task'), findsNothing);
        expect(find.textContaining('Private plans'), findsNothing);
        await f.close(tester);
      },
    );

    testWidgets(
      'access revoked while the list is open clears every row and task title',
      (tester) async {
        final f = await fixture(tester);
        (f.server.state['conversations'] as List).add(
          task(
            't1',
            'Sidebar rescan fix',
            'agent-1',
            'working',
            ago: const Duration(minutes: 1),
          ),
        );
        await f.controller.refresh();
        await f.show(tester, nativeState: false);
        expect(find.text('Sidebar rescan fix · 1m'), findsOneWidget);
        f.controller.revokeAccess('Access removed');
        await tester.pumpAndSettle();
        expect(find.textContaining('Sidebar rescan fix'), findsNothing);
        expect(f.row(1), findsNothing);
        await f.close(tester);
      },
    );
  });
}
