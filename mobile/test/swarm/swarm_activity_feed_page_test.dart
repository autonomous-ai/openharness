import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' show AppFont;
import 'package:harness_mobile/swarm/swarm_activity_page.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_activity_fixture.dart';
import 'swarm_fixture.dart';

/// The Activity screen on a server with Activity (Tony, task 8a): Replies in
/// place of Threads, a row bold while unread and named as this Swarm lists
/// who it is from, and what was open read on every device once it is left.
void main() {
  /// [home] under a signed-in shell's Swarm, on a 390-point phone, against
  /// a server whose `/activity` answers [rows].
  Future<FakeSwarm> pump(
    WidgetTester tester,
    List<Map<String, dynamic>> rows, {
    Widget home = const SwarmActivityPage(),
    List<Map<String, dynamic>> groups = const [],
  }) async {
    final fake = activityBackend(
      page: activityPage,
      activityDigest: () => 'digest-1',
      groups: groups,
    );
    fake.routes[activityPath] = (_) => {'items': rows, 'more': false};
    // As the backend marks: the person's rows made at or before `through`.
    fake.routes['$activityPath/read'] = (body) {
      final through = DateTime.parse(body!['through'] as String);
      for (final row in rows) {
        if (!DateTime.parse(row['createdAt'] as String).isAfter(through)) {
          row['read'] = true;
        }
      }
      return {'marked': 1};
    };
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
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: home,
      ),
    );
    await tester.pumpAndSettle();
    return fake;
  }

  Finder key(String value) => find.byKey(ValueKey(value));

  Future<void> filter(WidgetTester tester, String name) async {
    await tester.ensureVisible(key('swarm-activity-filter-$name'));
    await tester.pumpAndSettle();
    await tester.tap(key('swarm-activity-filter-$name'));
    await tester.pumpAndSettle();
  }

  List<Map<String, dynamic>?> marks(FakeSwarm fake) => [
    for (final call in fake.calls)
      if (call.method == 'POST' && call.path == '$activityPath/read') call.body,
  ];

  FontWeight? weight(WidgetTester tester, String text) =>
      tester.widget<Text>(find.text(text)).style?.fontWeight;

  testWidgets('Replies in place of Threads, counting the unread; a row bold '
      'while unread, with what was said under it', (tester) async {
    await pump(tester, [
      activityRow('r2', minute: 9, text: "Merged, it's in tonight's build"),
      activityRow(
        'r1',
        minute: 3,
        read: true,
        actor: {'kind': 'agent', 'id': 'agent-builder', 'name': 'Nova'},
        text: 'Looks good',
      ),
    ]);

    final pill = key('swarm-activity-filter-threads');
    expect(
      find.descendant(of: pill, matching: find.text('Replies')),
      findsOneWidget,
    );
    expect(find.descendant(of: pill, matching: find.text('1')), findsOneWidget);

    await filter(tester, 'threads');
    expect(find.text('River replied to your message'), findsOneWidget);
    expect(find.text("Merged, it's in tonight's build"), findsOneWidget);
    expect(weight(tester, 'River replied to your message'), AppFont.semibold);
    expect(weight(tester, 'Nova replied to your message'), AppFont.regular);
    expect(find.textContaining('#Mobile'), findsNWidgets(2));
    expect(
      find.byKey(const ValueKey('swarm-activity-reply-activity:$tab:r2')),
      findsOneWidget,
    );
  });

  testWidgets("a project's Activity (its status card) lists only the server "
      "rows of that project's chats", (tester) async {
    await pump(
      tester,
      [
        activityRow('here', minute: 5, text: 'In Mobile'),
        activityRow(
          'there',
          minute: 4,
          conversationId: 'chat-other',
          text: 'In another project',
        ),
      ],
      groups: [
        {...groupData('chat-other', title: 'Other'), 'projectId': 'project-2'},
      ],
      home: const SwarmActivityPage(swarmId: tab, projectId: project),
    );
    await filter(tester, 'threads');
    expect(find.text('In Mobile'), findsOneWidget);
    expect(find.text('In another project'), findsNothing);
  });

  testWidgets('a reaction names its emoji', (tester) async {
    await pump(tester, [
      activityRow('x1', kind: 'reaction', emoji: 'thumbs_up', minute: 2),
    ]);
    await filter(tester, 'reactions');
    expect(find.text('River reacted 👍 to your message'), findsOneWidget);
  });

  testWidgets('who it is from is named as this Swarm lists them: an agent by '
      "its name here, a person it does not list as Someone, never the server's "
      'word for a person', (tester) async {
    await pump(tester, [
      activityRow(
        'p1',
        minute: 5,
        actor: {'kind': 'person', 'id': 'person-gone', 'name': 'secret-name'},
      ),
      activityRow(
        'a1',
        minute: 4,
        actor: {'kind': 'agent', 'id': 'agent-builder', 'name': 'Elsewhere'},
      ),
      activityRow(
        'a2',
        minute: 3,
        actor: {'kind': 'agent', 'id': 'agent-left', 'name': 'Old Pip'},
      ),
    ]);
    await filter(tester, 'threads');
    expect(find.text('Someone replied to your message'), findsOneWidget);
    expect(find.text('Nova replied to your message'), findsOneWidget);
    expect(find.text('Old Pip replied to your message'), findsOneWidget);
    expect(find.textContaining('secret-name'), findsNothing);
    expect(find.textContaining('Elsewhere'), findsNothing);
  });

  testWidgets('Activity left (another tab) marks what it had open read on '
      'every device; a list never opened stays unread', (tester) async {
    final hidden = ValueNotifier(false);
    addTearDown(hidden.dispose);
    final fake = await pump(
      tester,
      [
        activityRow('r2', minute: 9),
        activityRow('x1', kind: 'reaction', emoji: 'check', minute: 12),
      ],
      home: Scaffold(
        body: ValueListenableBuilder(
          valueListenable: hidden,
          builder: (_, out, _) =>
              OutOfSight(hidden: out, child: const SwarmActivityView()),
        ),
      ),
    );
    await filter(tester, 'threads');

    // A chat opened from a row is over Activity, not instead of it.
    await tester.tap(key('swarm-activity-reply-activity:$tab:r2'));
    await tester.pumpAndSettle();
    expect(marks(fake), isEmpty);
    Navigator.of(
      tester.element(find.byType(SwarmActivityView, skipOffstage: false)),
    ).pop();
    await tester.pumpAndSettle();
    expect(weight(tester, 'River replied to your message'), AppFont.semibold);

    hidden.value = true;
    await tester.pumpAndSettle();
    expect(marks(fake), [
      {'through': DateTime.utc(2026, 11, 1, 7, 9).toIso8601String()},
    ], reason: 'the reaction behind Reactions was never open: it stays unread');

    hidden.value = false;
    await tester.pumpAndSettle();
    expect(weight(tester, 'River replied to your message'), AppFont.regular);
    final pill = key('swarm-activity-filter-reactions');
    expect(find.descendant(of: pill, matching: find.text('1')), findsOneWidget);
  });

  testWidgets('a Swarm the person can no longer read leaves the list at once', (
    tester,
  ) async {
    await pump(tester, [activityRow('r1', text: 'Private words')]);
    await filter(tester, 'threads');
    expect(find.text('Private words'), findsOneWidget);

    final host = tester.widget<SwarmScope>(find.byType(SwarmScope)).notifier!;
    host.session!.inbox.reader(tab)!.revoke();
    await tester.pumpAndSettle();
    expect(find.text('Private words'), findsNothing);
    expect(find.textContaining('replied to your message'), findsNothing);
  });

  testWidgets('a list that cannot be read says so and Try again reads it', (
    tester,
  ) async {
    final fake = activityBackend(
      page: activityPage,
      activityDigest: () => 'digest-1',
    );
    var fail = true;
    fake.routes[activityPath] = (_) => fail
        ? throw Exception('down')
        : {
            'items': [activityRow('r1', text: 'Back again')],
            'more': false,
          };
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
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: const SwarmActivityPage(),
      ),
    );
    await tester.pumpAndSettle();
    await filter(tester, 'threads');

    expect(find.text('Some chats could not be read.'), findsOneWidget);
    expect(key('swarm-activity-loading'), findsNothing);

    fail = false;
    await tester.tap(key('swarm-activity-retry'));
    await tester.pumpAndSettle();
    expect(find.text('Back again'), findsOneWidget);
    expect(find.text('Some chats could not be read.'), findsNothing);
  });
}
