import 'dart:async';

import 'package:clock/clock.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/swarm/swarm_conversation.dart';
import 'package:harness_mobile/swarm/swarm_message_receipt.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// The line under the person's newest message while its delivery is queued and
/// not getting in (Desktop's #2336), and the one read that keeps it honest: the
/// chat's own reads never see a delivery change.
void main() {
  const messages = '/api/super-tabs/$tab/conversations/g1/messages';
  const exact = '$messages?messageId=';
  const couldntTake =
      "Team Mac is online but couldn't take this message yet. Harness keeps trying, and it goes in as soon as it can.";
  const notPickedUp =
      "Team Mac is online but hasn't picked this message up yet. Harness keeps trying, and it goes in as soon as it can.";

  Map<String, dynamic> delivery({
    String status = 'queued',
    String agentId = 'agent-lead',
    DateTime? failingSince,
  }) => {
    'id': 'd1',
    'agentId': agentId,
    'status': status,
    'claimFailingSince': ?failingSince?.toUtc().toIso8601String(),
  };

  Map<String, dynamic> own(
    String id,
    int sequence, {
    required DateTime at,
    List<Map<String, dynamic>> deliveries = const [],
    String conversationId = 'g1',
  }) => {
    'id': id,
    'conversationId': conversationId,
    'text': 'Please start',
    'sequence': sequence,
    'author': {'kind': 'person', 'id': me, 'name': 'tony'},
    'deliveries': deliveries,
    'createdAt': at.toUtc().toIso8601String(),
  };

  Map<String, dynamic> machine(
    String id, {
    String name = 'Team Mac',
    DateTime? readAt,
  }) => {
    'machineId': id,
    'name': name,
    'contributorId': me,
    if (readAt != null)
      'observation': {'receivedAt': readAt.millisecondsSinceEpoch},
  };

  /// A Swarm where chat g1 holds [page], the Lead on [machines]; every read of
  /// one message answers [answer], [page] until it is set.
  ({FakeSwarm swarm, SwarmReader reader}) rig({
    required List<Map<String, dynamic>> page,
    List<Map<String, dynamic>>? machines,
    List<Map<String, dynamic>>? agents,
    FutureOr<Object?> Function(Map<String, dynamic>? body)? answer,
  }) {
    final swarm = FakeSwarm();
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData(
            'g1',
            agentIds: const ['agent-lead'],
            leadId: 'agent-lead',
            lastMessageSequence: page.first['sequence'] as int,
          ),
        ],
        agents: agents ?? [agent('agent-lead', name: 'Lead')],
        machines: machines ?? [machine('mac-1', readAt: clock.now())],
      ),
    };
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    swarm.routes[messages] = (_) => {'messages': page, 'next': null};
    swarm.routes[exact] =
        answer ?? (_) => {'messages': page.take(1).toList(), 'next': null};
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    addTearDown(reader.dispose);
    return (swarm: swarm, reader: reader);
  }

  Future<SwarmConversation> open(SwarmReader reader) async {
    await reader.refresh();
    final c = SwarmConversation(reader, 'g1');
    addTearDown(c.dispose);
    await c.load();
    return c;
  }

  /// One read of the Swarm, and what it set off answered.
  Future<void> tick(({FakeSwarm swarm, SwarmReader reader}) r) async {
    await r.reader.refresh();
    await pumpEventQueue();
  }

  int reads(FakeSwarm swarm) =>
      swarm.paths.where((path) => path.startsWith(exact)).length;

  group('reading the newest own message again', () {
    late DateTime now;
    late Clock moved;
    setUp(() {
      now = DateTime.utc(2026, 10, 30, 9);
      moved = Clock(() => now);
    });

    test('asks at the Swarm\'s reads, at most every 30 seconds', () {
      return withClock(moved, () async {
        final r = rig(
          page: [
            own('m1', 1, at: now, deliveries: [delivery()]),
          ],
        );
        final c = await open(r.reader);
        expect(reads(r.swarm), 0);

        await tick(r);
        expect(reads(r.swarm), 1);
        expect(r.swarm.paths.last, '${exact}m1');
        expect(c.receiptCurrent(c.latestOwn!), isTrue);

        now = now.add(const Duration(seconds: 29));
        await tick(r);
        expect(reads(r.swarm), 1, reason: 'under 30 seconds');

        now = now.add(const Duration(seconds: 1));
        await tick(r);
        expect(reads(r.swarm), 2);
      });
    });

    test('stops once the delivery is claimed, and the row takes the claim', () {
      return withClock(moved, () async {
        final queued = own('m1', 1, at: now, deliveries: [delivery()]);
        var status = 'queued';
        final r = rig(
          page: [queued],
          answer: (_) => {
            'messages': [
              {
                ...queued,
                'deliveries': [delivery(status: status)],
              },
            ],
          },
        );
        final c = await open(r.reader);
        await tick(r);
        expect(c.latestOwn!.receiptDelivery!.status, 'queued');

        status = 'claimed';
        now = now.add(const Duration(seconds: 30));
        await tick(r);
        expect(reads(r.swarm), 2);
        expect(c.latestOwn!.receiptDelivery!.status, 'claimed');

        now = now.add(const Duration(minutes: 5));
        await tick(r);
        expect(reads(r.swarm), 2, reason: 'claimed: nothing more to ask');
      });
    });

    test('stops after 10 minutes on screen, and the line stays as read', () {
      return withClock(moved, () async {
        final r = rig(
          page: [
            own('m1', 1, at: now, deliveries: [delivery()]),
          ],
        );
        final c = await open(r.reader);
        await tick(r);
        for (var i = 0; i < 19; i++) {
          now = now.add(const Duration(seconds: 30));
          await tick(r);
        }
        final asked = reads(r.swarm);
        expect(asked, 20);

        for (var i = 0; i < 10; i++) {
          now = now.add(const Duration(seconds: 30));
          await tick(r);
        }
        expect(reads(r.swarm), asked, reason: 'past the 10 minutes');
        expect(c.receiptCurrent(c.latestOwn!), isTrue);
      });
    });

    test('never asks in the background, and asks anew once back', () {
      return withClock(moved, () async {
        final r = rig(
          page: [
            own('m1', 1, at: now, deliveries: [delivery()]),
          ],
        );
        final c = await open(r.reader);
        await tick(r);
        expect(reads(r.swarm), 1);

        c.shown = false;
        for (var i = 0; i < 40; i++) {
          now = now.add(const Duration(seconds: 30));
          await tick(r);
        }
        expect(reads(r.swarm), 1, reason: 'off screen nothing asks');

        c.shown = true;
        expect(
          c.receiptCurrent(c.latestOwn!),
          isFalse,
          reason: 'what it read before the background is not believed',
        );
        await tick(r);
        expect(reads(r.swarm), 2);
        expect(c.receiptCurrent(c.latestOwn!), isTrue);
      });
    });

    test('asks only for the person\'s own newest, and only while queued', () {
      return withClock(moved, () async {
        final r = rig(
          page: [
            {
              ...own('m3', 3, at: now),
              'author': {'kind': 'agent', 'id': 'agent-lead', 'name': 'Lead'},
              'deliveries': [delivery()],
            },
            own(
              'm2',
              2,
              at: now,
              deliveries: [delivery(status: 'delivered')],
            ),
            own('m1', 1, at: now, deliveries: [delivery()]),
          ],
        );
        final c = await open(r.reader);
        await tick(r);
        expect(c.latestOwn!.id, 'm2');
        expect(reads(r.swarm), 0);
      });
    });

    test(
      'a failed read proves nothing, is retried at 30 seconds, and recovers',
      () {
        return withClock(moved, () async {
          final page = [
            own('m1', 1, at: now, deliveries: [delivery()]),
          ];
          var failing = true;
          final r = rig(
            page: page,
            answer: (_) => failing
                ? throw const SuperTabFailure('SWARM_BUSY', 'Busy')
                : {'messages': page},
          );
          final c = await open(r.reader);
          await tick(r);
          expect(reads(r.swarm), 1);
          expect(c.receiptCurrent(c.latestOwn!), isFalse);
          expect(c.error, isNull, reason: 'the chat itself reads on');

          now = now.add(const Duration(seconds: 5));
          await tick(r);
          expect(
            reads(r.swarm),
            1,
            reason: 'bounded: no retry before 30 seconds',
          );

          failing = false;
          now = now.add(const Duration(seconds: 25));
          await tick(r);
          expect(reads(r.swarm), 2);
          expect(c.receiptCurrent(c.latestOwn!), isTrue);
        });
      },
    );

    test('a read that is not this message of this chat proves nothing', () {
      return withClock(moved, () async {
        final page = [
          own('m1', 1, at: now, deliveries: [delivery()]),
        ];
        var answer = <Map<String, dynamic>>[];
        final r = rig(page: page, answer: (_) => {'messages': answer});
        final c = await open(r.reader);

        await tick(r);
        expect(c.receiptCurrent(c.latestOwn!), isFalse, reason: 'empty answer');

        answer = [
          own(
            'm1',
            1,
            at: now,
            conversationId: 'private-chat',
            deliveries: [delivery(status: 'claimed')],
          ),
        ];
        now = now.add(const Duration(seconds: 30));
        await tick(r);
        expect(c.receiptCurrent(c.latestOwn!), isFalse, reason: 'another chat');
        expect(c.latestOwn!.receiptDelivery!.status, 'queued');
      });
    });

    for (final code in ['FORBIDDEN', 'NOT_FOUND']) {
      test('$code: the chat is lost and nothing of it stays', () {
        return withClock(moved, () async {
          final r = rig(
            page: [
              own('m1', 1, at: now, deliveries: [delivery()]),
            ],
            answer: (_) => throw SuperTabFailure(code, 'Not available'),
          );
          final c = await open(r.reader);
          await tick(r);
          expect(c.messages, isEmpty);
          expect(c.state, SwarmChatState.lost);
          expect(c.latestOwn, isNull);
        });
      });
    }

    test('an answer or a refusal after access ended changes nothing', () {
      return withClock(moved, () async {
        final late_ = Completer<Object?>();
        final page = [
          own('m1', 1, at: now, deliveries: [delivery()]),
        ];
        final r = rig(page: page, answer: (_) => late_.future);
        final c = await open(r.reader);
        await tick(r);
        expect(reads(r.swarm), 1);

        r.reader.revoke();
        expect(c.messages, isEmpty);
        late_.completeError(
          const SuperTabFailure('FORBIDDEN', 'Not available'),
        );
        await pumpEventQueue();
        expect(c.messages, isEmpty);
        expect(c.error, isNull, reason: 'it says nothing of a chat let go');
      });
    });

    test('an answer after the chat closed tells no one', () {
      return withClock(moved, () async {
        final late_ = Completer<Object?>();
        final queued = own('m1', 1, at: now, deliveries: [delivery()]);
        final r = rig(page: [queued], answer: (_) => late_.future);
        await r.reader.refresh();
        final c = SwarmConversation(r.reader, 'g1');
        await c.load();
        await tick(r);
        expect(reads(r.swarm), 1);

        c.dispose();
        late_.complete({
          'messages': [
            {
              ...queued,
              'deliveries': [delivery(status: 'claimed')],
            },
          ],
        });
        await pumpEventQueue();
      });
    });

    test('an answer asked before the background is not believed after it', () {
      return withClock(moved, () async {
        final late_ = Completer<Object?>();
        final queued = own('m1', 1, at: now, deliveries: [delivery()]);
        final r = rig(page: [queued], answer: (_) => late_.future);
        final c = await open(r.reader);
        await tick(r);

        c.shown = false;
        c.shown = true;
        late_.complete({
          'messages': [
            {
              ...queued,
              'deliveries': [delivery(status: 'claimed')],
            },
          ],
        });
        await pumpEventQueue();
        expect(c.latestOwn!.receiptDelivery!.status, 'queued');
        expect(c.receiptCurrent(c.latestOwn!), isFalse);
      });
    });

    test(
      'an answer for the message before a newer own one is not the newer',
      () {
        return withClock(moved, () async {
          final late_ = Completer<Object?>();
          final first = own('m1', 1, at: now, deliveries: [delivery()]);
          final page = [first];
          final r = rig(page: page, answer: (_) => late_.future);
          final c = await open(r.reader);
          await tick(r);

          page.insert(0, own('m2', 2, at: now, deliveries: [delivery()]));
          await c.load();
          // No read of it yet: it arrived while the other's was under way.
          await c.load();
          late_.complete({
            'messages': [first],
          });
          await pumpEventQueue();
          expect(c.receiptCurrent(c.messages.last), isFalse);
        });
      },
    );
  });

  group('the line', () {
    /// [rigged]'s newest own message in the tree, as the chat draws it.
    Future<SwarmConversation> show(
      WidgetTester tester,
      ({FakeSwarm swarm, SwarmReader reader}) rigged,
    ) async {
      final c = await open(rigged.reader);
      await rigged.reader.refresh();
      await tester.pumpWidget(
        MaterialApp(
          home: Scaffold(
            body: ListenableBuilder(
              listenable: c,
              builder: (_, _) => switch (c.latestOwn) {
                final m? => SwarmMessageReceipt(conversation: c, message: m),
                null => const SizedBox.shrink(),
              },
            ),
          ),
        ),
      );
      await tester.pump();
      return c;
    }

    /// Let go of the tree: a wake-up left pending fails the test.
    Future<void> close(WidgetTester tester) async {
      expect(tester.takeException(), isNull);
      await tester.pumpWidget(const SizedBox());
    }

    testWidgets('claims failing for a minute read Not delivered yet', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(seconds: 70)),
              deliveries: [
                delivery(
                  failingSince: now.subtract(const Duration(seconds: 61)),
                ),
              ],
            ),
          ],
        ),
      );
      expect(find.text('Not delivered yet'), findsOneWidget);
      expect(find.text(couldntTake), findsOneWidget);
      expect(find.text('Send again'), findsNothing);
      expect(find.byType(TextButton), findsNothing);
      await close(tester);
    });

    testWidgets('an older backend: two minutes waiting reads it, in amber', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(minutes: 2, seconds: 1)),
              deliveries: [delivery()],
            ),
          ],
        ),
      );
      expect(find.text('Not delivered yet'), findsOneWidget);
      expect(find.text(notPickedUp), findsOneWidget);
      await close(tester);
    });

    testWidgets('offline still wins, in Desktop\'s words', (tester) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          machines: [
            machine('mac-1', readAt: now.subtract(const Duration(minutes: 3))),
          ],
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(minutes: 5)),
              deliveries: [
                delivery(
                  failingSince: now.subtract(const Duration(minutes: 5)),
                ),
              ],
            ),
          ],
        ),
      );
      expect(find.text("Lead's computer is offline"), findsOneWidget);
      expect(
        find.text(
          "Team Mac was last seen 3 min ago. Your message goes in when it's back online.",
        ),
        findsOneWidget,
      );
      expect(find.text('Not delivered yet'), findsNothing);
      await close(tester);
    });

    testWidgets('a machine with no reading is offline, with no last seen', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          machines: [machine('mac-1')],
          page: [
            own('m1', 1, at: now, deliveries: [delivery()]),
          ],
        ),
      );
      expect(find.text("Lead's computer is offline"), findsOneWidget);
      expect(
        find.text(
          "Team Mac is offline. Your message goes in when it's back online.",
        ),
        findsOneWidget,
      );
      await close(tester);
    });

    testWidgets(
      'a machine going quiet turns the line offline at the next read',
      (tester) async {
        final now = clock.now();
        final r = rig(
          machines: [machine('mac-1', readAt: now)],
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(minutes: 3)),
              deliveries: [delivery()],
            ),
          ],
        );
        await show(tester, r);
        expect(find.text('Not delivered yet'), findsOneWidget);

        await tester.pump(const Duration(seconds: 36));
        await r.reader.refresh();
        await tester.pump();
        expect(find.text("Lead's computer is offline"), findsOneWidget);
        expect(find.text('Not delivered yet'), findsNothing);
        await close(tester);
      },
    );

    testWidgets('a stopped recipient shows no Not delivered yet', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          agents: [
            {
              ...agent('agent-lead', name: 'Lead'),
              'downSince': now
                  .subtract(const Duration(minutes: 10))
                  .toUtc()
                  .toIso8601String(),
            },
          ],
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(minutes: 5)),
              deliveries: [
                delivery(
                  failingSince: now.subtract(const Duration(minutes: 5)),
                ),
              ],
            ),
          ],
        ),
      );
      expect(find.text('Not delivered yet'), findsNothing);
      await close(tester);
    });

    testWidgets('a claimed delivery carries no line, offline or not', (
      tester,
    ) async {
      final now = clock.now();
      final queued = own(
        'm1',
        1,
        at: now.subtract(const Duration(minutes: 5)),
        deliveries: [
          delivery(failingSince: now.subtract(const Duration(minutes: 5))),
        ],
      );
      await show(
        tester,
        rig(
          machines: [
            machine('mac-1', readAt: now.subtract(const Duration(minutes: 3))),
          ],
          page: [queued],
          answer: (_) => {
            'messages': [
              {
                ...queued,
                'deliveries': [
                  delivery(
                    status: 'claimed',
                    failingSince: now.subtract(const Duration(minutes: 5)),
                  ),
                ],
              },
            ],
          },
        ),
      );
      expect(find.text('Not delivered yet'), findsNothing);
      expect(find.text("Lead's computer is offline"), findsNothing);
      await close(tester);
    });

    testWidgets('it clears when the delivery is claimed', (tester) async {
      final now = clock.now();
      final message = own(
        'm1',
        1,
        at: now.subtract(const Duration(minutes: 3)),
        deliveries: [delivery()],
      );
      var status = 'queued';
      final r = rig(
        page: [message],
        answer: (_) => {
          'messages': [
            {
              ...message,
              'deliveries': [delivery(status: status)],
            },
          ],
        },
      );
      await show(tester, r);
      expect(find.text('Not delivered yet'), findsOneWidget);

      status = 'claimed';
      await tester.pump(const Duration(seconds: 30));
      await r.reader.refresh();
      await tester.pump();
      expect(find.text('Not delivered yet'), findsNothing);
      await close(tester);
    });

    testWidgets('it wakes once at the threshold, with no timer churn', (
      tester,
    ) async {
      final now = clock.now();
      final r = rig(
        page: [
          own(
            'm1',
            1,
            at: now.subtract(const Duration(minutes: 1, seconds: 50)),
            deliveries: [delivery()],
          ),
        ],
      );
      await show(tester, r);
      expect(find.text('Not delivered yet'), findsNothing);

      var built = 0;
      final before = debugOnRebuildDirtyWidget;
      debugOnRebuildDirtyWidget = (element, _) {
        if (element.widget is SwarmMessageReceipt) built++;
      };
      addTearDown(() => debugOnRebuildDirtyWidget = before);

      await tester.pump(const Duration(seconds: 9));
      expect(built, 0, reason: 'nothing draws it before the threshold');
      expect(find.text('Not delivered yet'), findsNothing);

      await tester.pump(const Duration(seconds: 2));
      expect(built, 1, reason: 'one wake-up');
      expect(find.text('Not delivered yet'), findsOneWidget);

      await tester.pump(const Duration(minutes: 5));
      expect(built, 1, reason: 'crossed: no more wake-ups');
      debugOnRebuildDirtyWidget = before;
      await close(tester);
    });

    testWidgets('the first of the two thresholds wakes it, in its words', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          page: [
            own(
              'm1',
              1,
              at: now,
              deliveries: [
                delivery(
                  failingSince: now.subtract(const Duration(seconds: 50)),
                ),
              ],
            ),
          ],
        ),
      );
      expect(find.text('Not delivered yet'), findsNothing);
      await tester.pump(const Duration(seconds: 11));
      expect(find.text(couldntTake), findsOneWidget);
      await close(tester);
    });

    testWidgets('queued for minutes keeps its line when claims start to fail', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(minutes: 5)),
              deliveries: [
                delivery(
                  failingSince: now.subtract(const Duration(seconds: 10)),
                ),
              ],
            ),
          ],
        ),
      );
      expect(find.text(couldntTake), findsOneWidget);
      await close(tester);
    });

    testWidgets(
      'away from the front no wake-up waits; back, the line is drawn',
      (tester) async {
        final now = clock.now();
        await show(
          tester,
          rig(
            // No reading to age: the minute away is not a machine going quiet.
            machines: const [],
            page: [
              own(
                'm1',
                1,
                at: now.subtract(const Duration(minutes: 1, seconds: 50)),
                deliveries: [delivery()],
              ),
            ],
          ),
        );
        addTearDown(
          () => tester.binding.handleAppLifecycleStateChanged(
            AppLifecycleState.resumed,
          ),
        );
        // Inactive still draws frames, so a wake-up left waiting would show.
        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.inactive,
        );
        await tester.pump();

        var built = 0;
        final before = debugOnRebuildDirtyWidget;
        debugOnRebuildDirtyWidget = (element, _) {
          if (element.widget is SwarmMessageReceipt) built++;
        };
        addTearDown(() => debugOnRebuildDirtyWidget = before);
        await tester.pump(const Duration(minutes: 1));
        expect(built, 0, reason: 'no timer fires away from the front');
        expect(find.text('Not delivered yet'), findsNothing);
        debugOnRebuildDirtyWidget = before;

        tester.binding.handleAppLifecycleStateChanged(
          AppLifecycleState.resumed,
        );
        await tester.pump();
        expect(find.text('Not delivered yet'), findsOneWidget);
        await close(tester);
      },
    );

    testWidgets('the Swarm out of reach says nothing, and comes back', (
      tester,
    ) async {
      final now = clock.now();
      final r = rig(
        page: [
          own(
            'm1',
            1,
            at: now.subtract(const Duration(minutes: 3)),
            deliveries: [delivery()],
          ),
        ],
      );
      await show(tester, r);
      expect(find.text('Not delivered yet'), findsOneWidget);

      final good = r.swarm.routes['/api/super-tabs/$tab/changes']!;
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
          throw const SuperTabFailure('NETWORK', 'No connection');
      await r.reader.refresh();
      await tester.pump();
      expect(r.reader.error, isNotNull);
      expect(find.text('Not delivered yet'), findsNothing);

      r.swarm.routes['/api/super-tabs/$tab/changes'] = good;
      await r.reader.refresh();
      await tester.pump();
      expect(r.reader.error, isNull);
      expect(find.text('Not delivered yet'), findsOneWidget);
      await close(tester);
    });

    testWidgets('access revoked while it shows: the line goes, nothing waits', (
      tester,
    ) async {
      final now = clock.now();
      final r = rig(
        page: [
          own(
            'm1',
            1,
            at: now.subtract(const Duration(minutes: 3)),
            deliveries: [delivery()],
          ),
        ],
      );
      final c = await show(tester, r);
      expect(find.text('Not delivered yet'), findsOneWidget);

      r.reader.revoke();
      await tester.pump();
      expect(c.messages, isEmpty);
      expect(find.text('Not delivered yet'), findsNothing);
      expect(find.textContaining('Team Mac'), findsNothing);
      await close(tester);
    });

    testWidgets('an agent who is no recipient of this chat is never named', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          agents: [
            agent('agent-lead', name: 'Lead'),
            {
              ...agent('agent-secret', name: 'Secret', machineId: 'mac-2'),
              'projectId': 'project-other',
            },
          ],
          machines: [
            machine('mac-1', readAt: now),
            machine('mac-2', name: 'Private Mac'),
          ],
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(minutes: 3)),
              deliveries: [delivery(agentId: 'agent-secret')],
            ),
          ],
        ),
      );
      expect(find.textContaining('Secret'), findsNothing);
      expect(find.textContaining('Private Mac'), findsNothing);
      expect(find.text('Not delivered yet'), findsNothing);
      await close(tester);
    });

    testWidgets('an unknown agent shows nothing and does not throw', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(minutes: 3)),
              deliveries: [delivery(agentId: 'agent-ghost')],
            ),
          ],
        ),
      );
      expect(find.text('Not delivered yet'), findsNothing);
      await close(tester);
    });

    testWidgets('a name reused in another project does not lend its machine', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          agents: [
            agent('agent-lead', name: 'Lead'),
            {
              ...agent('agent-twin', name: 'Lead', machineId: 'mac-2'),
              'projectId': 'project-other',
            },
          ],
          machines: [
            machine('mac-1', readAt: now),
            machine('mac-2', name: 'Other Mac'),
          ],
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(minutes: 3)),
              deliveries: [delivery()],
            ),
          ],
        ),
      );
      expect(find.text('Not delivered yet'), findsOneWidget);
      expect(find.text(notPickedUp), findsOneWidget);
      expect(find.textContaining('Other Mac'), findsNothing);
      await close(tester);
    });

    testWidgets('a machine this reader cannot see is called by its agent', (
      tester,
    ) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          machines: const [],
          page: [
            own(
              'm1',
              1,
              at: now.subtract(const Duration(minutes: 3)),
              deliveries: [delivery()],
            ),
          ],
        ),
      );
      expect(find.text('Not delivered yet'), findsOneWidget);
      expect(find.textContaining("Lead's computer is online"), findsOneWidget);
      expect(find.textContaining('mac-1'), findsNothing);
      await close(tester);
    });

    testWidgets('below the thresholds nothing takes room', (tester) async {
      final now = clock.now();
      await show(
        tester,
        rig(
          page: [
            own('m1', 1, at: now, deliveries: [delivery()]),
          ],
        ),
      );
      expect(tester.getSize(find.byType(SwarmMessageReceipt)).height, 0);
      await close(tester);
    });
  });
}
