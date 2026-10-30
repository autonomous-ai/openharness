// Phone-width web, no machine connected at all: #openharness and the Buddy
// chat drawn from what the browser read straight from the backend
// (docs/specs/2026-10-30-web-swarm-direct.md), in light and dark.
//
// SUPER_TAB_WEB_SHOTS=<folder> writes the pictures there for the pull request.
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/auth/auth_session.dart';
import 'package:harness/core/config.dart';
import 'package:harness/core/models.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/state/pane_layout_store.dart';
import 'package:harness/super_tabs/view.dart';
import 'package:harness/viewer/viewer_key_store.dart';
import 'package:harness/viewer/viewer_services.dart';

import 'support/buddy_fixture.dart';
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'support/web_swarm_backend.dart';
import 'swarm_state_test.dart' show MemoryStore;

final shots = Platform.environment['SUPER_TAB_WEB_SHOTS'];
const _tab = '0123456789abcdef01234567';
const _buddyChat = 'buddy-owner-lead';

ConversationServer _swarm() {
  final server = buddySwarm()
    ..state['id'] = _tab
    ..state['name'] = 'openharness';
  giveBuddy(
    server,
    person: 'owner',
    id: 'sage',
    name: 'Sage',
    machineId: 'studio',
    machineOwnerId: 'owner',
  );
  server.append('Web chats now load with no machine connected.');
  server.messages.last['author'] = {
    'kind': 'agent',
    'id': 'lead-agent',
    'name': 'Lead',
  };
  server.append(
    'Can my phone read the Swarm when my Mac is asleep?',
    conversationId: _buddyChat,
  );
  server.messages.last['author'] = {
    'kind': 'person',
    'id': 'owner',
    'name': 'owner@example.com',
  };
  buddyReply(
    server,
    _buddyChat,
    'Yes: the browser now reads it from Harness itself, signed in as you.',
    agentId: 'sage',
    name: 'Sage',
  );
  return server;
}

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    testWidgets('phone web, no machine: #openharness and the Buddy chat in '
        '${brightness.name}', (tester) async {
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 3;
      tester.view.physicalSize = const Size(390 * 3, 844 * 3);
      addTearDown(tester.view.reset);

      final server = _swarm();
      final session = AuthSession(storage: MemoryStore());
      final app = AppNotifier(
        config: AppConfig.dev,
        authSession: session,
        configStore: null,
        // Every saved setting and Swarm view in memory: never this Mac's files.
        paneLayoutStore: PaneLayoutStore(storage: MemoryStore()),
        viewer: ViewerServices(
          config: AppConfig.dev,
          session: session,
          keys: ViewerKeyStore(storage: MemoryStore()),
        ),
      );
      final backend = WebSwarmBackend(server);
      app.api = backend;
      app.currentUser = const CurrentUserProfile(
        id: 'owner',
        email: 'owner@example.com',
      );
      expect(app.machineStates, isEmpty);

      final c = await tester.runAsync(() async {
        final c = await app.superTabs.open(_tab);
        await c.refresh();
        return c;
      });
      expect(c!.error, isNull);

      final picture = GlobalKey();
      await tester.pumpWidget(
        MaterialApp(
          debugShowCheckedModeBanner: false,
          theme: grid.buildAppTheme(brightness: brightness),
          home: RepaintBoundary(
            key: picture,
            child: Scaffold(
              body: SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                onNewProject: () {},
                machineName: (_) => 'Studio',
              ),
            ),
          ),
        ),
      );
      Future<void> show(String id, String name, String text) async {
        await tester.runAsync(() async {
          await c.select(id);
          await c.loadMessages(id);
        });
        await tester.pumpAndSettle();
        expect(c.error, isNull);
        expect(find.textContaining(text), findsWidgets);
        if (shots != null) {
          await captureBoundary(
            tester,
            picture.currentContext!.findRenderObject()!
                as RenderRepaintBoundary,
            shots,
            'web-direct-$name-${brightness.name}',
          );
        }
      }

      await show('lead', 'openharness', 'Web chats now load');
      await show(_buddyChat, 'buddy', 'reads it from Harness itself');
      expect(backend.calls, isNotEmpty);
      // Closing the Swarm and the app stops their timers before the test ends.
      await tester.pumpWidget(const SizedBox());
      app.currentUser = null;
      app.dispose();
      await tester.pump(const Duration(seconds: 1));
    });
  }
}
