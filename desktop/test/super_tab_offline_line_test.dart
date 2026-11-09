import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/swarm_v4_data.dart';
import 'swarm_state_test.dart' show createApp;

/// Audit finding 7 of task #4211 (task #4250): losing the connection was invisible outside a chat. One line,
/// whatever the middle holds: a project's channel or an agent's chat.
final shots = Platform.environment['SUPER_TAB_OFFLINE_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));
  Finder key(String k) => find.byKey(ValueKey(k));

  Future<(ConversationServer, SuperTabController)> mount(
    WidgetTester tester,
    Brightness brightness,
  ) async {
    await tester.binding.setSurfaceSize(const Size(1500, 800));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final before = grid.AppTheme.brightness.value;
    grid.AppTheme.brightness.value = brightness;
    addTearDown(() => grid.AppTheme.brightness.value = before);
    final server = swarmV4Server();
    final c = server.controller(
      account: 'owner',
      initial: {'tabId': 'tab', 'accountId': 'owner', 'selectedId': 'lead'},
    );
    addTearDown(c.dispose);
    await tester.runAsync(c.refresh);
    final app = createApp();
    addTearDown(app.dispose);
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: c,
            app: app,
            onNewSwarm: () {},
            onInvite: () {},
            onAddAgent: (_) {},
            onOpenTerminal: (_) {},
            machineName: (_) => 'Mac Studio',
            board: true,
          ),
        ),
      ),
    );
    await tester.pumpAndSettle();
    return (server, c);
  }

  /// The connection is lost: the next read of the Swarm fails and what was read stays.
  Future<void> goOffline(
    WidgetTester tester,
    ConversationServer server,
    SuperTabController c,
  ) async {
    server.failReads = true;
    await tester.runAsync(c.refresh);
    await tester.pump();
  }

  for (final brightness in Brightness.values) {
    // A project's channel and an agent's chat.
    for (final place in ['super-group-lead', 'super-agent-second']) {
      testWidgets('${brightness.name}: $place says it is reconnecting, once, '
          'and Retry reads again', (tester) async {
        final (server, c) = await mount(tester, brightness);
        await tester.tap(key(place));
        await tester.pumpAndSettle();
        expect(key('super-reconnecting'), findsNothing);
        await goOffline(tester, server, c);
        expect(key('super-reconnecting'), findsOneWidget);
        await captureWindow(tester, shots, 'offline-$place-${brightness.name}');
        server.failReads = false;
        // The line's own Retry, in the row of the words.
        await tester.tap(
          find.descendant(
            of: find
                .ancestor(
                  of: key('super-reconnecting'),
                  matching: find.byType(Row),
                )
                .first,
            matching: find.text('Retry'),
          ),
        );
        await tester.runAsync(
          () => Future<void>.delayed(const Duration(milliseconds: 50)),
        );
        await tester.pumpAndSettle();
        expect(key('super-reconnecting'), findsNothing);
      });
    }
  }
}
