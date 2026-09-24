/// Data models mirroring the backend/web types.
library;

import 'agent_output_stats.dart';

enum MachineAuthMode { managed, remote, self, provider }

enum ConnectionStatus { disconnected, connecting, connected, reconnecting }

/// Current SSO identity returned by GET /api/auth/me.
class CurrentUserProfile {
  final String? id;
  final String? name;
  final String email;
  final String? avatarUrl;

  const CurrentUserProfile({
    this.id,
    this.name,
    required this.email,
    this.avatarUrl,
  });

  const CurrentUserProfile.local()
    : id = null,
      name = 'Local session',
      email = 'local terminal',
      avatarUrl = null;

  /// The stand-in for a local terminal session — not a person, so nothing
  /// should be named after it.
  bool get isLocalSession => id == null && email == 'local terminal';

  factory CurrentUserProfile.fromMe(Map<String, dynamic> response) {
    final rawUser = response['user'];
    if (rawUser is! Map) {
      throw const FormatException('missing user profile');
    }
    final user = Map<String, dynamic>.from(rawUser);
    final email = user['email'];
    if (email is! String || email.trim().isEmpty) {
      throw const FormatException('missing user email');
    }
    final rawName = user['name'];
    final rawAvatar = response['avatarUrl'];
    return CurrentUserProfile(
      id: user['id'] is String ? user['id'] as String : null,
      name: rawName is String && rawName.trim().isNotEmpty
          ? rawName.trim()
          : null,
      email: email.trim(),
      avatarUrl: rawAvatar is String && rawAvatar.trim().isNotEmpty
          ? rawAvatar.trim()
          : null,
    );
  }

  String get displayName => name ?? email;

  String get initials {
    final source = (name ?? email).trim();
    if (source.isEmpty) return '?';
    final words = source.split(RegExp(r'\s+')).where((word) => word.isNotEmpty);
    final chars = words.take(2).map((word) => word[0].toUpperCase()).join();
    return chars.isEmpty ? '?' : chars;
  }
}

/// Control-plane machine (GET /api/machines).
class Machine {
  final String machineId;

  /// Legacy fixture-only field. Production `/api/machines` no longer exposes machine API keys.
  final String apiKey;
  final String? computerId;
  final MachineAuthMode authMode;
  final String? engine;
  final String? name;
  final String? hostname;
  final String? status;

  const Machine({
    required this.machineId,
    this.apiKey = '',
    this.computerId,
    required this.authMode,
    this.engine,
    this.name,
    this.hostname,
    this.status,
  });

  String get displayName => (name != null && name!.isNotEmpty)
      ? name!
      : 'machine-${machineId.length > 8 ? machineId.substring(0, 8) : machineId}';

  factory Machine.fromJson(Map<String, dynamic> j) => Machine(
    machineId: j['machineId'] as String,
    apiKey: j['apiKey'] as String? ?? '',
    computerId: j['computerId'] as String?,
    authMode: MachineAuthMode.values.firstWhere(
      (m) => m.name == j['authMode'],
      orElse: () => MachineAuthMode.managed,
    ),
    engine: j['engine'] as String?,
    name: j['name'] as String?,
    hostname: j['hostname'] as String?,
    status: j['status'] as String?,
  );

  Machine copyWith({String? name}) => Machine(
    machineId: machineId,
    apiKey: apiKey,
    computerId: computerId,
    authMode: authMode,
    engine: engine,
    name: name ?? this.name,
    hostname: hostname,
    status: status,
  );
}

/// Data-plane agent (RPC agents_list).
/// What an agent with no name of its own is called — display only, never sent to a CLI as a rename.
const kUntitledPane = 'Untitled Pane';

final _automaticHarnessName = RegExp(
  r'^(?:(?:harness|agent)-[1-9]\d*|.+ harness \d{1,2}-\d{1,2} \d{1,2}:\d{2}(?::\d{2})?)$',
);

/// Whether [name] is one the CLI made up rather than one somebody chose — the desktop's rule.
bool isAutomaticHarnessName(String name) =>
    _automaticHarnessName.hasMatch(name);

