import 'package:flutter/widgets.dart';

import '../state/workspace_chrome.dart';

/// Whether the Store lays itself out for a phone: below the host chrome's
/// [WorkspaceChrome.compactBelow]. Desktop has no chrome, so its threshold is
/// zero and the Store keeps its rail at any window width.
bool storeIsCompact(BuildContext context) =>
    MediaQuery.sizeOf(context).width < WorkspaceChrome.of(context).compactBelow;

/// Whether the device showing the Store runs no harness of its own — a
/// browser — so there is no "this computer" for its copy to name. The host
/// says so by choosing where New Harness starts
/// ([WorkspaceChrome.newHarnessMachine]); Desktop never does.
bool storeRunsNoHarness(BuildContext context) =>
    WorkspaceChrome.of(context).newHarnessMachine != null;
