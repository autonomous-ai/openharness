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
    });
  }

  String _machineName(String? id) {
    final machine = id == null ? null : _app.machineStates[id];
    return machine?.machine.displayName ?? 'No computer';
  }

  Future<void> _refresh() async {
    final machineId = _machineId;
    if (machineId == null) return _pickReachable();
    setState(() => _loading = true);
    final reply = await _app.connectors(machineId, {'action': 'list'});
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
  void _restartThere((String, Agent) target) {
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
    final connected = [
      ...?cards?.where((c) => (c.connected || c.needsAttention) && shown(c)),
    ];
    final available = [
      ...?cards?.where((c) => !c.connected && !c.needsAttention && shown(c)),
    ];
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
                    const SizedBox(height: 8),
                    Text(
                      'Services your agents can use. Sign in here once: every computer of your account '
                      'gets the connection.',
                      style: tty.style(color: tty.dim),
                    ),
                    if (_notice.isNotEmpty) ...[
                      const SizedBox(height: 12),
                      Text(_notice, style: tty.style(color: tty.dim)),
                    ],
                    // Agents read their tools when they start: one already running gets a connection
                    // made since only on a restart. Always here, for the harness last opened.
                    if (lastOpened != null) ...[
                      const SizedBox(height: 12),
                      SettingsGroup(
                        children: [
                          SettingsRow(
                            key: const Key('connectors-restart'),
                            leading: const Icon(
                              LucideIcons.refreshCw300,
                              size: 20,
                            ),
                            title: 'Restart "${lastOpened.$2.displayName}"',
                            detail: 'Restart to use the new tools from your connectors.',
                            onTap: () => _restartThere(lastOpened),
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
                      // At the top, not under the connected list: a long one pushed both off the screen.
                      // Which computer signs in matters only when it cannot: any of them gets the connection.
                      if (_app.connectorMachines.length > 1) ...[
                        const SizedBox(height: 8),
                        // A long host name gives way, never "Change".
                        Row(
                          children: [
                            Flexible(
                              child: Text(
                                'Through ${_machineName(_machineId)}',
                                maxLines: 1,
                                overflow: TextOverflow.ellipsis,
                                style: tty.style(color: tty.dim),
                              ),
                            ),
                            TtyTextButton(
                              key: const Key('connectors-computer'),
                              label: 'Change',
                              onPressed: _pickMachine,
                            ),
                          ],
                        ),
                      ],
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
                                detail: card.needsAttention
                                    ? 'Connect again'
                                    : card.description,
                                value: card.needsAttention
                                    ? 'Reconnect'
                                    : 'Connected',
                                onTap: () => _manage(card),
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
                              detail: card.reason.isNotEmpty
                                  ? card.reason
                                  : card.description,
                              value: _busy.contains(card.code)
                                  ? 'Signing in…'
                                  : card.reason.isNotEmpty
                                  ? null
                                  : 'Add',
                              onTap:
                                  card.reason.isNotEmpty ||
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

class _Notice implements Exception {
  _Notice(this.text);
  final String text;
}
