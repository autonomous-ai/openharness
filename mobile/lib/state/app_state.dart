import 'dart:async';
import 'dart:math' show Random;

import 'package:dio/dio.dart';
import 'package:xterm/xterm.dart' show Terminal;
import 'package:flutter/foundation.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

import '../teams/team_controller.dart';
import '../api/api_client.dart';
import '../viewer/direct_auth_api.dart';
import '../viewer/direct_link.dart';
import '../viewer/group_sync.dart';
import '../e2ee/bytes.dart' show b64e;
import '../viewer/viewer_services.dart';
import '../auth/auth_session.dart';
import '../auth/peer_link_client.dart';
import '../auth/sign_in_client.dart';
import '../auth/cli_link.dart';
import '../core/config.dart';
import '../core/agent_git_context.dart';
import '../core/agent_preference.dart';
import '../core/engine_availability.dart';
import '../core/device_name.dart';
import '../core/permission_modes.dart';
import '../core/last_opened_agent.dart';
import '../core/phone_search_history.dart';
import '../core/machine_cache.dart';
import '../core/models.dart';
import '../core/project_folder.dart';
import '../core/project_history.dart';
import '../core/retry.dart';
import '../logging/app_log.dart';
import '../logging/startup_trace.dart';
import '../notify/agent_announcer.dart';
import '../notify/done_notice.dart';
import '../notify/system_notices.dart';
import '../settings/config_store.dart';
import '../stats/harness_stats.dart';
import '../terminal/terminal_session.dart';
import '../terminal/remote_media_download.dart';
import '../widgets/engine_identity.dart' show allEngines, engineIdentity;
import 'dial_status.dart';
import 'retarget_refusal.dart';
import 'pane_layout_store.dart';
import 'session_preview.dart';
import 'terminal_pane.dart';
import 'desk_sync.dart';
import 'phone_desk.dart';
import '../daemons/daemon_habits.dart';
import '../daemons/individual_art.dart';
import '../daemons/zoo_client.dart';
import 'swarm.dart';
import '../terminal/terminal_binary.dart';
import '../ws/ws_conn.dart';
import '../ws/ws_pool.dart';
import 'pending_question.dart';
import 'search_when.dart';
import 'session_content_search.dart';
import '../usage/remote_usage.dart';
import '../usage/usage_accounts.dart';
import '../phone/phone_name_store.dart';
import '../viewer/device_log.dart';
import '../viewer/device_history.dart';
import '../viewer/device_log_sync.dart';

enum AppStatus { bootstrapping, unauthenticated, authenticated }

enum AgentLoadStatus { idle, needsLink, loading, loaded, error }

/// Result of [AppNotifier.restartAgent]. [error] null means the RPC succeeded; [resumed] then says
/// whether the daemon reattached the agent's prior session or fell back to a fresh one (e.g. the
/// engine's resume flag wasn't recognized) — worth telling the user about, since it's not a failure
/// but the conversation may not have continued the way "Restart" implies.
class RestartAgentResult {
  final String? error;
  final bool resumed;

  const RestartAgentResult({this.error, this.resumed = true});
}

/// One deliberate creation, retained by the form if its reply is lost. Reusing
/// it checks the original request; opening New agent starts a fresh intent.
/// The id a lifecycle request is checked by when its reply is lost — see `agent_create_status`.
String _newReceiptId() {
  final random = Random.secure();
  return List.generate(
    16,
    (_) => random.nextInt(256),
  ).map((byte) => byte.toRadixString(16).padLeft(2, '0')).join();
}

class AgentCreationAttempt {
  AgentCreationAttempt() : _id = _newReceiptId();

  final String _id;
  String? _machineId, _targetId;
  Map<String, dynamic>? _choices;
  Future<String?>? _inFlight;
  bool _awaitingConfirmation = false, _finished = false;
  String? _outcome;
  String? _agentId;

  bool get awaitingConfirmation => _awaitingConfirmation;

  /// The agent this attempt started, once the machine has confirmed it.
  ///
  /// The form that asked for an agent is the one screen that knows it was just
  /// asked for, so it is the one that can open it. Without this the id is known
  /// only inside the notifier, and the new agent has to be found again in the
  /// list — a step nobody wants after naming a folder and an engine.
  String? get agentId => _agentId;

  String? _complete(String? error) {
    _finished = true;
    _awaitingConfirmation = false;
    return _outcome = error;
  }
}

class MachineState {
  Machine machine;
  ConnectionStatus connectionStatus = ConnectionStatus.disconnected;
  // Set when the local CLI's relay reports NO_PEER_LINK for this (non-local) machine — it needs
  // `harness link connect <machineId>` (the other machine's remote password) before it can
  // connect. The CLI owns E2EE entirely now; this is just "is trust established yet", not a
  // crypto/pairing state the app has any data for.
  bool needsLink = false;
  List<Agent> agents = [];

  /// True while [agents] came from the last run's cache rather than from this
  /// machine ([MachineCache], `_warmStartMachines`).
  ///
  /// ⚠️ **What it marks is a list that may name an agent that no longer
  /// exists** — one deleted from another device since this phone last looked.
  /// The names are good enough to draw a terminal around immediately, which is
  /// the whole point; what they cannot do is be trusted as the final word, so
  /// the terminal an agent from here opens says so if the machine disowns it.
  ///
  /// Cleared by `_replaceAgents`, i.e. by the first real `agents_list` — from
  /// that moment the list is the machine's own and nothing is provisional.
  bool agentsFromCache = false;

  AgentLoadStatus agentLoadStatus = AgentLoadStatus.idle;
  bool agentsRefreshing = false;
  String? agentsLoadError;
  Future<void>? agentsLoadInFlight;
  Future<void>? terminalCapabilityLoadInFlight;
  String? activeAgentId;
  bool terminalCapabilityLoaded = false;
  bool terminalCapabilityAvailable = false;
  String? terminalCapabilityError;

  /// The negotiation got no answer — a timeout, a dropped socket — rather than the machine saying
  /// no. That is not a fact about the machine, so the next sync that does get an answer asks again
  /// (see `_syncAgentsIfChanged`); a refusal or `available: false` is an answer, and stands.
  bool terminalCapabilityUnanswered = false;
  // Whether this machine's CLI daemon understands `terminal_paste` (a clipboard paste delivered as
  // one atomic tmux paste-buffer, not chunked like ordinary keystrokes — see TerminalSession.pasteText).
  // False for any CLI published before this existed; the panel falls back to the old chunked path.
  bool terminalPasteRawAvailable = false;
  // Whether this machine's CLI daemon understands TerminalBinaryKind.imagePaste (a native clipboard
  // IMAGE paste — see TerminalSession.pasteImage). False for any CLI published before this existed;
  // the panel falls back to forwarding a bare Ctrl+V, today's only option for an image paste.
  bool terminalImagePasteAvailable = false;
  // Whether this machine's CLI daemon understands TerminalBinaryKind.pasteFile (a dropped non-image
  // file, written to disk on that machine and pasted as a path — see TerminalSession.pasteFile).
  // Only consulted for a REMOTE pane; a local one pastes its own path directly and never needs this.
  bool terminalPasteFileAvailable = false;
  bool mediaPreviewAvailable = false;
  // Whether this machine's CLI understands `projectSource` on agent_create — a folder it makes or
  // clones for itself, rather than one the client names with `cwd`.
  //
  // ⚠️ False is not "the feature is off", it is "this machine would MISREPORT the failure". An
  // older CLI ignores the keys, finds no `cwd`, and refuses with INVALID_CWD — which reaches the
  // person as "the project folder is unavailable, choose another folder", advice about a folder
  // they never chose and that has nothing to do with what went wrong.
  bool projectFolderAvailable = false;
  // Whether this machine's CLI honours `takeover: false` on `terminal_open` — open only a terminal
  // no other app is driving, refused with CONTROL_LEASE_HELD otherwise. See
  // [TerminalSession.takeover].
  //
  // ⚠️ False is not "opens are polite anyway", it is the opposite: an older CLI ignores the key and
  // takes the terminal over like any other open. So nothing may be opened AHEAD of a person on a
  // machine that does not say this — see [AppNotifier.warmAgentPane].
  bool terminalNoTakeoverAvailable = false;
  // Which engines this machine actually has, as this machine answered it. Kept
  // on MachineState rather than globally because that is the whole point: two
  // machines on one account hold different engines, and the Docker rig holds
  // exactly one. See `engines_probe` in the CLI's backendSocket.
  final MachineEngines engines = MachineEngines();
  // Adapter/manager presence for this machine, from `node_status` pushes —
  // distinct from `connectionStatus`, which only reflects OUR websocket to
  // the backend. null = not seen yet (initial connect).
  bool? nodeOnline;
  // The agent the user selected while the Harness adapter was offline. Keep
  // this separate from activeAgentId so the UI can show a join guide without
  // opening a terminal stream against an unavailable node.
  String? pendingOfflineAgentId;
  final Set<String> processingAgentIds = {};

  /// When this app last SAW each agent's conversation move — a turn starting,
  /// beating or ending on this socket — by agentId.
  ///
  /// Newer than [Agent.updatedAt] whenever the machine has not re-sent that
  /// agent since, which is the normal case: the daemon pushes an agent when the
  /// agent changes, not on every turn. Without this, an agent somebody had just
  /// talked to kept the age of its last list fetch and sank below idle ones the
  /// moment its turn ended.
  final Map<String, DateTime> agentActivityAt = {};

  /// Agents on this machine that have stopped to ask something, by agentId.
  /// At most one per agent: a pane shows one dialog at a time, and the daemon
  /// re-announces the same open question rather than queueing a second.
  final Map<String, PendingQuestion> blockedAgents = {};
  final Map<String, String> sessionAgentIds = {};
  // Turn events can arrive while the initial agents_list RPC is still in
  // flight. Retain session correlation until that snapshot binds the row.
  final Set<String> pendingProcessingSessions = {};

  MachineState(this.machine);

  bool get isRemote => machine.authMode == MachineAuthMode.remote;

  Agent? get activeAgent {
    for (final agent in agents) {
      if (agent.id == activeAgentId) return agent;
    }
    return null;
  }
}

/// What every `agents_list` asks for.
///
/// ⚠️ **`includeStopped` is not optional polish — without it the fleet is
/// silently incomplete.** The daemon answers a plain `agents_list` with
/// `registry.advertised()`, which is live agents only, and adds saved-but-
/// stopped work only when asked (`cli/src/backendSocket.ts`, `agents_list`).
/// This app did not ask, so a machine with nine stopped harnesses reported
/// none of them and the phone showed a different fleet than the desktop on the
/// same account — for the search, the Agents tab and every count drawn off them.
///
/// The daemon ignores the flag for the hardware dial (`sessionRole == 'device'`);
/// this app pairs as `'web'`, so it is honoured here.
const kAgentsListPayload = {'includeStopped': true};

/// Who asked for a terminal to be opened.
///
/// A terminal has ONE controller and an ordinary `terminal_open` wins it, so
/// every attach has to say whether a person on THIS phone asked for it.
/// [person] may take the terminal from whoever holds it; [automatic] never may
/// — it opens as a watcher where the daemon supports that (`noTakeover`), and
/// does not open at all where it does not. The dial turning, a reconnect, a
/// desk another screen wrote, a push: all automatic.
enum AttachIntent { person, automatic }

class AppNotifier extends ChangeNotifier {
  final AuthSession session;
  AppConfig config;
  late ApiClient api;

  /// Says whether this device is signed in, and signs it out: [ViewerServices.login], the app's own
  /// session. The name is the desktop's, where the harness CLI holds the session instead.
  late final SignInClient cliLogin;

  /// Links to other machines by remote password — the app itself, through [ViewerServices.links].
  /// A viewer is not a machine, so it has no password of its own for anyone to link to.
  late final PeerLinkClient peerLinks;

  /// This app's stand-ins for the harness CLI (`lib/viewer/`). It is always a viewer: no CLI runs
  /// beside it, on a phone or anywhere else this package is built.
  final ViewerServices viewer;
  final ConfigStore? _store;

  final Duration turnActivityTimeout;
  @visibleForTesting
  final WsConn Function(String machineId)? connectionForTest;
  final Map<String, Timer> _turnActivityWatchdogs = {};

  /// What each agent was last asked and answered, as search matches it — the
  /// desktop's own store (see `session_preview.dart`), fed the same two ways:
  /// a small `agent_recent` read whenever the agent list arrives, and every
  /// turn event this socket carries, so a reply is findable the moment it lands.
  ///
  /// Read again after [freshFor] at the soonest, not the desktop's minute: a
  /// phone pays for the bytes, and the live events already keep a connected
  /// machine's agents current.
  late final sessionPreviews = SessionPreviewStore(
    canFetch: _canFetchPreview,
    freshFor: const Duration(minutes: 5),
    fetchRecent: (key) => _conn(key.machineId).request(
      'agent_recent',
      payload: {'agentId': key.agentId, 'n': 3},
      timeout: const Duration(seconds: 6),
    ),
  );

  /// What a finished turn or a question is worth — a tap, an unread mark, a
  /// system notice — decided by the dial's rules (`notify/`).
  final AgentAnnouncer agentNotices;

  SessionPreviewKey previewKey(String machineId, Agent agent) =>
      (machineId: machineId, agentId: agent.id, sessionId: agent.sessionId);

  /// Asks only a machine this app is already connected to, and never dials one:
  /// warming search must not be what wakes a relay socket.
  bool _canFetchPreview(SessionPreviewKey key) {
    if (_disposed || (_pool == null && connectionForTest == null)) return false;
    final machine = machineStates[key.machineId];
    return machine != null &&
        machine.nodeOnline != false &&
        !machine.needsLink &&
        machine.connectionStatus == ConnectionStatus.connected &&
        machine.agents.any(
          (agent) =>
              agent.id == key.agentId && agent.sessionId == key.sessionId,
        );
  }

  void _warmPreviews(MachineState machine) => sessionPreviews.warm(
    machine.agents.map((agent) => previewKey(machine.machine.machineId, agent)),
  );

  /// Has the next warm re-read [agent]'s content when its machine says the
  /// conversation moved since [before] — a turn this phone may have slept
  /// through. Compared on the machine's own clock, so a phone whose clock
  /// disagrees cannot make every refresh look like news.
  void _staleIfMoved(MachineState machine, Agent? before, Agent agent) {
    final moved = agent.updatedAt;
    if (before == null || moved == null) return;
    final was = before.updatedAt;
    if (was != null && !moved.isAfter(was)) return;
    sessionPreviews.markStale(previewKey(machine.machine.machineId, agent));
  }

  final Map<String, Timer> _offlineRetryTimers = {};
  // Safety-net reconciliation for a connected machine's agent list, on top of the push events
  // (agent_synced/agent_created/agent_renamed/agent_deleted) that normally keep it live — catches the
  // rare case a push event was dropped. Runs silently: see _syncAgentsIfChanged.
  final Map<String, Timer> _agentSyncTimers = {};
  final Set<String> _offlinePollsInFlight = {};
  final Set<String> _offlineRecoveryInFlight = {};
  bool _disposed = false;

  // Account and inventory replies belong to the session that requested them.
  // Signing out invalidates them before asynchronous connection cleanup.
  int _authRevision = 0;
  Future<void>? _profileInFlight;

  bool _authWorkCurrent(int revision) =>
      !_disposed && revision == _authRevision;

  int _invalidateAuthWork() {
    _profileInFlight = null;
    _retryInFlight = null;
    machinesLoading = false;
    return ++_authRevision;
  }

  WsPool? _pool;
  late String _autonomousEnv;
  String? _lastError;
  // Retrying re-runs `refreshMachines()` — a real fix for "could not load
  // machines" or a daemon hiccup, but a no-op for a failure that already
  // finished (an agent's launch), where the only honest control is to
  // dismiss it.
  bool _lastErrorRetryable = true;
  // Shown on the pre-navigation `bootstrapping` screen while [_finishBootstrapSignedIn] restores the
  // local state — null the rest of the time, including once [status] flips to `authenticated`.
  String? _bootStatusMessage;

  AppStatus status = AppStatus.bootstrapping;
  CurrentUserProfile? currentUser;
  List<Machine> machines = [];
  final Map<String, MachineState> machineStates = {};
  final Set<String> expandedMachines = {};
  String? selectedMachineId;

  // ── the desk: the account's tabs, the same on every computer ─────────────
  //
  // `phone_desk.dart` holds the whole of it, including why a phone follows the
  // desk instead of projecting itself onto it the way a window does. Everything
  // here is a hand-off: the closures read `api` LAZILY, because signing in
  // replaces that client and a tear-off taken now would go on talking to the
  // old one.
  late final PhoneDesk _desk = PhoneDesk(
    read: () => api.desk(),
    write: (ops) => api.deskOps(ops),
    onChanged: notifyListeners,
  );

  // ── the zoo: the account's daemons and eggs ──────────────────────────────
  //
  // `daemons/zoo_client.dart` holds it. Its own document, like the desk and
  // separate from it: read on sign-in, on `zoo_changed`, and when the app comes
  // back to the front. The closures read `api` lazily for the desk's reason.
  late final ZooClient zoo = ZooClient(
    read: () => api.zoo(),
    write: (ops) => api.zooOps(ops),
  );

  /// Individuals' own plates, drawn by harnessd on one of the account's
  /// computers and asked for over the sealed `pair_plate_get` frame
  /// (`daemons/individual_art.dart`). Until one arrives, and where none can
  /// be asked, the species plate is shown in the individual's colours.
  late final IndividualArt individualArt = IndividualArt(
    request: requestIndividualPlate,
  );

  /// Ask the account's connected computers for an
  /// individual's plates (`pair_plate_get { uid, id, seed, size, version,
  /// mood }` → `pair_plate { ..., frames, frameMs }`). The first that answers
  /// wins; a computer whose harnessd predates individual art says
  /// `UNSUPPORTED` or stays silent (a sealed frame it cannot open), which is a
  /// timeout and the next one. A first render can take tens of seconds;
  /// the recoloured species plate remains visible while it draws.
  Future<Map<String, dynamic>?> requestIndividualPlate(
    Map<String, dynamic> payload,
  ) async {
    if (_disposed || (_pool == null && connectionForTest == null)) return null;
    final machines = [
      for (final machine in machineStates.values)
        if (machine.connectionStatus == ConnectionStatus.connected &&
            !machine.needsLink &&
            machine.nodeOnline != false)
          machine,
    ];
    for (final machine in machines) {
      try {
        final answer = await _conn(machine.machine.machineId).request(
          'pair_plate_get',
          payload: payload,
          timeout: const Duration(minutes: 2),
        );
        if (answer['error'] == null && answer['frames'] is List) return answer;
      } catch (_) {
        // Too old, asleep, or not there: the next one.
      }
    }
    return null;
  }

  /// The first egg's habits this phone can see for itself — see
  /// `daemons/daemon_habits.dart` for which, and why the rest are left to the
  /// computers. The days it was used are kept where the layout is: nowhere in
  /// a test.
  late final PhoneHabits daemonHabits = PhoneHabits(
    zoo,
    storage: _paneLayout?.storage,
  );

  /// The account's tabs, in the desk's order. Empty where the desk has nothing
  /// or has not answered — the phone then swipes the whole account, as it did
  /// before the desk existed.
  List<DeskTab> get deskTabs => _desk.tabs;

  /// The tab the phone is in, or null for an agent no tab holds.
  String? get activeDeskTabId => _desk.activeTabId;

  /// Whether the desk's first read has come back — see [PhoneDesk.settled].
  bool get deskSettled => _desk.settled;

  /// A tab picked by hand, in the tabs panel — set as the agent chosen there
  /// is opened, so the swipe walks that tab from then on.
  void selectDeskTab(String? tabId) {
    _desk.select(tabId);
    _rememberDeskTab(tabId);
  }

  /// The tab the screen has worked out it is showing — see [PhoneDesk.note].
  void noteDeskTab(String? tabId) {
    _desk.note(tabId);
    _rememberDeskTab(tabId);
  }

  /// Kept for the next launch to fall back on — see [LastOpenedAgent.rememberTab]. Only a real
  /// tab: an agent opened from search, in none, leaves the last tab standing.
  void _rememberDeskTab(String? tabId) {
    if (tabId != null) lastOpenedAgent.rememberTab(tabId);
  }

  /// Whether the desk can be WRITTEN to — what the two `+`s on the tabs panel
  /// are drawn on. False before the first read answers, and on a backend with
  /// no desk at all: a `+` there would queue ops nothing will ever take.
  bool get deskWritable => _desk.enabled;

  /// An agent that already exists joins the tab the person picked — the `+` at
  /// the foot of a tab's list. See [PhoneDesk.addToTab].
  void addAgentToDeskTab(String tabId, AgentRef agent) =>
      _desk.addToTab(tabId, agent);

  /// A tab renamed by hand, from a double tap on its name in the tabs panel.
  /// See [PhoneDesk.renameTab].
  void renameDeskTab(String tabId, String name) => _desk.renameTab(tabId, name);

  /// An agent that already exists opens a tab of its own — the `+` on the tab
  /// row. See [PhoneDesk.createTabFor].
  String? createDeskTabFor(AgentRef agent, {String? name}) =>
      _desk.createTabFor(agent, name: name);

  /// The next agent made on this phone gets a tab of its own — armed by the `+`
  /// on the tab row before the new-agent form opens, and spent (or forgotten)
  /// by the time that form closes. See [PhoneDesk.openNextAgentInNewTab].
  void openNextAgentInNewDeskTab() => _desk.openNextAgentInNewTab();

  /// That form closed without making anything.
  void forgetNewDeskTabIntent() => _desk.forgetNewTabIntent();

  /// Read the desk now, and wait for it — what a sign-in and the app coming
  /// back to the foreground both start without waiting.
  @visibleForTesting
  Future<void> deskSyncForTest() => _desk.refresh();

  /// Swarms own arrangements; a shared pane owns one live terminal controller.
  final List<Swarm> swarms = [Swarm(id: 'swarm-1')];
  String _activeSwarmId = 'swarm-1';
  int _nextSwarmId = 2;
  static const maxSwarms = 24;
  static const maxClosedSwarms = 24;
  final List<ClosedWork> _closedHistory = [];
  int _nextClosedHistoryId = 1;
  List<ClosedWork> get closedHistory =>
      List.unmodifiable(_closedHistory.reversed);
  List<ClosedSwarm> get closedSwarms =>
      List.unmodifiable(_closedHistory.reversed.whereType<ClosedSwarm>());
  bool get canReopenClosedSwarm {
    final saved = _closedHistory.whereType<ClosedSwarm>().lastOrNull;
    return saved != null && _canReopenSwarm(saved);
  }

  bool get canReopenLastClosed =>
      _closedHistory.isNotEmpty &&
      canReopenClosed(_closedHistory.last.historyId);

  bool canReopenClosed(String historyId) {
    if (_disposed) return false;
    final entry = _closedHistory
        .where((entry) => entry.historyId == historyId)
        .firstOrNull;
    if (entry is ClosedSwarm) return _canReopenSwarm(entry);
    if (entry is! ClosedAgent) return false;
    final target = swarms.where((s) => s.id == entry.swarmId).firstOrNull;
    return target == null
        ? swarms.length < maxSwarms
        : target.panes.length < maxPanes ||
              target.panes.any(
                (p) =>
                    p.machineId == entry.machineId &&
                    p.agentId == entry.agentId,
              );
  }

  bool _canReopenSwarm(ClosedSwarm saved) {
    if (_disposed) return false;
    final target = swarms.where((swarm) => swarm.id == saved.id).firstOrNull;
    if (target == null) return swarms.length < maxSwarms;
    final present = {
      for (final pane in target.panes) (pane.machineId, pane.agentId),
    };
    final missing = {
      for (final pane in saved.panes)
        if (!present.contains((pane.machineId, pane.agentId)))
          (pane.machineId, pane.agentId),
    };
    return target.panes.length + missing.length <= maxPanes;
  }

  void _rememberClosed(ClosedWork entry) {
    // An unused starter has no work to recover. This also covers empty pages
    // restored from builds that did not mark them as drafts.
    if (entry is ClosedSwarm &&
        entry.name == Swarm.defaultName &&
        entry.panes.isEmpty) {
      return;
    }
    _closedHistory.add(entry);
    if (_closedHistory.length > maxClosedSwarms) _closedHistory.removeAt(0);
  }

  Swarm get activeSwarm => swarms.firstWhere(
    (s) => s.id == _activeSwarmId,
    orElse: () => swarms.first,
  );
  List<TerminalPane> get panes => activeSwarm.panes;
  Iterable<TerminalPane> get allPanes => swarms.expand((s) => s.panes).toSet();
  String get activeSwarmId => activeSwarm.id;
  bool get canOpenNewTab =>
      swarms.length < maxSwarms || swarms.any((swarm) => swarm.isEmptyStarter);

  // An untitled tab remains temporary until it has content or a custom name.
  // The return destination is session-local; abandoned drafts are never saved.
  final _draftSwarmReturns = <String, String>{};

  bool isDraftSwarm(String id) {
    if (!_draftSwarmReturns.containsKey(id)) return false;
    final swarm = swarms.where((swarm) => swarm.id == id).firstOrNull;
    return swarm != null &&
        swarm.panes.isEmpty &&
        swarm.name == Swarm.defaultName;
  }

  void newSwarm({String name = Swarm.defaultName, bool draft = false}) {
    // Every New Tab entry point reuses the existing start page, including
    // when another tab is selected or the tab limit has been reached.
    if (name == Swarm.defaultName) {
      final starter = activeSwarm.isEmptyStarter
          ? activeSwarm
          : swarms.where((swarm) => swarm.isEmptyStarter).firstOrNull;
      if (starter != null) {
        if (starter.id != activeSwarmId) selectSwarm(starter.id);
        return;
      }
    }
    if (swarms.length >= maxSwarms) return;
    while (swarms.any((s) => s.id == 'swarm-$_nextSwarmId')) {
      _nextSwarmId++;
    }
    final swarm = Swarm(id: 'swarm-${_nextSwarmId++}', name: name);
    if (draft) {
      _draftSwarmReturns[swarm.id] =
          _draftSwarmReturns[activeSwarmId] ?? activeSwarmId;
    }
    swarms.add(swarm);
    selectSwarm(swarm.id);
  }

  void selectSwarm(String id, {bool attachPending = true}) {
    if (!swarms.any((s) => s.id == id)) return;
    if (id != activeSwarmId && isDraftSwarm(activeSwarmId)) {
      final abandoned = activeSwarmId;
      swarms.removeWhere((swarm) => swarm.id == abandoned);
      _draftSwarmReturns.remove(abandoned);
    }
    _activeSwarmId = id;
    final pane = focusedPane;
    selectedMachineId = pane?.machineId;
    _persistLayout();
    if (attachPending) {
      for (final machine in machineStates.values) {
        // A tab the person switched to.
        _attachPendingPanes(
          machine,
          retryExisting: false,
          intent: AttachIntent.person,
        );
      }
    }
    notifyListeners();
  }

  /// Cancel an untouched new tab without closing a session or recording
  /// Recently Closed. A sole workspace remains the app's starting screen.
  bool cancelSwarmDraft(String id) {
    final returnId = _draftSwarmReturns[id];
    final target = swarms.where((swarm) => swarm.id == id).firstOrNull;
    if (returnId == null ||
        target == null ||
        target.panes.isNotEmpty ||
        target.name != Swarm.defaultName ||
        swarms.length == 1) {
      return false;
    }
    final wasActive = activeSwarmId == id;
    swarms.remove(target);
    _draftSwarmReturns.remove(id);
    if (wasActive) {
      selectSwarm(
        swarms.any((swarm) => swarm.id == returnId) ? returnId : swarms.last.id,
      );
    } else {
      _persistLayout();
      notifyListeners();
    }
    return true;
  }

  /// Navigate to an existing view without opening, retrying or taking control
  /// of a terminal. A shared view prefers the current Swarm, then the requested
  /// owner. Publish the destination and its focus together, preserving layout.
  bool revealAgentView(
    String machineId,
    String agentId, {
    String? preferredSwarmId,
  }) {
    if (_disposed) return false;
    bool contains(Swarm swarm) => swarm.panes.any(
      (p) => p.machineId == machineId && p.agentId == agentId,
    );
    final owner = contains(activeSwarm)
        ? activeSwarm
        : swarms
                  .where((s) => s.id == preferredSwarmId && contains(s))
                  .firstOrNull ??
              swarms.where(contains).firstOrNull;
    if (owner == null) return false;
    final pane = owner.panes.firstWhere(
      (p) => p.machineId == machineId && p.agentId == agentId,
    );
    if (owner == activeSwarm) {
      focusPane(pane.id, reveal: true);
      return true;
    }
    if (owner.focusedPaneId != pane.id) {
      owner.previousPaneId = owner.focusedPaneId;
      owner.focusedPaneId = pane.id;
    }
    if (owner.zoomedPaneId != null) owner.zoomedPaneId = pane.id;
    _activeSwarmId = owner.id;
    selectedMachineId = machineId;
    _persistLayout();
    notifyListeners();
    return true;
  }

  /// Command-number follows the current visual tab order, retaining each tab's
  /// focused pane. A missing position is a no-op, never a pane selection.
  void selectSwarmByIndex(int index) {
    if (index < 0 || index >= swarms.length) return;
    selectSwarm(swarms[index].id);
  }

  void stepSwarm(int delta) {
    final index = swarms.indexOf(activeSwarm);
    selectSwarm(swarms[(index + delta) % swarms.length].id);
  }

  void renameSwarm(String id, String name) {
    final clean = name.trim();
    if (clean.isEmpty) return;
    final swarm = swarms.where((s) => s.id == id).firstOrNull;
    if (swarm == null) return;
    swarm.name = clean.length > 80 ? clean.substring(0, 80) : clean;
    _persistLayout();
    notifyListeners();
  }

  void reorderSwarm(String id, int destination) {
    final index = swarms.indexWhere((s) => s.id == id);
    if (index < 0) return;
    final swarm = swarms.removeAt(index);
    swarms.insert(destination.clamp(0, swarms.length), swarm);
    _persistLayout();
    notifyListeners();
  }

  Future<void> closeSwarm(String id) async {
    if (cancelSwarmDraft(id)) return;
    final index = swarms.indexWhere((s) => s.id == id);
    if (index < 0) return;
    // Held ⌘W must not manufacture and close an endless sequence of blank
    // welcome tabs, evicting the real work from recently closed history.
    if (swarms.length == 1 &&
        swarms.single.panes.isEmpty &&
        swarms.single.name == Swarm.defaultName) {
      return;
    }
    final removed = swarms.removeAt(index);
    Swarm? replacement;
    if (swarms.isEmpty) {
      replacement = Swarm(id: 'swarm-${_nextSwarmId++}');
      swarms.add(replacement);
    }
    _rememberClosed(
      ClosedSwarm(
        removed,
        historyId: 'closed-${_nextClosedHistoryId++}',
        index: index,
        replacement: replacement,
        engine: removed.panes.length == 1
            ? stateOf(removed.panes.single.machineId)?.agents
                      .where(
                        (agent) => agent.id == removed.panes.single.agentId,
                      )
                      .firstOrNull
                      ?.engine ??
                  removed.panes.single.session?.engineId
            : null,
      ),
    );
    if (_activeSwarmId == id) {
      _activeSwarmId = swarms[index.clamp(0, swarms.length - 1)].id;
    }
    _persistLayout();
    notifyListeners();
    selectedMachineId = focusedPane?.machineId;
    for (final machine in machineStates.values) {
      // A tab closed here; the tiles behind it are theirs.
      _attachPendingPanes(machine, intent: AttachIntent.person);
    }
    for (final pane in removed.panes) {
      if (!allPanes.contains(pane)) await _detachSession(pane, sendClose: true);
    }
  }

