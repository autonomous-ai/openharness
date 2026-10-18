import 'dart:convert';
import 'dart:isolate';

import '../logging/app_log.dart';
import 'models.dart';
import 'snapshot_store.dart';

/// One machine as [MachineCache._parseDocument] reads it: what the launch uses, and its agents as the
/// daemon sent them, for the next save.
typedef _ParsedMachine = ({
  CachedMachine cached,
  List<Map<String, dynamic>> rawAgents,
});

/// The machines this account had at the end of the last run, so the next launch
/// can start dialling before `/api/machines` answers.
///
/// ⚠️ **A hint, never a source of truth.** The real list always arrives and
/// always wins: this exists only to fill the ~700ms round-trip during which the
/// app used to know nothing at all and could therefore do nothing at all. A
/// machine in here that the account no longer has is dropped the moment the
/// fetch lands, and one that was added on another device appears then too.
///
/// Only machines the account reported as UP are kept. A machine that was off
/// last time is the one case where acting on stale information costs something
/// real — a dial that opens a relay socket and then waits out its timeout
/// against a computer that is not there — and it is also the case the cache can
/// be most wrong about, because a machine's power state is exactly what changes
/// between two launches. Writing only the live ones means a wrong guess is the
/// cheap direction: at worst the phone waits for the fetch, which is what it did
/// before this existed.
///
/// It also remembers each machine's AGENTS, so the phone can draw its terminal —
/// with the right agent's name on it — while `agents_list` is still in flight.
/// The agents are kept exactly as the daemon sent them, so [Agent.fromJson] is
/// the only thing that ever parses that shape; a hand-written mirror of it would
/// drift the first time a field moved.
///
/// Stored beside the state file rather than in it ([SnapshotStore]): this is a
/// disposable cache with no secrets in it, and it must never take a turn in the
/// lock queue that the session token and the E2EE keys are waiting in.
class CachedMachine {
  const CachedMachine({
    required this.machine,
    required this.agents,
    required this.capabilities,
  });

  final Machine machine;

  /// What this machine last listed. Empty where the last run never got that far,
  /// which is simply a machine whose agents this launch waits for as before.
  final List<Agent> agents;

  /// The machine's last `terminal_capabilities` reply, or null where the last
  /// run never got one — see [MachineCache.rememberCapabilities].
  final Map<String, dynamic>? capabilities;
}

class MachineCache {
  /// [launchStore] defaults to a file only beside the default [store]: a caller that hands in its
  /// own store (every test) gets an empty launch record in memory, and so the launch it always had.
  MachineCache({SnapshotStore? store, SnapshotStore? launchStore})
    : _store = store ?? FileSnapshotStore('machines-cache'),
      _launchStore =
          launchStore ??
          (store == null
              ? FileSnapshotStore('machines-launch')
              : MemorySnapshotStore()),
      // Only beside the real files: a test's cache has no hint, so its launch reads as before.
      _hintStore = store == null ? FileSnapshotStore(_hintName) : null;

  /// The launch hint: the launch record's machine id and nothing else — see [preloadLaunchHint].
  static const _hintName = 'machines-launch-hint';
  final SnapshotStore? _hintStore;

  static String? _preloadedHint;
  static bool _hintPreloaded = false;

  /// Read the launch hint before the app's first frame — `startHarness` awaits this beside the
  /// preferences, so it costs the launch nothing it was not already waiting for.
  ///
  /// ⚠️ **Why (owner, 2026-10-02).** The launch's own machine was dialled only once the launch
  /// record had been read, and that read — like every other — finished only after the first frame,
  /// because building that frame holds the UI isolate for ~400ms on a debug build: measured, the
  /// dial went out at ~500ms with the file itself read in a few. The hint is a few dozen bytes,
  /// read before the frame, and the app dials from it at once (`AppNotifier._preDialFromHint`).
  /// It is written and cleared with the launch record, so it names the machine the record holds,
  /// and only ever this account's — signing out clears it first. Never throws.
  static Future<void> preloadLaunchHint() async {
    if (_hintPreloaded) return;
    _hintPreloaded = true;
    try {
      final raw = await FileSnapshotStore(_hintName).read();
      if (raw == null || raw.isEmpty) return;
      final decoded = jsonDecode(raw);
      if (decoded is! Map || decoded['version'] != _version) return;
      final machineId = decoded['machineId'];
      if (machineId is String && machineId.isNotEmpty) {
        _preloadedHint = machineId;
      }
    } on Object {
      // No hint is a launch that dials once the record is read, as it did.
    }
  }

