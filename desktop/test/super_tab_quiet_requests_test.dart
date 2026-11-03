import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/reading.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

/// Stability roadmap 2.5, the KPI: Desktop requests per person per minute,
/// counted by kind at the transport. One person in six Swarms: one on screen
/// (a message arrives in it every 30 s), two open behind it, three not
/// opened (one holds a tag waiting for them).
///
/// [_before] is what main measured with this same test before the change
/// (1a034eb26, 2026-10-29); each test holds the new count to its share of it.
const _ids = ['t1', 't2', 't3', 't4', 't5', 't6'];
const _window = Duration(minutes: 10);

/// Requests per minute on main, by scenario.
const _before = (pushOn: 19.1, pushOff: 194.1, background: 194.1);

class _Counts {
  final byKind = <String, int>{};
  int get total => byKind.values.fold(0, (a, b) => a + b);
  void add(String kind) => byKind[kind] = (byKind[kind] ?? 0) + 1;
  double perMinute() => total / _window.inMinutes;
  @override
  String toString() =>
      '${perMinute().toStringAsFixed(1)}/min  ${(byKind.keys.toList()..sort()).map((k) => '$k ${(byKind[k]! / _window.inMinutes).toStringAsFixed(1)}').join(', ')}';
}

class _Backend {
  _Backend() {
    for (final id in _ids) {
      servers[id] = ConversationServer()
        ..state['id'] = id
        ..append('Hello');
    }
    // A tag waiting in a Swarm not opened.
    servers['t5']!.tag('message-1');
  }

  final servers = <String, ConversationServer>{};
  final counts = _Counts();
  bool counting = false;

  Future<Object?> call(
    String method,
    String path, {
    Map<String, dynamic>? body,
  }) async {
    final uri = Uri.parse(path);
    if (uri.path == '/api/super-tabs/list') {
      if (counting) counts.add('list');
      final asked = uri.queryParameters['mentions'] == '1';
      return {
        'tabs': [
          for (final id in _ids)
            {
              'id': id,
              'name': id,
              if (asked) ...{
                'mentionsWaiting': servers[id]!.mentions.length,
                'mentionsDigest': 'd${servers[id]!.mentions.length}',
              },
            },
        ],
        'next': null,
      };
    }
    final segments = uri.pathSegments;
    final route = segments[3];
    if (counting) {
      counts.add(
        route == 'parts' || route == 'changes'
            ? 'state'
            : route == 'conversations'
            ? 'messages'
            : route,
      );
    }
    return servers[segments[2]]!.request(method, path, body: body);
  }
}

/// Runs the scenario for [_window] and returns what was asked.
_Counts _measure({required bool pushing, required bool foreground}) {
  final backend = _Backend();
  late final _Counts result;
  fakeAsync((async) {
    final client = SuperTabClient(
      transport: backend.call,
      storage: MemoryStore(),
      onTabs: (_, _) {},
    )..reading = SuperTabReading.desktop;
    client
      ..bind('owner')
      ..show('t1')
      ..pageVisible = foreground;
    for (final id in ['t1', 't2', 't3']) {
      client.open(id);
    }
    void push() {
      if (pushing) client.swarmChanged({});
    }

    push();
    client.refreshTabs();
    async.elapse(const Duration(seconds: 30));
    backend
      ..counts.byKind.clear()
      ..counting = true;
    var elapsed = Duration.zero;
    while (elapsed < _window) {
      async.elapse(const Duration(seconds: 30));
      elapsed += const Duration(seconds: 30);
      backend.servers['t1']!.append('Update ${elapsed.inSeconds}');
      if (pushing) {
        client.swarmChanged({
          'tabId': 't1',
          'parts': ['main'],
        });
      }
      if (elapsed.inSeconds % 240 == 0) push();
    }
    result = backend.counts;
    client.dispose();
  });
  return result;
}

void main() {
  // Pushes are on in production: most of main's polls were already gone, and
  // what is left is the tag reads and the reads that found nothing new.
  test('the server pushes, the app in front: at most 55% of before', () {
    final counts = _measure(pushing: true, foreground: true);
    // ignore: avoid_print
    print('KPI push on, foreground: $counts (before ${_before.pushOn}/min)');
    expect(counts.perMinute(), lessThanOrEqualTo(_before.pushOn * 0.55));
    expect(counts.byKind['mentions'], isNull);
  });

  // The fallback, when a server does not push.
  test('no pushes, the app in front: at most 30% of before', () {
    final counts = _measure(pushing: false, foreground: true);
    // ignore: avoid_print
    print('KPI push off, foreground: $counts (before ${_before.pushOff}/min)');
    expect(counts.perMinute(), lessThanOrEqualTo(_before.pushOff * 0.3));
    expect(counts.byKind['mentions'], isNull);
  });

  test('no pushes, the app in the background: at most 10% of before', () {
    final counts = _measure(pushing: false, foreground: false);
    // ignore: avoid_print
    print(
      'KPI push off, background: $counts (before ${_before.background}/min)',
    );
    expect(counts.perMinute(), lessThanOrEqualTo(_before.background * 0.1));
  });
}
