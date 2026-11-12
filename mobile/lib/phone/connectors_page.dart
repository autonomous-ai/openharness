import 'dart:async';
import 'dart:io';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/core/models.dart' show Agent, ConnectionStatus;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'connector_icons.dart';
import 'phone_navigation.dart' show openAgent;
import 'phone_search_catalog.dart' show phoneAgentId;
import 'phone_sheet.dart';
import 'settings_row.dart';
import 'tty.dart';
import 'tty_controls.dart';

/// Settings ▸ Connectors: the account's connected services (Linear, GitHub, Notion…), for every agent
/// on every computer of the account. A connection made through one computer reaches the others: they
/// keep it the same through the backend, sealed for the account's machines (cli/src/lib/connectors/
/// vaultSync.ts). The phone picks which computer to sign in through (any online one).
///
/// Signing in happens in this phone's own browser, so Google's "Continue with Google" works:
/// - `app` services finish through the Autonomous gateway, which the computer asks on its own.
/// - Every other service redirects the browser to the computer's `http://127.0.0.1:PORT/callback`.
///   For the length of the sign-in this phone listens on that same loopback port, catches the
///   redirect, and sends it to the computer (`connectors` `callback`, over the end-to-end
///   encrypted relay). The code is useless without the PKCE verifier, which never leaves the
///   computer; the computer checks the address and state before exchanging it.
class ConnectorsPage extends StatefulWidget {
  const ConnectorsPage({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<ConnectorsPage> createState() => _ConnectorsPageState();
}

class _Card {
  _Card(Map<String, dynamic> row)
    : code = row['connector'] as String? ?? '',
      name = (row['name'] as String?)?.trim().isNotEmpty == true
          ? row['name'] as String
          : row['connector'] as String? ?? '',
      description = row['description'] as String? ?? '',
      auth = row['auth'] as String? ?? '',
      state = row['state'] as String? ?? 'not_connected',
      reason = row['reason'] as String? ?? '';

  final String code, name, description, auth, state, reason;
  bool get connected => state == 'connected';
  bool get needsAttention => state == 'reconnect' || state == 'expired';
}

class _ConnectorsPageState extends State<ConnectorsPage>
    with WidgetsBindingObserver {
  static String? _lastMachine;

  String? _machineId;
  List<_Card>? _cards;
  String _query = '';
  bool _loading = false;
  final Set<String> _busy = {};

  /// Whether [_machineId] passes a connection on to the account's other computers (`list` `shared`):
  /// one that keeps them to itself is used only when no other answers ([_pickReachable]), and the
  /// messages must not promise "all your computers" for it.
  bool _shared = false;

  /// What the last action came to, or why the list could not be read. Set through [_say].
  String _notice = '';
  Timer? _noticeTimer;

  /// How long an action's outcome stays, as on the desktop (`connectors_controller.dart`).
  static const _noticeFor = Duration(seconds: 20);

  AppNotifier get _app => widget.notifier;

  @override
  void initState() {
    super.initState();
    _app.addListener(_machinesMayHaveChanged);
    WidgetsBinding.instance.addObserver(this);
    unawaited(_pickReachable());
  }

  @override
  void dispose() {
    _noticeTimer?.cancel();
    WidgetsBinding.instance.removeObserver(this);
    _app.removeListener(_machinesMayHaveChanged);
    super.dispose();
  }

  /// Sets the notice; call inside `setState`. [fades]: an action's outcome ("Linear connected…"),
  /// gone after [_noticeFor] — a "disconnected" from an hour ago still stood there. A list that could
  /// not be read keeps its reason: with no list under it, that is all the page says.
  void _say(String text, {bool fades = false}) {
    _notice = text;
    _noticeTimer?.cancel();
    _noticeTimer = null;
    if (!fades || text.isEmpty) return;
    _noticeTimer = Timer(_noticeFor, () {
      if (mounted) setState(() => _notice = '');
    });
  }

  /// Back from the browser (or from anywhere): a sign-in may have finished while this page was
  /// hidden, so read the connections again rather than wait for a pull.
  @override
  void didChangeAppLifecycleState(AppLifecycleState state) {
    if (state == AppLifecycleState.resumed && !_loading) unawaited(_refresh());
  }

  /// Opened before the account's computers were read (the app just started, the network slow): look
  /// again once one is there, instead of saying none is online until a pull.
  void _machinesMayHaveChanged() {
    if (_machineId == null && !_loading && _app.connectorMachines.isNotEmpty) {
      unawaited(_pickReachable());
    }
  }

  /// The computers to sign in through, the one used last first, then those connected now: with the
  /// connections the same on every computer, any that answers will do.
  List<String> get _candidates {
    final machines = [..._app.connectorMachines]
      ..sort((a, b) {
        int rank(MachineState m) => m.machine.machineId == _lastMachine
            ? 0
            : m.connectionStatus == ConnectionStatus.connected
            ? 1
            : 2;
        return rank(a).compareTo(rank(b));
      });
    return [for (final m in machines) m.machine.machineId];
  }

  /// The first computer that lists its connections and shares them with the others (`shared`); one
  /// that keeps them to itself (an older Harness) only when no other answers. None answering is said
  /// once, not per computer.
  Future<void> _pickReachable() async {
    setState(() => _loading = true);
    String? fallback;
    Map<String, dynamic>? fallbackReply;
    void use(String machineId, Map<String, dynamic> reply) {
      setState(() {
        _machineId = machineId;
        _lastMachine = machineId;
        _say('');
      });
      _show(reply);
    }

    for (final machineId in _candidates) {
      final reply = await _app.connectors(machineId, {
        'action': 'list',
      }, timeout: const Duration(seconds: 8));
      if (!mounted) return;
      if (reply['error'] != null) continue;
      if (reply['shared'] == true) return use(machineId, reply);
      fallback ??= machineId;
      fallbackReply ??= reply;
    }
    if (fallback != null) return use(fallback, fallbackReply!);
    setState(() {
      _loading = false;
      _machineId = null;
      _cards = null;
    });
  }

  void _show(Map<String, dynamic> reply) {
    setState(() {
      _loading = false;
      _shared = reply['shared'] == true;
      _cards = (reply['connections'] as List? ?? const [])
          .whereType<Map>()
          .map((row) => _Card(row.cast<String, dynamic>()))
          .toList();
      // What this computer's Claude Code and Codex said is laid on the new list at once: in its
      // order, with Microsoft 365, not the computer's order for the seconds until they answer again.
      final machineId = _machineId;
      final said = machineId == null || _viaFrom != machineId
          ? null
          : _viaSaid[_app]?[machineId];
      if (said != null) _applyVia(machineId!, said);
    });
    // Slower (the computer asks its Claude Code and Codex), so after the list is on screen.
    unawaited(_loadVia());
  }

  /// The engines [_machineId] has that connect Gmail, Calendar and Drive through their own account
  /// (`connectors` `elsewhere`, cli/src/lib/connectors/elsewhere.ts): only those are offered.
  Set<String> _engines = const {};

  /// Per service, its state through each engine: `connected`, `reconnect`, `installed` (Codex), `not_connected`.
  Map<String, Map<String, String>> _via = const {};

  /// Per service, what each way lets an agent do (`claude`, `codex`, `harness`).
  Map<String, Map<String, String>> _scopes = const {};

  /// Per service Codex splits (Microsoft 365), each of its plugins (`elsewhere` `parts`): ChatGPT
  /// connects each on its own, so each is offered on its own. An older computer says none.
  Map<String, List<_Part>> _parts = const {};

  /// Per service, its own page in each engine's account (`elsewhere` `pages`): claude.ai's connector,
  /// or the Codex plugin's page on ChatGPT, where an account is added once it is in.
  Map<String, Map<String, String>> _pages = const {};

  /// The computer [_engines], [_via] and [_scopes] were read from. Another computer starts with
  /// none of them: what one computer has is never shown as another's.
  String? _viaFrom;

  void _forgetVia() {
    _engines = const {};
    _via = const {};
    _scopes = const {};
    _parts = const {};
    _pages = const {};
    _viaFrom = null;
    _cards = _cards?.where((c) => c.auth != _viaOnly).toList();
  }

  static const _engineNames = {'claude': 'Claude', 'codex': 'Codex'};

  bool _hasWays(String code) =>
      _via[code]?.keys.any(_engines.contains) ?? false;

  bool _onVia(String code) =>
      _via[code]?.entries.any(
        // Codex's plugin installed counts: whether its account is signed in is ChatGPT's to know, and the
        // person chose to read installed as in.
        (e) => _engines.contains(e.key) && e.value != 'not_connected',
      ) ??
      false;

  /// The services a computer may offer through Claude Code or Codex (cli/src/lib/connectors/elsewhere.ts).
  static const _wayCodes = {
    'gmail',
    'google_calendar',
    'google_drive',
    'microsoft_365',
  };

  /// [_readVia] under way, for a tap that comes before its answer.
  Future<void>? _viaLoading;

  /// Still asking whether [card] connects through Claude Code or Codex: its row says so, and a tap
  /// waits for the answer rather than going straight to Harness's own sign-in.
  bool _checking(_Card card) =>
      _viaLoading != null &&
      _wayCodes.contains(card.code) &&
      !_hasWays(card.code);

  /// A tap on [card] before the computer said what its engines have: once it has, the ways if
  /// there are any, else what the tap would have done ([otherwise]).
  Future<void> _afterChecking(_Card card, VoidCallback? otherwise) async {
    await _viaLoading;
    if (!mounted) return;
    if (_hasWays(card.code)) return _chooseWay(card);
    otherwise?.call();
  }

  Future<void> _loadVia() {
    final loading = _readVia();
    // A block, not `=>`: assigned through an arrow, the Future is what the callback returns, and
    // setState throws on that.
    setState(() {
      _viaLoading = loading;
    });
    return loading.whenComplete(() {
      if (mounted && _viaLoading == loading) {
        setState(() => _viaLoading = null);
      }
    });
  }

  /// Each computer's last `elsewhere` answer, by machine id, for as long as the app runs: the page
  /// opened again shows Gmail through Claude Code where it was at once, not after the seconds the
  /// computer takes to ask Claude Code and Codex again. Kept on the app's notifier, not in a static, so
  /// two notifiers (two tests) never share one.
  static final _viaSaid = Expando<Map<String, Map<String, dynamic>>>();

  Future<void> _readVia() async {
    final machineId = _machineId;
    if (machineId == null) return;
    if (_viaFrom != machineId) {
      final said = _viaSaid[_app]?[machineId];
      setState(() {
        _forgetVia();
        if (said != null) _applyVia(machineId, said);
      });
    }
    final reply = await _app.connectors(machineId, {
      'action': 'elsewhere',
    }, timeout: const Duration(seconds: 60));
    if (!mounted || machineId != _machineId) return;
    // No answer this time (the computer restarting, a slow line): what it said last stands, or a
    // connection through Claude Code would drop out of the list until the next read. Another computer
    // was already forgotten above; an older Harness there never said anything.
    if (reply['error'] != null) return;
    (_viaSaid[_app] ??= {})[machineId] = reply;
    setState(() => _applyVia(machineId, reply));
  }

  /// Each way a service is in by through an engine, as `engine:service` (and `:plugin` for a part).
  Set<String> _waysIn() => {
    for (final MapEntry(key: code, value: states) in _via.entries)
      for (final MapEntry(key: engine, value: state) in states.entries)
        if (state == 'connected' || state == 'installed') '$engine:$code',
    for (final MapEntry(key: code, value: parts) in _parts.entries)
      for (final part in parts)
        if (part.state == 'installed') 'codex:$code:${part.plugin}',
  };

  /// [reply], what [machineId] said its Claude Code and Codex hold, as the page's state. In a setState.
  void _applyVia(String machineId, Map<String, dynamic> reply) {
    Map<String, Map<String, String>> table(Object? raw) => {
      if (raw is Map)
        for (final MapEntry(:key, :value) in raw.entries)
          if (value is Map)
            '$key': {
              for (final MapEntry(key: k, value: v) in value.entries)
                if (v is String) '$k': v,
            },
    };
    // What was in before, on this same computer: a way that comes in since is a new connection.
    final wasIn = _viaFrom == machineId ? _waysIn() : null;
    final said = reply['engines'];
    _engines = {
      if (said is Map)
        for (final MapEntry(:key, :value) in said.entries)
          if (value == true) '$key',
    };
    _via = table(reply['connections']);
    _scopes = table(reply['scopes']);
    _pages = table(reply['pages']);
    _parts = {
      if (reply['parts'] case final Map raw)
        for (final MapEntry(:key, :value) in raw.entries)
          if (value is List)
            '$key': [
              for (final part in value)
                if (part case {
                  'plugin': final String plugin,
                  'name': final String name,
                })
                  (
                    plugin: plugin,
                    name: name,
                    state: part['state'] is String
                        ? part['state'] as String
                        : 'not_connected',
                    page: part['page'] is String
                        ? part['page'] as String
                        : null,
                    icon: part['icon'] is String
                        ? part['icon'] as String
                        : null,
                  ),
            ],
    };
    _viaFrom = machineId;
    // An agent already running reads a new connector only when it starts again, and only its own
    // engine's: a Claude connection is nothing to a Codex session. Only once it is in, not when its
    // sign-in page opens (left unfinished, there is nothing to restart for).
    if (wasIn != null) {
      final cameIn = {
        for (final way in _waysIn().difference(wasIn)) way.split(':').first,
      };
      if (cameIn.contains(_lastOpened?.$2.engine)) _restartGlow = true;
    }
    // Services only an engine connects (Microsoft 365): a card of their own where the computer has
    // an engine for them. Added once, after the computer's own list.
    final cards = [...?_cards?.where((c) => c.auth != _viaOnly)];
    for (final row in (reply['services'] as List? ?? const [])) {
      if (row is! Map) continue;
      final card = _Card({
        ...row.cast<String, dynamic>(),
        'auth': _viaOnly,
        'state': 'not_connected',
      });
      if (_hasWays(card.code) && !cards.any((c) => c.code == card.code)) {
        cards.add(card);
      }
    }
    _cards = cards
      ..sort((a, b) => a.name.toLowerCase().compareTo(b.name.toLowerCase()));
  }

  /// The `auth` of a card the computer's Harness list does not have: only an engine connects it.
  static const _viaOnly = 'elsewhere';

  /// What a service with ways shows under its name: a chip for each way it is in by, as the
  /// desktop's card does (✓ Claude, ✓ Codex; amber for one to sign in to again). Null when none.
  Widget? _waysChips(_Card card) {
    final chips = [
      for (final MapEntry(key: engine, value: name) in _engineNames.entries)
        if (_engines.contains(engine))
          switch (_via[card.code]?[engine]) {
            'connected' || 'installed' => ('✓ $name', false),
            'reconnect' => ('$name · Reconnect', true),
            _ => null,
          },
      if (card.connected) ('✓ Harness', false),
      if (card.needsAttention) ('Harness · Reconnect', true),
    ].nonNulls;
    if (chips.isEmpty) return null;
    return Wrap(
      spacing: 6,
      runSpacing: 4,
      children: [
        for (final (text, again) in chips)
          Builder(
            builder: (context) {
              final color = again
                  ? AppPalette.warn
                  : AppPalette.accentOnSurface;
              return Container(
                padding: const EdgeInsets.symmetric(horizontal: 7, vertical: 2),
                decoration: BoxDecoration(
                  color: color.withValues(alpha: 0.16),
                  borderRadius: BorderRadius.circular(6),
                ),
                child: Text(
                  text,
                  style: TextStyle(
                    color: color,
                    fontSize: 12,
                    fontWeight: AppFont.semibold,
                  ),
                ),
              );
            },
          ),
      ],
    );
  }

  /// Gmail, Calendar or Drive: through the computer's Claude Code or Codex (only those it has), or
  /// Harness's own sign-in, each with what it lets an agent do.
  void _chooseWay(_Card card) {
    final scope = _scopes[card.code] ?? const {};
    // What a tap does, not what the state is: on a way already in, a tap takes it out.
    String status(String? state) => switch (state) {
      'connected' || 'installed' => 'Remove',
      'reconnect' => 'Reconnect',
      _ => 'Connect',
    };
    // What the way is in by, beside its name, as the desktop's rows say it.
    String? label(String? state) => switch (state) {
      'connected' => '✓ Connected',
      'installed' => '✓ Installed',
      'reconnect' => 'Needs sign-in again',
      _ => null,
    };
    // A way that is in offers its own page in that engine's account, where an account is added.
    String? openable(String? state, String? page) =>
        state == 'connected' || state == 'installed' ? page : null;
    const who = {
      'claude': 'Only Claude Code on the same Claude account',
      'codex': 'Only Codex on the same ChatGPT account',
    };
    final ways =
        <
          ({
            String key,
            String title,
            String detail,
            String value,
            String? label,
            VoidCallback? act,
            String? page,
            // A part of an engine's way (one of Codex's plugins): its icon's code, drawn under the engine.
            String? mark,
          })
        >[
          for (final MapEntry(key: engine, value: name) in _engineNames.entries)
            // ChatGPT connects each of a split service's plugins on its own, so each is a way of its own.
            if (_engines.contains(engine) &&
                engine == 'codex' &&
                _parts[card.code] != null)
              for (final part in _parts[card.code]!)
                (
                  key: 'codex-${part.plugin}',
                  title: part.name,
                  detail: '',
                  value: _busy.contains('${card.code}:$engine:${part.plugin}')
                      ? 'Installing…'
                      : status(part.state),
                  label: label(part.state),
                  act: part.state == 'installed'
                      ? () => unawaited(_disconnectVia(card, engine, part))
                      : () => unawaited(_connectVia(card, engine, part)),
                  page: openable(part.state, part.page),
                  mark: part.icon ?? card.code,
                )
            else if (_engines.contains(engine))
              (
                key: engine,
                title: name,
                detail: [?scope[engine], who[engine]!].join('\n'),
                value: _busy.contains('${card.code}:$engine')
                    ? (engine == 'codex' ? 'Installing…' : 'Working…')
                    : status(_via[card.code]?[engine]),
                label: label(_via[card.code]?[engine]),
                act: switch (_via[card.code]?[engine]) {
                  'connected' ||
                  'installed' => () => unawaited(_disconnectVia(card, engine)),
                  _ => () => unawaited(_connectVia(card, engine)),
                },
                page: openable(
                  _via[card.code]?[engine],
                  _pages[card.code]?[engine],
                ),
                mark: null,
              ),
          // Not for a service only an engine connects (Microsoft 365).
          if (scope.isEmpty || scope.containsKey('harness'))
            (
              key: 'harness',
              title: 'Harness',
              detail: '${scope['harness'] ?? card.description}\nAll agents',
              value: card.reason.isNotEmpty && !card.connected
                  ? card.reason
                  : card.needsAttention
                  ? 'Reconnect'
                  : card.connected
                  ? 'Remove'
                  : 'Connect',
              label: card.connected
                  ? '✓ Connected'
                  : card.needsAttention
                  ? 'Needs sign-in again'
                  : null,
              act:
                  !(card.connected ||
                      card.needsAttention ||
                      card.reason.isEmpty)
                  ? null
                  : card.connected
                  ? () => unawaited(_disconnect(card))
                  : () => unawaited(_connect(card)),
              page: null,
              mark: null,
            ),
        ];
    final route = phoneSheetRoute<void>(
      context,
      builder: (sheet) => SafeArea(
        child: SingleChildScrollView(
          padding: const EdgeInsets.fromLTRB(16, 18, 16, 16),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Connect ${card.name}',
                style: TextStyle(
                  color: AppPalette.textPrimary,
                  fontSize: 18,
                  fontWeight: AppFont.semibold,
                ),
              ),
              const SizedBox(height: 4),
              Text(
                'Pick who gets it. Each way has its own limits.',
                style: TextStyle(color: AppPalette.textSecondary, fontSize: 14),
              ),
              const SizedBox(height: 14),
              // One bordered card per way, apart from each other: in one card they read as a
              // paragraph.
              for (final (i, way) in ways.indexed) ...[
                // The first of an engine's parts: the engine above them, once.
                if (way.mark != null && (i == 0 || ways[i - 1].mark == null))
                  Padding(
                    key: const Key('connector-way-codex'),
                    padding: const EdgeInsets.fromLTRB(4, 2, 4, 8),
                    child: Row(
                      children: [
                        Icon(
                          LucideIcons.bot300,
                          size: 22,
                          color: AppPalette.textSecondary,
                        ),
                        const SizedBox(width: 12),
                        Expanded(
                          child: Column(
                            crossAxisAlignment: CrossAxisAlignment.start,
                            children: [
                              Text(
                                'Codex',
                                style: TextStyle(
                                  color: AppPalette.textPrimary,
                                  fontSize: 16,
                                  fontWeight: AppFont.semibold,
                                ),
                              ),
                              Text(
                                who['codex']!,
                                style: TextStyle(
                                  color: AppPalette.textFaint,
                                  fontSize: 12.5,
                                ),
                              ),
                            ],
                          ),
                        ),
                      ],
                    ),
                  ),
                _WayCard(
                  key: Key('connector-way-${way.key}'),
                  icon: way.key == 'harness'
                      ? LucideIcons.plug300
                      : LucideIcons.bot300,
                  mark: way.mark,
                  status: way.label,
                  fill: switch (way.value) {
                    'Connect' || 'Reconnect' => AppPalette.accent,
                    'Remove' => AppPalette.dangerFill,
                    _ => null,
                  },
                  title: way.title,
                  detail: way.detail,
                  value: way.value,
                  onTap: way.act == null
                      ? null
                      : () {
                          Navigator.of(sheet).pop();
                          way.act!();
                        },
                  onOpen: switch (way.page) {
                    final page? => () {
                      Navigator.of(sheet).pop();
                      unawaited(_openEngine(way.key, page));
                    },
                    null => null,
                  },
                ),
                const SizedBox(height: 10),
              ],
              const SizedBox(height: 10),
              Text(
                'Company account? Your admin may need to allow it.',
                style: TextStyle(color: AppPalette.textFaint, fontSize: 13),
              ),
            ],
          ),
        ),
      ),
    );
    unawaited(Navigator.of(context, rootNavigator: true).push(route));
  }

  /// Through [engine]'s own account: the computer installs Codex's plugin first, then the page to
  /// connect it on opens here, in this phone's browser (the connection is the account's, not a
  /// computer's).
  Future<void> _connectVia(_Card card, String engine, [_Part? part]) async {
    final machineId = _machineId;
    final key = '${card.code}:$engine${part == null ? '' : ':${part.plugin}'}';
    final name = part?.name ?? card.name;
    if (machineId == null || _busy.contains(key)) return;
    setState(() {
      _busy.add(key);
      _say(
        engine == 'codex'
            ? 'Installing the $name plugin in Codex on ${_machineName(machineId)}…'
            : '',
      );
    });
    // ChatGPT's page opens once the plugin is installed, not before: the plugin is the ChatGPT account's
    // (`codex plugin add` installs it there), so until then its page has nothing to sign in to. Meanwhile
    // the row says "Installing…".
    final reply = await _app.connectors(machineId, {
      'action': 'connect_via',
      'connector': card.code,
      'via': engine,
      'plugin': ?part?.plugin,
    }, timeout: const Duration(seconds: 150));
    if (!mounted) return;
    final url = reply['url'] as String?;
    if (reply['error'] != null || url == null) {
      setState(() {
        _busy.remove(key);
        _say('$name: ${_failure(reply)}', fades: true);
      });
      return;
    }
    final opened = await _openEngine(engine, url);
    if (!mounted) return;
    setState(() {
      _busy.remove(key);
      _say(
        !opened
            ? 'Open $url to connect $name.'
            : engine == 'codex'
            ? 'Codex has the $name plugin. Connect $name in ChatGPT; Codex asks for sign-in the first time it uses it.'
            : 'Connect $name on claude.ai. Claude Code on ${_machineName(machineId)} gets it in a moment.',
        fades: true,
      );
    });
    await _loadVia();
  }

  /// The computer is installing [card]'s Codex plugin ([_connectVia]): its row says so, the whole time.
  bool _installing(_Card card) => _busy.contains('${card.code}:codex');

  /// [url], where [engine]'s connectors are managed, in a browser tab of this app's own, as Harness's
  /// sign-in opens. The web, not the engine's app: handed to the system, a claude.ai or chatgpt.com
  /// address opens the Claude or ChatGPT app, and neither app takes an address for one service (the
  /// Claude app's `claude://` links reach its Connectors list at most), where the web opens Gmail's own.
  ///
  /// A browser tab still hands the app an address it claims: the Claude Android app claims
  /// `claude.ai/new`, the connectors' page there, so an older computer's `/new#…` is sent as `/new/#…`,
  /// which it does not claim and the web sends on to `/new` (cli/src/lib/connectors/elsewhere.ts).
  Future<bool> _openEngine(String engine, String url) {
    var uri = Uri.parse(url);
    if (uri.host == 'claude.ai' && uri.path == '/new') {
      uri = uri.replace(path: '/new/');
    }
    return launchUrl(uri, mode: LaunchMode.inAppBrowserView);
  }

  /// Remove [engine]'s way to [card], or one [part] of it. Codex's plugin is removed on the computer,
  /// and that is all: no page opens (one nobody asked for, on every Remove, was in the way,
  /// 2026-11-12). Claude's connector is claude.ai's, which neither Claude Code nor Harness can take
  /// out (`claude mcp remove` knows only the computer's own servers): its page opens there.
  Future<void> _disconnectVia(_Card card, String engine, [_Part? part]) async {
    if (engine == 'claude') {
      if (_pages[card.code]?['claude'] case final page?) {
        await _openEngine(engine, page);
      }
      if (mounted) {
        setState(
          () => _say('Disconnect ${card.name} on claude.ai.', fades: true),
        );
      }
      return;
    }
    final machineId = _machineId;
    final name = part?.name ?? card.name;
    if (machineId == null) return;
    final reply = await _app.connectors(machineId, {
      'action': 'disconnect_via',
      'connector': card.code,
      'via': engine,
      'plugin': ?part?.plugin,
    }, timeout: const Duration(seconds: 90));
    if (!mounted) return;
    setState(
      () => _say(
        reply['error'] != null
            ? '$name: ${_failure(reply)}'
            : 'Codex stopped using $name.',
        fades: true,
      ),
    );
    await _loadVia();
  }

  String _machineName(String? id) {
    final machine = id == null ? null : _app.machineStates[id];
    return machine?.machine.displayName ?? 'No computer';
  }

  /// [sync]: the reload button, or a pull. The computer exchanges the account's connections first, so one
  /// made on another computer (or this computer only just added to the account) is listed.
  Future<void> _refresh({bool sync = false}) async {
    final machineId = _machineId;
    if (machineId == null) return _pickReachable();
    setState(() => _loading = true);
    // A Sync waits on the account's connections first (up to 15 s there).
    final reply = await _app.connectors(
      machineId,
      {'action': 'list', if (sync) 'sync': true},
      timeout: sync ? const Duration(minutes: 1) : const Duration(seconds: 30),
    );
    if (!mounted || machineId != _machineId) return;
    // The computer went away: another that answers will do.
    if (reply['error'] == 'UNAVAILABLE') return _pickReachable();
    if (reply['error'] != null) {
      setState(() {
        _loading = false;
        _cards = null;
        _say(_failure(reply));
      });
      return;
    }
    _show(reply);
  }

  /// Sync connections under way.
  bool _syncing = false;

  /// The Sync row: the computer gets the account's connections, gives its agents their entries, and
  /// says what it now holds.
  Future<void> _syncNow() async {
    final machineId = _machineId;
    if (machineId == null || _syncing) return;
    setState(() {
      _syncing = true;
      _say('');
    });
    var done = false;
    try {
      await _refresh(sync: true);
      done = true;
    } finally {
      // Whatever went wrong, the row stops spinning.
      if (mounted) setState(() => _syncing = false);
    }
    if (!mounted || !done) return;
    setState(() {
      if (_notice.isNotEmpty || machineId != _machineId) return;
      final held = _cards?.where((c) => c.connected).length ?? 0;
      _say(
        held == 0
            ? 'Synced ${_machineName(machineId)}: no connections there yet.'
            : 'Synced ${_machineName(machineId)}: $held '
                  '${held == 1 ? 'connection' : 'connections'}, added to the '
                  'agents installed there. Restart an agent '
                  'already running to use them.',
        fades: true,
      );
    });
  }

  String _failure(Map<String, dynamic> reply) {
    final detail = reply['detail'] as String?;
    if (detail != null && detail.isNotEmpty) return detail;
    return switch (reply['error']) {
      'OWNER_REQUIRED' =>
        'Only the owner of this computer can connect its services.',
      'UNAVAILABLE' => 'This computer cannot be reached now.',
      _ =>
        'Connections are unavailable on this computer. Update Harness there.',
    };
  }

  void _pickMachine() {
    final machines = _app.connectorMachines;
    unawaited(
      showPhoneSheet(
        context,
        title: 'Sign in through',
        actions: [
          for (final machine in machines)
            PhoneSheetAction(
              icon: machine.machine.machineId == _machineId
                  ? LucideIcons.check300
                  : LucideIcons.monitor300,
              label: machine.machine.displayName,
              onTap: () {
                setState(() {
                  _machineId = machine.machine.machineId;
                  _lastMachine = _machineId;
                  _cards = null;
                  _say('');
                });
                unawaited(_refresh());
              },
            ),
        ],
      ),
    );
  }

  Future<void> _connect(_Card card) async {
    final machineId = _machineId;
    if (machineId == null || _busy.contains(card.code)) return;
    setState(() {
      _busy.add(card.code);
      _say('');
    });
    HttpServer? loopback;
    try {
      final started = await _app.connectors(machineId, {
        'action': 'connect',
        'connector': card.code,
      });
      if (started['error'] != null) throw _Notice(_failure(started));
      final flow = started['flow'] as String? ?? '';
      final address = started['authorize_url'] as String?;
      if (address != null) {
        final authorize = Uri.parse(address);
        final redirect = Uri.tryParse(
          authorize.queryParameters['redirect_uri'] ?? '',
        );
        if (card.auth != 'app' && redirect != null && _loopback(redirect)) {
          loopback = await _catchRedirect(machineId, flow, redirect);
        }
        final opened = await launchUrl(
          authorize,
          mode: LaunchMode.inAppBrowserView,
        );
        if (!opened) throw _Notice('Could not open the browser.');
      }
      final outcome = await _follow(machineId, flow, card.name);
      if (!mounted) return;
      setState(() => _say(outcome, fades: true));
    } on _Notice catch (notice) {
      if (mounted) setState(() => _say(notice.text, fades: true));
    } finally {
      await loopback?.close(force: true);
      if (mounted) setState(() => _busy.remove(card.code));
    }
    await _refresh();
  }

  static bool _loopback(Uri uri) =>
      uri.scheme == 'http' &&
      (uri.host == '127.0.0.1' || uri.host == 'localhost') &&
      uri.hasPort &&
      uri.path == '/callback';

  /// Listens on the computer's redirect port here, on this phone, while the browser signs in.
  Future<HttpServer> _catchRedirect(
    String machineId,
    String flow,
    Uri redirect,
  ) async {
    final HttpServer server;
    try {
      server = await HttpServer.bind(
        InternetAddress.loopbackIPv4,
        redirect.port,
      );
    } on SocketException {
      throw _Notice(
        'Port ${redirect.port} is busy on this phone. Close other apps and try again.',
      );
    }
    server.listen((request) async {
      if (request.uri.path != '/callback') {
        request.response.statusCode = HttpStatus.notFound;
        await request.response.close();
        return;
      }
      // The browser is answered at once and closed: while it covers the app the phone's line to the
      // computer is often down, so the code goes over once the app is back in front.
      request.response
        ..statusCode = HttpStatus.ok
        ..headers.contentType = ContentType.html
        ..headers.set('Cache-Control', 'no-store')
        ..write(
          '<!doctype html><meta charset=utf-8>'
          '<meta name=viewport content="width=device-width,initial-scale=1">'
          '<title>Harness</title>'
          "<body style='font:16px ui-monospace,monospace;background:#11140f;color:#e7e8de;padding:32px'>"
          '<h1>Signed in.</h1><p>Return to Harness to finish.</p>',
        );
      await request.response.close();
      unawaited(closeInAppWebView().catchError((_) {}));
      unawaited(
        _deliver(
          machineId,
          flow,
          redirect.replace(query: request.uri.query).toString(),
        ),
      );
    });
    return server;
  }

  /// Hands the caught redirect to the computer, again and again while the phone cannot reach it.
  Future<void> _deliver(String machineId, String flow, String url) async {
    final deadline = DateTime.now().add(const Duration(minutes: 2));
    while (DateTime.now().isBefore(deadline)) {
      final reply = await _app.connectors(machineId, {
        'action': 'callback',
        'flow': flow,
        'url': url,
      });
      if (reply['error'] != 'UNAVAILABLE') return;
      await Future<void>.delayed(const Duration(seconds: 2));
    }
  }

  /// The computer finishes the sign-in on its own; this follows it for up to six minutes. [name] is
  /// the service's, for the desktop's words when it is done.
  Future<String> _follow(String machineId, String flow, String name) async {
    final deadline = DateTime.now().add(const Duration(minutes: 6));
    while (mounted && DateTime.now().isBefore(deadline)) {
      await Future<void>.delayed(const Duration(seconds: 1));
      final reply = await _app.connectors(machineId, {
        'action': 'flow',
        'flow': flow,
      });
      // Unreachable is not an answer: the line drops while the browser covers the app, and the
      // sign-in goes on without it.
      if (reply['error'] == 'UNAVAILABLE') continue;
      if (reply['error'] != null) return _failure(reply);
      switch (reply['state']) {
        // The desktop's words (`connectors_controller.dart`): no "on all your computers", which a
        // computer that keeps its connections to itself ([_shared] false) would not make true.
        case 'connected':
          // An agent already running gets the new tools only on a restart: its row says so.
          if (mounted) setState(() => _restartGlow = true);
          return '$name connected. Your agents can use it now.';
        case 'failed':
          return reply['reason'] as String? ??
              'The sign-in did not finish. Try again.';
      }
    }
    return 'The sign-in was not finished in time.';
  }

  /// The engines Harness gives connections to as MCP servers (cli/src/lib/connectors/agents.ts).
  static const _mcpEngines = {'claude', 'codex', 'opencode'};

  /// The harness last opened on this phone, when it is running on an engine that reads its tools
  /// at start: the one a new connection is most likely meant for, restarted by the page's button.
  /// This phone's own visits ([AppNotifier.searchHistory]), the order Hold-the-title follows.
  (String, Agent)? get _lastOpened {
    final running = {
      for (final machine in _app.connectorMachines)
        for (final agent in machine.agents)
          if (!agent.isStopped && _mcpEngines.contains(agent.engine))
            phoneAgentId(machine.machine.machineId, agent.id): (
              machine.machine.machineId,
              agent,
            ),
    };
    for (final id in _app.searchHistory.recent) {
      final hit = running[id];
      if (hit != null) return hit;
    }
    return null;
  }

  /// A restart takes seconds and the daemon queues each one it is sent: tapped twice, the harness
  /// restarted twice, one after the other. Static: the page is gone by the time it finishes.
  static final Set<String> _restarting = {};

  /// Opens the harness, then restarts it there, so the person watches it come back with its new
  /// tools. The page closes on the way (the shell opens an agent at its root), so a failure is told
  /// in a snack bar rather than here.
  /// A connection was just made: the Restart row pulses amber until it is used.
  bool _restartGlow = false;

  void _restartThere((String, Agent) target) {
    setState(() => _restartGlow = false);
    final (machineId, agent) = target;
    final key = phoneAgentId(machineId, agent.id);
    if (!_restarting.add(key)) return;
    final messenger = ScaffoldMessenger.maybeOf(context);
    openAgent(context, _app, machineId, agent.id);
    unawaited(
      _app
          .restartAgent(machineId, agent.id)
          .then((result) {
            final error = result.error;
            if (error != null) {
              messenger?.showSnackBar(SnackBar(content: Text(error)));
            }
          })
          .whenComplete(() => _restarting.remove(key)),
    );
  }

  void _manage(_Card card) {
    unawaited(
      showPhoneSheet(
        context,
        title: card.name,
        actions: [
          if (card.needsAttention)
            PhoneSheetAction(
              icon: LucideIcons.refreshCw300,
              label: 'Connect again',
              onTap: () => unawaited(_connect(card)),
            ),
          PhoneSheetAction(
            icon: LucideIcons.unplug300,
            label: 'Disconnect',
            destructive: true,
            onTap: () => unawaited(_disconnect(card)),
          ),
        ],
      ),
    );
  }

  /// Where a connection made or taken away through [_machineId] reaches: every computer of the
  /// account, or that one alone ([_shared]).
  String get _where =>
      _shared ? 'all your computers' : _machineName(_machineId);

  /// Asked first, as on the desktop (`connectors_section.dart`): it takes the account from the
  /// agents at once, and the service itself still trusts it until revoked there.
  Future<void> _disconnect(_Card card) async {
    final machineId = _machineId;
    if (machineId == null) return;
    // Read before the question and kept after it: the answer is about the computer it named, even if
    // the page moved to another while it was up (back in front, it looks for one that answers).
    final where = _where;
    final confirmed = await confirmPhoneAction(
      context,
      // The sheet row's own icon — see [confirmPhoneAction].
      icon: LucideIcons.unplug300,
      title: 'Disconnect ${card.name}?',
      message:
          'Agents on $where stop using this account. To revoke it everywhere, use the '
          'service’s settings.',
      confirmLabel: 'Disconnect',
    );
    if (!confirmed || !mounted) return;
    final reply = await _app.connectors(machineId, {
      'action': 'disconnect',
      'connector': card.code,
    });
    if (!mounted) return;
    setState(
      () => _say(
        reply['error'] != null
            ? _failure(reply)
            : '${card.name} disconnected on $where.',
        fades: true,
      ),
    );
    await _refresh();
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final cards = _cards;
    final lastOpened = _lastOpened;
    final query = _query.toLowerCase();
    bool shown(_Card card) =>
        query.isEmpty ||
        card.name.toLowerCase().contains(query) ||
        card.description.toLowerCase().contains(query);
    // Connected through Harness, or through the computer's Claude Code or Codex.
    bool on(_Card c) => c.connected || c.needsAttention || _onVia(c.code);
    final connected = [...?cards?.where((c) => on(c) && shown(c))];
    final available = [...?cards?.where((c) => !on(c) && shown(c))];
    return Scaffold(
      backgroundColor: tty.ground,
      // PhoneShell's Scaffold already makes room for the keyboard, and the MediaQuery it hands down
      // still carries the inset: taking it again here shrank the list to nothing under the field.
      resizeToAvoidBottomInset: false,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            // Pushed from Settings ▸ Connectors: back above the title, fixed while the list scrolls,
            // as Settings and Computers have it when pushed.
            Align(
              alignment: Alignment.centerLeft,
              child: TtyBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
            ),
            Expanded(
              child: RefreshIndicator(
                onRefresh: _refresh,
                child: ListView(
                  padding: EdgeInsets.fromLTRB(
                    Tty.origin,
                    8,
                    Tty.origin,
                    MediaQuery.paddingOf(context).bottom + 24,
                  ),
                  children: [
                    const TtyText(
                      'Connectors',
                      size: TtySize.display,
                      weight: FontWeight.w600,
                    ),
                    const SizedBox(height: 4),
                    Text(
                      'Sign in once: every computer of your account gets it.',
                      style: tty.style(color: tty.dim),
                    ),
                    if (_notice.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      Text(_notice, style: tty.style(color: tty.dim)),
                    ],
                    // One card for what acts on the page as a whole: which computer, Sync, and the
                    // restart a running agent needs. Each row one line of detail, so the list starts
                    // high on the screen.
                    if (_machineId != null || lastOpened != null) ...[
                      const SizedBox(height: 12),
                      SettingsGroup(
                        children: [
                          // Which computer signs in matters only when it cannot: any of them gets the
                          // connection.
                          if (_app.connectorMachines.length > 1 &&
                              _machineId != null)
                            SettingsRow(
                              key: const Key('connectors-computer'),
                              leading: const Icon(
                                LucideIcons.monitor300,
                                size: 20,
                              ),
                              title: _machineName(_machineId),
                              detail: 'The machine this page signs in through',
                              value: 'Change',
                              onTap: _pickMachine,
                            ),
                          if (_machineId != null)
                            SettingsRow(
                              key: const Key('connectors-sync'),
                              leading: _syncing
                                  ? const SizedBox(
                                      width: 20,
                                      height: 20,
                                      child: CircularProgressIndicator(
                                        strokeWidth: 2,
                                      ),
                                    )
                                  : const Icon(
                                      LucideIcons.cloudDownload300,
                                      size: 20,
                                    ),
                              title: _syncing ? 'Syncing…' : 'Sync connections',
                              detail: 'Get them from your other computers, add them to its agents',
                              onTap: _syncing
                                  ? null
                                  : () => unawaited(_syncNow()),
                            ),
                          // Agents read their tools when they start: one already running gets a
                          // connection made since only on a restart.
                          if (lastOpened != null)
                            _Pulse(
                              active: _restartGlow,
                              child: SettingsRow(
                                key: const Key('connectors-restart'),
                                leading: Icon(
                                  LucideIcons.refreshCw300,
                                  size: 20,
                                  color: _restartGlow ? AppPalette.warn : null,
                                ),
                                title: 'Restart "${lastOpened.$2.displayName}"',
                                detail: _restartGlow
                                    ? 'New connection: restart to use it'
                                    : 'To use new tools from connectors',
                                onTap: () => _restartThere(lastOpened),
                              ),
                            ),
                        ],
                      ),
                    ],
                    if (cards == null && _loading) ...[
                      const SizedBox(height: 24),
                      const Center(child: CircularProgressIndicator()),
                    ] else if (_machineId == null) ...[
                      const SizedBox(height: 16),
                      Text(
                        'No computer of yours is online. Start Harness on a computer signed in to your '
                        'account, then pull to refresh.',
                        style: tty.style(color: tty.dim),
                      ),
                    ] else if (cards != null) ...[
                      const SizedBox(height: 12),
                      TextField(
                        key: const Key('connectors-search'),
                        decoration: const InputDecoration(
                          hintText: 'Search connectors',
                          prefixIcon: Icon(LucideIcons.search300),
                        ),
                        onChanged: (value) =>
                            setState(() => _query = value.trim()),
                      ),
                      const SettingsCaption('Connected'),
                      if (connected.isEmpty)
                        Text(
                          query.isEmpty
                              ? 'Nothing connected yet.'
                              : 'No match.',
                          style: tty.style(color: tty.dim),
                        )
                      else
                        SettingsGroup(
                          children: [
                            for (final card in connected)
                              SettingsRow(
                                leading: _ConnectorMark(
                                  code: card.code,
                                  name: card.name,
                                ),
                                title: card.name,
                                detail: _hasWays(card.code)
                                    ? null
                                    : card.needsAttention
                                    ? 'Connect again'
                                    : card.description,
                                below: _hasWays(card.code)
                                    ? _waysChips(card)
                                    : null,
                                value: _installing(card)
                                    ? 'Installing…'
                                    : _hasWays(card.code)
                                    ? 'Manage'
                                    : card.needsAttention
                                    ? 'Reconnect'
                                    : 'Connected',
                                onTap: _hasWays(card.code)
                                    ? () => _chooseWay(card)
                                    : _checking(card)
                                    ? () => unawaited(
                                        _afterChecking(
                                          card,
                                          () => _manage(card),
                                        ),
                                      )
                                    : () => _manage(card),
                              ),
                          ],
                        ),
                      SettingsCaption('Available ${available.length}'),
                      SettingsGroup(
                        children: [
                          for (final card in available)
                            SettingsRow(
                              leading: _ConnectorMark(
                                code: card.code,
                                name: card.name,
                              ),
                              title: card.name,
                              // A way begun but not finished (Codex's plugin, no account
                              // signed in yet) says so here, under Available.
                              detail:
                                  _hasWays(card.code) &&
                                      _waysChips(card) != null
                                  ? null
                                  : card.reason.isNotEmpty
                                  ? card.reason
                                  : card.description,
                              below: _hasWays(card.code)
                                  ? _waysChips(card)
                                  : null,
                              value: _busy.contains(card.code)
                                  ? 'Signing in…'
                                  : _installing(card)
                                  ? 'Installing…'
                                  : _checking(card)
                                  ? 'Checking…'
                                  : _hasWays(card.code)
                                  ? 'Add'
                                  : card.reason.isNotEmpty
                                  ? null
                                  : 'Add',
                              // Through Claude Code or Codex, it needs no Harness sign-in.
                              onTap: _hasWays(card.code)
                                  ? () => _chooseWay(card)
                                  : _checking(card)
                                  ? () => unawaited(
                                      _afterChecking(
                                        card,
                                        card.reason.isNotEmpty
                                            ? null
                                            : () => unawaited(_connect(card)),
                                      ),
                                    )
                                  : card.reason.isNotEmpty ||
                                        _busy.contains(card.code)
                                  ? null
                                  : () => unawaited(_connect(card)),
                            ),
                        ],
                      ),
                    ],
                  ],
                ),
              ),
            ),
          ],
        ),
      ),
    );
  }
}