  /// The machine [preloadLaunchHint] read, once — the launch that asks first takes it.
  static String? takeLaunchHint() {
    final hint = _preloadedHint;
    _preloadedHint = null;
    return hint;
  }

  final SnapshotStore _store;

  /// The launch record: the one machine the next launch reopens, in a document of its own — see
  /// [readLaunchRaw].
  ///
  /// ⚠️ **Why a second file (owner, 2026-10-02).** [_store] holds every agent of every machine,
  /// and the launch could draw nothing until all of it was read and parsed: 382KB for 167 agents,
  /// read in 0.5s and parsed in 0.76s on a debug Android build, and an account of seven to ten
  /// machines of fifty sessions each is three times that. The terminal on screen needs ONE
  /// machine's agents and capabilities. Written beside [_store], in the same write, so the two
  /// never describe different runs for longer than a crash between them.
  final SnapshotStore _launchStore;

  /// The last agent list seen for each machine, as the daemon sent it, awaiting
  /// the next [save].
  ///
  /// Held in memory rather than written on the spot: agent lists arrive one
  /// machine at a time, seconds apart, and a write per arrival would be several
  /// launches' worth of disk churn for a file only the NEXT launch reads. They
  /// go out with the machine list, which is written once per refresh.
  final Map<String, List<Map<String, dynamic>>> _agents = {};

  /// Writes run one at a time, in the order they were asked for.
  ///
  /// ⚠️ **[save] and [clear] race otherwise, and the loser is the file.** Both
  /// are started with `unawaited` — neither is worth making a person wait on —
  /// so a sign-out issued while a refresh's save is still in flight could leave
  /// that save landing AFTER the clear, and the next launch would warm-start
  /// into the machines of the account that just signed out. Queued, the last
  /// call asked for is the last one written.
  Future<void> _writes = Future.value();

  /// Bumped when the shape below changes. An older or newer document reads as no
  /// cache at all, which is always safe — the fetch fills it in.
  static const _version = 1;

  /// What the last run saw, or empty when there is nothing usable — [readRaw], then [parse].
  ///
  /// Never throws: a cache that cannot be read is a cache that is not there.
  Future<List<CachedMachine>> read() async {
    final raw = await readRaw();
    return raw == null ? const [] : parse(raw);
  }

  /// The cache file's text, unparsed — or null when there is none.
  ///
  /// Its own step so a launch can act on the text before paying for the parse: the machine to dial
  /// first is known from the last-opened record, and the text says whether this account still had it
  /// (`AppNotifier._warmStartMachines`). Never throws.
  Future<String?> readRaw() => _readFrom(_store);

  /// The launch record's text, unparsed, or null when there is none — [parseLaunch] reads it.
  Future<String?> readLaunchRaw() => _readFrom(_launchStore);

  /// [store]'s text once every write already asked for has landed — a read made while a sign-out's
  /// [clear] is queued would otherwise find the account that just left. Never throws.
  Future<String?> _readFrom(SnapshotStore store) async {
    try {
      await _writes;
      final raw = await store.read();
      return raw == null || raw.isEmpty ? null : raw;
    } on Object {
      return null;
    }
  }

  /// Below this many characters [parse] stays on the calling isolate: spawning one costs more than
  /// a small document does to parse.
  static const _parseOffThreadFrom = 64 * 1024;

