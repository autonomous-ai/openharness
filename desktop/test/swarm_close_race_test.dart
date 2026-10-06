import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/models.dart';
import 'package:harness/terminal/terminal_session.dart';
import 'package:harness/widgets/terminal_panel.dart';

import 'keymap_runtime_test.dart' show native, nativeChannel;
import 'swarm_screen_test.dart' show mount, terminal;
import 'swarm_state_test.dart' show createApp;

void main() {
  for (final closeActive in [false, true]) {
    test(
      'closing a ${closeActive ? 'selected' : 'background'} tab preserves retained error streams',
      () async {
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        app.stateOf('m')!
          ..nodeOnline = true
          ..terminalCapabilityAvailable = true;
        final session = terminal('a0', []);
        final retained = app.adoptSessionForTest(session);
        final first = app.activeSwarm;
        app.newSwarm(name: 'Closing');
        final closing = app.activeSwarm;
        if (!closeActive) app.selectSwarm(first.id);
        session.transportLost();
        await app.closeSwarm(closing.id);
        expect(app.activeSwarm, same(first));
        expect(app.panes, [retained]);
        expect(retained.session, same(session));
        expect(
          session.status,
          TerminalSessionStatus.error,
          reason: 'Closing a tab is navigation, not a retry of other terminals',
        );
      },
    );
  }

  testWidgets(
    'a stale pane close cannot remove a shared pane from another tab',
    (tester) async {
      final app = createApp();
      final pane = app.adoptSessionForTest(terminal('a0', []));
      final first = app.activeSwarm;
      app.newSwarm(name: 'Second');
      await app.addAgentToSwarm('m', 'a0');
      final second = app.activeSwarm;
      app.selectSwarm(first.id);
      try {
        await mount(tester, app);
        final close = tester
            .widget<TerminalPanel>(find.byType(TerminalPanel))
            .onClose!;
        app.selectSwarm(second.id);
        // Pointer release can arrive before the next frame replaces callbacks.
        close();
        await tester.pump();
        expect(first.panes, [pane]);
        expect(second.panes, [pane]);
        expect(app.closedHistory, isEmpty);
        tester.widget<TerminalPanel>(find.byType(TerminalPanel)).onClose!();
        await tester.pump();
        expect(app.swarms, [first]);
        expect(first.panes, [pane]);
        expect(pane.session, isNotNull);
      } finally {
        await tester.pumpWidget(const SizedBox());
        app.dispose();
      }
    },
  );

  for (final method in ['close', 'closeActive']) {
    testWidgets(
      'native $method acknowledges the new tab while stream cleanup waits',
      (tester) async {
        final app = createApp();
        final closeReply = Completer<bool>();
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          nativeChannel,
          (_) async => null,
        );
        final retained = app.adoptSessionForTest(terminal('a0', []));
        final first = app.activeSwarm;
        app.newSwarm(name: 'Closing');
        final closing = app.activeSwarm;
        app.adoptSessionForTest(
          TerminalSession(
              machineId: 'm',
              agentId: 'a1',
              agentName: 'Closing',
              engineId: 'codex',
              send: (type, _) => type == 'terminal_close'
                  ? closeReply.future
                  : Future.value(true),
              sendBinary: (_) async => true,
            )
            ..status = TerminalSessionStatus.controlling
            ..streamId = 'closing-stream',
        );
        try {
          await mount(tester, app, nativeTabs: true);
          var acknowledged = false;
          final reply = native(tester, method, {
            'id': closing.id,
          }).then((_) => acknowledged = true);
          await tester.pump();
          await tester.pump();
          expect(app.activeSwarm, same(first));
          expect(app.panes, [retained]);
          expect(
            acknowledged,
            isTrue,
            reason: 'AppKit must return keyboard focus before remote cleanup finishes',
          );
          closeReply.complete(true);
          await reply;
        } finally {
          if (!closeReply.isCompleted) closeReply.complete(true);
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            nativeChannel,
            null,
          );
        }
      },
    );
  }

  for (final confirmed in [false, true]) {
    testWidgets(
      'native close returns input while a ${confirmed ? 'confirmed' : 'cancelled'} decision is pending',
      (tester) async {
        final app = createApp();
        final review = Completer<bool>();
        tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
          nativeChannel,
          (_) async => null,
        );
        app.adoptSessionForTest(terminal('a0', []));
        final first = app.activeSwarm;
        app.newSwarm(name: 'Closing');
        final closing = app.activeSwarm;
        final pane = app.adoptSessionForTest(terminal('a1', []));
        app.stateOf('m')!.agents = [
          const Agent(
            id: 'a1',
            name: 'Closing',
            engine: 'codex',
            terminalAvailable: true,
            closeSupported: true,
          ),
        ];
        try {
          await mount(tester, app, nativeTabs: true);
          var reviewed = false;
          app.reviewSessionClose = (targets, {tabName}) {
            reviewed = true;
            return review.future;
          };
          var acknowledged = false;
          final reply = native(tester, 'close', {
            'id': closing.id,
          }).then((_) => acknowledged = true);
          await tester.pump();
          await tester.pump();
          expect(reviewed, isTrue);
          expect(acknowledged, isTrue);
          expect(app.activeSwarm, same(closing));
          expect(app.swarms, [first, closing]);
          expect(closing.panes, [pane]);
          expect(app.closedHistory, isEmpty);
          review.complete(confirmed);
          await reply;
          await tester.pump();
          expect(app.swarms, confirmed ? [first] : [first, closing]);
          expect(app.closedHistory, hasLength(confirmed ? 1 : 0));
        } finally {
          if (!review.isCompleted) review.complete(false);
          await tester.pumpWidget(const SizedBox());
          app.dispose();
          tester.binding.defaultBinaryMessenger.setMockMethodCallHandler(
            nativeChannel,
            null,
          );
        }
      },
    );
  }
}
