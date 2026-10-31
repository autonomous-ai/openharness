import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the one-Buddy PR's pictures there (spec
/// 2026-10-31-one-buddy-per-swarm).
final shots = Platform.environment['SUPER_TAB_ONE_BUDDY_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  ConversationServer swarm() {
    final server = oneBuddySwarm();
    server.state['name'] = 'autonomous.ai';
    server.state['projects'] = [
      projectFixture('lead', 'openharness', 'lead'),
      projectFixture('web', 'web-2', 'web-lead'),
    ];
    (server.state['conversations'] as List).add({
      ...conversationFixture('web-lead', 'Lead'),
      'projectId': 'web',
    });
    giveSwarmBuddy(server);
    // An older Buddy chat in openharness, from before one Buddy per Swarm.
    giveBuddy(server, id: 'old', name: 'Wren');
    (server.state['agents'] as List).removeWhere(
      (a) => (a as Map)['id'] == 'old',
    );
    server.append(
      'Can you check the login retry?',
      conversationId: 'buddy-peer-lead',
    );
    server.messages.last['author'] = {
      'kind': 'person',
      'id': 'peer',
      'name': 'ken.tran@example.com',
    };
    buddyReply(
      server,
      'buddy-peer-lead',
      'It retries three times, then shows the sign-in page.',
    );
    server.append(
      'Your login fix shipped in 0.5.18.',
      conversationId: 'swarm-buddy-peer',
    );
    server.messages.last['author'] = {
      'kind': 'agent',
      'id': 'lead-agent',
      'name': 'River',
    };
    server.messages.last['source'] = {'kind': 'pm-line', 'projectId': 'lead'};
    server.append(
      'which of my tasks are stuck, across projects?',
      conversationId: 'swarm-buddy-peer',
    );
    server.messages.last['author'] = {
      'kind': 'person',
      'id': 'peer',
      'name': 'ken.tran@example.com',
    };
    buddyReply(
      server,
      'swarm-buddy-peer',
      'openharness #196 waits on review; web-2 #88 waits on you.',
    );
    return server;
  }

  for (final brightness in Brightness.values) {
    testWidgets('one Buddy in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2400, 1400);
      addTearDown(tester.view.reset);
      final server = swarm();
      final c = server.controller(account: 'peer');
      await c.refresh();
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
                machineName: (_) => 'Kens-MacBook',
              ),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      Future<void> capture(String name) async {
        await tester.pumpAndSettle();
        await captureBoundary(
          tester,
          picture.currentContext!.findRenderObject()! as RenderRepaintBoundary,
          shots,
          'one-buddy-$name-${brightness.name}',
        );
      }

      await tester.tap(find.byKey(const ValueKey('super-swarm-buddy')));
      await capture('chat');
      await tester.tap(find.byKey(const ValueKey('super-chat-new-session')));
      await tester.pumpAndSettle();
      await tester.tap(
        find.byKey(const ValueKey('super-chat-session-project')),
      );
      await tester.pumpAndSettle();
      await captureWindow(
        tester,
        shots,
        'one-buddy-session-menu-${brightness.name}',
      );
      await tester.tapAt(const Offset(5, 5));
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Buddy options'));
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'one-buddy-menu-${brightness.name}');
      await tester.tap(find.text('Earlier chat in openharness'));
      await capture('earlier-chat');
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    });
  }
}
