import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
import 'package:harness/super_tabs/model.dart';
import 'package:harness/super_tabs/view.dart';

import 'support/super_tab_fixture.dart';
import 'support/capture.dart';
import 'swarm_state_test.dart' show createApp;

class ReceiptFixture {
  ReceiptFixture(this.tester, {this.status = 'claimed'});
  final WidgetTester tester;
  final String? status;
  final server = ConversationServer();
  // The receipt reads the package clock, which a test moves; real time would drift from it.
  final now = clock.now();
  late final SuperTabController controller;
  String? opened;
  bool addedLead = false;
  Map<String, dynamic> get message => server.messages.last;
  Map<String, dynamic> get delivery =>
      (message['deliveries'] as List).single as Map<String, dynamic>;

  Future<void> show({
    AppNotifier? app,
    void Function()? prepare,
    Brightness brightness = Brightness.light,
  }) async {
    server.state['agents'] = [
      {
        'id': 'lead-agent',
        'name': 'Lead',
        'machineId': 'm',
        'harnessId': 'a0',
        'contributorId': 'owner',
        'configuration': {'engine': 'codex'},
      },
    ];
    final group = (server.state['conversations'] as List).first as Map;
    group['leadId'] = 'lead-agent';
    group['agentIds'] = ['lead-agent'];
    server.state['machines'] = [
      {
        'machineId': 'm',
        'name': 'Team Mac',
        'observation': {'receivedAt': now.millisecondsSinceEpoch},
      },
    ];
    server.append('Please start.');
    message['createdAt'] = now
        .subtract(const Duration(minutes: 2))
        .toIso8601String();
    if (status != null) {
      message['deliveries'] = [
        {
          'id': 'delivery',
          'agentId': 'lead-agent',
          'status': status,
          'deliveredAt': now
              .subtract(const Duration(seconds: 42))
              .toIso8601String(),
        },
      ];
    }
    prepare?.call();
    controller = server.controller();
    await controller.refresh();
    await tester.binding.setSurfaceSize(const Size(1000, 720));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    await tester.pumpWidget(
      MaterialApp(
        debugShowCheckedModeBanner: false,
        theme: grid.buildAppTheme(brightness: brightness),
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            app: app,
            onAddAgent: (_) => addedLead = true,
            onOpenTerminal: (agent) => opened = agent.id,
            machineName: (_) => 'Team Mac',
          ),
        ),
      ),
    );
    await tester.pump(const Duration(milliseconds: 100));
  }

  /// Nothing under the newest own message: no Sent, Delivered, Replied or
  /// working line, and the line takes no room (Slack's rows, Dee 10-29).
  void expectQuiet() {
    for (final text in ['Sent', 'Sending…', 'Not sent']) {
      expect(find.text(text), findsNothing);
    }
    for (final text in ['Delivered', 'Replied', 'is working', 'offline']) {
      expect(find.textContaining(text), findsNothing);
    }
    final line = find.byKey(ValueKey('super-message-receipt-${message['id']}'));
    expect(tester.getSize(line).height, 0);
  }

  /// The quiet line under the newest own message: [text] alone, in grey, with
  /// no mark beside it (Swarm plan, step 1, item 2).
  void expectState(String text) {
    expect(find.text(text), findsOneWidget);
    final line = find.byKey(ValueKey('super-message-receipt-${message['id']}'));
    expect(
      find.descendant(of: line, matching: find.byType(Icon)),
      findsNothing,
    );
    for (final other in ['Sent', 'Typed', 'Not typed yet', 'Not sent']) {
      if (other != text) expect(find.text(other), findsNothing);
    }
  }

  Future<void> close() async {
    expect(find.text('Queued'), findsNothing);
    expect(find.textContaining('Check delivery'), findsNothing);
    expect(tester.takeException(), isNull);
    final own = controller
        .messages('lead')
        .where((m) => !m.fromAgent && m.authorId == 'owner')
        .lastOrNull;
    final receipt = own?.receiptDelivery;
    await captureWindow(
      tester,
      Platform.environment['HARNESS_SUPER_TAB_CAPTURE'],
      'receipt-${receipt?.status ?? 'no-lead'}-${receipt?.holdReason ?? 'plain'}',
    );
    await tester.pumpWidget(const SizedBox());
    await controller.flush();
    controller.dispose();
  }
}

