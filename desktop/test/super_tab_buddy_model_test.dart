import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_icons.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/shared/widgets/app_menu.dart';
import 'package:harness/state/workspace_chrome.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/local_models.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/buddy_fixture.dart';
import 'support/super_tab_fixture.dart';

/// A person switches their Buddy between their own subscription and a model
/// shared in the Swarm (task #2354, docs/plans/2026-11-03-buddy-model-switch-design.md):
/// the bar's picker offers what the server accepts and names who serves each
/// model; whoever serves one sees which Buddies run on it.
void main() {
  const swarmGrid = 'swarm-0123456789ab';

  List<Map<String, dynamic>> commands(ConversationServer server, String type) =>
      [
        for (final post in server.posts)
          if ((post['command'] as Map)['type'] == type)
            Map<String, dynamic>.from(post['command'] as Map),
      ];

  int now() => DateTime.now().millisecondsSinceEpoch;

  Map<String, dynamic> machine(
    String id,
    String name,
    String contributor,
    List<Map<String, dynamic>> served, {
    int? at,
    bool buddyOnly = false,
  }) => {
    'machineId': id,
    'name': name,
    'contributorId': contributor,
    'scope': 'swarm',
    'engines': <dynamic>[],
    'maxAgents': 4,
    'availableSlots': 4,
    'buddyOnly': ?(buddyOnly ? true : null),
    'observation': {'receivedAt': at ?? now(), 'localModels': served},
  };

  /// Ken's (`peer`) one Buddy runs on his Mac; the Swarm's grid is on, and
  /// its members' machines serve models on it, and on others.
  ConversationServer swarm({
    String? gridModel,
    Map<String, dynamic>? modelRequest,
    bool localModels = true,
    bool buddyOnly = false,
  }) {
    final server = oneBuddySwarm();
    server.state['people'] = [
      ...server.state['people'] as List,
      {'id': 'tony', 'email': 'tony@example.com', 'role': 'collaborator'},
      {'id': 'diego', 'email': 'diego@example.com', 'role': 'collaborator'},
    ];
    giveSwarmBuddy(server);
    final buddy = (server.state['agents'] as List).cast<Map>().firstWhere(
      (a) => a['id'] == 'wren',
    );
    if (gridModel != null) buddy['gridModel'] = gridModel;
    if (modelRequest != null) buddy['modelRequest'] = modelRequest;
    if (localModels) {
      server.state['localModels'] = {
        'grid': swarmGrid,
        'enabled': true,
        'ready': true,
      };
    }
    final kenMac = (server.state['machines'] as List).first as Map;
    if (buddyOnly) kenMac['buddyOnly'] = true;
    server.state['machines'] = [
      kenMac,
      machine('studio', 'Studio.local', 'owner', [
        {
          'grid': swarmGrid,
          'model': 'deepseek-4.1-flash',
          'name': 'DeepSeek 4.1 Flash',
          'kind': 'local',
        },
        {'grid': swarmGrid, 'model': 'kimi-k3', 'name': 'Kimi K3'},
        // Still starting: the grid does not list it yet.
        {
          'grid': swarmGrid,
          'model': 'qwen-3.6',
          'name': 'Qwen 3.6',
          'starting': true,
        },
        // Shared with the owner from another grid: their machine alone.
        {'grid': 'team', 'model': 'muse', 'name': 'Muse', 'kind': 'shared'},
        // Another Swarm's grid.
        {
          'grid': 'swarm-ffffffffffff',
          'model': 'other',
          'name': 'Other Grid',
          'kind': 'local',
        },
      ]),
      machine('tony-mini', 'Tonys-Mac-mini.local', 'tony', [
        {
          'grid': swarmGrid,
          'model': 'kimi-k3',
          'name': 'Kimi K3',
          'kind': 'local',
        },
      ]),
      machine('diego-mac', 'Diego-MacBook.local', 'diego', [
        {
          'grid': swarmGrid,
          'model': 'openai/gpt-6.1-sol',
          'name': 'GPT-6.1 Sol',
          'kind': 'api',
        },
      ]),
      // Its reading is ten minutes old: it says nothing now.
      machine('old-box', 'Old-Box.local', 'owner', [
        {
          'grid': swarmGrid,
          'model': 'stale-model',
          'name': 'Stale Model',
          'kind': 'local',
        },
      ], at: now() - 10 * 60 * 1000),
      // A Buddy-only machine never joins the Swarm's grid.
      machine('outside', 'Outside.local', 'owner', [
        {
          'grid': swarmGrid,
          'model': 'outside-model',
          'name': 'Outside Model',
          'kind': 'local',
        },
      ], buddyOnly: true),
    ];
    return server;
  }

  Future<SuperTabController> show(
    WidgetTester tester,
    ConversationServer server, {
    bool phone = false,
  }) async {
    final size = phone ? const Size(390, 844) : const Size(1280, 800);
    tester.view.devicePixelRatio = 1;
    tester.view.physicalSize = size;
    addTearDown(tester.view.reset);
    final c = server.controller(account: 'peer');
    await c.refresh();
    await c.select('swarm-buddy-peer');
    final view = Scaffold(
      body: SuperTabView(
        controller: c,
        onInvite: () {},
        onAddAgent: (_) {},
        onOpenTerminal: (_) {},
        machineName: (_) => 'Kens-MacBook',
      ),
    );
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.light),
        // A phone's browser lays the workspace out compact (web chrome).
        home: phone
            ? WorkspaceChromeScope(
                chrome: WorkspaceChrome(compactBelow: 720),
                child: view,
              )
            : view,
      ),
    );
    await tester.pumpAndSettle();
    return c;
  }

  Future<void> close(WidgetTester tester, SuperTabController c) async {
    await tester.pumpWidget(const SizedBox());
    await c.flush();
    c.dispose();
  }

  final picker = find.byKey(const ValueKey('super-buddy-model'));
  Finder inPicker(Finder f) => find.descendant(of: picker, matching: f);
  Finder row(String label) => find.widgetWithText(AppMenuItem, label);
  const rest =
      'Claude on Kens-MacBook · reads all your projects · only you can read this chat';
  const footer =
      'What your Buddy reads and writes goes to the machine or API that serves the model you pick.';

  Future<void> open(WidgetTester tester) async {
    await tester.tap(picker);
    await tester.pumpAndSettle();
  }

  group('the bar', () {
    testWidgets(
      'on the subscription, the picker comes first and the rest stays',
      (tester) async {
        final c = await show(tester, swarm());
        expect(inPicker(find.text('Your subscription')), findsOneWidget);
        expect(inPicker(find.byIcon(AppIcons.chevronDown)), findsOneWidget);
        expect(find.textContaining(' · $rest'), findsOneWidget);
        await close(tester, c);
      },
    );

    testWidgets('on a shared model, it names the model and who serves it', (
      tester,
    ) async {
      final c = await show(tester, swarm(gridModel: 'kimi-k3'));
      expect(inPicker(find.text('Kimi K3')), findsOneWidget);
      expect(
        find.textContaining(' · served by Studio, Tonys-Mac-mini · $rest'),
        findsOneWidget,
      );
      await close(tester, c);
    });

    testWidgets("on an API, it names the member's saved API", (tester) async {
      final c = await show(tester, swarm(gridModel: 'openai/gpt-6.1-sol'));
      expect(inPicker(find.text('GPT-6.1 Sol')), findsOneWidget);
      expect(
        find.textContaining(" · diego's saved API · $rest"),
        findsOneWidget,
      );
      await close(tester, c);
    });

    testWidgets('on a model nobody serves now, it says so', (tester) async {
      final c = await show(tester, swarm(gridModel: 'stale-model'));
      expect(inPicker(find.text('Stale Model')), findsOneWidget);
      expect(find.textContaining(' · not served now · $rest'), findsOneWidget);
      await close(tester, c);
    });

    testWidgets(
      'while a switch is under way, it says where to and opens nothing',
      (tester) async {
        final c = await show(
          tester,
          swarm(
            modelRequest: {
              'id': 'r1',
              'gridModel': 'deepseek-4.1-flash',
              'name': 'DeepSeek 4.1 Flash',
              'servedBy': ['Studio'],
              'requestedBy': 'peer',
              'at': DateTime.now().toUtc().toIso8601String(),
            },
          ),
        );
        expect(
          inPicker(find.text('Switching to DeepSeek 4.1 Flash…')),
          findsOneWidget,
        );
        expect(inPicker(find.byIcon(AppIcons.chevronDown)), findsNothing);
        await open(tester);
        expect(find.text('SHARED IN THIS SWARM'), findsNothing);
        expect(find.byType(AppMenuItem), findsNothing);
        await close(tester, c);
      },
    );

    testWidgets('switching home reads as the subscription', (tester) async {
      final c = await show(
        tester,
        swarm(
          gridModel: 'kimi-k3',
          modelRequest: {
            'id': 'r2',
            'gridModel': null,
            'requestedBy': 'peer',
            'at': DateTime.now().toUtc().toIso8601String(),
          },
        ),
      );
      expect(
        inPicker(find.text('Switching to your subscription…')),
        findsOneWidget,
      );
      await close(tester, c);
    });
  });

  group('the menu', () {
    testWidgets(
      'lists the subscription, then exactly the models the server accepts, each with who serves it',
      (tester) async {
        final c = await show(tester, swarm());
        await open(tester);
        expect(
          find.descendant(
            of: row('Your subscription'),
            matching: find.byIcon(AppIcons.check),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: row('Your subscription'),
            matching: find.text('Claude Code'),
          ),
          findsOneWidget,
        );
        expect(find.text('SHARED IN THIS SWARM'), findsOneWidget);
        expect(
          find.descendant(
            of: row('DeepSeek 4.1 Flash'),
            matching: find.text('served by Studio'),
          ),
          findsOneWidget,
        );
        // Served by two machines: the grid picks one per request.
        expect(
          find.descendant(
            of: row('Kimi K3'),
            matching: find.text('served by Studio, Tonys-Mac-mini'),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: row('GPT-6.1 Sol'),
            matching: find.text("diego's saved API"),
          ),
          findsOneWidget,
        );
        // The subscription and three models, nothing else.
        expect(find.byType(AppMenuItem), findsNWidgets(4));
        for (final absent in [
          'Muse',
          'Other Grid',
          'Qwen 3.6',
          'Stale Model',
          'Outside Model',
        ]) {
          expect(find.text(absent), findsNothing, reason: absent);
        }
        expect(find.text(footer), findsOneWidget);
        await close(tester, c);
      },
    );

    testWidgets(
      'picking a model sends it; picking the subscription it is on sends nothing',
      (tester) async {
        final server = swarm();
        final c = await show(tester, server);
        await open(tester);
        await tester.tap(row('Kimi K3'));
        await tester.pumpAndSettle();
        expect(commands(server, 'buddy.model'), [
          {'type': 'buddy.model', 'gridModel': 'kimi-k3'},
        ]);
        await open(tester);
        await tester.tap(row('Your subscription'));
        await tester.pumpAndSettle();
        expect(commands(server, 'buddy.model'), hasLength(1));
        await close(tester, c);
      },
    );

    testWidgets(
      'on a shared model, it is checked; the subscription sends null; the model again sends nothing',
      (tester) async {
        final server = swarm(gridModel: 'kimi-k3');
        final c = await show(tester, server);
        await open(tester);
        expect(
          find.descendant(
            of: row('Kimi K3'),
            matching: find.byIcon(AppIcons.check),
          ),
          findsOneWidget,
        );
        expect(
          find.descendant(
            of: row('Your subscription'),
            matching: find.byIcon(AppIcons.check),
          ),
          findsNothing,
        );
        await tester.tap(row('Kimi K3'));
        await tester.pumpAndSettle();
        expect(commands(server, 'buddy.model'), isEmpty);
        await open(tester);
        await tester.tap(row('Your subscription'));
        await tester.pumpAndSettle();
        expect(commands(server, 'buddy.model'), [
          {'type': 'buddy.model', 'gridModel': null},
        ]);
        await close(tester, c);
      },
    );

    testWidgets("a refused switch shows the server's reason", (tester) async {
      final server = swarm();
      server.refuse = {
        'code': 'BUDDY_MODEL_UNAVAILABLE',
        'message': 'Nobody in the Swarm serves that model now.',
      };
      final c = await show(tester, server);
      await open(tester);
      await tester.tap(row('DeepSeek 4.1 Flash'));
      await tester.pumpAndSettle();
      expect(
        find.text('Nobody in the Swarm serves that model now.'),
        findsOneWidget,
      );
      await close(tester, c);
    });

    testWidgets(
      "on a Buddy-only machine, it says to add the machine and lists no models",
      (tester) async {
        final c = await show(tester, swarm(buddyOnly: true));
        await open(tester);
        expect(
          find.text(
            "Add Kens-MacBook to the Swarm's Machines to use shared models.",
          ),
          findsOneWidget,
        );
        expect(find.text('DeepSeek 4.1 Flash'), findsNothing);
        expect(find.byType(AppMenuItem), findsOneWidget);
        await close(tester, c);
      },
    );

    testWidgets('with no model shared, it says nobody shares one yet', (
      tester,
    ) async {
      final c = await show(tester, swarm(localModels: false));
      await open(tester);
      expect(find.text('SHARED IN THIS SWARM'), findsOneWidget);
      expect(
        find.text('Nobody shares a model in this Swarm yet.'),
        findsOneWidget,
      );
      expect(find.byType(AppMenuItem), findsOneWidget);
      await close(tester, c);
    });

    testWidgets("a phone's rows are a finger's height", (tester) async {
      final c = await show(tester, swarm(), phone: true);
      await open(tester);
      final rows = find.byType(AppMenuItem);
      expect(rows, findsNWidgets(4));
      for (var i = 0; i < 4; i++) {
        expect(tester.getSize(rows.at(i)).height, greaterThanOrEqualTo(44));
      }
      await close(tester, c);
    });
  });

  group("the contributor's models", () {
    testWidgets('name the Buddies that run on each model', (tester) async {
      final server = swarm(gridModel: 'kimi-k3');
      final c = server.controller(account: 'owner');
      await c.refresh();
      await tester.pumpWidget(
        MaterialApp(
          theme: grid.buildAppTheme(brightness: Brightness.light),
          home: Scaffold(
            body: SuperTabMachineLocalModels(
              controller: c,
              machineId: 'studio',
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      expect(find.text('Kimi K3'), findsOneWidget);
      expect(find.text("Used by ken.tran's Buddy"), findsOneWidget);
      // One line, under the model the Buddy runs on alone.
      expect(
        tester.getTopLeft(find.text("Used by ken.tran's Buddy")).dy,
        greaterThan(tester.getTopLeft(find.text('Kimi K3')).dy),
      );
      expect(find.textContaining('Used by'), findsOneWidget);
      await close(tester, c);
    });
  });

  // Task #3256: a switch the Buddy guard holds (a Buddy started before its
  // owner was recorded) comes back as this line from the Buddy's machine
  // (cli superTabs/buddyModel.ts refusal(), backend buddyModel.ts). Until the
  // Buddy is started again, the bar offers that in one click.
  group('after a switch its Buddy must be started again for', () {
    const held =
        "Couldn't switch your Buddy: Start your Buddy again to switch its "
        'model. It is still on your subscription.';
    const offer = 'Start your Buddy again to switch its model.';
    final startAgain = find.widgetWithText(TextButton, 'Start again');

    /// The Buddy's machine's line in its chat, as the backend writes a
    /// switch's result: a system line by the Buddy agent [by].
    void line(ConversationServer server, String text, {String by = 'wren'}) {
      server.append(text, conversationId: 'swarm-buddy-peer');
      server.messages.last
        ..['author'] = {'kind': 'agent', 'id': by, 'name': 'Wren'}
        ..['source'] = {'kind': 'system'};
    }

    testWidgets('the bar offers Start again, which starts a fresh Buddy on '
        'the same machine and engine', (tester) async {
      final server = swarm();
      line(server, held);
      final c = await show(tester, server);
      expect(find.text(offer), findsOneWidget);
      // The picker stays: the line is what was learnt, not a lock.
      expect(picker, findsOneWidget);

      await tester.tap(startAgain);
      await tester.pumpAndSettle();
      // A running Buddy refuses a second start (backend BUDDY_EXISTS): it is
      // removed, then started, as a down one is replaced.
      expect(commands(server, 'buddy.remove').single, {'type': 'buddy.remove'});
      expect(commands(server, 'buddy.create').single, {
        'type': 'buddy.create',
        'machineId': 'ken-mac',
        'engine': 'claude',
      });
      expect(c.operationError, isNull);
      // The new Buddy did not write that line: the offer is gone.
      expect(c.buddy(SuperTabController.kSwarmBuddyKey)!.id, isNot('wren'));
      expect(find.text(offer), findsNothing);
      await close(tester, c);
    });

    testWidgets('it is not offered for another reason, once a later line '
        'settles it, while a switch is under way, or for an earlier Buddy', (
      tester,
    ) async {
      Future<void> none(ConversationServer server) async {
        final c = await show(tester, server);
        expect(find.text(offer), findsNothing);
        expect(startAgain, findsNothing);
        await close(tester, c);
      }

      await none(
        swarm()..append('Start your Buddy again', conversationId: 'lead'),
      );
      final other = swarm();
      line(
        other,
        "Couldn't switch your Buddy: Your Buddy is answering. Try again when "
        'it has finished. It is still on your subscription.',
      );
      await none(other);
      final later = swarm();
      line(later, held);
      line(
        later,
        "Peer's Buddy now runs on Kimi K3, which your machine serves.",
      );
      await none(later);
      final moving = swarm(
        modelRequest: {'id': 'req2', 'gridModel': 'kimi-k3', 'name': 'Kimi K3'},
      );
      line(moving, held);
      await none(moving);
      final earlier = swarm();
      line(earlier, held, by: 'old-wren');
      await none(earlier);
    });

    // Review of #3171 (Guide): the messages held can be an older page, read
    // back to the reader's mark, with the result that settled the switch
    // among the newer ones not read yet.
    testWidgets('it is not offered while the chat holds an older page than '
        'its newest message', (tester) async {
      final server = swarm();
      line(server, held);
      // Newer messages are in the chat that this window has not read.
      final chat = (server.state['conversations'] as List)
          .cast<Map<String, dynamic>>()
          .firstWhere((g) => g['id'] == 'swarm-buddy-peer');
      chat['lastMessageSequence'] = (chat['lastMessageSequence'] as int) + 5;
      chat['lastMainSequence'] = chat['lastMessageSequence'];
      final c = await show(tester, server);
      expect(find.text(offer), findsNothing);
      await close(tester, c);
    });

    // Review of #3171: a Buddy is removed before it starts again, so nothing
    // that would refuse the start may be known when it is removed.
    testWidgets('while new work is paused, Start again removes nothing', (
      tester,
    ) async {
      final server = swarm();
      server.state['paused'] = true;
      line(server, held);
      final c = await show(tester, server);
      // Words say why, not the disabled button alone (UI checklist).
      expect(
        find.text(
          'New work is paused. Start your Buddy again once it resumes.',
        ),
        findsOneWidget,
      );
      expect(tester.widget<TextButton>(startAgain).onPressed, isNull);
      expect(commands(server, 'buddy.remove'), isEmpty);
      await close(tester, c);
    });

    // Review of #3171: a start refused once its Buddy is removed leaves the
    // Start bar on the machine and engine it ran on, one click from them.
    testWidgets('a start refused after the removal keeps its machine and '
        'engine in the Start bar', (tester) async {
      final server = swarm();
      final wren = (server.state['agents'] as List).cast<Map>().firstWhere(
        (a) => a['id'] == 'wren',
      );
      wren['configuration'] = {'engine': 'codex', 'model': 'default'};
      line(server, held);
      server.unknownCommand = (command) => command['type'] == 'buddy.create';
      final c = await show(tester, server);
      await tester.tap(startAgain);
      await tester.pumpAndSettle();
      expect(commands(server, 'buddy.remove'), hasLength(1));
      expect(c.buddy(SuperTabController.kSwarmBuddyKey), isNull);
      final engine = find.byKey(const ValueKey('super-buddy-start-engine'));
      expect(
        find.descendant(of: engine, matching: find.text('Codex')),
        findsOneWidget,
      );

      server.unknownCommand = null;
      await tester.tap(find.widgetWithText(FilledButton, 'Start'));
      await tester.pumpAndSettle();
      expect(commands(server, 'buddy.create').last, {
        'type': 'buddy.create',
        'machineId': 'ken-mac',
        'engine': 'codex',
      });
      await close(tester, c);
    });
  });
}
