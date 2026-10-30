/// No-login review fixture for the whole Harness web app.
///
/// Build for web with `--dart-define=HARNESS_TEST=true` and open with
/// `?scenario=<name>` (see [webUxScenarios]) and optional `?theme=light|dark`.
/// It runs the real [HarnessApp] — the web frame, [RootShell] and the browser
/// workspace — against an in-memory [WebUxApp], so every screen is the
/// production widget with fake data. Review only: it never signs in, reads a
/// machine list or reaches a machine.
library;

import 'package:flutter/widgets.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:harness/app_shell.dart';
import 'package:harness/shared/theme/appearance_prefs_store.dart';
import 'package:harness/shared/theme/color_palette.dart';
import 'package:harness/state/app_state.dart';
import 'package:harness/web/web_entry.dart';

import 'web_ux_scenarios.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  // Let headless browsers address the rendered controls by role and name.
  WidgetsBinding.instance.ensureSemantics();
  final query = Uri.base.queryParameters;
  final scenario = webUxScenarios[query['scenario'] ?? 'workspace'];
  appearancePrefsStore.value = appearancePrefsStore.value.copyWith(
    palette: query['theme'] == 'light'
        ? HarnessPalette.paper
        : HarnessPalette.graphite,
  );
  final app = scenario?.seed() ?? (WebUxApp()..status = AppStatus.authenticated);
  runApp(
    ProviderScope(
      overrides: [appStateProvider.overrideWithValue(app)],
      child: HarnessApp(
        authenticatedScreen: authenticatedWorkspace,
        frame: appFrame,
      ),
    ),
  );
}
