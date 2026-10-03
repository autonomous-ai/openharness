import 'package:flutter/widgets.dart';

import '../../screens/swarm_screen.dart';
import '../../state/app_state.dart';
import 'web_chrome.dart';

/// The signed-in browser workspace: the shared swarm of panes, with the
/// mouse-first chrome that stands in for desktop's native menus.
class WebWorkspace extends StatelessWidget {
  const WebWorkspace({super.key, required this.app});

  final AppNotifier app;

  @override
  Widget build(BuildContext context) =>
      SwarmScreen(notifier: app, chrome: webWorkspaceChrome(app));
}
