import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/capture.dart';
import 'support/super_tab_fixture.dart';

/// Set to a folder to write the Buddy PR's pictures there.
final shots = Platform.environment['SUPER_TAB_BUDDY_SHOTS'];

void main() {
  setUpAll(() => loadCaptureFonts(shots));

  ConversationServer swarm() {
    final server = buddySwarm();
    server.state['name'] = 'openharness';
    server.state['projects'] = [
      projectFixture('lead', 'openharness', 'lead'),
      projectFixture('web', 'web-2', 'web-lead'),
    ];
    (server.state['conversations'] as List).add({
      ...conversationFixture('web-lead', 'Lead'),
      'projectId': 'web',
    });
    giveBuddy(server);
    giveBuddy(server, projectId: 'web', id: 'moss', name: 'Moss');
    // Other people's Buddies run in the Swarm too; no list shows them.
    giveBuddy(
      server,
      person: 'owner',
      id: 'sage',
      name: 'Sage',
      machineId: 'studio',
      machineOwnerId: 'owner',
    );
    // The reader's own web Buddy is the one that is down.
    (server.state['agents'] as List).cast<Map>().firstWhere(
      (a) => a['id'] == 'moss',
    )['downSince'] = '2026-10-28T09:00:00Z';
    server.append(
      'I want people to keep editing when the network drops.',
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
      'Three ways to scope it:\n1. Desktop only, last 50 messages cached (recommended)\n2. Desktop and phone\n3. Full offline workspace\nWhich fits?',
    );
    buddyReply(
      server,
      'lead',
      "Proposal from ken.tran's Buddy, on ken.tran's behalf\nGoal: Keep editing while offline\nScope: Desktop only, last 50 messages cached\nPriority: high",
      source: {
        'kind': 'buddy-proposal',
        'personId': 'peer',
        'ownerMessageId': 'message-1',
      },
    );
    server.decisions.add({
      'id': 'd1',
      'projectId': 'lead',
      'projectName': 'openharness',
      'conversationId': 'lead',
      'conversationTitle': 'Lead',
      'askerName': 'Lead',
      'question': 'Ship offline editing behind a flag?',
      'options': ['Yes', 'No'],
      'recommended': 0,
      'unblocks': 'The Desktop release',
      'createdAt': '2026-10-28T09:00:00Z',
    });
    server.state['decisionsWaiting'] = 1;
    return server;
  }

  for (final brightness in Brightness.values) {
    testWidgets('Buddies in ${brightness.name}', (tester) async {
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
                machineName: (_) => 'Team Mac',
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
          'buddy-$name-${brightness.name}',
        );
      }

      await c.select('buddy-peer-lead');
      await capture('chat');
      // Rename Buddy (Diego, 10-29): the ⋮ menu, the dialog, then the header.
      await tester.tap(find.byTooltip('Buddy options'));
      await tester.pumpAndSettle();
      await captureWindow(
        tester,
        shots,
        'buddy-rename-menu-${brightness.name}',
      );
      await tester.tap(find.text('Rename Buddy…'));
      await tester.pumpAndSettle();
      await tester.enterText(
        find.byKey(const ValueKey('super-buddy-name')),
        'Sparky',
      );
      await tester.pumpAndSettle();
      await captureWindow(tester, shots, 'buddy-rename-${brightness.name}');
      await tester.tap(find.text('Save'));
      await capture('renamed');
      await c.select('buddy-peer-web');
      await capture('offline');
      await c.select('lead');
      await capture('proposal');
      // Remove the web Buddy so the dialog has a project to offer.
      (server.state['agents'] as List).removeWhere(
        (a) => (a as Map)['id'] == 'moss',
      );
      await c.refresh();
      await tester.pumpAndSettle();
      await tester.tap(find.byTooltip('Add a Buddy'));
      await tester.pumpAndSettle();
      // The dialog is a route of its own, above the captured screen.
      await captureWindow(tester, shots, 'buddy-add-${brightness.name}');
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      await tester.pumpWidget(const SizedBox());
      await c.flush();
      c.dispose();
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));
  }
}