  void reopenClosedSwarm({String? historyId}) {
    if (_disposed) return;
    final index = _closedHistory.lastIndexWhere(
      (entry) =>
          entry is ClosedSwarm &&
          (historyId == null || entry.historyId == historyId),
    );
    if (index < 0) return;
    final saved = _closedHistory[index] as ClosedSwarm;
    if (!_canReopenSwarm(saved)) return;
    _closedHistory.removeAt(index);
    if (swarms.length == 1 && saved.replacesUntouchedWelcome(swarms.single)) {
      swarms.clear();
    }
    final pool = {
      for (final pane in allPanes) (pane.machineId, pane.agentId): pane,
    };
    final target = swarms.where((swarm) => swarm.id == saved.id).firstOrNull;
    if (target != null) {
      // Reopening an individual agent may have restored this swarm already.
      // Reunite its missing views without cloning the tab or overwriting edits
      // made since then. Live peers keep their terminal, draft and selection.
      final present = {
        for (final pane in target.panes) (pane.machineId, pane.agentId),
      };
      for (final entry in saved.panes) {
        if (!present.add((entry.machineId, entry.agentId))) continue;
        target.panes.add(
          pool.putIfAbsent(
            (entry.machineId, entry.agentId),
            () => TerminalPane(
              id: _nextPaneId++,
              machineId: entry.machineId,
              agentId: entry.agentId,
            ),
          ),
        );
      }
      target.focusedPaneId ??= target.panes.firstOrNull?.id;
      selectSwarm(target.id);
      return;
    }
    final restored = Swarm(id: saved.id, name: saved.name);
    for (final entry in saved.panes) {
      final pane = pool.putIfAbsent(
        (entry.machineId, entry.agentId),
        () => TerminalPane(
          id: _nextPaneId++,
          machineId: entry.machineId,
          agentId: entry.agentId,
        ),
      );
      restored.panes.add(pane);
      if (entry.pinnedSlot != null) {
        restored.pinnedSlots[pane.id] = entry.pinnedSlot!;
      }
    }
    int? paneAt(int index) => index >= 0 && index < restored.panes.length
        ? restored.panes[index].id
        : null;
    restored.focusedPaneId =
        paneAt(saved.focus) ?? restored.panes.firstOrNull?.id;
    restored.previousPaneId = paneAt(saved.previousFocus);
    restored.zoomedPaneId = paneAt(saved.zoom);
    swarms.insert(saved.index.clamp(0, swarms.length), restored);
    selectSwarm(restored.id);
  }

  /// Reopen the chosen closure, or the newest closure for Cmd-Shift-T.
  /// Membership is restored synchronously; a slow detach cannot resurrect an
  /// old controller or redirect the destination after a network wait.
  bool reopenClosed({String? historyId}) {
    final id = historyId ?? _closedHistory.lastOrNull?.historyId;
    if (id == null || !canReopenClosed(id)) return false;
    final index = _closedHistory.indexWhere((entry) => entry.historyId == id);
    final saved = _closedHistory[index];
    if (saved is ClosedSwarm) {
      reopenClosedSwarm(historyId: id);
      return true;
    }
    final agent = saved as ClosedAgent;
    _closedHistory.removeAt(index);
    var target = swarms.where((s) => s.id == agent.swarmId).firstOrNull;
    if (target == null) {
      target = Swarm(id: agent.swarmId, name: agent.swarmName);
      swarms.add(target);
    }
    final pane =
        allPanes
            .where(
              (p) =>
                  p.machineId == agent.machineId && p.agentId == agent.agentId,
            )
            .firstOrNull ??
        TerminalPane(
          id: _nextPaneId++,
          machineId: agent.machineId,
          agentId: agent.agentId,
        );
    if (!target.panes.contains(pane)) {
      target.panes.insert(agent.index.clamp(0, target.panes.length), pane);
      if (agent.pinnedSlot != null &&
          !target.pinnedSlots.containsValue(agent.pinnedSlot)) {
        target.pinnedSlots[pane.id] = agent.pinnedSlot!;
      }
    }
    if (target.focusedPaneId != pane.id) {
      target.previousPaneId = target.focusedPaneId;
    }
    target.focusedPaneId = pane.id;
    if (agent.zoomed || target.zoomedPaneId != null) {
      target.zoomedPaneId = pane.id;
    }
    _activeSwarmId = target.id;
    _settlePins();
    selectSwarm(target.id);
    return true;
  }

  /// Capture the destination before any network wait or tab change.
  Future<void> addAgentToSwarm(
    String machineId,
    String agentId, {
    String? swarmId,
    bool takeControl = false,
  }) => assignAgentToPane(
    null,
    machineId,
    agentId,
    swarmId: swarmId,
    takeControl: takeControl,
  );

  /// Which tile the keyboard, the dial and the rail's highlight all mean.
  ///
  /// Typing itself does NOT go through this on macOS — the renderer is a
  /// WebView, so a click makes that pane's WKWebView the first responder and
  /// AppKit routes keys there without asking. This is for everything that has
  /// no pointer behind it: the dial's scroll and focus frames, and which agent
  /// the rail draws as current.
  int? get focusedPaneId => activeSwarm.focusedPaneId;
  set focusedPaneId(int? value) => activeSwarm.focusedPaneId = value;

  int _nextPaneId = 1;

  static const maxPanes = 64;

  /// True from the moment a code is handed in — emailed or scanned — until the flow settles, one
  /// way or the other.
  ///
  /// It spans the whole flow, restoring the tiles and fetching the machines included, so the
  /// screen the user pressed a button on stays put: `RootShell` keeps the signed-out screen up
  /// while it is set, rather than dropping them onto a bare full-screen spinner.
  bool signingIn = false;

  AppNotifier({
    required AppConfig config,
    required AuthSession authSession,
    ConfigStore? configStore,
    this.connectionForTest,
    SignInClient? cliLogin,
    PeerLinkClient? peerLinks,
    ViewerServices? viewer,
    PaneLayoutStore? paneLayoutStore,
    SystemNotices? systemNotices,
    MachineCache? machineCache,
    GroupSync? groupSync,
    this.turnActivityTimeout = const Duration(seconds: 12),
  }) : _paneLayout = paneLayoutStore,
       // On the same terms as the stores below: no layout store means a test,
       // which must never reach the OS notification centre.
       agentNotices = AgentAnnouncer(
         system:
             systemNotices ??
             (paneLayoutStore == null
                 ? SilentSystemNotices()
                 : LocalSystemNotices()),
       ),
       // Remembers "a dial has been seen here" on the same terms the pane
       // layout is remembered: with a layout store there is a state file, and
       // without one (the tests) nothing is written anywhere.
       dial = DialState(paneLayoutStore?.storage),
       agentPreference = AgentPreference(paneLayoutStore?.storage),
       projectHistory = ProjectHistory(paneLayoutStore?.storage),
       lastOpenedAgent = LastOpenedAgent(paneLayoutStore?.storage),
       searchHistory = PhoneSearchHistory(paneLayoutStore?.storage),
       // On the same terms as the stores above: a layout store means this is a
       // real app with a real Harness home to cache into, and its absence means
       // a test, which must not read or write one — unless it hands over a
       // cache of its own, kept in memory.
       _machineCache =
           machineCache ?? (paneLayoutStore == null ? null : MachineCache()),
       session = authSession,
       _store = configStore,
       config = configStore?.config ?? config,
       viewer =
           viewer ??
           ViewerServices(
             config: configStore?.config ?? config,
             session: authSession,
           ) {
    this.cliLogin = cliLogin ?? this.viewer.login;
    this.peerLinks = peerLinks ?? this.viewer.links;
    _groupSyncOverride = groupSync;
    _autonomousEnv = this.config.autonomousEnv;
    api = _newApiClient();
    _initDeviceLog();
  }

  /// Straight to the backend, signed with this app's own session.
  ApiClient _newApiClient() =>
      ApiClient(config: config, session: session, auth: viewer.auth);

  /// Where the harnesses this notifier sees are counted — the app's own [harnessStats], kept on
  /// disk. Sample mode (`lib/demo/`) counts into one of its own: its harnesses are not the
  /// person's, and must not land in their figures.
  HarnessStats get stats => harnessStats;

  String? get lastError => _lastError;
  bool get lastErrorRetryable => _lastErrorRetryable;
  String? get bootStatusMessage => _bootStatusMessage;

  /// Clears the error strip without retrying anything, for a failure retrying
  /// cannot fix (see [_lastErrorRetryable]).
  void dismissError() {
    _lastError = null;
    notifyListeners();
  }

  String get autonomousEnv => _autonomousEnv;

  static const offlineRetryInterval = Duration(seconds: 5);
  static const agentSyncInterval = Duration(seconds: 60);

  MachineState? stateOf(String machineId) => machineStates[machineId];

  // ── the grid ────────────────────────────────────────────────────────────────────────────────────

  /// Null means "remember nothing", which is what a test gets by default.
  ///
  /// Deliberately NOT `?? PaneLayoutStore()` like the stores above it. Those
  /// only read, and only when asked; this one WRITES on every pane change, and
  /// a widget test that opens an agent would otherwise rewrite the layout in
  /// the developer's own ~/.harness state file. Production passes one; see
  /// [appStateProvider].
  final PaneLayoutStore? _paneLayout;

  /// The dial on this desk, for the rail's device row. Fed by `dial_status`
  /// frames from the local daemon; its own notifier, so the row rebuilds
  /// without dragging the whole rail through a machine-list rebuild.
  final DialState dial;
  final AgentPreference agentPreference;

  /// Folders agents have been started in, per machine, kept across launches.
  ///
  /// ⚠️ Not the same list as the folders this machine's agents are using right now. That one comes
  /// from `machine.agents` and a deleted agent takes its folder off it; this one is a HISTORY and
  /// outlives the agent — which is what "recent" has to mean for the word to be true.
  final ProjectHistory projectHistory;

  /// The agent the phone's terminal had open, kept across launches — see [LastOpenedAgent].
  final LastOpenedAgent lastOpenedAgent;

  /// The agents and commands reached from the search, most recent first — what
  /// ranks the box before a word is typed. See [PhoneSearchHistory].
  ///
  /// ⚠️ **On the app, not on the search screen.** It has to outlive one opening
  /// of the box: a history built per page would load the last run's visits and
  /// then forget every visit made since, which is exactly the half that matters
  /// while somebody is switching between two agents.
  final PhoneSearchHistory searchHistory;

  /// Last run's machine list, used to start dialling before this run's
  /// `/api/machines` answers — see [MachineCache] and [_warmStartMachines].
  /// Null in tests, which have no Harness home to cache into.
  final MachineCache? _machineCache;

  TerminalPane? get focusedPane {
    final id = focusedPaneId;
    if (id == null) return null;
    for (final pane in panes) {
      if (pane.id == id) return pane;
    }
    return null;
  }

  /// The one tile everything single-terminal still means.
  ///
  /// Kept as a getter rather than deleted because the alternative — teaching
  /// every caller about tiles — would have spread the grid across code that has
  /// no business knowing there is one (a rename arriving, an agent being
  /// deleted, the window closing). The handful of callers that must reach EVERY
  /// tile of a machine, rather than only the focused one, call [panesFor]
  /// instead; those are the transport-wide events, and they are marked.
  TerminalSession? get activeTerminal => focusedPane?.session;

  bool get canAddPane => panes.length < maxPanes;

  Iterable<TerminalPane> panesFor(String machineId) =>
      allPanes.where((pane) => pane.machineId == machineId);

  TerminalPane? paneOfAgent(String machineId, String agentId) {
    for (final pane in panes) {
      if (pane.machineId == machineId && pane.agentId == agentId) return pane;
    }
    return null;
  }

  bool isAgentInPane(String machineId, String agentId) =>
      paneOfAgent(machineId, agentId) != null;

  void focusPane(int paneId, {bool reveal = false}) {
    if (!panes.any((pane) => pane.id == paneId)) return;
    final moved = focusedPaneId != paneId;
    // Remembered only on a REAL move. Re-focusing the tile you are already on
    // happens constantly, and recording it would make ⌘; a key that returns you
    // to where you already are, which is the same as a key that does nothing.
    if (moved) _previousPaneId = focusedPaneId;
    focusedPaneId = paneId;
    selectedMachineId = focusedPane?.machineId;
    if (zoomedPaneId != null) zoomedPaneId = paneId;
    // ⚠️ **Nothing is told which agent is on screen.** The desktop sends `app_focus` and
    // `app_panes` here for the dial beside it; only the CLI's loopback server reads them
    // (`localWsServer.ts`), and a phone's socket is the relay, where nothing does — and the types
    // are not in `encryptedDownTypes`, so every swipe sent the agent id past the backend in the
    // clear for no one to read.
    if (moved) _persistLayout();
    if (moved || reveal) notifyListeners();
  }

  /// Machines whose link prompt the user has waved away.
  ///
  /// Dismissing cannot mean "deselect": [activeMachineState] falls back to the
  /// first expanded machine, so clearing the selection would often re-arrive at
  /// the very machine that was just closed. And it must not mean "linked" —
  /// nothing changed about the machine, which still cannot be read and still
  /// says so in the rail. It means only that the pane stops insisting.
  ///
  /// Held in memory, not on disk, and cleared the moment the machine is chosen
  /// again: someone who clicks that row is asking to see it.
  final Set<String> _dismissedLinkPrompts = {};

  bool isLinkPromptDismissed(String machineId) =>
      _dismissedLinkPrompts.contains(machineId);

  void dismissLinkPrompt(String machineId) {
    if (_dismissedLinkPrompts.add(machineId)) notifyListeners();
  }

  /// The person asked to see the prompt again — a deliberate open, not the
  /// reactive gate. Without this, every way in that does not go through
  /// [showMachinePane] (the welcome's Machines row) opened a dialog that its
  /// own "still needed?" check closed on the first frame: one popup, then
  /// nothing, for as long as the app ran.
  void revisitLinkPrompt(String machineId) {
    if (_dismissedLinkPrompts.remove(machineId)) notifyListeners();
  }

  MachineState? get activeMachineState {
    final terminal = activeTerminal;
    if (terminal != null) return machineStates[terminal.machineId];
    final selected = selectedMachineId;
    if (selected != null) return machineStates[selected];
    return expandedMachines.isEmpty
        ? null
        : machineStates[expandedMachines.first];
  }

  bool? _nodeOnlineFromStatus(String? status) {
    switch (status?.trim().toLowerCase()) {
      case 'running':
      case 'online':
      case 'connected':
      case 'ready':
        return true;
      case 'offline':
      case 'stopped':
      case 'disconnected':
      case 'unreachable':
      case 'error':
      case 'failed':
        return false;
      default:
        return null;
    }
  }

  Future<void> bootstrap() async {
    try {
      if (_store != null) {
        try {
          config = await StartupTrace.time(
            'boot.configLoad',
            () => _store.load().timeout(const Duration(seconds: 5)),
          );
        } catch (error) {
          // Connection settings are optional local preferences. An unavailable
          // state file must not invalidate an otherwise recoverable SSO flow;
          // use the store's safe cached/default production config.
          debugPrint(
            'bootstrap: config store unavailable, using defaults: $error',
          );
          config = _store.config;
        }
        // Forced, not read from persisted config: staging is a dev-only
        // escape hatch with no UI to reach it anymore (see the desktop's
        // login_screen.dart history) — a stale `stag` value saved before that removal must
        // never silently resurrect it.
        _autonomousEnv = 'prod';
        api = _newApiClient();
      }
      await _checkSignIn();
    } catch (error, stack) {
      debugPrint('bootstrap: fallback to login after error: $error\n$stack');
      currentUser = null;
      status = AppStatus.unauthenticated;
      notifyListeners();
    }
  }

  /// Whether this device is signed in, and everything behind the login screen when it is — what
  /// `bootstrap()` does once its config is loaded.
  Future<void> _checkSignIn() async {
    final revision = _authRevision;
    if (!_authWorkCurrent(revision)) return;
    // The boot spinner holds while the sign-in is checked.
    status = AppStatus.bootstrapping;
    notifyListeners();
    // The session is the app's own (`viewer/direct_auth.dart`): this asks whether one is kept.
    try {
      final authStatus = await StartupTrace.time(
        'boot.checkSignIn',
        cliLogin.checkStatus,
      );
      if (!_authWorkCurrent(revision)) return;
      if (!authStatus.loggedIn) {
        currentUser = null;
        status = AppStatus.unauthenticated;
        notifyListeners();
        return;
      }
      await _finishBootstrapSignedIn();
    } catch (error, stack) {
      if (!_authWorkCurrent(revision)) return;
      debugPrint('checkSignIn: fallback to login after error: $error\n$stack');
      currentUser = null;
      status = AppStatus.unauthenticated;
      notifyListeners();
    }
  }

  /// Both `bootstrap()` (already signed in) and a sign-in that just finished land here once a
  /// session exists — fetch the profile and machine list, and restore the tiles meanwhile.
  Future<void> _finishBootstrapSignedIn() async {
    final revision = _authRevision;
    if (!_authWorkCurrent(revision)) return;
    // Before ANYTHING below can start a connection, a machine refresh or a pane restore — each can
    // end in a read of the device log, which must be judged by THIS sign-in (a hand sign-in mints its
    // id here), not the previous account's. Synchronous: no await may come first.
    _beginDeviceLogSignIn(revision);
    // Stays on the pre-navigation `bootstrapping` screen (main.dart) until the local state is
    // restored. A phone has no local service to start — the desktop's "Starting local service…"
    // was a sentence about somebody else's computer shown while this one read its own disk.
    _bootStatusMessage = 'Getting your machines…';
    notifyListeners();
    // Which agent to reopen is the first thing the phone's home screen asks for
    // and the last thing it can draw without, so the read starts here rather
    // than when that screen mounts — several state-file operations later, behind
    // every one of their locks. See [LastOpenedAgent.prefetch].
    lastOpenedAgent.prefetch();
    // Before the machines, deliberately: the tiles are intent, they render as
    // "waiting for that machine" on their own, and each attaches as its machine
    // answers. Waiting for the machine list first would leave the window empty
    // for as long as the slowest one takes, and would hand the first-run
    // auto-pick a window in which the grid still looks empty.
    //
    // `dial` is not restored beside them: it describes a USB device plugged
    // into a desktop, which a phone has no port for, so the read could only
    // ever return the default it already holds.
    //
    // ⚠️ **The machine list is asked for HERE, not after the disk work, and that
    // ordering is the point.** A viewer reaches every machine over the network,
    // so `/api/machines` depends on nothing below it — yet it used to be the
    // last thing started, behind several exclusive locks on one state file. The
    // request now overlaps that disk work instead of queueing behind it, which
    // takes a whole HTTP round-trip off the stretch the phone spends saying
    // "Connecting to your machine…".
    //
    // ⚠️ The pool is built BEFORE the fetch is started, not after the restore
    // below. A returning list dials each machine through `_conn`, which reads
    // `_pool` and would throw on a null one — reachable only because this fetch
    // can now finish while the restore is still holding the file lock. It is
    // cheap and idempotent, and nothing it needs comes off disk.
    //
    // The failure is held rather than thrown: nothing awaits this future until
    // the end of the method, and an unhandled rejection in between would reach
    // the zone's error handler and be reported as a crash. It is re-raised at
    // that await, where the existing handler words it for the user and offers
    // the retry.
    _ensurePool();
    final machineRefresh = StartupTrace.time<Object?>(
      'boot.refreshMachines',
      () async {
        try {
          await refreshMachines();
          return null;
        } catch (error) {
          return error;
        }
      },
    );
    // Dial last run's machines WHILE that fetch is in the air. The socket,
    // the relay and the E2EE handshake are the slowest part of the launch by
    // far, and none of them needed the fetch to have finished — only a
    // machine id, which the last run already wrote down.
    unawaited(_warmStartMachines());
    // Not awaited before the fetch above starts: the screen still wants to
    // appear as soon as the local state is restored, and these two now overlap.
    await StartupTrace.time('boot.restoreLocalState', _restorePaneLayout);
    if (!_authWorkCurrent(revision)) return;
    _bootStatusMessage = null;
    status = AppStatus.authenticated;
    notifyListeners();
    // What the device log announced while the app was still starting up (see [_whenSignedIn]).
    _flushDeviceNotices(revision);
    // The device log is joined NOW, not after the machine list or the profile: a read of it that
    // landed first (a push, a reconnect) would judge a just-signed-in phone by the old sign-in's
    // file, and the log has to know the sign-in is fresh before anything waits.
    _registerDeviceLog(revision);
    // With no machine connected nothing is pushed to this phone: the machine list is read again now
    // and then until one is ([_rereadMachinesWhileDeaf]).
    _startDeafPoll();
    // Signed in. Display-name/avatar metadata is independent of machine
    // discovery and must not delay work.
    unawaited(_loadProfile());
    // The desk too: its tabs are what a swipe stays inside, and they are read
    // over REST rather than from any machine — so they can land before the
    // first machine has finished dialling.
    _desk.ensure();
    // The zoo the same way: the daemon on the chip is account state.
    zoo.ensure();
    try {
      // The request already in flight (above).
      final failure = await machineRefresh;
      if (failure != null) throw failure;
    } catch (error) {
      if (!_authWorkCurrent(revision)) return;
      _lastError = 'Could not load machines: ${describeApiError(error)}';
      _lastErrorRetryable = true;
    }
    if (_authWorkCurrent(revision)) notifyListeners();
  }

  /// Who is signed in, from the account. Shared by the boot path and by the
  /// retry path, because a profile the boot could not read is asked for again
  /// there — and a session that never learns its own account has an empty
  /// footer.
  Future<void> _loadProfile() {
    final pending = _profileInFlight;
    if (pending != null) return pending;
    final revision = _authRevision;
    late final Future<void> load;
    load = _readProfile(revision).whenComplete(() {
      if (identical(_profileInFlight, load)) _profileInFlight = null;
    });
    _profileInFlight = load;
    return load;
  }

  Future<void> _readProfile(int revision) async {
    try {
      final me = await api.me();
      if (!_authWorkCurrent(revision) || status != AppStatus.authenticated) {
        return;
      }
      if (me != null) {
        currentUser = CurrentUserProfile.fromMe(me);
        // A sign-in by hand: the device log keeps which account it was made to.
        if (currentUser?.id case final id?) {
          unawaited(_deviceLog?.signedInAs(id));
        }
        notifyListeners();
      }
    } catch (error) {
      if (_authWorkCurrent(revision)) {
        debugPrint('bootstrap: profile unavailable: $error');
      }
    }
  }

  /// The session went away while the app was already running — send the user to the signed-out screen with a
  /// reason, and stop the background work that can only fail from here.
  ///
  /// Cold start already handles this: [bootstrap] asks whether a session is kept. The hole this
  /// fills is the app that was ALREADY authenticated when the session disappeared underneath it —
  /// a relay socket finding it gone for good ([WsCredentialRevoked]).
  void _signedOutAtRuntime(String message) {
    if (status == AppStatus.unauthenticated) {
      return; // idempotent: several sources can race here
    }
    _invalidateAuthWork();
    currentUser = null;
    signingIn = false;
    // The code was scanned into the session that just ended — see [logout].
    pendingPairing = null;
    _clearDeviceNotices();
    _stopAccountTimers();
    _desk.reset();
    zoo.reset();
    unawaited(_pool?.closeAll());
    _pool = null;
    _lastError = message;
    _lastErrorRetryable = true;
    status = AppStatus.unauthenticated;
    notifyListeners();
  }

  /// A session was just saved: load everything behind the login screen. The
  /// one road in for every way of signing in.
  Future<void> _enterSignedIn(int revision) async {
    await _finishBootstrapSignedIn();
  }

  /// The phone's sign-in, first step: email [email] a one-time code. Throws the
  /// service's own reason ("Email is invalid") for the form to show. See
  /// `viewer/email_code_api.dart`.
  Future<void> sendLoginCode(String email) => viewer.emailLogin.sendCode(email);

  /// The phone's sign-in, second step: trade the emailed [code] for a session
  /// and go in.
  ///
  /// A wrong or expired code is thrown for the form to show beside the field —
  /// never raised to [lastError], which would put a second, generic error under
  /// the one the person is already reading. The login card stays up throughout:
  /// [signingIn] keeps it there (see `RootShell`), so the form keeps what was
  /// typed into it.
  Future<void> signInWithCode({
    required String email,
    required String code,
  }) async {
    final login = viewer.emailLogin;
    if (_disposed || signingIn) return;
    final revision = _invalidateAuthWork();
    _closedHistory.clear();
    _lastError = null;
    signingIn = true;
    notifyListeners();
    try {
      await login.signIn(email: email, code: code);
      if (!_authWorkCurrent(revision)) return;
      status = AppStatus.bootstrapping;
      notifyListeners();
      await _enterSignedIn(revision);
    } catch (_) {
      if (_authWorkCurrent(revision)) {
        status = AppStatus.unauthenticated;
      }
      rethrow;
    } finally {
      if (_authWorkCurrent(revision)) {
        signingIn = false;
        notifyListeners();
      }
    }
  }

  /// Sign in with the one-time code a signed-in computer's Add Phone QR
  /// carries — no email, no digits — and go in. Thrown and kept like
  /// [signInWithCode]: the welcome screen falls back to an emailed code.
  Future<void> signInWithScan(String code) async {
    final login = viewer.emailLogin;
    if (_disposed || signingIn) return;
    final revision = _invalidateAuthWork();
    _closedHistory.clear();
    _lastError = null;
    signingIn = true;
    notifyListeners();
    try {
      await login.signInWithScan(code, label: phoneClientDescriptor().name);
      if (!_authWorkCurrent(revision)) return;
      status = AppStatus.bootstrapping;
      notifyListeners();
      await _enterSignedIn(revision);
    } catch (_) {
      if (_authWorkCurrent(revision)) {
        status = AppStatus.unauthenticated;
      }
      rethrow;
    } finally {
      if (_authWorkCurrent(revision)) {
        signingIn = false;
        notifyListeners();
      }
    }
  }

  Future<void> logout() async {
    // Signing out takes this phone's key out of the account's devices, while the sign-in still works
    // to say so. Best effort, and brief.
    if (_deviceLog case final log?) {
      try {
        await log.leave().timeout(const Duration(seconds: 5));
      } catch (_) {}
    }
    final revision = _invalidateAuthWork();
    signingIn = false;
    // A scanned code belongs to the session it was scanned into. Held past this,
    // the next sign-in — perhaps another account's — would spend it on the first
    // locked machine of that id and show a pairing error where its password form
    // belongs. Not in [_invalidateAuthWork]: signing IN starts there too, and the
    // code is set before that sign-in on purpose (`phone_welcome.dart`).
    pendingPairing = null;
    _closedHistory.clear();
    // Best-effort and fire-and-forget: local state is cleared below regardless, but the saved
    // session goes too, so the NEXT launch doesn't silently sign back in without ever showing the
    // login screen.
    unawaited(cliLogin.logout());
    _stopAllOfflineRetries();
    _stopAllAgentSyncTimers();
    _stopAccountTimers();
    // Tiles go, the saved layout stays: signing out and back in is the same
    // person at the same desk, and the file is only read once machines exist.
    await _closeAllPanes(persist: false);
    if (!_authWorkCurrent(revision)) return;
    _closedHistory.clear();
    await _pool?.closeAll();
    if (!_authWorkCurrent(revision)) return;
    _pool = null;
    _clearAllTurnActivity();
    // The desk belongs to the account, not to the phone: its tabs go with the
    // session, writes this phone never managed to send included.
    _desk.reset();
    // The zoo is the account's too.
    zoo.reset();
    individualArt.reset();
    currentUser = null;
    machines = [];
    machineStates.clear();
    for (final controller in _teamControllers.values) {
      controller.dispose();
    }
    _teamControllers.clear();
    for (final controller in _channelControllers.values) {
      controller.dispose();
    }
    _channelControllers.clear();
    // ⚠️ The warm-start cache is this account's machine ids, so it goes with the
    // session. Left behind, the next launch would dial the previous account's
    // machines before its own fetch could say they are not its own — reaching
    // for computers the person signing in may have no relationship to at all.
    // Not awaited: sign-out must not wait on a disk write, and the cache is only
    // ever read after a sign-in that this clears the way for.
    unawaited(_machineCache?.clear());
    sessionPreviews.clear();
    agentNotices.reset();
    // The account's device notices go with it: the next sign-in may be another account's, and what
    // is still pending comes back from its own log once it registers.
    _clearDeviceNotices();
    expandedMachines.clear();
    selectedMachineId = null;
    status = AppStatus.unauthenticated;
    notifyListeners();
  }

  /// Forget every device notice of the account that just left (banner, removals), and make a read of
  /// its `pending` that is still in flight drop its result: the next sign-in may be another account's.
  void _clearDeviceNotices() {
    _pendingSyncGen++;
    _startupDeviceNotices.clear();
    newDevices.clear();
    departedDevices.clear();
    deviceRemovals.clear();
    _failedDismissals.clear();
    _deviceListFrozen = false;
    _deviceListTooMany = false;
  }

  /// What an account leaving takes with it: the refusals being settled, the machine list re-read
  /// while deaf, and when each machine last swapped trust groups (the next account's swap is its own).
  void _stopAccountTimers() {
    _forgetAllTrustSettles();
    _stopDeafPoll();
    _groupSyncedAt.clear();
  }

  void _onLocalFailure(String machineId, int code, String reason) {
    final machine = machineStates[machineId];
    if (machine == null || code != 4404) return;
    // A refusal for want of trust is usually only early: this phone's key not yet in the account's
    // device log, or the machine not yet in this phone's copy of it — a computer signed in after the
    // phone was. That is settled first ([_settleTrust]), while the machine keeps showing as
    // connecting; only a refusal that outlasts it asks for a password. Not for a machine a scanned
    // code waits for: its pairing screen is the way in, at once.
    if (_deviceLog != null &&
        (reason == 'NO_PEER_LINK' || reason == 'E2E_DENIED') &&
        pendingPairing?.machineId != machineId) {
      if ((_trustRounds[machineId] ?? 0) < _trustSettleRounds) {
        if (_trustSettling.add(machineId)) {
          unawaited(_settleTrust(machineId, reason));
        }
        return;
      }
      if (!machine.needsLink) {
        appLog.info(
          'link',
          '${_shortId(machineId)} still refused ($reason) after the device list was checked',
        );
      }
    }
    // A machine the account's device key log names may simply not have read it yet: read it again;
    // a machine it pins is dialled again as soon as it lands.
    if (_deviceLog case final log?) unawaited(log.refresh());
    _markNeedsLink(machine);
  }

  void _markNeedsLink(MachineState machine) {
    // The relay found no linked trust for this machine: it waits for this phone's password form (or
    // a scanned code), which reconnects when it lands. Nothing is polled — the desktop retries every
    // few seconds for a `harness link connect` run elsewhere, which a phone's links never come from.
    machine.needsLink = true;
    machine.agentLoadStatus = AgentLoadStatus.needsLink;
    // A 4404 can also arrive MID-SESSION ("peer revoked trust" in the CLI's
    // remoteRelay.ts) with terminals open on this machine. The disconnect
    // that follows deliberately no longer marks the node offline (see the
    // onStatus branch in _ensurePool), so the tiles have to be told here
    // instead — otherwise they keep rendering as live until a heartbeat
    // fails, and nothing records what to reattach once the machine is linked
    // again.
    _markSessionsUnreachable(
      machine,
      'This machine is no longer linked. Link it again to reconnect.',
    );
    notifyListeners();
  }

  // -- a refusal for want of trust ([_onLocalFailure]) ---------------------------------------------

  /// How many refusals of each machine were settled since it last connected, and the ones under way —
  /// each with what ends its wait early (a pin landing: [_redialNewlyTrusted]).
  final Map<String, int> _trustRounds = {};
  final Set<String> _trustSettling = {};
  final Map<String, Completer<void>> _trustWakes = {};
  static const _trustSettleRounds = 2;

