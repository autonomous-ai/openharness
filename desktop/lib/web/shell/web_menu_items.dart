import 'package:flutter/widgets.dart';

import '../../shared/theme/app_icons.dart';
import '../../shared/theme/app_pane_icon.dart';

/// Which layouts a menu row belongs to: some rows repeat a control the wide
/// bar already shows, others make no sense on a phone.
enum WebMenuWidth { any, compact, wide }

/// One entry of the `+` menu: a workspace command id, its menu label and the
/// glyph the desktop menu bar gives the same command. The command itself lives
/// in the workspace's shared command table.
typedef WebMenuItem = ({
  String command,
  String label,
  Widget icon,
  WebMenuWidth width,
});

/// What the `+` beside the tabs offers, in groups a thin rule separates: new
/// work and what opens it (Huy, 2026-11-02). Machines and Models are the
/// footer's links, as on Desktop; who is signed in, Settings and Appearance are
/// the avatar's. New Swarm is here because its only other door is a key
/// (Alt+S), which a phone has not. Splitting is here because a split is an edge
/// to hover, which a finger cannot.
const List<List<WebMenuItem>> kWebMenuGroups = [
  [
    (
      command: 'swarm.new',
      label: 'New tab',
      icon: Icon(AppIcons.plus),
      width: WebMenuWidth.any,
    ),
    (
      command: 'super_tab.new',
      label: 'New Swarm',
      icon: Icon(AppIcons.users),
      width: WebMenuWidth.any,
    ),
  ],
  [
    // One split, always to the right: a second "down" row only lengthens the
    // menu, and `>` in search still has Split down.
    (
      command: 'pane.split_right',
      label: 'Split pane',
      icon: AppPaneIcon(AppPaneSymbol.splitRight, size: AppIcons.inlineSize),
      width: WebMenuWidth.any,
    ),
    (
      command: 'navigation.history',
      label: 'History',
      icon: Icon(AppIcons.history),
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
];

/// Behind the `+` menu's More: what a mouse-first page must keep clickable and
/// a phone has no key for, now All commands is gone.
const List<WebMenuItem> kWebMoreItems = [
  (
    command: 'pane.zoom',
    label: 'Zoom pane',
    icon: Icon(AppIcons.maximize),
    width: WebMenuWidth.any,
  ),
  (
    command: 'pane.move_left',
    label: 'Move pane left',
    icon: Icon(AppIcons.arrowLeft),
    width: WebMenuWidth.any,
  ),
  (
    command: 'pane.move_right',
    label: 'Move pane right',
    icon: Icon(AppIcons.arrowRight),
    width: WebMenuWidth.any,
  ),
  (
    command: 'pane.move_up',
    label: 'Move pane up',
    icon: Icon(AppIcons.arrowUp),
    width: WebMenuWidth.any,
  ),
  (
    command: 'pane.move_down',
    label: 'Move pane down',
    icon: Icon(AppIcons.arrowDown),
    width: WebMenuWidth.any,
  ),
  (
    command: 'pane.move_to_tab',
    label: 'Move pane to another tab',
    icon: Icon(AppIcons.arrowRightLeft),
    width: WebMenuWidth.any,
  ),
  (
    command: 'pane.layout',
    label: 'Layouts',
    icon: Icon(AppIcons.layoutGrid),
    width: WebMenuWidth.any,
  ),
  (
    command: 'swarm.reopen',
    label: 'Reopen closed tab',
    icon: Icon(AppIcons.rotateCcw),
    width: WebMenuWidth.any,
  ),
];

/// Commands that only change how several panes sit, so one pane has no use for
/// them.
const _needsTwoPanes = {
  'pane.zoom',
  'pane.move_left',
  'pane.move_right',
  'pane.move_up',
  'pane.move_down',
};

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

/// More's rows as they can be drawn right now. Empty means no More row.
List<WebMenuItem> runnableWebMore(
  bool Function(String command) canRun, {
  required int panes,
}) => [
  for (final item in kWebMoreItems)
    if (canRun(item.command) &&
        (panes > 1 || !_needsTwoPanes.contains(item.command)))
      item,
];
