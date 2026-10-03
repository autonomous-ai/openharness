import 'dart:async';
import 'dart:io';

import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/core/harness_file_store.dart';

/// Runs before every test file under `test/`.
///
/// ⚠️ **Every default path points into a throwaway home.** The app's stores,
/// logs, crash log and snapshots all resolve under
/// `~/.harness` through [HarnessFileStore.defaultDirectoryPath], and a test
/// that builds the app without handing each one a fake would otherwise read and
/// write the developer's real state — sessions and E2EE keys included. See the
/// rules in `mobile/README.md`.
Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  HttpOverrides.global = _NoNetwork();
  final home = Directory.systemTemp.createTempSync('harness-test-home-');
  HarnessFileStore.homeForTest = home.path;
  tearDownAll(() {
    if (home.existsSync()) home.deleteSync(recursive: true);
  });
  await testMain();
}

class _NoNetwork extends HttpOverrides {
  @override
  HttpClient createHttpClient(SecurityContext? context) => throw StateError(
    'Network is disabled in tests. Inject an in-memory transport.',
  );
}