  /// How long one settling round waits for the machine's key to land before dialling again: two
  /// rounds, about fifteen seconds, before a password is asked for.
  @visibleForTesting
  Duration trustSettleRound = const Duration(milliseconds: 7500);

  /// How long a machine that denied this phone's key gets to read the account's log again (its CLI
  /// does on a hello from a key it does not know) before the first hello is said again.
  @visibleForTesting
  Duration trustDeniedWait = const Duration(seconds: 1);

  /// Hears every [_redial], for a test with no pool to dial through.
  @visibleForTesting
  void Function(String machineId)? onRedialForTest;

  static String _shortId(String id) => id.length > 8 ? id.substring(0, 8) : id;

  /// One round of settling [machineId]'s refusal ([reason]: `NO_PEER_LINK`, no key here for it, or
  /// `E2E_DENIED`, the machine does not know this phone's): put this phone into the account's device
  /// log and read it, then dial again — at once when the machine's key just landed, after a moment for
  /// a machine that has to read the log itself. A frozen log can settle nothing: the password it is.
  Future<void> _settleTrust(String machineId, String reason) async {
    final log = _deviceLog;
    if (log == null) return;
    final revision = _authRevision;
    final round = _trustRounds[machineId] = (_trustRounds[machineId] ?? 0) + 1;
    final wake = _trustWakes[machineId] = Completer<void>();
    final short = _shortId(machineId);
    bool current() =>
        !_disposed &&
        _authWorkCurrent(revision) &&
        identical(_trustWakes[machineId], wake) &&
        machineStates.containsKey(machineId);
    final started = Stopwatch()..start();
    try {
      final registration = await log.ensureRegistered().timeout(
        trustSettleRound,
        onTimeout: () => DeviceLogRegistration.missing,
      );
      if (!current()) return;
      if (registration == DeviceLogRegistration.frozen) {
        appLog.info('link', '$short refused ($reason): the device list is frozen');
        // The machine's password form says so (deviceListNeedsReview), from the listing.
        unawaited(_syncPendingDevices());
        _trustRounds[machineId] = _trustSettleRounds;
        _endTrustSettle(machineId);
        final machine = machineStates[machineId]!
          ..connectionStatus = ConnectionStatus.disconnected;
        _markNeedsLink(machine);
        return;
      }
      if (registration == DeviceLogRegistration.registered) {
        appLog.info('link', '$short refused ($reason): this phone joined the device list');
      }
      final pinned = await _holdsMachineKey(machineId);
      if (!current()) return;
      if (reason == 'E2E_DENIED' || !pinned) {
        final rest = trustSettleRound - started.elapsed;
        final wait = reason == 'E2E_DENIED' && round == 1
            ? trustDeniedWait
            : rest.isNegative
            ? Duration.zero
            : rest;
        await Future.any([Future<void>.delayed(wait), wake.future]);
        if (!current()) return;
      }
      final now = pinned || await _holdsMachineKey(machineId);
      if (!current()) return;
      appLog.info(
        'link',
        '$short refused ($reason): ${now ? 'pinned' : 'no key yet'}, dialling again (round $round)',
      );
      _endTrustSettle(machineId);
      _redial(machineId);
    } finally {
      // However the round ended, a machine no longer being settled can be settled again.
      if (identical(_trustWakes[machineId], wake)) _endTrustSettle(machineId);
    }
  }

  void _endTrustSettle(String machineId) {
    _trustSettling.remove(machineId);
    final wake = _trustWakes.remove(machineId);
    if (wake != null && !wake.isCompleted) wake.complete();
  }

  /// [machineId] connected, or the account is left: its refusals start counting again.
  void _forgetTrustSettle(String machineId) {
    _trustRounds.remove(machineId);
    _endTrustSettle(machineId);
  }

  void _forgetAllTrustSettles() {
    for (final machineId in [..._trustRounds.keys, ..._trustSettling]) {
      _forgetTrustSettle(machineId);
    }
  }

  Future<bool> _holdsMachineKey(String machineId) async {
    try {
      return await viewer.keys.peer(machineId) != null;
    } catch (_) {
      return false;
    }
  }

  /// Dial [machineId] again from scratch: a refused connection is closed for good, so it is closed
  /// and replaced.
  void _redial(String machineId) {
    final machine = machineStates[machineId];
    if (machine == null) return;
    onRedialForTest?.call(machineId);
    unawaited(_pool?.closeMachine(machineId));
    _connectMachine(machine);
  }

  /// The token a viewer's relay socket dials with.
  Future<String> _socketToken(bool force, String? failedToken) =>
      // Only a session that is gone for good may sign the person out — see
      // [WsCredentialRevoked]. An outage fails the refresh too, and is retried.
      viewer.auth
          .accessToken(force: force, failedToken: failedToken)
          .onError<DirectAuthException>(
            (error, _) => throw WsCredentialRevoked(error.message),
            test: (error) => error.signedOut,
          );

  /// [_socketToken], for a test: the pool that asks for it dials for real.
  @visibleForTesting
  Future<String> socketTokenForTest({
    bool force = false,
    String? failedToken,
  }) => _socketToken(force, failedToken);

  void _ensurePool() {
    if (_pool != null) return;
    _pool = WsPool(
      wsBaseUrl: config.wsBaseUrl,
      autonomousEnv: _autonomousEnv,
      accessTokenProvider: _socketToken,
      relayCodecs: viewer.relayCodecs,
      transportPlugins: viewer.transportPlugins,
      onAuthFailure: _signedOutAtRuntime,
      onLocalFailure: _onLocalFailure,
      onEvent: _handleEvent,
      onStatus: _onConnectionStatus,
    );
  }

  /// What a machine's socket coming up, dropping or re-dialling does to the model.
  void _onConnectionStatus(String machineId, ConnectionStatus nextStatus) {
    final machine = machineStates[machineId];
    if (machine == null) return;
    // A refusal being settled against the device log ([_settleTrust]) is still connecting.
    final settling =
        nextStatus == ConnectionStatus.disconnected &&
        _trustSettling.contains(machineId);
    machine.connectionStatus = settling
        ? ConnectionStatus.connecting
        : nextStatus;
    if (nextStatus == ConnectionStatus.connected) {
      _refreshDeviceLogAfterReconnect();
      machine.needsLink = false;
      _forgetTrustSettle(machineId);
      // A relay socket reports `connected` only after the machine's welcome
      // proved the link (`WsConn._markReady`), so a code held to pair this
      // machine has nothing left to do. Kept, it would be spent the next time
      // the machine locks — an unlink, say — in place of its password form.
      if (pendingPairing?.machineId == machineId) pendingPairing = null;
      // Route through _applyNodeStatus (not just `machine.nodeOnline = true`) for every machine,
      // not only the local one — a successful select IS the machine being reachable again, and
      // this is what lets a pending agent (captured below on disconnect) reattach automatically
      // instead of leaving the user stuck on the empty "select a machine" placeholder.
      unawaited(_applyNodeStatus(machine, true));
      unawaited(_loadMachineData(machine, force: true));
      _startAgentSyncTimer(machineId);
      // A session came up: the moment to compare trust groups with this machine.
      unawaited(_syncGroup(machineId));
    } else if (nextStatus == ConnectionStatus.reconnecting ||
        nextStatus == ConnectionStatus.disconnected) {
      _stopAgentSyncTimer(machineId);
      _clearMachineActivity(machine);
      // Same reasoning as above, mirrored: capture pendingOfflineAgentId from the currently-open
      // terminal (if any) so the connected branch above can reattach it, for every machine — this
      // used to be local-only, which is why a remote machine's terminal never came back on its own
      // after `harness start` on that machine, even though the guide screen promised it would.
      //
      // NOT while the machine is unlinked. NO_PEER_LINK is a lookup failing in a peer table
      // before anything is dialled, so that close says nothing about whether the OTHER computer is
      // up — our socket never reaches it. needsLink is set by onLocalFailure, which runs before
      // this branch for 4404 (see WsConn._onDone).
      //
      // ⚠️ And the machine is not marked offline. The socket is the phone's own line to the
      // relay — backgrounding the app drops it, and so does a tunnel — and losing it says nothing
      // about the machine at the other end, which `node_status`, `/api/machines` and a timed-out
      // request still report. Read as offline, every return to the app flashed "Offline" and
      // threw the pager away. The streams on it are dead all the same: told so, and put back once
      // the socket is.
      if (!machine.needsLink && !settling) {
        _markSessionsUnreachable(machine, 'Connection lost. Reconnecting…');
      }
    }
    notifyListeners();
  }

  /// One tick of the agent-list safety net ([_syncAgentsIfChanged]), which the
  /// app itself only reaches through a 60-second timer.
  @visibleForTesting
  Future<void> syncAgentsForTest(String machineId) async {
    final machine = machineStates[machineId];
    if (machine == null) return;
    await _syncAgentsIfChanged(machine);
  }

  @visibleForTesting
  void connectionStatusForTest(String machineId, ConnectionStatus status) =>
      _onConnectionStatus(machineId, status);

  /// The machine list is being fetched and there is nothing to show meanwhile.
  ///
  /// Only the FIRST fetch sets it: a refresh over a list already on screen
  /// keeps that list up (the rows are still true, just not from a moment ago)
  /// and reports nothing. The rail reads this to tell "loading" from "no
  /// machines", which an empty list alone cannot say.
  bool machinesLoading = false;

  Future<void> refreshMachines() async {
    final revision = _authRevision;
    if (!_authWorkCurrent(revision)) return;
    if (machines.isEmpty && !machinesLoading) {
      machinesLoading = true;
      notifyListeners();
    }
    try {
      await _refreshMachines(revision);
    } finally {
      // Said out loud: the list's own notify fires before this, so a flag
      // dropped silently here would leave the rail on its placeholders.
      if (_authWorkCurrent(revision) && machinesLoading) {
        machinesLoading = false;
        notifyListeners();
      }
    }
  }

  /// Tell the device log who is signed in, once per sign-in, synchronously (see
  /// [ViewerDeviceLog.beginSignIn]); [_registerDeviceLog] then finds it done.
  void _beginDeviceLogSignIn(int revision) {
    if (_deviceLogBegun == revision) return;
    _deviceLogBegun = revision;
    _deviceLog?.beginSignIn(fresh: viewer.auth.consumeFreshSignIn());
  }

  /// The account's device key log: this phone's key joins it (an existing sign-in too, from
  /// before the log existed), and every machine it names is reached with no password. Once per
  /// sign-in, the moment the app is authenticated ([_finishBootstrapSignedIn]) — before the machine
  /// list and the profile, and not waiting for either. Which account the log belongs to is a local
  /// fact the log keeps itself ([_beginDeviceLogSignIn]), never something the backend says, so
  /// there is nothing to read first.
  void _registerDeviceLog(int revision) {
    if (!_authWorkCurrent(revision) || status != AppStatus.authenticated || _deviceLogRegistered == revision) {
      return;
    }
    _deviceLogRegistered = revision;
    final log = _deviceLog;
    if (log == null) return;
    // Normally already begun at the top of [_finishBootstrapSignedIn]; a no-op then.
    _beginDeviceLogSignIn(revision);
    unawaited(
      log
          .register()
          // Then what is still pending from before (a restart) comes back as the banner.
          .whenComplete(_syncPendingDevices),
    );
  }

  Future<void> _refreshMachines(int revision) async {
    // No machine is "this computer" to a viewer, which has no local CLI: every one — even the one
    // it runs on — is reached through the relay.
    final list = await _fetchMachines();
    if (!_authWorkCurrent(revision)) return;
    machines = list
        .where((machine) => machine.authMode == MachineAuthMode.remote)
        .toList();
    final visible = machines.map((machine) => machine.machineId).toSet();
    // A code scanned for a machine this account does not have can never be
    // spent: the pairing screen waits for that machine to show up locked.
    if (pendingPairing case final pending?
        when !visible.contains(pending.machineId)) {
      pendingPairing = null;
    }
    for (final entry in machineStates.entries) {
      if (!visible.contains(entry.key)) {
        _clearMachineActivity(entry.value);
        _stopOfflineRetry(entry.key);
        _stopAgentSyncTimer(entry.key);
        // ⚠️ The SOCKET goes too, not just the bookkeeping above. Dropping the
        // state alone left the pool holding a live connection to a machine
        // nothing referred to any more — it kept dialling and reconnecting for
        // the rest of the session, with `_onConnectionStatus` discarding every
        // event because the state it looks up no longer exists.
        //
        // Reachable before [_warmStartMachines] only when a machine left the
        // account between two refreshes; reachable on every launch now, because
        // the warm start dials from a cache that can name a machine this fetch
        // does not return. Same fix either way.
        unawaited(_pool?.closeMachine(entry.key));
      }
    }
    machineStates.removeWhere((id, _) => !visible.contains(id));
    for (final machine in machines) {
      final state = machineStates.update(
        machine.machineId,
        (state) => state..machine = machine,
        ifAbsent: () => MachineState(machine),
      );
      final reportedOnline = _nodeOnlineFromStatus(machine.status);
      if (reportedOnline != null &&
          (state.nodeOnline == null || state.nodeOnline != reportedOnline)) {
        unawaited(_applyNodeStatus(state, reportedOnline));
      }
    }
    _autoConnectAndLoadMachines();
    // The list that just landed is what the NEXT launch starts from. Never
    // awaited: it is a hint for a future run and must not add a disk write to
    // the one a person is waiting on right now.
    final cache = _machineCache;
    if (cache != null) {
      unawaited(
        cache.save(
          machines,
          isOnline: (machine) => _nodeOnlineFromStatus(machine.status) == true,
        ),
      );
    }
    notifyListeners();
  }

  // The daemon reports `connected` only once its own backend socket is open, but
  // `/api/machines` is a separate REST leg (fresh token refresh + fetch) that can still stall
  // briefly right after that — a bounded retry absorbs that transient window without falling
  // back to the 30s Dio timeout. Never retries an `ApiException` (a real HTTP error response);
  // only a `DioException` (timeout/connection failure) is worth a second try.
  // Capped at 2 attempts, not 3: `receiveTimeout` is 30s, so every retried attempt can cost
  // another 30s on a genuine failure — one retry absorbs the transient window above without
  // tripling how long a truly broken backend takes to surface its error.
  Future<List<Machine>> _fetchMachines() => withRetry(
    api.machines,
    maxAttempts: 2,
    initialDelay: const Duration(milliseconds: 500),
    isRetryable: (error) => error is DioException,
  );

  void _startOfflineRetry(MachineState machine) {
    final machineId = machine.machine.machineId;
    if (machine.nodeOnline != false || machine.pendingOfflineAgentId == null) {
      _stopOfflineRetry(machineId);
      return;
    }
    if (_offlineRetryTimers.containsKey(machineId)) return;
    _offlineRetryTimers[machineId] = Timer.periodic(
      offlineRetryInterval,
      (_) => unawaited(_pollOfflineMachine(machineId)),
    );
  }

  void _stopOfflineRetry(String machineId) {
    _offlineRetryTimers.remove(machineId)?.cancel();
  }

  void _stopAllOfflineRetries() {
    for (final timer in _offlineRetryTimers.values) {
      timer.cancel();
    }
    _offlineRetryTimers.clear();
    _offlinePollsInFlight.clear();
  }

  void _startAgentSyncTimer(String machineId) {
    if (_agentSyncTimers.containsKey(machineId)) return;
    _agentSyncTimers[machineId] = Timer.periodic(agentSyncInterval, (_) {
      final machine = machineStates[machineId];
      if (machine == null) {
        _stopAgentSyncTimer(machineId);
        return;
      }
      unawaited(_syncAgentsIfChanged(machine));
    });
  }

  void _stopAgentSyncTimer(String machineId) {
    _agentSyncTimers.remove(machineId)?.cancel();
    _agentSyncTimeouts.remove(machineId);
  }

  void _stopAllAgentSyncTimers() {
    for (final timer in _agentSyncTimers.values) {
      timer.cancel();
    }
    _agentSyncTimers.clear();
    _agentSyncTimeouts.clear();
  }

  /// How many [agentSyncInterval] ticks in a row may time out before the machine
  /// is treated as gone and redialled ([_recoverStaleSession]).
  ///
  /// Two, not one: a single missed tick is a busy machine or a slow relay, and a
  /// forced redial costs every terminal on it a resync. Two in a row is a minute
  /// of a machine not answering the cheapest request there is, which nothing
  /// healthy does.
  @visibleForTesting
  static const agentSyncStaleTicks = 2;

  /// Consecutive timed-out [_syncAgentsIfChanged] ticks, per machine. Cleared by
  /// any answer, by any other failure, and by the timer stopping.
  final Map<String, int> _agentSyncTimeouts = {};

  /// Silent safety-net reconciliation, ticked every [agentSyncInterval] while a machine is connected.
  /// Only writes/notifies if the fetched list actually differs from what's already shown — a steady
  /// state where push events (agent_synced et al.) have kept everything in sync produces zero visible
  /// effect. Deliberately does not touch agentLoadStatus/agentsLoadError/notifyListeners on failure:
  /// a real connectivity problem is already surfaced by the push path, and a quiet background tick
  /// should not fight it.
  ///
  /// ⚠️ **Except a timeout, which this is the only thing left watching for.** A
  /// stale relay session (see [_recoverStaleSession]) leaves the transport
  /// "connected", the machine `nodeOnline`, its list `loaded` — so no screen is
  /// wrong, no push arrives to correct it, and nothing calls
  /// [_performMachineDataLoad], which is where the offline detection this used
  /// to defer to actually lives. Swallowed here, that state was permanent:
  /// measured at 16 minutes and still going, a phone showing a machine's agent
  /// list from before its Harness restarted, with every agent made since
  /// invisible — and, with the list feeding `deskGroups`, a desk tab whose
  /// harnesses had all silently vanished off the phone.
  Future<void> _syncAgentsIfChanged(MachineState machine) async {
    if (machine.connectionStatus != ConnectionStatus.connected) return;
    if (machine.agentsLoadInFlight != null) {
      return; // a real (foreground) load already owns this tick
    }
    final machineId = machine.machine.machineId;
    final revision = _authRevision;
    final connection = _conn(machineId);
    try {
      final response = await connection.request(
        'agents_list',
        payload: kAgentsListPayload,
        timeout: const Duration(seconds: 10),
      );
      _agentSyncTimeouts.remove(machineId);
      if (!_machineWorkCurrent(machine, revision)) return;
      // ⚠️ A terminal switched off by a negotiation that never got an answer stayed off until
      // the next reconnect: the machine answered this, so the link is up — ask again.
      if (machine.terminalCapabilityUnanswered) {
        unawaited(_loadTerminalCapabilities(machine, connection, revision));
      }
      final agents = (response['agents'] as List<dynamic>? ?? [])
          .map((item) => Agent.fromJson(item as Map<String, dynamic>))
          .toList();
      if (agentsEqual(machine.agents, agents)) return;
      _replaceAgents(machine, agents);
      notifyListeners();
    } on WsRequestTimeout {
      if (!_machineWorkCurrent(machine, revision)) return;
      final missed = (_agentSyncTimeouts[machineId] ?? 0) + 1;
      _agentSyncTimeouts[machineId] = missed;
      if (missed < agentSyncStaleTicks) return;
      _agentSyncTimeouts.remove(machineId);
      appLog.warn(
        'ws',
        'agents_list timed out $missed× on $machineId — redialling',
      );
      _recoverStaleSession(machine, connection);
    } catch (_) {
      // Silent by design — see doc comment above. A socket that dropped
      // mid-request is already redialling, so the count starts over.
      _agentSyncTimeouts.remove(machineId);
    }
  }

  /// Order-insensitive value equality for [Agent] lists — [Agent] has no operator== override, and a
  /// backend that returns the same agents in a different order must not register as "changed".
  ///
  /// ⚠️ Every field of [Agent] that the UI reads belongs here. This list is hand-maintained, and the
  /// cost of forgetting one is silent: the poll fetches the truth, compares it, decides nothing
  /// happened, and throws it away — so the field stays frozen at whatever it was for as long as the
  /// app runs. Add the field here in the same commit you add it to [Agent].
  @visibleForTesting
  static bool agentsEqual(List<Agent> a, List<Agent> b) {
    if (a.length != b.length) return false;
    final byId = {for (final agent in a) agent.id: agent};
    for (final agent in b) {
      final prev = byId[agent.id];
      if (prev == null ||
          prev.name != agent.name ||
          // What search and the Recent list read: a turn that ends moves
          // `updatedAt` and often `title`, and a sync that ignored them left
          // the phone sorting and searching by the list it had an hour ago.
          prev.title != agent.title ||
          prev.updatedAt != agent.updatedAt ||
          prev.lastOpenedAt != agent.lastOpenedAt ||
          prev.gridModel != agent.gridModel ||
          // The model sheet's sentence under a Local model.
          prev.gridWebSearch != agent.gridWebSearch ||
          prev.selectedModel != agent.selectedModel ||
          prev.dshName != agent.dshName ||
          prev.sessionId != agent.sessionId ||
          prev.engine != agent.engine ||
          prev.engineDisplayName != agent.engineDisplayName ||
          prev.engineIconHint != agent.engineIconHint ||
          prev.codexHome != agent.codexHome ||
          prev.parentAgentId != agent.parentAgentId ||
          prev.project != agent.project ||
          prev.gitContext != agent.gitContext ||
          prev.launchState != agent.launchState ||
          prev.launchError != agent.launchError ||
          prev.launchDetail != agent.launchDetail ||
          prev.status != agent.status ||
          prev.terminalAvailable != agent.terminalAvailable ||
          prev.terminalUnavailableReason != agent.terminalUnavailableReason ||
          // A row's stats line (`sheet_agent_lines.dart`) — the desktop
          // compares these three too.
          prev.tokensUsed != agent.tokensUsed ||
          prev.tokensUpdatedAt != agent.tokensUpdatedAt ||
          prev.outputStats != agent.outputStats ||
          // Whether a stopped row can be opened at all ([Agent.canPauseAndResume]).
          prev.resumeMode != agent.resumeMode) {
        return false;
      }
    }
    return true;
  }

  /// Public retry hook used by the offline join guide's "Retry now" action.
  Future<void> retryOfflineMachine(String machineId) =>
      _pollOfflineMachine(machineId);

  /// Links [machineId] by its remote password — the exchange `harness link connect` runs on a
  /// desktop, run here by [peerLinks] (`viewer/password_link.dart`) — for a machine the relay
  /// reported `NO_PEER_LINK` for, then reconnects it. Returns null on success, or an error
  /// message to show inline.
  Future<String?> connectWithPassword(
    String machineId,
    String password, {
    void Function(String stage)? onProgress,
  }) async {
    if (password.isEmpty) return 'Enter the remote password first';
    final result = await peerLinks.connect(
      machineId,
      password,
      onProgress: onProgress,
      displayName: machineStates[machineId]?.machine.displayName,
      label: phoneClientDescriptor().name,
    );
    if (result.error != null) return result.error;
    final targetId = result.linkedMachineId ?? machineId;
    final state = machineStates[targetId];
    if (state != null) {
      state.needsLink = false;
      state.agentLoadStatus = AgentLoadStatus.idle;
      notifyListeners();
      // The old WsConn closed itself permanently on NO_PEER_LINK — connFor() would otherwise see a
      // matching endpointKey and hand back that dead connection instead of dialing a fresh one.
      await _pool?.closeMachine(targetId);
      _connectMachine(state);
    }
    // One password, the whole group: this machine learns the phone's other machines, and they it.
    unawaited(_syncGroup(targetId, spread: true));
    return null;
  }

  // -- the account's devices: the device key log (viewer/device_log_sync.dart) --------------------

  ViewerDeviceLog? _deviceLog;
  int? _deviceLogRegistered;
  int? _deviceLogBegun;

  /// What the device log announced (a new device, a removal) while the app was still starting up:
  /// the OS notice and the banner wait for [_flushDeviceNotices], so a read that lands before the
  /// app is `authenticated` is not lost. Each carries the sign-in it belongs to; only a signed-out
  /// app drops them.
  final List<({int revision, void Function() run})> _startupDeviceNotices = [];

  /// Run [notice] now when the app is signed in; park it while it is still starting up; drop it
  /// when signed out (an in-flight read of the account that just left must not raise anything).
  void _whenSignedIn(void Function() notice) {
    if (_disposed || status == AppStatus.unauthenticated) return;
    if (status == AppStatus.bootstrapping) {
      _startupDeviceNotices.add((revision: _authRevision, run: notice));
      return;
    }
    notice();
  }

  void _flushDeviceNotices(int revision) {
    final parked = [..._startupDeviceNotices];
    _startupDeviceNotices.clear();
    for (final p in parked) {
      // Another sign-in began meanwhile: these are the previous account's.
      if (p.revision != revision || !_authWorkCurrent(revision)) continue;
      p.run();
    }
    // The replay put keys on the banner as they were when they were read; the log may have moved
    // on since (dismissed, removed): the banner is what the log holds now.
    if (parked.isNotEmpty) unawaited(_syncPendingDevices());
  }

  /// Devices that joined the account and this phone had never trusted, not yet dismissed. Rebuilt
  /// from the log's persisted `pending` ([_syncPendingDevices]), so a restart does not lose them.
  final List<DevLogMember> newDevices = [];

  /// Which of [newDevices] a fork suspended (not trusted here until the list is reviewed), as of the
  /// last read of the log. "Mine" on the banner cannot lift that, so for these it opens the device's
  /// page, which says why.
  final Set<String> _suspendedNew = {};

  bool newDeviceSuspended(String pub) => _suspendedNew.contains(pub);

  /// Devices taken out of the account by another device, until dismissed. Not persisted: the device
  /// history is the durable record.
  final List<DeviceRemovalNotice> deviceRemovals = [];

  /// Devices that joined and left the account before anyone here looked, until "Got it" (read from
  /// the log's persisted `departed`, so a restart does not lose them), oldest first.
  final List<DeviceLogDeparted> departedDevices = [];

  /// The key that removed [d] is itself a device nobody looked at (still new, or itself gone before
  /// anyone looked) — the alarming case. A device that signed itself out is never red.
  bool departedRed(DeviceLogDeparted d) =>
      !d.selfRemoved &&
      d.removedBy.isNotEmpty &&
      (newDevices.any((n) => n.pub == d.removedBy) ||
          departedDevices.any((o) => o.pub == d.removedBy));

  /// "Got it" on a device that left before it was looked at: saved, so the banner does not come back.
  void dismissDeparted(String pub) {
    _pendingSyncGen++;
    departedDevices.removeWhere((d) => d.pub == pub);
    // A "signed out" notice for the same key is the same ghost: the banner leaves it out while the
    // departed mark is up, so this "Got it" is its dismissal too (it must not surface afterwards).
    deviceRemovals.removeWhere((r) => r.pub == pub && r.selfRemoved);
    unawaited(_dismissInLog(pubs: [pub]));
    devicesRevision++;
    notifyListeners();
  }

  /// Bumped whenever the account's devices may have changed; the Devices page re-reads on it.
  int devicesRevision = 0;

  ViewerDeviceLog? get deviceLog => _deviceLog;

  /// This phone's copy of the device log is frozen, so it pins no machine from it until someone
  /// reviews the list (Your devices). A machine asking for its password says so.
  bool get deviceListNeedsReview => _deviceListFrozen;
  bool _deviceListFrozen = false;

  @visibleForTesting
  set deviceListNeedsReviewForTest(bool frozen) {
    _deviceListFrozen = frozen;
    notifyListeners();
  }

  /// The backend refused this phone a place on the account: it has too many devices (`TOO_MANY`).
  /// A machine asking for its password says so, beside [deviceListNeedsReview].
  bool get deviceListTooMany => _deviceListTooMany;
  bool _deviceListTooMany = false;

  @visibleForTesting
  set deviceListTooManyForTest(bool tooMany) {
    _deviceListTooMany = tooMany;
    notifyListeners();
  }

  /// Devices this phone dismissed whose write to the log failed: the banner must not bring them back
  /// on the next read of `pending`. Gone with the sign-in, or when the key is announced afresh.
  final Set<String> _failedDismissals = {};

  Future<void> _dismissInLog({String? pub, List<String>? pubs}) async {
    final log = _deviceLog;
    if (log == null) return;
    try {
      await log.dismiss(pub: pub, pubs: pubs);
    } catch (error) {
      debugPrint('devices: could not save the dismissal: $error');
      _failedDismissals.addAll([...?pubs, ?pub]);
    }
  }

  void _initDeviceLog() {
    final log = _deviceLog = ViewerDeviceLog(
      keys: viewer.keys,
      // This phone's own key rides each read, so the backend counts it as used (not as abandoned).
      fetch: (since) async => api.deviceKeys(
        since,
        self: await viewer.keys.identity().then<String?>((i) => b64e(i.pub), onError: (Object _) => null),
      ),
      append: (entry) => api.appendDeviceKey(entry),
      label: () => phoneClientDescriptor().name,
      // The log saves "announced" before it calls back, so a call that found the app still starting
      // up and was dropped would never be made again: [_whenSignedIn] parks it instead. Only a
      // signed-out app (an in-flight read of the account that just left) drops one.
      onAnnounce: (m) => _whenSignedIn(() {
        _failedDismissals.remove(m.pub);
        if (newDevices.any((d) => d.pub == m.pub)) return;
        newDevices.add(m);
        devicesRevision++;
        final name = m.label.isEmpty ? 'A device' : m.label;
        unawaited(agentNotices.system.showAccountNotice(
          key: m.pub,
          title: 'New device on your account',
          body: '$name ${m.kind == 'machine' ? 'joined' : 'signed in to'} your account and can reach '
              'your machines. Not yours? Remove it in Settings ▸ Your devices.',
        ));
        if (!_disposed) notifyListeners();
      }),
      onRemoved: (n) => _whenSignedIn(() => announceDeviceRemoval(n)),
      onSignedOut: () async {
        // Sign out first: it takes this phone's key out of the log, which needs the key it is about.
        await logout();
        await viewer.keys.forgetIdentity();
      },
      onChanged: () {
        devicesRevision++;
        unawaited(_syncPendingDevices());
        unawaited(_redialNewlyTrusted());
        if (!_disposed) notifyListeners();
      },
    );
    final links = peerLinks;
    if (links is DirectLink) links.deviceLog = log;
  }

  /// A device was taken out of the account (not by this phone): say so, once. A removal by a new
  /// device nobody looked at is the alarming one; its notice opens that signer, the rest open the list.
  void announceDeviceRemoval(DeviceRemovalNotice n) {
    if (deviceRemovals.any((r) => r.pub == n.pub)) return;
    deviceRemovals.add(n);
    devicesRevision++;
    unawaited(agentNotices.system.showAccountNotice(
      key: n.red ? 'removedBy:${n.signer}:${n.pub}' : 'removed:${n.pub}',
      title: n.title,
      body: n.sentence,
    ));
    if (!_disposed) notifyListeners();
  }

  void dismissDeviceRemoval(String pub) {
    // Only the notice. The same event may also be kept by the log as "left before you looked" (the
    // departed band, which has its own "Got it" and is a durable mark): a notice dismissed here —
    // however benign it reads, e.g. a self sign-out — never clears it.
    deviceRemovals.removeWhere((r) => r.pub == pub);
    notifyListeners();
  }

  /// Bumped by every read of `pending` and every local dismissal: a read that started before either
  /// is stale and must not put dismissed devices back on the banner.
  int _pendingSyncGen = 0;

