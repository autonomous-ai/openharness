import 'dart:async';

import 'package:harness/core/connected_semantics.dart';
import 'package:integration_test/integration_test.dart';

/// Native fixtures must keep the production accessibility boundary. Flutter's
/// test launcher initializes its binding before calling a test's main, so this
/// hook installs the guarded binding before that automatic initialization.
class HarnessIntegrationTestBinding extends IntegrationTestWidgetsFlutterBinding
    with ConnectedSemanticsBinding {}

HarnessIntegrationTestBinding? _binding;

HarnessIntegrationTestBinding ensureNativeTestBinding() =>
    _binding ??= HarnessIntegrationTestBinding();

Future<void> testExecutable(FutureOr<void> Function() testMain) async {
  ensureNativeTestBinding();
  await testMain();
}
