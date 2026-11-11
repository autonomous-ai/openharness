import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../core/models.dart';
import '../core/runtime_platform.dart';
import '../logging/app_log.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/swarm_layout.dart';
import '../shared/widgets/app_icon_button.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/native_webview_host.dart';
import '../widgets/web_pane_panel.dart';
import '../ws/ws_conn.dart';
import 'browser_bridge.dart';
import 'browser_settings_page.dart';
import 'browser_setup_dialog.dart';
import 'browser_stream.dart';
import 'browser_view.dart';

/// An agent chat's Browser icon, after Terminal: selected while its panel is open, and marked with the connection dot's
/// green while the agent's browser is [running].
class BrowserButton extends StatelessWidget {
  const BrowserButton({
    super.key,
    required this.open,
    this.running = false,
    required this.onPressed,
  });
  final bool open, running;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Semantics(
    key: const ValueKey('swarm-browser-button'),
    container: true,
    button: true,
    selected: open,
    label: running ? 'Browser, running' : 'Browser',
    onTap: onPressed,
    excludeSemantics: true,
    child: Stack(
      children: [
        AppIconButton(
          icon: AppIcons.globe,
          size: AppIcons.inlineSize,
          tooltip: 'Browser',
          selected: open,
          onPressed: onPressed,
        ),
        if (running)
          // At the glyph's top right: the 16-point glyph sits 8 points in from the 32-point target's edges.
          Positioned(
            top: 6,
            right: 6,
            child: IgnorePointer(
              child: Container(
                width: 6,
                height: 6,
                decoration: BoxDecoration(
                  color: grid.AppPalette.online,
                  shape: BoxShape.circle,
                ),
              ),
            ),
          ),
      ],
    ),
  );
}

/// What a failed browser says (`browser.error`), in the agent frame's words.
const _failed = {
  'needs_setup': 'Browser isn\'t set up',
  'podman_install_failed': 'Podman didn\'t install',
  'podman_manual': 'Install Podman, then retry',
  'podman_old': 'Update Podman, then retry',
  'podman_memory': 'Give Podman 4 GB of memory, then retry',
  'state_unreadable': 'Browser data can\'t be read',
  'podman_down': 'Podman is not running',
  'image_failed': 'Browser image failed to build',
  'browser_stopped': 'Browser stopped',
  'profile_unwritable': 'Browser can\'t save its login',
  'proxy_failed': 'Proxy is not reachable',
  'browser_limit': 'Too many browsers on this machine',
  'device_failed': 'Device settings didn\'t apply',
};

/// The setup steps, in order, and the line each one has.
const _steps = ['installing', 'starting_podman', 'building'];
const _stepLines = [
  'Podman installed',
  'Starting Podman…',
  'Building browser',
  'Starting browser',
];

/// What only the panel knows, after a stream it had ended: its line, and whether Retry opens another.
typedef _Failure = ({String line, bool retry});

/// An agent's own Chrome beside its chat (Mockups 3 and 4): off, a line and Start; while it is set up or starts, its
/// progress; when it failed, why and what to press; when ready, its screen through noVNC, which the person uses as
/// the agent does. Stop is in its header whenever the browser is on.
class BrowserPanel extends StatefulWidget {
  const BrowserPanel({
    super.key,
    required this.app,
    required this.machineId,
    required this.agentId,
    required this.thisComputer,
    this.onClose,
    @visibleForTesting this.newView,
  });

  final AppNotifier app;
  final String machineId, agentId;

  /// The agent runs on this computer: setup can be started only here.
  final bool thisComputer;
  final VoidCallback? onClose;

  /// The page for each stream; a test gives its own.
  final BrowserView Function()? newView;

  /// How long the panel's size holds still before Chrome's window is asked to take it: a drag sends one request.
  static const windowSettle = Duration(milliseconds: 300);

  @override
  State<BrowserPanel> createState() => _BrowserPanelState();
}

class _BrowserPanelState extends State<BrowserPanel> {
  BrowserView? _view;
  BrowserBridge? _bridge;
  bool _open = false;
  _Failure? _failure;

  /// The agent frame's browser when the machine said it is not ready: no stream opens until the frame changes, or
  /// until [_waitEnds] says the browser stopped.
  AgentBrowser? _waiting;
  Timer? _waitEnds;
  int _routeLosses = 0;
  bool _settings = false;

  /// A request the machine did not take, in one line.
  String? _refused;

  /// The screen area's size, in logical pixels, rounded; the last one Chrome's window was asked to take; and the wait
  /// for the size to hold still.
  (int, int)? _screen, _asked;
  Timer? _settle;