  /// Rebuild [newDevices] from the log's persisted `pending`, oldest first: what survived a restart,
  /// and what another path (a `group_sync`, a dismiss) changed.
  Future<void> _syncPendingDevices() async {
    final log = _deviceLog;
    if (log == null) return;
    final gen = ++_pendingSyncGen;
    final DeviceLogListing listing;
    try {
      listing = await log.list();
    } catch (_) {
      return;
    }
    if (_disposed || gen != _pendingSyncGen || status != AppStatus.authenticated) return;
    final frozen = listing.frozen != null;
    final tooMany = listing.registerError == 'TOO_MANY';
    final frozenChanged = frozen != _deviceListFrozen || tooMany != _deviceListTooMany;
    _deviceListFrozen = frozen;
    _deviceListTooMany = tooMany;
    final pending = listing.pending.toSet();
    _suspendedNew
      ..clear()
      ..addAll([
        for (final r in listing.members)
          if (r.suspended) r.member.pub,
      ]);
    final next = [
      for (final r in listing.members)
        if (pending.contains(r.member.pub) &&
            !r.self &&
            !_failedDismissals.contains(r.member.pub))
          r.member,
    ]..sort((a, b) => a.seq.compareTo(b.seq));
    final nextDeparted = [
      for (final d in listing.departed)
        if (!_failedDismissals.contains(d.pub)) d,
    ];
    final same = listEquals([for (final m in next) m.pub], [for (final m in newDevices) m.pub]);
    final sameDeparted =
        listEquals([for (final d in nextDeparted) d.pub], [for (final d in departedDevices) d.pub]);
    if (same && sameDeparted && !frozenChanged) return;
    newDevices
      ..clear()
      ..addAll(next);
    departedDevices
      ..clear()
      ..addAll(nextDeparted);
    notifyListeners();
  }

  /// A machine waiting on trust — being settled ([_settleTrust]), or asking for its password — that the
  /// device key log now vouches for: dial it again, at once.
  Future<void> _redialNewlyTrusted() async {
    for (final state in [...machineStates.values]) {
      final machineId = state.machine.machineId;
      if (!state.needsLink && !_trustSettling.contains(machineId)) continue;
      if (!await _holdsMachineKey(machineId)) continue;
      if (_trustWakes[machineId] case final wake? when !wake.isCompleted) {
        wake.complete();
        continue;
      }
      if (!state.needsLink) continue;
      state.needsLink = false;
      state.agentLoadStatus = AgentLoadStatus.idle;
      await _pool?.closeMachine(state.machine.machineId);
      _connectMachine(state);
    }
    if (!_disposed) notifyListeners();
  }

  /// When each of the account's keys last opened a session (`{pub: ms}`), for the Devices page.
  Future<Map<String, int>> devicesLastSeen() => api.deviceKeysSeen();

  /// The account's devices as this phone verified them. A seam of its own so a test can answer
  /// without a real device log.
  Future<DeviceLogListing> deviceListing() async => await _deviceLog?.list() ?? DeviceLogListing.empty;

  DateTime? _deviceLogReadAt;

  /// A socket came back: a `device_keys_changed` sent while this phone was offline reached nobody, so
  /// read the log again — and put this phone's key into it if the boot's register could not — at most
  /// every half minute, since a reconnect is every machine at once.
  void _refreshDeviceLogAfterReconnect() {
    final log = _deviceLog;
    if (log == null) return;
    final now = DateTime.now();
    if (_deviceLogReadAt case final last? when now.difference(last) < const Duration(seconds: 30)) return;
    _deviceLogReadAt = now;
    unawaited(log.ensureRegistered());
  }

  /// The devices list was opened: every device announced so far has been seen — the banner's, and
  /// [pending], what the list itself read from the log (after a restart, before the banner is rebuilt
  /// from it). Persisted, so the banner does not come back.
  ///
  /// [shown] is the banner's set as it was when the list was read: pass it when the page awaited
  /// anything in between, or a device announced meanwhile — never shown — would be dismissed unseen.
  /// Without it, the banner as it is now.
  void seenNewDevices({Iterable<String> pending = const [], Iterable<String>? shown}) {
    final bannerPubs = (shown ?? newDevices.map((d) => d.pub)).toList();
    if (bannerPubs.isEmpty && pending.isEmpty) return;
    // Exactly what was shown, never "all": a device added since (and not yet shown) stays pending.
    // And a device that left before anyone looked is cleared by its own "Got it" only: opening the
    // list is not that.
    final departed = {for (final d in departedDevices) d.pub};
    final marked = {...pending, ...bannerPubs}.where((p) => !departed.contains(p)).toList();
    // Nothing marked: a read of `pending` under way (the one a startup replay starts, which takes a
    // departed key's stale "New device" down) is not stale — let it land.
    if (marked.isEmpty) return;
    // A read of `pending` already under way predates this: it must not put them back.
    _pendingSyncGen++;
    unawaited(_dismissInLog(pubs: marked));
    final before = newDevices.length;
    newDevices.removeWhere((d) => marked.contains(d.pub));
    if (newDevices.length != before) notifyListeners();
  }

  /// "It's mine" on [pub]. Only the device's own page, which shows why a key is Suspended, passes
  /// [liftSuspension]: that is the person vouching for it. Anywhere else the key stays suspended —
  /// the banner never said so.
  void dismissNewDevice(String pub, {bool liftSuspension = false}) {
    newDevices.removeWhere((d) => d.pub == pub);
    // A key that joined and left before anyone looked: a "New device" for it is a stale replay, and its
    // flag is cleared by its own "Got it" only ([dismissDeparted]) — "It's mine" here takes the banner
    // down and marks nothing.
    if (departedDevices.any((d) => d.pub == pub)) {
      notifyListeners();
      return;
    }
    _pendingSyncGen++;
    unawaited(liftSuspension ? _dismissInLog(pub: pub) : _dismissInLog(pubs: [pub]));
    notifyListeners();
  }

  /// "Got it" on the Devices page's "Already on your account" list: persisted, shown once.
  Future<void> seeDeviceBaseline() async {
    try {
      await deviceLog?.seeBaseline();
    } catch (error) {
      debugPrint('devices: could not save the baseline as seen: $error');
    }
  }

  /// Every add and remove on the account as this phone verified it. A seam of its own so a test can
  /// answer without a real device log.
  Future<DeviceLogHistory> deviceHistory() async =>
      await _deviceLog?.history() ?? const DeviceLogHistory(rows: [], complete: false);

  /// Take [pub] out of the account on every device. Null when done, else why not.
  Future<String?> removeDevice(String pub) async {
    final log = _deviceLog;
    final error = log == null ? 'UNAVAILABLE' : await log.remove(pub);
    if (error == null) newDevices.removeWhere((d) => d.pub == pub);
    devicesRevision++;
    notifyListeners();
    return error;
  }

  /// A code scanned from a desktop app's "Add phone" QR, held across sign-in: once its machine shows
  /// up locked, the phone pairs with the code ([connectWithCode]) instead of asking for a password.
  /// See `phone/welcome/connect_code.dart`. Null the rest of the time.
  ({String machineId, String code})? pendingPairing;

  /// The scanned code is spent (it failed, or the person chose the password): the computer's
  /// password form is what the home screen shows next.
  void dropPendingPairing() {
    if (pendingPairing == null) return;
    pendingPairing = null;
    notifyListeners();
  }

  /// Pairs with [machineId] by the one-time code its desktop app showed, then reconnects it — the
  /// QR's way in, where [connectWithPassword] is the password's. Null on success, or what to show.
  Future<String?> connectWithCode(String machineId, String code) async {
    final result = await peerLinks.connectWithCode(
      machineId,
      code,
      label: phoneClientDescriptor().name,
      displayName: machineStates[machineId]?.machine.displayName,
    );
    if (result.error != null) return result.error;
    final state = machineStates[result.linkedMachineId ?? machineId];
    if (state != null) {
      state.needsLink = false;
      state.agentLoadStatus = AgentLoadStatus.idle;
      notifyListeners();
      await _pool?.closeMachine(state.machine.machineId);
      _connectMachine(state);
    }
    unawaited(_syncGroup(result.linkedMachineId ?? machineId, spread: true));
    return null;
  }

  /// A test's stand-in for the trust-group roster swap; null uses [DirectLink.syncGroup].
  late final GroupSync? _groupSyncOverride;

  /// The trust-group roster swap (`viewer/group_sync.dart`). Only the app's own [DirectLink] dials
  /// for it — a test that hands over fake links, or has no layout store (no state file), never does.
  GroupSync? get _groupSync {
    if (_groupSyncOverride case final sync?) return sync;
    final links = peerLinks;
    return links is DirectLink && _paneLayout != null ? links.syncGroup : null;
  }

  final Map<String, DateTime> _groupSyncedAt = {};
  static const _groupResync = Duration(minutes: 5);

  /// Swaps trust-group rosters with [machineId], at most every few minutes per machine — any
  /// session this phone opens is the moment. With [spread] (a machine was just linked) or when the
  /// swap taught this phone a new machine, every other linked machine hears of it straight away.
  Future<void> _syncGroup(String machineId, {bool spread = false}) async {
    final sync = _groupSync;
    if (sync == null) return;
    final now = DateTime.now();
    final last = _groupSyncedAt[machineId];
    if (!spread && last != null && now.difference(last) < _groupResync) return;
    // Not stamped while the device log is still the last account's (DirectLink.syncGroup skips it
    // then): stamped, a machine reached right after an account switch went five minutes unsynced.
    if (await _deviceLog?.ownsLog() == false) return;
    _groupSyncedAt[machineId] = now;
    // Fire-and-forget from the connection handler: a state file that is locked for a moment must not
    // surface as an unhandled error. The next session retries.
    try {
      final label = phoneClientDescriptor().name;
      final outcome = await sync(machineId, label: label);
      await _afterGroupSync(outcome);
      if (!spread && outcome.pinned.isEmpty) return;
      for (final other in [...machineStates.keys]) {
        if (other == machineId || machineStates[other]?.nodeOnline == false) {
          continue;
        }
        if (await viewer.keys.peer(other) == null) continue;
        _groupSyncedAt[other] = DateTime.now();
        await _afterGroupSync(await sync(other, label: label));
      }
    } catch (_) {
      _groupSyncedAt.remove(machineId);
    }
  }

  /// What a roster swap changed, applied to the machines on screen: a machine the group removed wants
  /// its password again; a machine waiting for one that the group has now vouched for is dialed.
  Future<void> _afterGroupSync(GroupSyncOutcome outcome) async {
    var changed = false;
    for (final id in outcome.unpinned) {
      final machine = machineStates[id];
      if (machine == null || machine.needsLink) continue;
      machine.needsLink = true;
      machine.agentLoadStatus = AgentLoadStatus.needsLink;
      await _pool?.closeMachine(id);
      _markSessionsUnreachable(
        machine,
        'This machine left your group. Enter its password to reconnect.',
      );
      changed = true;
    }
    for (final machine in [...machineStates.values]) {
      if (!machine.needsLink) continue;
      final id = machine.machine.machineId;
      if (await viewer.keys.peer(id) == null) continue;
      machine.needsLink = false;
      machine.agentLoadStatus = AgentLoadStatus.idle;
      await _pool?.closeMachine(id);
      _connectMachine(machine);
      changed = true;
    }
    if (changed) notifyListeners();
  }

  List<LinkedMachine> linkedMachines = [];
  bool linkedMachinesLoading = false;
  String? linkedMachinesError;

  /// Refreshes the "machines this one trusts" list (`harness link list`).
  Future<void> refreshLinkedMachines() async {
    linkedMachinesLoading = true;
    notifyListeners();
    final result = await peerLinks.list();
    linkedMachinesLoading = false;
    linkedMachinesError = result.error;
    linkedMachines = result.machines;
    notifyListeners();
  }

  /// Removes a linked machine's trust pin, then refreshes the list. Returns null on success.
  ///
  /// ⚠️ Dropping the pin does NOT end the connection by itself, and that is the whole reason the
  /// teardown below exists. The pin is local to this device — the machine is never told — and the
  /// socket already open has negotiated its session, so it keeps working exactly as before. No
  /// close arrives, so nothing flips [MachineState.needsLink], and the row stays under "Linked"
  /// looking connected because it IS connected.
  ///
  /// So this does by hand what a `NO_PEER_LINK` close does on its own: shut the socket, mark the
  /// machine as wanting its password, and tell the open terminals they are no longer reachable.
  Future<String?> unlinkMachine(String machineId) async {
    final error = await peerLinks.unlink(machineId);
    if (error != null) return error;
    await refreshLinkedMachines();
    final machine = machineStates[machineId];
    if (machine == null) return null;
    // ⚠️ Marked unlinked BEFORE the socket is closed, not after. Closing reports `disconnected`, and
    // the status handler reads a disconnect from a LINKED machine as the machine going away — it
    // sets `nodeOnline = false`. Closed first, a computer that is still switched on came out of
    // Unlink labelled "Offline" and unopenable, and stayed that way until the next machine refresh.
    // Flagged first, the handler skips that (see the `!machine.needsLink` guard in `_ensurePool`) and
    // presence stays whatever `/api/machines` last said: on → "Needs its password", off → "Offline".
    machine.needsLink = true;
    machine.agentLoadStatus = AgentLoadStatus.needsLink;
    await _pool?.closeMachine(machineId);
    _markSessionsUnreachable(
      machine,
      'This phone is no longer linked. Enter the password again to reconnect.',
    );
    notifyListeners();
    return null;
  }

  Future<void> _pollOfflineMachine(String machineId) async {
    final machine = machineStates[machineId];
    if (machine == null ||
        machine.nodeOnline != false ||
        machine.pendingOfflineAgentId == null ||
        _offlinePollsInFlight.contains(machineId)) {
      return;
    }
    _offlinePollsInFlight.add(machineId);
    try {
      final latest = (await _fetchMachines()).where(
        (item) => item.machineId == machineId,
      );
      if (latest.isEmpty) return;
      final reportedOnline = _nodeOnlineFromStatus(latest.first.status);
      if (reportedOnline == null) return;
      machine.machine = latest.first;
      await _applyNodeStatus(machine, reportedOnline);
    } catch (error) {
      debugPrint('offline node retry failed: $machineId: $error');
    } finally {
      _offlinePollsInFlight.remove(machineId);
    }
  }

  /// Open only the machine data sockets after discovery. Terminal panes remain
  /// lazy and are attached only when the user selects an agent row.
  void _autoConnectAndLoadMachines() {
    final visible = machines.map((machine) => machine.machineId).toSet();
    expandedMachines
      ..removeWhere((machineId) => !visible.contains(machineId))
      ..addAll(visible);
    if (machines.isEmpty) {
      selectedMachineId = null;
      return;
    }
    if (!visible.contains(selectedMachineId)) {
      selectedMachineId = machines.first.machineId;
    }
    final dial = <MachineState>[];
    for (final machine in machines) {
      final state = machineStates[machine.machineId]!;
      // ⚠️ **A machine the account says is down is not dialled, and this is the
      // single biggest thing standing between launch and a usable screen.**
      //
      // `/api/machines` has already reported each machine's status by this
      // point, and a phone commonly has several linked machines with one
      // actually running. Dialling the rest anyway bought nothing and cost the
      // full inventory budget EACH: the socket opens (the relay is up — it is
      // the machine behind it that is not), then `waitUntilReady` sits there
      // until it times out, because the machine that would answer is off. A
      // real launch measured four of those, `10002ms` apiece, while the one
      // live machine had been ready since 3s.
      //
      // The tiles say "Offline", which is both true and immediate, instead of
      // "Connecting…" for ten seconds before saying the same thing.
      //
      // ⚠️ **This is NOT covered by the 5-second offline poll, whatever it
      // looks like.** `_startOfflineRetry` bails for a REMOTE machine unless
      // something is already waiting on one of its agents
      // (`pendingOfflineAgentId`) — and on a phone every machine is remote. So
      // a machine skipped here is not dialled again by anything on a timer: it
      // stays invisible, its agents included, until a pull-to-refresh
      // (`retryMachines`) or the search asks ([reachAllMachines]). That gap is
      // what "it only shows the sessions on one machine" was.
      //
      // A null answer means the account did not say — an older backend, or a
      // status this app does not recognise. That still dials: silence is not
      // evidence of being down, and the previous behaviour is the safe one.
      //
      // Read from `machine.status` rather than `state.nodeOnline`, which the
      // caller sets through an unawaited `_applyNodeStatus`: that happens to
      // assign synchronously today, so both agree, but this loop should not be
      // the thing that breaks if it ever gains an await before the assignment.
      if (_nodeOnlineFromStatus(machine.status) == false) {
        StartupTrace.mark('skipped offline machine ${machine.machineId}');
        continue;
      }
      dial.add(state);
    }
    unawaited(_connectAfterDeviceLog(dial, load: true));
  }

  /// Dial [states]: at once a machine this phone holds a key for, one already asking for its password
  /// and one a scanned code waits for. A machine with no key here may only be missing from this
  /// phone's copy of the device log — a computer signed in after the phone was — so the log is read
  /// first, briefly, rather than dialling a refusal. [load]: ask a machine that already answers for
  /// its data ([_dialAndLoad]).
  Future<void> _connectAfterDeviceLog(
    List<MachineState> states, {
    required bool load,
  }) async {
    final revision = _authRevision;
    bool current(MachineState state) =>
        _authWorkCurrent(revision) &&
        identical(machineStates[state.machine.machineId], state);
    final waiting = <MachineState>[];
    for (final state in states) {
      final machineId = state.machine.machineId;
      if (state.needsLink ||
          pendingPairing?.machineId == machineId ||
          await _holdsMachineKey(machineId)) {
        if (current(state)) _dialAndLoad(state, load: load);
      } else {
        waiting.add(state);
      }
    }
    if (waiting.isEmpty) return;
    await _deviceLog?.refresh().timeout(
      const Duration(seconds: 5),
      onTimeout: () {},
    );
    for (final state in waiting) {
      if (current(state)) _dialAndLoad(state, load: load);
    }
  }

  void _dialAndLoad(MachineState state, {required bool load}) {
    _connectMachine(state);
    if (!load) return;
    // ⚠️ **Only ask a machine that is already answering.** `_connectMachine`
    // starts a dial; it does not finish one. Asking here regardless meant
    // `waitUntilReady` sat on a handshake that had not happened yet, spending
    // the inventory budget on the connection rather than on the request — and
    // on a first launch it spent ALL of it, which then read as the machine
    // having gone offline and triggered a `forceReconnect()` that threw the
    // working socket away and started over.
    //
    // A machine that is not ready yet loses nothing: `_onConnectionStatus`
    // calls this the moment its handshake completes, with `force: true`, which
    // is the path every reconnect in the app already takes.
    //
    // Read off the POOL rather than through `_conn`, which would build a
    // connection as a side effect of being asked about one — for a machine
    // `_connectMachine` had just declined to dial, that would be this method
    // quietly undoing its own decision.
    if (_connectionReady(state.machine.machineId)) {
      unawaited(_loadMachineData(state));
    }
  }

  /// A user-triggered reload is in flight.
  ///
  /// Read by the rail's reload button, which spins its glyph and stops taking
  /// clicks while this is true. It is deliberately NOT [machinesLoading]: that
  /// one means "there is nothing on screen yet", and a refresh over a list
  /// already up leaves it false on purpose.
  bool get machinesRefreshing => _retryInFlight != null;

  /// The run itself, so a second press joins the first instead of starting a
  /// second `GET /api/machines` beside it. The button's disabled state makes
  /// this hard to reach by pointer, but ⌘R has no such guard, and neither has
  /// the error strip's own retry.
  Future<void>? _retryInFlight;

  Future<void> retryMachines() {
    if (_disposed) return Future<void>.value();
    final inFlight = _retryInFlight;
    if (inFlight != null) return inFlight;
    late final Future<void> run;
    run = _performRetryMachines().whenComplete(() {
      if (identical(_retryInFlight, run)) {
        _retryInFlight = null;
        if (!_disposed) notifyListeners();
      }
    });
    _retryInFlight = run;
    notifyListeners();
    return run;
  }

  Future<void> _performRetryMachines() async {
    final revision = _authRevision;
    if (!_authWorkCurrent(revision) || status == AppStatus.unauthenticated) {
      return;
    }
    if (currentUser == null) unawaited(_loadProfile());
    // The desk is joined here as well, should the boot not have got that far —
    // [PhoneDesk.ensure] makes that once.
    _desk.ensure();
    zoo.ensure();
    try {
      await refreshMachines();
      if (!_authWorkCurrent(revision)) return;
      _lastError = null;
    } catch (error) {
      if (!_authWorkCurrent(revision)) return;
      _lastError = 'Could not load machines: ${describeApiError(error)}';
      _lastErrorRetryable = true;
      notifyListeners();
      return;
    }
    await Future.wait(expandedMachines.toList().map(reloadMachineData));
    if (_authWorkCurrent(revision)) notifyListeners();
  }

  void toggleExpand(String machineId) {
    if (expandedMachines.contains(machineId)) {
      expandedMachines.remove(machineId);
    } else {
      expandedMachines.add(machineId);
      selectedMachineId = machineId;
      final machine = machineStates[machineId];
      if (machine != null) {
        _connectMachine(machine);
        unawaited(_loadMachineData(machine));
      }
    }
    notifyListeners();
  }

  /// Selects a machine without toggling its tree. Setup/status rows use this
  /// action so clicking an E2EE prompt always opens that machine's setup pane.
  Future<void> selectMachineForSetup(String machineId) async {
    final machine = machineStates[machineId];
    if (machine == null) return;
    _dismissedLinkPrompts.remove(machineId);
    selectedMachineId = machineId;
    expandedMachines.add(machineId);
    // Nothing is torn down here any more. That line existed because the content
    // area was one terminal belonging to whichever machine was selected, so
    // browsing to a second machine's setup form would otherwise have left the
    // first machine's terminal rendering underneath it. Tiles now say what they
    // are on their own and outlive the rail's selection, which makes selecting
    // a machine navigation again — and closing someone's running terminals
    // because they clicked a row would be the surprise, not the fix.
    //
    // The form itself arrives as a tile, which is the only way it can arrive at
    // all: a machine that needs linking has no agents to open.
    showMachinePane(machineId);
    _connectMachine(machine);
    notifyListeners();
  }

  void _connectMachine(MachineState machine) {
    // connFor() starts a new socket and reports `connecting` through onStatus,
    // or returns the existing socket with its current status intact. Do not
    // overwrite an already-connected socket when the user collapses and
    // re-expands the machine row; doing so leaves the UI permanently yellow
    // and disables every agent even though the transport is still ready.
    if (_pool != null) _conn(machine.machine.machineId);
  }

  WsConn _conn(String machineId) {
    final testConnection = connectionForTest;
    if (testConnection != null) return testConnection(machineId);
    // Every machine is dialled through the relay: there is no local CLI to proxy for it.
    final connection = _pool!.connFor(machineId);
    _wireConnectionHooks(connection, machineId);
    return connection;
  }

  /// Whether [machineId]'s socket has finished its handshake — asked of the
  /// connection the app already HOLDS, never of one built for the asking (see
  /// [_autoConnectAndLoadMachines] for why that matters). A test's
  /// [connectionForTest] stands in for the pool here, as it does in [_conn].
  bool _connectionReady(String machineId) {
    final testConnection = connectionForTest;
    if (testConnection != null) return testConnection(machineId).isReady;
    return _pool?[machineId]?.isReady == true;
  }

  // Every machine hands over the same loopback (HTRL) frames: the relay codec has opened the E2EE
  // envelope before a frame gets here (see `ws/relay_codec.dart`), so there is no per-machine
  // branching left here at all.
  void _wireConnectionHooks(WsConn connection, String machineId) {
    connection.onBinaryFrame = (frame) =>
        _handleTerminalBinary(machineId, frame);
  }

  /// Bulk terminal data for a machine, which may now be feeding several tiles.
  ///
  /// Read the live session identity instead of maintaining a second registry.
  /// Skip unrelated sessions before awaiting: every ignored async call adds a
  /// scheduling turn to the socket's incoming queue. Matching frames enter the
  /// session's ordered renderer queue synchronously, regardless of tab order.
  Future<void> _handleTerminalBinary(String machineId, Uint8List raw) async {
    final targets = panesFor(machineId)
        .map((pane) => pane.session)
        .whereType<TerminalSession>()
        .toList();
    if (targets.isEmpty) return;
    final clear = decodeTerminalLocal(raw);
    if (clear == null) {
      // Undecodable says the transport is wrong, not that one stream is — so
      // it goes to all of them.
      for (final terminal in targets) {
        terminal.transportLost('Binary terminal frame could not be decoded');
      }
      return;
    }
    for (final terminal in targets) {
      if (terminal.streamId == clear.streamId) {
        await terminal.handleBinary(clear);
      }
    }
  }

  Future<bool> _sendTerminalBinary(
    String machineId,
    TerminalBinaryFrame frame,
  ) async {
    final encoded = encodeTerminalLocal(frame);
    if (encoded == null) return false;
    return _conn(machineId).sendTerminalBinary(encoded);
  }

  /// Start dialling last run's machines without waiting for `/api/machines`.
  ///
  /// ⚠️ **The whole point is the socket, not the list.** A relay dial plus the
  /// E2EE handshake is around 1.5 seconds on a phone, and it used to begin only
  /// after the machine list had been fetched — ~700ms during which the app knew
  /// every machine id it needed from the last run and did nothing with them. The
  /// two overlap now, so by the time the real list lands its machines are
  /// already connected or most of the way there.
  ///
  /// **The fetch always wins.** `_refreshMachines` rebuilds `machineStates` from
  /// what the account says, keeping the entries this made (`machineStates.update`
  /// with `ifAbsent`) and dropping any machine that is no longer there — with
  /// its socket, through the `removeWhere` that already handles a machine
  /// disappearing between refreshes. Nothing here is shown to the user as fact:
  /// the tiles it creates carry no agents until a real list arrives.
  ///
  /// Skipped entirely once a fetch has already populated the list — a
  /// re-bootstrap after a sign-in has nothing to warm up, and warming from a
  /// cache that the fetch has already superseded would be a step backwards.
  ///
  /// **The one visible cost.** A machine unlinked from the account since the
  /// last run shows for the length of the fetch — under a second — and then goes
  /// when the real list arrives. Accepted deliberately: the cache holds only
  /// machines the account itself reported as up, unlinking is rare and is done
  /// deliberately by the person who would see this, and the alternative is the
  /// blank screen that every launch used to show instead.
  Future<void> _warmStartMachines() async {
    final cache = _machineCache;
    if (cache == null || _disposed) return;
    final revision = _authRevision;
    final cached = await StartupTrace.time('boot.machineCache', cache.read);
    if (cached.isEmpty || _disposed || !_authWorkCurrent(revision)) return;
    // The fetch got there first — it is the truth, and this has nothing to add.
    if (machines.isNotEmpty || machineStates.isNotEmpty) return;
    var warmed = 0;
    var warmedAgents = 0;
    final warmMachines = <Machine>[];
    final warmStates = <MachineState>[];
    for (final entry in cached) {
      final machine = entry.machine;
      // A viewer reaches every machine through the relay; a cached entry that
      // claims to be this computer has no meaning on a phone and no local
      // endpoint to dial, so it waits for the fetch like it always did.
      if (machine.authMode != MachineAuthMode.remote) continue;
      final state = machineStates.putIfAbsent(
        machine.machineId,
        () => MachineState(machine),
      );
      // ⚠️ **The agents go in as PROVISIONAL, and the flag below is what keeps
      // them honest.** With them the phone draws its terminal — the right
      // agent's name on it, from the record it already had — while the real list
      // is still crossing the network, instead of showing a spinner for two
      // seconds and then the same screen.
      //
      // `agentLoadStatus` stays `loading`, not `loaded`: every screen reads that
      // to mean the machine still owes a list, so the refresh indicators, the
      // empty states and `_machineStillComing` all keep behaving as though
      // nothing had arrived — which is the truth. What these give is a name to
      // draw and an id to open, not a claim that the list is settled.
      if (entry.agents.isNotEmpty) {
        state.agents = entry.agents;
        state.agentsFromCache = true;
        warmedAgents += entry.agents.length;
      }
      // ⚠️ **The capability reply is replayed so a terminal can attach without
      // waiting for the negotiation round-trip.** `_canAttachAgent` requires
      // `terminalCapabilityAvailable`, which is otherwise only true once
      // `terminal_capabilities` has crossed the network — the last gate on the
      // launch, and worth about 700ms of it.
      //
      // Safe in the direction that matters. Only a reply that SAID the terminal
      // works is ever cached, the live negotiation runs regardless and
      // overwrites this within the second, and a machine that has genuinely lost
      // its tmux answers `available: false` — at which point
      // `_applyTerminalCapabilities` clears the flag and every screen reverts to
      // what it would have shown anyway. The narrow cost of being wrong is one
      // `terminal_open` that fails and is retried, against a second saved on
      // every launch that is right.
      final capabilities = entry.capabilities;
      if (capabilities != null) {
        _applyTerminalCapabilities(state, capabilities);
        // ⚠️ NOT `terminalCapabilityLoaded`-as-settled: the live negotiation
        // still has to run, and `_loadTerminalCapabilities` keys off its own
        // in-flight future rather than this flag, so replaying here cannot
        // suppress it.
      }
      // ⚠️ **The dial, and ONLY the dial. No `_loadMachineData` here.**
      //
      // Asking for the agent list at this point was a real bug, and an ugly one
      // to watch: the socket is a few milliseconds old, so `waitUntilReady` was
      // waiting on a handshake that had not begun. Any hiccup on that first dial
      // — and a cold relay socket has them — reached `_onDone`, which rejects
      // every waiter with "WS disconnected". That is NOT a `WsRequestTimeout`,
      // so it fell to the generic branch and painted **Disconnected** over a
      // machine that was merely still connecting. `_autoConnectAndLoadMachines`
      // then asked again a second later, waited out the full ten-second
      // inventory budget, and `forceReconnect()` tore the socket down and
      // redialled from scratch. The screen showed Attaching → Disconnected →
      // Attaching → Live across twelve seconds, for a machine that had answered
      // in one.
      //
      // Nothing is lost by leaving it out. `_onConnectionStatus` calls
      // `_loadMachineData` the moment the handshake actually completes — that is
      // how every other connection in the app gets its list — and the agents
      // from the cache are already on screen meanwhile. The warm start's job is
      // to have the socket ALREADY OPEN when that happens, which is where its
      // second and a half comes from; the request itself was never the part
      // worth racing. A machine with no key here reads the device log first
      // ([_connectAfterDeviceLog]).
      warmStates.add(state);
      warmMachines.add(machine);
      warmed++;
    }
    if (warmed == 0) return;
    unawaited(_connectAfterDeviceLog(warmStates, load: false));
    // ⚠️ Published to `machines` as well, because every screen indexes agents
    // through THAT list (`agentIndex`, `filterableMachines`) rather than through
    // `machineStates` — without this the warm start would have opened the
    // sockets and drawn nothing, which is half the win and all of the risk.
    //
    // Replaced wholesale by `_refreshMachines` the moment the fetch lands: it
    // assigns `machines` from the account's own answer and drops any state not
    // in it, so nothing cached outlives the round-trip it was covering.
    machines = warmMachines;
    StartupTrace.mark(
      'warm-started $warmed machine(s), $warmedAgents agent(s)',
    );
    notifyListeners();
  }

  /// The least time `agents_list` gets, however long the handshake before it
  /// took. Short enough that a dead machine is still reported promptly, long
  /// enough for one round-trip over a relay on a mobile connection.
  static const _agentsListFloor = Duration(seconds: 4);

  static Duration _atLeast(Duration value, Duration floor) =>
      value < floor ? floor : value;

  Future<void> _loadMachineData(
    MachineState machine, {
    bool force = false,
  }) async {
    if (!_machineWorkCurrent(machine, _authRevision)) return;
    if (machine.agentLoadStatus == AgentLoadStatus.loaded && !force) return;
    final inFlight = machine.agentsLoadInFlight;
    if (inFlight != null) return inFlight;
    late final Future<void> load;
    load = _performMachineDataLoad(machine).whenComplete(() {
      if (identical(machine.agentsLoadInFlight, load)) {
        machine.agentsLoadInFlight = null;
      }
    });
    machine.agentsLoadInFlight = load;
    return load;
  }

