import 'dart:io';

import 'package:flutter/gestures.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/harness_activity.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/identity.dart';
import 'package:harness/super_tabs/roster.dart';
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

  testWidgets('a reviewer reads Rev; an agent without a role stays Dev', (
    tester,
  ) async {
    final f = await fixture(tester);
    (f.server.state['agents'] as List)[1]['role'] = 'reviewer';
    await f.controller.refresh();
    await f.show(tester);
    expect(f.inRow(1, find.text('Rev')), findsOneWidget);
    expect(f.inRow(1, find.byTooltip('Reviewer')), findsOneWidget);
    expect(f.inRow(1, find.text('Dev')), findsNothing);
    expect(f.inRow(3, find.text('Dev')), findsOneWidget);
    expect(f.inRow(0, find.text('PM')), findsOneWidget);
    await f.close(tester);
  });

  testWidgets('agents follow project selection', (tester) async {
    final f = await fixture(tester);
    f.app.stateOf('m')!.agents = const [
      Agent(
        id: 'a0',
        name: 'native',
        engine: 'codex',
        title: 'Join Super Tab roster',
      ),
    ];
    await f.show(tester);
    expect(f.row(2), findsNothing);
    for (final i in [0, 1, 3]) {
      expect(f.inRow(i, find.byType(SuperTabAvatar)), findsOneWidget);
      expect(f.inRow(i, find.text(i == 0 ? 'PM' : 'Dev')), findsOneWidget);
      expect(f.inRow(i, find.text('openharness')), findsOneWidget);
    }
    expect(find.text('Join Super Tab roster'), findsNothing);
    expect(find.text('Ready'), findsNothing);
    final nameX = tester.getTopLeft(f.inRow(0, find.text('Atlas'))).dx;
    final projectX = tester.getTopLeft(f.inRow(0, find.text('openharness'))).dx;
    expect(projectX, nameX);
    expect(
      tester.getCenter(f.inRow(0, find.text('Atlas'))).dy,
      lessThan(tester.getCenter(f.inRow(0, find.text('openharness'))).dy),
    );
    expect(tester.getSize(f.row(0)).height, lessThanOrEqualTo(60));
    expect(
      tester.getTopLeft(find.text('owner').first).dx,
      projectX,
      reason: 'People and agent identity use the same text column',
    );
    f.controller.select('os-lead');
    await tester.pumpAndSettle();
    for (final i in [0, 1, 3]) {
      expect(f.row(i), findsNothing);
    }
    expect(f.inRow(2, find.text('autonomous-os')), findsOneWidget);
    expect(find.text('owner'), findsOneWidget);
    await tester.tap(find.byTooltip('Add agent'));
    expect(f.added?.id, 'os-lead');
    f.controller.select('offline');
    await tester.pumpAndSettle();
    expect(f.row(2), findsNothing);
    expect(
      tester.getTopLeft(f.row(0)).dy,
      lessThan(tester.getTopLeft(f.row(1)).dy),
    );
    expect(
      tester.getTopLeft(f.row(1)).dy,
      lessThan(tester.getTopLeft(f.row(3)).dy),
    );
    await tester.tap(f.row(1));
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
        expect(f.row(legacyAgent), findsNothing);
        f.controller.select('os-lead');
        await tester.pumpAndSettle();
        expect(
          f.inRow(legacyAgent, find.text('autonomous-os')),
          findsOneWidget,
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
    expect(f.row(1), findsOneWidget);
    f.controller.select('os-lead');
    await tester.pumpAndSettle();
    expect(f.row(1), findsNothing);
    await f.close(tester);
  });

  testWidgets('no selected project shows no agent rows', (tester) async {
    final f = await fixture(tester);
    f.controller.selectedId = 'missing';
    await f.show(tester);
    for (var i = 0; i < 4; i++) {
      expect(f.row(i), findsNothing);
    }
    expect(find.text('owner'), findsOneWidget);
    expect(find.byTooltip('Add agent'), findsNothing);
    await f.close(tester);
  });

  testWidgets('live turns and unread changes update the same status cell', (
    tester,
  ) async {
    final f = await fixture(tester);
    await f.show(tester);
    expect(f.activity(tester, 0), HarnessActivity.idle);
    final mark = f.inRow(0, find.byType(ActivityMark));
    final position = tester.getTopLeft(mark);
    await f.app.handleEventForTest('m', {
      'type': 'turn_started',
      'agentId': 'a0',
    });
    await tester.pump();
    expect(f.activity(tester, 0), HarnessActivity.working);
    f.app.agentUnread.mark('m', 'a0', AlertKind.done);
    await tester.pump();
    expect(f.activity(tester, 0), HarnessActivity.working);
    await f.app.handleEventForTest('m', {
      'type': 'turn_ended',
      'agentId': 'a0',
    });
    await tester.pump();
    expect(f.activity(tester, 0), HarnessActivity.done);
    expect(
      f.inRow(0, find.byTooltip(HarnessActivity.done.label)),
      findsOneWidget,
    );
    f.app.markAgentSeen('m', 'a0');
    await tester.pump();
    expect(f.activity(tester, 0), HarnessActivity.idle);
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
