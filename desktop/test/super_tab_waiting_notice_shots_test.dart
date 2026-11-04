import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart' show FontLoader;
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/notify/agent_alerts.dart';
import 'package:harness/notify/alert_sounds.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart' show AgentLoadStatus;
import 'package:harness/state/notification_inbox.dart';
import 'package:harness/super_tabs/workspace.dart';
import 'package:harness/terminal/terminal_binary.dart';
import 'package:harness/terminal/terminal_font_store.dart';
import 'package:xterm/xterm.dart' show TerminalStyle;
import 'package:harness/widgets/agent_alert_banners.dart';
import 'package:harness/widgets/pane_grid.dart';
import 'package:harness/ws/local_cli_discovery.dart' show LocalCliEndpoint;

import 'super_tab_launch_test.dart'
    show SuperTabFixtureConnection, SuperTabLaunchFixture;
import 'super_tab_waiting_notice_test.dart' show waitingSwarm;
import 'support/capture.dart';

/// Set to a folder to write the PR's screenshots there.
final _shots = Platform.environment['HARNESS_WAITING_NOTICE_CAPTURE_DIR'];

/// What Nova's terminal holds: Claude Code stopped at a permission prompt,
/// as Egret3 was when Huy clicked its toast.
const _prompt =
    '⏺ I will run the Desktop widget tests for the notice click.\r\n'
    '\r\n'
    '╭───────────────────────────────────────────────────────────────────╮\r\n'
    '│ Bash command                                                      │\r\n'
    '│                                                                   │\r\n'
    '│   flutter test test/super_tab_waiting_notice_test.dart            │\r\n'
    '│   Run the waiting-notice widget tests                             │\r\n'
    '│                                                                   │\r\n'
    '│ Do you want to proceed?                                           │\r\n'
    '│ ❯ 1. Yes                                                          │\r\n'
    "│   2. Yes, and don't ask again for flutter test commands           │\r\n"
    '│   3. No, and tell Claude what to do differently (esc)             │\r\n'
    '╰───────────────────────────────────────────────────────────────────╯\r\n';

/// The machine's daemon, answering Nova's terminal with its screen.
class _PromptConnection extends SuperTabFixtureConnection {
  _PromptConnection(super.store);

  @override
  Future<bool> sendTerminalFrame(
    String type,
    Map<String, dynamic> payload,
  ) async {
    if (type != 'terminal_open') return true;
    const stream = SuperTabFixtureConnection.streamId;
    await event('terminal_ready', {
      'requestId': payload['requestId'],
      'protocolVersion': 3,
      'streamId': stream,
      'agentId': payload['agentId'],
    });
    await app.handleTerminalBinaryForTest(
      'm',
      encodeTerminalLocal(
        TerminalBinaryFrame(
          kind: TerminalBinaryKind.keyframe,
          streamId: stream,
          seq: 0,
          bytes: Uint8List.fromList(utf8.encode(_prompt)),
          compressed: false,
          cols: 100,
          rows: 30,
        ),
      )!,
    );
    return true;
  }
}

