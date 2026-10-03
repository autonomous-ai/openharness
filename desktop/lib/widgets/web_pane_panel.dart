import 'package:harness/shared/theme/app_icons.dart';

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../core/open_in_browser.dart';
import '../core/runtime_platform.dart';
import '../core/models.dart' show AgentVerdict;
import '../core/test_run.dart';
import '../shared/theme/app_pane_icon.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import '../state/app_state.dart';
import '../state/harness_monitor_controller.dart';
import '../state/terminal_pane.dart';
import '../theme/app_theme.dart';
import '../viewer/interactive_viewer.dart';
import 'agent_drag.dart';
import 'engine_identity.dart';
import 'harness_activity_mark.dart';
import '../terminal/terminal_text.dart';
import 'verdict_marks.dart';

/// A domain harness's viewer, in a tile beside its agent's terminal.
///
/// The page is the harness's own — Circuit's board workspace, Workshop's 3D
/// view — served by a process the daemon runs on the agent's machine. This
/// panel only frames it: a header in the terminal's own idiom, a webview
/// that follows [TerminalPane.url] when the daemon names a new one, and a
/// small notice while the viewer is not answering yet.
///
/// The webview is a native view (WKWebView through `webview_flutter`), and a
/// native view cannot exist where no platform implementation is registered:
/// under `flutter test`, and on Linux today. There the body is the URL in
/// words, so every layout around it still builds and the tests can prove the
/// tile is placed, sized and closed correctly without instantiating it.
class WebPanePanel extends StatefulWidget {
  const WebPanePanel({
    super.key,
    required this.notifier,
    required this.pane,
    this.title = 'Viewer',
    required this.ownerName,
    required this.ownerEngine,
    this.ownerDisplayName,
    this.verdict,
    this.working = false,
    this.onClose,
    this.onToggleZoom,
    this.zoomed = false,
    this.compactHeader = false,
    this.visible = true,
  });

  final AppNotifier notifier;
  final bool visible;
  final TerminalPane pane;

  /// What the pane is called in its header ("3D Viewer"); see viewerPaneName.
  final String title;

  /// The harness this viewer belongs to — in the header's tooltip, beside the URL.
  final String ownerName;
  final String? ownerEngine;
  final String? ownerDisplayName;

  /// The harness's verdict on the workspace this viewer shows, for the phase
  /// strip and the chip in the header. The viewer IS the product, so this
  /// header carries them in full where the terminal's shows only the chip.
  final AgentVerdict? verdict;

  /// The agent is mid-turn: the header says so instead of the last verdict.
  final bool working;
  final VoidCallback? onClose;
  final VoidCallback? onToggleZoom;
  final bool zoomed;
  final bool compactHeader;

  /// Whether this build can put a real webview on screen. One place, so the
  /// panel and its tests agree on when the placeholder is the right answer.
  static bool get webviewAvailable => !kUnderTest && RuntimePlatform.isMacOS;

  @override
  State<WebPanePanel> createState() => _WebPanePanelState();
}

class _WebPanePanelState extends State<WebPanePanel> {
  bool get _isMonitor =>
      widget.notifier
          .stateOf(widget.pane.machineId)
          ?.agents
          .any(
            (agent) =>
                agent.id == widget.pane.ownerAgentId &&
                agent.dsh == harnessMonitorId,
          ) ==
      true;
  WebViewController? _controller;
  InteractiveViewerSession? _remote;
  String? _remoteIdentity;
  String? _loadedUrl;
  bool _loading = false;
  String? _failure;

  /// The appearance last stamped on the page, so a rebuild that changed nothing runs no script.
  Brightness? _stampedBrightness;

  @override
  void initState() {
    super.initState();
    _mountRemote();
    if (WebPanePanel.webviewAvailable) unawaited(_mountController());
  }

