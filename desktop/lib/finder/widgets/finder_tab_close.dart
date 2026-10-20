import 'package:flutter/widgets.dart';

import '../finder_controller.dart';
import '../finder_tabs.dart';
import 'finder_dialogs.dart';

/// Closes [tab], asking first when it has unsaved edits — Save, Don't Save
/// or Cancel. False when the person kept it open or the save failed.
Future<bool> closeFinderTab(
  BuildContext context,
  FinderController controller,
  FinderTab tab,
) async {
  if (tab.dirty) {
    final choice = await askToSaveChanges(context, tab.title);
    if (choice == null) return false;
    if (choice == FinderUnsavedChoice.save && !await tab.document!.save()) {
      return false;
    }
  }
  controller.tabs.close(tab.id);
  return true;
}

/// Asks about every tab with unsaved edits, one at a time, before the whole
/// tile closes. False as soon as one is kept open.
Future<bool> closeAllFinderTabs(
  BuildContext context,
  FinderController controller,
) async {
  for (final tab in controller.tabs.tabs.where((t) => t.dirty).toList()) {
    if (!context.mounted) return false;
    controller.tabs.activate(tab.id);
    if (!await closeFinderTab(context, controller, tab)) return false;
  }
  return true;
}
