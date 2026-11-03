import 'dart:async';

import 'package:fake_async/fake_async.dart';
import 'package:flutter/cupertino.dart' show CupertinoPageRoute;
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/swarm/swarm_chat_notify.dart';
import 'package:harness_mobile/swarm/swarm_home_rows.dart';
import 'package:harness_mobile/swarm/swarm_home_view_sheet.dart';
import 'package:harness_mobile/swarm/swarm_mark_all.dart';
import 'package:harness_mobile/swarm/swarm_page.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart' show MemoryKeyValueStore;
import 'swarm_fixture.dart';

/// Mark all read on the phone, as Desktop has it
/// (#2453): every chat shown unread reads as read at once, and its mark goes
/// to the server only once 6 s pass without Undo, since read marks never
/// move back there. Leaving the app or closing the session is no Undo; access
/// lost sends nothing.
void main() {
  const web = 'project-2';
  const webLead = 'group-lead-web';

  /// One Swarm: Mobile, whose g1 and g2 are unread past the server's marks,
  /// a muted chat and a dormant one unread too, and a read one; and Web,
  /// read.
  FakeSwarm backend() {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    const derived = {
      'readMarks': {
        leadChat: 2,
        'g1': 1,
        'g2': 1,
        'g-muted': 1,
        'g-dormant': 1,
        'g-read': 3,
        webLead: 1,
      },
      'chatSettings': {'g-muted': 'muted'},
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      derived: derived,
      head: headData(
        projects: [
          ...headData()['projects'] as List,
          {
            'id': web,
            'name': 'Web',
            'ownerId': me,
            'leadConversationId': webLead,
            'visibility': 'public',
            'members': <Object>[],
            'updateMinutes': 5,
          },
        ],
      ),
      groups: [
        groupData('g1', title: 'Fix login', lastMessageSequence: 5),
        groupData('g2', title: 'Ship it', lastMessageSequence: 4),
        groupData('g-muted', title: 'Noise', lastMessageSequence: 6),
        groupData(
          'g-dormant',
          title: 'Old',
          lastMessageSequence: 7,
          dormant: true,
        ),
        groupData('g-read', title: 'Done', lastMessageSequence: 3),
        {
          ...groupData(webLead, title: 'Web', lastMessageSequence: 1),
          'projectId': web,
        },
      ],
    );
    fake.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: derived);
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/conversations/'] = (body) => {
      'sequence': body?['sequence'],
      'messages': <Object>[],
      'next': null,
    };
    return fake;
  }

  /// The read marks sent, by chat and mark.
  List<(String, Object?)> marksSent(FakeSwarm fake) => [
    for (final call in fake.calls)
      if (call.method == 'POST' && call.path.endsWith('/read'))
        (
          call.path.split('/conversations/').last.split('/').first,
          call.body?['sequence'],
        ),
  ];

  group('Mark all read', () {
    /// A session over [backend], read once.
    ({SwarmSession session, FakeSwarm fake, SwarmReader reader}) rig(
      FakeAsync async, {
      MemoryKeyValueStore? store,
    }) {
      final fake = backend();
      final session = SwarmSession(
        accountId: me,
        request: fake.request,
        notices: SilentSystemNotices(),
        readMarks: store ?? MemoryKeyValueStore(),
      );
      session.inbox.refresh();
      async.flushMicrotasks();
      final reader = session.inbox.reader(tab)!;
      return (session: session, fake: fake, reader: reader);
    }

    bool unread(SwarmReader reader, String id) =>
        reader.readMarks!.unread(reader.snapshot!.conversation(id)!);

    test('every chat shown unread reads as read at once, and nothing is '
        'sent before 6 s; then each mark is sent once', () {
      fakeAsync((async) {
        final r = rig(async);
        expect(unread(r.reader, 'g1'), isTrue);

        final held = r.session.markAllRead([tab])!;
        async.flushMicrotasks();

        expect(held.count, 2);
        expect(unread(r.reader, 'g1'), isFalse);
        expect(unread(r.reader, 'g2'), isFalse);
        async.elapse(const Duration(milliseconds: 5900));
        expect(marksSent(r.fake), isEmpty);

        async.elapse(const Duration(milliseconds: 200));
        expect(marksSent(r.fake), [('g1', 5), ('g2', 4)]);
        expect(r.session.markAll, isNull);

        async.elapse(const Duration(minutes: 1));
        r.session.dispose();
        async.flushMicrotasks();
        expect(marksSent(r.fake), hasLength(2));
      });
    });

    test('Undo within 6 s sends nothing, and the chats read unread again', () {
      fakeAsync((async) {
        final r = rig(async);
        final held = r.session.markAllRead([tab])!;
        async.elapse(const Duration(seconds: 3));

        held.undo();
        async.elapse(const Duration(seconds: 10));

        expect(marksSent(r.fake), isEmpty);
        expect(unread(r.reader, 'g1'), isTrue);
        expect(unread(r.reader, 'g2'), isTrue);
        expect(r.session.markAll, isNull);
        r.session.dispose();
        async.flushMicrotasks();
        expect(marksSent(r.fake), isEmpty);
      });
    });

    test('muted and dormant chats are left as they were, as on Desktop', () {
      fakeAsync((async) {
        final r = rig(async);
        r.session.markAllRead([tab]);
        async.elapse(const Duration(seconds: 7));

        expect(unread(r.reader, 'g-muted'), isTrue);
        expect(unread(r.reader, 'g-dormant'), isTrue);
        expect(marksSent(r.fake).map((m) => m.$1), isNot(contains('g-muted')));
        expect(
          marksSent(r.fake).map((m) => m.$1),
          isNot(contains('g-dormant')),
        );
        r.session.dispose();
      });
    });

    test('the app going to the background sends the marks at once: it may '
        'not come back to send them, and a late Undo changes nothing', () {
      fakeAsync((async) {
        final r = rig(async);
        r.session.foreground = true;
        final held = r.session.markAllRead([tab])!;
        async.elapse(const Duration(seconds: 1));

        r.session.foreground = false;
        async.flushMicrotasks();

        expect(marksSent(r.fake), [('g1', 5), ('g2', 4)]);
        held.undo();
        expect(unread(r.reader, 'g1'), isFalse);
        r.session.dispose();
      });
    });

    test('closing the session (app closed, account changed) sends the marks '
        'at once', () {
      fakeAsync((async) {
        final r = rig(async);
        r.session.markAllRead([tab]);
        async.elapse(const Duration(seconds: 1));

        r.session.dispose();
        async.flushMicrotasks();

        expect(marksSent(r.fake), [('g1', 5), ('g2', 4)]);
      });
    });

    test('access lost during the wait sends nothing, and the phone keeps no '
        'mark of it', () {
      fakeAsync((async) {
        final store = MemoryKeyValueStore();
        final r = rig(async, store: store);
        r.session.markAllRead([tab]);
        async.elapse(const Duration(seconds: 1));

        r.reader.revoke();
        async.elapse(const Duration(seconds: 10));
        r.session.dispose();
        async.flushMicrotasks();

        expect(marksSent(r.fake), isEmpty);
        expect(store.values['swarm_read_marks.$me.$tab'], isNull);
      });
    });

    test('a chat read during the wait keeps its read after Undo', () {
      fakeAsync((async) {
        final r = rig(async);
        final held = r.session.markAllRead([tab])!;
        r.reader.readMarks!.markRead('g1', 5);
        async.flushMicrotasks();

        held.undo();
        async.elapse(const Duration(seconds: 10));

        expect(unread(r.reader, 'g1'), isFalse);
        expect(unread(r.reader, 'g2'), isTrue);
        expect(marksSent(r.fake), [('g1', 5)]);
        r.session.dispose();
      });
    });

    test(
      'a second Mark all read sends the first\'s marks before it starts',
      () {
        fakeAsync((async) {
          final r = rig(async);
          r.session.markAllRead([tab]);
          async.elapse(const Duration(seconds: 1));

          expect(r.session.markAllRead([tab]), isNull);
          async.flushMicrotasks();

          expect(marksSent(r.fake), [('g1', 5), ('g2', 4)]);
          r.session.dispose();
        });
      },
    );

    /// Holds the server's answer to [chat]'s notification setting until the
    /// test gives it.
    Completer<Object?> holdNotify(FakeSwarm fake, String chat) {
      final answer = Completer<Object?>();
      fake.routes['/api/super-tabs/$tab/conversations/$chat/notifications'] = (
        _,
      ) => answer.future;
      return answer;
    }

    test('a chat muted on this phone a moment ago, before the server '
        'answers, is left as it was', () {
      fakeAsync((async) {
        final r = rig(async);
        final answer = holdNotify(r.fake, 'g1');
        r.reader.setNotify('g1', SwarmNotify.muted);
        async.flushMicrotasks();

        final held = r.session.markAllRead([tab])!;
        async.elapse(const Duration(seconds: 7));

        expect(held.count, 1);
        expect(unread(r.reader, 'g1'), isTrue);
        expect(marksSent(r.fake), [('g2', 4)]);
        answer.complete({'notify': 'muted'});
        r.session.dispose();
        async.flushMicrotasks();
      });
    });

    test('a mute the server kept, before a read carries it, is left as it '
        'was', () {
      fakeAsync((async) {
        final r = rig(async);
        holdNotify(r.fake, 'g1').complete({'notify': 'muted'});
        r.reader.setNotify('g1', SwarmNotify.muted);
        async.flushMicrotasks();
        expect(r.reader.snapshot!.chatSettings['g1'], isNull);

        r.session.markAllRead([tab]);
        async.elapse(const Duration(seconds: 7));

        expect(marksSent(r.fake), [('g2', 4)]);
        r.session.dispose();
      });
    });

    test('a chat unmuted on this phone a moment ago is marked with the '
        'rest', () {
      fakeAsync((async) {
        final r = rig(async);
        final answer = holdNotify(r.fake, 'g-muted');
        r.reader.setNotify('g-muted', SwarmNotify.mentions);
        async.flushMicrotasks();

        final held = r.session.markAllRead([tab])!;
        async.elapse(const Duration(seconds: 7));

        expect(held.count, 3);
        expect(unread(r.reader, 'g-muted'), isFalse);
        expect(marksSent(r.fake), [('g1', 5), ('g2', 4), ('g-muted', 6)]);
        answer.complete({'notify': 'mentions'});
        r.session.dispose();
        async.flushMicrotasks();
      });
    });

    test('with every unread chat muted on this phone a moment ago there is '
        'nothing to mark', () {
      fakeAsync((async) {
        final r = rig(async);
        holdNotify(r.fake, 'g1');
        holdNotify(r.fake, 'g2');
        expect(swarmAnyUnread([r.reader]), isTrue);
        r.reader.setNotify('g1', SwarmNotify.muted);
        r.reader.setNotify('g2', SwarmNotify.muted);
        async.flushMicrotasks();

        expect(swarmAnyUnread([r.reader]), isFalse);
        expect(r.session.markAllRead([tab]), isNull);
        r.session.dispose();
      });
    });

    test('a mute the server refused, or one a newer choice replaced, does '
        'not keep a chat out', () {
      fakeAsync((async) {
        final r = rig(async);
        r.fake.routes['/api/super-tabs/$tab/conversations/g1/notifications'] = (
          _,
        ) => throw const SwarmRequestTestFailure();
        r.reader.setNotify('g1', SwarmNotify.muted);
        final older = holdNotify(r.fake, 'g2');
        r.reader.setNotify('g2', SwarmNotify.muted);
        final newer = holdNotify(r.fake, 'g2');
        r.reader.setNotify('g2', SwarmNotify.all);
        async.flushMicrotasks();
        // The first choice's answer comes after the newer one was made.
        older.complete({'notify': 'muted'});
        async.flushMicrotasks();

        final held = r.session.markAllRead([tab])!;
        async.elapse(const Duration(seconds: 7));

        expect(held.count, 2);
        expect(marksSent(r.fake), [('g1', 5), ('g2', 4)]);
        newer.complete({'notify': 'all'});
        r.session.dispose();
        async.flushMicrotasks();
      });
    });

    test('access lost while a mute is on its way: nothing is marked or '
        'sent, and its late answer changes nothing', () {
      fakeAsync((async) {
        final r = rig(async);
        final answer = holdNotify(r.fake, 'g1');
        r.reader.setNotify('g1', SwarmNotify.muted);
        async.flushMicrotasks();

        r.reader.revoke();
        expect(swarmAnyUnread([r.reader]), isFalse);
        expect(r.session.markAllRead([tab]), isNull);
        answer.complete({'notify': 'muted'});
        async.elapse(const Duration(seconds: 7));

        expect(r.reader.notifyOf('g1'), SwarmNotify.mentions);
        expect(marksSent(r.fake), isEmpty);
        r.session.dispose();
        async.flushMicrotasks();
      });
    });

    test('before the Swarm is read there is nothing to mark; once a failed '
        'first read recovers, Mark all read works', () {
      fakeAsync((async) {
        final fake = backend();
        final load = fake.routes['/api/super-tabs/$tab/parts']!;
        fake.routes['/api/super-tabs/$tab/parts'] = (_) =>
            throw const SwarmRequestTestFailure();
        final session = SwarmSession(
          accountId: me,
          request: fake.request,
          notices: SilentSystemNotices(),
          readMarks: MemoryKeyValueStore(),
        );
        session.inbox.refresh();
        async.flushMicrotasks();
        final reader = session.inbox.reader(tab)!;
        expect(reader.snapshot, isNull);
        expect(swarmAnyUnread([reader]), isFalse);
        expect(session.markAllRead([tab]), isNull);

        fake.routes['/api/super-tabs/$tab/parts'] = load;
        reader.refresh();
        async.flushMicrotasks();

        expect(swarmAnyUnread([reader]), isTrue);
        expect(session.markAllRead([tab])?.count, 2);
        session.dispose();
      });
    });
  });

  group('Home', () {
    Future<SwarmHost> pump(
      WidgetTester tester,
      FakeSwarm fake, {
      ValueNotifier<String?>? signedIn,
    }) async {
      tester.view.physicalSize = const Size(1170, 2532);
      tester.view.devicePixelRatio = 3;
      addTearDown(tester.view.reset);
      final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
        ..value = {PhoneExperiment.swarm};
      final account = signedIn ?? ValueNotifier<String?>(me);
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
          builder: (context, child) =>
              SwarmScope(notifier: host, child: child!),
          onGenerateRoute: (_) => CupertinoPageRoute<void>(
            builder: (_) => SwarmPage(
              now: () => DateTime.fromMillisecondsSinceEpoch(
                0,
                isUtc: true,
              ).add(const Duration(minutes: 30)),
            ),
          ),
        ),
      );
      await tester.pumpAndSettle();
      return host;
    }

    Finder key(String value) => find.byKey(ValueKey(value));
    Finder row(String projectId) => key('swarm-project-$tab-$projectId');
    bool bold(WidgetTester tester, String projectId) =>
        tester.widget<SwarmHomeProjectRow>(row(projectId)).project.news.bold;

    /// Opens Sort and filter, where Mark all read is (2026-11-03).
    Future<void> openView(WidgetTester tester) async {
      await tester.tap(key('swarm-home-view'));
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
    }

    /// Mark all read, from Sort and filter: the sheet closes, then it marks.
    Future<void> markAll(WidgetTester tester) async {
      await openView(tester);
      await tester.tap(key('swarm-mark-all-read'));
    }

    /// Whether Mark all read has something to mark, as its row in Sort and
    /// filter says; the sheet then closes.
    Future<bool> markable(WidgetTester tester) async {
      await openView(tester);
      final on =
          tester
              .widget<SwarmHomeViewAction>(key('swarm-mark-all-read'))
              .onTap !=
          null;
      Navigator.of(tester.element(key('swarm-mark-all-read'))).pop();
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 400));
      return on;
    }

    testWidgets('Mark all read tells how many with Undo; Undo puts the bold '
        'back and sends nothing, and with nothing unread it is greyed', (
      tester,
    ) async {
      final fake = backend();
      await pump(tester, fake);
      expect(bold(tester, project), isTrue);
      expect(await markable(tester), isTrue);

      await markAll(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));

      expect(find.text('Marked 2 chats read'), findsOneWidget);
      expect(bold(tester, project), isFalse);
      expect(await markable(tester), isFalse);

      await tester.tap(find.text('Undo'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 7));
      await tester.pumpAndSettle();

      expect(marksSent(fake), isEmpty);
      expect(bold(tester, project), isTrue);

      await markAll(tester);
      await tester.pump();
      await tester.pump(const Duration(seconds: 7));
      await tester.pumpAndSettle();
      expect(marksSent(fake), [('g1', 5), ('g2', 4)]);
      expect(await markable(tester), isFalse);
    });

    testWidgets('a chat muted on this phone a moment ago is not marked: the '
        'toast counts the rest, and with all muted the button greys', (
      tester,
    ) async {
      final fake = backend();
      final answers = <Completer<Object?>>[];
      for (final chat in ['g1', 'g2']) {
        fake.routes['/api/super-tabs/$tab/conversations/$chat/notifications'] =
            (_) {
              final answer = Completer<Object?>();
              answers.add(answer);
              return answer.future;
            };
      }
      final host = await pump(tester, fake);
      final reader = host.session!.inbox.reader(tab)!;

      reader.setNotify('g1', SwarmNotify.muted);
      await tester.pump();
      await markAll(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('Marked 1 chat read'), findsOneWidget);
      await tester.tap(find.text('Undo'));
      await tester.pump();
      await tester.pump(const Duration(seconds: 7));
      await tester.pumpAndSettle();

      reader.setNotify('g2', SwarmNotify.muted);
      await tester.pump();
      expect(await markable(tester), isFalse);
      expect(marksSent(fake), isEmpty);
      for (final answer in answers) {
        answer.complete({'notify': 'muted'});
      }
      await tester.pumpAndSettle();
    });

    testWidgets('after the 6 s the marks are sent and the Undo toast closes '
        'with them', (tester) async {
      final fake = backend();
      await pump(tester, fake);
      await markAll(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('Undo'), findsOneWidget);

      await tester.pump(const Duration(milliseconds: 5600));
      await tester.pump(const Duration(seconds: 1));

      expect(marksSent(fake), [('g1', 5), ('g2', 4)]);
      expect(find.text('Undo'), findsNothing);
      expect(find.text('Marked 2 chats read'), findsNothing);
      // And it stays closed.
      await tester.pump(const Duration(minutes: 1));
      expect(find.text('Undo'), findsNothing);
    });

    testWidgets('with a screen reader on, a second Mark all read inside the '
        '6 s keeps its own toast, and the first one is closed', (tester) async {
      tester.platformDispatcher.accessibilityFeaturesTestValue =
          const FakeAccessibilityFeatures(accessibleNavigation: true);
      addTearDown(
        tester.platformDispatcher.clearAccessibilityFeaturesTestValue,
      );
      final fake = backend();
      final host = await pump(tester, fake);
      await markAll(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('Marked 2 chats read'), findsOneWidget);

      // A new message in a chat that was read: something to mark again.
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [
          part(
            'g-read',
            9,
            groupData('g-read', title: 'Done', lastMessageSequence: 8),
          ),
        ],
      );
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pump();
      await markAll(tester);
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(marksSent(fake), [('g1', 5), ('g2', 4)]);
      expect(find.text('Marked 2 chats read'), findsNothing);
      expect(find.text('Marked 1 chat read'), findsOneWidget);
      expect(find.text('Undo'), findsOneWidget);

      await tester.pump(const Duration(seconds: 7));
      expect(marksSent(fake), [('g1', 5), ('g2', 4), ('g-read', 8)]);
      expect(find.text('Undo'), findsNothing);
    });

    testWidgets('the app going to the background sends the marks and '
        'closes the Undo toast at once', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      host.foreground = true;
      await markAll(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('Undo'), findsOneWidget);

      host.foreground = false;
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(marksSent(fake), [('g1', 5), ('g2', 4)]);
      expect(find.text('Undo'), findsNothing);
      expect(find.text('Marked 2 chats read'), findsNothing);
    });

    testWidgets('another account signing in sends the marks and closes the '
        'Undo toast at once', (tester) async {
      final fake = backend();
      final account = ValueNotifier<String?>(me);
      await pump(tester, fake, signedIn: account);
      await markAll(tester);
      await tester.pump();
      await tester.pump(const Duration(milliseconds: 500));
      expect(find.text('Undo'), findsOneWidget);

      account.value = 'person-other';
      await tester.pump();
      await tester.pump(const Duration(seconds: 1));

      expect(marksSent(fake), [('g1', 5), ('g2', 4)]);
      expect(find.text('Undo'), findsNothing);
    });

    testWidgets('access lost while Home is open: the held marks are never '
        'sent, and nothing is left to mark', (tester) async {
      final fake = backend();
      final host = await pump(tester, fake);
      await markAll(tester);
      await tester.pump();

      host.session!.inbox.reader(tab)!.revoke();
      await tester.pump();
      // Home reads the Swarm again under a skeleton: nothing settles.
      for (var i = 0; i < 70; i++) {
        await tester.pump(const Duration(milliseconds: 100));
      }

      expect(marksSent(fake), isEmpty);
      expect(row(project), findsNothing);
      expect(swarmAnyUnread([host.session!.inbox.reader(tab)!]), isFalse);
    });
  });
}

/// A read that fails, as a server that cannot answer.
class SwarmRequestTestFailure implements Exception {
  const SwarmRequestTestFailure();
}
