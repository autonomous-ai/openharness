import 'package:flutter_test/flutter_test.dart';
import 'package:harness/core/test_run.dart';
import 'package:integration_test/integration_test.dart';
import 'package:window_manager/window_manager.dart';

import '../test/session_close_dialog_test.dart' as dialog;
import '../test/session_close_test.dart' as close;

void main() {
  if (!kUnderTest) {
    throw StateError('Session close fixtures require FLUTTER_TEST=1');
  }
  IntegrationTestWidgetsFlutterBinding.ensureInitialized().framePolicy =
      LiveTestWidgetsFlutterBindingFramePolicy.onlyPumps;
  setUpAll(() async {
    await windowManager.ensureInitialized();
    await windowManager.show();
    await windowManager.focus();
  });
  close.main();
  dialog.main();
}
