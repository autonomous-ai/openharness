// The daemon port Desktop talks to comes from one build-time define, so the test flavor
// (desktop/tool/test_flavor.py) can be built for its own daemon while the installed app keeps 18473.
// The installed app never reads a port from its environment: a PORT set in a person's shell must not
// move it.
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/config.dart';

void main() {
  test('a port gives the loopback base URL Desktop talks to', () {
    expect(localCliBaseUrlFor(18999), 'http://127.0.0.1:18999');
  });

  test('without the define, the installed app keeps the daemon on 18473', () {
    expect(localDaemonPort, 18473);
    expect(AppConfig.dev.localCliBaseUrl, 'http://127.0.0.1:18473');
  });

  test('the port is written in one place: no other literal 18473 in lib', () {
    final literal = RegExp(r'\b18473\b');
    final offenders = Directory('lib')
        .listSync(recursive: true)
        .whereType<File>()
        .where((f) => f.path.endsWith('.dart'))
        .where((f) => f.readAsStringSync().contains(literal))
        .map((f) => f.path.replaceAll('\\', '/'))
        .toList();
    expect(offenders, ['lib/core/config.dart']);
    final config = File('lib/core/config.dart').readAsStringSync();
    expect(literal.allMatches(config).length, 1,
        reason: 'the define default is the only 18473');
    expect(config, contains("int.fromEnvironment('HARNESS_DAEMON_PORT'"));
  });
}
