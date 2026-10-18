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

/// Settings ▸ Tab invites: the invitations to shared tabs waiting for an
/// answer, and the tabs whose owner's computer has a new key.
class TabInvitesSection extends StatefulWidget {
  const TabInvitesSection({super.key, required this.notifier});

  final AppNotifier notifier;

  @override
  State<TabInvitesSection> createState() => _TabInvitesSectionState();
}

class _TabInvitesSectionState extends State<TabInvitesSection> {
  @override
  void initState() {
    super.initState();
    // Read when the panel opens, so an invitation that arrived a moment ago is here.
    unawaited(widget.notifier.sharedTabs.refresh());
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
          builder: (context, _) => _body(context),
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
        return const Text(
          'Turn on "Agents in the same tab can message each other" in Experimental to get invitations.',
        );
      case SharedTabsState.tooOld:
        return UpdateHarnessLine(widget.notifier);
      case SharedTabsState.unsupported:
        return const Text('Shared tabs aren\'t available on the Harness service yet.');
      case SharedTabsState.unavailable:
        return Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            const Text(
              'Harness could not reach this computer. Check that it is online, then try again.',
            ),
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
                onPressed: () => unawaited(showAcceptInvite(context, widget.notifier, invite)),
                child: const Text('Accept'),
              ),
            ),
          ),
        for (final u in snapshot.untrusted)
          DecoratedBox(
            key: Key('tab-invite-untrusted-${u.sharedTabId}'),
            decoration: BoxDecoration(
              color: AppPalette.warn.withValues(alpha: 0.10),
              border: Border.all(color: AppPalette.warn.withValues(alpha: 0.28)),
              borderRadius: BorderRadius.circular(14),
            ),
            child: SettingRow(
              title: '${_line(shortSharedText(u.ownerEmail), 'The owner')}\'s computer has a new key.',
              control: Align(
                alignment: Alignment.centerLeft,
                child: OutlinedButton(
                  key: Key('tab-invite-trust-${u.sharedTabId}'),
                  onPressed: () => unawaited(showTrustAgain(context, widget.notifier, u.sharedTabId)),
                  child: const Text('Trust again'),
                ),
              ),
            ),
          ),
      ],
    );
  }

  static String _line(String text, String fallback) => text.isEmpty ? fallback : text;
}

/// Waiting, drawn in the shape of the answer: rows.
class _Skeleton extends StatelessWidget {
  const _Skeleton();

  @override
  Widget build(BuildContext context) {
    final fill = Theme.of(context).colorScheme.onSurface.withValues(alpha: 0.08);
    return Semantics(
      label: 'Loading invitations',
      child: Column(
        spacing: 10,
        children: [
          for (var i = 0; i < 2; i++)
            DecoratedBox(
              decoration: BoxDecoration(color: fill, borderRadius: BorderRadius.circular(14)),
              child: const SizedBox(height: 64, width: double.infinity),
            ),
        ],
      ),
    );
  }
}
