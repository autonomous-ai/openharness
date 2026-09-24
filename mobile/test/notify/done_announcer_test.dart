import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';

import 'package:harness_mobile/core/last_opened_agent.dart';
import 'package:harness_mobile/notify/done_announcer.dart';
import 'package:harness_mobile/notify/done_notice.dart';
import 'package:harness_mobile/notify/system_notices.dart';

class _RecordingNotices implements SystemNotices {
  final shown = <DoneNoticeMessage>[];

  @override
  final opened = ValueNotifier<AgentRef?>(null);

  @override
  Future<void> requestPermission() async {}

  @override
  Future<void> show(DoneNoticeMessage message) async => shown.add(message);
}

void main() {
  const ref = (machineId: 'm', agentId: 'a');
  const agent = (ref: ref, name: 'Fix login', machine: 'MacBook');
  const news = (
    aborted: false,
    replay: false,
    subagent: false,
    reply: 'Looked at the form.\n\nFixed the login screen and pushed.',
  );

  late _RecordingNotices system;
  late int chimes;
  late bool front;
  late DoneAnnouncer announcer;

  setUp(() {
    system = _RecordingNotices();
    chimes = 0;
    front = true;
    announcer = DoneAnnouncer(
      system: system,
      chime: () async => chimes++,
      inFront: () => front,
    );
    addTearDown(announcer.dispose);
  });

  test('watching: a chime, no mark, no notice', () {
    final notice = announcer.turnEnded(agent, news, watching: () => true);

    expect(notice, DoneNotice.chime);
    expect(chimes, 1);
    expect(announcer.unread.count, 0);
    expect(system.shown, isEmpty);
  });

  test('elsewhere in the app: a chime and a mark, no notice', () {
    announcer.turnEnded(agent, news, watching: () => false);

    expect(chimes, 1);
    expect(announcer.unread.contains(ref), isTrue);
    expect(system.shown, isEmpty);
  });

  test(
    'away: a mark and one notice naming the agent, its machine, its news',
    () {
      front = false;
      announcer.turnEnded(agent, news, watching: () => true);

      expect(chimes, 0, reason: 'nobody is holding a backgrounded app');
      expect(announcer.unread.contains(ref), isTrue);
      expect(system.shown, hasLength(1));
      final shown = system.shown.single;
      expect(shown.agent, ref);
      expect(shown.title, 'Fix login');
      expect(shown.machine, 'MacBook');
      expect(shown.body, 'Fixed the login screen and pushed.');
    },
  );

  test('a sub-agent turn does nothing at all, even away', () {
    front = false;
    announcer.turnEnded(agent, (
      aborted: false,
      replay: false,
      subagent: true,
      reply: 'x',
    ), watching: () => false);

    expect(chimes, 0);
    expect(announcer.unread.count, 0);
    expect(system.shown, isEmpty);
  });

  test('an agent is one mark however many turns it finished', () {
    announcer.turnEnded(agent, news, watching: () => false);
    announcer.turnEnded(agent, news, watching: () => false);

    expect(announcer.unread.count, 1);
    announcer.unread.clear(ref);
    expect(announcer.unread.count, 0);
  });

  group('noticeBody', () {
    test('keeps the last paragraph, on one line', () {
      expect(noticeBody('a\n\nb  c\nd'), 'b c d');
    });

    test('cuts a long reply with an ellipsis', () {
      final body = noticeBody('x' * 400, limit: 20);
      expect(body.length, 20);
      expect(body.endsWith('…'), isTrue);
    });
  });
}
