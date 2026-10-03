import 'package:harness/core/test_run.dart';
import 'package:integration_test/integration_test.dart';

import '../test/terminal_cursor_idle_test.dart' as cursor;
import 'native_terminal_e2e_test.dart' as terminal;

void main() {
  if (!kUnderTest) {
    throw StateError('Native cursor fixtures require FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized();
  cursor.main();
  terminal.main();
}
