// Test-only normal Flutter entrypoint. Build with `flutter build windows --debug
// --no-pub --target integration_test/windows_runner_child.dart`, then copy the
// complete Debug bundle before building the parent integration test. There is
// deliberately no flutter_test/integration_test host handshake in this child.
import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

const _links = MethodChannel('harness/community_links');

Future<void> main() async {
  final log = Platform.environment['HARNESS_RUNNER_TEST_CHILD'];
  if (!Platform.isWindows ||
      Platform.environment['FLUTTER_TEST'] != '1' ||
      (Platform.environment['HARNESS_DESKTOP_INSTANCE'] ?? '').isEmpty ||
      log == null ||
      !File(log).isAbsolute) {
    throw StateError(
      'Windows runner child requires isolated test configuration',
    );
  }
  WidgetsFlutterBinding.ensureInitialized();
  final file = File(log);
  var tail = Future<void>.value();
  var ready = false;
  final beforeReady = <String>[];
  Future<void> record(String url) => tail = tail.then((_) async {
    await file.writeAsString('$url\n', mode: FileMode.append, flush: true);
  });
  _links.setMethodCallHandler((call) async {
    if (call.method != 'open' || call.arguments is! String) return;
    final url = call.arguments as String;
    if (!ready) {
      beforeReady.add(url);
    } else {
      await record(url);
    }
  });
  runApp(
    const MaterialApp(
      home: Scaffold(body: Center(child: Text('Harness runner test child'))),
    ),
  );
  await _mark('$log.waiting-before-ready');
  final watch = Stopwatch()..start();
  while (!File('$log.release').existsSync()) {
    if (watch.elapsed >= const Duration(seconds: 60)) {
      throw TimeoutException('parent did not release the child ready barrier');
    }
    await Future<void>.delayed(const Duration(milliseconds: 50));
  }
  final pending = await _links
      .invokeListMethod<String>('ready')
      .timeout(const Duration(seconds: 20));
  // Queue cold pending links before any live open callback that overtook the
  // ready reply. No await may interleave this queue transition.
  for (final url in [...?pending, ...beforeReady]) {
    unawaited(record(url));
  }
  beforeReady.clear();
  ready = true;
  await tail;
  await _mark('$log.ready');
}

Future<void> _mark(String path) async {
  // Existence must mean the complete marker, including the actual PID, is read.
  final temporary = File('$path.tmp');
  await temporary.writeAsString('$pid', flush: true);
  await temporary.rename(path);
}
