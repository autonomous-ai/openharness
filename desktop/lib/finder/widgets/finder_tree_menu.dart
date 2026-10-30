import 'dart:io' show Platform;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;

import '../../shared/theme/app_icons.dart';
import '../../shared/widgets/app_menu.dart';
import '../finder_controller.dart';
import '../finder_file_actions.dart';
import '../finder_models.dart';
import 'finder_dialogs.dart';

/// What a right click on the tree offers — Orca's explorer menu, less what a
/// tile has no use for: new items, rename, the two paths, reveal, open with
/// the system's app, and the Trash.
List<Widget> finderTreeMenu({
  required BuildContext context,
  required FinderController controller,
  required FinderEntry? entry,
  required void Function(String folder, {required bool asFolder}) onCreate,
  required void Function(FinderEntry entry) onRename,
}) {
  final target = entry?.path ?? controller.root;
  final folder = entry == null || entry.isDirectory
      ? target
      : p.dirname(target);
  void copy(String text) => Clipboard.setData(ClipboardData(text: text));
  return [
    AppMenuItem(
      icon: AppIcons.filePlus,
      label: 'New File…',
      onPressed: () => onCreate(folder, asFolder: false),
    ),
    AppMenuItem(
      icon: AppIcons.folderPlus,
      label: 'New Folder…',
      onPressed: () => onCreate(folder, asFolder: true),
    ),
    const AppMenuDivider(),
    AppMenuItem(
      icon: AppIcons.copy,
      label: 'Copy Path',
      onPressed: () => copy(target),
    ),
    AppMenuItem(
      icon: AppIcons.copy,
      label: 'Copy Relative Path',
      onPressed: () => copy(p.relative(target, from: controller.root)),
    ),
    AppMenuItem(
      icon: AppIcons.folderOpen,
      label: Platform.isMacOS ? 'Reveal in Finder' : 'Show in File Manager',
      onPressed: () => controller.files.reveal(target),
    ),
    if (entry != null && !entry.isDirectory)
      AppMenuItem(
        icon: AppIcons.externalLink,
        label: 'Open with Default App',
        onPressed: () => controller.files.open(target),
      ),
    if (entry != null) ...[
      const AppMenuDivider(),
      AppMenuItem(
        icon: AppIcons.pencil,
        label: 'Rename',
        onPressed: () => onRename(entry),
      ),
      AppMenuItem(
        icon: AppIcons.trash2,
        label: 'Move to Trash',
        danger: true,
        onPressed: () => trashEntry(context, controller, entry),
      ),
    ],
  ];
}

/// Asks, then moves [entry] to the Trash.
Future<void> trashEntry(
  BuildContext context,
  FinderController controller,
  FinderEntry entry,
) async {
  if (!await confirmTrash(context, entry.name)) return;
  final error = await controller.trash(entry.path);
  if (error != null) controller.say(error);
}