/// A service's icon, bundled with the app (assets/connector-icons), or its initial when it has none
/// (a custom server).
/// [child] under an amber wash that brightens and fades while [active]: the Restart row after a
/// connection is made, which a running agent needs before it has the new tools. Still when not.
class _Pulse extends StatefulWidget {
  const _Pulse({required this.active, required this.child});

  final bool active;
  final Widget child;

  @override
  State<_Pulse> createState() => _PulseState();
}

class _PulseState extends State<_Pulse> with SingleTickerProviderStateMixin {
  late final _beat = AnimationController(
    vsync: this,
    duration: const Duration(milliseconds: 900),
  );

  @override
  void initState() {
    super.initState();
    if (widget.active) _beat.repeat(reverse: true);
  }

  @override
  void didUpdateWidget(_Pulse old) {
    super.didUpdateWidget(old);
    if (widget.active && !_beat.isAnimating) _beat.repeat(reverse: true);
    if (!widget.active && _beat.isAnimating) {
      _beat
        ..stop()
        ..value = 0;
    }
  }

  @override
  void dispose() {
    _beat.dispose();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    if (!widget.active) return widget.child;
    return AnimatedBuilder(
      animation: _beat,
      builder: (context, child) {
        final t = Curves.easeInOut.transform(_beat.value);
        return DecoratedBox(
          decoration: BoxDecoration(
            color: AppPalette.warn.withValues(alpha: 0.08 + 0.22 * t),
            border: Border.all(
              color: AppPalette.warn.withValues(alpha: 0.35 + 0.65 * t),
              width: 1.5,
            ),
            borderRadius: BorderRadius.circular(AppCard.radius),
          ),
          child: child,
        );
      },
      child: widget.child,
    );
  }
}

