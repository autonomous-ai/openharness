import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';
import 'package:harness_mobile/phone/phone_status.dart';

TerminalSession _session(TerminalSessionStatus status) => TerminalSession(
  machineId: 'm',
  agentId: 'a',
  agentName: 'Agent',
  engineId: 'codex',
  send: (_, _) async => true,
  sendBinary: (_) async => true,
)..status = status;

void main() {
  test('a session nobody else is driving offers nothing to reclaim', () {
    expect(phoneReclaimAction(null), isNull);
    for (final status in [
      TerminalSessionStatus.opening,
      TerminalSessionStatus.resyncing,
      TerminalSessionStatus.controlling,
    ]) {
      expect(
        phoneReclaimAction(_session(status)),
        isNull,
        reason: '$status has nothing to take back',
      );
    }
  });

  test('a taken-over session offers control back', () {
    final action = phoneReclaimAction(
      _session(TerminalSessionStatus.takenOver),
    );

    expect(action?.label, 'Take control');
    expect(action?.tone, PhoneTone.attention);
  });

  test('a dropped session offers a reconnect', () {
    for (final status in [
      TerminalSessionStatus.error,
      TerminalSessionStatus.closed,
    ]) {
      final action = phoneReclaimAction(_session(status));

      expect(action?.label, 'Reconnect', reason: '$status');
      expect(action?.tone, PhoneTone.bad, reason: '$status');
    }
  });

  group('who took control', () {
    TerminalSession taken({Map<String, dynamic>? takenBy}) {
      final session = _session(TerminalSessionStatus.controlling)
        ..streamId = 's';
      session.handleFrame('terminal_closed', {
        'streamId': 's',
        'code': 'TERMINAL_TAKEN_OVER',
        'reason': 'another client connected',
        'takenBy': ?takenBy,
      });
      return session;
    }

    test('the summary and the strip name the taker when the daemon said', () {
      final session = taken(
        takenBy: {
          'kind': 'desktop',
          'name': 'Mac mini',
          'machineId': 'ab12ab12ab12ab12',
        },
      );
      expect(session.status, TerminalSessionStatus.takenOver);
      final name = phoneTakerName(session, (_) => null);
      expect(name, 'Mac mini');
      expect(
        phoneSessionSummary(session, takerName: name).label,
        'Taken over by Mac mini',
      );
      expect(
        phoneTakeoverNotice(session, name),
        'Mac mini took control of this terminal',
      );
      // The fleet's current name for that machine wins over the declared one.
      expect(
        phoneTakerName(
          session,
          (id) => id == 'ab12ab12ab12ab12' ? 'Studio' : null,
        ),
        'Studio',
      );
    });

    test('an older daemon, or a nameless taker, reads as another app', () {
      final session = taken();
      expect(phoneTakerName(session, (_) => null), isNull);
      expect(phoneSessionSummary(session).label, 'Taken over');
      expect(
        phoneTakeoverNotice(session, null),
        'Another app took control of this terminal',
      );
      expect(
        phoneTakerName(
          taken(takenBy: {'kind': 'not a kind', 'name': 'x'}),
          (_) => null,
        ),
        isNull,
      );
    });

    test('nothing to say while this phone drives, or nobody does', () {
      expect(phoneTakeoverNotice(null, null), isNull);
      for (final status in [
        TerminalSessionStatus.controlling,
        TerminalSessionStatus.closed,
        TerminalSessionStatus.error,
      ]) {
        expect(phoneTakeoverNotice(_session(status), 'Mac'), isNull);
        expect(phoneTakerName(_session(status), (_) => 'Mac'), isNull);
      }
    });
  });
}
