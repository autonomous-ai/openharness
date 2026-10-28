import 'dart:async';

import 'package:flutter/material.dart';

import '../../agent_messages/shared_tab_dialogs.dart';
import '../../agent_messages/shared_tab_placement.dart' show shortSharedText;
import '../../agent_messages/shared_tabs.dart';
import '../../agent_messages/update_harness.dart';
import '../../shared/theme/app_theme.dart';
import '../../shared/widgets/section_scaffold.dart';
import '../../shared/widgets/setting_row.dart';
import '../../state/app_state.dart';
import '../../super_tabs/model.dart';

/// Settings ▸ Tab invites: the invitations to shared tabs waiting for an
/// answer, and the tabs whose owner's computer has a new key.
class TabInvitesSection extends StatefulWidget {
  const TabInvitesSection({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<TabInvitesSection> createState() => _TabInvitesSectionState();
}

class _TabInvitesSectionState extends State<TabInvitesSection> {
  List<Map<String, dynamic>> _superInvites = [], _superTabs = [];
  String? _superError, _accepting;
  bool _loadingSuper = true;
  Timer? _refreshTimer;
  int _read = 0;
  @override
  void initState() {
    super.initState();
    // Read when the panel opens, so an invitation that arrived a moment ago is here.
    unawaited(widget.notifier.sharedTabs.refresh());
    unawaited(_refreshSuper());
    _refreshTimer = Timer.periodic(
      const Duration(seconds: 15),
      (_) => unawaited(_refreshSuper()),
    );
  }

  @override
  void dispose() {
    _refreshTimer?.cancel();
    super.dispose();
  }

  Future<void> _refreshSuper() async {
    final read = ++_read;
    try {
      final client = widget.notifier.superTabs;
      final answers = await Future.wait([
        client.request('GET', '/api/super-tabs/invitations'),
        client.request('GET', '/api/super-tabs/list'),
      ]);
      if (!mounted || read != _read) return;
      setState(() {
        _superInvites = (answers[0] as List).map(superTabMap).toList();
        _superTabs = (superTabMap(answers[1])['tabs'] as List)
            .map(superTabMap)
            .toList();
        _superError = null;
        _loadingSuper = false;
      });
    } catch (failure) {
      if (mounted && read == _read) {
        setState(() {
          _superError = failure.toString();
          _loadingSuper = false;
        });
      }
    }
  }

  Future<void> _acceptSuper(Map<String, dynamic> invite) async {
    if (_accepting != null) return;
    setState(() => _accepting = invite['inviteId'] as String);
    try {
      final app = widget.notifier;
      final reply = await app.superTabs.map(
        'POST',
        '/api/super-tabs/${invite['tabId']}/commands',
        body: {
          'operationId': 'accept-${invite['inviteId']}',
          'command': {'type': 'invite.accept', 'inviteId': invite['inviteId']},
        },
      );
      final tabId = invite['tabId'] as String;
      final controller = await app.superTabs.open(tabId);
      await controller.refresh();
      final result = superTabMap(reply['result']);
      if (result['conversationId'] is String) {
        controller.select(result['conversationId'] as String);
      }
      if (!mounted) return;
      app.openSuperTab(tabId, invite['name'] as String);
      await _refreshSuper();
      if (mounted) await Navigator.of(context).maybePop();
    } catch (failure) {
      if (mounted) setState(() => _superError = failure.toString());
    } finally {
      if (mounted) setState(() => _accepting = null);
    }
  }

  static String _expires(String iso) {
    final at = DateTime.tryParse(iso)?.toLocal();
    if (at == null) return '';
    String two(int n) => n.toString().padLeft(2, '0');
    return 'Expires ${at.year}-${two(at.month)}-${two(at.day)}';
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return SectionScaffold(
      title: 'Tab invites',
      subtitle: 'People who invited you to a shared tab, and shared tabs that need your trust again.',
      child: SingleChildScrollView(
        child: ListenableBuilder(
          listenable: widget.notifier.sharedTabs,
          builder: (context, _) => Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              if (_loadingSuper) const LinearProgressIndicator(),
              if (_superError != null)
                SettingRow(
                  title: 'Could not load Swarms',
                  detail: _superError,
                  control: TextButton(
                    onPressed: _refreshSuper,
                    child: const Text('Retry'),
                  ),
                ),
              for (final invite in _superInvites)
                SettingRow(
                  title: invite['name'] as String,
                  detail:
                      'Swarm · ${invite['role'] == 'viewer' ? 'Can view' : 'Can collaborate'}',
                  control: FilledButton(
                    onPressed: _accepting == null
                        ? () => _acceptSuper(invite)
                        : null,
                    child: Text(
                      _accepting == invite['inviteId'] ? 'Joining…' : 'Accept',
                    ),
                  ),
                ),
              for (final tab in _superTabs)
                SettingRow(
                  title: tab['name'] as String,
                  detail: 'Swarm',
                  control: TextButton(
                    onPressed: () {
                      widget.notifier.openSuperTab(
                        tab['id'] as String,
                        tab['name'] as String,
                      );
                      Navigator.of(context).maybePop();
                    },
                    child: const Text('Open'),
                  ),
                ),
              _body(context),
            ],
          ),
        ),
      ),
    );
  }