class Agent {
  final String id;
  final String? sessionId;
  final String name;

  /// What the agent is on, in its own words — the transcript's title as the
  /// daemon cleaned it, null when it has none or it is the name already. A
  /// created agent keeps its `work · 3188` name while this moves with the work,
  /// so it is what tells two such agents apart on a phone.
  final String? title;

  /// When the conversation was last written — the transcript's mtime, which the
  /// daemon prefers over its own bookkeeping precisely so a client sorting by
  /// recency follows the work. Null from a daemon too old to send it.
  final DateTime? updatedAt;
  final String? engine;
  final String? engineDisplayName;
  final String? engineIconHint;
  final String? codexHome;

  /// The model a grid launch pinned (`qwen3-coder`, a llama.cpp GGUF), null when
  /// the agent is on its engine's own login or the engine chose.
  final String? gridModel;

  /// Whether the agent can search the web on that model, or null when the
  /// daemon said nothing — an agent on its own login, an older daemon, or a
  /// grid agent it merely discovered. Decided by the daemon when it built the
  /// launch and carried on every frame, so it is right after a reconnect or a
  /// restart without anything being replayed.
  final GridWebSearch? gridWebSearch;

  /// The runtime profile's model for this session (`gpt-5-codex`, `opus`), null
  /// when the daemon has none to report.
  final String? selectedModel;

  /// A domain-specific harness's display name ("Model manager"), null for a
  /// plain engine.
  final String? dshName;
  final String? parentAgentId;
  final AgentProject? project;
  final String status;
  final String launchState;
  final String? launchError;
  final String? launchDetail;
  final bool terminalAvailable;
  final String? terminalUnavailableReason;

  /// The conversation's token count as its machine last measured it — input, output and cached
  /// input together. Null from a daemon that does not report usage.
  final int? tokensUsed;
  final DateTime? tokensUpdatedAt;

  /// What the harness has produced — see [AgentOutputStats].
  final AgentOutputStats? outputStats;

  /// How much of this harness a resume brings back, as its daemon says per engine: `shell`,
  /// `conversation` or `fresh` (`cli/src/lib/resumeCapability.ts`). Null from a daemon older than
  /// the field.
  final String? resumeMode;

  const Agent({
    required this.id,
    this.sessionId,
    required this.name,
    this.title,
    this.updatedAt,
    this.engine,
    this.engineDisplayName,
    this.engineIconHint,
    this.codexHome,
    this.gridModel,
    this.gridWebSearch,
    this.selectedModel,
    this.dshName,
    this.parentAgentId,
    this.project,
    this.status = 'active',
    this.launchState = 'ready',
    this.launchError,
    this.launchDetail,
    this.terminalAvailable = false,
    this.terminalUnavailableReason,
    this.tokensUsed,
    this.tokensUpdatedAt,
    this.outputStats,
    this.resumeMode,
  });

