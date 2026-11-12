import '../state/app_state.dart';
import '../state/swarm.dart';

/// The one way the Desktop names Swarm [id], named [name] (anh Dee, 2026-11-12): to someone invited to another person's
/// Personal Swarm it is that person's, "Dee's Swarm", so Personal is only ever the reader's own; their own and every other
/// Swarm by its name, a team Swarm named Personal too. Which Swarm is a Personal one the server says
/// ([SuperTabClient.isPersonalSwarm]); an older one does not, and every Swarm keeps its name. Its owner is named as the
/// Swarm shows them ([SuperTabPerson.shownName]: the name they set, else their username), as read here; before any read
/// here has them, plain Swarm. Shown only: the Swarm stays named Personal.
String swarmShownName(AppNotifier app, String id, String name) {
  final reader = app.currentUser?.id;
  final owner = app.superTabs.ownerOf(id);
  if (!app.superTabs.isPersonalSwarm(id) ||
      reader == null ||
      owner == null ||
      owner == reader) {
    return name;
  }
  return switch (app.superTabs.personOf(id, owner)) {
    final person? => "${person.shownName}'s Swarm",
    null => 'Swarm',
  };
}

/// [tab]'s name when it shows a Swarm, by [swarmShownName]; null for a tab that shows none.
String? swarmTabShownName(AppNotifier app, Swarm tab) =>
    switch (tab.superTabId) {
      final id? when tab.isSuperTab => swarmShownName(app, id, tab.name),
      _ => null,
    };
