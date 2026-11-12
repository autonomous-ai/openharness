import 'dart:async';

import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/swarm/swarm_chat_notify.dart';
import 'package:harness_mobile/swarm/swarm_read_marks.dart';
import 'package:harness_mobile/swarm/swarm_reader.dart';
import 'package:harness_mobile/swarm/swarm_request.dart';

import 'swarm_fixture.dart';

/// Each person's notification setting per chat (the desktop's #2453, Slack's
/// channel notifications): All new messages, Mentions only (the default) or
/// Muted, set from the phone through the desktop's own call, and followed at
/// once by every count on the phone.
void main() {
  const notifications = '/api/super-tabs/$tab/conversations/g1/notifications';

  /// Swarm [tab] with work g1 and g2, read once: [settings] are the reader's
  /// own settings. Its next change read answers [next] (the
  /// settings it carries, by chat), and moves g1 on to [g1Sequence].
  late Map<String, dynamic> next;
  Future<({FakeSwarm swarm, SwarmReader reader})> rig({
    Map<String, String> settings = const {},
  }) async {
    final swarm = FakeSwarm();
    next = {};
    final derived = {if (settings.isNotEmpty) 'chatSettings': settings};
    swarm.routes['/api/super-tabs/$tab/parts'] = (_) => firstLoad(
      groups: [
        groupData('g1', title: 'Fix login', lastMessageSequence: 3),
        groupData('g2', title: 'Ship it', lastMessageSequence: 1),
      ],
      derived: derived,
    );
    swarm.routes['/api/super-tabs/$tab/changes'] = (_) =>
        changes(cursor: 'c2', derived: {...derived, 'chatSettings': next});
    final reader = SwarmReader(
      tabId: tab,
      accountId: me,
      request: swarm.request,
    );
    final marks = reader.readMarks = SwarmReadMarks(reader, store: null);
    addTearDown(() {
      marks.dispose();
      reader.dispose();
    });
    await reader.refresh();
    await settle();
    return (swarm: swarm, reader: reader);
  }

  /// The setting route answers each choice when the test completes it.
  List<({Map<String, dynamic> body, Completer<Object?> answer})> hold(
    FakeSwarm swarm, {
    String chat = 'g1',
  }) {
    final held = <({Map<String, dynamic> body, Completer<Object?> answer})>[];
    swarm.routes['/api/super-tabs/$tab/conversations/$chat/notifications'] =
        (body) {
          final answer = Completer<Object?>();
          held.add((body: body!, answer: answer));
          return answer.future;
        };
    return held;
  }

  group('the setting', () {
    test('is Mentions only until the server says otherwise; its word for '
        'each, and nothing it does not know', () async {
      final r = await rig(settings: {'g2': 'all'});

      expect(r.reader.notifyOf('g1'), SwarmNotify.mentions);
      expect(r.reader.notifyOf('g2'), SwarmNotify.all);
      expect(SwarmNotify.parse('loud'), SwarmNotify.mentions);
      expect(
        [for (final n in SwarmNotify.values) n.label],
        ['All new messages', 'Mentions only', 'Muted'],
      );
    });

    test('a choice shows at once and is sent through the desktop\'s call; '
        'kept, it stays until a read carries it', () async {
      final r = await rig();
      final held = hold(r.swarm);

      final saved = r.reader.setNotify('g1', SwarmNotify.muted);
      expect(r.reader.notifyOf('g1'), SwarmNotify.muted);
      expect(r.swarm.calls.last.method, 'POST');
      expect(r.swarm.calls.last.path, notifications);
      expect(held.single.body, {'notify': 'muted'});

      held.single.answer.complete({'notify': 'muted'});
      expect(await saved, isTrue);
      expect(
        r.reader.snapshot!.chatSettings['g1'],
        isNull,
        reason: 'no read since',
      );
      expect(r.reader.notifyOf('g1'), SwarmNotify.muted);

      next = {'g1': 'muted'};
      await r.reader.refresh();
      expect(r.reader.notifyOf('g1'), SwarmNotify.muted);
      // Changed on the desktop since: the read's word now.
      next = {'g1': 'all'};
      await r.reader.refresh();
      expect(r.reader.notifyOf('g1'), SwarmNotify.all);
    });

    test('a read begun before the answer does not flick it back', () async {
      final r = await rig();
      final held = hold(r.swarm);
      final gate = Completer<void>();
      r.swarm.routes['/api/super-tabs/$tab/changes'] = (_) async {
        await gate.future;
        return changes(cursor: 'c2');
      };

      final reading = r.reader.refresh();
      final saved = r.reader.setNotify('g1', SwarmNotify.all);
      held.single.answer.complete({'notify': 'all'});
      expect(await saved, isTrue);
      gate.complete();
      await reading;

      expect(r.reader.notifyOf('g1'), SwarmNotify.all);
    });

    test('refused, or not answered as asked: the old setting is back, and it '
        'says so', () async {
      final r = await rig(settings: {'g1': 'all'});
      final held = hold(r.swarm);

      final refused = r.reader.setNotify('g1', SwarmNotify.muted);
      held.single.answer.completeError(
        const SuperTabFailure('CHAT_SETTING_BUSY', 'Busy', statusCode: 503),
      );
      expect(await refused, isFalse);
      expect(r.reader.notifyOf('g1'), SwarmNotify.all);

      final odd = r.reader.setNotify('g1', SwarmNotify.muted);
      held.last.answer.complete({'notify': 'mentions'});
      expect(await odd, isFalse);
      expect(r.reader.notifyOf('g1'), SwarmNotify.all);
    });

    test('a later choice for the same chat wins over one still on its way, '
        'whichever answers first', () async {
      final r = await rig();
      final held = hold(r.swarm);

      final first = r.reader.setNotify('g1', SwarmNotify.muted);
      final second = r.reader.setNotify('g1', SwarmNotify.all);
      held[1].answer.complete({'notify': 'all'});
      expect(await second, isTrue);
      held[0].answer.completeError(Exception('lost'));
      expect(await first, isTrue, reason: 'nothing to say: overtaken');

      expect(r.reader.notifyOf('g1'), SwarmNotify.all);
    });

    test('choices for two chats at once each settle on their own', () async {
      final r = await rig();
      final one = hold(r.swarm);
      final two = hold(r.swarm, chat: 'g2');

      final g1 = r.reader.setNotify('g1', SwarmNotify.muted);
      final g2 = r.reader.setNotify('g2', SwarmNotify.all);
      two.single.answer.complete({'notify': 'all'});
      expect(await g2, isTrue);
      one.single.answer.completeError(Exception('lost'));
      expect(await g1, isFalse);

      expect(r.reader.notifyOf('g1'), SwarmNotify.mentions);
      expect(r.reader.notifyOf('g2'), SwarmNotify.all);
    });

    test('access lost while a choice is on its way: nothing of it stays, '
        'and its answer changes nothing', () async {
      final r = await rig();
      final held = hold(r.swarm);
      final saved = r.reader.setNotify('g1', SwarmNotify.muted);

      r.reader.revoke();
      expect(r.reader.notifyOf('g1'), SwarmNotify.mentions);
      var told = 0;
      r.reader.addListener(() => told++);
      held.single.answer.complete({'notify': 'muted'});

      expect(await saved, isTrue, reason: 'no error once access is gone');
      expect(r.reader.notifyOf('g1'), SwarmNotify.mentions);
      expect(told, 0);
    });

    test(
      'a chat the reader does not read — another project\'s, a private '
      'or Buddy chat not theirs, or none — is refused alike, unasked',
      () async {
        final r = await rig();
        final before = r.swarm.calls.length;

        for (final id in ['other-project-chat', 'buddy-ann', '']) {
          expect(await r.reader.setNotify(id, SwarmNotify.muted), isFalse);
          expect(r.reader.notifyOf(id), SwarmNotify.mentions);
        }
        expect(r.swarm.calls, hasLength(before));
      },
    );

    test(
      'a first read that failed and later recovers can still set it',
      () async {
        final swarm = FakeSwarm();
        var fail = true;
        swarm.routes['/api/super-tabs/$tab/parts'] = (_) {
          if (fail) throw Exception('offline');
          return firstLoad(groups: [groupData('g1')]);
        };
        final reader = SwarmReader(
          tabId: tab,
          accountId: me,
          request: swarm.request,
        );
        addTearDown(reader.dispose);
        await reader.refresh();
        expect(await reader.setNotify('g1', SwarmNotify.muted), isFalse);
        expect(reader.loading, isFalse, reason: 'no stuck Loading');

        fail = false;
        await reader.refresh();
        final held = hold(swarm);
        final saved = reader.setNotify('g1', SwarmNotify.muted);
        held.single.answer.complete({'notify': 'muted'});
        expect(await saved, isTrue);
        expect(reader.notifyOf('g1'), SwarmNotify.muted);
      },
    );

    test('a chat id reused in another Swarm keeps its own setting', () async {
      final r = await rig(settings: {'g1': 'muted'});
      final swarm = FakeSwarm();
      swarm.routes['/api/super-tabs/tab-2/parts'] = (_) =>
          firstLoad(tabId: 'tab-2', groups: [groupData('g1')]);
      final other = SwarmReader(
        tabId: 'tab-2',
        accountId: me,
        request: swarm.request,
      );
      addTearDown(other.dispose);
      await other.refresh();

      expect(r.reader.notifyOf('g1'), SwarmNotify.muted);
      expect(other.notifyOf('g1'), SwarmNotify.mentions);
    });
  });
}
