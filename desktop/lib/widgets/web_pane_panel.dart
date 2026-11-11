import 'package:harness/shared/theme/app_icons.dart';

import 'dart:async';
import 'dart:convert';

import 'package:flutter/foundation.dart';
import 'package:flutter/material.dart';
import 'package:webview_flutter/webview_flutter.dart';
import 'package:webview_flutter_wkwebview/webview_flutter_wkwebview.dart';

import '../core/open_in_browser.dart';
import '../core/native_webview_runtime.dart';
import '../core/runtime_platform.dart';
import '../core/models.dart' show AgentVerdict;
import '../core/test_run.dart';
import '../shared/theme/app_pane_icon.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/workspace_bar_style.dart';
import '../state/app_state.dart';
import '../measurement/product_measurement.dart';
import '../state/harness_monitor_controller.dart';
import '../state/terminal_pane.dart';
import '../state/viewer_load_tracker.dart';
import '../theme/app_theme.dart';
import '../viewer/interactive_viewer.dart';
import 'agent_drag.dart';
import 'engine_identity.dart';
import 'harness_activity_mark.dart';
import '../terminal/terminal_text.dart';
import 'verdict_marks.dart';
import 'native_webview_host.dart';

/// The harnesses whose viewer is a web page the person browses: their pane carries a browser bar.
const _browserHarnesses = {'autonomous/web-studio'};

/// The screen a web page is tried at in its pane: a phone's width, a tablet's, or the whole pane.
enum _PageSize {
  mobile('Mobile · 390 px', AppIcons.smartphone, 390),
  tablet('Tablet · 820 px', AppIcons.tablet, 820),
  desktop('Desktop · full width', AppIcons.monitor, null);

  const _PageSize(this.label, this.icon, this.width);
  final String label;
  final IconData icon;

  /// The page's width in logical pixels; null is the pane's own.
  final double? width;
}

