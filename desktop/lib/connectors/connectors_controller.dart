import 'dart:async';

import 'package:flutter/foundation.dart';

import '../core/models.dart' show Agent;
import '../core/open_in_browser.dart';
import '../state/app_state.dart';

/// One service on Settings ▸ Connectors, as this computer's daemon reports it
/// (`connectors` `list`, cli/src/lib/connectors/connect.ts `cards`).
@immutable
class ConnectorCard {
  const ConnectorCard({
    required this.code,
    required this.name,
    required this.description,
    required this.state,
    this.account = '',
    this.auth = 'dcr',
    this.custom = false,
    this.reason = '',
    this.tools = false,
  });

  factory ConnectorCard.fromJson(Map<String, dynamic> json) => ConnectorCard(
    code: json['connector'] as String? ?? '',
    name: json['name'] as String? ?? '',
    description: json['description'] as String? ?? '',
    state: json['state'] as String? ?? 'not_connected',
    account: json['account'] as String? ?? '',
    auth: json['auth'] as String? ?? 'dcr',
    custom: json['custom'] == true,
    reason: json['reason'] as String? ?? '',
    tools: json['tools'] == true,
  );

  final String code;
  final String name;
  final String description;

  /// `not_connected`, `connected` or `reconnect`.
  final String state;
  final String account;

  /// `dcr` (signs in from this computer), `app` (through the Harness account) or `custom`.
  final String auth;
  final bool custom;

  /// Why it cannot be connected now ("Needs harness login"), or empty.
  final String reason;

  /// Whether agents get it as MCP tools (else only `harness connections call`).
  final bool tools;

  bool get connected => state != 'not_connected';
}

/// Settings ▸ Connectors: this computer's connected services, through its
/// daemon. A sign-in opens the service's consent page in the browser and is
/// followed until it finishes; the list itself never leaves the app.
class ConnectorsController extends ChangeNotifier {
  ConnectorsController(this.app, {this.machineId});

  final AppNotifier app;

  /// The computer whose connections these are; this one by default.
  final String? machineId;

  /// How often a sign-in in progress is asked about, and for how long.
  @visibleForTesting
  static Duration pollEvery = const Duration(seconds: 1);
  static const _signInFor = Duration(minutes: 6);

  List<ConnectorCard> cards = const [];
  bool signedIn = true;
  bool loading = false;
  String? error;
  final Set<String> pending = {};
  bool _disposed = false;

  /// Whether a connection made here reaches the account's other computers (`list` `shared`).
  bool shared = false;

  /// The agent engines on that computer that connect Gmail, Calendar and Drive through their own account
  /// (`connectors` `elsewhere`, cli/src/lib/connectors/elsewhere.ts): `claude`, `codex`. Only those are offered.
  Set<String> engines = const {};

  /// Per service, its state through each engine: `connected`, `reconnect`, `installed` (Codex) or `not_connected`.
  Map<String, Map<String, String>> via = const {};

  /// Per service, what each engine's way lets an agent do.
  Map<String, Map<String, String>> scopes = const {};

  /// Services only an engine connects (Microsoft 365), which the Harness list has no card for (`elsewhere` `services`).
  List<ConnectorCard> viaOnly = const [];

