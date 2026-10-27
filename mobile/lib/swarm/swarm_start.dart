import 'swarm_inbox.dart';

/// One of the person's computers as Swarm's start screen lists it: its name,
/// and whether it is away for real (`phoneMachineAway`).
typedef SwarmComputer = ({String name, bool away});

/// What Swarm shows before there is a Swarm to show — one screen each, with
/// one button. Swarm turned off is not one of them: the app is as it was, and
/// Settings offers Swarm.
enum SwarmStart {
  /// The account has no computer at all: Connect a computer.
  noComputer,

  /// None of its computers is online, and no Swarm was read yet: Try again.
  offline,

  /// The Swarms were read, and there is none: Show me how.
  none,

  /// No Swarm, and an invitation to one waiting: Join.
  invited,
}

/// Which start screen applies, from what the phone already knows: [computers]
/// as the account's list says (null until it has answered) and what [inbox]
/// read. Null when there is a Swarm to show, or nothing is known yet.
///
/// A computer going away after the Swarms were read shows no start screen:
/// what was read stays, and the reads retry quietly (`swarmRequest`). It once
/// flashed "Connect one of your computers" for 10 to 25 seconds at a time
/// with the computer connected all along (owner's iPhone, 2026-10-27).
SwarmStart? swarmStart(SwarmInbox inbox, List<SwarmComputer>? computers) {
  if (computers == null) return null;
  if (computers.isEmpty) return SwarmStart.noComputer;
  if (!inbox.loaded) {
    final away = computers.every((computer) => computer.away);
    return away || inbox.noComputer ? SwarmStart.offline : null;
  }
  if (inbox.swarms.isNotEmpty) return null;
  return inbox.invitations.isEmpty ? SwarmStart.none : SwarmStart.invited;
}
