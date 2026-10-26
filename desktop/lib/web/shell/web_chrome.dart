import '../../state/app_state.dart';
import '../../super_tabs/reading.dart';
import '../../state/workspace_chrome.dart';
import '../onboarding/web_first_machine.dart';
import '../footer/web_footer_bar.dart';
import '../tabs/web_tab_switcher.dart';
import 'web_app_menu.dart';
import 'web_layout.dart';
import 'web_machine_choice.dart';

/// Everything the browser adds to the shared workspace: a menu before the
/// tabs, a tab switcher and a one-dropdown footer on narrow screens, a clickable Back in the picker
/// with its key hints hidden, and a connected machine for New Harness, since
/// a browser is not a machine. It also turns on a menu on every tab, worded
/// pane states and the compact pane header, which the web reads and Desktop
/// leaves off.
///
/// Made once per [AppNotifier]: the signed-in screen is rebuilt on every app
/// notification, and a new chrome each time would rebuild every widget that
/// reads it ([WorkspaceChromeScope] compares by identity). Nothing in it
/// depends on more than [app].
WorkspaceChrome webWorkspaceChrome(AppNotifier app) =>
    _webChromes[app] ??= _webWorkspaceChrome(app);

final _webChromes = Expando<WorkspaceChrome>('webWorkspaceChrome');

WorkspaceChrome _webWorkspaceChrome(AppNotifier app) => WorkspaceChrome(
  leadingWidth: WebAppMenuButton.widthOf,
  leading: (context, commands) =>
      WebAppMenuButton(app: app, commands: commands),
  newHarnessMachine: () => webNewHarnessMachine(app),
  pickerShowsBack: true,
  showsKeyHints: false,
  viewMachineCloses: true,
  showsShareStatus: true,
  scrollsTabsByArrows: true,
  compactTabs: (context, commands) =>
      WebTabSwitcher(app: app, commands: commands),
  compactFooter: (context, footer) => WebFooterBar(footer: footer),
  compactBelow: kWebCompactBelow,
  twoPaneColumnsBelow: 1000,
  firstMachine: (context) => WebFirstMachine(app: app),
  menuOnEveryTab: true,
  labelsPaneStatus: true,
  compactPaneHeader: true,
  superTabRecovers: true,
  // A phone pays for every read: poll the Swarm on screen only, slow it while
  // the conversation is quiet, read when a machine connects instead of at the
  // next poll, ask for the saved conversation beside the first state, and
  // draw the last view kept on this device while the first read is on its way.
  superTabReading: const SuperTabReading(
    quietPoll: Duration(seconds: 15),
    pausesAway: true,
    readsOnConnect: true,
    connectGrace: Duration(seconds: 10),
    messagesWithState: true,
    drawsSaved: true,
  ),
);