  Future<void> _performMachineDataLoad(MachineState machine) async {
    final revision = _authRevision;
    // ⚠️ Agents restored from the cache do NOT count as "had agents". This is a
    // first load wearing last run's names: `agentsRefreshing` would render it as
    // a quiet background refresh over a list that had been confirmed, and this
    // list has not been. Kept as `loading`, every screen treats the machine as
    // still owing its list, which it does.
    final hadAgents = machine.agents.isNotEmpty && !machine.agentsFromCache;
    machine.agentsRefreshing = hadAgents;
    if (!hadAgents) machine.agentLoadStatus = AgentLoadStatus.loading;
    machine.agentsLoadError = null;
    notifyListeners();
    final connection = _conn(machine.machine.machineId);
    final deadline = Stopwatch()..start();
    debugPrint('agents_list start: ${machine.machine.machineId}');
    try {
      const inventoryTimeout = Duration(seconds: 10);
      // ⚠️ **The handshake has its OWN budget, and running out of it is not a
      // failure.** These were one ten-second budget shared between waiting for
      // the socket and asking through it, which is the single worst mechanism in
      // this launch path: a caller that asked before the socket was up spent the
      // whole budget waiting, the timeout landed on `agents_list`, the handler
      // below read that as the node having gone offline, and `forceReconnect()`
      // tore down a socket that was seconds from ready — then the redial did it
      // all again. Measured on a cold launch: twelve seconds of
      // `Attaching → Disconnected → Attaching → Live` for a machine that had
      // answered in two.
      //
      // Separated, "the socket is not up yet" resolves as what it is — nothing
      // has been asked, so nothing has failed. The load simply returns, leaving
      // `agentLoadStatus` on `loading`; `_onConnectionStatus` runs it again with
      // `force: true` the moment the handshake completes, which is how every
      // reconnect in the app already gets its list.
      //
      // Callers still avoid asking early where they can (see
      // `_autoConnectAndLoadMachines`, `_applyNodeStatus`) — this is the floor
      // under all of them, not a licence to ignore it.
      try {
        await StartupTrace.time(
          'agents.waitUntilReady',
          () => connection.waitUntilReady(timeout: inventoryTimeout),
        );
      } on WsRequestTimeout {
        if (!_machineWorkCurrent(machine, revision)) return;
        machine.agentsRefreshing = false;
        StartupTrace.mark(
          'agents_list deferred: handshake pending '
          '${machine.machine.machineId}',
        );
        notifyListeners();
        return;
      }
      if (!_machineWorkCurrent(machine, revision)) return;
      // What the connection spent is subtracted so a machine that is up but slow
      // to answer still fails inside a sensible total, with a floor so the
      // request always gets a fair hearing of its own.
      final remaining = _atLeast(
        inventoryTimeout - deadline.elapsed,
        _agentsListFloor,
      );
      final capabilities = _loadTerminalCapabilities(
        machine,
        connection,
        revision,
      );
      final response = await StartupTrace.time(
        'agents.list',
        () => connection.request(
          'agents_list',
          payload: kAgentsListPayload,
          timeout: remaining,
        ),
      );
      if (!_machineWorkCurrent(machine, revision)) return;
      final rawAgents = response['agents'] as List<dynamic>? ?? [];
      final agents = rawAgents
          .map((item) => Agent.fromJson(item as Map<String, dynamic>))
          .toList();
      // Kept for the next launch, as the daemon sent it — see [MachineCache].
      //
      // ⚠️ Written out HERE, not left to the next refresh. The machine list is
      // saved when `/api/machines` lands, which is always before any machine has
      // answered with its agents — so a cache that only went out with that save
      // would be a launch behind forever, and a first run would never cache
      // agents at all. Never awaited: this is for the next launch and must not
      // add a disk write to the one in progress.
      final cache = _machineCache;
      if (cache != null) {
        cache.rememberAgents(machine.machine.machineId, [
          for (final item in rawAgents)
            if (item is Map<String, dynamic>) item,
        ]);
        unawaited(
          cache.save(
            machines,
            isOnline: (item) => _nodeOnlineFromStatus(item.status) == true,
          ),
        );
      }
      _replaceAgents(machine, agents);
      machine.agentLoadStatus = AgentLoadStatus.loaded;
      machine.agentsRefreshing = false;
      machine.agentsLoadError = null;
      debugPrint(
        'agents_list success: ${machine.machine.machineId} '
        '(${machine.agents.length} agents)',
      );
      // Publish discovery immediately. The capability loader attaches waiting
      // panes when its reply arrives; either response may finish first.
      if (machine.terminalCapabilityLoadInFlight == null) {
        // The machine answered its agent list; nobody asked.
        _attachPendingPanes(machine, intent: AttachIntent.automatic);
        _autoPickFirstAgent();
      }
      notifyListeners();
      await capabilities;
      return;
    } catch (error) {
      if (!_machineWorkCurrent(machine, revision)) return;
      machine.agentsRefreshing = false;
      if (error is WsRequestTimeout) {
        machine.agentsLoadError =
            'Harness is offline — run harness start on that machine';
        _recoverStaleSession(machine, connection);
      } else if (connection.isClosed || machine.nodeOnline == false) {
        machine.agentsLoadError = 'Could not load harnesses: $error';
      } else {
        // ⚠️ **The socket dropped mid-request and is already redialling — that
        // is not a failure to report, it is a wait to keep waiting.**
        //
        // `_onDone` rejects every pending waiter with "WS disconnected" and then
        // schedules a reconnect, so this branch is reached routinely on a first,
        // cold dial. Treated as an error it painted **Disconnected** across a
        // machine that was seconds from answering, and `_onConnectionStatus`
        // re-requests the list the moment the retry lands anyway — so the error
        // was not only wrong, it was about to be replaced by the right screen.
        //
        // Left null, every surface keeps showing the connecting state it was
        // already showing, which is what is actually happening.
        machine.agentsLoadError = null;
      }
      // A NO_PEER_LINK close already set needsLink (via onLocalFailure) perhaps a microtask before
      // this catch runs — don't downgrade that specific, actionable state back to a generic error.
      //
      // A drop that is retrying is left alone for the same reason: `error` there
      // would strand the machine on a dead end, when the redial is in flight.
      if (!hadAgents &&
          machine.agentsLoadError != null &&
          machine.agentLoadStatus != AgentLoadStatus.needsLink) {
        machine.agentLoadStatus = AgentLoadStatus.error;
      }
      debugPrint('agents_list failed: ${machine.machine.machineId}: $error');
    }
    if (!_machineWorkCurrent(machine, revision)) return;
    // Order matters: a restored tile for THIS machine claims its agent before
    // the first-run convenience gets to look, so the two can never both open.
    // Same list, the other branch of its reply.
    _attachPendingPanes(machine, intent: AttachIntent.automatic);
    _autoPickFirstAgent();
    notifyListeners();
  }

  /// An RPC timed out on a machine whose transport still calls itself connected:
  /// take the machine down and dial it again.
  ///
  /// A request timing out while the local relay session still nominally reports
  /// "connected" means the node itself has stopped answering — exactly what a
  /// REST-status flip to offline means elsewhere, so it is routed through
  /// [_applyNodeStatus] (not just `nodeOnline = false`) so the pending agent gets
  /// captured for auto-reattach, same as any other offline detection path.
  ///
  /// ⚠️ **And then a fresh dial, for a remote machine.** The relay's cached
  /// upstream session can go stale at the E2EE-session layer without the
  /// underlying transport ever closing — most commonly the relayed machine's own
  /// Harness process restarting, which drops its in-memory session state but
  /// doesn't touch the socket. No close event ever fires, so nothing else would
  /// ever notice; without this every future request keeps timing out against the
  /// same dead session, for as long as the app runs.
  void _recoverStaleSession(MachineState machine, WsConn connection) {
    if (machine.nodeOnline != false) {
      unawaited(_applyNodeStatus(machine, false));
    }
    unawaited(connection.forceReconnect());
  }

  bool _machineWorkCurrent(MachineState machine, int revision) =>
      _authWorkCurrent(revision) &&
      identical(machineStates[machine.machine.machineId], machine);

  /// Whether the app has already opened a terminal on its own.
  ///
  /// Once, at startup, and never again: a later refresh must not reopen a
  /// terminal the user deliberately closed, and a machine that reconnects
  /// mid-session must not yank the pane away from whatever they are watching.
  bool _autoPickedAgent = false;

  /// Open the first agent on this computer, so the app arrives at work instead
  /// of at an instruction.
  ///
  /// "Select a machine, then an agent terminal" is a correct sentence and a
  /// poor first screen: in the ordinary case — one computer, agents already
  /// running on it — there is exactly one thing the user was going to click.
  ///
  /// Runs after a machine's data load rather than after the machine list,
  /// because [selectAgent] refuses on three counts that are only settled by
  /// then: the agent must exist, it must have a tmux terminal, and the
  /// machine's terminal protocol must have been negotiated. Called on every
  /// load and guarded, rather than wired to one specific load, because which
  /// machine answers first is not something this side decides.
  void _autoPickFirstAgent() {
    if (_autoPickedAgent) return;
    // V2 opens on the welcome screen; discovering an agent is not a request
    // to attach its terminal. Keep the startup gate settled for this run.
    _autoPickedAgent = true;
  }

  /// Ask a machine which engines it has.
  ///
  /// Called when the New Agent dialog opens, not at connect: the answer costs
  /// one interactive shell per engine on the far side, and it is only ever
  /// looked at in that dialog.
  ///
  /// That caller passes [force], and should: engines come and go through a
  /// terminal this app never sees, and an install the dialog itself started
  /// invalidates the stored answer as it finishes. Without it the app probes
  /// once per run and then insists, for the rest of the session, on what was
  /// true when it started. The cache is here to collapse a re-open into one
  /// sweep, not to spare the machine the question.
  ///
  /// Deduplicated on [MachineEngines.inFlight] so opening the dialog twice, or
  /// reopening it mid-probe, does not start a second sweep. Never throws — a
  /// machine that cannot answer leaves every engine unknown, and unknown is
  /// rendered as the dialog behaved before this existed.
  Future<void> probeEngines(String machineId, {bool force = false}) {
    final machine = machineStates[machineId];
    if (machine == null) return Future.value();
    final existing = machine.engines.inFlight;
    if (existing != null) return existing;
    if (machine.engines.loaded && !force) return Future.value();
    final work = _probeEngines(machine);
    machine.engines.inFlight = work;
    notifyListeners();
    return work;
  }

  Future<void> _probeEngines(MachineState machine) async {
    try {
      final result = await _conn(machine.machine.machineId).request(
        'engines_probe',
        // The engine list travels so a machine only pays for what the dialog
        // shows. An older CLI that does not know this request answers with an
        // error, which lands in the catch below as "unknown" — never as a wrong
        // "not installed", because a CLI predating the feature would otherwise
        // report every engine missing and offer to install the ones already
        // there.
        payload: {'engines': allEngines.map((e) => e.id).toList()},
        timeout: const Duration(seconds: 30),
      );
      final raw = result['engines'];
      if (raw is! List) throw const FormatException('engines_probe: no list');
      machine.engines.replace(
        raw.map(EngineAvailability.fromJson).whereType<EngineAvailability>(),
      );
    } catch (error) {
      // A CLI that predates `engines_probe` refuses it by code; `detail` already
      // reads as a sentence when the peer sends one, so prefer it verbatim.
      machine.engines.error = error is WsRequestFailure
          ? (error.detail?.isNotEmpty == true ? error.detail : error.code)
          : 'This machine could not report its engines';
    } finally {
      machine.engines.inFlight = null;
      notifyListeners();
    }
  }

  Future<void> _loadTerminalCapabilities(
    MachineState machine,
    WsConn connection,
    int revision,
  ) {
    final pending = machine.terminalCapabilityLoadInFlight;
    if (pending != null) return pending;
    late final Future<void> load;
    load = _readTerminalCapabilities(machine, connection, revision)
        .whenComplete(() {
          if (identical(machine.terminalCapabilityLoadInFlight, load)) {
            machine.terminalCapabilityLoadInFlight = null;
          }
        });
    machine.terminalCapabilityLoadInFlight = load;
    return load;
  }

  /// Read a `terminal_capabilities` reply into [machine].
  ///
  /// Shared by the live negotiation and by the warm start that replays last
  /// run's reply from disk, so a cached machine and a freshly negotiated one are
  /// described by exactly the same code — a second, parallel reader is how the
  /// two would come to disagree about what `available` means.
  void _applyTerminalCapabilities(
    MachineState machine,
    Map<String, dynamic> result,
  ) {
    machine.terminalCapabilityLoaded = true;
    machine.terminalCapabilityUnanswered = false;
    machine.terminalCapabilityAvailable =
        result['protocolVersion'] == TerminalSession.protocolVersion &&
        result['backend'] == 'tmux' &&
        result['available'] == true;
    machine.terminalCapabilityError = machine.terminalCapabilityAvailable
        ? null
        : 'tmux terminal streaming is unavailable';
    final features = result['features'];
    machine.terminalPasteRawAvailable =
        features is Map && features['pasteRaw'] == true;
    machine.terminalImagePasteAvailable =
        features is Map && features['imagePaste'] == true;
    machine.terminalPasteFileAvailable =
        features is Map && features['pasteFile'] == true;
    machine.mediaPreviewAvailable =
        features is Map && features['mediaPreview'] == true;
    machine.projectFolderAvailable =
        features is Map && features['projectFolder'] == true;
    machine.terminalNoTakeoverAvailable =
        features is Map && features['noTakeover'] == true;
  }

  Future<void> _readTerminalCapabilities(
    MachineState machine,
    WsConn connection,
    int revision,
  ) async {
    try {
      final result = await connection.request(
        'terminal_capabilities',
        payload: {'protocolVersion': TerminalSession.protocolVersion},
        timeout: const Duration(seconds: 8),
      );
      if (!_machineWorkCurrent(machine, revision)) return;
      _applyTerminalCapabilities(machine, result);
      // Kept for the next launch, but only a reply that says the terminal works
      // — see [MachineCache.rememberCapabilities]. Written out with the agent
      // list, which lands moments later on this same connection.
      if (machine.terminalCapabilityAvailable) {
        _machineCache?.rememberCapabilities(machine.machine.machineId, result);
      }
    } catch (error) {
      if (!_machineWorkCurrent(machine, revision)) return;
      machine.terminalCapabilityLoaded = true;
      machine.terminalCapabilityUnanswered = error is! WsRequestFailure;
      machine.terminalCapabilityAvailable = false;
      machine.terminalCapabilityError = 'Could not negotiate terminal protocol';
      machine.terminalPasteRawAvailable = false;
      machine.terminalImagePasteAvailable = false;
      machine.terminalPasteFileAvailable = false;
      machine.mediaPreviewAvailable = false;
      machine.projectFolderAvailable = false;
      machine.terminalNoTakeoverAvailable = false;
    }
    if (!_machineWorkCurrent(machine, revision)) return;
    if (machine.agentLoadStatus != AgentLoadStatus.loading &&
        !machine.agentsRefreshing) {
      // Terminal capabilities landed; nobody asked.
      _attachPendingPanes(machine, intent: AttachIntent.automatic);
      _autoPickFirstAgent();
      notifyListeners();
    }
  }

  void _replaceAgents(MachineState machine, List<Agent> agents) {
    final previousWork = {for (final agent in machine.agents) agent.id: agent};
    agents = [
      for (final agent in agents)
        retainNewerGitContext(agent, previousWork[agent.id]),
    ];
    // Whatever was here before, this list came from the machine itself — see
    // [MachineState.agentsFromCache]. Cleared before the loops below, which are
    // exactly the code that retires an agent the cache was wrong about.
    machine.agentsFromCache = false;
    final nextIds = agents.map((agent) => agent.id).toSet();
    final previous = {for (final agent in machine.agents) agent.id: agent};
    for (final old in machine.agents.where(
      (agent) => !nextIds.contains(agent.id),
    )) {
      sessionPreviews.removeAgent(machine.machine.machineId, old.id);
    }
    for (final agent in agents) {
      sessionPreviews.retainAgent(
        machine.machine.machineId,
        agent.id,
        agent.sessionId,
      );
      _staleIfMoved(machine, previous[agent.id], agent);
    }
    for (final agentId in machine.processingAgentIds.difference(nextIds)) {
      _cancelTurnActivity(machine.machine.machineId, agentId);
    }
    machine.agents = agents;
    final pending = machine.pendingOfflineAgentId;
    if (pending != null && !nextIds.contains(pending)) {
      machine.pendingOfflineAgentId = null;
      _stopOfflineRetry(machine.machine.machineId);
    }
    if (machine.activeAgentId != null &&
        !nextIds.contains(machine.activeAgentId) &&
        panesFor(machine.machine.machineId).isEmpty) {
      machine.activeAgentId = null;
    }
    machine.processingAgentIds.removeWhere((id) => !nextIds.contains(id));
    machine.sessionAgentIds.clear();
    for (final agent in agents) {
      final sessionId = agent.sessionId;
      if (sessionId != null) machine.sessionAgentIds[sessionId] = agent.id;
    }
    for (final sessionId in machine.pendingProcessingSessions.toList()) {
      final agentId = machine.sessionAgentIds[sessionId];
      if (agentId == null) continue;
      machine.pendingProcessingSessions.remove(sessionId);
      _markAgentProcessing(machine, agentId);
    }
    _warmPreviews(machine);
  }

  void _upsertAgent(MachineState machine, Agent agent) {
    final index = machine.agents.indexWhere((item) => item.id == agent.id);
    final previous = index == -1 ? null : machine.agents[index];
    agent = retainNewerGitContext(agent, previous);
    if (index == -1) {
      machine.agents = [...machine.agents, agent];
    } else {
      machine.agents = [...machine.agents]..[index] = agent;
    }
    sessionPreviews.retainAgent(
      machine.machine.machineId,
      agent.id,
      agent.sessionId,
    );
    _staleIfMoved(machine, previous, agent);
    sessionPreviews.warm([previewKey(machine.machine.machineId, agent)]);
    machine.sessionAgentIds.removeWhere((_, id) => id == agent.id);
    final sessionId = agent.sessionId;
    if (sessionId != null) {
      machine.sessionAgentIds[sessionId] = agent.id;
      if (machine.pendingProcessingSessions.remove(sessionId)) {
        _markAgentProcessing(machine, agent.id);
      }
    }
    machine.agentLoadStatus = AgentLoadStatus.loaded;
    machine.agentsLoadError = null;
    if (agent.launchState == 'failed' && previous?.launchState != 'failed') {
      _lastError = agent.launchDetail ?? 'Failed to start ${agent.name}';
      // The launch already ran and failed (e.g. the engine's automatic
      // install failed) — reloading the machine list will not install it.
      _lastErrorRetryable = false;
    }
  }

  void _renameAgent(MachineState machine, String agentId, String name) {
    final index = machine.agents.indexWhere((agent) => agent.id == agentId);
    if (index == -1 || name.trim().isEmpty) return;
    final cleanName = name.trim();
    machine.agents = [...machine.agents]
      ..[index] = machine.agents[index].copyWith(name: cleanName);
    for (final pane in panesFor(machine.machine.machineId)) {
      if (pane.agentId != agentId) continue;
      pane.session?.renameAgent(cleanName);
    }
  }

  Future<void> _removeAgent(MachineState machine, String agentId) async {
    machine.agents = machine.agents
        .where((agent) => agent.id != agentId)
        .toList();
    sessionPreviews.removeAgent(machine.machine.machineId, agentId);
    agentNotices.forgetAgent((
      machineId: machine.machine.machineId,
      agentId: agentId,
    ));
    machine.sessionAgentIds.removeWhere((_, id) => id == agentId);
    machine.agentActivityAt.remove(agentId);
    _cancelTurnActivity(machine.machine.machineId, agentId);
    if (machine.activeAgentId == agentId) machine.activeAgentId = null;
    if (machine.pendingOfflineAgentId == agentId) {
      machine.pendingOfflineAgentId = null;
      _stopOfflineRetry(machine.machine.machineId);
    }
    // Every tile showing it, not just the focused one — and without
    // `terminal_close`, which would be addressed to an agent the machine has
    // already destroyed.
    final machineId = machine.machine.machineId;
    for (final pane in allPanes.toList()) {
      if (pane.machineId != machineId || pane.agentId != agentId) continue;
      await _detachSession(pane, sendClose: false);
      for (final swarm in swarms) {
        swarm.remove(pane);
      }
    }
    _persistLayout();
  }

  String? _eventAgentId(
    MachineState machine,
    Map<String, dynamic> event,
    Map<String, dynamic> payload,
  ) {
    final explicit = payload['agentId'] ?? event['agentId'];
    if (explicit is String && explicit.isNotEmpty) return explicit;
    final session = payload['sessionId'] ?? event['dbSessionId'];
    if (session is! String || session.isEmpty) return null;
    return machine.sessionAgentIds[session];
  }

  String? _eventSessionId(
    Map<String, dynamic> event,
    Map<String, dynamic> payload,
  ) {
    final session = payload['sessionId'] ?? event['dbSessionId'];
    return session is String && session.isNotEmpty ? session : null;
  }

  /// One session event into [sessionPreviews], as the desktop feeds its own —
  /// dropped when it belongs to a session the agent has already moved on from,
  /// so a late frame from before a `/clear` cannot write into the new one.
  void _ingestPreview(
    MachineState machine,
    Map<String, dynamic> event,
    String type,
    Map<String, dynamic> payload,
  ) {
    final agentId = _eventAgentId(machine, event, payload);
    final agent = machine.agents
        .where((agent) => agent.id == agentId)
        .firstOrNull;
    if (agent == null) return;
    final sessionId = _eventSessionId(event, payload);
    if (sessionId != null &&
        agent.sessionId != null &&
        sessionId != agent.sessionId) {
      return;
    }
    sessionPreviews.ingest(
      previewKey(machine.machine.machineId, agent),
      type,
      payload,
      streamingText: agent.engine == 'opencode' || agent.engine == 'kilo',
    );
  }

  String _turnActivityKey(String machineId, String agentId) =>
      '$machineId\u0000$agentId';

  bool _markAgentProcessing(MachineState machine, String agentId) {
    final changed = machine.processingAgentIds.add(agentId);
    final key = _turnActivityKey(machine.machine.machineId, agentId);
    _turnActivityWatchdogs.remove(key)?.cancel();
    _turnActivityWatchdogs[key] = Timer(turnActivityTimeout, () {
      _turnActivityWatchdogs.remove(key);
      // Closed even when the machine has been replaced under us: this path is
      // the only end a stalled turn ever gets, and a stats turn left open would
      // sit there until quit and then bank every hour since as work.
      stats.onTurnEnded(key);
      final current = machineStates[machine.machine.machineId];
      if (!identical(current, machine)) return;
      if (machine.processingAgentIds.remove(agentId)) notifyListeners();
    });
    return changed;
  }

  /// Whether this agent is mid-turn, by the app's own reckoning.
  ///
  /// Fed by `turn_started`/`turn_heartbeat`/`turn_ended` and by the same watchdog that clears a
  /// stalled turn, so it answers what the tiles already draw rather than a second opinion.
  ///
  /// Read by the model menu, which disables itself for exactly the agents the CLI would refuse with
  /// AGENT_BUSY. It is deliberately NOT authoritative: only the CLI inspects the pane, and a turn
  /// can begin between a build and a tap. This spares the user the round trip in the common case;
  /// the refusal remains the thing that guarantees no turn is lost.
  bool agentIsProcessing(String machineId, String agentId) =>
      machineStates[machineId]?.processingAgentIds.contains(agentId) ?? false;

  // ── blocked agents ────────────────────────────────────────────────────────

  /// The question this agent stopped on, if it is waiting for one.
  ///
  /// Read by the tile, which rings itself while its agent is blocked. That ring
  /// is the whole surface: an agent asking something is a fact about the pane
  /// you are looking at, not a queue to be worked through somewhere else.
  PendingQuestion? questionFor(String machineId, String agentId) =>
      machineStates[machineId]?.blockedAgents[agentId];

  void _cancelTurnActivity(String machineId, String agentId) {
    final key = _turnActivityKey(machineId, agentId);
    _turnActivityWatchdogs.remove(key)?.cancel();
    // Every ordinary end of a turn comes through here — `turn_ended`, a
    // disconnect, a deleted agent — so this is where the clock stops. An end for
    // a turn this process never saw start contributes nothing (see
    // `HarnessStats.onTurnEnded`), which is what makes the disconnect sweep safe.
    stats.onTurnEnded(key);
    final machine = machineStates[machineId];
    machine?.processingAgentIds.remove(agentId);
    // A question cannot outlive its own turn — the daemon's watcher says the
    // same thing from the other end, tearing down and announcing a close when
    // the turn ends. Clearing here as well means the row cannot survive a close
    // frame that was dropped, and this is also the path a deleted agent takes.
    machine?.blockedAgents.remove(agentId);
  }

  void _clearMachineActivity(MachineState machine) {
    for (final agentId in machine.processingAgentIds.toList()) {
      _cancelTurnActivity(machine.machine.machineId, agentId);
    }
    machine.processingAgentIds.clear();
    machine.pendingProcessingSessions.clear();
    machine.blockedAgents.clear();
  }

  void _clearAllTurnActivity() {
    for (final timer in _turnActivityWatchdogs.values) {
      timer.cancel();
    }
    _turnActivityWatchdogs.clear();
    for (final machine in machineStates.values) {
      machine.processingAgentIds.clear();
      machine.pendingProcessingSessions.clear();
      machine.blockedAgents.clear();
    }
  }

  Future<void> reloadMachineData(String machineId) async {
    final machine = machineStates[machineId];
    if (machine == null) return;
    _connectMachine(machine);
    await _loadMachineData(machine, force: true);
  }

  /// Dial and re-ask EVERY machine on the account, whatever the account last
  /// said about any of them.
  ///
  /// For the screen that offers the whole fleet in one list — the search, which
  /// is the one place somebody asks "where is that agent" without knowing which
  /// machine holds it, and so the one place a missing machine is a wrong answer
  /// rather than a shorter list.
  ///
  /// ⚠️ **This deliberately dials machines [_autoConnectAndLoadMachines]
  /// skipped.** Not dialling a machine the account reported down is right at
  /// launch — finding out costs the full inventory budget EACH, and four dead
  /// machines held the screen ten seconds apiece — and wrong here. That status
  /// is a snapshot from before the app was opened; a machine that has come up
  /// since contributes nothing, because [agentIndex] lists only a machine that
  /// is answering. Reported as "it only shows the sessions on one machine".
  ///
  /// ⚠️ Contrast [_canFetchPreview], which must never dial, and still must not.
  /// That one is per AGENT — dozens of reads, each able to wake a relay socket
  /// for one row's subtitle. This is one `agents_list` per machine, and the
  /// list is what the search has nothing to offer without.
  ///
  /// ⚠️ **No `/api/machines` round trip.** It asks the machines the app already
  /// knows, so a phone on two bars still reaches all of them; an account fetch
  /// that failed would otherwise take the dials down with it, which is exactly
  /// what [retryMachines] does when it returns early. A machine ADDED to the
  /// account since launch is therefore not found here — it arrives through the
  /// Machines tab's pull-to-refresh, the screen whose job is listing them.
  ///
  /// Nothing on screen waits for this: each machine publishes as it answers,
  /// and the rows already drawn keep their places — the search ranks on the
  /// visit history and the name, neither of which a late-answering machine
  /// moves. See [PhoneSearchHistory] and `rankPhoneDestinations`.
  Future<void> reachAllMachines() async {
    // No transport yet — before sign-in, or in a test with no fake connection.
    // The same guard [_canFetchPreview] uses, and for the same reason: `_conn`
    // would build one out of a null pool.
    if (_disposed || (_pool == null && connectionForTest == null)) return;
    await Future.wait([
      for (final machine in machines) reloadMachineData(machine.machineId),
    ]);
  }

  /// What every connected machine's agent accounts have spent, asked in
  /// parallel and read there with that machine's own credentials (`usage_read`).
  ///
  /// A machine may be signed in to a different subscription, and a rate limit
  /// belongs to an account rather than a computer, so the only honest way to
  /// show that one is to ask the machine that holds it.
  ///
  /// ⚠️ **A machine whose CLI predates `usage_read` does not refuse it — it goes
  /// silent.** The frame reaches it as an E2EE envelope it does not know to
  /// open, so the requestId inside is never read and nothing replies. That is a
  /// timeout, not an `UNSUPPORTED`, which is why this asks with a short one and
  /// treats every failure alike: a machine that cannot say has nothing to add,
  /// and it must never hold up the figures of the ones that can.
  Future<List<MachineUsage>> readRemoteUsage({String? machineId}) async {
    final remotes = [
      for (final machine in machineStates.values)
        if (machine.connectionStatus == ConnectionStatus.connected &&
            (machineId == null || machine.machine.machineId == machineId))
          machine,
    ];
    final answers = await Future.wait([
      for (final machine in remotes) _readMachineUsage(machine),
    ]);
    return [for (final answer in answers) ?answer];
  }

  Future<MachineUsage?> _readMachineUsage(MachineState machine) async {
    try {
      final reply = await _conn(machine.machine.machineId)
          .request('usage_read', timeout: const Duration(seconds: 10));
      final readings = parseUsageReadResult(reply);
      if (readings.isEmpty) return null;
      return MachineUsage(
        machineName: machine.machine.displayName,
        readings: readings,
      );
    } catch (_) {
      return null;
    }
  }

  /// Media uses the existing machine-scoped, encrypted file RPC. It is never
  /// queued for a disconnected machine or resolved against this app's cwd.
  Future<Map<String, dynamic>> readRemoteMediaChunk(
    String machineId,
    String agentId,
    String target, {
    required int offset,
    String? revision,
  }) async {
    final machine = machineStates[machineId];
    if (machine == null ||
        machine.needsLink ||
        machine.nodeOnline == false ||
        machine.connectionStatus != ConnectionStatus.connected) {
      throw const RemoteMediaException(
        'This machine is disconnected. Reconnect and try opening the preview again.',
      );
    }
    if (!machine.mediaPreviewAvailable) {
      throw const RemoteMediaException(
        'Update the Harness CLI on this remote machine to open image and video previews.',
      );
    }
    final connection = _conn(machineId);
    if (!connection.isReady) {
      throw const RemoteMediaException(
        'This machine is disconnected. Reconnect and try opening the preview again.',
      );
    }
    try {
      return await connection.request(
        'agent_read_file',
        payload: {
          'agentId': agentId,
          'path': target,
          'media': true,
          'offset': offset,
          'revision': ?revision,
        },
        timeout: const Duration(seconds: 15),
      );
    } on WsRequestFailure catch (error) {
      throw RemoteMediaException(switch (error.code) {
        'MEDIA_NOT_FOUND' || 'NOT_FOUND' => 'This file is no longer available on the remote machine. It may have moved or been deleted.',
        'MEDIA_TOO_LARGE' => 'Remote previews support files up to 512 MB. Use a smaller export or transfer this file separately.',
        'MEDIA_CHANGED' => 'The file changed while downloading. Wait for it to finish generating and try again.',
        'MEDIA_UNSUPPORTED' => 'This file is not a supported image or video.',
        'MEDIA_INVALID_REQUEST' => 'This file is outside the folders Harness reads for this harness. Use one in its working folder or a temp folder.',
        'AGENT_NOT_FOUND' =>
          'This harness is no longer available. Reconnect and try again.',
        'NOT_TEXT' || 'FILE_TOO_LARGE' => 'Update the Harness CLI on this remote machine to open media previews.',
        _ => 'The remote machine could not read this file. Check that it is accessible and try again.',
      });
    } catch (_) {
      throw const RemoteMediaException(
        'The media download was interrupted. Check the connection and try again.',
      );
    }
  }