  Widget _body(BuildContext context) {
    final shares = widget.notifier.sharedTabs;
    final snapshot = shares.snapshot;
    switch (shares.state) {
      case SharedTabsState.unknown:
        return const _Skeleton();
      case SharedTabsState.off:
        return _superInvites.isEmpty && !_loadingSuper && _superError == null
            ? const Text('No invitations.')
            : const SizedBox.shrink();
      case SharedTabsState.tooOld:
        return UpdateHarnessLine(widget.notifier);
      case SharedTabsState.unsupported:
        return const Text(
          'Shared tabs aren\'t available on the Harness service yet.',
        );
      case SharedTabsState.unavailable:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Text(unreachableComputer),
            TextButton(
              onPressed: () => unawaited(shares.refresh()),
              child: const Text('Try again'),
            ),
          ],
        );
      case SharedTabsState.ready:
        break;
    }
    if (snapshot.invites.isEmpty && snapshot.untrusted.isEmpty) {
      return const Text('No invitations.');
    }
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      spacing: 10,
      children: [
        for (final invite in snapshot.invites)
          SettingRow(
            title: _line(shortSharedText(invite.tabName), 'A tab'),
            detail: [
              _line(shortSharedText(invite.ownerEmail), 'Someone'),
              _expires(invite.expiresAt),
            ].where((s) => s.isNotEmpty).join(' · '),
            control: Align(
              alignment: Alignment.centerLeft,
              child: FilledButton(
                key: Key('tab-invite-accept-${invite.id}'),
                onPressed: () => unawaited(
                  showAcceptInvite(context, widget.notifier, invite),
                ),
                child: const Text('Accept'),
              ),
            ),
          ),
        for (final u in snapshot.untrusted)
          DecoratedBox(
            key: Key('tab-invite-untrusted-${u.sharedTabId}'),
            decoration: BoxDecoration(
              color: AppPalette.warn.withValues(alpha: 0.10),
              border: Border.all(
                color: AppPalette.warn.withValues(alpha: 0.28),
              ),
              borderRadius: BorderRadius.circular(14),
            ),
            child: SettingRow(
              title:
                  '${_line(shortSharedText(u.ownerEmail), 'The owner')}\'s computer has a new key.',
              control: Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton(
                  key: Key('tab-invite-trust-${u.sharedTabId}'),
                  onPressed: () => unawaited(
                    showTrustAgain(context, widget.notifier, u.sharedTabId),
                  ),
                  child: const Text('Trust again'),
                ),
              ),
            ),
          ),
      ],
    );
  }

  static String _line(String text, String fallback) =>
      text.isEmpty ? fallback : text;
}

/// Waiting, drawn in the shape of the answer: rows.
class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) {
    final fill = Theme.of(context).colorScheme.onSurface
        .withValues(alpha: 0.08);
    return Semantics(
      label: 'Loading invitations',
      child: Column(
        spacing: 10,
        children: [
          for (var i = 0; i < 2; i++)
            DecoratedBox(
              decoration: BoxDecoration(
                color: fill,
                borderRadius: BorderRadius.circular(14),
              ),
              child: const SizedBox(height: 64, width: double.infinity),
            ),
        ],
      ),
    );
  }
}
