/// Which layouts a menu row belongs to: some rows repeat a control the wide
/// bar already shows, others make no sense on a phone.
enum WebMenuWidth { any, compact, wide }

/// One entry of the web app menu: a workspace command id and its menu label.
/// The command itself lives in the workspace's shared command table.
typedef WebMenuItem = ({String command, String label, WebMenuWidth width});

/// What the menu offers, in groups a thin rule separates. Only what has no
/// other door in the browser chrome: new work is the `+` beside the tabs
/// (a new tab opens on "Start an agent"), agents the search button, tabs the
/// tab bar and switcher, attention the bell, closing a pane its own header;
/// keyboard tours and grid layout stay out of a mouse-first menu. Sharing and
/// splitting are here because the header gave them up: Share is an
/// experimental button, off until asked for, and a split is an edge to hover,
/// which a finger cannot. All commands still reaches every one.
const List<List<WebMenuItem>> kWebMenuGroups = [
  [
    (command: 'machines.list', label: 'Machines', width: WebMenuWidth.any),
    (command: 'models.list', label: 'Models', width: WebMenuWidth.any),
    // The wide bar has its own Store button; the phone bar gives it up.
    (command: 'app.store', label: 'Store', width: WebMenuWidth.compact),
  ],
  [
    (command: 'agent.share', label: 'Share harness', width: WebMenuWidth.any),
    // One split, always to the right: a second "down" row only lengthens the
    // menu, and All commands still has Split down.
    (command: 'pane.split_right', label: 'Split pane', width: WebMenuWidth.any),
  ],
  [
    (command: 'navigation.history', label: 'History', width: WebMenuWidth.any),
    (
      command: 'navigation.commands',
      label: 'All commands',
      width: WebMenuWidth.any,
    ),
  ],
  [
    (command: 'app.settings', label: 'Settings', width: WebMenuWidth.any),
    (command: 'app.customize', label: 'Customize', width: WebMenuWidth.any),
    // Pairing a phone is for a computer; a phone is already here.
    (command: 'app.add_phone', label: 'Add phone', width: WebMenuWidth.wide),
  ],
];

/// The groups as they can be drawn right now: rows for the other layout, and
/// commands that cannot run in this workspace state, are left out, and a group
/// left empty goes with them.
List<List<WebMenuItem>> runnableWebMenu(
  bool Function(String command) canRun, {
  required bool compact,
}) => [
  for (final group in kWebMenuGroups)
    if (group
            .where(
              (item) =>
                  item.width !=
                      (compact ? WebMenuWidth.wide : WebMenuWidth.compact) &&
                  canRun(item.command),
            )
            .toList()
        case final items when items.isNotEmpty)
      items,
];