  void _mountRemote() {
    if (!kIsWeb &&
        !(_isMonitor && !kUnderTest && !WebPanePanel.webviewAvailable)) {
      return;
    }
    final pane = widget.pane;
    final identity = '${pane.machineId}/${pane.ownerAgentId}/${pane.url}';
    if (_remoteIdentity == identity) return;
    _remote?.dispose();
    _remoteIdentity = identity;
    final notifier = widget.notifier;
    final machineId = pane.machineId, agentId = pane.ownerAgentId!;
    _remote = InteractiveViewerSession(
      (payload) => notifier.viewerSurface(machineId, agentId, payload),
      onHostAction: (action) => unawaited(_hostAction(action)),
    );
    pane.focusViewerInput = _focusRemote;
  }

  bool _focusRemote() => _remote?.focusInput?.call() ?? false;

  @override
  void dispose() {
    if (widget.pane.focusViewerInput == _focusRemote) {
      widget.pane.focusViewerInput = null;
    }
    _remote?.dispose();
    super.dispose();
  }

  Future<void> _mountController() async {
    // WebKit's default media policy wants a click before any playback, which
    // leaves a viewer's muted video sitting at 00:00 with a play button; a
    // pane whose whole point is the render the harness just made autoplays it.
    final controller =
        WebViewController.fromPlatformCreationParams(
            WebViewPlatform.instance is WebKitWebViewPlatform
                ? WebKitWebViewControllerCreationParams(
                    allowsInlineMediaPlayback: true,
                    mediaTypesRequiringUserAction: const <PlaybackMediaTypes>{},
                  )
                : const PlatformWebViewControllerCreationParams(),
          )
          ..setJavaScriptMode(JavaScriptMode.unrestricted)
          ..setNavigationDelegate(
            NavigationDelegate(
              onPageStarted: (_) => _set(() {
                _loading = true;
                _failure = null;
              }),
              onPageFinished: (_) {
                _set(() => _loading = false);
                // A fresh document has no stamp; give it the app's appearance before it is looked at.
                _stampedBrightness = null;
                _stampTheme();
              },
              onWebResourceError: (error) {
                // Only the page itself: a harness's viewer pulls fonts, models
                // and images of its own, and one of those failing is its business
                // to show, not ours to call a dead viewer.
                if (error.isForMainFrame == false) return;
                _set(() {
                  _loading = false;
                  _failure = error.description.isNotEmpty
                      ? error.description
                      : 'The viewer did not answer.';
                });
              },
            ),
          );
    _controller = controller;
    if (_isMonitor) {
      await controller.addJavaScriptChannel(
        'HarnessHost',
        onMessageReceived: (message) async {
          if (message.message.length > 2048) return;
          final current = await controller.currentUrl();
          try {
            if (!mounted ||
                current == null ||
                Uri.tryParse(current)?.origin !=
                    Uri.tryParse(widget.pane.url ?? '')?.origin) {
              return;
            }
            final action = jsonDecode(message.message);
            if (action is Map<String, dynamic>) await _hostAction(action);
          } catch (_) {
            /* malformed navigation request */
          }
        },
      );
    }
    if (mounted) _load();
  }

