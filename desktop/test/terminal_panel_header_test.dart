// The pane header's transport badge: which of the three paths carries this
// pane's bytes, drawn by shape as well as colour, and absent where there is no
// such choice to report.

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/theme/app_theme.dart';
import 'package:harness/widgets/agent_drag.dart';
import 'package:harness/widgets/pane_share_badge.dart';
import 'package:harness/widgets/terminal_panel.dart';

import 'support/real_fonts.dart';

class _PrNotifier extends AppNotifier {
  _PrNotifier()
    : super(
        config: AppConfig.dev,
        authSession: AuthSession(),
        configStore: null,
      );
  int prReads = 0;
  @override
  Future<Map<String, dynamic>> readAgentPullRequest(
    String machineId,
    String agentId,
  ) async {
    prReads++;
    return {
      'status': 'found',
      'number': 260,
      'state': 'Draft',
      'url': 'https://github.com/autonomous-ai/openharness/pull/260',
    };
  }
}

/// Shared by the VM and native fixture: exercise the retained terminal header's
/// actual visibility and foreground wiring with synthetic requests only.
Future<void> verifyPanePrVisibility(WidgetTester tester) async {
  final notifier = _PrNotifier();
  final session = TerminalSession(
    machineId: 'local',
    agentId: 'agent-1',
    agentName: 'Fixture',
    engineId: 'codex',
    send: (_, _) async => true,
    sendBinary: (_) async => true,
  )..status = TerminalSessionStatus.controlling;
  notifier.machineStates['local'] = MachineState(
    const Machine(
      machineId: 'local',
      name: 'Fixture',
      authMode: MachineAuthMode.remote,
    ),
  );
  void branch(String name) {
    notifier.machineStates['local']!.agents = [
      Agent(
        id: 'agent-1',
        name: 'Fixture',
        engine: 'codex',
        project: AgentProject(name: 'fixture', cwd: '/fixture', branch: name),
      ),
    ];
  }

  Widget frame(bool visible) => MaterialApp(
    home: Scaffold(
      body: SizedBox(
        width: 900,
        height: 320,
        child: TerminalPanel(
          notifier: notifier,
          session: session,
          focused: true,
          visible: visible,
        ),
      ),
    ),
  );
  try {
    branch('first');
    notifier.appLifecycleChanged(AppLifecycleState.hidden);
    await tester.pumpWidget(frame(false));
    await tester.pump();
    expect(notifier.prReads, 0);
    notifier.appLifecycleChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(notifier.prReads, 0);
    await tester.pumpWidget(frame(true));
    await tester.pump();
    expect(notifier.prReads, 1);
    expect(find.text('#260 Draft'), findsOneWidget);
    notifier.appLifecycleChanged(AppLifecycleState.hidden);
    branch('second');
    await tester.pumpWidget(frame(true));
    await tester.pump();
    expect(notifier.prReads, 1);
    expect(find.text('#260 Draft'), findsNothing);
    notifier.appLifecycleChanged(AppLifecycleState.resumed);
    await tester.pump();
    expect(notifier.prReads, 2);
    await tester.pump();
    expect(find.text('#260 Draft'), findsOneWidget);
    expect(tester.takeException(), isNull);
  } finally {
    await tester.pumpWidget(const SizedBox());
    session.dispose();
    notifier.dispose();
  }
}