void main() {
  setUpAll(
    () => loadCaptureFonts(Platform.environment['HARNESS_SUPER_TAB_CAPTURE']),
  );
  for (final status in ['queued', 'claimed']) {
    testWidgets(
      'receipt: fresh $status reads Sending, then Sent once it is older',
      (tester) async {
        final f = ReceiptFixture(tester, status: status);
        await f.show(
          prepare: () =>
              f.message['createdAt'] = DateTime.now().toIso8601String(),
        );
        expect(find.text('Sending…'), findsOneWidget);
        // The message ages on screen: no read of it again, which a state
        // with the same counters no longer makes (spec 2026-11-02-poll-cost).
        await tester.pump(const Duration(seconds: 8));
        f.expectState('Sent');
        await f.close();
      },
    );
  }

  for (final status in ['delivered', 'confirmed']) {
    testWidgets('receipt: $status reads Typed under the message', (
      tester,
    ) async {
      final f = ReceiptFixture(tester, status: status);
      await f.show();
      f.expectState('Typed');
      await f.close();
    });
  }

  testWidgets(
    'receipt: answered shows nothing: its answer is the third state',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'answered');
      await f.show(
        prepare: () => f.delivery['answeredAt'] = f.now.toIso8601String(),
      );
      f.expectQuiet();
      await f.close();
    },
  );

  testWidgets(
    'receipt: a delivered message reads Typed while its Lead works and after',
    (tester) async {
      final app = createApp(connected: true);
      addTearDown(app.dispose);
      final f = ReceiptFixture(tester, status: 'delivered');
      await f.show(app: app);
      await app.handleEventForTest('m', {
        'type': 'turn_started',
        'agentId': 'a0',
      });
      await tester.pump();
      f.expectState('Typed');
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
      });
      await tester.pump(const Duration(milliseconds: 100));
      f.expectState('Typed');
      await f.close();
    },
  );

  // Not typed in 2 minutes says why (Swarm plan, step 1, item 2), from what
  // holds it in its terminal (cli core/input.ts), and offers the terminal when
  // its person can see to it there.
  const harnessKeepsTrying =
      "Lead can't take messages right now. Harness keeps trying, and it goes in as soon as it can.";
  for (final (reason, why, inTerminal) in [
    (
      'team_waiting_idle',
      'Lead is working. Your message goes in when this turn ends.',
      false,
    ),
    (
      'team_waiting_busy',
      'Lead is working. Your message goes in when this turn ends.',
      false,
    ),
    (
      'team_waiting_user',
      'Lead is waiting on your answer in its terminal.',
      true,
    ),
    ('team_waiting_draft', "Lead's terminal has unsent text.", true),
    ('team_waiting_dialog', "Lead's terminal has a menu open.", true),
    ('team_waiting_control', harnessKeepsTrying, false),
    ('team_waiting_unavailable', harnessKeepsTrying, false),
    (null, harnessKeepsTrying, false),
  ]) {
    testWidgets(
      'receipt: held by ${reason ?? 'nothing named'} reads Sent, and two minutes on says why',
      (tester) async {
        final f = ReceiptFixture(tester);
        await f.show(
          prepare: () {
            f.message['createdAt'] = clock
                .now()
                .subtract(const Duration(minutes: 1, seconds: 30))
                .toIso8601String();
            if (reason != null) {
              f.delivery['holdReason'] = reason;
              f.delivery['holdSince'] = f.now
                  .subtract(const Duration(seconds: 34))
                  .toIso8601String();
            }
          },
        );
        f.expectState('Sent');
        expect(find.text(why), findsNothing);
        // By the receipt's own clock: no snapshot comes to rebuild it.
        await tester.pump(const Duration(seconds: 31));
        expect(find.text('Not typed yet'), findsOneWidget);
        expect(find.text('Sent'), findsNothing);
        expect(find.text(why), findsOneWidget);
        expect(
          find.text('Open terminal'),
          inTerminal ? findsOneWidget : findsNothing,
        );
        if (inTerminal) {
          await tester.tap(find.text('Open terminal'));
          await tester.pump();
          expect(f.opened, 'lead-agent');
          expect(f.server.posts, isEmpty);
        }
        await f.close();
      },
    );
  }

  testWidgets(
    'receipt: offline recipient uses its machine reading and last-seen name',
    (tester) async {
      final f = ReceiptFixture(tester);
      await f.show(
        prepare: () {
          (f.server.state['machines'] as List)
              .first['observation']['receivedAt'] = f.now
              .subtract(const Duration(minutes: 3))
              .millisecondsSinceEpoch;
        },
      );
      expect(find.text("Lead's computer is offline"), findsOneWidget);
      expect(
        find.text(
          "Team Mac was last seen 3 min ago. Your message goes in when it's back online.",
        ),
        findsOneWidget,
      );
      await f.close();
    },
  );

  for (final direct in [true, false]) {
    testWidgets(
      'receipt: a held message to a computer with no Swarm reading ${direct ? 'connected directly says why it is not typed' : 'read through the Swarm says offline'}',
      (tester) async {
        final app = createApp(connected: true);
        addTearDown(app.dispose);
        app.stateOf('m')!.localOnly = direct;
        final f = ReceiptFixture(tester);
        await f.show(
          app: app,
          prepare: () {
            final machines = f.server.state['machines'] as List;
            direct ? machines.clear() : machines.first.remove('observation');
            f.delivery['holdReason'] = 'team_waiting_idle';
          },
        );
        expect(find.textContaining('busy'), findsNothing);
        if (direct) {
          expect(find.text('Not typed yet'), findsOneWidget);
          expect(
            find.text(
              'Lead is working. Your message goes in when this turn ends.',
            ),
            findsOneWidget,
          );
        } else {
          expect(find.text("Lead's computer is offline"), findsOneWidget);
        }
        await f.close();
      },
    );
  }

  for (final (label, resolution) in [
    ('Open terminal', null),
    ('Send again', 'resend'),
    ('It arrived', 'received'),
  ]) {
    testWidgets(
      'receipt: uncertainty keeps the warning and $label uses the existing action',
      (tester) async {
        final f = ReceiptFixture(tester, status: 'uncertain');
        await f.show();
        expect(find.text("Couldn't confirm delivery"), findsOneWidget);
        expect(
          find.text(
            "Lead's computer may have typed this into the terminal without confirming. Check the terminal before sending again, or it could run twice.",
          ),
          findsOneWidget,
        );
        for (final action in ['Open terminal', 'Send again', 'It arrived']) {
          expect(find.text(action), findsOneWidget);
        }
        await tester.tap(find.text(label));
        await tester.pump();
        if (resolution == null) {
          expect(f.opened, 'lead-agent');
          expect(f.server.posts, isEmpty);
        } else {
          expect(f.server.posts.single['command'], {
            'type': 'delivery.resolve',
            'deliveryId': 'delivery',
            'resolution': resolution,
          });
        }
        await f.close();
      },
    );
  }

  // A project's channel: its PM is chosen from its owner's agents, never started (anh Dee, 2026-11-11).
  testWidgets(
    'receipt: no Lead in a project\'s channel is not sent and offers Choose PM',
    (tester) async {
      final f = ReceiptFixture(tester, status: null);
      await f.show(
        prepare: () =>
            (f.server.state['conversations'] as List).first['leadId'] = null,
      );
      expect(find.text('Not sent · this chat has no Lead'), findsOneWidget);
      expect(find.text('Add a Lead'), findsNothing);
      await tester.tap(find.text('Choose PM'));
      await tester.pumpAndSettle();
      // Choose PM's dialog, and no new agent's form.
      expect(find.byKey(const ValueKey('choose-pm-confirm')), findsOneWidget);
      expect(f.addedLead, isFalse);
      await tester.tap(find.text('Cancel'));
      await tester.pumpAndSettle();
      await f.close();
    },
  );

  testWidgets('receipt: no Lead and no start, with an app, is still not sent', (
    tester,
  ) async {
    final app = createApp(connected: true);
    addTearDown(app.dispose);
    final f = ReceiptFixture(tester, status: null);
    await f.show(
      app: app,
      prepare: () =>
          (f.server.state['conversations'] as List).first['leadId'] = null,
    );
    expect(find.text('Not sent · this chat has no Lead'), findsOneWidget);
    expect(find.text('Choose PM'), findsOneWidget);
    await f.close();
  });

  testWidgets(
    'receipt: only latest own message carries a receipt, even after another person speaks',
    (tester) async {
      final f = ReceiptFixture(tester);
      await f.show(
        prepare: () {
          f.server.append('Someone else speaks.');
          f.message['author'] = {
            'kind': 'person',
            'id': 'peer',
            'name': 'Peer',
          };
          f.message['deliveries'] = [
            {
              'id': 'peer-delivery',
              'agentId': 'lead-agent',
              'status': 'uncertain',
            },
          ];
        },
      );
      expect(find.text("Couldn't confirm delivery"), findsNothing);
      f.server.append('My next question.');
      f.message['deliveries'] = [
        {'id': 'new-delivery', 'agentId': 'lead-agent', 'status': 'uncertain'},
      ];
      await f.controller.refresh();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text("Couldn't confirm delivery"), findsOneWidget);
      await f.close();
    },
  );

  // Not typed yet, for a queued copy: prod 10-30 (v1.3.71), claims failed for
  // two hours while every queued message looked delivered.
  const couldntTake =
      "Team Mac is online but couldn't take this message yet. Harness keeps trying, and it goes in as soon as it can.";
  const notPickedUp =
      "Team Mac is online but hasn't picked this message up yet. Harness keeps trying, and it goes in as soon as it can.";
  const notRunning =
      "Lead isn't running. Your message goes in when it runs again.";

  testWidgets(
    'receipt: a queued message whose claims fail for a minute reads Not typed yet',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () => f.delivery['claimFailingSince'] = f.now
            .subtract(const Duration(seconds: 61))
            .toIso8601String(),
      );
      expect(find.text('Not typed yet'), findsOneWidget);
      expect(find.text(couldntTake), findsOneWidget);
      expect(find.text('Send again'), findsNothing);
      await f.close();
    },
  );

  testWidgets(
    'receipt: a queued message no computer picked up for 2 minutes reads Not typed yet',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () => f.message['createdAt'] = f.now
            .subtract(const Duration(minutes: 2, seconds: 1))
            .toIso8601String(),
      );
      expect(find.text('Not typed yet'), findsOneWidget);
      expect(find.text(notPickedUp), findsOneWidget);
      await f.close();
    },
  );

  testWidgets('receipt: offline still wins over Not typed yet', (tester) async {
    final f = ReceiptFixture(tester, status: 'queued');
    await f.show(
      prepare: () {
        f.delivery['claimFailingSince'] = f.now
            .subtract(const Duration(minutes: 5))
            .toIso8601String();
        (f.server.state['machines'] as List)
            .first['observation']['receivedAt'] = f.now
            .subtract(const Duration(minutes: 3))
            .millisecondsSinceEpoch;
      },
    );
    expect(find.text("Lead's computer is offline"), findsOneWidget);
    expect(find.text('Not typed yet'), findsNothing);
    await f.close();
  });

  testWidgets(
    'receipt: a stopped recipient queued for minutes says it is not running',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () {
          (f.server.state['agents'] as List).first['downSince'] = f.now
              .subtract(const Duration(minutes: 10))
              .toIso8601String();
          f.message['createdAt'] = f.now
              .subtract(const Duration(minutes: 3))
              .toIso8601String();
        },
      );
      expect(find.text('Not typed yet'), findsOneWidget);
      expect(find.text(notRunning), findsOneWidget);
      expect(find.text(notPickedUp), findsNothing);
      await f.close();
    },
  );

  testWidgets(
    'receipt: a stopped recipient with failing claims says it is not running, not why its computer failed',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () {
          (f.server.state['agents'] as List).first['downSince'] = f.now
              .subtract(const Duration(minutes: 10))
              .toIso8601String();
          f.delivery['claimFailingSince'] = f.now
              .subtract(const Duration(minutes: 5))
              .toIso8601String();
        },
      );
      expect(find.text('Not typed yet'), findsOneWidget);
      expect(find.text(notRunning), findsOneWidget);
      expect(find.text(couldntTake), findsNothing);
      await f.close();
    },
  );

  testWidgets(
    'receipt: a delivery to an agent not in the Swarm reads Sent and does not throw',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () {
          f.delivery['agentId'] = 'ghost-agent';
          f.message['createdAt'] = f.now
              .subtract(const Duration(minutes: 3))
              .toIso8601String();
        },
      );
      expect(find.text('Not typed yet'), findsNothing);
      f.expectState('Sent');
      await f.close();
    },
  );

  testWidgets(
    'receipt: a message queued for minutes keeps its line when the first claim failure arrives',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () {
          f.message['createdAt'] = f.now
              .subtract(const Duration(minutes: 5))
              .toIso8601String();
          f.delivery['claimFailingSince'] = f.now
              .subtract(const Duration(seconds: 10))
              .toIso8601String();
        },
      );
      expect(find.text('Not typed yet'), findsOneWidget);
      expect(find.text(couldntTake), findsOneWidget);
      await f.close();
    },
  );

  testWidgets(
    'receipt: a claimed message\'s leftover claim fields change nothing: it reads Sent',
    (tester) async {
      final f = ReceiptFixture(tester);
      await f.show(
        prepare: () {
          f.message['createdAt'] = f.now
              .subtract(const Duration(minutes: 1))
              .toIso8601String();
          f.delivery['claimFailingSince'] = f.now
              .subtract(const Duration(minutes: 5))
              .toIso8601String();
        },
      );
      f.expectState('Sent');
      expect(find.text(couldntTake), findsNothing);
      await f.close();
    },
  );

  testWidgets(
    'receipt: below both thresholds it reads Sent, and Not typed yet comes by the receipt\'s own clock',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () => f.message['createdAt'] = clock
            .now()
            .subtract(const Duration(minutes: 1, seconds: 58))
            .toIso8601String(),
      );
      f.expectState('Sent');
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('Not typed yet'), findsOneWidget);
      await f.close();
    },
  );

  // A message tagging several agents: one agent's cancelled copy said Not sent
  // under it though the Lead's copy arrived, and people sent it again (10-30).
  // Not sent shows only when no recipient got it; one still waiting keeps its
  // own line, so the receipt never promises arrival while another waits.
  group('receipt: several recipients', () {
    Map<String, dynamic> row(String agentId, String status) => {
      'id': 'delivery-$agentId',
      'agentId': agentId,
      'status': status,
    };
    String? receipt(List<Map<String, dynamic>> deliveries) =>
        SuperTabMessage.fromJson({
          'id': 'm1',
          'conversationId': 'lead',
          'text': '@Lead @Builder please start',
          'sequence': 1,
          'author': {'kind': 'person', 'id': 'owner', 'name': 'Owner'},
          'deliveries': deliveries,
        }).receiptDelivery?.status;

    test('one copy cancelled while another arrived is not the receipt', () {
      for (final arrived in ['delivered', 'confirmed', 'answered']) {
        final rows = [row('lead-agent', arrived), row('builder', 'cancelled')];
        expect(receipt(rows), arrived);
        expect(receipt(rows.reversed.toList()), arrived);
      }
      expect(receipt([row('builder', 'cancelled')]), 'cancelled');
      expect(
        receipt([row('lead-agent', 'queued'), row('builder', 'cancelled')]),
        'queued',
      );
      expect(
        receipt([row('builder', 'cancelled'), row('lead-agent', 'claimed')]),
        'claimed',
      );
      expect(
        receipt([row('lead-agent', 'answered'), row('builder', 'uncertain')]),
        'uncertain',
      );
    });

    testWidgets(
      'the Lead got it and the Builder\'s copy was cancelled: Typed, no Not sent',
      (tester) async {
        final f = ReceiptFixture(tester, status: null);
        await f.show(
          prepare: () => f.message['deliveries'] = [
            row('builder', 'cancelled'),
            row('lead-agent', 'delivered'),
          ],
        );
        f.expectState('Typed');
        await f.close();
      },
    );

    testWidgets('every copy cancelled still reads Not sent', (tester) async {
      final f = ReceiptFixture(tester, status: null);
      await f.show(
        prepare: () => f.message['deliveries'] = [row('builder', 'cancelled')],
      );
      expect(find.text('Not sent'), findsOneWidget);
      await f.close();
    });

    testWidgets('the Lead\'s copy still waiting keeps its line, not Not sent', (
      tester,
    ) async {
      final f = ReceiptFixture(tester, status: null);
      await f.show(
        prepare: () => f.message['deliveries'] = [
          row('builder', 'cancelled'),
          row('lead-agent', 'queued'),
        ],
      );
      expect(find.text('Not sent'), findsNothing);
      expect(find.text('Not typed yet'), findsOneWidget);
      await f.close();
    });
  });
}
