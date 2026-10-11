import 'app_state.dart';
import 'essential_harness_controller.dart';

const harnessMonitorId = 'autonomous/harness-monitor';
const harnessMonitorName = 'Harness Monitor';

/// The footer's harness count opens this one: the Store's Harness Monitor essential.
class HarnessMonitorController extends EssentialHarnessController {
  HarnessMonitorController(AppNotifier app)
    : super(app, harnessMonitorEssential);
}
