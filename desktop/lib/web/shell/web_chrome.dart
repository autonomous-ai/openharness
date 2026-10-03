import '../../state/app_state.dart';
import '../../state/workspace_chrome.dart';
import '../footer/web_footer_bar.dart';
import '../tabs/web_tab_switcher.dart';
import 'web_app_menu.dart';
import 'web_layout.dart';
import 'web_machine_choice.dart';

/// Everything the browser adds to the shared workspace: a menu before the
/// tabs, a tab switcher and a one-dropdown footer on narrow screens, a clickable Back in the picker
/// with its key hints hidden, and a connected machine for New Harness, since
/// a browser is not a machine.
WorkspaceChrome webWorkspaceChrome(AppNotifier app) => WorkspaceChrome(
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
);
