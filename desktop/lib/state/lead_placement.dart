/// A machine of the Swarm a new project's Product Manager could start on, as
/// New Project lists it under "Lead: … · Change".
class LeadMachine {
  const LeadMachine({
    required this.id,
    required this.name,
    required this.online,
    required this.freeAgents,
    this.repositories = const {},
    this.folders = const {},
    this.maySleep = false,
    this.unavailable,
    this.inSwarm = true,
    this.own = true,
    this.native = true,
    this.team = false,
    this.teamEngines,
    this.engineRefusals = const {},
  });
  final String id, name;
  final bool online;

  /// The agent slots it offers the Swarm that nothing runs in; null for a
  /// machine of the person's the Swarm does not list, which it does not limit.
  final int? freeAgents;

  /// Listed by the Swarm. A person may still start their project's Product
  /// Manager on another machine of theirs, as before.
  final bool inSwarm;

  /// One of the person's own machines. Another person's runs the Product
  /// Manager only in its Mac's Harness Team account ([team]).
  final bool own;

  /// This Desktop starts the Product Manager itself, on a machine of the
  /// person's it is connected to; otherwise the Swarm starts it there.
  final bool native;

  /// It runs in that machine's Harness Team account.
  final bool team;

  /// The engines it runs in that Mac's Harness Team account, as the server
  /// decided (backend leadStart.ts leadChoices); the others run on the Mac
  /// itself. Null from a server that does not say: then [team] holds for all.
  final Set<String>? teamEngines;

  /// It runs with [engine] in that Mac's Harness Team account.
  bool inTeam(String engine) => teamEngines?.contains(engine) ?? team;

  /// The repositories the Swarm already checked out there, as
  /// [leadRepositoryKey] reads them.
  final Set<String> repositories;

  /// Where those checkouts are on that machine, by the same key, when known.
  final Map<String, String> folders;

  /// A laptop: it may sleep with the Product Manager on it.
  final bool maySleep;

  /// Why the Product Manager cannot start here whatever its state, or null.
  final String? unavailable;

  /// Why an engine cannot run a Product Manager here (not offered to the
  /// Swarm, not installed or signed in, no quota left, suspended), by engine.
  /// An engine not in it runs.
  final Map<String, String> engineRefusals;

  bool runs(String engine) => !engineRefusals.containsKey(engine);

  /// The Product Manager engines it runs, in [kLeadEngines] order.
  List<String> get leadEngines => [
    for (final engine in kLeadEngines)
      if (runs(engine)) engine,
  ];

  bool has(String? repository) {
    final key = leadRepositoryKey(repository);
    return key != null && repositories.contains(key);
  }

  /// It can start a Product Manager now, with one of [leadEngines].
  bool get startable =>
      unavailable == null &&
      online &&
      (freeAgents ?? 1) > 0 &&
      leadEngines.isNotEmpty;
}

/// The engines a Product Manager runs on: routing reads quota for these two.
const kLeadEngines = ['claude', 'codex'];

/// A Product Manager engine's name as people read it.
String leadEngineLabel(String engine) =>
    const {'claude': 'Claude Code', 'codex': 'Codex'}[engine] ?? engine;

/// Why each of [kLeadEngines] cannot run a Product Manager on a machine, from
/// what the Swarm reads of it: the engines it offers the Swarm ([offered],
/// null when not reported), each engine's install and sign-in as its host
/// reported them ([readiness], null for not known), its subscription windows'
/// use ([usedPercents], absent when unread) and the engines the server
/// suspended there after failed starts ([suspended], with why). What is not
/// known does not rule an engine out, as the route does not.
Map<String, String> leadEngineRefusals({
  Set<String>? offered,
  Map<String, ({bool? installed, bool? signedIn})> readiness = const {},
  Map<String, List<num>> usedPercents = const {},
  Map<String, String> suspended = const {},
}) => {
  for (final engine in kLeadEngines)
    engine: ?_engineRefusal(
      leadEngineLabel(engine),
      offered: offered == null || offered.contains(engine),
      readiness: readiness[engine],
      used: usedPercents[engine] ?? const [],
      suspended: suspended[engine],
    ),
};

