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

  /// Ken's one Buddy and models shared in the Swarm (task #2354): one served
  /// by two machines, an API a member shares.
  ConversationServer sharedModels({String? gridModel}) {
    const swarmGrid = 'swarm-0123456789ab';
    final server = oneBuddySwarm();
    server.state['people'] = [
      ...server.state['people'] as List,
      {'id': 'diego', 'email': 'diego@example.com', 'role': 'collaborator'},
    ];
    giveSwarmBuddy(server);
    if (gridModel != null) {
      (server.state['agents'] as List).cast<Map>().firstWhere(
        (a) => a['id'] == 'wren',
      )['gridModel'] = gridModel;
    }
    server.state['localModels'] = {
      'grid': swarmGrid,
      'enabled': true,
      'ready': true,
    };
    Map<String, dynamic> machine(
      String id,
      String name,
      String contributor,
      List<(String, String, String)> served,
    ) => {
      'machineId': id,
      'name': name,
      'contributorId': contributor,
      'scope': 'swarm',
      'engines': <dynamic>[],
      'maxAgents': 4,
      'availableSlots': 4,
      'observation': {
        'receivedAt': DateTime.now().millisecondsSinceEpoch,
        'localModels': [
          for (final (model, name, kind) in served)
            {'grid': swarmGrid, 'model': model, 'name': name, 'kind': kind},
        ],
      },
    };
    server.state['machines'] = [
      (server.state['machines'] as List).first,
      machine('studio', "Ken's Mac Studio", 'owner', [
        ('deepseek-4.1-flash', 'DeepSeek 4.1 Flash', 'local'),
        ('kimi-k3', 'Kimi K3', 'local'),
      ]),
      machine('mini', "Tony's Mac mini", 'owner', [
        ('kimi-k3', 'Kimi K3', 'local'),
      ]),
      machine('diego-mac', 'Diego-MacBook', 'diego', [
        ('openai/gpt-6.1-sol', 'GPT-6.1 Sol', 'api'),
      ]),
    ];
    return server;
  }

  for (final brightness in Brightness.values) {
    testWidgets('Buddy model picker in ${brightness.name}', (tester) async {
      if (shots == null) return;
      final previous = grid.AppTheme.brightness.value;
      grid.AppTheme.brightness.value = brightness;
      addTearDown(() => grid.AppTheme.brightness.value = previous);
      tester.view.devicePixelRatio = 2;
      tester.view.physicalSize = const Size(2400, 1400);
      addTearDown(tester.view.reset);
      for (final (name, gridModel) in [('menu', null), ('shared', 'kimi-k3')]) {
        final c = sharedModels(gridModel: gridModel)
            .controller(account: 'peer');
        await c.refresh();
        await c.select('swarm-buddy-peer');
        await tester.pumpWidget(
          MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: grid.buildAppTheme(brightness: brightness),
            home: Scaffold(
              body: SuperTabView(
                controller: c,
                onInvite: () {},
                onAddAgent: (_) {},
                onOpenTerminal: (_) {},
                machineName: (_) => 'Team Mac',
              ),
            ),
          ),
        );
        await tester.pumpAndSettle();
        if (gridModel == null) {
          await tester.tap(find.byKey(const ValueKey('super-buddy-model')));
          await tester.pumpAndSettle();
        }
        await captureWindow(
          tester,
          shots,
          'buddy-model-$name-${brightness.name}',
        );
        await tester.pumpWidget(const SizedBox());
        await c.flush();
        c.dispose();
      }
    }, variant: TargetPlatformVariant.only(TargetPlatform.macOS));

    // Task #3256: after a switch the Buddy guard held, the bar offers Start
    // again (Scholes approved the mockup, 11-05).
    // The UI checklist's states (review of #3171): the line at 100% and 200%
    // text, while paused (Start again disabled), and the Start bar a start
    // refused after the removal leaves, on the Buddy's machine and engine.
    for (final (state, scale) in [
      ('', 1.0),
      ('-200', 2.0),
      ('-paused', 1.0),
      ('-refused', 1.0),
    ]) {
      testWidgets(
        'Buddy Start again$state after a held switch in ${brightness.name}',
        (tester) async {
          if (shots == null) return;
          final previous = grid.AppTheme.brightness.value;
          grid.AppTheme.brightness.value = brightness;
          addTearDown(() => grid.AppTheme.brightness.value = previous);
          tester.view.devicePixelRatio = 2;
          tester.view.physicalSize = const Size(2400, 1400);
          addTearDown(tester.view.reset);
          final server = sharedModels();
          if (state == '-paused') server.state['paused'] = true;
          if (state == '-refused') {
            (server.state['agents'] as List).cast<Map>().firstWhere(
              (a) => a['id'] == 'wren',
            )['configuration'] = {
              'engine': 'codex',
              'model': 'default',
            };
            server.unknownCommand = (command) =>
                command['type'] == 'buddy.create';
          }
          server.append(
            "Couldn't switch your Buddy: Start your Buddy again to switch its "
            'model. It is still on your subscription.',
            conversationId: 'swarm-buddy-peer',
          );
          server.messages.last
            ..['author'] = {'kind': 'agent', 'id': 'wren', 'name': 'Wren'}
            ..['source'] = {'kind': 'system'};
          final c = server.controller(account: 'peer');
          await c.refresh();
          await c.select('swarm-buddy-peer');
          await tester.pumpWidget(
            MaterialApp(
              debugShowCheckedModeBanner: false,
              theme: grid.buildAppTheme(brightness: brightness),
              builder: (context, child) => MediaQuery(
                data: MediaQuery.of(context)
                    .copyWith(textScaler: TextScaler.linear(scale)),
                child: child!,
              ),
              home: Scaffold(
                body: SuperTabView(
                  controller: c,
                  onInvite: () {},
                  onAddAgent: (_) {},
                  onOpenTerminal: (_) {},
                  machineName: (_) => 'Team Mac',
                ),
              ),
            ),
          );
          await tester.pumpAndSettle();
          expect(
            find.byKey(const ValueKey('super-buddy-start-again')),
            findsOneWidget,
          );
          if (state == '-refused') {
            await tester.tap(find.widgetWithText(TextButton, 'Start again'));
            await tester.pumpAndSettle();
            expect(
              find.byKey(const ValueKey('super-buddy-start')),
              findsOneWidget,
            );
          }
          await captureWindow(
            tester,
            shots,
            'buddy-start-again$state-${brightness.name}',
          );
          await tester.pumpWidget(const SizedBox());
          await c.flush();
          c.dispose();
        },
        variant: TargetPlatformVariant.only(TargetPlatform.macOS),
      );
    }

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
