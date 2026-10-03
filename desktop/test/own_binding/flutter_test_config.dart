import 'dart:async';

/// Tests here construct their own test binding in `main` (a subclass with production mixins and
/// recording hooks), so they cannot run under `test/flutter_test_config.dart`, which creates the
/// standard binding first. Only the nearest config applies, so this one opts out of that. Each
/// file sets the two-minute `defaultTestTimeout` on its own binding instead.
Future<void> testExecutable(FutureOr<void> Function() testMain) => Future.sync(testMain);
