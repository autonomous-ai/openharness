// The left pane's fixes of the Desktop 1.3.89 audit (task #4445, group C), for the PR's pictures, light and dark, at
// an 880 window (the left pane at its least) and at 1500: a folded Projects with a tag waiting (finding 19), a row
// reached by Tab beside the selected one (finding 21), and the polish (a long Swarm name, a PM's project after a
// separator, an agent with no chat yet, "No projects yet."). Writes nothing unless HARNESS_SUPER_TAB_CAPTURE
// names a folder.
import 'dart:io';

import 'package:flutter/gestures.dart';
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

final shots = Platform.environment['HARNESS_SUPER_TAB_CAPTURE'];

Map<String, dynamic> _agent(
  String id,
  String name,
  String kind,
  String? chat,
) => {
  'id': id,
  'projectId': 'lead',
  'name': name,
  'displayName': name,
  'machineId': 'host',
  'harnessId': 'session',
  'contributorId': 'owner',
  'configuration': {'engine': 'codex'},
  'kind': kind,
  'chatId': chat,
  'myAgent': true,
};

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  for (final brightness in Brightness.values) {
    for (final width in [880.0, 1500.0]) {
      for (final scene in [
        'folded-waiting',
        'focus',
        'polish',
        'no-projects',
      ]) {
        testWidgets('$scene at ${width.toInt()} (${brightness.name})', (
          tester,
        ) async {
          if (shots == null) return;
          await tester.binding.setSurfaceSize(Size(width, 800));
          addTearDown(() => tester.binding.setSurfaceSize(null));
          final before = grid.AppTheme.brightness.value;
          grid.AppTheme.brightness.value = brightness;
          addTearDown(() => grid.AppTheme.brightness.value = before);
          final server = swarm()..followedThreads = null;
          final groups = (server.state['conversations'] as List)
              .cast<Map<String, dynamic>>();
          if (scene == 'no-projects') {
            server.state['projects'] = <dynamic>[];
            groups.clear();
            server.state['agents'] = <dynamic>[];
          } else {
            server.state['agents'] = [
              _agent('kestrel', 'Kestrel', 'regular', 'agent-chat-kestrel'),
              _agent('orion', 'Orion', 'pm', 'lead'),
              // Brought, with no chat yet: its row opens nothing.
              _agent('sparrow', 'Sparrow', 'regular', null),
            ];
            groups.firstWhere((g) => g['id'] == 'lead')['leadId'] = 'orion';
            groups.add({
              ...conversationFixture('agent-chat-kestrel', 'Kestrel'),
              'kind': 'agent-chat',
              'agentIds': ['kestrel'],
            });
          }
          if (scene == 'folded-waiting') server.tag('message-1');
          if (scene == 'polish') {
            server.state['name'] = 'Autonomous Robotics Collective';
          }
          final c = server.controller(
            account: 'owner',
            initial: {
              'tabId': 'tab',
              'accountId': 'owner',
              if (scene == 'focus') 'selectedId': 'agent-chat-kestrel',
            },
          );
          await tester.runAsync(c.refresh);
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
                  onAddAgent: (_) {},
                  onOpenTerminal: (_) {},
                  machineName: (_) => 'Mac Studio',
                ),
              ),
            ),
          );
          for (var i = 0; i < 3; i++) {
            await tester.runAsync(
              () => Future<void>.delayed(const Duration(milliseconds: 30)),
            );
            await tester.pump(const Duration(milliseconds: 50));
          }
          if (scene == 'polish') {
            // At 880 the Board folds the left pane into its drawer (finding 12): open it as a person would.
            if (find
                .byKey(const ValueKey('super-swarm-switcher'))
                .evaluate()
                .isEmpty) {
              await tester.tap(find.byTooltip('Conversations'));
              await tester.pump(const Duration(milliseconds: 300));
            }
            // The pointer on the cut Swarm name: its tooltip reads all of it.
            final mouse = await tester.createGesture(
              kind: PointerDeviceKind.mouse,
            );
            addTearDown(mouse.removePointer);
            await mouse.addPointer(location: Offset.zero);
            await mouse.moveTo(
              tester.getCenter(
                find.byKey(const ValueKey('super-swarm-switcher')),
              ),
            );
            // Past the hover's wait, then past the tooltip's fade.
            await tester.pump(const Duration(seconds: 1));
            await tester.pump(const Duration(milliseconds: 300));
          }
          if (scene == 'focus') {
            final orion = find.byKey(const ValueKey('super-agent-orion'));
            for (var i = 0; i < 100; i++) {
              await tester.sendKeyEvent(LogicalKeyboardKey.tab);
              await tester.pump();
              final focused = FocusManager.instance.primaryFocus?.context;
              if (focused != null &&
                  find
                      .descendant(
                        of: orion,
                        matching: find.byElementPredicate((e) => e == focused),
                      )
                      .evaluate()
                      .isNotEmpty) {
                break;
              }
            }
            await tester.pump(const Duration(milliseconds: 400));
          }
          expect(tester.takeException(), isNull);
          await captureWindow(
            tester,
            shots,
            'left-pane-$scene-${width.toInt()}-${brightness.name}',
          );
          await tester.pumpWidget(const SizedBox());
          await tester.runAsync(c.flush);
          c.dispose();
          await tester.pump(const Duration(seconds: 5));
        });
      }
    }
  }
}
