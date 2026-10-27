import 'dart:io';

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
  final now = DateTime.now();
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
      'receipt: fresh $status reads Sending then an older message reads Sent',
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
        expect(find.text('Sent'), findsOneWidget);
        expect(find.text('Sending…'), findsNothing);
        await f.close();
      },
    );
  }

  for (final status in ['delivered', 'confirmed']) {
    testWidgets(
      'receipt: $status uses the recorded delivery time without inventing remote activity',
      (tester) async {
        final f = ReceiptFixture(tester, status: status);
        await f.show();
        final at = DateTime.parse(f.delivery['deliveredAt'] as String)
            .toLocal();
        expect(
          find.text(
            'Delivered ${at.hour.toString().padLeft(2, '0')}:${at.minute.toString().padLeft(2, '0')}',
          ),
          findsOneWidget,
        );
        expect(find.textContaining('is working'), findsNothing);
        await f.close();
      },
    );
  }

  testWidgets(
    'receipt: known working activity appears and clears without a new message',
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
      expect(find.text('Lead is working'), findsOneWidget);
      expect(find.textContaining(RegExp(r'^0:4[2-5]$')), findsOneWidget);
      await app.handleEventForTest('m', {
        'type': 'turn_ended',
        'agentId': 'a0',
      });
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Lead is working'), findsNothing);
      expect(find.textContaining('Delivered '), findsOneWidget);
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
    testWidgets('receipt: $reason held message reads only Sent', (
      tester,
    ) async {
      final f = ReceiptFixture(tester);
      await f.show(
        prepare: () {
          f.delivery['holdReason'] = reason;
          f.delivery['holdSince'] = f.now
              .subtract(const Duration(seconds: 34))
              .toIso8601String();
        },
      );
      expect(find.text('Sent'), findsOneWidget);
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

  for (final (direct, shown) in [
    (true, 'Sent'),
    (false, "Lead's computer is offline"),
  ]) {
    testWidgets(
      'receipt: a held message to a computer with no Swarm reading ${direct ? 'connected directly reads Sent' : 'read through the Swarm says offline'}',
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
        expect(find.textContaining(shown), findsOneWidget);
        expect(find.textContaining('busy'), findsNothing);
        expect(
          find.textContaining('offline'),
          direct ? findsNothing : findsWidgets,
        );
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

  testWidgets('receipt: answered shows its fixed delivery-to-answer duration', (
    tester,
  ) async {
    final f = ReceiptFixture(tester, status: 'answered');
    await f.show(
      prepare: () {
        f.delivery['answeredAt'] = f.now.toIso8601String();
        f.delivery['deliveredAt'] = f.now
            .subtract(const Duration(seconds: 72))
            .toIso8601String();
      },
    );
    expect(find.text('Replied · 1m 12s'), findsOneWidget);
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
      expect(find.text('Sent'), findsOneWidget);
      expect(find.text("Couldn't confirm delivery"), findsNothing);
      f.server.append('My next question.');
      f.message['deliveries'] = [
        {'id': 'new-delivery', 'agentId': 'lead-agent', 'status': 'delivered'},
      ];
      await f.controller.refresh();
      await tester.pump(const Duration(milliseconds: 100));
      expect(find.text('Sent'), findsNothing);
      expect(find.text('Delivered'), findsOneWidget);
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
}