  AppNotifier get _app => widget.app;
  MachineState? get _machine => _app.stateOf(widget.machineId);
  String get _machineName => _machine?.machine.displayName ?? widget.machineId;

  AgentBrowser? get _browser => _machine?.agents
      .where((a) => a.id == widget.agentId)
      .firstOrNull
      ?.browser;

  bool get _online {
    final machine = _machine;
    return machine != null &&
        machine.nodeOnline != false &&
        machine.connectionStatus == ConnectionStatus.connected;
  }

  @override
  void initState() {
    super.initState();
    _app.addListener(_sync);
    WidgetsBinding.instance.addPostFrameCallback((_) => _sync());
  }

  @override
  void dispose() {
    _app.removeListener(_sync);
    _waitEnds?.cancel();
    _end();
    super.dispose();
  }

  /// Opens a stream when the browser is ready and nothing holds it back, and ends one that should no longer be open.
  void _sync() {
    if (!mounted) return;
    final browser = _browser;
    // Off forgets what the stream it had said: a later Start begins clean.
    if (browser == null) {
      _failure = null;
      _routeLosses = 0;
    }
    if (_waiting != null && browser != _waiting) _waiting = null;
    if (_waiting == null) _waitEnds?.cancel();
    final wanted =
        WebPanePanel.webviewAvailable &&
        _online &&
        browser?.state == 'ready' &&
        _failure == null &&
        _waiting == null &&
        !_settings;
    if (wanted && _bridge == null) unawaited(_connect());
    if (!wanted && _bridge != null) _end();
    setState(() {});
  }

  Future<void> _connect() async {
    final view = (widget.newView ?? BrowserView.new)();
    final stream = _app.browserStream(widget.machineId, widget.agentId);
    final bridge = BrowserBridge(view, stream, mac: RuntimePlatform.isMacOS);
    _view = view;
    _bridge = bridge;
    _open = false;
    try {
      await bridge.start();
    } on BrowserStreamError catch (error) {
      if (!mounted || _bridge != bridge) return;
      _end();
      _refusedOpen(error.code);
      return;
    }
    if (!mounted || _bridge != bridge) return;
    // A working stream: the next route loss is the first in a row again.
    _routeLosses = 0;
    _app.productMeasurement.agentBrowserOpened();
    unawaited(stream.closed.then((reason) => _closed(bridge, reason)));
    setState(() => _open = true);
    // A new page knows no window yet.
    unawaited(_fitWindow());
  }

  /// Ends the open stream, if any, without a word: what to show comes from whoever ended it. Chrome's window keeps
  /// its last size.
  void _end() {
    unawaited(_bridge?.close());
    _bridge = null;
    _view = null;
    _open = false;
    _settle?.cancel();
    _asked = null;
  }

  /// The screen area was laid out at [size]: once it holds still, Chrome's window is asked to take it.
  void _screenSized(Size size) {
    final screen = (size.width.round(), size.height.round());
    if (screen == _screen) return;
    _screen = screen;
    if (!_open) return;
    _settle?.cancel();
    _settle = Timer(BrowserPanel.windowSettle, () => unawaited(_fitWindow()));
  }

  /// Asks the machine to size Chrome's window to the screen area, and tells the page the size it set. A machine that
  /// cannot leaves the page scaling the whole screen; the next settled size asks again.
  Future<void> _fitWindow() async {
    final bridge = _bridge;
    final screen = _screen;
    if (!_open || bridge == null || screen == null || screen == _asked) return;
    _asked = screen;
    final (width, height) = screen;
    final set = await _app.agentBrowserWindow(
      widget.machineId,
      widget.agentId,
      width,
      height,
    );
    if (!mounted || _bridge != bridge) return;
    if (set == null) {
      if (_asked == screen) _asked = null;
      return;
    }
    bridge.window(set.width, set.height);
  }

  void _refusedOpen(String code) {
    switch (code) {
      case 'VIEWER_LIMIT':
        _failure = (line: 'Browser is open in too many places', retry: false);
      case 'NOT_OWNER':
        _failure = (line: 'Only its owner can open this browser', retry: false);
      case 'NOT_READY' || 'NO_BROWSER':
        _wait();
      case BrowserStreamError.page:
        _failure = (
          line: 'This computer can\'t show the browser',
          retry: false,
        );
      default:
        return _lostRoute();
    }
    _sync();
  }

  void _closed(BrowserBridge bridge, String? reason) {
    if (!mounted || _bridge != bridge) return;
    _end();
    if (reason == 'route') return _lostRoute();
    _routeLosses = 0;
    switch (reason) {
      case 'rate' || 'backlog':
        _failure = (line: 'Browser is slow here', retry: true);
      case 'agent':
        _wait();
      default:
        // noVNC closed its own side.
        _failure = (line: 'Browser lost its connection', retry: true);
    }
    _sync();
  }

