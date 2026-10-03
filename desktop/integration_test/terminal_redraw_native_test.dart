import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:harness/core/test_run.dart';

import '../test/support/terminal_redraw_pixels.dart';
import 'native_terminal_e2e_test.dart' as terminal_journeys;

void main() {
  if (!kUnderTest) {
    throw StateError('Native terminal fixtures require FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  terminal_journeys.main();
  testWidgets('rewritten rows match uncached native terminal pixels', (
    tester,
  ) async {
    await tester.runAsync(verifyTerminalRedrawPixels);
    expect(tester.takeException(), isNull);
  });
}
