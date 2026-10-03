/// The first egg's habits (`daemons/README.md`, First egg: habits), mapped to
/// signals this window already has. Each is reported once with `zoo.habit`.
///
/// | key         | signal here                                                   |
/// |-------------|---------------------------------------------------------------|
/// | `turn`      | a turn ended without error in a harness open in a pane here   |
/// | `split`     | a tab holds two or more different harnesses side by side      |
/// | `find`      | something was opened from Cmd-O (the harness finder)          |
/// | `elsewhere` | NOT REPORTED: the app cannot tell which device started a      |
/// |             | harness, so "answered from another device" has no reliable    |
/// |             | signal here. harnessd or the server has to report it.         |
/// | `machine`   | another computer of the account is connected (signed in)      |
/// | `store`     | a turn ended in a Store harness (anything but coding)         |
/// | `resume`    | a paused harness was resumed from this window                 |
/// | `days`      | three different local days with the window in front           |
///               (kept by `ZooController.noteDay`)
library;

import '../core/models.dart' show ConnectionStatus;
import '../state/app_state.dart';

Set<String> observedHabits(AppNotifier app, {bool found = false}) {
  final own = app.machineStates.values.where((m) => !m.machine.isShared);
  return {
    if (own.any((m) => m.completedHarnessUses.isNotEmpty)) 'turn',
    if (app.swarms.any(
      (tab) =>
          !tab.isStore &&
          {
                for (final pane in tab.panes)
                  if (!pane.isWeb && pane.agentId != null)
                    (pane.machineId, pane.agentId),
              }.length >=
              2,
    ))
      'split',
    if (found) 'find',
    if (!app.isGuest &&
        own.any(
          (m) =>
              !m.isLocalMachine &&
              !m.needsLink &&
              m.nodeOnline != false &&
              m.connectionStatus == ConnectionStatus.connected,
        ))
      'machine',
    if (own.any(
      (m) => m.completedHarnessUses.any((u) => u.harness != 'coding'),
    ))
      'store',
    if (own.any((m) => m.resumedHarnesses > 0)) 'resume',
  };
}