  /// Waits for the agent frame's browser to change. A frame that stays ready while no stream opens (the exec alone
  /// failed) is a stopped browser, with Retry.
  void _wait() {
    _waiting = _browser;
    _waitEnds?.cancel();
    _waitEnds = Timer(BrowserStream.openTimeout, () {
      if (!mounted || _waiting == null) return;
      appLog.warn(
        'browser',
        'browser on ${widget.machineId} did not come back',
      );
      _waiting = null;
      _failure = (line: _failed['browser_stopped']!, retry: true);
      _sync();
    });
  }

  /// The stream's route went away: the next stream takes whatever route there is now, once; twice in a row says so.
  void _lostRoute() {
    if (++_routeLosses > 1) {
      _failure = (line: 'Browser lost its connection', retry: true);
    }
    _sync();
  }

  void _retryStream() {
    _failure = null;
    _routeLosses = 0;
    _sync();
  }

  /// Sends [request] to the agent's machine, and says so in one line when it was not taken.
  Future<void> _ask(Future<void> Function() request) async {
    setState(() => _refused = null);
    try {
      await request();
    } catch (error) {
      appLog.warn('browser', 'request to ${widget.machineId} failed: $error');
      if (!mounted) return;
      setState(
        () => _refused = switch (error) {
          StateError(:final message) => message,
          WsRequestFailure(code: 'UNSUPPORTED') =>
            'Update Harness on $_machineName first',
          WsRequestFailure(code: 'NOT_ON_WINDOWS') =>
            'Browser doesn\'t run on Windows yet',
          WsRequestFailure(code: 'NOT_OWNER') =>
            'Only its owner can open this browser',
          _ => 'Browser isn\'t available on $_machineName right now',
        },
      );
    }
  }

  void _start() =>
      _ask(() => _app.agentBrowserStart(widget.machineId, widget.agentId));

  void _stop() =>
      _ask(() => _app.agentBrowserStop(widget.machineId, widget.agentId));

  Future<void> _install() async {
    final availability = await _app.agentBrowserAvailable(widget.machineId);
    if (!mounted) return;
    final install = await showBrowserSetupDialog(
      context,
      ownMachine: availability.ownMachine,
    );
    if (install) await _ask(() => _app.agentBrowserSetup(widget.machineId));
  }

