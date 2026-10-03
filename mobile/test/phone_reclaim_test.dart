import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/terminal/terminal_session.dart';

TerminalSession _session(TerminalSessionStatus status) => TerminalSession(
  machineId: 'm',
  agentId: 'a',
  agentName: 'Agent',
  engineId: 'codex',
  send: (_, _) async => true,
  sendBinary: (_) async => true,
)..status = status;

/// Who took a terminal, and who holds one this phone only watches — as the session reads them off
/// the daemon's frames.
void main() {
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

    test('the taker is named when the daemon said', () {
      final session = taken(
        takenBy: {
          'kind': 'desktop',
          'name': 'Mac mini',
          'machineId': 'ab12ab12ab12ab12',
        },
      );
      expect(session.status, TerminalSessionStatus.takenOver);
      expect(session.takenOverBy?.label((_) => null), 'Mac mini');
      expect(session.errorMessage, 'Mac mini connected to this terminal.');
      // The fleet's current name for that machine wins over the declared one.
      expect(
        session.takenOverBy?.label(
          (id) => id == 'ab12ab12ab12ab12' ? 'Studio' : null,
        ),
        'Studio',
      );
    });

    test('an older daemon, or a nameless taker, reads as another client', () {
      final session = taken();
      expect(session.status, TerminalSessionStatus.takenOver);
      expect(session.takenOverBy, isNull);
      expect(
        session.errorMessage,
        'Another client connected to this terminal.',
      );
      expect(
        taken(takenBy: {'kind': 'not a kind', 'name': 'x'}).takenOverBy,
        isNull,
      );
    });

    group('who is driving a terminal this phone only watches', () {
      /// Opened politely onto a terminal somebody else holds: the daemon's
      /// ready says `readOnly`, and — from a daemon new enough — who holds it.
      Future<TerminalSession> watching({Map<String, dynamic>? heldBy}) async {
        final sent = <Map<String, dynamic>>[];
        final session = TerminalSession(
          machineId: 'm',
          agentId: 'a',
          agentName: 'Agent',
          engineId: 'codex',
          send: (_, payload) async {
            sent.add(payload);
            return true;
          },
          sendBinary: (_) async => true,
        );
        addTearDown(session.dispose);
        await session.open(initialCols: 100, initialRows: 30);
        await session.handleFrame('terminal_ready', {
          'requestId': sent.single['requestId'],
          'protocolVersion': 3,
          'streamId': 's',
          'agentId': 'a',
          'readOnly': true,
          'heldBy': ?heldBy,
        });
        return session;
      }

      test('the holder is named, as the desktop names it', () async {
        final session = await watching(
          heldBy: {
            'kind': 'desktop',
            'name': 'MacBookPro2021.local',
            'machineId': 'ab12ab12ab12ab12',
          },
        );
        expect(session.watching, isTrue);
        expect(session.heldBy?.label((_) => null), 'MacBookPro2021.local');
        // The fleet's current name for that machine wins, as it does for a taker.
        expect(
          session.heldBy?.label(
            (id) => id == 'ab12ab12ab12ab12' ? 'Studio' : null,
          ),
          'Studio',
        );
      });

      test('an older daemon names nobody', () async {
        final session = await watching();
        expect(session.watching, isTrue);
        expect(session.heldBy, isNull);
      });
    });
  });
}