void main() {
  setUpAll(loadRealFonts);
  testWidgets(
    'retained terminal header respects pane and app visibility',
    verifyPanePrVisibility,
  );
  TerminalSession sessionNamed(String name) {
    final session = TerminalSession(
      machineId: 'local',
      agentId: 'agent-1',
      agentName: name,
      engineId: 'codex',
      send: (_, _) async => true,
      sendBinary: (_) async => true,
    );
    session.status = TerminalSessionStatus.controlling;
    session.streamId = 'stream-1';
    return session;
  }

  Future<void> pump(
    WidgetTester tester,
    TerminalSession session, {
    double width = 900,
    bool withPr = false,
    bool compactHeader = false,
    bool showsShares = false,
    Map<String, dynamic>? share,
  }) async {
    // Wider than the pane, and stated: the default test window is 800px, and a
    // `SizedBox(width: 900)` inside it is silently clamped to 800.
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final notifier = withPr
        ? _PrNotifier()
        : AppNotifier(
            config: AppConfig.dev,
            authSession: AuthSession(),
            configStore: null,
          );
    notifier.machineStates['local'] =
        MachineState(
            const Machine(
              machineId: 'local',
              name: 'Office',
              authMode: MachineAuthMode.remote,
            ),
          )
          ..agents = const [
            Agent(
              id: 'agent-1',
              name: 'Desktop',
              engine: 'codex',
              project: AgentProject(
                name: 'autonomous-harness',
                branch: 'main',
                cwd: '/work/autonomous-harness',
              ),
            ),
          ];
    addTearDown(notifier.dispose);
    if (share != null) notifier.shareStatus.record('local', 'agent-1', share);
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: width,
            height: 320,
            child: PaneShareStatus(
              visible: showsShares,
              child: TerminalPanel(
                notifier: notifier,
                session: session,
                focused: true,
                compactHeader: compactHeader,
                onClose: compactHeader ? () {} : null,
              ),
            ),
          ),
        ),
      ),
    );
    await tester.pump();
  }

  for (final width in [420.0, 600.0, 720.0, 900.0]) {
    testWidgets('PR badge remains visible at pane width $width', (
      tester,
    ) async {
      final session = sessionNamed('Desktop');
      addTearDown(session.dispose);
      await pump(tester, session, width: width, withPr: true);
      expect(find.text('#260 Draft'), findsOneWidget);
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    });
  }

  const publicShare = {
    'link': {'id': 'l1', 'visibility': 'public'},
    'shares': [],
  };

  // Sharing stays beside the trailing model and pane controls, including when
  // a connection status fills the title row. It must not overlap either group.
  for (final width in [420.0, 900.0]) {
    for (final status in [
      TerminalSessionStatus.controlling,
      TerminalSessionStatus.takenOver,
    ]) {
      testWidgets(
        'a shared pane keeps its badge before model and controls, ${status.name}, width $width',
        (tester) async {
          final session = sessionNamed('Desktop')..status = status;
          addTearDown(session.dispose);
          await pump(
            tester,
            session,
            width: width,
            compactHeader: true,
            showsShares: true,
            share: publicShare,
          );
          final badge = find.byKey(const ValueKey('pane-share:local:agent-1'));
          expect(badge, findsOneWidget);
          final rect = tester.getRect(badge);
          expect(rect.width, greaterThan(12));
          expect(
            rect.left,
            greaterThan(tester.getRect(find.text('Desktop')).right),
          );
          final model = tester.getRect(
            find.byKey(const ValueKey(('pane-model', 'local', 'agent-1'))),
          );
          final controls = [tester.getRect(find.byType(PaneCloseButton))];
          final agent = tester.getRect(
            find.byKey(const ValueKey('pane-agent-control')),
          );
          expect(rect.right, closeTo(agent.left, 1));
          expect(agent.right, closeTo(model.left, 1));
          expect(model.right, closeTo(controls.first.left, 1));
          for (var i = 1; i < controls.length; i++) {
            expect(controls[i - 1].right, closeTo(controls[i].left, 1));
          }
          expect(controls.last.right, closeTo(width - 4, 1));
          if (width > 560) expect(find.text('Public'), findsOneWidget);
          expect(tester.takeException(), isNull);
          await tester.pumpWidget(const SizedBox());
        },
      );
    }
  }

  testWidgets('without the web scope a shared pane shows no mark', (
    tester,
  ) async {
    final session = sessionNamed('Desktop');
    addTearDown(session.dispose);
    await pump(tester, session, compactHeader: true, share: publicShare);
    expect(
      find.byKey(const ValueKey('pane-share:local:agent-1')),
      findsNothing,
    );
    await tester.pumpWidget(const SizedBox());
  });

  // Each shape describes the path topology, not an assumed speed: direct link, intermediate hop,
  // backend server. Tooltip and semantics use the protocol names people will diagnose with.
  testWidgets(
    'connection status follows the session name without moving project details',
    (tester) async {
      final session = sessionNamed('Desktop');
      addTearDown(session.dispose);
      // Keep the full project readable beside both agent and model controls.
      await pump(tester, session, width: 1100);
      final project = find.text('autonomous-harness');
      final projectRect = tester.getRect(project);
      for (final (status, label) in [
        (TerminalSessionStatus.opening, 'Connecting'),
        (TerminalSessionStatus.resyncing, 'Restoring'),
        (TerminalSessionStatus.closed, 'Reconnect'),
        (TerminalSessionStatus.error, 'Reconnect'),
      ]) {
        session.status = status;
        await pump(tester, session, width: 1100);
        final nameRect = tester.getRect(find.text('Desktop'));
        final statusRect = tester.getRect(
          find.widgetWithText(TextButton, label),
        );
        expect(statusRect.left, greaterThan(nameRect.right));
        expect(statusRect.right, lessThan(projectRect.left));
        expect(tester.getRect(project), projectRect);
        expect(tester.takeException(), isNull);
      }
    },
  );

  testWidgets(
    'the transport badge describes each link mode by shape, colour, and label',
    (tester) async {
      final marks = {
        'p2p': (
          icon: AppIcons.link2,
          color: AppColors.success,
          label: 'P2P · Direct peer connection',
        ),
        'turn': (
          icon: AppIcons.waypoints,
          color: AppColors.warning,
          label: 'TURN · Via Cloudflare relay',
        ),
        'relay': (
          icon: AppIcons.server,
          color: AppColors.mutedStrong,
          label: 'WS · Via Harness WebSocket relay',
        ),
      };

      for (final entry in marks.entries) {
        final session = sessionNamed('a');
        addTearDown(session.dispose);
        session.linkMode = entry.key;
        await pump(tester, session);

        final mark = find.byIcon(entry.value.icon);
        expect(
          mark,
          findsOneWidget,
          reason: 'link mode ${entry.key} has the wrong topology',
        );
        expect(tester.widget<Icon>(mark).color, entry.value.color);
        expect(tester.widget<Icon>(mark).size, 14);
        expect(find.byTooltip(entry.value.label), findsOneWidget);
        expect(find.bySemanticsLabel(entry.value.label), findsOneWidget);
        // Exactly one of the three, never two at once.
        for (final other in marks.values.where(
          (value) => value.icon != entry.value.icon,
        )) {
          expect(find.byIcon(other.icon), findsNothing);
        }
      }
    },
  );

  testWidgets('a terminal with no link mode gets no badge at all', (
    tester,
  ) async {
    // This is the local-machine case: the CLI never sends terminal_link_mode for a terminal on this
    // same computer, because there is no transport choice to report.
    final session = sessionNamed('a');
    addTearDown(session.dispose);
    expect(session.linkMode, isNull);
    await pump(tester, session);

    for (final icon in [AppIcons.link2, AppIcons.waypoints, AppIcons.server]) {
      expect(find.byIcon(icon), findsNothing);
    }
  });

  testWidgets('a live transport change replaces the badge in place', (
    tester,
  ) async {
    final session = sessionNamed('a');
    addTearDown(session.dispose);
    session.linkMode = 'p2p';
    await pump(tester, session);

    expect(find.byIcon(AppIcons.link2), findsOneWidget);
    final position = tester.getCenter(find.byIcon(AppIcons.link2));
    session.linkMode = 'turn';
    await pump(tester, session);
    expect(find.byIcon(AppIcons.link2), findsNothing);
    expect(find.byIcon(AppIcons.waypoints), findsOneWidget);
    expect(tester.getCenter(find.byIcon(AppIcons.waypoints)), position);

    session.linkMode = 'relay';
    await pump(tester, session);
    expect(find.byIcon(AppIcons.waypoints), findsNothing);
    expect(find.byIcon(AppIcons.server), findsOneWidget);
    expect(tester.getCenter(find.byIcon(AppIcons.server)), position);
  });

  // ── the harness verdict chip ─────────────────────────────────────────────

  Future<AppNotifier> pumpWithAgent(
    WidgetTester tester,
    TerminalSession session,
    Agent agent, {
    AppNotifier? app,
  }) async {
    tester.view.physicalSize = const Size(1200, 800);
    tester.view.devicePixelRatio = 1;
    addTearDown(tester.view.reset);
    final notifier =
        app ??
        AppNotifier(
          config: AppConfig.dev,
          authSession: AuthSession(),
          configStore: null,
        );
    if (app == null) addTearDown(notifier.dispose);
    notifier.machineStates['local'] = MachineState(
      const Machine(
        machineId: 'local',
        authMode: MachineAuthMode.remote,
        name: 'This Mac',
      ),
    )..agents = [agent];
    await tester.pumpWidget(
      MaterialApp(
        home: Scaffold(
          body: SizedBox(
            width: 900,
            height: 320,
            child: TerminalPanel(
              notifier: notifier,
              session: session,
              focused: true,
            ),
          ),
        ),
      ),
    );
    await tester.pump();
    return notifier;
  }

  Agent agentWith(AgentVerdict? verdict) => Agent(
    id: 'agent-1',
    name: 'a',
    engine: 'claude',
    dsh: 'autonomous/autonomous-circuit',
    dshName: 'Autonomous Circuit',
    terminalAvailable: true,
    verdict: verdict,
  );

  testWidgets(
    'a harness agent is drawn as its harness, with no chip of its own',
    (tester) async {
      final chip = find.byKey(const ValueKey('pane-verdict-chip'));
      final session = sessionNamed('a');
      addTearDown(session.dispose);
      final notifier = await pumpWithAgent(
        tester,
        session,
        agentWith(
          const AgentVerdict(ready: true, summary: 'Board is fab-ready'),
        ),
      );
      // Its harness — icon and name, like every other pane; no second mark
      // for the engine underneath (owner, 2026-09-15).
      expect(
        find.byKey(const ValueKey('engine-icon-autonomous/autonomous-circuit')),
        findsOneWidget,
      );
      expect(
        find.byKey(const ValueKey('pane-header-base-engine')),
        findsNothing,
      );
      // The verdict is the viewer pane's to show (owner, 2026-09-15): the
      // terminal header carries none, before or after a verdict arrives.
      expect(chip, findsNothing);
      await pumpWithAgent(
        tester,
        session,
        agentWith(const AgentVerdict(ready: false, errors: 2)),
        app: notifier,
      );
      expect(chip, findsNothing);
      expect(find.text('2 errors'), findsNothing);
    },
  );
}