  factory Agent.fromJson(Map<String, dynamic> j) {
    final terminal = j['terminal'];
    final terminalMap = terminal is Map
        ? Map<String, dynamic>.from(terminal)
        : const <String, dynamic>{};
    final runtimes = terminalMap['runtimes'] is List
        ? terminalMap['runtimes'] as List
        : const [];
    final hasTmux = runtimes.any(
      (runtime) => runtime is Map && runtime['backend'] == 'tmux',
    );
    final advertisedAvailable = terminalMap['available'];
    final terminalAvailable = advertisedAvailable is bool
        ? advertisedAvailable
        : hasTmux;
    final launchRaw = j['launch'];
    final launch = launchRaw is Map
        ? Map<String, dynamic>.from(launchRaw)
        : const <String, dynamic>{};
    final launchState = switch (launch['state']) {
      'starting' => 'starting',
      'failed' => 'failed',
      _ => 'ready',
    };
    final grid = j['grid'];
    // The desktop's reading of `tokenUsage`: the total alone, and nothing at all for a value no
    // JavaScript number could have held.
    final usage = j['tokenUsage'];
    final tokens = usage is Map ? wireCount(usage['totalTokens']) : null;
    return Agent(
      id: j['id'] as String,
      sessionId: _safeLabel(j['sessionId']),
      name: j['name'] as String? ?? 'agent',
      title: _safeLabel(j['title']),
      updatedAt: _safeTime(j['updatedAt']),
      engine: _safeEngine(j['engine']),
      engineDisplayName: _safeLabel(j['engineDisplayName']),
      engineIconHint: _safeLabel(j['engineIconHint']),
      codexHome: j['engine'] == 'codex' ? _safeCodexHome(j['codexHome']) : null,
      gridModel: grid is Map ? _safeLabel(grid['model']) : null,
      gridWebSearch: grid is Map
          ? GridWebSearch.fromWire(grid['webSearch'])
          : null,
      selectedModel: _safeLabel(j['selectedModel']),
      dshName: _safeLabel(j['dshName']),
      parentAgentId: _safeLabel(j['parentAgentId'] ?? j['parentId']),
      project: AgentProject.fromJson(j['project']),
      status: (j['status'] as String?) ?? 'active',
      launchState: launchState,
      launchError: launchState == 'failed' ? _safeLabel(launch['error']) : null,
      launchDetail: launchState == 'failed'
          ? _safeDetail(launch['detail'])
          : null,
      terminalAvailable: terminalAvailable,
      terminalUnavailableReason: terminalAvailable
          ? null
          : _safeLabel(terminalMap['reason']) ??
                'terminal unavailable (no verified terminal pane)',
      tokensUsed: tokens,
      tokensUpdatedAt: tokens != null && usage is Map
          ? _safeTime(usage['updatedAt'])
          : null,
      outputStats: AgentOutputStats.fromJson(j['outputStats']),
      resumeMode: _safeResumeMode(j['resumeMode']),
    );
  }

  Agent copyWith({String? name}) => Agent(
    id: id,
    sessionId: sessionId,
    name: name ?? this.name,
    title: title,
    updatedAt: updatedAt,
    engine: engine,
    engineDisplayName: engineDisplayName,
    engineIconHint: engineIconHint,
    codexHome: codexHome,
    gridModel: gridModel,
    gridWebSearch: gridWebSearch,
    selectedModel: selectedModel,
    dshName: dshName,
    parentAgentId: parentAgentId,
    project: project,
    status: status,
    launchState: launchState,
    launchError: launchError,
    launchDetail: launchDetail,
    terminalAvailable: terminalAvailable,
    terminalUnavailableReason: terminalUnavailableReason,
    tokensUsed: tokensUsed,
    tokensUpdatedAt: tokensUpdatedAt,
    outputStats: outputStats,
    resumeMode: resumeMode,
  );

  /// Saved work the daemon is no longer running, as the desktop's [Agent] reads
  /// it. Its conversation is on disk; `agent_resume` brings it back.
  ///
  /// ⚠️ **Only ever set on a machine the app asked `includeStopped: true` of.**
  /// The daemon's plain `agents_list` answers with `registry.advertised()` —
  /// live agents only — so a client that does not ask sees a fleet with its
  /// stopped work silently missing, which is exactly what this app did.
  bool get isStopped => status == 'stopped';

  /// Whether a row has anything to put on its stats line — see [AgentOutputStats].
  bool get hasMonitorStats =>
      tokensUsed != null || (outputStats != null && !outputStats!.isEmpty);

  /// The name a row draws — the desktop's `displayName`, so an agent reads the same on both.
  ///
  /// A name the CLI made up (`harness-3`, `Claude harness 9-23 13:52`) says only when it was
  /// started; the agent's own title says what it is about, and with neither the desktop writes
  /// [kUntitledPane]. A name somebody chose is always kept.
  String get displayName {
    if (!isAutomaticHarnessName(name)) return name;
    final own = title?.trim();
    return own != null && own.isNotEmpty ? own : kUntitledPane;
  }