String? _engineRefusal(
  String label, {
  required bool offered,
  required ({bool? installed, bool? signedIn})? readiness,
  required List<num> used,
  required String? suspended,
}) {
  if (!offered) return '$label isn’t offered here';
  if (readiness?.installed == false) return '$label isn’t installed';
  if (readiness?.signedIn == false) return '$label isn’t signed in';
  if (used.any((percent) => percent >= 100)) {
    return '$label has no quota left until it resets';
  }
  return suspended;
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

/// Best first: one the Product Manager can start on now (the person's own
/// before a teammate's, the Swarm's machines before the person's others,
/// always on with laptops that may sleep last, one this Desktop starts, with
/// [repository] already there, with the most room); then the ones it cannot
/// use yet (full), then unavailable ones, then offline ones.
List<LeadMachine> rankLeadMachines(
  Iterable<LeadMachine> machines,
  String? repository,
) {
  int tier(LeadMachine m) => m.startable
      ? 0
      : m.unavailable == null && m.online && m.leadEngines.isNotEmpty
      ? 1
      : m.online
      ? 2
      : 3;
  int flag(bool value) => value ? 0 : 1;
  return [...machines]..sort(
    (a, b) => [
      tier(a).compareTo(tier(b)),
      // The person's own first, as the Swarm places a waiting one.
      flag(a.own).compareTo(flag(b.own)),
      flag(a.inSwarm).compareTo(flag(b.inSwarm)),
      flag(!a.maySleep).compareTo(flag(!b.maySleep)),
      // Started by this Desktop: its files go in directly, its result is
      // known at once.
      flag(a.native).compareTo(flag(b.native)),
      flag(a.has(repository)).compareTo(flag(b.has(repository))),
      (b.freeAgents ?? 0).compareTo(a.freeAgents ?? 0),
      a.name.toLowerCase().compareTo(b.name.toLowerCase()),
    ].firstWhere((order) => order != 0, orElse: () => 0),
  );
}

/// A machine's row detail, in words, so colour is never the only signal.
String leadMachineDetail(LeadMachine machine, String? repository) {
  if (machine.unavailable case final why?) return why;
  if (!machine.online) return 'Offline';
  if (machine.leadEngines.isEmpty) {
    // One reason for both engines (a paused or offline machine) said once.
    return 'Can’t run a Product Manager: '
        '${{for (final engine in kLeadEngines) ?machine.engineRefusals[engine]}.join(', ')}';
  }
  final free = machine.freeAgents;
  if (free == null) return 'Online · Not in this Swarm';
  return [
    'Online',
    free <= 0
        ? 'No agents free'
        : '$free ${free == 1 ? 'agent' : 'agents'} free',
    if (free > 0 && machine.team) 'Team account',
    if (free > 0 && machine.has(repository)) 'Has repo',
    if (free > 0 && machine.maySleep) 'May sleep',
  ].join(' · ');
}

/// Why a paused Swarm's machines take no work, as its rows and the
/// Product Manager line say it.
const kLeadSwarmPaused = 'New work is paused in this Swarm';

/// The Swarm's model list (its routing policy) for a new project's Product
/// Manager: engines and models it turns off. Empty, it rules nothing out.
///
/// The owners' per-project rules (preferred engine, forbidden models) are not
/// read here: a new project has none until it is created.
class LeadModelList {
  const LeadModelList({
    this.disabledEngines = const {},
    this.disabledModels = const {},
    this.gridModels = true,
  });

  /// Engines the list has no enabled model of.
  final Set<String> disabledEngines;

  /// Models the list turns off at every effort, as (engine, model).
  final Set<(String, String)> disabledModels;

  /// Whether the list lets work run on models served on the Swarm's grid.
  final bool gridModels;

  /// Why the list rules [engine] out, or null.
  String? engineRefusal(String engine) => disabledEngines.contains(engine)
      ? 'The Swarm’s model list has no enabled ${_engineName(engine)} model.'
      : null;

  /// Why [engine] running [model] (null for its default) is ruled out, or
  /// null.
  String? refusal(String engine, String? model) {
    if (engineRefusal(engine) case final why?) return why;
    if (disabledModels.contains((engine, model ?? 'default'))) {
      return 'The Swarm’s model list turns off ${_engineName(engine)} '
          '${model ?? 'default model'}.';
    }
    return null;
  }

  /// Read from the Swarm's routing policy; null reads as an empty list.
  factory LeadModelList.of(Map<String, dynamic>? policy) {
    final byModel = <(String, String), bool>{};
    final byEngine = <String, bool>{};
    for (final row in policy?['models'] as List? ?? const []) {
      if (row case {
        'engine': final String engine,
        'model': final String model,
        'enabled': final bool enabled,
      }) {
        byModel[(engine, model)] =
            (byModel[(engine, model)] ?? false) || enabled;
        byEngine[engine] = (byEngine[engine] ?? false) || enabled;
      }
    }
    return LeadModelList(
      disabledEngines: {
        for (final MapEntry(:key, :value) in byEngine.entries)
          if (!value) key,
      },
      disabledModels: {
        for (final MapEntry(:key, :value) in byModel.entries)
          if (!value) key,
      },
      gridModels: switch (policy?['localModels']) {
        {'enabled': false} => false,
        _ => true,
      },
    );
  }
}

String _engineName(String engine) =>
    const {'claude': 'Claude', 'codex': 'Codex'}[engine] ?? engine;
