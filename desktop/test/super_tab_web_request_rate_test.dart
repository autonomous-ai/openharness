// Swarm requests a web client sends per minute, through a machine (before) and
// straight to the backend (docs/specs/2026-10-30-web-swarm-direct.md): the
// baseline for the scale line's first warning, the backend's per-person route
// limit. One Swarm open on screen, with the web's read policy
// (lib/web/shell/web_chrome.dart), over ten simulated minutes.
//
// SUPER_TAB_RATE_OUT=<file> writes the counts there for the pull request.
import 'dart:io';

import 'package:fake_async/fake_async.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/super_tabs/client.dart';
import 'package:harness/super_tabs/reading.dart';

import 'support/super_tab_fixture.dart';
import 'swarm_state_test.dart' show MemoryStore;

const _tab = '0123456789abcdef01234567';
const _minutes = 10;

/// As lib/web/shell/web_chrome.dart sets it.
const _web = SuperTabReading(
  quietPoll: Duration(seconds: 15),
  pausesAway: true,
  readsOnConnect: true,
  connectGrace: Duration(seconds: 10),
  messagesWithState: true,
  drawsSaved: true,
);

/// Requests per minute with one Swarm open. [pushEvery]: the server says the
/// Swarm changed this often (a busy Swarm), or never. [reconnectEvery]: a
/// machine of the person's reconnects this often, which made the relayed web
/// read again at once ([SuperTabClient.serverAvailable]); the direct web
/// ignores machines.
double _perMinute({
  required bool direct,
  Duration? pushEvery,
  Duration? reconnectEvery,
}) {
  var calls = 0;
  fakeAsync((time) {
    final server = ConversationServer()..state['id'] = _tab;
    final client = SuperTabClient(
      transport: (method, path, {body}) {
        calls++;
        return server.request(method, path, body: body);
      },
      storage: MemoryStore(),
      discoveryInterval: const Duration(seconds: 15),
    )..reading = _web;
    client.bind('owner');
    client.show(_tab);
    client.open(_tab);
    time.flushMicrotasks();
    if (pushEvery != null) client.swarmChanged(const {});
    calls = 0;
    var at = Duration.zero;
    const step = Duration(seconds: 1);
    while (at < const Duration(minutes: _minutes)) {
      time.elapse(step);
      at += step;
      if (pushEvery != null && at.inSeconds % pushEvery.inSeconds == 0) {
        server.append('change at ${at.inSeconds}s');
        client.swarmChanged({
          'tabId': _tab,
          'lastChangedAt': at.inMilliseconds,
          'parts': ['main'],
        });
      }
      if (!direct &&
          reconnectEvery != null &&
          at.inSeconds % reconnectEvery.inSeconds == 0) {
        client.serverAvailable();
      }
    }
    client.bind(null);
    time.flushTimers(flushPeriodicTimers: false);
  });
  return calls / _minutes;
}

void main() {
  final rows = <String>[];
  tearDownAll(() {
    final out = Platform.environment['SUPER_TAB_RATE_OUT'];
    if (out != null) File(out).writeAsStringSync('${rows.join('\n')}\n');
  });

  void row(String name, double relay, double direct) => rows.add(
    '$name: relay ${relay.toStringAsFixed(1)}/min, '
    'direct ${direct.toStringAsFixed(1)}/min',
  );

  test('a quiet Swarm: the same requests either way', () {
    final relay = _perMinute(direct: false);
    final direct = _perMinute(direct: true);
    row('quiet, no pushes', relay, direct);
    expect(direct, relay);
    expect(direct, greaterThan(0));
  });

  test('a busy Swarm told by pushes: the same requests either way', () {
    const every = Duration(seconds: 10);
    final relay = _perMinute(direct: false, pushEvery: every);
    final direct = _perMinute(direct: true, pushEvery: every);
    row('busy, a push every 10 s', relay, direct);
    expect(direct, relay);
  });

  test('a machine on a weak link reconnecting: fewer requests direct', () {
    const every = Duration(seconds: 20);
    final relay = _perMinute(direct: false, reconnectEvery: every);
    final direct = _perMinute(direct: true, reconnectEvery: every);
    row('quiet, a machine reconnecting every 20 s', relay, direct);
    expect(direct, lessThan(relay));
  });
}
