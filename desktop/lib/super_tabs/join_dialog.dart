import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';
import 'controller.dart';
import 'join_link.dart';

/// The native URL channel queues links before authentication. This host only
/// presents them after sign-in and never joins on the person's behalf.
class SwarmJoinHost extends StatefulWidget {
  const SwarmJoinHost({super.key, required this.app, required this.child});
  final AppNotifier app;
  final Widget child;

  @override
  State<SwarmJoinHost> createState() => _SwarmJoinHostState();
}

class _SwarmJoinHostState extends State<SwarmJoinHost> {
  bool _presenting = false;

  @override
  void initState() {
    super.initState();
    swarmJoinInbox.addListener(_schedule);
    widget.app.addListener(_schedule);
    _schedule();
  }

  void _schedule() {
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(_next());
    });
    WidgetsBinding.instance.ensureVisualUpdate();
  }

  Future<void> _next() async {
    final app = widget.app;
    final account = app.currentUser;
    if (!mounted ||
        _presenting ||
        swarmJoinInbox.pending.isEmpty ||
        app.status != AppStatus.authenticated ||
        account?.id == null) {
      return;
    }
    final accountId = account!.id!;
    final link = swarmJoinInbox.pending.first;
    bool current() =>
        mounted &&
        app.status == AppStatus.authenticated &&
        app.currentUser?.id == accountId;
    _presenting = true;
    try {
      await showAppDialog<void>(
        context: context,
        builder: (context) => ListenableBuilder(
          listenable: app,
          builder: (context, _) => current()
              ? SwarmJoinDialog(
                  link: link,
                  accountEmail: account.email,
                  request: app.superTabs.map,
                  isCurrent: current,
                  onJoined: (id, name) {
                    if (!current()) return;
                    app.openSuperTab(id, name);
                    // Joined by the person at this Mac: macOS asks once for
                    // the Harness Team account (cli/src/team/autoSetup.ts).
                    unawaited(app.offerTeamAccount('join'));
                  },
                )
              : AlertDialog(
                  content: const Text('Sign in again to open this Swarm link.'),
                  actions: [
                    TextButton(
                      onPressed: () => Navigator.pop(context),
                      child: const Text('Close'),
                    ),
                  ],
                ),
        ),
      );
    } finally {
      swarmJoinInbox.complete(link);
      _presenting = false;
      if (mounted) _schedule();
    }
  }

  @override
  void dispose() {
    swarmJoinInbox.removeListener(_schedule);
    widget.app.removeListener(_schedule);
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

class SwarmJoinDialog extends StatefulWidget {
  const SwarmJoinDialog({
    super.key,
    required this.link,
    required this.accountEmail,
    required this.request,
    required this.onJoined,
    required this.isCurrent,
  });
  final SwarmJoinLink link;
  final String accountEmail;
  final SuperTabRequest request;
  final void Function(String id, String name) onJoined;
  final bool Function() isCurrent;

  @override
  State<SwarmJoinDialog> createState() => _SwarmJoinDialogState();
}

class _SwarmJoinDialogState extends State<SwarmJoinDialog> {
  final _operationId = superTabOperationId();
  Map<String, dynamic>? _preview;
  bool _loading = true, _joining = false;
  String? _error;
  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(widget.link.tabId)}/join';
  Map<String, dynamic> get _token => {
    if (widget.link.token != null) 'token': widget.link.token,
  };
  bool get _current => mounted && widget.isCurrent();

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  Future<void> _load() async {
    if (!_current) return;
    setState(() {
      _loading = true;
      _error = null;
    });
    try {
      // A token belongs in the request body, never an HTTP URL or proxy log.
      final preview = await widget.request(
        'POST',
        '$_path/preview',
        body: _token,
      );
      if (!_current) return;
      if (preview['id'] != widget.link.tabId ||
          preview['name'] is! String ||
          !const [
            'owner',
            'collaborator',
            'viewer',
          ].contains(preview['role'])) {
        throw const FormatException('Invalid invitation');
      }
      setState(() => _preview = preview);
    } catch (failure) {
      if (_current) setState(() => _error = _errorMessage(failure));
    } finally {
      if (_current) setState(() => _loading = false);
    }
  }

  Future<void> _join() async {
    if (!_current || _joining || _preview == null) return;
    setState(() {
      _joining = true;
      _error = null;
    });
    try {
      if (_preview!['alreadyMember'] != true) {
        final result = await widget.request(
          'POST',
          _path,
          body: {'operationId': _operationId, ..._token},
        );
        if (!_current) return;
        if (result['id'] != widget.link.tabId) {
          throw const FormatException('Invalid invitation');
        }
      }
      if (!_current) return;
      widget.onJoined(widget.link.tabId, _preview!['name'] as String);
      if (mounted) Navigator.pop(context);
    } catch (failure) {
      if (_current) setState(() => _error = _errorMessage(failure));
    } finally {
      if (_current) setState(() => _joining = false);
    }
  }

  String _errorMessage(Object failure) {
    if (failure is SuperTabFailure) {
      if (const {
        'FORBIDDEN',
        'NOT_FOUND',
        'INVALID_LINK',
        'LINK_REVOKED',
        'JOIN_UNAVAILABLE',
      }.contains(failure.code)) {
        return 'This link is unavailable for your account. Ask the owner for an invitation.';
      }
      if (failure.code == 'SIGNED_OUT' || failure.code == 'ACCOUNT_CHANGED') {
        return 'Sign in again to open this Swarm link.';
      }
    }
    return 'Could not open this Swarm. Check your connection and try again.';
  }

  @override
  Widget build(BuildContext context) => DesktopPromptSurface(
    body: DesktopPromptScrollBody(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          DesktopDialogHeader(
            title: _preview?['alreadyMember'] == true
                ? 'Open Swarm'
                : 'Join Swarm',
            padding: EdgeInsets.zero,
            onClose: () => Navigator.pop(context),
          ),
          const SizedBox(height: 16),
          if (_loading)
            const LinearProgressIndicator()
          else if (_preview case final preview?) ...[
            Text(preview['name'] as String, style: DesktopChrome.heading()),
            const SizedBox(height: 8),
            Text(
              preview['alreadyMember'] == true
                  ? 'You’re already a member.'
                  : preview['role'] == 'viewer'
                  ? 'You’ll be able to view shared projects.'
                  : 'You’ll be able to collaborate on shared projects.',
              style: DesktopChrome.text(),
            ),
          ],
          const SizedBox(height: 12),
          Text(widget.accountEmail, style: DesktopChrome.metadata()),
          if (_error != null) ...[
            const SizedBox(height: 12),
            Text(_error!, style: DesktopChrome.text()),
          ],
        ],
      ),
    ),
    actions: [
      FilledButton(
        key: const Key('swarm-join-confirm'),
        onPressed: _loading || _joining
            ? null
            : _preview == null
            ? _load
            : _join,
        child: Text(
          _joining
              ? 'Joining…'
              : _preview == null
              ? 'Retry'
              : _preview!['alreadyMember'] == true
              ? 'Open Swarm'
              : 'Join Swarm',
        ),
      ),
    ],
  );
}