  /// One-level directory listing on the remote machine, for the New Agent folder browser.
  /// Returns `{path, entries: [{name, isDir}], truncated}` or `{error}` — the caller renders both.
  Future<Map<String, dynamic>> listRemoteFolder(
    String machineId,
    String? path,
  ) async {
    final connection = _conn(machineId);
    try {
      return await connection.request(
        'fs_list_dir',
        payload: {
          ...?path == null ? null : {'path': path},
        },
        timeout: const Duration(seconds: 10),
      );
    } catch (error) {
      return {'error': 'UNREACHABLE'};
    }
  }

  final _teamControllers = <String, TeamController>{};
  final _channelControllers = <String, TeamController>{};
  TeamController channelController(String tabId, String gatewayMachineId) =>
      _channelControllers.putIfAbsent(tabId, () {
        late final TeamController controller;
        controller = TeamController(
          channelTabId: tabId,
          request: (payload) => teamRequest(
            controller.team?['machineId'] as String? ?? gatewayMachineId,
            payload,
          ),
        );
        return controller;
      });
  TeamController teamController(String machineId) =>
      _teamControllers.putIfAbsent(
        machineId,
        () => TeamController(
          request: (payload) => teamRequest(machineId, payload),
        ),
      );

  Future<Map<String, dynamic>> teamRequest(
    String machineId,
    Map<String, dynamic> payload,
  ) async {
    try {
      return await _conn(
        machineId,
      ).request('team', payload: payload, timeout: const Duration(seconds: 35));
    } on WsRequestFailure catch (e) {
      throw TeamRequestError(
        e.code == 'UNSUPPORTED'
            ? 'Update Harness on this machine to use agent collaboration.'
            : e.toString(),
        uncertain: const {
          'UNCONFIRMED',
          'DISCONNECTED',
          'TEAM_UNAVAILABLE',
        }.contains(e.code),
      );
    }
  }

  /// The Git choices [path] offers, read ON the machine that owns it.
  ///
  /// ⚠️ **The phone never looks at a repository itself, and could not.** The
  /// folder is on somebody's laptop; `git` runs there. The desktop has a local
  /// branch of this same call for its own machine — see `readGitProject` there
  /// — and this is the half that is always remote.
  ///
  /// Answers `{isGit, branch, branches: [...], defaultRef, root, ...}`, parsed
  /// by [GitProjectInfo.fromJson], or `{error}` — which the form draws as "no
  /// Git choices here" rather than as a failure, because a folder that is not a
  /// repository answers the same way.
  ///
  /// A short timeout on purpose: this runs while somebody is looking at a form
  /// they have already half filled in, and a machine that cannot answer in six
  /// seconds should leave the rest of the form working.
  /// Machines whose daemon can be asked what was said in their sessions now — connected, never
  /// dialled for it: a search must not be what wakes a relay socket.
  Iterable<String> get searchableMachineIds => [
    for (final machine in machineStates.values)
      if (machine.connectionStatus == ConnectionStatus.connected &&
          !machine.needsLink &&
          machine.nodeOnline != false)
        machine.machine.machineId,
  ];

  /// Every turn of every session on [machineId], searched by its daemon (`session_search`,
  /// cli/src/lib/sessionSearch/) — the desktop's `searchSessions`, unchanged. Null when the machine
  /// cannot answer: offline, or a CLI that predates the request, which goes silent rather than
  /// refusing it — hence the short timeout.
  Future<List<SessionContentHit>?> searchSessions(
    String machineId,
    String query, {
    SearchWhen? when,
    int limit = 30,
  }) async {
    if (!searchableMachineIds.contains(machineId)) return null;
    try {
      final reply = await _conn(machineId).request(
        'session_search',
        payload: {
          'query': query,
          'limit': limit,
          if (when != null) ...{
            'from': when.from.millisecondsSinceEpoch,
            'to': when.to.millisecondsSinceEpoch,
          },
        },
        timeout: const Duration(seconds: 4),
      );
      if (reply['error'] != null) return null;
      return SessionContentHit.listFromReply(machineId, reply);
    } catch (_) {
      return null;
    }
  }

  Future<Map<String, dynamic>> readAgentGitHistory(
    String machineId,
    String agentId, {
    int offset = 0,
  }) async {
    final machine = stateOf(machineId), revision = _authRevision;
    final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
    if (machine == null || agent == null) return {'status': 'unavailable'};
    try {
      final result = await _conn(machineId).request(
        'git_pull_request',
        payload: {'agentId': agentId, 'history': true, 'offset': offset},
        timeout: const Duration(seconds: 45),
      );
      if (!_machineWorkCurrent(machine, revision) ||
          !sameGitConversation(
            agent,
            machine.agents.where((a) => a.id == agentId).firstOrNull,
          )) {
        return {'status': 'unavailable'};
      }
      return result;
    } catch (_) {
      return {'status': 'unavailable'};
    }
  }

  Future<Map<String, dynamic>> readGitProject(
    String machineId,
    String path,
  ) async {
    final machine = machineStates[machineId];
    if (machine == null) return {'error': 'UNAVAILABLE'};
    try {
      return await _conn(machineId).request(
        'git_project_info',
        payload: {'path': path},
        timeout: const Duration(seconds: 6),
      );
    } catch (_) {
      return {'error': 'UNAVAILABLE'};
    }
  }

  /// Every Codex profile folder the CLI on [machineId] can offer, merged with [observedPaths]
  /// (Codex homes already known from this same machine's other Codex agents). Runs entirely on that
  /// machine — this app never touches a filesystem itself, which is what makes it work for a remote
  /// machine too. Returns `{profiles: [{path, label}]}` or `{error}`.
  Future<Map<String, dynamic>> listCodexProfiles(
    String machineId, {
    Set<String> observedPaths = const {},
  }) async {
    final connection = _conn(machineId);
    try {
      return await connection.request(
        'codex_profiles_list',
        payload: {'observedPaths': observedPaths.toList()},
        timeout: const Duration(seconds: 10),
      );
    } catch (error) {
      return {'error': 'UNREACHABLE'};
    }
  }

  /// Links [path] as a Codex profile on [machineId], persisted there so it survives future
  /// requests. Returns `{profile: {path, label}}` or `{error}`.
  Future<Map<String, dynamic>> linkCodexProfile(
    String machineId,
    String path,
  ) async {
    final connection = _conn(machineId);
    try {
      return await connection.request(
        'codex_profile_link',
        payload: {'path': path},
        timeout: const Duration(seconds: 10),
      );
    } catch (error) {
      return {'error': 'UNREACHABLE'};
    }
  }

  /// Starts an agent, or recovers this form's earlier request after a lost reply.
  /// Returns null on success, or an inline message; [attempt] tells the form
  /// whether to offer Check status instead of inviting another creation.
  /// [projectFolder] asks the MACHINE to produce the folder — a fresh project of its own, or a
  /// clone of a repository — instead of being handed one that already exists.
  ///
  /// ⚠️ It replaces [folder] rather than joining it: `cwd` leaves the payload entirely when a
  /// request is present. Both answer "which directory", and a machine given a path AND an
  /// instruction to make one would have to guess which was meant. `cli/src/lib/projectFolder.ts`
  /// reads the pair, and `[folder]` stays required so the ordinary case — a folder the person
  /// picked — cannot be forgotten.
  Future<String?> createAgent(
    String machineId, {
    required String engine,
    required String folder,
    ProjectFolderRequest? projectFolder,
    String? permissionMode,
    String? codexHome,
    GridModel? model,
    String? swarmId,
    AgentCreationAttempt? attempt,
    String? prompt,
    String? name,
  }) {
    final creation = attempt ?? AgentCreationAttempt();
    final task = prompt?.trim();
    final choices = <String, dynamic>{
      'engine': engine,
      // The harness's first task — the machine types it into the agent once it is up. Only
      // claude, codex and opencode take one (see `kFirstTaskEngines`); an empty one is left out.
      if (task != null && task.isNotEmpty) 'prompt': task,
      // What the agent is called until its engine titles the session. Absent, the machine names it
      // after the engine and the time ("Codex harness 9-17 15:26").
      if (name != null && name.trim().isNotEmpty) 'name': name.trim(),
      if (projectFolder == null) 'cwd': folder,
      ...?projectFolder?.payload,
      'permissionMode': ?permissionMode,
      // ⚠️ **Both keys, and the older one is not redundant.** `permissionMode`
      // is the whole menu (`core/permission_modes.dart`); `bypassPermission` is
      // the yes/no a daemon from before that menu understands, and it is all
      // such a machine reads. Sent alone, "Plan first" on an old machine would
      // launch as "approve everything" — so the boolean is derived from the
      // mode rather than asked for separately. See [permissionModeApproves].
      'bypassPermission': permissionMode == null
          ? false
          : permissionModeApproves(permissionMode),
      'codexHome': ?codexHome,
      'gridModel': ?model?.id,
      'gridName': ?model?.grid,
    };
    return _create(machineId, choices, swarmId: swarmId, attempt: creation);
  }

  /// A Claude Code or Codex conversation Harness did not start, opened as a harness that resumes
  /// it, in its own folder (Find's "not in Harness" rows, `ExternalSessionRef`) — the desktop's
  /// `resumeConversation`. The machine refuses one open elsewhere, already a harness, or whose
  /// folder is gone, and says why. Null when it started; otherwise what to tell the person. The
  /// new harness's id is on [attempt] once it has.
  Future<String?> resumeConversation(
    String machineId, {
    required String engine,
    required String folder,
    required String sessionId,
    String? name,
    AgentCreationAttempt? attempt,
  }) => _create(machineId, {
    'engine': engine,
    'cwd': folder,
    'bypassPermission': true,
    'name': ?name,
    'resumeSessionId': sessionId,
  }, attempt: attempt);

  Future<String?> _create(
    String machineId,
    Map<String, dynamic> choices, {
    String? swarmId,
    AgentCreationAttempt? attempt,
  }) {
    final creation = attempt ?? AgentCreationAttempt();
    if (creation._choices != null &&
        (creation._machineId != machineId ||
            !mapEquals(creation._choices, choices))) {
      return Future.value(
        'Check the original request before changing its choices.',
      );
    }
    if (creation._finished) return Future.value(creation._outcome);
    if (creation._inFlight case final inFlight?) return inFlight;
    if (creation._choices == null) {
      creation._choices = choices;
      creation._machineId = machineId;
      creation._targetId = swarmId ?? activeSwarmId;
    }
    final work = _createAgentWithReceipt(creation);
    creation._inFlight = work;
    return work.whenComplete(() => creation._inFlight = null);
  }

  String? _creationPlacementError(String targetId) {
    final target = swarms.where((s) => s.id == targetId).firstOrNull;
    if (target == null) return 'This swarm was closed';
    if (target.panes.length >= maxPanes) {
      return 'This swarm is full. Open a new swarm to create a harness.';
    }
    return null;
  }

  String _creationFailureMessage(String code, String? detail, String machine) =>
      switch (code) {
        'CWD_NOT_FOUND' || 'INVALID_CWD' =>
          'The project folder is unavailable on $machine. '
              'Choose another folder and try again.',
        'TMUX_UNAVAILABLE' =>
          'Harness needs tmux to start harnesses on $machine. '
              'Install tmux there, then try again.',
        'UNSUPPORTED_ON_REMOTE' || 'UNSUPPORTED' =>
          'Update the harness CLI on this machine to create a harness',
        // Opening a conversation Harness did not start (`resumeSessionId`). The machine says what
        // stopped it: open elsewhere, already a harness, gone.
        'SESSION_OPEN_ELSEWHERE' ||
        'SESSION_IN_HARNESS' ||
        'SESSION_NOT_FOUND' ||
        'SESSION_FOLDER_GONE' ||
        'SESSION_BUSY_IN_TERMINAL' ||
        'SESSION_STOP_FAILED' ||
        'INVALID_SESSION' =>
          detail ?? 'Could not open that conversation on $machine.',
        // Not the machine's own sentence: it ends "Moving it here quits it
        // there", written for the desktop's take-over button. A phone sends no
        // `takeOver` and has no such button, so what it can offer is the way
        // that works from here.
        'SESSION_OPEN_IN_TERMINAL' =>
          'It is open in a terminal on $machine. Close it there, then open '
              'it here.',
        _ => 'Create harness failed: ${detail ?? code}',
      };

  Future<String?> _createAgentWithReceipt(AgentCreationAttempt creation) async {
    final machineId = creation._machineId!;
    final targetId = creation._targetId!;
    final choices = creation._choices!;
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    final machineName = machine.machine.displayName;
    // A status check must remain possible even if the destination closed or a
    // capability probe changed while the first create was already in flight.
    if (!creation.awaitingConfirmation) {
      final placementError = _creationPlacementError(targetId);
      if (placementError != null) return placementError;
      if (choices['codexHome'] != null) {
        if (choices['engine'] != 'codex') {
          return 'Choose a Codex profile only for Codex';
        }
        if (machine.engines['codex']?.supportsCodexHome != true) {
          return 'Update the harness CLI on this machine to choose a Codex profile';
        }
      }
    }
    final connection = _conn(machineId);
    // Recheck before launch: a selected model may have stopped since the picker
    // opened. Status checks never repeat this or send a second creation.
    if (!creation.awaitingConfirmation && choices['gridModel'] != null) {
      final models = await gridModels(machineId);
      if (!models.reachable) {
        return creation._complete(
          'Could not verify models on $machineName. Refresh models or use your subscription.',
        );
      }
      if (!models.supportsModelLaunch) {
        return creation._complete(
          'Update Harness CLI on $machineName to choose a model before starting.',
        );
      }
      if (!models.canRunLocally(choices['engine'] as String) ||
          !models.sections.any(
            (section) =>
                section.name == choices['gridName'] &&
                section.models.any((model) => model.id == choices['gridModel']),
          )) {
        return creation._complete(
          'The selected model is unavailable. Refresh models or use your subscription.',
        );
      }
    }
    final operation = creation.awaitingConfirmation
        ? 'agent_create_status'
        : 'agent_create';
    final unconfirmed =
        '$machineName has not confirmed the new harness yet. '
        'Check status before creating another.';
    Map<String, dynamic> result;
    creation._awaitingConfirmation = true;
    try {
      if (operation == 'agent_create_status') {
        result = await connection.request(
          operation,
          payload: {'creationId': creation._id},
          timeout: const Duration(seconds: 10),
        );
        if (result['creationId'] != creation._id) return unconfirmed;
      } else {
        result = await connection.request(
          operation,
          payload: {...choices, 'creationId': creation._id},
          timeout: const Duration(seconds: 20),
        );
      }
    } on WsRequestFailure catch (failure) {
      if (operation == 'agent_create_status') {
        if (failure.code == 'UNSUPPORTED' ||
            failure.code == 'UNSUPPORTED_ON_REMOTE' ||
            failure.code == 'E2EE_REQUIRED') {
          return '$machineName cannot check this creation. '
              'Use Find a harness to look for it before creating another.';
        }
        return unconfirmed;
      }
      // Refusals that happen before a launch are safe to correct. INTERNAL,
      // spawn timeouts and connection failures cannot prove nothing started.
      const refusedBeforeLaunch = {
        'CWD_NOT_FOUND',
        'INVALID_CWD',
        'INVALID_ENGINE',
        'INVALID_GRID',
        'INVALID_CODEX_HOME',
        'TMUX_UNAVAILABLE',
        'TMUX_TOO_OLD_FOR_GRID',
        'GRID_CONFIG_FAILED',
        'UNSUPPORTED_ON_REMOTE',
        'UNSUPPORTED',
        // A conversation Harness did not start, refused before its pane opens.
        'SESSION_OPEN_ELSEWHERE',
        'SESSION_IN_HARNESS',
        'SESSION_NOT_FOUND',
        'SESSION_FOLDER_GONE',
        'INVALID_SESSION',
        // Open in a terminal on that machine (`adoptableSession` in the CLI's
        // cli.ts): refused because this phone did not say how to take it
        // over, so nothing started. Missing here, the most common case of all
        // — a conversation somebody left running in `claude` — read as a lost
        // reply, "has not confirmed the new harness yet".
        'SESSION_OPEN_IN_TERMINAL',
        'SESSION_BUSY_IN_TERMINAL',
        'SESSION_STOP_FAILED',
      };
      if (refusedBeforeLaunch.contains(failure.code)) {
        return creation._complete(
          _creationFailureMessage(failure.code, failure.detail, machineName),
        );
      }
      return unconfirmed;
    } catch (_) {
      // Includes disconnects, malformed replies and timeouts. A transport error
      // is not evidence that the machine did not execute the request.
      return unconfirmed;
    }
    if ((result.containsKey('creationId') || result['state'] != null) &&
        result['creationId'] != creation._id) {
      return unconfirmed;
    }
    switch (result['state']) {
      case 'missing':
        // An old CLI may have created the agent before being updated to a
        // receipt-aware version. Missing is not proof that nothing started.
        // Check status stays read-only, even across upgrades and reconnects.
        return '$machineName has no record of this request. '
            'Use Find a harness to look for it before creating another.';
      case 'pending':
        return '$machineName is still starting your harness. Check again in a moment.';
      case 'unconfirmed':
        return '$machineName could not confirm whether this harness started. '
            'Use Open Harness to look for it before creating another.';
      case 'unavailable':
        return creation._complete(
          'This harness was created but is no longer available. '
          'You can create a new one.',
        );
      case 'failed':
        final failure = result['failure'];
        if (failure is! Map || failure['code'] is! String) return unconfirmed;
        return creation._complete(
          _creationFailureMessage(
            failure['code'] as String,
            failure['detail'] is String ? failure['detail'] as String : null,
            machineName,
          ),
        );
      case 'created':
      case null: // A successful first response from a CLI predating receipts.
        break;
      default:
        return unconfirmed;
    }
    final raw = result['agent'];
    if (raw is! Map || raw['id'] is! String || (raw['id'] as String).isEmpty) {
      return unconfirmed;
    }
    final Agent agent;
    try {
      agent = Agent.fromJson(Map<String, dynamic>.from(raw));
    } catch (_) {
      return unconfirmed;
    }
    creation._agentId = agent.id;
    creation._complete(null);
    if (_disposed || machineStates[machineId] != machine) return null;
    _upsertAgent(machine, agent);
    // ⚠️ Read from the AGENT the machine answered with, not from what was asked for. "New project"
    // and a clone send no `cwd` at all — the folder is whatever the machine made — so taking it
    // from the request would record nothing for exactly the two sources that produce a folder
    // worth remembering.
    final projectPath = agent.project?.cwd ?? choices['cwd'];
    if (projectPath is String && projectPath.isNotEmpty) {
      unawaited(projectHistory.select(machineId, projectPath));
    }
    // Apply each creation receipt once, even if its transport result is replayed.
    stats.onAgentSpawned();
    notifyListeners();
    if (_creationPlacementError(targetId) != null) {
      _lastError =
          'The harness was created, but its original swarm or layout changed. '
          'Use Open Harness to find it.';
      _lastErrorRetryable = false;
      notifyListeners();
      return null;
    }
    // Created HERE, so it joins the tab this phone is in — the way an agent
    // created in a window joins that window's tab. See [PhoneDesk.adopt] for
    // what happens when the phone is in no tab.
    _desk.adopt((
      machineId: machineId,
      agentId: agent.id,
    ), name: agent.displayName);
    await assignAgentToPane(null, machineId, agent.id, swarmId: targetId);
    return null;
  }

  /// Renames a machine via `PATCH /api/machines/:machineId` (control-plane REST — the machine's
  /// `name` is backend-owned, unlike an agent's, which lives on the harness CLI). Returns null on
  /// success, or an error message to show inline in the caller's dialog.
  Future<String?> renameMachine(String machineId, String name) async {
    final state = machineStates[machineId];
    if (state == null) return 'Machine not found';
    final trimmed = name.trim();
    if (trimmed.isEmpty) return 'Name cannot be empty';
    try {
      await api.renameMachine(machineId: machineId, name: trimmed);
    } catch (error) {
      return 'Rename failed: $error';
    }
    state.machine = state.machine.copyWith(name: trimmed);
    final index = machines.indexWhere((m) => m.machineId == machineId);
    if (index != -1) machines[index] = state.machine;
    notifyListeners();
    return null;
  }

  /// Permanently deletes a machine from the account (backend `DELETE /api/machines/:id`) — not to
  /// be confused with [unlinkMachine], which only drops this computer's local E2EE trust pin and
  /// leaves the machine itself intact. Returns null on success, or an error message to show inline.
  Future<String?> deleteMachine(String machineId) async {
    final state = machineStates[machineId];
    if (state == null) return 'Machine not found';
    try {
      await api.deleteMachine(machineId: machineId);
    } catch (error) {
      return 'Delete failed: $error';
    }
    // Any tile still showing this machine would otherwise sit forever in the "waiting to answer"
    // busy state, since the machine can never be found again after this.
    for (final pane in panesFor(machineId).toList()) {
      for (final swarm in swarms) {
        swarm.remove(pane);
      }
      await _detachSession(pane, sendClose: true);
    }
    _persistLayout();
    _stopAgentSyncTimer(machineId);
    machineStates.remove(machineId);
    machines.removeWhere((m) => m.machineId == machineId);
    if (selectedMachineId == machineId) selectedMachineId = null;
    notifyListeners();
    return null;
  }

  /// Renames an agent via `agent_update`. Returns null on success, or an error message to show
  /// inline in the caller's dialog.
  Future<String?> renameAgent(
    String machineId,
    String agentId,
    String name,
  ) async {
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    final trimmed = name.trim();
    if (trimmed.isEmpty) return 'Name cannot be empty';
    Map<String, dynamic> result;
    try {
      result = await _conn(
        machineId,
      ).request('agent_update', payload: {'agentId': agentId, 'name': trimmed});
    } catch (error) {
      return 'Rename failed: $error';
    }
    final error = result['error'];
    if (error is String) return 'Rename failed: $error';
    _renameAgent(machine, agentId, trimmed);
    notifyListeners();
    return null;
  }

  /// Tells the machine that owns an agent it was just opened here, so it can stamp
  /// `lastOpenedAt` and every app — this phone, each desktop — sorts by the same
  /// last use. Fire and forget: a daemon too old to keep the stamp answers
  /// `MISSING_UPDATE`, and nothing here depends on the answer.
  ///
  /// Coalesced per agent: opening the same one again within [_touchEvery] says
  /// nothing new.
  void touchAgent(String machineId, String agentId) {
    final machine = machineStates[machineId];
    if (machine == null || machine.needsLink) return;
    final key = '$machineId/$agentId';
    final now = DateTime.now();
    final last = _touchedAt[key];
    if (last != null && now.difference(last) < _touchEvery) return;
    _touchedAt[key] = now;
    unawaited(() async {
      try {
        await _conn(machineId).request(
          'agent_update',
          payload: {'agentId': agentId, 'opened': true},
        );
      } catch (_) {
        // Recency is a nicety: a machine that cannot hear it keeps its order.
      }
    }());
  }

  static const _touchEvery = Duration(seconds: 3);
  final _touchedAt = <String, DateTime>{};

  /// Deletes an agent via `agent_delete`. Returns null on success, or an error message to show
  /// inline in the caller's dialog.
  Future<String?> deleteAgent(String machineId, String agentId) async {
    final machine = machineStates[machineId];
    if (machine == null) return 'Machine not found';
    Map<String, dynamic> result;
    try {
      result = await _conn(machineId)
          .request('agent_delete', payload: {'agentId': agentId});
    } catch (error) {
      return 'Delete failed: $error';
    }
    final error = result['error'];
    if (error is String) return 'Delete failed: $error';
    await _removeAgent(machine, agentId);
    // Gone from the machine, so gone from the desk: a tab left holding it would
    // keep a pane no computer can ever attach. See [PhoneDesk.drop].
    _desk.drop((machineId: machineId, agentId: agentId));
    notifyListeners();
    return null;
  }

  /// Restarts an agent via `agent_restart` — exits its current engine process and relaunches it
  /// daemon-side, resuming its session where possible.
  ///
  /// The reply carries the same fresh `Agent` shape `agent_synced` pushes once the new process is
  /// confirmed, so this upserts from the reply directly — idempotent on `agent.id`, same as
  /// [createAgent], and safe even if the CLI's own `agent_synced` push for the restart arrives
  /// separately (fire-and-forget on the CLI side, unordered relative to this reply).
  /// Bring a stopped agent back, so something can be opened on it.
  ///
  /// The desktop's `resumeAgent`: a thin guard over [restartAgent], which is the
  /// same `agent_restart` RPC. Split out because the two have different
  /// preconditions — restart is "this agent is misbehaving, relaunch it", resume
  /// is "this agent is not running, it should be".
  ///
  /// An agent that already has a terminal succeeds without touching the machine:
  /// the caller's job is "make it openable", and it is.
  ///
  /// ⚠️ **`agent_resume`, never `agent_restart`.** The daemon routes the two to different services
  /// (`backendSocket.ts`): restart swaps the process inside a LIVE pane and refuses an agent with
  /// none (`NO_ACTIVE_PROCESS`, `RESTART_UNSUPPORTED_BACKEND`) — which is every stopped agent — while
  /// resume builds a pane and reopens the saved conversation by its session id. This used to send
  /// restart, so tapping a Stopped row could only ever fail.
  Future<RestartAgentResult> resumeAgent(String machineId, String agentId) {
    final machine = stateOf(machineId);
    final agent = machine?.agents
        .where((agent) => agent.id == agentId)
        .firstOrNull;
    if (agent?.terminalAvailable == true) {
      return Future.value(const RestartAgentResult());
    }
    if (machine == null || agent == null || !agent.isStopped) {
      return Future.value(
        const RestartAgentResult(
          error: 'That harness is no longer available. Search again.',
        ),
      );
    }
    // Refused here rather than round-tripped: the machine can only say RESUME_UNAVAILABLE.
    if (!agent.canPauseAndResume) {
      return Future.value(
        const RestartAgentResult(
          error: 'This harness has no supported saved conversation to resume.',
        ),
      );
    }
    return _resumeWithReceipt(machine, agent);
  }

  /// Resumes whose outcome the machine has not confirmed yet, by agent → the receipt id they were
  /// sent with.
  ///
  /// ⚠️ **A lost reply is not a failed resume.** The daemon may be starting the conversation right
  /// now, and a second `agent_resume` would start it twice. So the next tap on the same agent asks
  /// `agent_create_status` about the SAME id instead, exactly as the desktop's restart attempt does;
  /// only a confirmed outcome — started, refused, gone — clears the entry.
  final Map<(String, String), String> _agentResumes = {};

  Future<RestartAgentResult> _resumeWithReceipt(
    MachineState machine,
    Agent stopped,
  ) async {
    final key = (machine.machine.machineId, stopped.id);
    final checking = _agentResumes[key];
    final receipt = checking ?? _newReceiptId();
    _agentResumes[key] = receipt;
    RestartAgentResult settle(String error) {
      _agentResumes.remove(key);
      return RestartAgentResult(error: error);
    }

    const unconfirmed = RestartAgentResult(
      error: 'The machine has not confirmed the resume yet. Tap the harness again to check.',
    );
    Future<Map<String, dynamic>> resume() => _conn(machine.machine.machineId)
        .request(
          'agent_resume',
          payload: {'creationId': receipt, 'agentId': stopped.id},
        );
    // Whether the request whose answer is being read is `agent_resume` itself —
    // its refusals are final — rather than a status check.
    var resuming = checking == null;
    Map<String, dynamic> result;
    try {
      result = resuming
          ? await resume()
          : await _conn(
              machine.machine.machineId,
            ).request('agent_create_status', payload: {'creationId': receipt});
      // ⚠️ **`missing` is the machine never having heard of it — the desktop's
      // rule.** The first send can fail before it leaves the phone (a socket
      // mid-redial is the usual way), and then every check after it answers
      // `missing`, for ever: the agent could not be resumed from this phone
      // again until the app restarted. So the SAME intent is sent again. The
      // daemon reserves a receipt before it launches anything, so a delayed
      // original and this replay cannot both open a terminal.
      if (!resuming &&
          result['creationId'] == receipt &&
          result['state'] == 'missing') {
        resuming = true;
        result = await resume();
      }
    } on WsRequestFailure catch (failure) {
      // A refusal to a resume happened before anything launched; anything else — a timeout,
      // INTERNAL, a status check the machine cannot answer — leaves the outcome unknown.
      if (!resuming || failure.code == 'INTERNAL') return unconfirmed;
      return settle(_resumeFailure(failure.code, failure.detail));
    } catch (_) {
      return unconfirmed;
    }
    if (result['creationId'] != receipt) return unconfirmed;
    switch (result['state']) {
      case 'created':
        break;
      case 'pending':
        return const RestartAgentResult(
          error: 'The machine is still resuming this harness. Tap it again in a moment.',
        );
      case 'unavailable':
        return settle('That harness is no longer available. Search again.');
      case 'failed':
        final failure = result['failure'];
        if (failure is! Map || failure['code'] is! String) return unconfirmed;
        return settle(
          _resumeFailure(failure['code'] as String, failure['detail']),
        );
      default:
        return unconfirmed;
    }
    final raw = result['agent'];
    if (raw is! Map || raw['id'] != stopped.id) return unconfirmed;
    final Agent resumed;
    try {
      resumed = Agent.fromJson(Map<String, dynamic>.from(raw));
    } catch (_) {
      return unconfirmed;
    }
    // The desktop's bar for "resumed": the conversation promised ([Agent.resumedAsPromised]),
    // started — not one still starting or already failed.
    final promised = stopped.resumedAsPromised(
      resumed,
      reportedResumed: result['resumed'] != false,
    );
    if (!promised || resumed.launchState != 'ready') {
      return unconfirmed;
    }
    _agentResumes.remove(key);
    // A paused harness came back from this phone: a first-egg habit.
    daemonHabits.resumed();
    if (_disposed || machineStates[machine.machine.machineId] != machine) {
      return const RestartAgentResult();
    }
    _upsertAgent(machine, resumed);
    notifyListeners();
    return const RestartAgentResult();
  }

  /// The desktop's `_restartFailure` wording for a resume the machine refused.
  String _resumeFailure(String code, Object? detail) =>
      detail is String && detail.isNotEmpty
      ? detail
      : switch (code) {
          'UNSUPPORTED_ON_REMOTE' || 'UNSUPPORTED' =>
            'Update the harness CLI on this machine to open saved harnesses.',
          'AGENT_BUSY' => 'Another operation is changing this harness. Wait for it to finish, then retry.',
          _ => 'Could not open this harness: $code',
        };

  Future<RestartAgentResult> restartAgent(
    String machineId,
    String agentId,
  ) async {
    final machine = machineStates[machineId];
    if (machine == null) {
      return const RestartAgentResult(error: 'Machine not found');
    }
    Map<String, dynamic> result;
    try {
      result = await _conn(machineId)
          .request('agent_restart', payload: {'agentId': agentId});
    } catch (error) {
      return RestartAgentResult(error: 'Restart failed: $error');
    }
    final error = result['error'];
    if (error is String) {
      final detail = result['detail'];
      return RestartAgentResult(
        error: detail is String ? detail : 'Restart failed: $error',
      );
    }
    final raw = result['agent'];
    if (raw is Map) {
      try {
        _upsertAgent(machine, Agent.fromJson(Map<String, dynamic>.from(raw)));
        notifyListeners();
      } catch (_) {
        // Malformed reply agent — harmless, the CLI's own agent_synced push still lands.
      }
    }
    // Absent (older daemon build) reads as true — assume resumed rather than warn about a fresh
    // session that may not have happened, since this field is purely additive UI polish.
    final resumed = result['resumed'];
    return RestartAgentResult(resumed: resumed is bool ? resumed : true);
  }