  /// Whether the saved conversation itself can be reopened — the desktop's rule for a daemon that
  /// predates [resumeMode]: exact resume for Claude Code and Codex, once the engine saved a session.
  bool get canResumeConversation =>
      (engine == 'claude' || engine == 'codex') &&
      sessionId?.isNotEmpty == true;

  /// Whether stopped work can be brought back at all — the desktop's `canPauseAndResume`.
  ///
  /// ⚠️ **The daemon decides, per engine ([resumeMode]).** Every engine resumes on a current one —
  /// some as a new conversation ([resumesFreshConversation]) — so reading [canResumeConversation]
  /// alone greyed out work the machine would bring back, as "Resume unavailable". The fallback is
  /// for a daemon too old to say: the old rule, so it is never offered a resume it refuses.
  bool get canPauseAndResume =>
      resumeMode != null || engine == 'terminal' || canResumeConversation;

  /// Whether a resume opens a NEW conversation rather than the paused one: the engine has no resume
  /// argv (`fresh`), or nothing recorded a conversation to reopen. A different session id after
  /// such a resume is the machine doing as it was told.
  bool get resumesFreshConversation =>
      resumeMode == 'fresh' ||
      (resumeMode == 'conversation' && (sessionId?.isEmpty ?? true));

  static String? _safeResumeMode(Object? raw) =>
      raw is String && const {'shell', 'conversation', 'fresh'}.contains(raw)
      ? raw
      : null;

  static String? _safeEngine(Object? raw) {
    if (raw is! String || raw.isEmpty || raw.length > 64) return null;
    return RegExp(r'^[a-zA-Z0-9._-]+$').hasMatch(raw) ? raw : null;
  }

  static String? _safeCodexHome(Object? raw) {
    if (raw is! String ||
        !raw.startsWith('/') ||
        raw.length > 4096 ||
        RegExp(r'[\x00-\x1f\x7f]').hasMatch(raw)) {
      return null;
    }
    return raw;
  }

  static String? _safeLabel(Object? raw) {
    if (raw is! String || raw.isEmpty) return null;
    return raw.length <= 80 ? raw : raw.substring(0, 80);
  }

  static DateTime? _safeTime(Object? raw) =>
      raw is String && raw.length <= 64 ? DateTime.tryParse(raw) : null;

  static String? _safeDetail(Object? raw) {
    if (raw is! String || raw.isEmpty) return null;
    final clean = raw.replaceAll(RegExp(r'[\u0000-\u001f\u007f]'), ' ').trim();
    if (clean.isEmpty) return null;
    return clean.length <= 500 ? clean : clean.substring(0, 500);
  }
}

/// What the daemon answered when asked where a typed task belongs (⌘B).
///
/// `candidates` is the pick followed by EVERY other agent the daemon weighed — ranked where the router
/// ranked them, in rail order after that. Not a shortlist: when the router is unsure the right agent is
/// often the one it put fourth, and a picker that cannot show it leaves no way forward but Esc.
/// The window reads it only when `confidence` is too low to act on — the whole point of the number
/// being on the wire.
class RouteAnswer {
  const RouteAnswer({
    required this.agentId,
    required this.machineId,
    required this.name,
    required this.confidence,
    required this.reason,
    required this.candidates,
    this.weighed = 0,
    this.machines = 0,
    this.via = '',
  });

  final String agentId;

  /// Which computer the pick lives on. Names are for reading; this is what opens the pane.
  final String machineId;
  final String name;
  final double confidence;
  final String reason;
  final List<RouteCandidate> candidates;

  /// How many agents were weighed, and across how many computers.
  ///
  /// Shown WHILE the router thinks, because the question during those seconds is not "how long" — it is
  /// "did it even look at the agent I mean". The daemon caps the list it weighs, so this is the only
  /// place that can answer it.
  final int weighed;
  final int machines;

