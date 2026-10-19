import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:integration_test/integration_test.dart';

import '../test/desktop_search_polish_test.dart' as review;

/// Run the shared picker journeys with synthetic subscriptions in a real window.
/// Use --plain-name 'every search scope fits' for both themes and long email labels.
void main() {
  if (!kUnderTest)
    throw StateError('Subscription fixtures require FLUTTER_TEST=1');
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  review.main();
}