  /// The cards to show: the Harness list, and the engine-only services it does not have.
  List<ConnectorCard> get shownCards => [
    ...cards,
    for (final card in viaOnly)
      // Only where that computer has an engine to connect it through.
      if (!cards.any((c) => c.code == card.code) && hasWays(card.code)) card,
  ]..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));

  /// Whether Harness's own sign-in is a way into [code]; not for an engine-only service.
  bool harnessWay(String code) => scopes[code]?.containsKey('harness') ?? true;

  /// Whether [code] can be connected through Claude Code or Codex on that computer.
  bool hasWays(String code) => via[code]?.keys.any(engines.contains) ?? false;

  /// Whether [code] is connected, or installed, through an engine.
  bool connectedVia(String code) =>
      via[code]?.entries.any(
        // Codex's plugin installed counts: whether its account is signed in is ChatGPT's to know.
        (e) => engines.contains(e.key) && e.value != 'not_connected',
      ) ??
      false;

  /// ChatGPT's connectors, where the accounts Codex's plugins use are added, or the main one chosen: more than
  /// one Google account if the person wants. Codex's own, not Harness's to hold.
  static final codexAccounts = Uri.parse(
    'https://chatgpt.com/#settings/Connectors',
  );

  Future<void> openCodexAccounts() => openInBrowser(codexAccounts);

  /// What the last action came to. It goes away on its own: Settings keeps this page alive, and a
  /// "disconnected" from days ago was still standing there.
  String get notice => _notice;
  set notice(String text) {
    _notice = text;
    _noticeTimer?.cancel();
    if (text.isEmpty) return;
    _noticeTimer = Timer(noticeFor, () {
      _notice = '';
      _changed();
    });
  }

  String _notice = '';
  Timer? _noticeTimer;
  @visibleForTesting
  static Duration noticeFor = const Duration(seconds: 20);

  /// The engines Harness gives connections to as MCP servers (cli/src/lib/connectors/agents.ts).
  static const mcpEngines = {'claude', 'codex', 'opencode'};

  /// The harness in the focused pane, when it is running on an engine that reads its tools at start
  /// and is this account's to restart (a shared machine's is view-only).
  ({String machineId, Agent agent})? get focusedRestartable {
    final pane = app.focusedPane;
    final agentId = pane?.agentId;
    if (pane == null || agentId == null) return null;
    final machine = app.stateOf(pane.machineId);
    if (machine == null || machine.machine.isShared != false) return null;
    final agent = machine.agents.where((a) => a.id == agentId).firstOrNull;
    if (agent == null ||
        agent.isStopped ||
        !mcpEngines.contains(agent.engine)) {
      return null;
    }
    return (machineId: pane.machineId, agent: agent);
  }

  String? get _target => machineId ?? app.localMachineState?.machine.machineId;

  Future<Map<String, dynamic>> _ask(
    Map<String, dynamic> payload, {
    Duration timeout = const Duration(seconds: 20),
  }) async {
    final target = _target;
    if (target == null) throw StateError('This computer is not connected yet.');
    final answer = await app.connectors(target, payload, timeout: timeout);
    final failure = answer['error'];
    if (failure != null) {
      throw _Refused(
        answer['detail'] as String? ??
            (failure == 'SERVICE_UNAVAILABLE' || failure == 'UNSUPPORTED'
                ? 'Update Harness on this computer to use Connectors.'
                : 'Connections are unavailable. Try again.'),
      );
    }
    return answer;
  }

  void _changed() {
    if (!_disposed) notifyListeners();
  }

  /// [sync]: the Refresh button. The computer exchanges the account's connections first, so one made on
  /// another computer (or this computer only just added to the account) is here when it answers.
  Future<void> refresh({bool sync = false}) async {
    loading = true;
    _changed();
    try {
      // A Sync waits on the account's connections first (up to 15 s there).
      final answer = await _ask(
        {'action': 'list', if (sync) 'sync': true},
        timeout: sync
            ? const Duration(minutes: 1)
            : const Duration(seconds: 20),
      );
      cards = [
        for (final row in (answer['connections'] as List? ?? const []))
          if (row is Map) ConnectorCard.fromJson(row.cast<String, dynamic>()),
      ]..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
      signedIn = answer['signed_in'] != false;
      shared = answer['shared'] == true;
      error = null;
    } catch (e) {
      error = _message(e);
    } finally {
      loading = false;
      _changed();
    }
    // Slower (it asks Claude Code and Codex), so after the list is on screen.
    if (error == null) unawaited(refreshVia());
  }

  /// What Claude Code and Codex on that computer hold. A daemon too old to say leaves the three
  /// services to Harness alone, as before.
  Future<void> refreshVia() {
    final loading = _readVia();
    viaLoading = loading;
    return loading.whenComplete(() {
      if (viaLoading == loading) viaLoading = null;
    });
  }

  /// [refreshVia] under way: a click on Gmail before its answer waits for it ([afterChecking]),
  /// rather than going straight to Harness's own sign-in.
  Future<void>? viaLoading;

  /// The services a computer may offer through Claude Code or Codex (cli/src/lib/connectors/elsewhere.ts).
  static const wayCodes = {
    'gmail',
    'google_calendar',
    'google_drive',
    'microsoft_365',
  };

  /// Still asking whether [code] connects through Claude Code or Codex.
  bool checking(String code) =>
      viaLoading != null && wayCodes.contains(code) && !hasWays(code);

  /// Once the computer has said what its engines have: whether [code] has ways.
  Future<bool> afterChecking(String code) async {
    await viaLoading;
    return hasWays(code);
  }

  Future<void> _readVia() async {
    try {
      final answer = await _ask({'action': 'elsewhere'});
      Map<String, Map<String, String>> table(Object? raw) => {
        if (raw is Map)
          for (final MapEntry(:key, :value) in raw.entries)
            if (value is Map)
              '$key': {
                for (final MapEntry(key: k, value: v) in value.entries)
                  if (v is String) '$k': v,
              },
      };
      final said = answer['engines'];
      engines = {
        if (said is Map)
          for (final MapEntry(:key, :value) in said.entries)
            if (value == true) '$key',
      };
      via = table(answer['connections']);
      scopes = table(answer['scopes']);
      viaOnly = [
        for (final row in (answer['services'] as List? ?? const []))
          if (row is Map)
            ConnectorCard.fromJson({
              ...row.cast<String, dynamic>(),
              'state': 'not_connected',
              'auth': 'elsewhere',
            }),
      ];
      _changed();
    } catch (_) {
      // Unknown action on an older CLI, or the computer unreachable: nothing to offer through an engine.
    }
  }

  /// Connect [card] through [engine]'s own account: Codex installs its plugin first. The page the
  /// person signs in on opens in the browser; the card follows what the engine says for a few minutes.
  Future<void> connectVia(ConnectorCard card, String engine) async {
    notice = '';
    final key = '${card.code}:$engine';
    pending.add(key);
    _changed();
    try {
      final answer = await _ask({
        'action': 'connect_via',
        'connector': card.code,
        'via': engine,
      });
      final url = answer['url'] as String?;
      final who = engineName(engine);
      if (url != null && !await openInBrowser(Uri.parse(url))) {
        notice = 'Open this address to connect ${card.name} for $who: $url';
      } else {
        notice = engine == 'codex'
            ? 'Codex has the ${card.name} plugin. Connect ${card.name} in ChatGPT; Codex asks for Google sign-in the first time it uses it.'
            : 'Connect ${card.name} on claude.ai. Claude Code on this computer gets it in a moment.';
      }
    } catch (e) {
      notice = '${card.name}: ${_message(e)}';
      pending.remove(key);
      _changed();
      return;
    }
    pending.remove(key);
    await refreshVia();
    // Back from the browser: the card shows it as soon as the engine does.
    final deadline = DateTime.now().add(_signInFor);
    while (!_disposed &&
        via[card.code]?[engine] == 'not_connected' &&
        DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(pollEvery * 10);
      await refreshVia();
    }
  }

  /// Stop [engine] using [card]: Codex's plugin is removed on that computer, and the engine's
  /// account page opens, where the grant itself is ended.
  Future<void> disconnectVia(ConnectorCard card, String engine) async {
    try {
      final answer = await _ask({
        'action': 'disconnect_via',
        'connector': card.code,
        'via': engine,
      });
      final url = answer['url'] as String?;
      if (url != null) await openInBrowser(Uri.parse(url));
      notice = engine == 'codex'
          ? 'Codex stopped using ${card.name}. To end its access to your Google account, disconnect it in ChatGPT too.'
          : 'Disconnect ${card.name} on claude.ai: Claude Code follows your claude.ai account.';
    } catch (e) {
      notice = '${card.name}: ${_message(e)}';
    }
    await refreshVia();
  }

  static String engineName(String engine) => switch (engine) {
    'claude' => 'Claude',
    'codex' => 'Codex',
    _ => engine,
  };

  Future<void> connect(ConnectorCard card) async {
    notice = '';
    pending.add(card.code);
    _changed();
    try {
      final started = await _ask({'action': 'connect', 'connector': card.code});
      await _follow(card.name, started);
    } catch (e) {
      notice = '${card.name}: ${_message(e)}';
    } finally {
      pending.remove(card.code);
      await refresh();
      // Back from the browser, the link to the computer may still be coming back: the card shows the
      // new connection as soon as it answers, not on the next manual refresh.
      for (var i = 0; error != null && !_disposed && i < 5; i++) {
        await Future<void>.delayed(pollEvery);
        await refresh();
      }
    }
  }

  Future<void> _follow(String name, Map<String, dynamic> started) async {
    final url = started['authorize_url'] as String?;
    if (url != null && !await openInBrowser(Uri.parse(url))) {
      notice = 'Open this address to sign in to $name: $url';
      _changed();
    }
    final flow = started['flow'] as String?;
    if (flow == null) return;
    final deadline = DateTime.now().add(_signInFor);
    Object? lastError;
    while (!_disposed && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(pollEvery);
      final Map<String, dynamic> status;
      try {
        status = await _ask({'action': 'flow', 'flow': flow});
      } on _Refused {
        rethrow;
      } catch (e) {
        // The link to the computer can drop for a moment while the person is in the browser signing in;
        // the sign-in goes on in the daemon all the same. Ask again rather than give up on it.
        lastError = e;
        continue;
      }
      if (status['state'] == 'connected') {
        notice = '$name connected. Your agents can use it now.';
        return;
      }
      if (status['state'] == 'failed') {
        // `reason`, not `error`: a reply carrying `error` never reaches here (WsConn reads it as a failure).
        notice = '$name: ${status['reason'] ?? 'The sign-in did not finish.'}';
        return;
      }
    }
    if (lastError != null) throw lastError;
  }

  Future<void> disconnect(ConnectorCard card) async {
    try {
      await _ask({'action': 'disconnect', 'connector': card.code});
      notice = shared
          ? '${card.name} disconnected on all your computers.'
          : '${card.name} disconnected on this computer.';
    } catch (e) {
      notice = _message(e);
    }
    await refresh();
  }

  /// Add custom: null when added (or its sign-in started), else why not.
  Future<String?> addCustom(
    String name,
    String url,
    Map<String, String> headers,
  ) async {
    try {
      final started = await _ask({
        'action': 'custom',
        'name': name,
        'url': url,
        'headers': headers,
      });
      if (started['flow'] != null) {
        unawaited(
          _follow(name, started)
              .catchError((Object e) {
                notice = '$name: ${_message(e)}';
              })
              .whenComplete(refresh),
        );
      } else {
        notice = '$name added. Your agents can use it now.';
        await refresh();
      }
      return null;
    } catch (e) {
      return _message(e);
    }
  }

  static String _message(Object e) => switch (e) {
    _Refused(:final message) => message,
    StateError(:final message) => message,
    _ => 'Connections are unavailable. Try again.',
  };

  @override
  void dispose() {
    _disposed = true;
    _noticeTimer?.cancel();
    super.dispose();
  }
}

/// The computer answered, and said no: a reason to stop, unlike a request that did not get through.
class _Refused implements Exception {
  const _Refused(this.message);

  final String message;

  @override
  String toString() => message;
}
