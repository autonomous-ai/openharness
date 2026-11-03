import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/notify/system_notices.dart';
import 'package:harness_mobile/settings/experimental_features.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart' as grid;
import 'package:harness_mobile/shared/widgets/touch_target.dart';
import 'package:harness_mobile/swarm/swarm_conversation_page.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';
import 'package:harness_mobile/swarm/swarm_session.dart';

import '../voice_fakes.dart';
import 'swarm_fixture.dart';

/// Jump to first unread in a phone chat (Desktop's #2273 and #2294): shown
/// only while the New messages line is above the view and has not been seen,
/// a tap lands on the line, and it holds steady while any jump lands.
void main() {
  const chat = 'buddy-me';
  const messages = '/api/super-tabs/$tab/conversations/$chat/messages';
  final line = find.byKey(const ValueKey('swarm-new-messages-line'));
  final pill = find.byKey(const ValueKey('swarm-jump-unread'));
  final latest = find.byKey(const ValueKey('swarm-jump-latest'));
  final list = find.byKey(const ValueKey('swarm-messages'));

  Map<String, dynamic> said(
    int sequence, {
    String? replyTo,
    String conversation = chat,
  }) => {
    'id': 'msg-$sequence',
    'conversationId': conversation,
    'text': 'Update $sequence.',
    'sequence': sequence,
    'replyTo': ?replyTo,
    'author': {'kind': 'agent', 'id': 'agent-wren', 'name': 'agent-wren'},
    'attachments': <Object>[],
    'reactions': <Object>[],
    'createdAt': DateTime.utc(2026, 10, 29, 1, sequence).toIso8601String(),
  };

  List<Map<String, dynamic>> forty() => [for (var i = 1; i <= 40; i++) said(i)];

  /// The person's Buddy chat holding [page], read through [mark] on some
  /// device; [older] pages come before it.
  FakeSwarm backend(
    List<Map<String, dynamic>> page, {
    required int mark,
    bool older = false,
  }) {
    final fake = FakeSwarm();
    fake.routes['/api/super-tabs/list'] = (_) => {
      'tabs': [
        {'id': tab, 'name': 'Phone Swarm', 'ownerId': me},
      ],
      'next': null,
    };
    fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
      ...firstLoad(
        groups: [
          groupData(
            'g1',
            title: 'Fix login',
            number: 7,
            lastMessageSequence: 40,
          ),
          buddyChatData(
            chat,
            agentIds: ['agent-wren'],
            lastMessageSequence: page.last['sequence'] as int,
          ),
        ],
        agents: [
          agent('agent-lead', name: 'Lead', displayName: 'River'),
          buddyData('agent-wren', displayName: 'Wren'),
        ],
        derived: {
          'readMarks': {chat: mark, 'g1': 40},
        },
      ),
      'members': [part(me, 1, person(me))],
    };
    fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(cursor: 'c2');
    fake.routes['/api/super-tabs/$tab/decisions?state=open'] = (_) => {
      'decisions': <Object>[],
    };
    fake.routes['/api/super-tabs/$tab/mentions?state=waiting'] = (_) => {
      'mentions': <Object>[],
    };
    fake.routes[messages] = (_) => {
      'messages': page.reversed.toList(),
      'next': older
          ? {'sequence': page.first['sequence'], 'id': 'msg-older'}
          : null,
    };
    fake.routes['/api/super-tabs/$tab/conversations/g1/messages'] = (_) => {
      'messages': [for (var i = 40; i >= 1; i--) said(i, conversation: 'g1')],
      'next': null,
    };
    return fake;
  }

  Future<SwarmHost> pump(
    WidgetTester tester,
    FakeSwarm fake, {
    bool settle = true,
    String? messageId,
    String conversation = chat,
    ValueNotifier<String?>? signedIn,
  }) async {
    final features = ExperimentalFeaturesStore(storage: MemoryKeyValueStore())
      ..value = {PhoneExperiment.swarm};
    final account = signedIn ?? ValueNotifier<String?>(me);
    final host = SwarmHost(
      accountId: () => account.value,
      account: account,
      request: fake.request,
      upload: refuseSwarmUpload,
      notices: SilentSystemNotices(),
      features: features,
      readMarks: MemoryKeyValueStore(),
    )..foreground = false;
    addTearDown(host.dispose);
    await tester.pumpWidget(
      MaterialApp(
        theme: grid.buildAppTheme(brightness: Brightness.dark),
        builder: (context, child) => SwarmScope(notifier: host, child: child!),
        home: SwarmConversationPage(
          swarmId: tab,
          conversationId: conversation,
          messageId: messageId,
        ),
      ),
    );
    if (settle) {
      await tester.pumpAndSettle();
    } else {
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
    }
    return host;
  }

  bool onScreen(WidgetTester tester, Finder f) {
    if (f.evaluate().isEmpty) return false;
    final view = tester.getRect(list);
    final row = tester.getRect(f);
    return row.top >= view.top && row.bottom <= view.bottom;
  }

  /// The read marks sent for the chat, in order.
  List<Object?> marksSent(FakeSwarm fake) => [
    for (final call in fake.calls)
      if (call.method == 'POST' &&
          call.path == '/api/super-tabs/$tab/conversations/$chat/read')
        call.body?['sequence'],
  ];

  /// Whether the pill showed in each of [frames] frames from now.
  Future<List<bool>> framesOf(WidgetTester tester, {int frames = 40}) async {
    final shown = <bool>[];
    for (var i = 0; i < frames; i++) {
      await tester.pump(const Duration(milliseconds: 16));
      shown.add(pill.evaluate().isNotEmpty);
    }
    return shown;
  }

  /// The chat opened from a notice at a message well below the line.
  Future<SwarmHost> openBelowLine(
    WidgetTester tester,
    FakeSwarm fake, {
    ValueNotifier<String?>? signedIn,
  }) async {
    final host = await pump(
      tester,
      fake,
      messageId: 'msg-25',
      signedIn: signedIn,
    );
    expect(onScreen(tester, find.text('Update 25.')), isTrue);
    expect(onScreen(tester, line), isFalse);
    return host;
  }

  const refused = SuperTabFailure(
    'FORBIDDEN',
    'You cannot read this Swarm.',
    statusCode: 403,
  );

  group('when it shows', () {
    testWidgets('opened at a message below the line, it says so in words at '
        'the top of the list, with a full touch target', (tester) async {
      await openBelowLine(tester, backend(forty(), mark: 5));

      expect(pill, findsOneWidget);
      expect(find.text('Jump to first unread'), findsOneWidget);
      expect(tester.getSemantics(pill).label, 'Jump to first unread');
      expect(tester.getSize(pill).height, greaterThanOrEqualTo(minTouchTarget));
      final view = tester.getRect(list);
      final rect = tester.getRect(pill);
      expect(rect.top - view.top, lessThan(24));
      expect(rect.center.dx, moreOrLessEquals(view.center.dx));
    });

    testWidgets('opening at the line never shows it, on the way or after', (
      tester,
    ) async {
      await pump(tester, backend(forty(), mark: 5), settle: false);
      expect(await framesOf(tester), everyElement(isFalse));
      await tester.pumpAndSettle();

      expect(onScreen(tester, line), isTrue);
      expect(pill, findsNothing);
    });

    testWidgets('a line on screen as the chat opens counts as seen: pushed '
        'above by what comes later, it is not offered', (tester) async {
      final fake = backend(forty(), mark: 38);
      final host = await pump(tester, fake);
      expect(onScreen(tester, line), isTrue);
      expect(pill, findsNothing);

      fake.routes[messages] = (_) => {
        'messages': [for (var i = 70; i >= 1; i--) said(i)],
        'next': null,
      };
      fake.routes['/api/super-tabs/$tab/changes'] = (_) => changes(
        cursor: 'c3',
        groups: [
          part(
            chat,
            9,
            buddyChatData(
              chat,
              agentIds: ['agent-wren'],
              lastMessageSequence: 70,
            ),
          ),
        ],
      );
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 70.')), isTrue);
      expect(onScreen(tester, line), isFalse);
      expect(pill, findsNothing);
    });

    testWidgets('a chat with no line has none, however far back', (
      tester,
    ) async {
      await pump(tester, backend(forty(), mark: 40));
      expect(line, findsNothing);

      await tester.drag(list, const Offset(0, 1500));
      await tester.pumpAndSettle();
      expect(latest, findsOneWidget);
      expect(pill, findsNothing);
    });

    testWidgets('a line below the view is not offered', (tester) async {
      await pump(tester, backend(forty(), mark: 30), messageId: 'msg-5');

      expect(onScreen(tester, find.text('Update 5.')), isTrue);
      expect(onScreen(tester, line), isFalse);
      expect(pill, findsNothing);
    });

    testWidgets('Jump to latest past a line never seen does not count as '
        'seeing it: it is then above, and offered', (tester) async {
      await pump(tester, backend(forty(), mark: 30), messageId: 'msg-20');
      expect(pill, findsNothing);
      expect(latest, findsOneWidget);

      await tester.tap(latest);
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(pill, findsOneWidget);
    });

    testWidgets('a work chat has none', (tester) async {
      await pump(
        tester,
        backend(forty(), mark: 40),
        conversation: 'g1',
        messageId: 'msg-20',
      );
      expect(onScreen(tester, find.text('Update 20.')), isTrue);
      expect(pill, findsNothing);
    });
  });

  group('a tap', () {
    testWidgets('lands on the line, and it goes for the rest of the visit', (
      tester,
    ) async {
      await openBelowLine(tester, backend(forty(), mark: 5));

      await tester.tap(pill);
      await tester.pumpAndSettle();

      expect(onScreen(tester, line), isTrue);
      expect(onScreen(tester, find.text('Update 6.')), isTrue);
      expect(pill, findsNothing);

      await tester.fling(list, const Offset(0, -6000), 4000);
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(pill, findsNothing, reason: 'the line has been seen');
    });

    testWidgets('moves nothing that was read: no mark goes past what the '
        'chat had shown', (tester) async {
      final fake = backend(forty(), mark: 5);
      await openBelowLine(tester, fake);

      await tester.tap(pill);
      await tester.pumpAndSettle();
      await tester.pump(const Duration(seconds: 5));

      expect(marksSent(fake), everyElement(lessThanOrEqualTo(25)));
    });

    testWidgets('lands from the foot too, far above any row built', (
      tester,
    ) async {
      await pump(tester, backend(forty(), mark: 5), messageId: 'msg-25');
      await tester.fling(list, const Offset(0, -6000), 4000);
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Update 40.')), isTrue);
      expect(pill, findsOneWidget);

      await tester.tap(pill);
      await tester.pumpAndSettle();

      expect(onScreen(tester, line), isTrue);
      expect(pill, findsNothing);
    });
  });

  group('while a jump lands', () {
    testWidgets('its own tap keeps it steady until the line has landed: it '
        'goes once, never back', (tester) async {
      await openBelowLine(tester, backend(forty(), mark: 5));

      await tester.tap(pill);
      final shown = await framesOf(tester);
      expect(shown.first, isTrue, reason: 'still there as the jump starts');
      expect(shown.last, isFalse);
      expect(
        shown.skipWhile((s) => s),
        everyElement(isFalse),
        reason: 'no flicker: $shown',
      );
    });

    testWidgets('a quote followed in a chat showing it keeps it steady in '
        'every frame, and after', (tester) async {
      final page = forty();
      page[24] = said(25, replyTo: 'msg-12');
      await openBelowLine(tester, backend(page, mark: 5));
      expect(pill, findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('swarm-quote-msg-25')));
      final shown = await framesOf(tester);

      expect(shown, everyElement(isTrue));
      await tester.pumpAndSettle();
      expect(onScreen(tester, find.text('Update 12.')), isTrue);
      expect(pill, findsOneWidget);
    });

    testWidgets('a quote passing the line on its way does not count as seeing '
        'it', (tester) async {
      final page = forty();
      page[24] = said(25, replyTo: 'msg-2');
      await openBelowLine(tester, backend(page, mark: 10));
      expect(pill, findsOneWidget);

      await tester.tap(find.byKey(const ValueKey('swarm-quote-msg-25')));
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 2.')), isTrue);
      expect(onScreen(tester, line), isFalse);
      expect(pill, findsNothing, reason: 'the line is below now');

      // Back at the foot the line, never seen, is above again.
      await tester.tap(latest);
      await tester.pumpAndSettle();
      expect(pill, findsOneWidget);
    });

    testWidgets('a quote that cannot be read back ends the landing: no '
        'Finding left, and the line is still measured', (tester) async {
      final fake = backend(forty(), mark: 12, older: true);
      final page = forty();
      page[24] = said(25, replyTo: 'msg-gone');
      final first = fake.routes[messages]!;
      fake.routes[messages] = (body) => {
        ...(first(body)! as Map<String, dynamic>),
        'messages': page.reversed.toList(),
      };
      await pump(tester, fake, messageId: 'msg-25');
      expect(pill, findsOneWidget);

      fake.routes[messages] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Messages are down.');
      await tester.tap(find.byKey(const ValueKey('swarm-quote-msg-25')));
      await tester.pumpAndSettle();

      expect(find.textContaining('Finding the original'), findsNothing);
      expect(pill, findsOneWidget);

      // No landing left open: read up to the line, and it is seen.
      fake.routes[messages] = first;
      var steps = 0;
      while (!onScreen(tester, line) && steps++ < 40) {
        await tester.drag(list, const Offset(0, 120));
        await tester.pumpAndSettle();
      }
      expect(onScreen(tester, line), isTrue);
      expect(pill, findsNothing);
    });
  });

  group('seen by reading', () {
    testWidgets('scrolled up to, it goes and does not come back', (
      tester,
    ) async {
      await openBelowLine(tester, backend(forty(), mark: 12));
      expect(pill, findsOneWidget);

      var steps = 0;
      while (!onScreen(tester, line) && steps++ < 40) {
        await tester.drag(list, const Offset(0, 120));
        await tester.pumpAndSettle();
      }
      expect(onScreen(tester, line), isTrue);
      expect(pill, findsNothing);

      await tester.fling(list, const Offset(0, -6000), 4000);
      await tester.pumpAndSettle();
      expect(onScreen(tester, line), isFalse);
      expect(pill, findsNothing);
    });
  });

  group('its privacy edges', () {
    testWidgets('access taken away while it shows: it goes with the messages', (
      tester,
    ) async {
      final fake = backend(forty(), mark: 5);
      final host = await pump(tester, fake, messageId: 'msg-25');
      expect(pill, findsOneWidget);

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();

      expect(pill, findsNothing);
      expect(line, findsNothing);
      expect(find.text('Update 25.'), findsNothing);
    });

    testWidgets('access taken away as a tap lands: nothing comes back', (
      tester,
    ) async {
      final fake = backend(forty(), mark: 5);
      final host = await pump(tester, fake, messageId: 'msg-25');

      fake.routes['/api/super-tabs/$tab/changes'] = (_) => throw refused;
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => throw refused;
      await tester.tap(pill);
      unawaited(host.session!.inbox.reader(tab)!.refresh());
      await tester.pumpAndSettle();

      expect(pill, findsNothing);
      expect(line, findsNothing);
      expect(find.text('Update 6.'), findsNothing);
    });

    testWidgets('signing out takes it away, and a new session starts with '
        'nothing kept of the old one', (tester) async {
      final signedIn = ValueNotifier<String?>(me);
      final fake = backend(forty(), mark: 40);
      final page = forty();
      fake.routes['/api/super-tabs/$tab/parts'] = (_) => {
        ...firstLoad(
          groups: [
            buddyChatData(
              chat,
              agentIds: ['agent-wren'],
              lastMessageSequence: 40,
            ),
          ],
          agents: [buddyData('agent-wren', displayName: 'Wren')],
          derived: {
            'readMarks': {chat: signedIn.value == me ? 5 : 40},
          },
        ),
        'members': [part(me, 1, person(me))],
      };
      fake.routes[messages] = (_) => {
        'messages': page.reversed.toList(),
        'next': null,
      };
      final host = await pump(
        tester,
        fake,
        messageId: 'msg-25',
        signedIn: signedIn,
      );
      expect(pill, findsOneWidget);

      signedIn.value = null;
      await tester.pump();
      expect(pill, findsNothing);

      // Back as someone whose mark is at the end: no line, so no pill.
      host.foreground = true;
      signedIn.value = 'person-other';
      await tester.pumpAndSettle();
      host.foreground = false;
      expect(pill, findsNothing);
    });

    testWidgets('a read left behind by a sign-out does not offer it in the '
        'chat that replaced it', (tester) async {
      final fake = backend(forty(), mark: 5);
      final asked = <Completer<Object?>>[];
      final page = fake.routes[messages]!;
      fake.routes[messages] = (body) {
        asked.add(Completer<Object?>());
        return asked.last.future;
      };
      final signedIn = ValueNotifier<String?>(me);
      final host = await pump(
        tester,
        fake,
        settle: false,
        messageId: 'msg-25',
        signedIn: signedIn,
      );
      expect(asked, hasLength(1));

      signedIn.value = null;
      await tester.pump();
      host.foreground = true;
      signedIn.value = me;
      for (var i = 0; i < 10; i++) {
        await tester.pump(const Duration(milliseconds: 50));
      }
      host.foreground = false;
      expect(asked, hasLength(2));

      asked[0].complete(page(null));
      await tester.pump(const Duration(milliseconds: 50));
      expect(pill, findsNothing, reason: "the old chat's read is dropped");
      expect(line, findsNothing);

      asked[1].complete(page(null));
      await tester.pumpAndSettle();
      expect(pill, findsOneWidget, reason: "the new chat's own read");
    });
  });

  group('a first read that fails, then recovers', () {
    testWidgets('still places the line, with nothing read meanwhile, and the '
        'chat opens at it', (tester) async {
      final fake = backend(forty(), mark: 5);
      final answer = fake.routes[messages]!;
      fake.routes[messages] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Messages are down.');
      final host = await pump(tester, fake);
      expect(find.text('Messages are down.'), findsOneWidget);
      expect(find.byKey(const ValueKey('swarm-chat-skeleton')), findsNothing);
      expect(line, findsNothing);

      fake.routes[messages] = answer;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(onScreen(tester, line), isTrue, reason: 'opened at the line');
      expect(pill, findsNothing);
      expect(
        marksSent(fake).where((s) => (s! as int) > 5),
        isEmpty,
        reason: 'nothing past the line is read',
      );
    });

    testWidgets('still offers the way back in a chat a notice opened', (
      tester,
    ) async {
      final fake = backend(forty(), mark: 5);
      final answer = fake.routes[messages]!;
      fake.routes[messages] = (_) =>
          throw const SuperTabFailure('INTERNAL', 'Messages are down.');
      final host = await pump(tester, fake, messageId: 'msg-25');
      expect(pill, findsNothing);

      fake.routes[messages] = answer;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(onScreen(tester, find.text('Update 25.')), isTrue);
      expect(pill, findsOneWidget);
      await tester.tap(pill);
      await tester.pumpAndSettle();
      expect(onScreen(tester, line), isTrue);
      expect(pill, findsNothing);
    });

    testWidgets('a refused first read that comes back places it too', (
      tester,
    ) async {
      final fake = backend(forty(), mark: 5);
      final answer = fake.routes[messages]!;
      fake.routes[messages] = (_) => throw refused;
      final host = await pump(tester, fake);
      expect(line, findsNothing);
      expect(marksSent(fake), isEmpty);

      fake.routes[messages] = answer;
      await host.session!.inbox.reader(tab)!.refresh();
      await tester.pumpAndSettle();

      expect(find.text('You cannot read this Swarm.'), findsNothing);
      expect(onScreen(tester, line), isTrue);
    });
  });

  group('with Jump to latest, on a small phone', () {
    /// Both pills up on a 320-wide phone, [keyboard] points of it covered.
    Future<void> bothShowing(WidgetTester tester, {double keyboard = 0}) async {
      await tester.binding.setSurfaceSize(const Size(320, 568));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      tester.view.viewInsets = FakeViewPadding(bottom: keyboard * 3);
      addTearDown(tester.view.resetViewInsets);
      await openBelowLine(tester, backend(forty(), mark: 5));
      expect(pill, findsOneWidget);
      expect(latest, findsOneWidget);
    }

    Future<void> expectClear(WidgetTester tester) async {
      final top = tester.getRect(pill);
      final bottom = tester.getRect(latest);
      final view = tester.getRect(list);
      final composer = tester.getRect(find.byType(TextField));
      expect(top.overlaps(bottom), isFalse, reason: '$top over $bottom');
      expect(bottom.bottom, lessThanOrEqualTo(composer.top));
      expect(top.bottom, lessThanOrEqualTo(composer.top));
      expect(top.left, greaterThanOrEqualTo(view.left));
      expect(top.right, lessThanOrEqualTo(view.right));
      expect(onScreen(tester, line), isFalse, reason: 'above the view');
      expect(tester.takeException(), isNull);
    }

    testWidgets('neither overlaps the other, the composer or the line', (
      tester,
    ) async {
      await bothShowing(tester);
      await expectClear(tester);
    });

    testWidgets('nor with the keyboard up', (tester) async {
      await bothShowing(tester, keyboard: 216);
      await expectClear(tester);
    });

    testWidgets('the pair look alike: the same capsule and the same type', (
      tester,
    ) async {
      await bothShowing(tester);
      Container capsule(Finder of) => tester.widget<Container>(
        find.descendant(of: of, matching: find.byType(Container)).first,
      );
      Text words(Finder of) => tester.widget<Text>(
        find.descendant(of: of, matching: find.byType(Text)),
      );
      expect(capsule(pill).decoration, capsule(latest).decoration);
      expect(words(pill).style, words(latest).style);
      expect(tester.getSize(pill).height, tester.getSize(latest).height);
    });

    testWidgets('its words fit at twice the text size, or end short', (
      tester,
    ) async {
      tester.platformDispatcher.textScaleFactorTestValue = 2;
      addTearDown(tester.platformDispatcher.clearTextScaleFactorTestValue);
      await bothShowing(tester);
      expect(tester.takeException(), isNull);
      final rect = tester.getRect(pill);
      expect(rect.right, lessThanOrEqualTo(320));
      expect(rect.left, greaterThanOrEqualTo(0));
    });
  });
}