  /// The machine in the launch record [raw], when it is [machineId] — reachable over the relay, and
  /// with [agentId] among its agents. Null for anything else, and nothing is kept from it then.
  ///
  /// ⚠️ **The agent has to be there, not just the machine.** The home screen opens on that agent,
  /// and with only this machine's agents to choose from it could not tell "deleted since" from
  /// "on a machine not read yet" — its fallback would pick from a partial list. Without the agent,
  /// the launch waits for the whole cache, as it always did. Never throws.
  Future<CachedMachine?> parseLaunch(
    String raw, {
    required String machineId,
    required String agentId,
  }) async {
    final parsed = await _parseOffThreadIfLarge(raw);
    if (parsed.length != 1) return null;
    final entry = parsed.single;
    final cached = entry.cached;
    if (cached.machine.machineId != machineId ||
        cached.machine.authMode != MachineAuthMode.remote ||
        !cached.agents.any((agent) => agent.id == agentId)) {
      return null;
    }
    _keep(parsed);
    return cached;
  }

  /// [raw] as the machines it lists. Never throws.
  ///
  /// ⚠️ **Parsed off the UI isolate once the file is large (owner, 2026-10-01).** Every agent of
  /// every machine is in here, verbatim, and the whole of it was decoded and turned into [Agent]s
  /// on the thread drawing the launch: measured at 273ms for 103 agents and 629ms for 131, during
  /// which the first frame and the dial both waited. The account the phone is built for has seven
  /// or eight machines of ten to twenty sessions each, which is worse again. Parsed in a background
  /// isolate, the work still takes as long, but nothing on screen waits for it; a small file is
  /// parsed in place, as before, since an isolate's start-up would cost more than it saves.
  Future<List<CachedMachine>> parse(String raw) async {
    final parsed = await _parseOffThreadIfLarge(raw);
    _keep(parsed);
    return [for (final entry in parsed) entry.cached];
  }

  static Future<List<_ParsedMachine>> _parseOffThreadIfLarge(String raw) async {
    if (raw.length < _parseOffThreadFrom) return _parseDocument(raw);
    try {
      return await Isolate.run(() => _parseDocument(raw));
    } on Object {
      // An isolate that would not start is a parse done here instead, never a cache lost.
      return _parseDocument(raw);
    }
  }

  /// [parsed], kept for the next [save], on this isolate — see [_agents] and [_capabilities].
  ///
  /// ⚠️ **Only where this run has learned nothing newer.** A parse finishes whenever it finishes,
  /// and on a large account a machine can answer its list before it does — the launch record lets
  /// the launch's machine dial ahead of the rest of the cache. Written over, that fresh list would
  /// go back to last run's, and the next save would write the old one out.
  void _keep(List<_ParsedMachine> parsed) {
    for (final entry in parsed) {
      final machineId = entry.cached.machine.machineId;
      _agents.putIfAbsent(machineId, () => entry.rawAgents);
      // Carried forward so a launch that reads the cache and is closed
      // before any machine answers still writes back what it knew.
      final capabilities = entry.cached.capabilities;
      if (capabilities != null) {
        _capabilities.putIfAbsent(machineId, () => capabilities);
      }
    }
  }