  /// 'model' when a classifier answered, 'heuristic' when name matching stood in for it, '' when the
  /// daemon did not say.
  ///
  /// Both land under the threshold BY DESIGN — an unsure model and a router that could not run must both
  /// stop and ask — which is exactly why the window needs to tell them apart: "not sure which agent" and
  /// "the router could not run" send a person to different next moves.
  final String via;

  /// True when nobody was picked at all — an empty machine, or a daemon that could not answer.
  bool get isEmpty => agentId.isEmpty;

  /// Read with `is`, never with `as`.
  ///
  /// `json['x'] as String?` does not answer null for a number — it THROWS, and this frame crosses a
  /// socket, so the shape is whatever the other end sent. An exception here surfaces as a palette
  /// spinner that never comes down, which is the one failure the person cannot act on. A malformed field
  /// has to read as "nobody was picked" instead.
  static RouteAnswer fromJson(Map<String, dynamic> json) => RouteAnswer(
    agentId: _str(json['agentId']),
    machineId: _str(json['machineId']),
    name: _str(json['name']),
    confidence: json['confidence'] is num
        ? (json['confidence'] as num).toDouble()
        : 0,
    reason: _str(json['reason']),
    weighed: json['weighed'] is num ? (json['weighed'] as num).toInt() : 0,
    machines: json['machines'] is num ? (json['machines'] as num).toInt() : 0,
    via: _str(json['via']),
    candidates: [
      for (final entry
          in (json['candidates'] is List
              ? json['candidates'] as List<dynamic>
              : const []))
        if (entry is Map<String, dynamic>) RouteCandidate.fromJson(entry),
    ],
  );
}

class RouteCandidate {
  const RouteCandidate({
    required this.agentId,
    required this.machineId,
    required this.name,
    required this.machine,
    required this.recent,
    this.engine = '',
    this.confidence = 0,
  });

  final String agentId;

  /// Which computer to open the pane on. Names are for reading; this is for acting.
  final String machineId;
  final String name;

  /// Which computer it runs on. The candidate list spans every machine, so two agents named "api" on two
  /// of them are the same row twice without this.
  final String machine;

  /// What that agent was last doing — the line under its name when the window has to ask.
  final String recent;

  /// Which CLI it runs on. The picker wears the same engine mark the rail does, so a row here and the
  /// same agent in the rail are recognisably one thing rather than two lists that happen to share names.
  final String engine;

  /// How well the router thought this one fits, 0..1. DISPLAY ONLY.
  ///
  /// Nothing is dispatched on it — the pick is [RouteAnswer.agentId] and the number that gates it is
  /// [RouteAnswer.confidence]. 0 means the router said nothing about this candidate, and the picker
  /// draws no bar rather than an empty one, because an empty bar reads as "no fit" and this is "no
  /// answer".
  final double confidence;

  static RouteCandidate fromJson(Map<String, dynamic> json) => RouteCandidate(
    agentId: _str(json['agentId']),
    machineId: _str(json['machineId']),
    name: _str(json['name']),
    machine: _str(json['machine']),
    recent: _str(json['recent']),
    engine: _str(json['engine']),
    confidence: json['confidence'] is num
        ? (json['confidence'] as num).toDouble().clamp(0, 1)
        : 0,
  );
}

String _str(Object? value) => value is String ? value : '';

/// How a checkout on no branch reports itself, `Detached 65281563` (`cli/src/lib/agentProject.ts`).
const kDetachedBranchPrefix = 'Detached ';

/// Context reported by the owning daemon. Missing on older daemons.
class AgentProject {
  const AgentProject({
    required this.name,
    required this.cwd,
    this.root,
    this.remote,
    this.branch,
    this.branchPending = false,
  });
  final String name;
  final String cwd;
  final String? root;
  final String? remote;
  final String? branch;

  /// [branch] is still the name Harness made up at Start; it is shown once the session's name
  /// replaces it.
  final bool branchPending;

  String identity(String machineId) =>
      remote != null ? 'repo:$remote' : 'folder:$machineId:${root ?? cwd}';

