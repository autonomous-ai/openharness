import 'package:flutter/widgets.dart';

import '../../screens/swarm_screen.dart';
import '../../state/app_state.dart';
import '../onboarding/saved_computers.dart';
import 'web_chrome.dart';

/// The signed-in browser workspace: the shared swarm of panes, with the
/// mouse-first chrome that stands in for desktop's native menus.
class WebWorkspace extends StatelessWidget {
  const WebWorkspace({super.key, required this.app});

  final AppNotifier app;

  @override
  Widget build(BuildContext context) {
    // Made once per app, here rather than with the connect page: the list is
    // kept whenever it answers, also when a computer connects before the page shows.
    savedComputersOf(app);
    return SwarmScreen(notifier: app, chrome: webWorkspaceChrome(app));
  }
}