class _ConnectorMark extends StatelessWidget {
  const _ConnectorMark({required this.code, required this.name});

  final String code;
  final String name;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final path = connectorIcons[code];
    return Container(
      width: 28,
      height: 28,
      padding: const EdgeInsets.all(3),
      decoration: BoxDecoration(
        color: path == null ? tty.dim.withValues(alpha: 0.25) : Colors.white,
        borderRadius: BorderRadius.circular(7),
      ),
      alignment: Alignment.center,
      child: path == null
          ? Text(
              name.isEmpty ? '?' : name.characters.first.toUpperCase(),
              style: tty.style(weight: FontWeight.w700),
            )
          : Image.asset(path, fit: BoxFit.contain),
    );
  }
}

/// One of the plugins Codex splits a service into (Microsoft 365), as `elsewhere` `parts` names it:
/// PLUGIN@MARKETPLACE, its name, `installed` or `not_connected`, its own page on ChatGPT and its icon's
/// code in [connectorIcons].
typedef _Part = ({
  String plugin,
  String name,
  String state,
  String? page,
  String? icon,
});

/// One way to connect a service, in the Connect sheet: who it is, what it can do and who gets it,
/// and its state in a button-like pill at the right. Dimmed, and not tappable, when [onTap] is null.
class _WayCard extends StatelessWidget {
  const _WayCard({
    super.key,
    required this.icon,
    required this.title,
    required this.detail,
    required this.value,
    required this.onTap,
    this.onOpen,
    this.mark,
    this.fill,
    this.status,
  });