  Future<void> _hostAction(Map<String, dynamic> action) async {
    if (!mounted || !_isMonitor || !widget.visible) return;
    final error = await widget.notifier.handleHarnessMonitorAction(
      widget.pane,
      action,
    );
    final guidance =
        error ??
        (action['action'] == 'assistant' && action['chooseModel'] == true
            ? (widget.ownerEngine == 'opencode'
                  ? 'Use /models in OpenCode to choose a model before sending your question.'
                  : 'Choose a model from your assistant’s model menu before sending your question.')
            : null);
    if (mounted && guidance != null) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(guidance)));
    }
  }

  void _set(VoidCallback change) {
    if (mounted) setState(change);
  }

  void _load() {
    final url = widget.pane.url;
    final controller = _controller;
    if (url == null || controller == null) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    _loadedUrl = url;
    _failure = null;
    // The window colour behind the page, so a dark app never flashes white
    // while a viewer loads. WKWebView on macOS has no such setting (the plugin
    // throws UnimplementedError, seen live 2026-09-15 as a red pane), so only
    // platforms that do get it.
    if (!RuntimePlatform.isMacOS) {
      controller.setBackgroundColor(grid.AppPalette.windowBg);
    }
    controller.loadRequest(uri);
  }

  /// Tell the page which appearance the app is in.
  ///
  /// The web view follows the SYSTEM's light/dark setting on its own (`prefers-color-scheme`),
  /// not the app's — so an app set to dark on a light Mac showed a light viewer inside a dark
  /// window, and the two disagreed. The stamp is the same `data-theme` on the document root that
  /// the app's own artifact pages honour; a viewer that styles for it follows the app, and one
  /// that does not is unaffected. Runs on every load and whenever the app's theme changes.
  void _stampTheme() {
    final controller = _controller;
    if (controller == null || _loadedUrl == null) return;
    final brightness = grid.AppTheme.brightness.value;
    if (brightness == _stampedBrightness) return;
    _stampedBrightness = brightness;
    final theme = brightness == Brightness.dark ? 'dark' : 'light';
    controller
        .runJavaScript(
          "document.documentElement.setAttribute('data-theme','$theme')",
        )
        .catchError((_) {});
  }

  Future<void> _openInBrowser(Uri page) async {
    if (await openInBrowser(page) || !mounted) return;
    ScaffoldMessenger.maybeOf(context)?.showSnackBar(
      const SnackBar(
        content: Text('Could not open a browser. Copy the address instead.'),
      ),
    );
  }

  void _reload() {
    if (_remote case final remote?) {
      remote.reload();
      return;
    }
    if (_controller == null) return;
    if (_loadedUrl != widget.pane.url) {
      _load();
    } else {
      _failure = null;
      _controller!.reload();
    }
    setState(() {});
  }

  @override
  void didUpdateWidget(WebPanePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    _mountRemote();
    // The daemon named a different page — the newest artifact, a viewer
    // restarted on another port. Navigate in place; the tile stays.
    if (widget.pane.url != _loadedUrl) _load();
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    // The theme is a dependency of this build; a change here reaches the page too.
    _stampTheme();
    return ColoredBox(
      color: grid.AppPalette.windowBg,
      child: Column(
        children: [
          _header(context),
          Divider(height: 1, color: AppColors.border),
          Expanded(child: _body(context)),
        ],
      ),
    );
  }

  Widget _header(BuildContext context) =>
      MediaQuery.withNoTextScaling(child: Builder(builder: _buildHeader));

  Widget _buildHeader(BuildContext context) {
    TerminalFontScope.watch(context);
    final compact = widget.compactHeader;
    return SizedBox(
      height: compact ? 38 : 46,
      child: Padding(
        padding: const EdgeInsets.only(
          left: 14,
          right: grid.AppDesktop.paneCloseInset,
        ),
        child: Row(
          children: [
            EngineMark(
              engine: widget.ownerEngine,
              displayName: widget.ownerDisplayName,
              size: 17,
            ),
            const SizedBox(width: 10),
            // The name, and one status after it — ready, or what stands in
            // the way, or where the work is — in the place a "Viewer" label
            // would only repeat what the pane shows. A status, not a history.
            Expanded(
              child: Tooltip(
                message: [widget.ownerName, ?widget.pane.url].join('\n'),
                waitDuration: const Duration(milliseconds: 500),
                child: Row(
                  children: [
                    Flexible(
                      child: Text(
                        widget.title,
                        key: const ValueKey('viewer-pane-title'),
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: workspaceBarTextStyle(color: AppColors.text),
                      ),
                    ),
                    if (widget.pane.ownerAgentId case final ownerId?)
                      HarnessActivityMark(
                        app: widget.notifier,
                        machineId: widget.pane.machineId,
                        agentId: ownerId,
                        visible: widget.visible,
                      ),
                    if (widget.verdict case final verdict?
                        when !_isMonitor) ...[
                      Text(
                        '  ·  ',
                        style: grid.AppType.monoLabel(
                          color: AppColors.mutedStrong,
                        ),
                      ),
                      Flexible(
                        child: VerdictStatus(
                          verdict: verdict,
                          working: widget.working,
                        ),
                      ),
                    ],
                  ],
                ),
              ),
            ),
            const SizedBox(width: 8),
            // coverage:ignore-start
            // Only a real webview's navigation sets _loading; none under test.
            if (_loading)
              const Padding(
                padding: EdgeInsets.symmetric(horizontal: 6),
                child: SizedBox(
                  width: 12,
                  height: 12,
                  child: CircularProgressIndicator(strokeWidth: 1.5),
                ),
              ),
            // coverage:ignore-end
            _ViewerActions(
              onReload: _controller == null && _remote == null ? null : _reload,
              onClose: widget.onClose,
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    if (widget.pane.viewerError case final error?) {
      return _Notice(
        key: const ValueKey('web-pane-error'),
        icon: AppIcons.unplug,
        title: 'Viewer unavailable',
        detail: error,
      );
    }
    if (_remote case final remote?) return RemoteViewerSurface(session: remote);
    final controller = _controller;
    final url = widget.pane.url;
    if (controller == null) {
      // No embedded webview on this platform (it ships for macOS only — see
      // [webviewAvailable]), so the page it would have shown opens in the
      // browser instead of sitting here as text (openharness#108).
      final page = url == null ? null : Uri.tryParse(url);
      return _Notice(
        key: const ValueKey('web-pane-placeholder'),
        icon: AppIcons.globe,
        title: 'Viewer',
        detail: page == null
            ? 'No viewer yet.'
            : 'This viewer opens in your browser on this platform.\n$url',
        action: page == null
            ? null
            : TextButton(
                key: const ValueKey('web-pane-open-in-browser'),
                onPressed: () => _openInBrowser(page),
                child: const Text('Open in browser'),
              ),
      );
    }
    return Stack(
      fit: StackFit.expand,
      children: [
        WebViewWidget(controller: controller),
        if (_failure != null)
          ColoredBox(
            color: grid.AppPalette.windowBg,
            child: _Notice(
              icon: AppIcons.unplug,
              title: 'Waiting for the viewer',
              detail: _failure!,
              action: TextButton(
                onPressed: _reload,
                child: const Text('Retry'),
              ),
            ),
          ),
      ],
    );
  }
}

/// Viewer navigation never stops the harness that owns it.
class _ViewerActions extends StatelessWidget {
  const _ViewerActions({this.onReload, this.onClose});

  final VoidCallback? onReload, onClose;

  @override
  Widget build(BuildContext context) {
    return Row(
      mainAxisSize: MainAxisSize.min,
      children: [
        PaneHeaderButton(
          label: 'Reload viewer',
          icon: AppPaneSymbol.reload,
          onPressed: onReload,
        ),
        PaneHeaderButton(
          label: 'Close viewer',
          command: 'pane.close',
          icon: AppPaneSymbol.close,
          iconSize: AppIcons.closeSize,
          onPressed: onClose,
        ),
      ],
    );
  }
}

class _Notice extends StatelessWidget {
  const _Notice({
    super.key,
    required this.icon,
    required this.title,
    required this.detail,
    this.action,
  });

  final IconData icon;
  final String title;
  final String detail;
  final Widget? action;

  @override
  Widget build(BuildContext context) {
    return Center(
      child: SingleChildScrollView(
        padding: const EdgeInsets.all(20),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          children: [
            Icon(icon, size: 24, color: AppColors.mutedStrong),
            const SizedBox(height: 10),
            Text(
              title,
              style: grid.AppType.label(
                color: AppColors.text,
                fontWeight: FontWeight.w600,
              ),
            ),
            const SizedBox(height: 4),
            Text(
              detail,
              textAlign: TextAlign.center,
              maxLines: 3,
              overflow: TextOverflow.ellipsis,
              style: grid.AppType.body(color: AppColors.mutedStrong),
            ),
            if (action != null) ...[const SizedBox(height: 8), action!],
          ],
        ),
      ),
    );
  }
}
