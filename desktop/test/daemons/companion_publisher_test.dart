import 'package:flutter_test/flutter_test.dart';
import 'package:harness/daemons/companion_publisher.dart';

void main() {
  test(
    'coalesces repaint traffic, refreshes on reconnect and clears accounts',
    () {
      var now = DateTime.utc(2026, 9, 28);
      final sent = <Map<String, dynamic>>[];
      final publisher = CompanionPublisher(
        window: 'desktop-a',
        now: () => now,
        send: (p) {
          sent.add(p);
          return true;
        },
      );
      Map<String, dynamic> state(int left) => {
        'enabled': true,
        'phase': 'creature',
        'feeling': {
          'emotion': 'excited',
          'reason': 'merged',
          'intensity': 3,
          'reactionId': 'merge:442',
          'remainingMs': left,
        },
      };
      publisher.publish(state(9000), scope: 'account:a', foreground: true);
      now = now.add(const Duration(seconds: 1));
      publisher.publish(state(8000), scope: 'account:a', foreground: true);
      expect(sent, hasLength(1));
      publisher.publish(
        state(7000),
        scope: 'account:a',
        foreground: true,
        force: true,
      );
      expect(sent.last['revision'], 2);
      expect((sent.last['feeling'] as Map)['remainingMs'], 7000);
      publisher.publish(
        {'enabled': false},
        scope: 'account:b',
        foreground: true,
      );
      expect(sent.last['epoch'], 2);
      expect(sent.last.containsKey('feeling'), isFalse);
      expect(sent.last.containsKey('scope'), isFalse);
    },
  );

  test('a refused send does not suppress the current state on retry', () {
    var ready = false;
    final sent = <Map<String, dynamic>>[];
    final publisher = CompanionPublisher(
      window: 'desktop-a',
      send: (p) {
        if (!ready) return false;
        sent.add(p);
        return true;
      },
    );
    publisher.publish({'enabled': false}, scope: 'account:a', foreground: true);
    ready = true;
    publisher.publish({'enabled': false}, scope: 'account:a', foreground: true);
    expect(sent, hasLength(1));
    expect(sent.single['revision'], 2);
  });
}
