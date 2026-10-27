import '../state/app_state.dart';

/// The Chat with PM shortcut: the active Swarm tab's current project's chat
/// ([SuperTabController.openCurrentPmChat]). False when the active tab is no
/// Swarm tab, or its Swarm is not open here.
Future<bool> openActivePmChat(AppNotifier app) async {
  final id = app.activeSwarm.superTabId;
  if (id == null) return false;
  final controller = app.superTabs.peek(id);
  return controller != null && await controller.openCurrentPmChat();
}