  /// Live models on every harness grid this machine is signed into, for the
  /// model sheet.
  ///
  /// Asked of the machine the agent runs on rather than kept in app state: the
  /// answer is whatever that machine's `grid` reports at this moment (an engine
  /// can join or leave between two opens), and a cached list would offer a
  /// model nobody is serving any more.
  ///
  /// Never throws — a machine whose daemon is too old to know the RPC, one with
  /// no grid, and one that timed out are all "nothing to offer", which is what
  /// the sheet shows.
  Future<GridModels> gridModels(String machineId) async {
    try {
      final response = await _conn(machineId)
          .request('grid_models_list', timeout: const Duration(seconds: 12));
      List<GridModel> parseModels(Object? raw, {String? grid}) =>
          (raw as List<dynamic>? ?? [])
              .whereType<Map<String, dynamic>>()
              .map(
                (m) => GridModel(
                  id: (m['id'] as String?) ?? '',
                  node: (m['node'] as String?) ?? '',
                  grid: grid,
                ),
              )
              .where((m) => m.id.isNotEmpty)
              .toList();
      final capable = response['localModelEngines'];
      return GridModels(
        supportsModelLaunch: response['supportsModelLaunch'] == true,
        gridName: response['gridName'] as String?,
        // The own grid's list, which an older daemon sends on its own.
        models: parseModels(response['models']),
        grids: (response['grids'] as List<dynamic>? ?? [])
            .whereType<Map<String, dynamic>>()
            .where((g) => (g['name'] as String?)?.isNotEmpty == true)
            .map(
              (g) => GridSection(
                name: g['name'] as String,
                own: g['own'] == true,
                models: parseModels(g['models'], grid: g['name'] as String),
              ),
            )
            .toList(),
        localModelEngines: capable is List
            ? capable.whereType<String>().map((e) => e.toLowerCase()).toSet()
            : null,
        gridCli: GridCli.parse(response['gridCli']),
      );
    } catch (_) {
      // NOT `gridName: null` with an empty list — that is the shape of "this
      // account has no grid", and a caller cannot tell it from "the machine did
      // not answer". A signed-in user whose daemon was offline would be told to
      // sign in again, which is both wrong and unactionable.
      return const GridModels.unreachable();
    }
  }

  /// Point one agent at a model on a harness grid. Returns null on success, or
  /// the one sentence to show — the phone has no error rail, so the caller
  /// snackbars it (see [retargetRefusalMessage]).
  ///
  /// Sends the model id and nothing else: the daemon on that machine resolves
  /// the endpoint and the credential from its own signed-in `grid`, so neither
  /// travels over the relay and the phone never holds a grid key. Moving an
  /// agent re-execs its pane, which is why this is an explicit choice in a
  /// sheet rather than something a swipe can do.
  ///
  /// [gridName] is the grid the model was picked from — a shared grid's section
  /// in the sheet. Absent, the daemon uses the account's own grid.
  Future<String?> retargetAgentToGridModel(
    String machineId,
    String agentId,
    String modelId, {
    String? gridName,
  }) => _retarget(machineId, agentId, {
    'agentId': agentId,
    'gridModel': modelId,
    'gridName': ?gridName,
  });

  /// Put the agent back on its engine's own vendor login.
  Future<String?> clearAgentGrid(String machineId, String agentId) =>
      _retarget(machineId, agentId, {'agentId': agentId, 'clearGrid': true});

  /// The one `agent_retarget` call both doors take.
  ///
  /// A refusal happens BEFORE the daemon touches the pane — an engine with no
  /// way onto a Local model, a busy agent, a machine that cannot resolve its
  /// models — so nothing in the terminal ever says why, and without this the
  /// tap simply does nothing. One sentence, in the app's own words; the
  /// daemon's own `detail` is written for its log and names the grid.
  ///
  /// A transport failure is NOT a refusal: the daemon may well have done the
  /// move, and the agent frame that follows is the truth. Nothing is said
  /// rather than a story the terminal is about to contradict.
  Future<String?> _retarget(
    String machineId,
    String agentId,
    Map<String, dynamic> payload,
  ) async {
    try {
      await _conn(machineId).request(
        'agent_retarget',
        payload: payload,
        timeout: const Duration(seconds: 30),
      );
      return null;
    } on WsRequestFailure catch (failure) {
      return _retargetRefusal(machineId, agentId, failure.code);
    } catch (_) {
      return null;
    }
  }

  String _retargetRefusal(String machineId, String agentId, String code) {
    final agent = machineStates[machineId]?.agents
        .where((a) => a.id == agentId)
        .firstOrNull;
    return retargetRefusalMessage(
      code,
      engineLabel: engineIdentity(agent?.engine).label,
    );
  }

  /// Every tile on the machine, not just the focused one: the machine is what
  /// went away, so a tile of the same machine sitting in another corner of the
  /// grid is just as dead and must say so rather than keep showing a terminal
  /// that can no longer receive anything. Records what was open so the next
  /// `connected` can put it back (`_recoverPendingAgent`).
  void _markSessionsUnreachable(MachineState machine, String message) {
    // The tile being looked at first. `pendingOfflineAgentId` is ONE slot, filled by the first tile
    // that qualifies, and `_recoverPendingAgent` SELECTS what is in it — focus, `activeAgentId`
    // and the right to take the terminal back all go with that. A phone holds several tiles per
    // machine now (the pager's neighbours, see [warmAgentPane]), and list order says nothing
    // about which of them a person is reading.
    final focused = focusedPane;
    final tiles = panesFor(machine.machine.machineId).toList();
    if (focused != null && tiles.remove(focused)) tiles.insert(0, focused);
    for (final pane in tiles) {
      final session = pane.session;
      if (session == null) continue;
      machine.activeAgentId ??= session.agentId;
      // A pane someone else already took over must stay frozen until the user retries it
      // themselves (see `_paneNeedsAttach`) — recording it here would have `_recoverPendingAgent`
      // call `selectAgent` on reconnect and silently win it back the moment the connection
      // returns, fighting whichever machine holds it now.
      //
      // Nor a warm tile, for the same reason one step removed: nobody ever looked at it, and
      // selecting it is what would let it take a terminal another app picked up meanwhile. It
      // comes back with the rest, through `_attachPendingPanes`, as politely as it first opened.
      if (session.status != TerminalSessionStatus.takenOver && !pane.warm) {
        machine.pendingOfflineAgentId ??= session.agentId;
      }
      // Do not send terminal_close: the adapter is already gone and the
      // next client attachment should be the only stream that owns the pane.
      session.transportLost(message);
    }
  }

  Future<void> _applyNodeStatus(MachineState machine, bool online) async {
    if (_disposed) return;
    final machineId = machine.machine.machineId;
    final wasOnline = machine.nodeOnline;
    machine.nodeOnline = online;

    if (!online) {
      _markSessionsUnreachable(
        machine,
        'Harness is offline. Run harness start on that machine to reconnect.',
      );
      _startOfflineRetry(machine);
    } else {
      _stopOfflineRetry(machineId);
      if (wasOnline == false) {
        for (final pane in panesFor(machineId)) {
          pane.session?.transportLost(
            'Harness reconnected; restoring terminal…',
          );
        }
      }
      final pending = machine.pendingOfflineAgentId;
      if (pending != null) {
        unawaited(_recoverPendingAgent(machine, pending));
      } else if (_connectionReady(machineId) &&
          (wasOnline == false || panesFor(machineId).any(_paneNeedsAttach))) {
        // ⚠️ **A machine that was OFF and is back owes a fresh list, whether or
        // not anything here was waiting on it.** This arrives as a `node_status`
        // push over a socket that never closed, so `_onConnectionStatus` — which
        // is what reloads after every real reconnect — does not run, and the
        // list this app holds is from before that machine's Harness restarted.
        // Nothing corrects it: the pushes that would have go to a session the
        // restart dropped. A phone therefore kept showing a machine's agents
        // from minutes earlier, every agent made since invisible, and a desk tab
        // holding those agents (`deskGroups`) read as an empty tab.
        //
        // A tile restored from the saved layout is the other half, and has no
        // pendingOfflineAgentId — nothing of its was interrupted, it simply
        // arrived before its machine did. Without this it would sit on
        // "Attaching…" forever on a machine that has since come back, because
        // every other route to _attachSession runs off a load that nothing here
        // would trigger.
        //
        // ⚠️ **Only once the socket is actually up.** `/api/machines` reports a
        // machine as running well before this app has finished dialling it, and
        // this branch fires off that REST answer — so on a cold launch it asked
        // for the agent list against a socket that was still handshaking. The
        // request then spent the whole ten-second inventory budget WAITING for
        // that handshake, timed out, and the timeout handler read it as the node
        // having gone offline and called `forceReconnect()`, which threw away
        // the socket that was seconds from being ready and dialled again. That
        // is the twelve-second `Attaching → Disconnected → Attaching → Live` a
        // launch showed.
        //
        // Nothing is lost by waiting: `_onConnectionStatus` runs this same load
        // with `force: true` the moment the handshake completes, and it is what
        // attaches the restored tile in every other case already.
        unawaited(_loadMachineData(machine, force: true));
      }
    }
    notifyListeners();
  }

  Future<void> _recoverPendingAgent(
    MachineState machine,
    String agentId,
  ) async {
    final machineId = machine.machine.machineId;
    if (!_offlineRecoveryInFlight.add(machineId)) return;
    try {
      // E2EE and agents_list can become ready in separate frames after a
      // node restart. Poll briefly instead of racing a single request.
      for (var attempt = 0; attempt < 40; attempt++) {
        if (_disposed ||
            machine.nodeOnline != true ||
            machine.pendingOfflineAgentId != agentId) {
          return;
        }
        // ⚠️ Poll past a socket that is not up yet rather than asking through
        // it. `_loadMachineData` would spend its whole ten-second inventory
        // budget waiting for the handshake and then report the machine offline —
        // on the very path that exists to recover a machine coming back. The
        // delay at the foot of this loop is the poll; this just skips the turn.
        if (!_connectionReady(machineId)) {
          await Future<void>.delayed(const Duration(milliseconds: 250));
          continue;
        }
        await _loadMachineData(machine, force: true);
        final agent = machine.agents.cast<Agent?>().firstWhere(
          (candidate) => candidate?.id == agentId,
          orElse: () => null,
        );
        if (agent != null &&
            agent.terminalAvailable &&
            machine.terminalCapabilityAvailable) {
          machine.pendingOfflineAgentId = null;
          // Only reattach the terminal if the user is still on THIS machine — recovery can finish
          // well after the user has moved on to a different machine/agent, and forcing selectAgent
          // here would yank their focus back to what they were looking at before, mid-navigation.
          // The recovered agent still shows normally in the rail; they can click it themselves.
          if (selectedMachineId == machineId) {
            // A machine coming back is not somebody picking the phone up: the
            // agent shows again, its terminal stays with whoever holds it.
            await selectAgent(
              machineId,
              agentId,
              intent: AttachIntent.automatic,
            );
          } else {
            notifyListeners();
          }
          return;
        }
        await Future<void>.delayed(const Duration(milliseconds: 250));
      }
    } finally {
      _offlineRecoveryInFlight.remove(machineId);
    }
  }

  /// Enable-time fallback: preserve the user's current choice and acknowledge it.
  /// Selection records focus before waiting for terminal attachment, so a later
  /// user click is never overwritten by completion of an asynchronous open.
  Future<void> ensureDeviceFocus(Map<String, dynamic> payload) async {
    final expiresAt = payload['expiresAt'];
    final machineId = payload['machineId'];
    final agentId = payload['agentId'];
    final focusRevision = payload['focusRevision'];
    if (expiresAt is! num ||
        expiresAt <= DateTime.now().millisecondsSinceEpoch ||
        machineId is! String ||
        agentId is! String ||
        agentId.isEmpty ||
        focusRevision is! String ||
        focusRevision.isEmpty) {
      return;
    }
    if (focusedPane?.agentId != null) return;
    // The WiFi device asked, not a hand on this phone — see [AttachIntent].
    await _showAgentFromDevice(machineId, agentId);
  }

  /// The dial turned to an agent. Ordinary selection, the same path a click on the rail takes.
  ///
  /// It used to take a `DeskEdge` and, for an agent with no tile, replace the pane at that end — the
  /// dial's carousel could walk past the end of the desk onto an unopened agent, and the edge said
  /// which tile it had walked off. The carousel walks only open panes now, so there is no off-desk
  /// landing left to place and nothing to replace.
  Future<void> selectAgentFromDial(String machineId, String agentId) async {
    // ⚠️ Not `selectAgent`: arriving is a claim, and the dial turning is
    // not a person arriving at THIS phone. The agent comes on screen; its
    // terminal stays with whoever types in it, and the band offers it back.
    await _showAgentFromDevice(machineId, agentId);
  }

  /// Put an agent on screen because a device asked — the dial, the WiFi
  /// device — without taking its terminal. See [AttachIntent].
  Future<void> _showAgentFromDevice(String machineId, String agentId) async {
    final existing = paneOfAgent(machineId, agentId);
    if (existing == null) {
      await selectAgent(machineId, agentId, intent: AttachIntent.automatic);
      return;
    }

    selectedMachineId = machineId;
    machineStates[machineId]?.activeAgentId = agentId;
    focusPane(existing.id);
    if (existing.session == null) {
      await _attachSession(existing, takeControl: false);
    }
  }

  /// Open [agentId] on this phone, taking its terminal.
  ///
  /// ⚠️ **Arriving IS the claim.** The daemon keeps ONE controller per agent, so every
  /// `terminal_open` this sends takes the terminal from whoever held it — the desktop included.
  /// That is the point: a phone is picked up to type at an agent, and asking politely first put a
  /// read-only stream and a "Take control" band in front of every agent a desktop had open,
  /// including the one the app opens on.
  ///
  /// The displaced app is told who took it and has the same one press back; on the phone that
  /// press is a tap or a scroll on the terminal taken back off it.
  ///
  /// The one open that stays polite is [warmAgentPane]'s guess about the next swipe, which is
  /// nobody arriving anywhere. See [_attachSession].
  Future<void> selectAgent(
    String machineId,
    String agentId, {

    /// [AttachIntent.automatic] shows the agent without claiming its
    /// terminal — the road `_showAgentFromDevice` and recovery take.
    AttachIntent intent = AttachIntent.person,
  }) async {
    final person = intent == AttachIntent.person;
    final existing = paneOfAgent(machineId, agentId);
    if (existing != null) {
      selectedMachineId = machineId;
      machineStates[machineId]?.activeAgentId = agentId;
      focusPane(existing.id);
      // A tile the pager opened ahead of time is being looked at now, so it
      // joins the saved layout like any tile a person chose. Left warm, a
      // relaunch would restore the tile before it AND reopen this agent from
      // `lastOpenedAgent` — two streams for one screen. See [TerminalPane.warm].
      if (existing.warm) {
        existing.warm = false;
        _persistLayout();
      }
      final terminal = existing.session;
      if (terminal != null) {
        // Arming the NEXT open, and only that one: the flag is lowered again the moment an open it
        // armed is answered (see the `terminal_ready` branch of `TerminalSession`), so a claim
        // cannot outlive the arrival that made it and come back as a reconnect hours later. Coming
        // back to the agent raises it again, because that is another arrival.
        terminal.takeover = person;
      }
      if (terminal == null) {
        // The pane wanted this agent before `_attachSession` could actually attach it (the agent's
        // terminal wasn't verified yet, the machine was briefly offline, ...). Nothing else retries a
        // null session on its own — see `_attachPendingPanes` — so a click here has to.
        await _attachSession(existing, takeControl: person);
      } else if (terminal.watching && person) {
        // ⚠️ **The one reopen that replaces a perfectly live stream.** A watcher renders the
        // terminal without holding it (see [TerminalSession.watching]), so by every other measure
        // here it is healthy — `controlling`, with a stream id — and the branches below would
        // leave it alone. What this page wants is the KEYBOARD, and the only way to ask for it is
        // a fresh open that takes the lease. Its retained output stays on screen meanwhile.
        if (!_canAttachPane(existing)) return;
        await terminal.reopen(force: true);
      } else if (terminal.status == TerminalSessionStatus.takenOver) {
        // Somebody else took it while this page held it. Arriving back on the page asks for it
        // again — the same open the band's button makes.
        if (!_canAttachPane(existing)) return;
        await terminal.reopen();
      } else if (terminal.status != TerminalSessionStatus.opening &&
          terminal.status != TerminalSessionStatus.controlling &&
          terminal.status != TerminalSessionStatus.resyncing) {
        if (!_canAttachPane(existing)) return;
        // Retry the dead stream in place so its output and view context remain
        // available until the next keyframe. Healthy panes stay focus-only.
        await terminal.reopen();
      }
      return;
    }
    await addAgentToSwarm(machineId, agentId, takeControl: person);
  }

  /// Opens [agentId]'s stream for a tile nobody is looking at yet — the phone's
  /// pager attaching the agents either side of the one on screen, so the next
  /// swipe lands on output instead of on "Attaching…".
  ///
  /// Everything [selectAgent] does BESIDES attaching is deliberately left out:
  /// no focus, no `selectedMachineId`, no `activeAgentId`, no announcement to
  /// the daemon, no layout write. The tile is a guess about where the thumb
  /// goes next, and none of those should move for a guess. [TerminalPane.warm]
  /// is the one thing that marks it, and [selectAgent] is what happens when the
  /// guess comes true.
  ///
  /// A tile already there is left alone — except a warm one holding a dead
  /// stream, which is reopened the way `_attachPendingPanes` would. A stream
  /// someone else took over is NOT reopened from here: that is the tug-of-war
  /// `_paneNeedsAttach` exists to avoid, and a page nobody is looking at has no
  /// business starting it.
  ///
  /// ⚠️ **The one open that never takes a terminal another app is driving.**
  /// Landing on an agent claims it (see [_attachSession]); this is a guess
  /// about the next swipe, and a guess must cost the desktop nothing. The
  /// machine answers only if the terminal is free; otherwise the tile sits as
  /// `takenOver` until a person actually arrives on it, and arriving is what
  /// claims it.
  ///
  /// ⚠️ **Nothing is opened at all on an OLDER machine.** A CLI that predates
  /// the key ignores it and takes the terminal over like any other open — so on
  /// such a machine the politeness above is not available, and a guess there
  /// would cost the desktop its terminal with nobody having arrived anywhere.
  /// See [MachineState.terminalNoTakeoverAvailable].
  Future<void> warmAgentPane(String machineId, String agentId) async {
    if (_disposed) return;
    if (machineStates[machineId]?.terminalNoTakeoverAvailable != true) return;
    final existing = paneOfAgent(machineId, agentId);
    if (existing != null) {
      // Only a tile that is still warm, whose session asks politely. One a
      // person has looked at reopens WITH a takeover, and that is for the
      // recovery every tile shares (`_attachPendingPanes`) to decide, never
      // for a guess about the next swipe.
      if (existing.warm && _paneNeedsAttach(existing)) {
        // ⚠️ Automatic, spelled out: [_reattachPane] defaults to a PERSON,
        // which raises the session's takeover — and a guess reopened that way
        // took the terminal off the desktop with nobody on the page.
        await _reattachPane(existing, intent: AttachIntent.automatic);
      }
      return;
    }
    if (!canAddPane || !_canAttachAgent(machineId, agentId)) return;
    final pane = TerminalPane(
      id: _nextPaneId++,
      machineId: machineId,
      agentId: agentId,
    )..warm = true;
    panes.add(pane);
    // Told, so the parked page for this agent builds its panel — which is what
    // measures the viewport `_attachSession` is about to wait for.
    notifyListeners();
    await _attachSession(pane, takeControl: false);
  }

  /// Show a MACHINE in the grid, for the states that belong to the machine
  /// rather than to any agent on it.
  ///
  /// It has to be a tile like any other — the alternative of letting a machine
  /// take over the whole content area would blank three working terminals
  /// belonging to two other machines. The one exception is a machine that
  /// already needs linking: that state now surfaces as a blocking popup
  /// (the desktop's `HomeScreen._maybeShowLinkDialog`) rather
  /// than a tile, so opening one here too would just be a redundant "not
  /// linked" pane sitting behind it. Selecting is still worth doing — it's
  /// what makes the popup's gate notice this machine — the tile is not.
  void showMachinePane(String machineId) {
    final machine = machineStates[machineId];
    if (machine == null) return;
    _dismissedLinkPrompts.remove(machineId);
    selectedMachineId = machineId;
    if (machine.isRemote && machine.needsLink) {
      notifyListeners();
      return;
    }

    final existing = panes
        .where((pane) => pane.machineId == machineId && pane.agentId == null)
        .firstOrNull;
    if (existing != null) {
      focusPane(existing.id);
      notifyListeners();
      return;
    }

    final target = focusedPane;
    if (target != null && target.agentId == null) {
      target.machineId = machineId;
      focusPane(target.id);
      notifyListeners();
      return;
    }
    if (!canAddPane) return;
    final pane = TerminalPane(id: _nextPaneId++, machineId: machineId);
    panes.add(pane);
    focusPane(pane.id);
    notifyListeners();
  }

  /// Put an agent into a specific tile, or into a NEW tile when [paneId] is
  /// null — which is what a drop on the empty slot means.
  Future<void> assignAgentToPane(
    int? paneId,
    String machineId,
    String agentId, {
    String? swarmId,
    bool takeControl = false,
  }) async {
    final target = swarms
        .where((s) => s.id == (swarmId ?? activeSwarmId))
        .firstOrNull;
    if (target == null || _disposed) return;
    final targetPanes = target.panes;
    final machine = machineStates[machineId];
    if (machine == null) return;

    Agent? agent;
    for (final candidate in machine.agents) {
      if (candidate.id == agentId) {
        agent = candidate;
        break;
      }
    }
    if (agent == null) return;

    final shared = allPanes
        .where((p) => p.machineId == machineId && p.agentId == agentId)
        .firstOrNull;
    final existing = targetPanes
        .where((p) => p.machineId == machineId && p.agentId == agentId)
        .firstOrNull;
    if (paneId == null && existing != null) {
      if (target == activeSwarm) focusPane(existing.id);
      return;
    }
    final replaced = targetPanes.where((p) => p.id == paneId).firstOrNull;
    if (replaced == shared && shared != null) {
      if (target == activeSwarm) focusPane(shared.id);
      return;
    }
    if (replaced == null &&
        existing == null &&
        targetPanes.length >= maxPanes) {
      _lastError =
          'This swarm holds $maxPanes harnesses. Open another swarm to add more.';
      _lastErrorRetryable = false;
      notifyListeners();
      return;
    }
    final insertion = replaced == null
        ? targetPanes.length
        : targetPanes.indexOf(replaced);
    if (existing != null) target.remove(existing);
    if (replaced != null) target.remove(replaced);
    final pane =
        shared ??
        TerminalPane(id: _nextPaneId++, machineId: machineId, agentId: agentId);
    final firstAgent = targetPanes.every((pane) => pane.agentId == null);
    targetPanes.insert(insertion.clamp(0, targetPanes.length), pane);
    if (firstAgent && target.name == Swarm.defaultName) {
      final name = agent.name.trim();
      if (name.isNotEmpty) {
        target.name = name.length > 80 ? name.substring(0, 80) : name;
      }
    }
    if (replaced != null && !allPanes.contains(replaced)) {
      // Release just the desktop stream. The CLI agent process keeps running.
      unawaited(_detachSession(replaced, sendClose: true));
    }

    target.focusedPaneId = pane.id;
    target.zoomedPaneId = null;
    if (target == activeSwarm) selectedMachineId = machineId;
    _dismissedLinkPrompts.remove(machineId);
    machine.activeAgentId = agentId;
    _persistLayout();

    if (machine.nodeOnline == false) {
      machine.pendingOfflineAgentId = agentId;
      _startOfflineRetry(machine);
      notifyListeners();
      return;
    }
    if (!machine.terminalCapabilityAvailable) {
      notifyListeners();
      return;
    }
    machine.pendingOfflineAgentId = null;
    _stopOfflineRetry(machineId);
    notifyListeners();
    if (target == activeSwarm || pane.session != null) {
      await _attachSession(pane, takeControl: takeControl);
    }
  }

  /// How this phone introduces itself on `terminal_open`, so a desktop it
  /// displaces can say "(this phone) took control": the name given it in
  /// Settings, else the OS's, else its model — `core/device_name.dart` has the
  /// order and why `Platform.localHostname` ("localhost" on iOS) is not it.
  TerminalClientDescriptor phoneClientDescriptor() {
    return TerminalClientDescriptor(
      kind: 'phone',
      name: composePhoneName(
        override: phoneNameStore.value,
        device: NativeDeviceInfo.cached,
        userName: currentUser?.name,
      ),
    );
  }

  /// Open the stream for a tile that already knows what it wants.
  ///
  /// Separate from [assignAgentToPane] because a restored tile takes this path
  /// on its own, later, when its machine finally answers — the intent was
  /// settled at launch, and nothing about the selection should move again then.
  /// ⚠️ **Every session built here CLAIMS the terminal** — [takeControl] is
  /// true unless the caller is a guess about where the thumb goes next
  /// ([warmAgentPane]), and nothing else opens a stream.
  ///
  /// The phone used to ask politely and land on a read-only stream with a "Take
  /// control" band over it, which is what opening the app looked like whenever
  /// a desktop had the agent — a band, an empty terminal, and a press before a
  /// single key could be typed. A phone is picked up to type at an agent, so
  /// arriving IS the claim now; the desktop it displaces says who took it and
  /// has the same button back.
  Future<void> _attachSession(
    TerminalPane pane, {
    bool takeControl = true,
  }) async {
    if (_disposed || !allPanes.contains(pane) || pane.session != null) return;
    final wantedAgentId = pane.agentId;
    if (wantedAgentId == null) return;
    final machine = machineStates[pane.machineId];
    if (machine == null) return;
    if (machine.nodeOnline == false) return;
    if (!machine.terminalCapabilityAvailable) return;
    Agent? agent;
    for (final candidate in machine.agents) {
      if (candidate.id == wantedAgentId) {
        agent = candidate;
        break;
      }
    }
    if (agent == null || !agent.terminalAvailable) return;

    final terminal = TerminalSession(
      machineId: pane.machineId,
      agentId: agent.id,
      agentName: agent.name,
      engineId: agent.engine,
      client: phoneClientDescriptor(),
      send: (type, payload) =>
          _conn(pane.machineId).sendTerminalFrame(type, payload),
      sendBinary: (frame) => _sendTerminalBinary(pane.machineId, frame),
      // ⚠️ **A socket that has not finished its handshake is not a stalled one,
      // and forcing a reconnect on it destroys the dial that was about to
      // succeed.** `terminal_open` can now be sent very early — the agent and
      // the machine's capabilities both come from the cache, so a terminal is
      // built while the relay handshake is still in flight. That open gets no
      // `terminal_ready`, which looks exactly like a stalled stream, and the
      // recovery for a stalled stream is `forceReconnect()`: it tore down the
      // in-progress dial, the redial started over, and the launch spent an extra
      // two seconds showing `Attaching → Disconnected → Attaching → Live`.
      //
      // Reconnecting is right for a session that stalled on a connection that IS
      // up — the relay's cached upstream session going stale, which is what this
      // hook was written for. It is wrong before readiness, where there is
      // nothing to recover and the thing to do is wait: `_onConnectionStatus`
      // reattaches every pane the moment the handshake lands.
      onOpenStalled: () async {
        final connection = _conn(pane.machineId);
        if (!connection.isReady) return false;
        await connection.forceReconnect();
        return true;
      },
      // ⚠️ **Opening IS taking, for everything a person does.** A page opened, swiped onto or
      // restored at launch claims the terminal; the one open that still asks politely is the warm
      // tile the pager builds ahead of the thumb, which is a guess and must not cost the desktop
      // anything. See [TerminalSession.takeover] and [warmAgentPane].
      takeover: takeControl,
    );
    pane.session = terminal;
    // Back to an agent read a moment ago: its last screen, at once, until the stream's arrives.
    final kept = _keptScreens.remove('${pane.machineId}/${agent.id}');
    if (kept != null) terminal.seedScreen(kept);
    terminal.addListener(notifyListeners);
    notifyListeners();
    // Wait for the pane's actual measured viewport before asking the daemon to open anything.
    // Sending the 80x24 fallback here used to make the daemon spawn the remote TTY (and render its
    // first keyframe) at that wrong size, which then had to be corrected by a resize round trip —
    // visible as the terminal's content briefly rendering narrow before snapping to full width. The
    // blank "Attaching…" placeholder already covers this measurement, which lands within a frame or
    // two of the panel mounting; `waitForViewportSize`'s own 2s timeout falls back to 80x24 only if
    // the pane genuinely never gets laid out.
    await terminal.open(waitForViewportSize: true);
  }

  Future<void> _detachSession(
    TerminalPane pane, {
    required bool sendClose,
  }) async {
    final terminal = pane.session;
    pane.session = null;
    if (terminal == null) return;
    terminal.removeListener(notifyListeners);
    // The screen as the reader left it, for the next time this agent opens — see [_keptScreens].
    final agentId = pane.agentId;
    if (agentId != null && terminal.hasRenderedFrame) {
      final key = '${pane.machineId}/$agentId';
      _keptScreens.remove(key);
      _keptScreens[key] = terminal.terminal;
      while (_keptScreens.length > _keptScreenLimit) {
        _keptScreens.remove(_keptScreens.keys.first);
      }
    }
    if (sendClose) await terminal.close();
    terminal.dispose();
  }

  /// ⌘; — the pane focused before this one.
  ///
  /// tmux spells it the same way, and the reason it earns a key is that two
  /// agents at a time is the shape most work actually has: a thing being built
  /// and a thing being watched. Walking a list to get back to the other one is
  /// the wrong motion, and it gets longer as the grid fills.
  set _previousPaneId(int? value) => activeSwarm.previousPaneId = value;

  /// ⌘⏎ — one pane filling the grid, and back.
  ///
  /// The id is held rather than a flag, so a zoom SURVIVES the thing that
  /// usually breaks this: focus moving. Zoomed on tile 3 and then jumping to
  /// tile 5 shows tile 5 zoomed, which is what tmux does and what the eye
  /// expects; a boolean would have shown tile 3 while the focus was elsewhere.
  int? get zoomedPaneId => activeSwarm.zoomedPaneId;
  set zoomedPaneId(int? value) => activeSwarm.zoomedPaneId = value;

  /// Put pinned tiles back in their slots after the list moved under them.
  ///
  /// Lifted rather than swapped: after a close everyone has slid up one, and
  /// lifting the pinned tile back into its slot leaves that slide intact for
  /// every other tile. A swap would instead fling whichever tile inherited the
  /// slot to the far end of the grid — one close, two tiles moved, and only one
  /// of them explicable.
  ///
  /// A pin past the end of a shrunken grid is HELD, not dropped: the tiles that
  /// closed can come back, and forgetting the pin the moment the grid got small
  /// would quietly undo a choice the user never revisited.
  void _settlePins() {
    final pinned = panes.where((pane) => pane.pinnedSlot != null).toList()
      ..sort((a, b) => a.pinnedSlot!.compareTo(b.pinnedSlot!));
    for (final pane in pinned) {
      final want = pane.pinnedSlot!;
      if (want >= panes.length) continue;
      final at = panes.indexOf(pane);
      if (at == want) continue;
      panes.removeAt(at);
      panes.insert(want, pane);
    }
  }