  /// The document in [raw], parsed — pure, so it can run on any isolate ([parse]). Empty for a
  /// document that is not this version's, or not one at all.
  static List<_ParsedMachine> _parseDocument(String raw) {
    try {
      final decoded = jsonDecode(raw);
      if (decoded is! Map<String, dynamic>) return const [];
      if (decoded['version'] != _version) return const [];
      final machines = decoded['machines'];
      if (machines is! List) return const [];
      final parsed = <_ParsedMachine>[];
      for (final item in machines) {
        if (item is! Map<String, dynamic>) continue;
        try {
          final machine = Machine.fromJson(item);
          final rawAgents = item['agents'];
          final agents = <Agent>[];
          if (rawAgents is List) {
            for (final entry in rawAgents) {
              if (entry is! Map<String, dynamic>) continue;
              try {
                agents.add(Agent.fromJson(entry));
              } on Object {
                // One unreadable agent is one agent this launch draws a second
                // later than it might have. Its machine still opens.
                continue;
              }
            }
          }
          final rawCaps = item['capabilities'];
          final capabilities = rawCaps is Map<String, dynamic> ? rawCaps : null;
          parsed.add((
            cached: CachedMachine(
              machine: machine,
              agents: agents,
              capabilities: capabilities,
            ),
            rawAgents: [
              for (final entry in (rawAgents is List ? rawAgents : const []))
                if (entry is Map<String, dynamic>) entry,
            ],
          ));
        } on Object {
          // One malformed entry does not discard the rest; the fetch will
          // correct whatever this cache got wrong either way.
          continue;
        }
      }
      return parsed;
    } on Object {
      return const [];
    }
  }

  /// Remember [agents] — the daemon's own JSON — as this machine's list.
  ///
  /// Kept until the next [save] writes it out. Passing an empty list is
  /// meaningful and is kept: a machine whose agents were all deleted should come
  /// back empty next launch, not with the ones it had before.
  void rememberAgents(String machineId, List<Map<String, dynamic>> agents) {
    _agents[machineId] = agents;
    _unsaved = true;
  }

  /// Whether a list or an agent was remembered since the last [save] — what a
  /// save made only to keep the file current asks first (`AppNotifier`'s
  /// background write), so an unchanged run writes nothing.
  bool get hasUnsaved => _unsaved;
  bool _unsaved = false;

  /// [agent] — one agent as the daemon sent it, in a push (`agent_synced`,
  /// `agent_created`) or a reply that carries one — put in place of the agent
  /// with its id in [machineId]'s list, or added at its end. Whether it was
  /// added is returned: a list that GREW is the one change the next launch
  /// cannot do without (see `AppNotifier`'s early save).
  ///
  /// ⚠️ **Why the list is amended between lists (owner, 2026-10-01).** It was
  /// only ever written when a machine answered `agents_list`, which a phone asks
  /// on connecting — so a harness made during a run was not in the file at the
  /// end of it, and the next launch, reopening exactly that harness, had no
  /// agent to draw a terminal for: it waited out the machine's whole list first.
  /// Measured on 2 of 7 launches, both straight after making a harness.
  ///
  /// The same object `agents_list` carries — one shape on the wire, built by
  /// one function in the CLI (`agentFrame.ts`) — so it is kept as it came. Not
  /// for a machine this run has neither read from the file nor listed: there is
  /// no list to amend, and one agent written as the whole of it would read back
  /// as a machine that has nothing else.
  bool rememberAgent(String machineId, Map<String, dynamic> agent) {
    final list = _agents[machineId];
    final id = agent['id'];
    if (list == null || id is! String || id.isEmpty) return false;
    // A fresh list rather than an edit: the one held may be the very list a
    // caller handed [rememberAgents], and it is not this class's to change.
    final next = List<Map<String, dynamic>>.of(list);
    final at = next.indexWhere((item) => item['id'] == id);
    if (at == -1) {
      next.add(agent);
    } else {
      next[at] = agent;
    }
    _agents[machineId] = next;
    _unsaved = true;
    return at == -1;
  }

  /// [agentId]'s name in [machineId]'s list changed — `agent_renamed`, which
  /// carries the name alone. A copy of its JSON with the new name; nothing for
  /// an agent the list does not have.
  void renameAgent(String machineId, String agentId, String name) {
    final list = _agents[machineId];
    if (list == null) return;
    final at = list.indexWhere((item) => item['id'] == agentId);
    if (at == -1 || list[at]['name'] == name) return;
    _agents[machineId] = List<Map<String, dynamic>>.of(list)
      ..[at] = {...list[at], 'name': name};
    _unsaved = true;
  }