/// Where this computer's gateway to another machine's viewer starts a page (the CLI's
/// remoteViewerProxy `BOOTSTRAP`).
const _gatewayPrefix = '/__harness_viewer/';

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
/// under `flutter test`, and on Linux without WebKitGTK. There the body shows
/// the URL in words, so every layout around it still builds and the tests can prove the
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
  static bool get webviewAvailable =>
      webviewAvailableForTest ??
      (!kUnderTest &&
          (RuntimePlatform.isMacOS || NativeWebViewRuntime.available));

  /// A test that installs a fake `WebViewPlatform` mounts the real webview path.
  @visibleForTesting
  static bool? webviewAvailableForTest;

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

  /// A web harness's pane reads as a browser: back, forward, reload, the page's address, and the page in
  /// the computer's own browser (owner, 2026-11-09). Other viewers (a 3D model, a board) keep their header.
  bool get _browserBar =>
      !_isMonitor &&
      widget.notifier
              .stateOf(widget.pane.machineId)
              ?.agents
              .any(
                (agent) =>
                    agent.id == widget.pane.ownerAgentId &&
                    _browserHarnesses.contains(agent.dsh),
              ) ==
          true;

  /// The page the webview is on now, which a click inside the page may have moved from [TerminalPane.url].
  String? _pageUrl;
  bool _canGoBack = false, _canGoForward = false;
  _PageSize _pageSize = _PageSize.desktop;
  final _address = TextEditingController();
  final _addressFocus = FocusNode();

  /// Whether the pane's page comes through this computer's gateway to another machine's viewer
  /// (the CLI's remoteViewerProxy): its address here is `/__harness_viewer/<token>?path=…`.
  bool get _throughGateway =>
      Uri.tryParse(widget.pane.url ?? '')?.path.startsWith(_gatewayPrefix) ==
      true;

  /// Whether [_controller] has its JavaScript channel. A load before then was cancelled by the one
  /// [_mountController] makes once it is added, and the cancellation counted as a failed load.
  bool _controllerReady = false;
  InteractiveViewerSession? _remote;
  String? _remoteIdentity;
  String? _loadedUrl;
  late final _viewerLoad = ViewerLoadTracker(
    begin: () =>
        widget.notifier.productMeasurement.begin(ProductFlow.viewerLoad),
    load: _navigate,
    changed: () => _set(() {}),
  );

  /// The remote viewer surface's load, measured by its own first frame.
  void Function(ProductOutcome)? _finishLoad;
  void _startLoad() {
    _finishLoad?.call(ProductOutcome.cancelled);
    _finishLoad = widget.notifier.productMeasurement.begin(
      ProductFlow.viewerLoad,
    );
  }

  void _remoteLoaded() {
    if (_remote?.image != null) {
      _finishLoad?.call(ProductOutcome.ok);
    } else if (_remote?.error != null) {
      _finishLoad?.call(ProductOutcome.failed);
    }
  }

  /// The appearance last stamped on the page, so a rebuild that changed nothing runs no script.
  Brightness? _stampedBrightness;

  /// Whether the person can see this pane: its tab in front, no other pane zoomed over it, and the
  /// window not minimised or hidden.
  bool get _shown => widget.visible && widget.notifier.inSight.value;

  /// What the Monitor's page was last told, so a rebuild that changed nothing runs no script.
  bool? _stampedShown;

  @override
  void initState() {
    super.initState();
    widget.notifier.inSight.addListener(_shownChanged);
    _mountRemote();
    if (WebPanePanel.webviewAvailable) unawaited(_mountController());
  }

  /// Harness Monitor's page reads every machine on the account for as long as it is connected, and a
  /// tile in a tab behind another stays mounted with its page loaded. Out of sight, its page is told
  /// to disconnect and its rendered surface stops pulling frames; back in sight, both resume and the
  /// page catches up once (2026-10-28). Other viewers are left exactly as they were.
  void _shownChanged() {
    _stampShown();
    _remote?.paused = _isMonitor && !_shown;
  }

  void _stampShown() {
    final controller = _controller;
    if (!_isMonitor || controller == null || _loadedUrl == null) return;
    final shown = _shown;
    if (shown == _stampedShown) return;
    _stampedShown = shown;
    controller
        .runJavaScript(
          "document.documentElement.dataset.hostVisible='$shown';"
          "document.dispatchEvent(new Event('harness-host-visibility'))",
        )
        .catchError((_) {});
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
    if (!kIsWeb) {
      _startLoad();
      _remote!.addListener(_remoteLoaded);
    }
    pane.focusViewerInput = _focusRemote;
    _remote!.paused = _isMonitor && !_shown;
  }

  bool _focusRemote() => _remote?.focusInput?.call() ?? false;

  @override
  void dispose() {
    widget.notifier.inSight.removeListener(_shownChanged);
    _finishLoad?.call(ProductOutcome.cancelled);
    _viewerLoad.dispose();
    if (widget.pane.focusViewerInput == _focusRemote) {
      widget.pane.focusViewerInput = null;
    }
    _remote?.dispose();
    _address.dispose();
    _addressFocus.dispose();
    super.dispose();
  }

  /// The webview moved to [url]: the address bar says where, and back and forward say whether they can.
  Future<void> _pageChanged(String? url) async {
    if (url == null || url.isEmpty) return;
    _pageUrl = url;
    if (!_addressFocus.hasFocus) _address.text = _shownAddress(url);
    final controller = _controller;
    if (controller == null) return;
    final back = await controller.canGoBack().catchError((_) => false);
    final forward = await controller.canGoForward().catchError((_) => false);
    _set(() {
      _canGoBack = back;
      _canGoForward = forward;
    });
  }

  /// Where the agent's page lives on its own machine, when the verdict names it (its dev server,
  /// `http://127.0.0.1:5173`): the address the agent and its terminal speak of.
  String? get _agentOrigin {
    final preview = Uri.tryParse(widget.verdict?.preview ?? '');
    return preview != null && preview.scheme == 'http' && preview.hasPort
        ? preview.origin
        : null;
  }

  /// The page's full address. Through the gateway, the origin is the agent's own (its dev server) when
  /// the verdict names it, so the bar reads as the agent's terminal does; else the address it has here.
  String _shownAddress(String url) {
    final uri = Uri.tryParse(url);
    if (uri == null) return url;
    final page = uri.path.startsWith(_gatewayPrefix)
        ? (uri.queryParameters['path'] ?? '/')
        : (uri.path.isEmpty ? '/' : uri.path) +
              (uri.hasQuery ? '?${uri.query}' : '') +
              (uri.fragment.isEmpty ? '' : '#${uri.fragment}');
    final origin = _throughGateway ? (_agentOrigin ?? uri.origin) : uri.origin;
    return '$origin$page';
  }

  /// What the person typed, as a page of this viewer: a path ("/menu"), or a full address on the page's
  /// host and port (here, or the agent's own). Anything else stays out of the pane, which shows the
  /// agent's pages only.
  Uri? _typedPage(String text) {
    final input = text.trim();
    final current = Uri.tryParse(_pageUrl ?? widget.pane.url ?? '');
    if (input.isEmpty || current == null || !current.hasAuthority) return null;
    if (input.startsWith('/')) return Uri.tryParse('${current.origin}$input');
    final typed = Uri.tryParse(input.contains('://') ? input : 'http://$input');
    if (typed != null && typed.hasAuthority) {
      if (typed.origin == current.origin) return typed;
      // The agent's own address of a page through the gateway: the same page, here.
      if (_throughGateway && typed.origin == _agentOrigin) {
        return Uri.tryParse(
          current.origin + typed.toString().substring(typed.origin.length),
        );
      }
    }
    // A bare path without its slash ("menu"), never a host.
    if (!input.contains(':') && !input.contains('.')) {
      return Uri.tryParse('${current.origin}/$input');
    }
    return null;
  }

  void _goTo(String text) {
    final page = _typedPage(text);
    final controller = _controller;
    if (controller == null) return;
    if (page == null) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        const SnackBar(
          content: Text(
            'This pane shows the agent’s pages. Type a path such as /about, or open the page in your browser.',
          ),
        ),
      );
      if (_pageUrl case final url?) _address.text = _shownAddress(url);
      return;
    }
    controller.loadRequest(page);
  }

  /// The page in this computer's browser: through the gateway, its bootstrap address leading to the
  /// page shown now, so the browser gets the gateway's cookie on the way.
  Uri? get _pageForBrowser {
    final pane = Uri.tryParse(widget.pane.url ?? '');
    if (pane == null) return null;
    final shown = _pageUrl;
    if (_throughGateway) {
      final page = Uri.tryParse(shown ?? '');
      if (page == null || page.path.startsWith(_gatewayPrefix)) return pane;
      final path =
          (page.path.isEmpty ? '/' : page.path) +
          (page.hasQuery ? '?${page.query}' : '') +
          (page.fragment.isEmpty ? '' : '#${page.fragment}');
      return pane.replace(queryParameters: {'path': path});
    }
    return Uri.tryParse(shown ?? '') ?? pane;
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
              onPageStarted: _viewerLoad.started,
              onUrlChange: (change) => unawaited(_pageChanged(change.url)),
              onPageFinished: (url) {
                _viewerLoad.finished(url);
                unawaited(_pageChanged(url));
                // A fresh document has no stamp; give it the app's appearance before it is looked at.
                _stampedBrightness = null;
                _stampTheme();
                _stampedShown = null;
                _stampShown();
              },
              onWebResourceError: (error) {
                // Only the page itself: a harness's viewer pulls fonts, models
                // and images of its own, and one of those failing is its business
                // to show, not ours to call a dead viewer. (WKWebView reports
                // every navigation failure as the main frame's; the tracker
                // tells them apart.)
                if (error.isForMainFrame == false) return;
                _viewerLoad.failed(
                  code: error.errorCode,
                  domain: error is WebKitWebResourceError ? error.domain : null,
                  url: error.url,
                  description: error.description,
                );
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
    _controllerReady = true;
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
    if (url == null || controller == null || !_controllerReady) return;
    final uri = Uri.tryParse(url);
    if (uri == null) return;
    _loadedUrl = url;
    _viewerLoad.request(url);
    // The window colour behind the page, so a dark app never flashes white
    // while a viewer loads. WKWebView on macOS has no such setting (the plugin
    // throws UnimplementedError, seen live 2026-09-15 as a red pane), so only
    // platforms that do get it.
    if (!RuntimePlatform.isMacOS) {
      controller.setBackgroundColor(grid.AppPalette.windowBg);
    }
    controller.loadRequest(uri);
  }

  /// An automatic retry of [url], on the load already being measured.
  void _navigate(String url) {
    final uri = Uri.tryParse(url);
    if (!mounted || uri == null) return;
    _controller?.loadRequest(uri);
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
    // The pane's address, never the webview's own reload: a remote viewer's address lasts one
    // connection (the CLI's per-connection gateway), and reloading the page went back to a gateway
    // that had closed.
    _load();
    setState(() {});
  }

  @override
  void didUpdateWidget(WebPanePanel oldWidget) {
    super.didUpdateWidget(oldWidget);
    if (oldWidget.notifier != widget.notifier) {
      oldWidget.notifier.inSight.removeListener(_shownChanged);
      widget.notifier.inSight.addListener(_shownChanged);
    }
    _mountRemote();
    _shownChanged();
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
          if (_browserBar &&
              _controller != null &&
              widget.pane.viewerError == null) ...[
            _BrowserBar(
              address: _address,
              focus: _addressFocus,
              onBack: _canGoBack ? () => _controller?.goBack() : null,
              onForward: _canGoForward ? () => _controller?.goForward() : null,
              onReload: () => _controller?.reload(),
              onSubmit: _goTo,
              size: _pageSize,
              onSize: (size) => setState(() => _pageSize = size),
              onOpenInBrowser: _pageForBrowser == null
                  ? null
                  : () => _openInBrowser(_pageForBrowser!),
            ),
            Divider(height: 1, color: AppColors.border),
          ],
          Expanded(
            child: NativeWebViewHost(
              visible: widget.visible,
              child: _body(context),
            ),
          ),
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
                        // The agent's own app, not the package's viewer, while its verdict names one.
                        _browserBar && _agentOrigin != null
                            ? 'Preview'
                            : widget.title,
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
            // Only a webview's navigation sets loading; the placeholder has none.
            if (_viewerLoad.loading)
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
      // No embedded webview here ([webviewAvailable]), so the page it would
      // have shown opens in the browser instead of sitting here as text
      // (openharness#108). Windows 11 ships WebView2, so on Windows this is a
      // computer that has lost it, and it can be had again.
      final page = url == null ? null : Uri.tryParse(url);
      return _Notice(
        key: const ValueKey('web-pane-placeholder'),
        icon: AppIcons.globe,
        title: 'Viewer',
        detail: page == null
            ? 'No viewer yet.'
            : defaultTargetPlatform == TargetPlatform.windows
            ? 'This viewer opens in your browser. Install Microsoft Edge WebView2 to see it here.\n$url'
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
    final width = _browserBar ? _pageSize.width : null;
    return Stack(
      fit: StackFit.expand,
      children: [
        // A phone's or a tablet's width, centred on the pane's own ground, as a browser's device mode. One
        // tree for every size, so changing it resizes the page and never rebuilds its native view.
        LayoutBuilder(
          builder: (context, box) => Center(
            child: SizedBox(
              key: const ValueKey('web-pane-page'),
              width: width != null && width < box.maxWidth
                  ? width
                  : box.maxWidth,
              height: box.maxHeight,
              child: WebViewWidget(controller: controller),
            ),
          ),
        ),
        if (_viewerLoad.failure case final failure?)
          ColoredBox(
            key: const ValueKey('web-pane-waiting'),
            color: grid.AppPalette.windowBg,
            child: _Notice(
              icon: AppIcons.unplug,
              title: 'Waiting for the viewer',
              detail: failure,
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

/// Back, forward, reload, the page's address and the computer's own browser, as a browser's toolbar.
class _BrowserBar extends StatelessWidget {
  const _BrowserBar({
    required this.address,
    required this.focus,
    required this.onReload,
    required this.onSubmit,
    required this.size,
    required this.onSize,
    this.onBack,
    this.onForward,
    this.onOpenInBrowser,
  });

  final TextEditingController address;
  final FocusNode focus;
  final VoidCallback? onBack, onForward, onOpenInBrowser;
  final VoidCallback onReload;
  final ValueChanged<String> onSubmit;
  final _PageSize size;
  final ValueChanged<_PageSize> onSize;

  Widget _button(
    String label,
    Widget icon,
    VoidCallback? onPressed, {
    Key? key,
  }) => Tooltip(
    message: label,
    waitDuration: const Duration(milliseconds: 500),
    child: SizedBox(
      width: 28,
      height: 28,
      child: IconButton(
        key: key,
        padding: EdgeInsets.zero,
        iconSize: 15,
        color: AppColors.text,
        disabledColor: AppColors.mutedStrong.withValues(alpha: 0.45),
        onPressed: onPressed,
        icon: icon,
      ),
    ),
  );

  @override
  Widget build(BuildContext context) {
    return SizedBox(
      key: const ValueKey('web-pane-browser-bar'),
      height: 36,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8),
        child: Row(
          children: [
            _button(
              'Back',
              const Icon(AppIcons.arrowLeft),
              onBack,
              key: const ValueKey('web-pane-back'),
            ),
            _button(
              'Forward',
              const Icon(AppIcons.arrowRight),
              onForward,
              key: const ValueKey('web-pane-forward'),
            ),
            _button(
              'Reload page',
              const AppPaneIcon(AppPaneSymbol.reload, size: 15),
              onReload,
              key: const ValueKey('web-pane-reload-page'),
            ),
            const SizedBox(width: 6),
            Expanded(
              child: Container(
                height: 26,
                padding: const EdgeInsets.symmetric(horizontal: 8),
                decoration: BoxDecoration(
                  color: AppColors.border.withValues(alpha: 0.35),
                  borderRadius: BorderRadius.circular(13),
                ),
                child: Row(
                  children: [
                    Icon(
                      AppIcons.globe,
                      size: 13,
                      color: AppColors.mutedStrong,
                    ),
                    const SizedBox(width: 6),
                    Expanded(
                      child: TextField(
                        key: const ValueKey('web-pane-address'),
                        controller: address,
                        focusNode: focus,
                        maxLines: 1,
                        style: grid.AppType.monoLabel(color: AppColors.text),
                        decoration: const InputDecoration(
                          isCollapsed: true,
                          border: InputBorder.none,
                        ),
                        onSubmitted: onSubmit,
                        onTap: () => address.selection = TextSelection(
                          baseOffset: 0,
                          extentOffset: address.text.length,
                        ),
                      ),
                    ),
                  ],
                ),
              ),
            ),
            const SizedBox(width: 6),
            for (final option in _PageSize.values)
              _button(
                option.label,
                Icon(
                  option.icon,
                  color: option == size
                      ? AppColors.text
                      : AppColors.mutedStrong,
                ),
                option == size ? () {} : () => onSize(option),
                key: ValueKey('web-pane-size-${option.name}'),
              ),
            const SizedBox(width: 2),
            _button(
              'Open in browser',
              const Icon(AppIcons.externalLink),
              onOpenInBrowser,
              key: const ValueKey('web-pane-open-page-in-browser'),
            ),
          ],
        ),
      ),
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
