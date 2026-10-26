import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/link.dart';
import 'package:url_launcher/url_launcher.dart';

import '../core/models.dart';
import '../measurement/hub_usage.dart';
import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/empty_state.dart';
import '../state/app_state.dart';
import '../state/terminal_pane.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/web_download_button.dart';
import 'shared_agent_location.dart';
import 'shared_harness_panel.dart';
import 'shared_link_state.dart';

/// Public landing and private recipient view, using the same encrypted renderer as desktop.
/// It does not add a machine, receive a peer key, or restore the visitor's workspace.
/// It counts, as the Hub does ([HubUsage]), the page drawn, what the link showed, how long a live
/// harness stayed in view and the clicks on it; never the link, its key, the harness or the reader.
class SharedAgentPage extends StatefulWidget {
  const SharedAgentPage({
    super.key,
    required this.app,
    required this.location,
    this.dio,
    this.usage,
    this.openHarness,
  });
  final AppNotifier app;
  final SharedAgentLocation location;
  final Dio? dio;

  /// Tests pass their own; the page otherwise counts into the app's [hubUsage].
  final HubUsage? usage;

  /// Opens the Harness app at this site's root; a test passes its own.
  final Future<void> Function()? openHarness;
  @override
  State<SharedAgentPage> createState() => _SharedAgentPageState();
}

class _SharedAgentPageState extends State<SharedAgentPage> {
  late final _dio =
      widget.dio ??
      Dio(
        BaseOptions(
          connectTimeout: const Duration(seconds: 15),
          receiveTimeout: const Duration(seconds: 20),
          validateStatus: (_) => true,
        ),
      );
  Map<String, dynamic>? _data;
  SharedLinkProblem? _problem;
  bool _loading = true;
  int _revision = 0;
  Timer? _offlineRetry;
  late bool _signedIn = widget.app.status == AppStatus.authenticated;
  late final _usage = widget.usage ?? hubUsage;
  bool _viewCounted = false;
  final _opens = <SharedOpen>{};
  VisibleTime? _dwell;
  @override
  void initState() {
    super.initState();
    _usage.accessToken = _accessToken;
    _countView();
    unawaited(_load());
  }

  /// A staging link or account is the team's own, not a reader's.
  bool get _measured =>
      widget.location.environment != 'stag' &&
      widget.app.config.autonomousEnv != 'stag';

  void _count(String metric) {
    if (_measured) _usage.count(metric);
  }

  void _countAction(SharedAction action) => _count(action.metric);

  /// Once per page, as soon as it is known whether the reader is signed in.
  void _countView() {
    final status = widget.app.status;
    if (_viewCounted ||
        (status != AppStatus.authenticated &&
            status != AppStatus.unauthenticated)) {
      return;
    }
    _viewCounted = true;
    _count(sharedViewMetric(member: status == AppStatus.authenticated));
  }

  void _countOpen(SharedOpen open) {
    if (_opens.add(open)) _count(open.metric);
    // Counted, then sent with the rest, as the page goes or the panel leaves.
    if (open == SharedOpen.live) {
      _dwell ??= VisibleTime((shown) {
        _count(sharedDwellMetric(shown));
        _usage.flush();
      });
    }
  }

  Future<String?> _accessToken() async {
    final auth = widget.app.viewer?.auth;
    return auth != null && await auth.hasSession()
        ? await auth.accessToken()
        : null;
  }

  void _signIn() {
    _countAction(SharedAction.signInClick);
    unawaited(widget.app.login());
  }

  void _retry() {
    _countAction(SharedAction.retry);
    unawaited(_load());
  }

  void _openHarness() => unawaited(
    (widget.openHarness ?? _openHarnessHere)().catchError((Object _) {}),
  );

  static Future<void> _openHarnessHere() => launchUrl(
    SharedAgentLocation.workspaceOf(Uri.base),
    webOnlyWindowName: '_self',
  );

  @override
  void didUpdateWidget(SharedAgentPage oldWidget) {
    super.didUpdateWidget(oldWidget);
    _countView();
    final signedIn = widget.app.status == AppStatus.authenticated;
    if (signedIn != _signedIn || oldWidget.location.id != widget.location.id) {
      _signedIn = signedIn;
      unawaited(_load());
    }
  }

  @override
  void dispose() {
    _revision++;
    _offlineRetry?.cancel();
    _dwell?.finish();
    _usage.accessToken = null;
    if (widget.dio == null) _dio.close(force: true);
    super.dispose();
  }

  void _show(SharedLinkProblem problem) => setState(() {
    _loading = false;
    _problem = problem;
  });

