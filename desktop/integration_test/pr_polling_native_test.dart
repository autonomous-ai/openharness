import 'package:flutter_test/flutter_test.dart';
import 'package:integration_test/integration_test.dart';
import 'package:harness/core/test_run.dart';

import '../test/terminal_panel_header_test.dart' show verifyPanePrVisibility;

void main() {
  if (!kUnderTest) {
    throw StateError('Run this synthetic fixture with FLUTTER_TEST=1.');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  testWidgets(
    'native pane PR refresh follows visibility and branch changes',
    verifyPanePrVisibility,
  );
}