  /// The folder as the person chose it — the desktop's `AgentProject.label`: inside a Git checkout,
  /// a subfolder shows as itself and the checkout's root as its repository ([name]), even when the
  /// checkout is a temporary worktree. Outside Git it is [name], the folder itself.
  ///
  /// ⚠️ **Not the tail of [cwd].** A worktree's folder is `worktree-35…`, a name Harness made up;
  /// the repository it belongs to is what the desktop shows, and what somebody recognises.
  String get label {
    final checkout = root;
    if (checkout == null) return name;
    String trimmed(String path) => path.replaceFirst(RegExp(r'[/\\]+$'), '');
    if (trimmed(checkout) == trimmed(cwd)) return name;
    return cwd
            .split(RegExp(r'[/\\]'))
            .where((part) => part.isNotEmpty)
            .lastOrNull ??
        name;
  }

  /// The branch, or null when the daemon reported none or reported it blank.
  String? get branchLabel {
    final trimmed = branch?.trim();
    return trimmed == null || trimmed.isEmpty ? null : trimmed;
  }

  /// On a commit rather than a branch: an agent reading or testing one.
  bool get detached => branch?.startsWith(kDetachedBranchPrefix) == true;

  /// The branch worth showing beside [label] — the desktop's `shownBranch`: none while Harness's
  /// made-up name waits for the session's, and none on no branch at all. [branchLabel] stays the
  /// searchable one.
  String? get shownBranch => branchPending || detached ? null : branchLabel;

  /// The branch as a tooltip says it, whatever [shownBranch] leaves out.
  String? get branchDetail => switch (branchLabel) {
    null => null,
    final branch when detached =>
      'No branch: on commit ${branch.substring(kDetachedBranchPrefix.length)}',
    final branch => 'Branch: $branch',
  };

  @override
  bool operator ==(Object other) =>
      other is AgentProject &&
      name == other.name &&
      cwd == other.cwd &&
      root == other.root &&
      remote == other.remote &&
      branch == other.branch &&
      branchPending == other.branchPending;
  @override
  int get hashCode =>
      Object.hash(name, cwd, root, remote, branch, branchPending);

  static AgentProject? fromJson(Object? raw) {
    if (raw is! Map) return null;
    String? field(String key, [int max = 4096]) {
      final v = raw[key];
      return v is String &&
              v.isNotEmpty &&
              v.length <= max &&
              !RegExp(r'[\x00-\x1f\x7f]').hasMatch(v)
          ? v
          : null;
    }

    final name = field('name', 256);
    final cwd = field('cwd');
    if (name == null || cwd == null) return null;
    return AgentProject(
      name: name,
      cwd: cwd,
      root: field('root'),
      remote: field('remote'),
      branch: field('branch', 256),
      branchPending: raw['branchPending'] == true,
    );
  }
}

/// Whether an agent on a Local model can search the web, as the daemon decided
/// when it built the launch (`grid.webSearch` on the agent frame).
///
/// Three words, each a different fact for the person reading the picker: `on`
/// needs no sentence; `unavailable` means the daemon could not obtain the
/// web-tools configuration this time (an outdated CLI, no sign-in) and moving
/// the agent again may fix it; `unsupported` means the engine cannot take the
/// tools on this machine at all (Pi has no MCP client; Hermes under a
/// system-managed install), and nothing about the model changes that.
enum GridWebSearch {
  on,
  unavailable,
  unsupported;

  /// The one sentence shown for a degraded status, or null when there is
  /// nothing to say.
  String? get sentence => switch (this) {
    GridWebSearch.on => null,
    GridWebSearch.unavailable => 'Web search unavailable',
    GridWebSearch.unsupported => 'Web search not supported by this engine',
  };

  /// The wire word, or null for anything else — an older daemon sends no field,
  /// and a newer one might send a fourth word this build should neither print
  /// verbatim nor guess at.
  static GridWebSearch? fromWire(Object? raw) => switch (raw) {
    'on' => GridWebSearch.on,
    'unavailable' => GridWebSearch.unavailable,
    'unsupported' => GridWebSearch.unsupported,
    _ => null,
  };
}

