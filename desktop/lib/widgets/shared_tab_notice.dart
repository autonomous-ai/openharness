import 'dart:async';
import 'dart:convert';

import 'package:flutter/material.dart';
import 'package:harness/shared/theme/app_icons.dart';

import '../agent_messages/shared_tab_errors.dart';
import '../agent_messages/shared_tab_placement.dart' show shortSharedText;
import '../agent_messages/shared_tabs.dart';
import '../agent_messages/shared_tabs_model.dart' as model;
import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import 'window_chrome.dart';

/// The band across the top of the window for shared tabs: a new invitation
/// ("Alice invited you to the tab "app"" with View, once per invitation on
/// this computer), then what the daemon reports (removed, full, refused,
/// unsent, relay taken). One at a time.
class SharedTabNotice extends StatefulWidget {
  const SharedTabNotice({super.key, required this.notifier});

  final AppNotifier notifier;

  /// Whether the band has anything to say right now (so the shell can leave
  /// it out of the column when it has not).
  static bool hasWork(AppNotifier app) =>
      app.sharedTabs.snapshot.invites.isNotEmpty ||
      app.sharedTabs.snapshot.notices.isNotEmpty;

  /// The invitation notice's copy; an older backend names no tab.
  static String inviteText(model.SharedTabInvite invite) {
    final owner = shortSharedText(invite.ownerEmail);
    final name = shortSharedText(invite.tabName);
    return '${owner.isEmpty ? 'Someone' : owner} invited you to ${name.isEmpty ? 'a tab' : 'the tab "$name"'}';
  }

  /// A daemon notice in words: what happened, and what to do.
  static String noticeText(model.SharedTabNotice notice, model.SharedTabsSnapshot snapshot) {
    final tab = snapshot.tabs.where((t) => t.sharedTabId == notice.sharedTabId).firstOrNull;
    final owner = shortSharedText(notice.ownerEmail ?? tab?.ownerEmail ?? '');
    return switch (notice.kind) {
      'removed' =>
        'You were removed from ${owner.isEmpty ? 'a' : '$owner\'s'} tab',
      'full' => sharedTabErrorText(const SharedTabsFailure('TAB_FULL', '')),
      'relay_taken' => sharedTabErrorText(const SharedTabsFailure('RELAY_TAKEN', '')),
      'unsent' || 'refused' => notice.error == null
          ? 'A message to a shared tab was not sent. Try again in a moment.'
          : sharedTabErrorText(SharedTabsFailure(notice.error!, '')),
      _ => 'Something changed in a shared tab.',
    };
  }

  @override
  State<SharedTabNotice> createState() => _SharedTabNoticeState();
}

class _SharedTabNoticeState extends State<SharedTabNotice> {
  Set<String>? _seen;
  String? _seenAccount, _loading, _current;

  @override
  void initState() {
    super.initState();
    widget.notifier.sharedTabs.addListener(_changed);
  }

  @override
  void didUpdateWidget(SharedTabNotice old) {
    super.didUpdateWidget(old);
    if (old.notifier != widget.notifier) {
      old.notifier.sharedTabs.removeListener(_changed);
      widget.notifier.sharedTabs.addListener(_changed);
    }
  }

  @override
  void dispose() {
    widget.notifier.sharedTabs.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  /// One invitation as remembered: the backend reuses an invitation's id when
  /// the owner invites the same email to the same tab again, but gives it a
  /// new expiry, so id + expiry tells a re-invitation from the one already shown.
  static String _inviteKey(model.SharedTabInvite i) => '${i.id}|${i.expiresAt}';

  static String _key(String account) => 'shared_tabs.invites_seen.$account';

  Future<void> _load(String account) async {
    if (_loading == account) return;
    _loading = account;
    var seen = <String>{};
    try {
      final raw = await widget.notifier.deviceLibraryStorage?.read(_key(account));
      final json = raw == null ? null : jsonDecode(raw);
      if (json is List) seen = {...json.whereType<String>()};
    } catch (_) {}
    if (!mounted) return;
    setState(() {
      _seen = seen;
      _seenAccount = account;
      _loading = null;
    });
  }

  void _remember(String account, String id) {
    final seen = _seen!..add(id);
    final list = seen.toList();
    // Old ids go: an invitation lives for days, not for the life of the account.
    final kept = list.length > 200 ? list.sublist(list.length - 200) : list;
    unawaited(
      Future(() async {
        try {
          await widget.notifier.deviceLibraryStorage?.write(_key(account), jsonEncode(kept));
        } catch (_) {}
      }),
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final shares = widget.notifier.sharedTabs;
    final snapshot = shares.snapshot;
    final account = snapshot.me?.accountId;
    if (account == null) return const SizedBox.shrink();
    if (_seenAccount != account) {
      _seen = null;
      _current = null;
      unawaited(_load(account));
      return const SizedBox.shrink();
    }
    model.SharedTabInvite? invite;
    final live = snapshot.invites.where((i) => _inviteKey(i) == _current).firstOrNull;
    if (live != null) {
      invite = live;
    } else {
      _current = null;
      invite = snapshot.invites.where((i) => !_seen!.contains(_inviteKey(i))).lastOrNull;
      if (invite != null) {
        final id = _current = _inviteKey(invite);
        // Recorded after the frame: build has no side effects of its own.
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && _seenAccount == account) _remember(account, id);
        });
      }
    }
    final notice = invite == null ? snapshot.notices.firstOrNull : null;
    if (invite == null && notice == null) return const SizedBox.shrink();
    final text = invite != null
        ? SharedTabNotice.inviteText(invite)
        : SharedTabNotice.noticeText(notice!, snapshot);
    final tint = Color.alphaBlend(
      grid.AppPalette.warn.withValues(alpha: 0.10),
      grid.AppPalette.windowBg,
    );
    return WindowDragArea(
      child: Material(
        color: Colors.transparent,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: tint,
            border: Border(
              bottom: BorderSide(color: grid.AppPalette.warn.withValues(alpha: 0.28)),
            ),
          ),
          child: Padding(
            padding: EdgeInsets.fromLTRB(14 + trafficLightClearance, 7, 10, 7),
            child: Row(
              children: [
                Icon(AppIcons.users, size: 16, color: grid.AppPalette.warn),
                const SizedBox(width: 10),
                Expanded(
                  child: Text(
                    text,
                    key: const Key('shared-tab-notice'),
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: grid.AppType.body(color: grid.AppPalette.textPrimary),
                  ),
                ),
                const SizedBox(width: 12),
                TextButton(
                  key: const Key('shared-tab-notice-dismiss'),
                  onPressed: () {
                    if (invite != null) {
                      setState(() => _current = null);
                    } else {
                      unawaited(shares.dismiss(notice!.id));
                    }
                  },
                  child: Text(invite != null ? 'Not now' : 'Got it'),
                ),
                if (invite != null) ...[
                  const SizedBox(width: 6),
                  OutlinedButton(
                    key: const Key('shared-tab-notice-view'),
                    onPressed: () {
                      setState(() => _current = null);
                      widget.notifier.requestSharedTabs();
                    },
                    child: const Text('View'),
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}
