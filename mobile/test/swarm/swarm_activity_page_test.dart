import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_activity_fixture.dart';
import 'swarm_fixture.dart';

/// The Activity screen (Tony's prototype C3): four filters, each with its
/// count; Approve, which asks first, and Reply on the row; rows the person
/// handled kept, dimmed, below the others; and nothing of a Swarm left on
/// screen once the person can no longer read it.
void main() {
  const work = 'work:$tab:g1:attempt-g1:needs_human';

  /// [home] under a signed-in shell's Swarm, Swarm on, on a 390-point phone.
  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    Widget home = const SwarmActivityPage(),
    MemoryKeyValueStore? store,
  }) async {
    await tester.binding.setSurfaceSize(const Size(390, 844));
    addTearDown(() => tester.binding.setSurfaceSize(null));
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: store ?? MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: home,
      ),
    );
    await tester.pumpAndSettle();
    return host;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  SwarmHost host(WidgetTester tester) =>
      tester.widget<SwarmScope>(find.byType(SwarmScope)).notifier!;

  int chatReads(FakeSwarm fake) =>
      fake.paths.where((p) => p.startsWith(activityChatPath)).length;

  /// Opens filter [name], scrolled into view first: the pills scroll
  /// sideways, as the prototype's do.
  Future<void> filter(WidgetTester tester, String name) async {
    await tester.ensureVisible(key('swarm-activity-filter-$name'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-activity-filter-$name'));
    await tester.pumpAndSettle();
  }

  testWidgets('four filters, each with its count, each a thumb tall', (
    tester,
  ) async {
    await pump(tester, activityBackend(page: activityPage));

    expect(find.text('Activity'), findsOneWidget);
    for (final (name, label, count) in [
      ('needsYou', 'Needs you', '2'),
      ('mentions', '@', '1'),
      ('threads', 'Threads', '1'),
      ('reactions', 'Reactions', '0'),
    ]) {
      final pill = key('swarm-activity-filter-$name');
      expect(
        find.descendant(of: pill, matching: find.text(label)),
        findsOneWidget,
      );
      expect(
        find.descendant(of: pill, matching: find.text(count)),
        findsOneWidget,
        reason: '$label carries its count',
      );
      expect(tester.getSize(pill).height, greaterThanOrEqualTo(44));
    }
  });

  testWidgets('Needs you: where and who over the ask, Approve on a decision, '
      'Reply on work', (tester) async {
    await pump(tester, activityBackend());

    final decision = key('swarm-activity-row-decision:d1');
    expect(
      find.descendant(of: decision, matching: find.text('#Mobile · River')),
      findsOneWidget,
    );
    expect(
      find.descendant(
        of: decision,
        matching: find.text('Approve merge: PR #2154?'),
      ),
      findsOneWidget,
    );
    final approve = key('swarm-activity-approve-decision:d1');
    final reply = key('swarm-activity-reply-$work');
    expect(approve, findsOneWidget);
    expect(reply, findsOneWidget);
    expect(key('swarm-activity-reply-decision:d1'), findsNothing);
    for (final button in [approve, reply]) {
      expect(tester.getSize(button).height, greaterThanOrEqualTo(44));
      expect(tester.getSize(button).width, greaterThanOrEqualTo(44));
    }
  });

  testWidgets('Approve asks first, naming the option; Cancel sends nothing', (
    tester,
  ) async {
    final fake = activityBackend();
    await pump(tester, fake);

    await tester.tap(key('swarm-activity-approve-decision:d1'));
    await tester.pumpAndSettle();
    expect(find.text('Approve?'), findsOneWidget);
    expect(find.textContaining('“Merge”'), findsOneWidget);

    await tester.tap(key('swarm-activity-approve-cancel'));
    await tester.pump(const Duration(seconds: 5));
    await tester.pumpAndSettle();

    expect(fake.commands, isEmpty);
    expect(key('swarm-activity-approve-decision:d1'), findsOneWidget);
  });

  testWidgets('Approve confirmed is held for Undo, then sent, and the row '
      'stays as handled', (tester) async {
    final fake = activityBackend();
    final host = await pump(tester, fake);

    await tester.tap(key('swarm-activity-approve-decision:d1'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-activity-approve-confirm'));
    await tester.pump();
    expect(find.text('Sending “Merge”'), findsOneWidget);
    expect(key('swarm-undo-d1'), findsOneWidget);

    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    await tester.pump(const Duration(seconds: 4));
    await tester.pumpAndSettle();
    expect(fake.commands.single, {
      'type': 'decision.answer',
      'decisionId': 'd1',
      'choice': 1,
    });
    await host.session!.inbox.refresh();
    await tester.pumpAndSettle();

    expect(key('swarm-activity-handled-decision:d1'), findsOneWidget);
    expect(find.text('Approved'), findsOneWidget);
    expect(
      find.descendant(
        of: key('swarm-activity-filter-needsYou'),
        matching: find.text('1'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('Reply opens where it was asked; back, the row is handled', (
    tester,
  ) async {
    await pump(tester, activityBackend());

    await tester.tap(key('swarm-activity-reply-$work'));
    await tester.pumpAndSettle();
    expect(find.byType(SwarmConversationPage), findsOneWidget);
    expect(
      tester
          .widget<SwarmConversationPage>(find.byType(SwarmConversationPage))
          .conversationId,
      'g1',
    );

    await tester.tap(find.byKey(const ValueKey('tty-back')).first);
    await tester.pumpAndSettle();
    expect(key('swarm-activity-handled-$work'), findsOneWidget);
    expect(find.text('Opened'), findsOneWidget);
    expect(
      find.descendant(
        of: key('swarm-activity-filter-needsYou'),
        matching: find.text('1'),
      ),
      findsOneWidget,
    );
  });

  testWidgets('a row tapped opens in full, with every option', (tester) async {
    await pump(tester, activityBackend());

    await tester.tap(key('swarm-activity-row-decision:d1'));
    await tester.pumpAndSettle();

    expect(key('swarm-option-d1-0'), findsOneWidget);
    expect(key('swarm-option-d1-1'), findsOneWidget);
  });

  testWidgets('@: the tags, Reply opening the chat at the tag', (tester) async {
    await pump(tester, activityBackend());
    await filter(tester, 'mentions');

    expect(find.text('Can you check the copy?'), findsOneWidget);
    await tester.tap(key('swarm-activity-reply-mention:m1'));
    await tester.pumpAndSettle();

    final page = tester.widget<SwarmConversationPage>(
      find.byType(SwarmConversationPage),
    );
    expect((page.conversationId, page.messageId), (leadChat, 'msg-tag'));
  });

  testWidgets('Threads: the person\'s threads, the one with news first', (
    tester,
  ) async {
    await pump(tester, activityBackend(page: activityPage));
    await filter(tester, 'threads');

    final open = key('swarm-activity-row-thread:$tab:root-1');
    expect(
      find.descendant(of: open, matching: find.text('Ship the build tonight?')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: open, matching: find.text('2 replies')),
      findsOneWidget,
    );
    expect(key('swarm-activity-handled-thread:$tab:root-old'), findsOneWidget);
    expect(
      tester.getTopLeft(open).dy,
      lessThan(
        tester.getTopLeft(key('swarm-activity-row-thread:$tab:root-old')).dy,
      ),
    );

    await tester.tap(key('swarm-activity-reply-thread:$tab:root-1'));
    await tester.pumpAndSettle();
    final page = tester.widget<SwarmConversationPage>(
      find.byType(SwarmConversationPage),
    );
    expect((page.conversationId, page.messageId), (leadChat, 'root-1'));
  });

  testWidgets("Reactions: who reacted how to the person's message", (
    tester,
  ) async {
    final store = MemoryKeyValueStore()
      ..values['swarm_activity.$me.$tab'] = '{"marks":{}}';
    await pump(tester, activityBackend(page: activityPage), store: store);
    await filter(tester, 'reactions');

    final row = key('swarm-activity-row-reaction:$tab:mine-2');
    expect(
      find.descendant(of: row, matching: find.text('Copy is fixed.')),
      findsOneWidget,
    );
    expect(
      find.descendant(of: row, matching: find.textContaining('River')),
      findsWidgets,
    );
    expect(
      find.descendant(of: row, matching: find.textContaining('✅ 1')),
      findsOneWidget,
    );
    expect(key('swarm-activity-row-reaction:$tab:own-only'), findsNothing);
  });

  testWidgets('a filter with nothing in it says so', (tester) async {
    await pump(tester, activityBackend());
    await filter(tester, 'reactions');

    expect(key('swarm-activity-none'), findsOneWidget);
    expect(find.text('No reactions to you yet.'), findsOneWidget);
  });

  testWidgets('a Swarm the person can no longer read leaves the screen at '
      'once, with nothing of it left', (tester) async {
    final fake = activityBackend(page: activityPage);
    final host = await pump(tester, fake);
    expect(key('swarm-activity-row-decision:d1'), findsOneWidget);

    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': <Object>[],
      'next': null,
    };
    fake.routes['/api/super-tabs/invitations'] = (_) => <Object>[];
    await host.session!.inbox.refresh();
    await tester.pumpAndSettle();

    expect(find.textContaining('Mobile'), findsNothing);
    expect(find.textContaining('River'), findsNothing);
    expect(key('swarm-activity-none'), findsOneWidget);
    await filter(tester, 'threads');
    expect(find.text('Ship the build tonight?'), findsNothing);
    expect(key('swarm-activity-loading'), findsNothing);
  });

  testWidgets('a project chat that cannot be read says so, and Try again '
      'reads it again', (tester) async {
    final fake = activityBackend();
    fake.routes[activityChatPath] = (_) =>
        throw const SuperTabFailure('MACHINE_UNAVAILABLE', 'No computer.');
    await pump(tester, fake);
    await filter(tester, 'threads');

    expect(find.text('Some chats could not be read.'), findsOneWidget);
    expect(key('swarm-activity-loading'), findsNothing);

    fake.routes[activityChatPath] = (_) => activityPage();
    await tester.tap(key('swarm-activity-retry'));
    await tester.pumpAndSettle();

    expect(find.text('Some chats could not be read.'), findsNothing);
    expect(find.text('Ship the build tonight?'), findsOneWidget);
  });

  testWidgets('out of sight, it reads no chat; in sight again, it does', (
    tester,
  ) async {
    final fake = activityBackend(page: activityPage);
    final hidden = ValueNotifier(true);
    addTearDown(hidden.dispose);
    await pump(
      tester,
      fake,
      home: Scaffold(
        body: ValueListenableBuilder(
          valueListenable: hidden,
          builder: (_, out, _) =>
              OutOfSight(hidden: out, child: const SwarmActivityView()),
        ),
      ),
    );
    await host(tester).session!.inbox.refresh();
    await tester.pumpAndSettle();
    expect(chatReads(fake), 0);

    hidden.value = false;
    await tester.pumpAndSettle();
    expect(chatReads(fake), 1);
  });
}