/// Each way a Waiting on you notice opens Nova's terminal at its prompt, and
/// the reason for Finn, whom no chat holds (#2792). The Team account this
/// runs in has no screen, so the pane is drawn here against a daemon fixture
/// that holds a real prompt.
void main() {
  setUpAll(() async {
    await loadCaptureFonts(_shots);
    // The terminal's own font, so the prompt reads as it does on a Mac.
    const mono = '/System/Library/Fonts/SFNSMono.ttf';
    if (_shots != null && File(mono).existsSync()) {
      final bytes = ByteData.sublistView(await File(mono).readAsBytes());
      await (FontLoader('SF Mono')..addFont(Future.value(bytes))).load();
    }
  });

  for (final brightness in Brightness.values) {
    testWidgets('screenshots for review (${brightness.name})', (tester) async {
      await tester.binding.setSurfaceSize(const Size(1280, 800));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      final f = SuperTabLaunchFixture(
        connectionFactory: (store) => _PromptConnection(store),
      );
      final c = await waitingSwarm(f);
      // No threads followed: Activity lists only what needs the reader.
      f.connection.server.followedThreads = {
        'unread': <dynamic>[],
        'read': <dynamic>[],
        'more': false,
      };
      // Nova runs in Claude Code and waits at its prompt, on a connected Mac.
      for (final agent in f.connection.server.state['agents'] as List) {
        agent['configuration'] = {'engine': 'claude'};
      }
      await c.refresh();
      f.app.stateOf('m')!
        // This Mac, reached over its own daemon as the reader's is.
        ..localEndpoint = LocalCliEndpoint(
          computerId: 'fixture',
          wsUri: Uri.parse('ws://fixture.invalid'),
          protocolVersion: 1,
          terminalProtocolVersion: 3,
        )
        ..nodeOnline = true
        ..connectionStatus = ConnectionStatus.connected
        ..agentLoadStatus = AgentLoadStatus.loaded
        ..terminalCapabilityAvailable = true
        ..agents = [
          for (final (id, name) in [('nova', 'Nova'), ('finn', 'Finn')])
            Agent.fromJson({
              'id': 'native-$id',
              'name': name,
              'engine': 'claude',
              'status': 'running',
              'sessionId': 'session-$id',
              'terminal': {'available': true},
            }),
        ];
      f.app.agentAlerts.store.value = true;
      addTearDown(() => f.app.agentAlerts.store.value = false);
      final font = terminalFontStore.value;
      terminalFontStore.value = const TerminalStyle(
        fontFamily: 'SF Mono',
        fontSize: 13,
      );
      addTearDown(() => terminalFontStore.value = font);
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: brightness),
          home: Scaffold(
            body: Stack(
              children: [
                ListenableBuilder(
                  listenable: f.app,
                  builder: (_, _) => SuperTabWorkspace(
                    app: f.app,
                    canvas: PaneGrid(notifier: f.app, swarmMode: true),
                    onAddAgent: (_) {},
                  ),
                ),
                AgentAlertBanners(notifier: f.app),
              ],
            ),
          ),
        ),
      );
      // A terminal keeps drawing (its cursor), so frames rather than a settle.
      Future<void> frames([int count = 20]) async {
        for (var frame = 0; frame < count; frame++) {
          await tester.pump(const Duration(milliseconds: 100));
        }
      }

      Future<void> shot(String name) =>
          captureWindow(tester, _shots, 'waiting-$name-${brightness.name}');

      /// Nova's terminal is open beside the task, focused, at its prompt.
      void atPrompt() {
        expect(c.selectedId, 'task');
        expect(c.terminalAgents('task').single.id, 'nova');
        final pane = f.app.focusedPane;
        expect(pane?.agentId, 'native-nova');
        // The prompt the daemon sent is on the pane's own terminal.
        expect(
          pane?.session?.terminal.buffer.getText(),
          contains('Do you want to proceed?'),
        );
      }

      /// Back to the project chat with no terminal, for the next way in.
      Future<void> back() async {
        c.selectTerminal('task', null);
        await c.select('lead');
        await frames();
        expect(c.terminalAgents('task'), isEmpty);
      }

      Future<void> toast(String agent) async {
        f.app.agentAlerts.post(
          AgentAlert(
            machineId: 'm',
            agentId: 'native-$agent',
            title: agent == 'nova' ? 'Nova' : 'Finn',
            kind: AlertKind.needsYou,
            at: DateTime.now(),
          ),
        );
        await frames(5);
      }

      await frames();
      await toast('nova');
      await shot('toast');
      await tester.tap(find.byKey(const Key('agent-alert-banner')));
      await frames();
      atPrompt();
      await shot('toast-opened');

      await back();
      await tester.tap(find.byKey(const ValueKey('super-activity')));
      await frames();
      await shot('activity');
      await tester.tap(find.text('Nova is waiting on you'));
      await frames();
      atPrompt();
      await shot('activity-opened');

      await back();
      // The bell's row, as its dropdown opens it.
      await openInboxNotification(
        f.app,
        const InboxNotification(
          machineId: 'm',
          agentId: 'native-nova',
          title: 'Nova',
          detail: '',
          kind: AlertKind.needsYou,
          unavailable: null,
        ),
      );
      await frames();
      atPrompt();
      await shot('bell-opened');

      await toast('finn');
      await tester.tap(find.byKey(const Key('agent-alert-banner')));
      await frames(10);
      expect(find.byType(SnackBar), findsOneWidget);
      await shot('no-chat');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      f.app.superTabs.dispose();
      // Its terminals keep timers until the app goes.
      f.dispose();
      await tester.pump();
    });
  }
}
