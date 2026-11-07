import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/view.dart';

import 'super_tab_activity_lists_test.dart' show swarm;
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show createApp;

/// Set to a folder to write the PR's screenshots there.
final shots = Platform.environment['SUPER_TAB_V3_LEFT_SHOTS'];

Map<String, dynamic> _agent(String id, String name) => {
  'id': id,
  'projectId': 'lead',
  'name': name,
  'displayName': name,
  'machineId': 'host',
  'harnessId': 'session',
  'contributorId': 'owner',
  'configuration': {'engine': 'codex'},
};

/// Swarm v3's left pane and middle (task #4118), in both appearances: My agents with the Buddy first, a PM's crown and an
/// unread name in bold; the chat of a selected agent in the middle; a project's Board with Projects open. Task #4192: no
/// arrows under the org switcher, the Buddy's own avatar, only the server's My agents, and My agents folded.
void main() {
  setUpAll(() async {
    await loadCaptureFonts(shots);
    if (shots != null && Platform.isMacOS) {
      final bytes = ByteData.sublistView(
        await File('/System/Library/Fonts/Apple Symbols.ttf').readAsBytes(),
      );
      await (FontLoader('Apple Symbols')..addFont(Future.value(bytes))).load();
    }
  });

  for (final brightness in Brightness.values) {
    for (final scene in ['agent-chat', 'no-agents', 'board', 'folded']) {
      testWidgets('$scene (${brightness.name})', (tester) async {
        await tester.binding.setSurfaceSize(const Size(1500, 800));
        addTearDown(() => tester.binding.setSurfaceSize(null));
        final before = grid.AppTheme.brightness.value;
        grid.AppTheme.brightness.value = brightness;
        addTearDown(() => grid.AppTheme.brightness.value = before);
        final server = swarm();
        final groups = (server.state['conversations'] as List)
            .cast<Map<String, dynamic>>();
        if (scene == 'no-agents') {
          server.state['agents'] = <dynamic>[];
        } else {
          server.state['swarmBuddy'] = true;
          server.state['agents'] = [
            {
              ..._agent('buddy', 'Buddy'),
              'buddyScope': 'swarm',
              'buddyOf': {'personId': 'owner'},
              'kind': 'buddy',
              'chatId': 'swarm-buddy-owner',
              'myAgent': true,
            },
            {
              ..._agent('kestrel', 'Kestrel'),
              'kind': 'regular',
              'chatId': 'agent-chat-kestrel',
              'myAgent': true,
            },
            {
              ..._agent('orion', 'Orion'),
              'kind': 'pm',
              'chatId': 'lead',
              'myAgent': true,
            },
            // A finished or Team-account agent the server leaves out of My agents (task #4192).
            {
              ..._agent('avatarrow', 'Avatarrow'),
              'kind': 'regular',
              'chatId': null,
              'myAgent': false,
            },
          ];
          groups.add({
            ...conversationFixture('swarm-buddy-owner', 'Buddy'),
            'kind': 'swarm-buddy',
            'buddyOwnerId': 'owner',
            'agentIds': ['buddy'],
          });
          groups.firstWhere((g) => g['id'] == 'lead')['leadId'] = 'orion';
          // A Regular agent's own chat with its person (backend #4116): it needs no Lead.
          groups.add({
            ...conversationFixture('agent-chat-kestrel', 'Kestrel'),
            'kind': 'agent-chat',
            'agentIds': ['kestrel'],
          });
          server.append(
            'Please look at the build.',
            conversationId: 'agent-chat-kestrel',
          );
          server.messages.last['author'] = {
            'kind': 'person',
            'id': 'owner',
            'name': 'owner@example.com',
          };
          server.append(
            'On it: the build fails on the lint step, fixing now.',
            conversationId: 'agent-chat-kestrel',
          );
          server.messages.last['author'] = {
            'kind': 'agent',
            'id': 'kestrel',
            'name': 'Kestrel',
          };
        }
        server.append('Working on the fix.', conversationId: 'offline');
        final c = server.controller(
          account: 'owner',
          initial: {
            'tabId': 'tab',
            'accountId': 'owner',
            'selectedId': 'lead',
            if (scene == 'board' || scene == 'folded')
              'projectsGroupOpen': true,
            if (scene == 'folded') 'agentsGroupOpen': false,
          },
        );
        await tester.runAsync(c.refresh);
        // With an app the left pane has the org switcher and + New agent, as it does in the real window.
        final AppNotifier app = createApp();
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
                rightPane: (_) => Center(
                  child: Text(
                    'Tasks (v3)',
                    style: TextStyle(color: grid.AppPalette.textFaint),
                  ),
                ),
              ),
            ),
          ),
        );
        Future<void> settle() async {
          for (var i = 0; i < 3; i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 30)),
            );
            await tester.pump(const Duration(milliseconds: 50));
          }
        }

        await settle();
        if (scene == 'agent-chat') {
          await tester.tap(find.byKey(const ValueKey('super-agent-kestrel')));
          await settle();
        } else if (scene == 'board') {
          await tester.tap(find.byKey(const ValueKey('super-group-lead')));
          await settle();
        }
        await captureWindow(tester, shots, '$scene-${brightness.name}');
        await tester.pumpWidget(const SizedBox());
        await tester.runAsync(c.flush);
        c.dispose();
        await tester.pump(const Duration(seconds: 5));
      });
    }
  }
}