  Future<void> _paste() async {
    final text = (await Clipboard.getData(Clipboard.kTextPlain))?.text;
    if (text != null && text.isNotEmpty) _bridge?.paste(text);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ColoredBox(
      key: const ValueKey('swarm-browser-panel'),
      color: DesktopChrome.surface,
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Container(
            height: 52,
            padding: const EdgeInsets.symmetric(
              horizontal: SwarmLayout.barSide,
            ),
            decoration: BoxDecoration(
              border: Border(bottom: BorderSide(color: DesktopChrome.rim)),
            ),
            child: Row(
              spacing: 4,
              children: [
                Expanded(
                  child: Text(
                    'Browser',
                    style: DesktopChrome.text(medium: true),
                  ),
                ),
                if (_browser != null)
                  DesktopPill(
                    key: const ValueKey('swarm-browser-stop'),
                    label: 'Stop',
                    compact: true,
                    quiet: true,
                    onPressed: _stop,
                  ),
                AppIconButton(
                  key: const ValueKey('swarm-browser-settings'),
                  icon: AppIcons.settings,
                  tooltip: 'Browser settings',
                  selected: _settings,
                  onPressed: () {
                    _settings = !_settings;
                    _sync();
                  },
                ),
                AppIconButton(
                  key: const ValueKey('swarm-browser-paste'),
                  icon: AppIcons.clipboardPaste,
                  tooltip: 'Paste',
                  onPressed: _open && !_settings ? _paste : null,
                ),
                AppIconButton(
                  key: const ValueKey('swarm-browser-close'),
                  icon: AppIcons.close,
                  tooltip: 'Close',
                  onPressed: widget.onClose,
                ),
              ],
            ),
          ),
          Expanded(child: _body()),
        ],
      ),
    );
  }

  Widget _body() {
    if (!_online) return _line('Reconnect this machine to open its browser');
    if (_settings) {
      return BrowserSettingsPage(
        app: _app,
        machineId: widget.machineId,
        agentId: widget.agentId,
        onBack: () {
          _settings = false;
          _sync();
        },
      );
    }
    if (_failure case final failure?) {
      return _line(
        failure.line,
        action: failure.retry ? ('Retry', _retryStream) : null,
      );
    }
    final browser = _browser;
    if (browser == null) {
      return _line(
        'A sandboxed Chrome the agent drives',
        action: ('Start', _start),
        actionKey: const ValueKey('swarm-browser-start'),
      );
    }
    final view = _view;
    return switch (browser.state) {
      'setup' => _progress(browser.step),
      'failed' => _failedLine(browser.error),
      // Setup and its failures are words; only the screen needs a webview.
      'ready' when !WebPanePanel.webviewAvailable => _line(
        'This computer can\'t show the browser',
      ),
      'ready' when view != null && _waiting == null => Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Expanded(
            child: LayoutBuilder(
              builder: (context, constraints) {
                _screenSized(constraints.biggest);
                return Stack(
                  fit: StackFit.expand,
                  children: [
                    NativeWebViewHost(child: view.build(context)),
                    if (!_open) _starting(),
                  ],
                );
              },
            ),
          ),
          // A Stop the machine did not take, under the screen.
          if (_refused case final refused?)
            Padding(
              padding: const EdgeInsets.all(DesktopChrome.controlGap),
              child: _refusedLine(refused),
            ),
        ],
      ),
      _ => _starting(),
    };
  }

  Widget _failedLine(String? error) {
    final retry = (
      'Retry',
      () =>
          _ask(() => _app.agentBrowserRetry(widget.machineId, widget.agentId)),
    );
    return switch (error) {
      'needs_setup' when !widget.thisComputer => _line(
        'Set up Browser on $_machineName first',
      ),
      'needs_setup' => _line(_failed[error]!, action: ('Install', _install)),
      'podman_install_failed' => _line(
        _failed[error]!,
        action: widget.thisComputer
            ? (
                'Retry',
                () => _ask(() => _app.agentBrowserSetup(widget.machineId)),
              )
            : null,
      ),
      'state_unreadable' => _line(_failed[error]!),
      // A failure this build has no words for reads as the browser stopping, which Retry answers too.
      _ => _line(_failed[error] ?? _failed['browser_stopped']!, action: retry),
    };
  }

  Widget _starting() => Center(
    child: Column(
      mainAxisSize: MainAxisSize.min,
      spacing: DesktopChrome.controlGap,
      children: [
        const SizedBox.square(
          dimension: grid.AppControl.iconSize,
          child: CircularProgressIndicator(strokeWidth: 1.5),
        ),
        Text('Starting browser…', style: DesktopChrome.control()),
        if (_refused case final refused?) _refusedLine(refused),
      ],
    ),
  );

  /// One centred line, with an action under it.
  Widget _line(String line, {(String, VoidCallback)? action, Key? actionKey}) =>
      Center(
        child: Padding(
          padding: const EdgeInsets.all(24),
          child: Column(
            mainAxisSize: MainAxisSize.min,
            spacing: DesktopChrome.controlGap,
            children: [
              Text(
                line,
                textAlign: TextAlign.center,
                style: DesktopChrome.control(),
              ),
              if (action case (final label, final onPressed))
                FilledButton(
                  key: actionKey,
                  onPressed: onPressed,
                  child: Text(label),
                ),
              if (_refused case final refused?) _refusedLine(refused),
            ],
          ),
        ),
      );

  /// A request the machine did not take, in one 12 grey line.
  Widget _refusedLine(String refused) => Text(
    refused,
    textAlign: TextAlign.center,
    style: DesktopChrome.metadata(),
  );

  /// The four setup lines: earlier steps ticked, the current one turning, the rest still to come.
  Widget _progress(String? step) {
    final current = _steps.indexOf(step ?? '');
    return Center(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          for (var i = 0; i < _stepLines.length; i++)
            Padding(
              padding: const EdgeInsets.symmetric(
                vertical: grid.AppDesktop.listRowGap,
              ),
              child: Row(
                mainAxisSize: MainAxisSize.min,
                spacing: DesktopChrome.controlGap,
                children: [
                  if (i < current)
                    Icon(
                      AppIcons.circleCheck,
                      size: grid.AppControl.iconSize,
                      semanticLabel: 'Done',
                    )
                  else if (i == current)
                    const SizedBox.square(
                      dimension: grid.AppControl.iconSize,
                      child: CircularProgressIndicator(strokeWidth: 1.5),
                    )
                  else
                    Icon(
                      AppIcons.circle,
                      size: grid.AppControl.iconSize,
                      color: DesktopChrome.muted,
                    ),
                  Text(
                    _stepLines[i],
                    style: DesktopChrome.control(
                      color: i <= current ? null : DesktopChrome.muted,
                    ),
                  ),
                ],
              ),
            ),
          if (_refused case final refused?) _refusedLine(refused),
        ],
      ),
    );
  }
}
