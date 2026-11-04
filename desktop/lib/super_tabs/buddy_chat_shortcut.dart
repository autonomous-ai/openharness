import '../state/app_state.dart';

/// The Buddy chat shortcut: the active Swarm tab's current project's Buddy
/// chat ([SuperTabController.openCurrentBuddyChat]). False when the active tab
/// is no Swarm tab, or its Swarm is not open here.
Future<bool> openActiveBuddyChat(AppNotifier app) async {
  final id = app.activeSwarm.superTabId;
  if (id == null) return false;
  final controller = app.superTabs.peek(id);
  return controller != null && await controller.openCurrentBuddyChat();
}
