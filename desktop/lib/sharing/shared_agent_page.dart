import 'dart:async';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:url_launcher/link.dart';

import '../core/models.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../state/terminal_pane.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/web_download_button.dart';
import 'shared_agent_location.dart';
import 'shared_harness_panel.dart';

/// Public landing and private recipient view, using the same encrypted renderer as desktop.
/// It does not add a machine, receive a peer key, or restore the visitor's workspace.
class SharedAgentPage extends StatefulWidget {
  const SharedAgentPage({
    super.key,
    required this.app,
    required this.location,
    this.dio,
  });
  final AppNotifier app;
  final SharedAgentLocation location;
  final Dio? dio;
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
  String? _error;
  bool _loading = true, _signInRequired = false;
  int _revision = 0;
  Timer? _offlineRetry;
  late bool _signedIn = widget.app.status == AppStatus.authenticated;
  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void didUpdateWidget(SharedAgentPage oldWidget) {
    super.didUpdateWidget(oldWidget);
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
    if (widget.dio == null) _dio.close(force: true);
    super.dispose();
  }

  Future<void> _load() async {
    _offlineRetry?.cancel();
    final revision = ++_revision;
    setState(() {
      _loading = true;
      _data = null;
      _error = null;
      _signInRequired = false;
    });
    try {
      final key = widget.location.ownerKey;
      if (key == null || !RegExp(r'^[A-Za-z0-9+/]{43}=$').hasMatch(key)) {
        throw const FormatException(
          'This link is incomplete. Ask the owner to copy the full link again.',
        );
      }
      final auth = widget.app.viewer?.auth;
      final token = auth != null && await auth.hasSession()
          ? await auth.accessToken()
          : null;
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
      if (response.statusCode != 200) {
        setState(() {
          _signInRequired = response.statusCode == 401;
          _error = _signInRequired
              ? 'This link is private. Sign in with an invited email.'
              : 'This link is unavailable or your email has not been invited. Ask the owner for access.';
          _loading = false;
        });
        return;
      }
      final data = Map<String, dynamic>.from(response.data['data'] as Map);
      if (data['ownerPublicKey'] != key) {
        throw const FormatException(
          'The owner identity has changed. Ask the owner for a new link.',
        );
      }
      if (data['online'] != true) {
        setState(() {
          _loading = false;
          _error = 'The owner’s machine is offline. This page reconnects when it comes back.';
        });
        _offlineRetry = Timer(
          const Duration(seconds: 10),
          () => unawaited(_load()),
        );
        return;
      }
      setState(() {
        _data = data;
        _loading = false;
      });
    } catch (error) {
      if (mounted && revision == _revision) {
        setState(() {
          _loading = false;
          _error = error is FormatException ? error.message : 'Could not open this link. Check your connection and try again.';
        });
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
                        onPressed: follow,
                      ),
                    ),
                    const WebDownloadButton(),
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
                        _error = 'Viewing paused.';
                      }),
                      onSignIn: _signedIn
                          ? null
                          : () => unawaited(widget.app.login()),
                    )
                  : Center(
                      child: SingleChildScrollView(
                        padding: const EdgeInsets.all(24),
                        child: ConstrainedBox(
                          constraints: const BoxConstraints(maxWidth: 440),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Text(
                                _loading
                                    ? 'Opening shared harness…'
                                    : 'Shared harness',
                                style: DesktopChrome.heading(),
                                textAlign: TextAlign.center,
                              ),
                              if (!_loading) ...[
                                const SizedBox(height: 12),
                                Semantics(
                                  liveRegion: true,
                                  child: Text(
                                    _error ?? 'Shared harness',
                                    style: DesktopChrome.text(
                                      size: 13,
                                      color: DesktopChrome.muted,
                                    ),
                                    textAlign: TextAlign.center,
                                  ),
                                ),
                              ],
                              if (widget.app.lastError != null) ...[
                                const SizedBox(height: 12),
                                Text(
                                  widget.app.lastError!,
                                  style: DesktopChrome.text(
                                    size: 13,
                                    color: Theme.of(context).colorScheme.error,
                                  ),
                                  textAlign: TextAlign.center,
                                ),
                              ],
                              const SizedBox(height: 20),
                              Wrap(
                                spacing: 8,
                                runSpacing: 8,
                                alignment: WrapAlignment.center,
                                children: [
                                  if (_signInRequired)
                                    DesktopPill(
                                      label: widget.app.signingIn
                                          ? 'Signing in…'
                                          : 'Sign in',
                                      onPressed: widget.app.signingIn
                                          ? null
                                          : () => unawaited(widget.app.login()),
                                    ),
                                  if (!_loading && !_signInRequired)
                                    DesktopPill(
                                      label: 'Retry',
                                      onPressed: _load,
                                    ),
                                  if (!_loading && _signedIn && _data == null)
                                    DesktopPill(
                                      label: 'Switch account',
                                      onPressed: () =>
                                          unawaited(widget.app.logout()),
                                    ),
                                ],
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
            ),
          ],
        ),
      ),
    );
  }
}
