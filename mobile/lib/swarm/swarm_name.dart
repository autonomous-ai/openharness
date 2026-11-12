import 'swarm_inbox.dart';

/// The one way the phone names Swarm [id], named [name], as Desktop does
/// (`swarm_name.dart` `swarmShownName`, anh Dee, 2026-11-12): to someone
/// invited to another person's Personal Swarm it is that person's, "Dee's
/// Swarm", so Personal is only ever the reader's own; their own and every
/// other Swarm by its name, a team Swarm named Personal too. Which Swarm is a
/// Personal one the server says ([SwarmInbox.isPersonalSwarm]); an older one
/// does not, and every Swarm keeps its name. Its owner is named as the Swarm
/// shows them (the name they set, else their username), as a read here has
/// them; before one does, plain Swarm. Shown only: the Swarm stays named
/// Personal, and Rename Swarm edits that name.
String swarmShownName(SwarmInbox inbox, String id, String name) {
  final owner = inbox.ownerOf(id);
  if (!inbox.isPersonalSwarm(id) ||
      owner == null ||
      owner.isEmpty ||
      owner == inbox.accountId) {
    return name;
  }
  return switch (inbox.personOf(id, owner)) {
    final person? => "${person.shownName}'s Swarm",
    null => 'Swarm',
  };
}