  /// [agentId] is gone from [machineId] — deleted, or stopped and waiting for
  /// the next list to bring it back as such. Whether it was there is returned.
  bool forgetAgent(String machineId, String agentId) {
    final list = _agents[machineId];
    if (list == null) return false;
    final next = [
      for (final item in list)
        if (item['id'] != agentId) item,
    ];
    if (next.length == list.length) return false;
    _agents[machineId] = next;
    _unsaved = true;
    return true;
  }

  /// Remember a machine's `terminal_capabilities` reply, as the daemon sent it.
  ///
  /// ⚠️ **Only ever called with a reply that said the terminal IS available.**
  /// The point of keeping this is to let the next launch attach a terminal
  /// before the negotiation round-trip returns, and a remembered "unavailable"
  /// would instead make the next launch refuse to attach to a machine that may
  /// well be fine by then — a cache that can only do harm. A machine whose tmux
  /// really has gone simply negotiates as it always did, one round-trip in.
  void rememberCapabilities(String machineId, Map<String, dynamic> reply) =>
      _capabilities[machineId] = reply;

  /// See [rememberCapabilities]. Same lifetime as [_agents].
  final Map<String, Map<String, dynamic>> _capabilities = {};

  /// Replace the cache with the machines from a fetch that has just landed.
  ///
  /// Never throws and is never worth awaiting on a path a person is waiting on:
  /// a cache that failed to save costs the NEXT launch a few hundred
  /// milliseconds and costs this one nothing.
  ///
  /// [launchMachineId] is the machine the next launch reopens — what the launch record holds
  /// ([readLaunchRaw]). Absent, or not among the machines saved, the record is cleared, so it never
  /// names a machine the cache beside it does not.
  Future<void> save(
    Iterable<Machine> machines, {
    required bool Function(Machine) isOnline,
    String? launchMachineId,
  }) {
    // Built now, on the caller's turn, so the document written is the machine
    // list as it was when the save was ASKED for rather than whatever the list
    // has become by the time the queue reaches it. Only built — the agents in
    // it are the lists this class holds, which it replaces and never edits
    // (see [rememberAgent]), so encoding them later writes the same thing.
    var agentCount = 0;
    Map<String, Object?>? launchEntry;
    final entries = <Map<String, Object?>>[];
    for (final machine in machines.where(isOnline)) {
      final agents = _agents[machine.machineId];
      agentCount += agents?.length ?? 0;
      final entry = <String, Object?>{
        'machineId': machine.machineId,
        'computerId': machine.computerId,
        'authMode': machine.authMode.name,
        'engine': machine.engine,
        'name': machine.name,
        'hostname': machine.hostname,
        // Written as the status that got it in here. The reader treats
        // every cached machine as a candidate to dial, and the fetch
        // replaces this with the truth within the second.
        'status': machine.status,
        // The daemon's own agent JSON, verbatim — see the class comment.
        // Absent where this run never listed that machine's agents, which
        // reads back as a machine with no cached agents.
        'agents': ?agents,
        'capabilities': ?_capabilities[machine.machineId],
      };
      entries.add(entry);
      if (machine.machineId == launchMachineId) launchEntry = entry;
    }
    final document = {'version': _version, 'machines': entries};
    final launchDocument = launchEntry == null
        ? null
        : {
            'version': _version,
            'machines': [launchEntry],
          };
    final launchAgents = (launchEntry?['agents'] as List?)?.length ?? 0;
    // What was remembered is in [document] now, whichever write lands last.
    _unsaved = false;
    _launchAskedFor = (launchMachineId,);
    final generation = ++_generation;
    return _queue(() async {
      // ⚠️ **Only the newest save is written (owner, 2026-10-02).** Each machine's list asks for
      // one as it lands, and on a launch that lets several machines go at once that was a whole
      // encode of every agent on the account per machine, each bigger than the last. A save asked
      // for after this one holds everything this one does, and is in the queue behind it.
      if (generation != _generation) {
        _superseded++;
        return;
      }
      final clock = Stopwatch()..start();
      final text = await _encode(document, agentCount);
      final encodeMs = clock.elapsedMilliseconds;
      if (generation != _generation) {
        _superseded++;
        return;
      }
      await _store.write(text);
      final hint = _hintStore;
      if (launchDocument == null) {
        // The hint first: it is what a launch acts on before anything else is read.
        await hint?.clear();
        await _launchStore.clear();
      } else {
        await _launchStore.write(await _encode(launchDocument, launchAgents));
        // After the record it names, so a crash between the two leaves an older hint, which the
        // launch checks against the agent it reopens — never a hint ahead of its record.
        await hint?.write(
          jsonEncode({'version': _version, 'machineId': launchMachineId}),
        );
      }
      final skipped = _superseded;
      _superseded = 0;
      appLog.info(
        'cache',
        'machines-cache written · ${entries.length} machine(s), '
            '$agentCount agent(s), ${(text.length / 1024).round()}KB · '
            'encode ${encodeMs}ms '
            '${agentCount >= _encodeOffThreadFrom ? 'off-thread' : 'inline'} · '
            'launch ${launchDocument == null ? 'none' : '$launchAgents agent(s)'}'
            '${skipped > 0 ? ' · $skipped older save(s) skipped' : ''} · '
            'total ${clock.elapsedMilliseconds}ms',
      );
    });
  }

