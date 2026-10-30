import 'dart:io';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/shared/theme/app_theme.dart' as grid;
import 'package:harness/state/app_state.dart';
import 'package:harness/super_tabs/controller.dart';
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

  Future<void> show({AppNotifier? app, void Function()? prepare}) async {
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
        theme: grid.buildAppTheme(brightness: Brightness.light),
        home: Scaffold(
          body: SuperTabView(
            controller: controller,
            app: app,
            onInvite: () {},
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
      'receipt: fresh $status reads Sending then an older message shows nothing',
      (tester) async {
        final f = ReceiptFixture(tester, status: status);
        await f.show(
          prepare: () =>
              f.message['createdAt'] = DateTime.now().toIso8601String(),
        );
        expect(find.text('Sending…'), findsOneWidget);
        f.message['createdAt'] = f.now
            .subtract(const Duration(seconds: 8))
            .toIso8601String();
        await f.controller.refresh();
        await tester.pump();
        f.expectQuiet();
        await f.close();
      },
    );
  }

  for (final status in ['delivered', 'confirmed', 'answered']) {
    testWidgets('receipt: $status shows nothing under the message', (
      tester,
    ) async {
      final f = ReceiptFixture(tester, status: status);
      await f.show(
        prepare: () => f.delivery['answeredAt'] = f.now.toIso8601String(),
      );
      f.expectQuiet();
      await f.close();
    });
  }

  testWidgets(
    'receipt: a delivered message stays quiet while its Lead works and after',
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
      f.expectQuiet();
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
      });
      await tester.pump(const Duration(milliseconds: 100));
      f.expectQuiet();
      await f.close();
    },
  );

  for (final (reason, label) in [
    ('team_waiting_idle', 'Lead is busy'),
    ('team_waiting_user', "someone is typing in Lead's terminal"),
    ('team_waiting_draft', "Lead's terminal has unsent text"),
    ('team_waiting_control', "Lead can't take messages right now"),
    ('team_waiting_unavailable', "Lead can't take messages right now"),
  ]) {
    testWidgets('receipt: $reason held message shows nothing', (tester) async {
      final f = ReceiptFixture(tester);
      await f.show(
        prepare: () {
          f.delivery['holdReason'] = reason;
          f.delivery['holdSince'] = f.now
              .subtract(const Duration(seconds: 34))
              .toIso8601String();
        },
      );
      f.expectQuiet();
      expect(find.textContaining(label), findsNothing);
      expect(find.textContaining('waiting'), findsNothing);
      expect(find.textContaining('by itself'), findsNothing);
      await f.close();
    });
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
      'receipt: a held message to a computer with no Swarm reading ${direct ? 'connected directly shows nothing' : 'read through the Swarm says offline'}',
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
          f.expectQuiet();
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

  testWidgets('receipt: no Lead is not sent and offers Add a Lead', (
    tester,
  ) async {
    final f = ReceiptFixture(tester, status: null);
    await f.show(
      prepare: () =>
          (f.server.state['conversations'] as List).first['leadId'] = null,
    );
    expect(find.text('Not sent · this chat has no Lead'), findsOneWidget);
    await tester.tap(find.text('Add a Lead'));
    expect(f.addedLead, isTrue);
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

  testWidgets(
    'receipt: stored hold notices stay hidden while other agent messages stay',
    (tester) async {
      final f = ReceiptFixture(tester);
      await f.show(
        prepare: () {
          f.delivery['holdReason'] = 'team_waiting_idle';
          f.delivery['holdSince'] = f.now.toIso8601String();
          final original = f.message['id'];
          f.server.append('A message for Lead is waiting. It stays queued.');
          f.message['author'] = {
            'kind': 'agent',
            'id': 'lead-agent',
            'name': 'Lead',
          };
          f.message['source'] = {
            'kind': 'delivery-hold',
            'messageId': original,
            'deliveryId': 'delivery',
            'agentId': 'lead-agent',
          };
          f.server.append('A real update.');
          f.message['author'] = {
            'kind': 'agent',
            'id': 'lead-agent',
            'name': 'Lead',
          };
          // A newer own message: the old notice is no longer about the latest one.
          f.server.append('My next question.');
        },
      );
      expect(
        find.textContaining('A message for Lead is waiting.'),
        findsNothing,
      );
      expect(find.text('A real update.'), findsOneWidget);
      expect(find.textContaining('Lead is busy'), findsNothing);
      await f.close();
    },
  );

  // Not delivered yet: prod 10-30 (v1.3.71), claims failed for two hours while
  // every queued message looked delivered.
  const couldntTake =
      "Team Mac is online but couldn't take this message yet. Harness keeps trying, and it goes in as soon as it can.";
  const notPickedUp =
      "Team Mac is online but hasn't picked this message up yet. Harness keeps trying, and it goes in as soon as it can.";

  testWidgets(
    'receipt: a queued message whose claims fail for a minute reads Not delivered yet',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () => f.delivery['claimFailingSince'] = f.now
            .subtract(const Duration(seconds: 61))
            .toIso8601String(),
      );
      expect(find.text('Not delivered yet'), findsOneWidget);
      expect(find.text(couldntTake), findsOneWidget);
      expect(find.text('Send again'), findsNothing);
      await f.close();
    },
  );

  testWidgets(
    'receipt: a queued message no computer picked up for 2 minutes reads Not delivered yet',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () => f.message['createdAt'] = f.now
            .subtract(const Duration(minutes: 2, seconds: 1))
            .toIso8601String(),
      );
      expect(find.text('Not delivered yet'), findsOneWidget);
      expect(find.text(notPickedUp), findsOneWidget);
      await f.close();
    },
  );

  testWidgets('receipt: offline still wins over Not delivered yet', (
    tester,
  ) async {
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
    expect(find.text('Not delivered yet'), findsNothing);
    await f.close();
  });

  testWidgets(
    'receipt: a stopped recipient that has been queued for minutes shows neither case',
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
      expect(find.text('Not delivered yet'), findsNothing);
      await f.close();
    },
  );

  testWidgets(
    'receipt: a stopped recipient with failing claims shows no Not delivered yet',
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
      expect(find.text('Not delivered yet'), findsNothing);
      await f.close();
    },
  );

  testWidgets(
    'receipt: a delivery to an agent not in the Swarm shows nothing and does not throw',
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
      expect(find.text('Not delivered yet'), findsNothing);
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
      expect(find.text('Not delivered yet'), findsOneWidget);
      expect(find.text(couldntTake), findsOneWidget);
      await f.close();
    },
  );

  testWidgets(
    'receipt: a claimed message with leftover claim fields stays quiet',
    (tester) async {
      final f = ReceiptFixture(tester);
      await f.show(
        prepare: () => f.delivery['claimFailingSince'] = f.now
            .subtract(const Duration(minutes: 5))
            .toIso8601String(),
      );
      f.expectQuiet();
      expect(find.text('Not delivered yet'), findsNothing);
      await f.close();
    },
  );

  testWidgets(
    'receipt: below both thresholds nothing shows, and the line comes by the receipt\'s own clock',
    (tester) async {
      final f = ReceiptFixture(tester, status: 'queued');
      await f.show(
        prepare: () => f.message['createdAt'] = clock
            .now()
            .subtract(const Duration(minutes: 1, seconds: 58))
            .toIso8601String(),
      );
      expect(find.text('Not delivered yet'), findsNothing);
      await tester.pump(const Duration(seconds: 3));
      expect(find.text('Not delivered yet'), findsOneWidget);
      await f.close();
    },
  );
}