  Future<void> _load() async {
    _offlineRetry?.cancel();
    final revision = ++_revision;
    setState(() {
      _loading = true;
      _data = null;
      _problem = null;
    });
    final key = widget.location.ownerKey;
    if (key == null || !RegExp(r'^[A-Za-z0-9+/]{43}=$').hasMatch(key)) {
      // Nothing to ask the server: only a whole link can open.
      _countOpen(SharedOpen.failed);
      _show(SharedLinkProblem.incomplete);
      return;
    }
    try {
      final token = await _accessToken();
      final response = await _dio.get(
        '${widget.app.config.apiBaseUrl}/api/shared-agents/${widget.location.id}',
        options: Options(
          headers: {
            'x-autonomous-env': widget.location.environment,
            if (token != null) 'Authorization': 'Bearer $token',
          },
        ),
      );
      if (!mounted || revision != _revision) return;
      final status = response.statusCode;
      if (status == 401 || status == 403 || status == 404) {
        _countOpen(status == 401 ? SharedOpen.private : SharedOpen.noAccess);
        // Signed in already, a refusal is never a reason to sign in again:
        // that would send the reader round the sign-in for the same answer.
        _show(
          status == 401 && !_signedIn
              ? SharedLinkProblem.private
              : SharedLinkProblem.refused,
        );
        return;
      }
      if (status != 200) throw StateError('shared link read: $status');
      final data = Map<String, dynamic>.from(response.data['data'] as Map);
      if (data['ownerPublicKey'] != key) {
        _countOpen(SharedOpen.failed);
        _show(SharedLinkProblem.changed);
        return;
      }
      if (data['online'] != true) {
        _countOpen(SharedOpen.offline);
        _show(SharedLinkProblem.offline);
        _offlineRetry = Timer(
          const Duration(seconds: 10),
          () => unawaited(_load()),
        );
        return;
      }
      _countOpen(SharedOpen.live);
      setState(() {
        _data = data;
        _loading = false;
      });
    } catch (_) {
      if (mounted && revision == _revision) {
        _countOpen(SharedOpen.failed);
        _show(SharedLinkProblem.failed);
      }
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final data = _data;
    return Scaffold(
      backgroundColor: grid.AppPalette.windowBg,
      body: SafeArea(
        child: Column(
          children: [
            Padding(
              padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 8),
              child: SizedBox(
                width: double.infinity,
                child: Wrap(
                  spacing: 16,
                  runSpacing: 8,
                  alignment: WrapAlignment.spaceBetween,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  children: [
                    // The product page, in a new tab: a visitor keeps the
                    // harness they were shown open behind it.
                    Link(
                      uri: harnessAppPage,
                      target: LinkTarget.blank,
                      builder: (context, follow) => DesktopPill(
                        label: 'Harness',
                        quiet: true,
                        onPressed: follow == null
                            ? null
                            : () {
                                _countAction(SharedAction.productPage);
                                follow();
                              },
                      ),
                    ),
                    // A phone's download is the store bar's.
                    if (!browserHasAppStore())
                      WebDownloadButton(
                        open: (uri) {
                          _countAction(SharedAction.getApp);
                          return openInNewTab(uri);
                        },
                      ),
                  ],
                ),
              ),
            ),
            Expanded(
              child: data != null
                  ? SharedHarnessPanel(
                      key: ValueKey('${widget.location.id}:$_signedIn'),
                      notifier: widget.app,
                      pane: TerminalPane(
                        id: -1,
                        machineId: data['machineId'] as String,
                        agentId: data['agentId'] as String,
                      ),
                      grant: SharedHarness(
                        id: widget.location.id,
                        agentId: data['agentId'] as String,
                        name: data['name'] as String,
                        engine: data['engine'] as String?,
                        expiresAt: DateTime.utc(9999),
                        ownerPublicKey: widget.location.ownerKey,
                      ),
                      hasAccess: true,
                      visible: true,
                      link: true,
                      linkEnvironment: widget.location.environment,
                      onClose: () => setState(() {
                        _data = null;
                        _problem = SharedLinkProblem.paused;
                      }),
                      onSignIn: _signedIn ? null : _signIn,
                      onUsage: _countAction,
                    )
                  : _loading
                  ? const EmptyState(
                      icon: AppIcons.link2,
                      title: 'Opening shared harness…',
                    )
                  : SharedLinkState(
                      problem: _problem ?? SharedLinkProblem.failed,
                      email: widget.app.currentUser?.email,
                      signingIn: widget.app.signingIn,
                      signInError: widget.app.lastError,
                      onSignIn: _signIn,
                      onSwitchAccount: () => unawaited(widget.app.logout()),
                      onRetry: _retry,
                      onOpenHarness: _openHarness,
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
