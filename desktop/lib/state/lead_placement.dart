/// A machine of the Swarm a new project's Product Manager could start on, as
/// New Project lists it under "Lead: … · Change".
class LeadMachine {
  const LeadMachine({
    required this.id,
    required this.name,
    required this.online,
    required this.freeAgents,
    this.repositories = const {},
    this.maySleep = false,
    this.unavailable,
  });
  final String id, name;
  final bool online;

  /// The agent slots it offers the Swarm that nothing runs in.
  final int freeAgents;

  /// The repositories the Swarm already checked out there, as
  /// [leadRepositoryKey] reads them.
  final Set<String> repositories;

  /// A laptop: it may sleep with the Product Manager on it.
  final bool maySleep;

  /// Why the Product Manager cannot start here whatever its state, or null.
  final String? unavailable;

  bool has(String? repository) {
    final key = leadRepositoryKey(repository);
    return key != null && repositories.contains(key);
  }

  bool get startable => unavailable == null && online && freeAgents > 0;
}

/// One repository however its remote is spelled: `host/owner/name`, lower
/// case, without scheme, user, `.git` or trailing slash. Null for none.
String? leadRepositoryKey(String? remote) {
  var value = remote?.trim().toLowerCase() ?? '';
  if (value.isEmpty) return null;
  value = value.replaceFirst(RegExp(r'^[a-z+]+://'), '');
  value = value.replaceFirst(RegExp(r'^[^@/]+@'), '');
  // scp-like `host:owner/name`.
  value = value.replaceFirstMapped(
    RegExp(r'^([^/:]+):(?!\d)'),
    (m) => '${m[1]}/',
  );
  value = value.replaceFirst(RegExp(r'/+$'), '');
  value = value.replaceFirst(RegExp(r'\.git$'), '');
  return value.isEmpty ? null : value;
}

/// Best first: one the Product Manager can start on now, always on (laptops
/// that may sleep last), with [repository] already there, with the most room; then the ones it cannot
/// use yet (full), then other people's, then offline ones.
List<LeadMachine> rankLeadMachines(
  Iterable<LeadMachine> machines,
  String? repository,
) {
  int tier(LeadMachine m) => m.startable
      ? 0
      : m.unavailable == null && m.online
      ? 1
      : m.online
      ? 2
      : 3;
  int flag(bool value) => value ? 0 : 1;
  return [...machines]..sort(
    (a, b) => [
      tier(a).compareTo(tier(b)),
      flag(!a.maySleep).compareTo(flag(!b.maySleep)),
      flag(a.has(repository)).compareTo(flag(b.has(repository))),
      b.freeAgents.compareTo(a.freeAgents),
      a.name.toLowerCase().compareTo(b.name.toLowerCase()),
    ].firstWhere((order) => order != 0, orElse: () => 0),
  );
}

/// Where the Swarm places the Product Manager, or null when no machine can
/// take it now.
LeadMachine? bestLeadMachine(
  Iterable<LeadMachine> machines,
  String? repository,
) => rankLeadMachines(
  machines,
  repository,
).where((m) => m.startable).firstOrNull;

/// A machine's row detail, in words, so colour is never the only signal.
String leadMachineDetail(LeadMachine machine, String? repository) {
  if (machine.unavailable case final why?) return why;
  if (!machine.online) return 'Offline';
  final free = machine.freeAgents;
  return [
    'Online',
    free <= 0
        ? 'No agents free'
        : '$free ${free == 1 ? 'agent' : 'agents'} free',
    if (free > 0 && machine.has(repository)) 'Has repo',
    if (free > 0 && machine.maySleep) 'May sleep',
  ].join(' · ');
}
