import 'package:flutter/widgets.dart';

import 'screens/swarm_screen.dart';
import 'state/app_state.dart';

/// The signed-in screen of a native build. A browser build compiles
/// `web/web_entry.dart` in its place (the conditional import in `main.dart`),
/// so native code never reaches `lib/web/`.
Widget authenticatedWorkspace(AppNotifier app) => SwarmScreen(notifier: app);

/// A native build draws nothing around its screens.
Widget appFrame(Widget app) => app;