  Future<void> closePane(int paneId, {bool persist = true}) async {
    final pane = panes.where((p) => p.id == paneId).firstOrNull;
    if (pane == null) return;
    // A warm tile was never something the person had open — see
    // [TerminalPane.warm] — so closing it is not something to offer undoing.
    if (pane.agentId != null && !pane.warm) {
      final machine = stateOf(pane.machineId);
      final agent = machine?.agents
          .where((a) => a.id == pane.agentId)
          .firstOrNull;
      _rememberClosed(
        ClosedAgent(
          pane,
          activeSwarm,
          historyId: 'closed-${_nextClosedHistoryId++}',
          name: agent?.name ?? pane.session?.agentName ?? pane.agentId!,
          machineName: machine?.machine.displayName ?? pane.machineId,
          engine: agent?.engine ?? pane.session?.engineId,
        ),
      );
    }
    activeSwarm.remove(pane);
    _settlePins();
    if (persist) _persistLayout();
    selectedMachineId = focusedPane?.machineId;
    notifyListeners();
    if (!allPanes.contains(pane)) await _detachSession(pane, sendClose: true);
  }

  /// The last screens of agents this phone closed, oldest first — shown the instant one is opened
  /// again, while its live stream attaches ([TerminalSession.seedScreen]). A few, not all: each holds
  /// its scrollback, up to 10,000 lines.
  final _keptScreens = <String, Terminal>{};
  static const _keptScreenLimit = 3;

  Future<void> _closeAllPanes({bool persist = true}) async {
    // Everything closing at once is a sign-out or a reset: nothing of it is kept.
    _keptScreens.clear();
    final open = allPanes.toList();
    for (final swarm in swarms) {
      swarm.panes.clear();
      swarm.focusedPaneId = null;
      swarm.zoomedPaneId = null;
    }
    for (final pane in open) {
      await _detachSession(pane, sendClose: true);
    }
    if (persist) _persistLayout();
  }

  int _layoutRevision = 0;

  Future<void> flushPaneLayout() =>
      _paneLayout?.flushSwarms() ?? Future<void>.value();

  void _persistLayout() {
    _draftSwarmReturns.removeWhere((id, _) {
      final swarm = swarms.where((swarm) => swarm.id == id).firstOrNull;
      return swarm == null ||
          swarm.panes.isNotEmpty ||
          swarm.name != Swarm.defaultName;
    });
    _layoutRevision++;
    final saved = swarms.where((swarm) => !isDraftSwarm(swarm.id)).toList();
    if (saved.isEmpty) return;
    final savedActive = isDraftSwarm(activeSwarmId)
        ? _draftSwarmReturns[activeSwarmId]
        : activeSwarmId;
    unawaited(
      _paneLayout?.saveSwarms(
        saved,
        saved.any((swarm) => swarm.id == savedActive)
            ? savedActive!
            : saved.last.id,
      ),
    );
  }

  /// Rebuild the grid from disk as INTENT only — the tiles appear immediately,
  /// each saying which machine it is waiting for, and attach themselves as
  /// their machines answer.
  ///
  /// The tiles cannot wait for the machines: machines answer in an order this
  /// side does not decide, a restored grid commonly spans two of them, and one
  /// being slow or offline must not hold the others blank.
  Future<void> _restorePaneLayout() async {
    final store = _paneLayout;
    if (store == null) return;
    final initialSwarm = activeSwarm;
    final revision = _layoutRevision;
    final saved = await store.loadSwarms();
    if (_disposed || revision != _layoutRevision) return;
    if (saved != null &&
        allPanes.isEmpty &&
        swarms.length == 1 &&
        activeSwarm == initialSwarm) {
      final restored = <Swarm>[];
      final pool = <String, TerminalPane>{};
      for (final raw in (saved['swarms'] as List).take(maxSwarms)) {
        if (raw is! Map || raw['id'] is! String || raw['panes'] is! List) {
          continue;
        }
        final id = raw['id'] as String;
        if (id.isEmpty || restored.any((s) => s.id == id)) continue;
        final swarm = Swarm(
          id: id,
          name:
              raw['name'] is String && (raw['name'] as String).trim().isNotEmpty
              ? (raw['name'] as String).substring(
                  0,
                  (raw['name'] as String).length.clamp(0, 80),
                )
              : Swarm.defaultName,
        );
        for (final item in (raw['panes'] as List).take(maxPanes)) {
          final entry = PaneLayoutEntry.fromJson(item);
          if (entry == null) continue;
          final key = '${entry.machineId}\u0000${entry.agentId}';
          final pane = pool.putIfAbsent(
            key,
            () => TerminalPane(
              id: _nextPaneId++,
              machineId: entry.machineId,
              agentId: entry.agentId,
            )..pinnedSlot = entry.pinnedSlot,
          );
          if (!swarm.panes.contains(pane)) {
            swarm.panes.add(pane);
            if (entry.pinnedSlot != null) {
              swarm.pinnedSlots[pane.id] = entry.pinnedSlot!;
            }
          }
        }
        int? paneAt(Object? index) =>
            index is int && index >= 0 && index < swarm.panes.length
            ? swarm.panes[index].id
            : null;
        swarm.focusedPaneId =
            paneAt(raw['focus']) ?? swarm.panes.firstOrNull?.id;
        swarm.zoomedPaneId = paneAt(raw['zoom']);
        swarm.previousPaneId = paneAt(raw['previousFocus']);
        restored.add(swarm);
      }
      if (restored.isNotEmpty) {
        // Older builds saved multiple unused start pages. Retain the selected
        // one when possible; custom names and real work stay intact.
        final starters = restored.where((swarm) => swarm.isEmptyStarter);
        final starter =
            starters
                .where((swarm) => swarm.id == saved['activeId'])
                .firstOrNull ??
            starters.firstOrNull;
        final hadDuplicateStarters = starters.length > 1;
        if (hadDuplicateStarters) {
          restored.removeWhere(
            (swarm) => swarm.isEmptyStarter && swarm != starter,
          );
        }
        swarms
          ..clear()
          ..addAll(restored);
        _activeSwarmId = restored.any((s) => s.id == saved['activeId'])
            ? saved['activeId'] as String
            : restored.first.id;
        while (swarms.any((s) => s.id == 'swarm-$_nextSwarmId')) {
          _nextSwarmId++;
        }
        _autoPickedAgent = true;
        if (hadDuplicateStarters) _persistLayout();
        notifyListeners();
        return;
      }
    }
    if (allPanes.isNotEmpty ||
        swarms.length != 1 ||
        activeSwarm != initialSwarm) {
      return;
    }
    final entries = await store.load();
    if (_disposed || revision != _layoutRevision) return;
    if (entries.isEmpty) return;
    for (final entry in entries) {
      panes.add(
        TerminalPane(
          id: _nextPaneId++,
          machineId: entry.machineId,
          agentId: entry.agentId,
        )..pinnedSlot = entry.pinnedSlot,
      );
    }
    // The saved order already puts everything where it was left, so this is
    // only a repair: a layout whose file was hand-edited, or trimmed by the
    // pane ceiling on the way in, can arrive with a pinned tile off its slot.
    _settlePins();
    focusedPaneId = panes.first.id;
    // A restored grid IS the choice of what to open, so the first-run
    // convenience must not also fire and add a fifth agent nobody asked for.
    _autoPickedAgent = true;
    notifyListeners();
  }

  /// Attach any tile of this machine that is still waiting.
  ///
  /// Called after every load rather than once, because the three things
  /// [_attachSession] insists on — the agent exists, it has a tmux terminal,
  /// and the machine's terminal protocol has been negotiated — become true at
  /// different moments, and a machine that goes away and returns has to be able
  /// to re-arrive at them.
  void _attachPendingPanes(
    MachineState machine, {
    bool retryExisting = true,
    required AttachIntent intent,
  }) {
    // Nobody asked on this phone, and this machine's CLI cannot open a terminal
    // without taking it from whoever has it — so it opens nothing.
    if (intent == AttachIntent.automatic &&
        !machine.terminalNoTakeoverAvailable) {
      return;
    }
    final machineId = machine.machine.machineId;
    for (final pane in allPanes.toList()) {
      if (!panes.contains(pane) && pane.session == null) continue;
      if (pane.machineId != machineId) continue;
      // Navigation may mount a new view; it must never retry a retained stream
      // or discard its output while the machine is unavailable.
      if (!retryExisting && pane.session != null) continue;
      if (!_paneNeedsAttach(pane)) continue;
      // Covers a tile that never attached AND one holding a stream the machine
      // lost. Only the first used to be covered, and the second is why a
      // reconnect left every tile but one frozen on "restoring terminal…":
      // recovery ran off pendingOfflineAgentId, which is a single slot, so it
      // could only ever promise restoration to one of them.
      unawaited(_reattachPane(pane, intent: intent));
    }
  }

  /// Whether this tile is showing something that is not a working terminal.
  ///
  /// `takenOver` is deliberately absent. A stream someone else claimed is only
  /// reopened when a person asks for it — see [selectAgent], which is reached
  /// from the tile's own retry button. Doing it automatically would have two
  /// windows trading one terminal back and forth for as long as both stayed
  /// open.
  bool _paneNeedsAttach(TerminalPane pane) {
    if (pane.agentId == null) return false;
    final session = pane.session;
    if (session == null) return true;
    return switch (session.status) {
      TerminalSessionStatus.error || TerminalSessionStatus.closed => true,
      _ => false,
    };
  }

  /// Reopen a dead stream in its existing session, keeping its rendered output.
  /// An already-lost stream needs no close addressed to its previous owner.
  Future<void> _reattachPane(
    TerminalPane pane, {
    AttachIntent intent = AttachIntent.person,
  }) async {
    if (!_canAttachPane(pane)) return;
    final session = pane.session;
    if (session == null) {
      await _attachSession(pane, takeControl: intent == AttachIntent.person);
    } else {
      if (intent == AttachIntent.person) session.takeover = true;
      await session.reopen();
    }
  }

  bool _canAttachPane(TerminalPane pane) =>
      !_disposed &&
      allPanes.contains(pane) &&
      _canAttachAgent(pane.machineId, pane.agentId);

  /// Whether a terminal for this agent could be opened right now, whether or not a pane holds it.
  bool _canAttachAgent(String machineId, String? agentId) {
    final machine = machineStates[machineId];
    return machine != null &&
        machine.nodeOnline != false &&
        machine.terminalCapabilityAvailable &&
        !(machine.isRemote && machine.needsLink) &&
        machine.agents.any((a) => a.id == agentId && a.terminalAvailable);
  }

  /// Resolve a dial agent to the machine that owns it.
  ///
  /// New CLIs state the machine explicitly. Older CLIs only sent an agent id;
  /// that is safe to retain only when the current snapshots contain exactly
  /// one matching machine. The websocket carrying the event is always the
  /// local daemon and is therefore not evidence that the agent is local.
  String? _dialFocusMachine(Map<String, dynamic> payload, String agentId) {
    final explicitMachineId = payload['machineId'];
    if (explicitMachineId is String && explicitMachineId.isNotEmpty) {
      final state = machineStates[explicitMachineId];
      if (state == null ||
          !state.agents.any((candidate) => candidate.id == agentId)) {
        return null;
      }
      return explicitMachineId;
    }

    String? match;
    for (final entry in machineStates.entries) {
      if (!entry.value.agents.any((candidate) => candidate.id == agentId)) {
        continue;
      }
      if (match != null) return null; // Ambiguous legacy event: do not guess.
      match = entry.key;
    }
    return match;
  }

  Future<void> _handleEvent(
    String machineId,
    Map<String, dynamic> event,
  ) async {
    final machine = machineStates[machineId];
    if (machine == null) return;
    final type = event['type'] as String? ?? '';
    final payload = (event['payload'] as Map<String, dynamic>?) ?? {};
    // Only terminal protocol frames visit the session pool. Heartbeats, dial
    // scroll and discovery events must not await every retained terminal.
    // Each session still sees terminal frames: ready replies match their own
    // request/agent, while transport errors must reach the whole machine.
    if (type.startsWith('terminal_')) {
      for (final pane in panesFor(machineId).toList()) {
        await pane.session?.handleFrame(type, payload);
      }
      return;
    }
    if (SessionPreviewStore.eventTypes.contains(type)) {
      _ingestPreview(machine, event, type, payload);
      // Content belongs to the preview's notifier. It must not invalidate the
      // whole app for every token or tool event.
      if (type != 'turn_started' && type != 'turn_ended') return;
    }
    switch (type) {
      // ── the dial, over the cable, forwarded by the local daemon ──────────────────────────────────
      // Local-only frames (backend.sendLocal in the harness CLI): they describe a hand at THIS desk, so
      // they never reach the cloud web audience, who may be sitting at another computer entirely.
      case 'dial_status':
        // The dial came, went, or started taking an update. Its own notifier —
        // see [dial] — so nothing else in the window rebuilds for it.
        dial.apply(DialStatus.fromJson(payload));
        return;
      case 'dial_scroll':
        // Straight through, including the reports carrying no travel — the ends of a stroke are the point
        // of the message. The window does no arithmetic here; the terminal that owns the scrollback does.
        final phase = switch (payload['phase']) {
          'down' => 0,
          'up' => 2,
          _ => 1,
        };
        activeTerminal?.scroll(
          phase,
          (payload['dy'] as num?)?.round() ?? 0,
          (payload['velocity'] as num?)?.round() ?? 0,
        );
        return;
      case 'device_focus':
        unawaited(ensureDeviceFocus(payload));
        break;
      case 'dial_focus':
        // Turning the dial to an agent brings that agent's terminal up here — the ordinary selection
        // path, the same one a click on the rail takes, failing the same way for a missing terminal,
        // an offline machine or an unknown id.
        //
        // It used to carry an `edge` for an agent with no tile, naming which end of the desk the
        // carousel had walked off so a tile could be replaced there. The carousel walks only open
        // panes now, so every focus it sends is about a pane that already exists.
        final agentId = payload['agentId'];
        if (agentId is String && agentId.isNotEmpty) {
          final targetMachineId = _dialFocusMachine(payload, agentId);
          if (targetMachineId != null) {
            unawaited(selectAgentFromDial(targetMachineId, agentId));
          }
        }
        break;
      case 'dial_swarm':
        // The dial picked a swarm from its own list. The ordinary switch, exactly as ⌘] or a click on
        // the tab: the desk changes, `_persistLayout` re-describes it, and the dial's ring and swarm
        // line follow from that — nothing is answered to the dial directly.
        final swarmId = payload['swarmId'];
        if (swarmId is String && swarmId.isNotEmpty) selectSwarm(swarmId);
        break;
      case 'device_keys_changed':
        // The account's device key log grew: read and verify it from this phone's head.
        // Arrives once per machine socket, like desk_changed; concurrent reads share one.
        unawaited(_deviceLog?.refresh());
        return;
      case 'machines_changed':
        // The account's machine list changed somewhere: a machine created, renamed or deleted. The
        // payload is only a reason; the list itself is read again (once per machine socket it
        // arrives on: concurrent reads share one).
        _rereadMachines();
        return;
      case 'desk_changed':
        // The account's tabs changed — in a window on some computer, or on
        // another phone. The frame carries only the revision; the document
        // itself is fetched, so a burst of edits collapses into one read.
        //
        // ⚠️ It arrives once per MACHINE this phone is connected to (the backend
        // has no per-phone socket to send it on, so it rides each machine's —
        // `lib/webWs.ts`). [PhoneDesk.noticeRevision] is what makes four
        // machines mean one GET.
        _desk.noticeRevision(payload['revision']);
        return;
      case 'zoo_changed':
        // The account's daemons and eggs changed — an egg earned on a computer,
        // a hatch or a pair switch on another client. Once per machine, like
        // `desk_changed`; [ZooClient.noticeRevision] makes that one GET.
        zoo.noticeRevision(payload['revision']);
        return;
      case 'node_status':
        final online = payload['online'] == true;
        await _applyNodeStatus(machine, online);
        break;
      case 'machine_select_error':
        _lastError =
            'Machine selection failed: ${payload['error'] ?? 'unknown error'}';
        _lastErrorRetryable = true;
        machine.connectionStatus = ConnectionStatus.disconnected;
        break;
      case 'agent_synced':
        final raw = payload['agent'];
        if (raw is Map) {
          try {
            final agent = Agent.fromJson(Map<String, dynamic>.from(raw));
            _upsertAgent(machine, agent);
            if (agent.terminalAvailable) {
              // A pane created before this agent's terminal was verified is still sitting on
              // "Attaching…" with no session — nothing else re-checks it once agentLoadStatus is
              // already `loaded`, so this push is the only signal that it can attach now.
              // A push about an agent synced elsewhere.
              _attachPendingPanes(machine, intent: AttachIntent.automatic);
            } else {
              // ⚠️ **Kept, not removed — the desktop's rule.** This is how a STOP arrives
              // (`publishStoppedAgent` pushes the agent with `status: 'stopped'`), and also how an
              // agent looks for a moment while its pane is re-verified. Removing it here made
              // stopped work vanish from the phone until the next full reload, so there was no row
              // left to resume. `agent_deleted` is what removes an agent; this only lets go of the
              // streams, which have no terminal behind them any more.
              for (final pane in panesFor(machine.machine.machineId).toList()) {
                if (pane.agentId != agent.id) continue;
                await _detachSession(pane, sendClose: false);
              }
            }
          } catch (_) {
            unawaited(_loadMachineData(machine, force: true));
          }
        } else {
          unawaited(_loadMachineData(machine, force: true));
        }
        break;
      case 'agent_created':
        final raw = payload['agent'];
        if (raw is Map && raw['terminal'] is Map) {
          try {
            final agent = Agent.fromJson(Map<String, dynamic>.from(raw));
            _upsertAgent(machine, agent);
            // Same reattach as `agent_synced` above — a pane can be waiting on this exact agent
            // (e.g. one this window's own New Agent dialog just opened) with no session yet.
            // A push about an agent created elsewhere.
            _attachPendingPanes(machine, intent: AttachIntent.automatic);
          } catch (_) {
            unawaited(_loadMachineData(machine, force: true));
          }
        } else {
          unawaited(_loadMachineData(machine, force: true));
        }
        break;
      case 'agent_renamed':
        final agentId = _eventAgentId(machine, event, payload);
        final name = payload['name'];
        if (agentId != null && name is String) {
          _renameAgent(machine, agentId, name);
        } else {
          unawaited(_loadMachineData(machine, force: true));
        }
        break;
      case 'agent_deleted':
        final agentId = _eventAgentId(machine, event, payload);
        if (agentId != null) await _removeAgent(machine, agentId);
        // ⚠️ **`retained` is a stop, not a deletion — the desktop's rule.** The
        // daemon's `forgetSession` ends the live agent and keeps its work as a
        // stopped harness in the same breath, and says only this; the stopped
        // row is in the next `agents_list` (`includeStopped`), never in a push.
        // Without the read the harness vanished from the phone until the
        // 60-second sync — the one row somebody opens to resume it.
        if (agentId == null || payload['retained'] == true) {
          unawaited(_loadMachineData(machine, force: true));
        }
        break;
      // An agent stopped and is waiting on the person. Ignored by this window
      // until now, even though the daemon had already shaped the question for
      // the dial — `sendCommander` is device-only, so it never came down this
      // wire at all.
      case 'commander_question':
        final agentId = _eventAgentId(machine, event, payload);
        if (agentId != null) {
          final asked = PendingQuestion.fromPayload(
            machineId: machineId,
            agentId: agentId,
            payload: payload,
            now: DateTime.now(),
          );
          if (asked != null) {
            // The daemon re-announces an open question after a reconnect, and
            // on attaching to a turn that was already mid-dialog. Keep the
            // original clock in that case: this is the same wait continuing,
            // and restarting it would make a long block look new.
            final known = machine.blockedAgents[agentId];
            machine.blockedAgents[agentId] =
                known != null && known.sameAs(asked)
                ? asked.withSince(known.since)
                : asked;
            // Whether it is NEWS is the announcer's to say, not [known]'s:
            // `blockedAgents` is emptied on every dropped socket, and the
            // re-announce that follows is the same question — see
            // `notify/question_notice.dart`.
            _announceQuestion(machine, asked);
          }
        }
        break;
      // It stopped being on screen — answered here, in the pane by hand, on
      // another window, or on the dial. Whoever got there first, everyone else
      // is told to stop drawing it.
      case 'commander_question_close':
        final agentId = _eventAgentId(machine, event, payload);
        final requestId = payload['requestId'];
        if (agentId != null) {
          final open = machine.blockedAgents[agentId];
          // Only if it is the one being closed: a stale close must not wipe the
          // question that replaced it when a dialog advanced to its next page.
          if (open != null &&
              (requestId is! String ||
                  requestId.isEmpty ||
                  open.requestId == requestId)) {
            machine.blockedAgents.remove(agentId);
          }
          agentNotices.questionClosed((
            machineId: machine.machine.machineId,
            agentId: agentId,
          ), requestId: requestId is String ? requestId : null);
        }
        break;
      case 'turn_started':
      case 'turn_heartbeat':
        var changed = false;
        final agentId = _eventAgentId(machine, event, payload);
        if (agentId != null) {
          machine.agentActivityAt[agentId] = DateTime.now();
          changed = _markAgentProcessing(machine, agentId);
          // Only a START opens a stats turn, for the reason above: a heartbeat
          // is a turn already under way, and counting one would report an agent
          // this app merely reconnected to as work somebody just asked for.
          if (type == 'turn_started') {
            stats.onTurnStarted(
              _turnActivityKey(machine.machine.machineId, agentId),
            );
          }
        } else {
          final sessionId = _eventSessionId(event, payload);
          if (sessionId != null) {
            changed = machine.pendingProcessingSessions.add(sessionId);
          }
        }
        // Renew the watchdog on every heartbeat, but redraw only when the
        // agent first becomes busy. Expiry and turn end publish separately.
        if (!changed) return;
        break;
      case 'turn_ended':
        final agentId = _eventAgentId(machine, event, payload);
        if (agentId != null) {
          // The answer just landed — the moment a recency sort should follow.
          machine.agentActivityAt[agentId] = DateTime.now();
          _cancelTurnActivity(machine.machine.machineId, agentId);
          _announceTurnEnd(machine, agentId, event, payload);
        } else {
          final sessionId = _eventSessionId(event, payload);
          if (sessionId != null) {
            machine.pendingProcessingSessions.remove(sessionId);
          }
        }
        break;
      // ⚠️ Everything else changed nothing here, so it must not redraw. The machine streams every
      // agent's live chat — `text_delta`, `tool_start`, … — down this socket, several per second
      // per agent, and each one used to rebuild every screen listening to this notifier.
      default:
        return;
    }
    notifyListeners();
  }

  /// Feed one machine event straight into the dispatcher.
  ///
  /// The frames worth testing here have no terminal to route through and no
  /// socket to arrive on — what they exercise is the bookkeeping either side of
  /// that, which is exactly what a live socket makes hard to reach.
  @visibleForTesting
  Future<void> restorePaneLayoutForTest() => _restorePaneLayout();

  @visibleForTesting
  Future<void> handleMachineEventForTest(
    String machineId,
    Map<String, dynamic> event,
  ) => _handleEvent(machineId, event);

  @visibleForTesting
  Future<void> handleTerminalBinaryForTest(String machineId, Uint8List frame) =>
      _handleTerminalBinary(machineId, frame);

  /// Put an already-built session on the grid.
  ///
  /// The seam tests used to get from assigning `activeTerminal` directly, which
  /// a grid cannot offer: a session on screen is a session in a TILE, and the
  /// tile is what every lifecycle path — a machine going offline, an agent
  /// being deleted, a frame arriving — actually looks for.
  @visibleForTesting
  TerminalPane adoptSessionForTest(TerminalSession session) {
    final pane = TerminalPane(
      id: _nextPaneId++,
      machineId: session.machineId,
      agentId: session.agentId,
    )..session = session;
    panes.add(pane);
    focusedPaneId = pane.id;
    session.addListener(notifyListeners);
    return pane;
  }

  @visibleForTesting
  Future<void> handleEventForTest(
    String machineId,
    Map<String, dynamic> event,
  ) => _handleEvent(machineId, event);

  /// The agent on screen, when the app is in front of anybody.
  AgentRef? get _watchedAgent {
    if (!agentNotices.inFront) return null;
    final pane = focusedPane;
    final agentId = pane?.agentId;
    if (pane == null || agentId == null) return null;
    return (machineId: pane.machineId, agentId: agentId);
  }

  void _seeWatchedAgent() {
    final watched = _watchedAgent;
    if (watched != null) agentNotices.seen(watched);
  }

  /// Every change the screens hear about is also a chance that the agent on
  /// screen is a different one — and going to an agent is what reads its news.
  ///
  /// ⚠️ **Here, and not in the `focusedPaneId` setter where it first went.**
  /// Half the roads onto an agent never touch that setter: a NEW pane — a row
  /// tapped, a notice tapped — is focused on its swarm directly, and so are a
  /// restored layout and a swarm switched to. Hooked there, the mark outlived
  /// the person opening the very agent it pointed at. Every one of those roads
  /// ends by notifying, so this is the one place none of them can miss. It
  /// costs a lookup: [AgentAnnouncer.seen] is silent for an agent with no mark.
  @override
  void notifyListeners() {
    _seeWatchedAgent();
    super.notifyListeners();
  }

  /// [agent] on [machine], as a notice names it.
  NoticeAgent _noticeAgent(MachineState machine, Agent agent) => (
    ref: (machineId: machine.machine.machineId, agentId: agent.id),
    name: agent.displayName,
    machine: machine.machine.displayName,
  );

  /// An agent this phone has not been told about is never announced: a notice
  /// about it could not open anything.
  Agent? _knownAgent(MachineState machine, String agentId) =>
      machine.agents.where((a) => a.id == agentId).firstOrNull;

  /// One agent's turn ended: tell the person as the dial would — see
  /// `notify/done_notice.dart` for when that is a tap, a mark or a notice.
  void _announceTurnEnd(
    MachineState machine,
    String agentId,
    Map<String, dynamic> event,
    Map<String, dynamic> payload,
  ) {
    final agent = _knownAgent(machine, agentId);
    if (agent == null) return;
    final who = _noticeAgent(machine, agent);
    agentNotices.turnEnded(
      who,
      turnEndFrom(
        event,
        payload,
        reply: sessionPreviews
            .read(previewKey(who.ref.machineId, agent))
            ?.turnReply,
      ),
      watching: () => _watchedAgent == who.ref,
    );
  }

  /// An agent stopped to ask the person something — see
  /// `notify/question_notice.dart`.
  void _announceQuestion(MachineState machine, PendingQuestion asked) {
    final agent = _knownAgent(machine, asked.agentId);
    if (agent == null) return;
    final who = _noticeAgent(machine, agent);
    agentNotices.questionAsked(
      who,
      requestId: asked.requestId,
      prompt: asked.prompt,
      watching: () => _watchedAgent == who.ref,
    );
  }

  /// The app is back in front of somebody: every machine socket the phone lost while it was away
  /// dials again now instead of waiting out a backoff nobody is watching.
  ///
  /// ⚠️ The phone loses these sockets by being BACKGROUNDED — the OS stops the process, and it is
  /// not obliged to say so. Nothing here detects that at the time, and nothing can: a suspended
  /// process runs no code to notice with. Resuming is the first moment the app is able to look, so
  /// it is the moment it must.
  ///
  /// Safe to call on every resume. [WsPool.reconnectAll] skips connections that are already open
  /// and connections somebody closed on purpose, so a tab switch that cost nothing costs nothing.
  void handleAppResumed() {
    _pool?.reconnectAll();
    // Back in front of the agent that was on screen: whatever it finished
    // while the phone was in a pocket has now been seen.
    _seeWatchedAgent();
    // ⚠️ **The desk is re-read here and not only on a push.** A backgrounded
    // phone runs no code, so every `desk_changed` sent while it was away
    // reached a socket nobody was listening on: without this the tabs would be
    // whatever they were when the phone went into a pocket, until something
    // else happened to change them.
    unawaited(_desk.refresh());
    if (status == AppStatus.authenticated) {
      // The device key log too: a `device_keys_changed` sent while the phone was away reached nobody
      // — and this phone's key goes into it if the boot could not put it there.
      unawaited(_deviceLog?.ensureRegistered());
      // And the machine list, when no machine is connected to push one: the person most likely just
      // went to their computer to sign it in.
      _rereadMachinesWhileDeaf();
      _startDeafPoll();
    }
    // The zoo too, for the same reason: a `zoo_changed` sent while the phone
    // was in a pocket reached nobody.
    if (status == AppStatus.authenticated) unawaited(zoo.refresh());
  }

  /// The app went into a pocket: stop the reads that only make sense in front
  /// of somebody. The sockets are left to the OS, which suspends them anyway —
  /// [handleAppResumed] is what puts both back.
  void handleAppPaused() {
    _desk.pause();
    _stopDeafPoll();
  }

  /// How often a phone with no machine connected reads the machine list again. Every push
  /// (`machines_changed`, `device_keys_changed`) reaches the phone over a machine's socket; with none
  /// connected — the person signed in on the phone first and is now running `harness login` on their
  /// computer — nothing tells it that computer joined.
  @visibleForTesting
  Duration deafMachineListInterval = const Duration(seconds: 20);

  Timer? _deafMachineListTimer;
  Future<void>? _machineReread;

  void _startDeafPoll() {
    if (_disposed || status != AppStatus.authenticated) return;
    _deafMachineListTimer ??= Timer.periodic(
      deafMachineListInterval,
      (_) => _rereadMachinesWhileDeaf(),
    );
  }

  void _stopDeafPoll() {
    _deafMachineListTimer?.cancel();
    _deafMachineListTimer = null;
  }

  /// A phone that hears nothing reads the machine list again: the computer the person is signing in on
  /// right now appears, and the dial that follows reads the device log for its key first.
  void _rereadMachinesWhileDeaf() {
    if (_disposed || status != AppStatus.authenticated) return;
    if (machineStates.values.any(
      (m) => m.connectionStatus == ConnectionStatus.connected,
    )) {
      return;
    }
    _rereadMachines();
  }

  /// Read the machine list again because something other than the person asked; reads under way are
  /// shared, and a failure is left to the next one.
  void _rereadMachines() {
    _machineReread ??= refreshMachines()
        .catchError((Object _) {})
        .whenComplete(() => _machineReread = null);
  }

  /// What the local CLI closing this machine's socket with [code] does to the
  /// model — the `WsPool.onLocalFailure` path, without a socket.
  @visibleForTesting
  void localFailureForTest(String machineId, int code, String reason) =>
      _onLocalFailure(machineId, code, reason);

  /// What a socket finding the session gone for good does to the model — the
  /// `WsPool.onAuthFailure` path ([WsCredentialRevoked]), without a socket.
  @visibleForTesting
  void authFailureForTest(String message) => _signedOutAtRuntime(message);

  @override
  void dispose() {
    for (final controller in _teamControllers.values) {
      controller.dispose();
    }
    _teamControllers.clear();
    for (final controller in _channelControllers.values) {
      controller.dispose();
    }
    _channelControllers.clear();
    _disposed = true;
    _closedHistory.clear();
    _stopAccountTimers();
    _stopAllOfflineRetries();
    _stopAllAgentSyncTimers();
    _clearAllTurnActivity();
    for (final pane in allPanes) {
      pane.session?.removeListener(notifyListeners);
      pane.session?.dispose();
    }
    for (final swarm in swarms) {
      swarm.panes.clear();
    }
    sessionPreviews.dispose();
    agentNotices.dispose();
    _desk.dispose();
    daemonHabits.dispose();
    individualArt.dispose();
    zoo.dispose();
    super.dispose();
  }
}

final appStateProvider = Provider<AppNotifier>((ref) {
  final app = AppNotifier(
    config: AppConfig.dev,
    authSession: AuthSession(),
    configStore: ConfigStore(),
    paneLayoutStore: PaneLayoutStore(),
  );
  app.bootstrap();
  return app;
});
