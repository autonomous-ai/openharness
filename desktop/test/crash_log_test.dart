import 'dart:io';

import 'package:flutter/foundation.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/crash_log.dart';
import 'package:harness/logging/app_log.dart';
import 'package:harness/logging/log_stream.dart';
import 'package:harness/logging/log_stream_sinks.dart';
import 'package:harness/ws/ws_conn.dart';

void main() {
  test('an error reaches the log with its stack', () {
    final directory = Directory.systemTemp.createTempSync(
      'harness-v2-crash-test-',
    );
    final file = File('${directory.path}/errors.log');
    CrashLog.testFile = file;
    addTearDown(() {
      CrashLog.testFile = null;
      directory.deleteSync(recursive: true);
    });

    CrashLog.record(
      TypeError(),
      StackTrace.fromString(
        '#0 someFrame (package:harness/somewhere.dart:1:2)',
      ),
      context: 'renderer',
    );

    expect(file.existsSync(), isTrue);
    final text = file.readAsStringSync();
    expect(text, contains('[renderer]'));
    expect(
      text,
      contains('someFrame'),
      reason: 'the stack is the whole point — a message alone names no line',
    );
    file.deleteSync();
  });

  // A refusal nobody caught still reaches errors.log, and its detail can quote
  // a prompt or a name: the file keeps the code, as the app log does.
  test('a refusal reaches errors.log by its code, not its detail', () {
    final directory = Directory.systemTemp.createTempSync(
      'harness-v2-crash-test-',
    );
    final file = File('${directory.path}/errors.log');
    CrashLog.testFile = file;
    final previousLog = appLog;
    final stream = LogStream();
    appLog = StreamAppLog(stream);
    addTearDown(() {
      appLog = previousLog;
      CrashLog.testFile = null;
      directory.deleteSync(recursive: true);
    });

    CrashLog.record(
      const WsRequestFailure(
        responseType: 'agent_create_result',
        code: 'SPAWN_FAILED',
        detail: 'could not start zebra-orchard',
      ),
      StackTrace.empty,
      context: 'async',
    );

    final text = file.readAsStringSync();
    expect(text, contains('[async] agent_create_result: SPAWN_FAILED'));
    expect(text, isNot(contains('zebra-orchard')));
    expect(stream.entries.single.error, 'agent_create_result: SPAWN_FAILED');
  });

  test('installing keeps the handler that was already there', () {
    var previousRan = false;
    FlutterError.onError = (_) => previousRan = true;
    CrashLog.install();

    FlutterError.onError!(FlutterErrorDetails(exception: StateError('boom')));

    expect(
      previousRan,
      isTrue,
      reason: 'adding a copy must not silence what already printed',
    );
  });
}