/// One model a harness grid can answer right now.
class GridModel {
  /// The id an engine is pointed at, verbatim from the grid.
  final String id;

  /// Which machine serves it. Display only, and empty when the grid does not
  /// say — on a private grid this is one of the user's own computers, which is
  /// the useful part of the answer.
  final String node;

  /// The grid it is served on — the section it was listed under. Null on an
  /// older daemon that sends only the own grid's list, which the retarget then
  /// targets as it always did.
  final String? grid;

  const GridModel({required this.id, required this.node, this.grid});
}

/// Which `grid` a machine would run, as its daemon reports beside the model
/// list (`gridCli`).
///
/// `managed` is the runtime Harness itself carries and pins; `path` is one the
/// person installed (runnable, but not the pin); `missing` is nothing to run —
/// the one value that changes what the picker says, because an agent moved
/// onto a Local model there would die on its first `grid`. An older daemon
/// sends no field, read as null: nothing is claimed either way.
enum GridCli {
  managed,
  path,
  missing;

  static GridCli? parse(Object? raw) => switch (raw) {
    'managed' => GridCli.managed,
    'path' => GridCli.path,
    'missing' => GridCli.missing,
    _ => null,
  };
}

/// One grid the machine is signed into, with what it serves. [own] marks the
/// account's private grid — the picker calls that one "Local models on your
/// machines"; a shared grid goes by its name.
class GridSection {
  final String name;
  final bool own;
  final List<GridModel> models;

  const GridSection({
    required this.name,
    required this.own,
    required this.models,
  });
}

/// The picker's whole answer: which grids were asked, and what they offer.
///
/// `gridName` is null when the machine has no grid yet — told apart from "a
/// grid with nothing on it", because the two need different sentences in front
/// of a person.
class GridModels {
  final String? gridName;
  final List<GridModel> models;

  /// Every grid the machine is signed into, own grid first, each with its live
  /// models — the picker's sections. Empty on an older daemon, which sends only
  /// [models] for the own grid; the picker then draws that one section.
  final List<GridSection> grids;

  /// The engines a Local model can be offered to at all, as the daemon on that
  /// machine names them (`localModelEngines`). Null when the daemon is older
  /// and sends no such list — read as "offer everything", the behaviour before.
  final Set<String>? localModelEngines;

  /// Which `grid` the machine would run — see [GridCli]. Null when the daemon
  /// is older and does not say, which claims nothing.
  final GridCli? gridCli;

  /// Did the machine ANSWER? False when the request failed — offline, timed
  /// out, or a daemon too old to know the call.
  ///
  /// Kept apart from `gridName == null` because the two mean opposite things to
  /// a person. "This account has no grid" is a fact worth acting on; "we could
  /// not ask" is not a fact about the account at all, and a UI that folds them
  /// together tells a signed-in user to sign in again.
  final bool reachable;

  const GridModels({
    required this.gridName,
    required this.models,
    this.grids = const [],
    this.localModelEngines,
    this.gridCli,
    this.reachable = true,
  });

  /// The machine could not be asked. Says nothing about the account, because
  /// nothing is known — including which engines it would have offered, or
  /// whether it has a `grid`.
  const GridModels.unreachable()
    : gridName = null,
      models = const [],
      grids = const [],
      localModelEngines = null,
      gridCli = null,
      reachable = false;

  /// The sections to draw: [grids] when the daemon sent them, else the own grid
  /// alone.
  List<GridSection> get sections => grids.isNotEmpty
      ? grids
      : [
          if (gridName != null)
            GridSection(name: gridName!, own: true, models: models),
        ];

  /// Whether [engine] may be pointed at one of [models]: unknown engines are
  /// refused only when the daemon gave a list — a picker that guessed would
  /// refuse the wrong ones on an older daemon.
  bool canRunLocally(String? engine) {
    final capable = localModelEngines;
    if (capable == null) return true;
    final id = engine?.trim().toLowerCase();
    return id != null && capable.contains(id);
  }
}
