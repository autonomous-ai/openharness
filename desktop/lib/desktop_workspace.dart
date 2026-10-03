import 'package:flutter/widgets.dart';

import 'fleet/fleet_overview.dart';
import 'screens/swarm_screen.dart';
import 'state/app_state.dart';

/// The signed-in screen of a native build. A browser build compiles
/// `web/web_entry.dart` in its place (the conditional import in `main.dart`),
/// so native code never reaches `lib/web/`. The fleet overview (Ctrl+Shift+G)
/// wraps the native workspace only.
Widget authenticatedWorkspace(AppNotifier app) =>
    FleetOverviewHost(app: app, child: SwarmScreen(notifier: app));

/// A native build draws nothing around its screens.
Widget appFrame(Widget app) => app;