  /// Whether the launch record was last written for some machine other than [launchMachineId] —
  /// or not written at all this run. What a save made only to keep the file current asks
  /// (`AppNotifier`'s background write) beside [hasUnsaved]: a person who moved to another
  /// machine's agent changed nothing in any list, and the next launch would still find the
  /// record for the machine before.
  bool launchRecordStale(String? launchMachineId) {
    final asked = _launchAskedFor;
    return asked == null
        ? launchMachineId != null
        : asked.$1 != launchMachineId;
  }

  /// The launch machine the last [save] was asked to record, null inside when it was asked for
  /// none; null when nothing was saved this run.
  (String?,)? _launchAskedFor;

  /// Bumped by every [save] and [clear]: a queued save that finds it moved on has been replaced.
  int _generation = 0;

  /// Saves dropped for a newer one since the last write — for its log line.
  int _superseded = 0;

  /// From this many agents a document is encoded on a background isolate. Below it, spawning one
  /// costs more than the encode.
  static const _encodeOffThreadFrom = 40;

  /// [document] as JSON — off the UI isolate when it holds [agentCount] agents or more, since
  /// the whole account's agents encoded on it were a stall the screen could see.
  static Future<String> _encode(Object document, int agentCount) async {
    if (agentCount < _encodeOffThreadFrom) return jsonEncode(document);
    try {
      return await Isolate.run(() => jsonEncode(document));
    } on Object {
      // An isolate that would not start is an encode done here instead, never a cache lost.
      return jsonEncode(document);
    }
  }

  /// Forget everything — what signing out does, so the next account does not
  /// start by dialling the previous one's machines.
  Future<void> clear() {
    _agents.clear();
    _capabilities.clear();
    _unsaved = false;
    _launchAskedFor = null;
    // A save still waiting its turn was the account that is leaving.
    _generation++;
    // The hint and the launch record first: they are what a launch acts on before anything else.
    _preloadedHint = null;
    return _queue(() async {
      await _hintStore?.clear();
      await _launchStore.clear();
      await _store.clear();
    });
  }

  /// Run [write] after every write already asked for, swallowing its failure.
  Future<void> _queue(Future<void> Function() write) {
    final queued = _writes.then((_) async {
      try {
        await write();
      } on Object {
        // Best effort, exactly like the snapshot store's own contract: a cache
        // that failed to save costs the next launch a few hundred milliseconds.
      }
    });
    _writes = queued;
    return queued;
  }
}