  /// [value] filled in this colour, apart at a glance: Connect blue, Remove red; outlined when null.
  final Color? fill;

  /// What it is in by (✓ Connected, ✓ Installed, Needs sign-in again), beside [title].
  final String? status;

  final IconData icon;

  /// A part of an engine's way (one of Codex's plugins): its icon's code, drawn in place of [icon],
  /// the card set in under its engine.
  final String? mark;
  final String title;

  /// What it can do, then who gets it, on two lines.
  final String detail;
  final String value;
  final VoidCallback? onTap;

  /// A blue icon beside [title], a tap of its own: the service's own page in that engine's account,
  /// where an account is added. Only for a way that is in.
  final VoidCallback? onOpen;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final lines = detail.split('\n');
    final live = onTap != null;
    final edge = AppPalette.textFaint.withValues(alpha: 0.45);
    final mark = this.mark;
    final card = Opacity(
      opacity: live ? 1 : 0.6,
      child: Material(
        color: AppGlass.rowFill,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(12),
          side: BorderSide(color: edge),
        ),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          onTap: onTap,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(14, 12, 12, 12),
            child: Row(
              children: [
                if (mark == null)
                  Icon(icon, size: 22, color: AppPalette.textSecondary)
                else
                  _ConnectorMark(code: mark, name: title),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              title,
                              overflow: TextOverflow.ellipsis,
                              style: TextStyle(
                                color: AppPalette.textPrimary,
                                fontSize: 16,
                                fontWeight: AppFont.semibold,
                              ),
                            ),
                          ),
                          // What it is in by, as the desktop's rows say it: blue, amber to sign in again.
                          if (status case final status?) ...[
                            const SizedBox(width: 8),
                            Text(
                              status,
                              style: TextStyle(
                                color: status.startsWith('✓')
                                    ? AppPalette.accentOnSurface
                                    : AppPalette.warn,
                                fontSize: 12.5,
                                fontWeight: AppFont.semibold,
                              ),
                            ),
                          ],
                          if (onOpen case final open?)
                            // An icon, not a button; a finger-sized target around it.
                            InkWell(
                              key: const Key('connector-way-open'),
                              onTap: open,
                              borderRadius: BorderRadius.circular(6),
                              child: Padding(
                                padding: const EdgeInsets.all(6),
                                child: Icon(
                                  Icons.open_in_new,
                                  size: 16,
                                  color: AppPalette.accentOnSurface,
                                ),
                              ),
                            ),
                        ],
                      ),
                      if (lines.first.isNotEmpty) ...[
                        const SizedBox(height: 3),
                        Text(
                          lines.first,
                          style: TextStyle(
                            color: AppPalette.textSecondary,
                            fontSize: 14,
                            height: 1.3,
                          ),
                        ),
                      ],
                      if (lines.length > 1) ...[
                        const SizedBox(height: 2),
                        Text(
                          lines.skip(1).join(' '),
                          style: TextStyle(
                            color: AppPalette.textFaint,
                            fontSize: 12.5,
                          ),
                        ),
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 10),
                Container(
                  padding: const EdgeInsets.symmetric(
                    horizontal: 12,
                    vertical: 6,
                  ),
                  // Filled as the desktop's buttons are: Connect blue, Remove red.
                  decoration: BoxDecoration(
                    borderRadius: BorderRadius.circular(8),
                    color: fill,
                    border: fill != null ? null : Border.all(color: edge),
                  ),
                  child: Text(
                    value,
                    style: TextStyle(
                      color: fill != null
                          ? Colors.white
                          : AppPalette.textPrimary,
                      fontSize: 13,
                      fontWeight: AppFont.semibold,
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
    return mark == null
        ? card
        : Padding(padding: const EdgeInsets.only(left: 18), child: card);
  }
}

class _Notice implements Exception {
  _Notice(this.text);
  final String text;
}
