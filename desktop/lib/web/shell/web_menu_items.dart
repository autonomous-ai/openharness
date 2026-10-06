import 'package:flutter/widgets.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_pane_icon.dart';

/// Which layouts a menu row belongs to: some rows repeat a control the wide
/// bar already shows, others make no sense on a phone.
enum WebMenuWidth { any, compact, wide }

/// One entry of the web app menu: a workspace command id, its menu label and
/// the glyph the desktop menu bar gives the same command. The command itself
/// lives in the workspace's shared command table.
typedef WebMenuItem = ({
  String command,
  String label,
  Widget icon,
  WebMenuWidth width,
});

/// What the menu offers, in groups a thin rule separates. Only what has no
/// other door in the browser chrome: new work is the `+` beside the tabs
/// (a new tab opens on "Start an agent"), agents the search button, tabs the
/// tab bar and switcher, attention the bell, closing a pane its own header;
/// keyboard tours and grid layout stay out of a mouse-first menu. Splitting is
/// here because the header gave it up: a split is an edge to hover, which a
/// finger cannot. Sharing is not — Share is an experimental button, off until
/// its setting is switched on, and a row here would put it back for everyone.
/// All commands still reaches every one.
const List<List<WebMenuItem>> kWebMenuGroups = [
  [
    (
      command: 'machines.list',
      label: 'Machines',
      icon: Icon(AppIcons.server),
      width: WebMenuWidth.any,
    ),
    (
      command: 'models.list',
      label: 'Models',
      icon: Icon(AppIcons.cpu),
      width: WebMenuWidth.any,
    ),
    // The wide bar has its own Store button; the phone bar gives it up.
    (
      command: 'app.store',
      label: 'Store',
      icon: Icon(AppIcons.store),
      width: WebMenuWidth.compact,
    ),
  ],
  [
    // One split, always to the right: a second "down" row only lengthens the
    // menu, and All commands still has Split down.
    (
      command: 'pane.split_right',
      label: 'Split pane',
      icon: AppPaneIcon(AppPaneSymbol.splitRight, size: AppIcons.inlineSize),
      width: WebMenuWidth.any,
    ),
  ],
  [
    (
      command: 'navigation.history',
      label: 'History',
      icon: Icon(AppIcons.history),
      width: WebMenuWidth.any,
    ),
    (
      command: 'navigation.commands',
      label: 'All commands',
      icon: Icon(AppIcons.command),
      width: WebMenuWidth.any,
    ),
  ],
  [
    (
      command: 'app.settings',
      label: 'Settings',
      icon: Icon(AppIcons.settings),
      width: WebMenuWidth.any,
    ),
    (
      command: 'app.customize',
      label: 'Customize',
      icon: Icon(AppIcons.palette),
      width: WebMenuWidth.any,
    ),
    // Pairing a phone is for a computer; a phone is already here.
    (
      command: 'app.add_phone',
      label: 'Add phone',
      icon: Icon(AppIcons.smartphone),
      width: WebMenuWidth.wide,
    ),
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
