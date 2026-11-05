import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/activity.dart';
import 'package:harness/super_tabs/places.dart';

import 'super_tab_activity_lists_test.dart'
    show load, swarm, unreadThread, wait;
import 'support/super_tab_fixture.dart';

Map<String, dynamic> _group(ConversationServer server, String id) =>
    (server.state['conversations'] as List)
        .cast<Map<String, dynamic>>()
        .firstWhere((g) => g['id'] == id);

void main() {
  group('the sidebar\'s counts (task #2996)', () {
    test('Decisions counts decisions, agents waiting and due reminders; '
        'Mentions the unread tags; Threads the threads with unread '
        'replies', () async {
      final server = swarm();
      server.ask(['Ship it?']);
      wait(server);
      server.tag('message-1');
      server.followedThreads = {
        'unread': [
          unreadThread('message-1'),
          {...unreadThread('message-2'), 'conversationId': 'lead'},
        ],
        'read': [],
        'more': false,
      };
      final activity = await load(server);
      expect(activity.needsCount, 2);
      expect(activity.mentionsCount, 1);
      expect(activity.threadsCount, 2);
    });

    test(
      'Mentions stands on the server\'s count until the tags are read',
      () async {
        final server = swarm()..state['mentionsWaiting'] = 4;
        final c = server.controller(account: 'owner');
        addTearDown(() async {
          await c.flush();
          c.dispose();
        });
        await c.refresh();
        expect(SuperTabActivity.of(c).mentionsCount, 4);
      },
    );
  });

  group('a typed answer on the Decisions page', () {
    test('a decision answered in words sends its note and no option, and '
        'leaves the list', () async {
      final server = swarm();
      server.ask(['Which machine runs the phone tests?']);
      final activity = await load(server);
      final decision = activity.decisions.open.single;
      expect(
        await activity.decisions.answerInWords(
          decision,
          ' Use the Mac Studio ',
        ),
        isTrue,
      );
      final sent = server.posts
          .map((p) => p['command'] as Map)
          .lastWhere((c) => c['type'] == 'decision.answer');
      expect(sent['note'], 'Use the Mac Studio');
      expect(sent.containsKey('choice'), isFalse);
      expect(activity.decisions.open, isEmpty);
      expect(server.decisions.single['note'], 'Use the Mac Studio');
    });

    test('a server before typed answers refuses it: the decision stays open '
        'and says so, and an option still answers it', () async {
      final server = swarm()
        ..unknownCommand = (c) =>
            c['type'] == 'decision.answer' &&
            c['choice'] == null &&
            c['delegate'] == null;
      server.ask(['Ship it?']);
      final activity = await load(server);
      final decision = activity.decisions.open.single;
      expect(
        await activity.decisions.answerInWords(decision, 'Next week'),
        isFalse,
      );
      expect(activity.decisions.refusedWords(decision), isTrue);
      expect(activity.decisions.open.single.id, decision.id);
      expect(await activity.decisions.answer(decision, 0), isTrue);
      expect(activity.decisions.refusedWords(decision), isFalse);
    });

    test('an agent waiting answered in words gets the words in its task, '
        'addressed to it, and leaves until it asks again', () async {
      final server = swarm();
      wait(server);
      _group(server, 'offline')['assignment']['result'] = 'Okay to turn it on?';
      final activity = await load(server);
      final need = activity.needsYou.single;
      expect(await activity.answerWaiting(need, ' Yes, go '), isTrue);
      final sent = server.posts
          .map((p) => p['command'] as Map)
          .lastWhere((c) => c['type'] == 'message.send');
      expect(sent['conversationId'], 'offline');
      expect(sent['text'], 'Yes, go');
      expect(sent['recipientIds'], ['kestrel']);
      expect(activity.needsYou, isEmpty);
      expect(activity.needsCount, 0);

      _group(server, 'offline')['assignment']['result'] = 'And the other one?';
      server.revision++;
      await activity.controller.refresh();
      expect(activity.needsYou.single.question, 'And the other one?');
    });
  });

  group('places (back and forward)', () {
    late ConversationServer server;
    late SuperTabPlaces places;

    setUp(() async {
      server = swarm();
      final activity = await load(server);
      places = SuperTabPlaces.of(activity.controller);
    });

    const threads = SuperTabPlace.page(SwarmPage.threads);
    const chat = SuperTabPlace.chat('lead');
    const thread = SuperTabPlace.chat('offline', root: 'message-1');

    test('back and forward step through the places recorded', () {
      places
        ..record(threads)
        ..record(thread)
        ..record(thread);
      expect(places.canGoBack, isTrue);
      expect(places.canGoForward, isFalse);
      places.step(-1);
      expect(places.takeStep(), threads);
      expect(places.takeStep(), isNull);
      // Arriving there records the same place: the trail stays.
      places.record(threads);
      expect(places.canGoForward, isTrue);
      places.step(1);
      expect(places.takeStep(), thread);
    });

    test('a new place after going back drops the forward trail', () {
      places
        ..record(threads)
        ..record(thread)
        ..step(-1);
      places.takeStep();
      places.record(chat);
      expect(places.canGoForward, isFalse);
      places.step(-1);
      expect(places.takeStep(), threads);
    });

    test('a place whose chat is gone is skipped', () {
      places
        ..record(chat)
        ..record(thread)
        ..record(threads);
      (server.state['conversations'] as List).removeWhere(
        (g) => (g as Map)['id'] == 'offline',
      );
      server.revision++;
      return places.controller.refresh().then((_) {
        places.step(-1);
        expect(places.takeStep(), chat);
      });
    });

    test('keeps at most 64 places', () {
      for (var i = 0; i < 70; i++) {
        places.record(i.isEven ? threads : chat);
      }
      var back = 0;
      while (places.canGoBack) {
        places.step(-1);
        places.takeStep();
        back++;
      }
      expect(back, SuperTabPlaces.capacity - 1);
    });
  });
}
