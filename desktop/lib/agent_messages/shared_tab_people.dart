import 'dart:async';

import 'package:flutter/material.dart';

import '../core/models.dart' show ConnectionStatus;
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'shared_tab_dialogs.dart';
import 'shared_tab_errors.dart';
import 'shared_tab_placement.dart' show plainSharedText, shortSharedText;
import 'shared_tabs.dart';
import 'shared_tabs_model.dart';

/// The plain words for a warning about a shared tab (1c spec, Errors).
String sharedTabAlertText(String code) => switch (code) {
  'foreign_machine' => 'The tab lists a computer as yours that isn\'t.',
  'machine_key_mismatch' =>
    'A computer in this tab changed its key; its harnesses were left out.',
  'own_machine_listed' => 'The tab lists one of your computers under another account; it was left out.',
  'bad_signature' => 'A change to this tab wasn\'t signed by its owner\'s computer, so it was ignored.',
  'unpinned_key' =>
    'This tab is signed by a computer you haven\'t trusted yet.',
  'share_id_mismatch' => 'The Harness service named this tab differently than expected, so this computer didn\'t sign for it.',
  _ => 'Something about this tab couldn\'t be verified.',
};

/// Make Leader or Remove Leader as the app says, answering the words of a new
/// failure (the app keeps the old leader and sets [AppNotifier.lastError]), or
/// null. One path for the shared and the unshared People.
Future<String?> toggleLeaderReportingError(
  AppNotifier app,
  String machineId,
  String agentId,
) async {
  final before = app.lastError;
  await app.toggleLeaderOf(machineId, agentId);
  final after = app.lastError;
  return after != null && after != before ? after : null;
}

const _onlyOwner = 'Only the computer that shares this tab can change it.';
const _ownerElsewhere =
    'Only the computer that shares this tab can change who is in it. '
    'Stop Sharing and Move here work from any of your computers.';

/// People: who is in a shared tab and the harnesses each brought, with the
/// warnings about the tab first. Strings from another account are plain text,
/// one line, ellipsized.
class SharedTabPeople extends StatefulWidget {
  const SharedTabPeople({
    super.key,
    required this.app,
    required this.sharedTabId,
    required this.deskTabId,
  });

  final AppNotifier app;
  final String sharedTabId, deskTabId;

  @override
  State<SharedTabPeople> createState() => _SharedTabPeopleState();
}

class _SharedTabPeopleState extends State<SharedTabPeople> {
  Map<String, ({String? project, String? branch})>? _who;
  String _whoFor = '';
  int _whoReads = 0;
  String? _error;
  bool _busy = false;
  late final _listenable = Listenable.merge([
    widget.app,
    widget.app.sharedTabs,
    widget.app.experimentalFeatures,
  ]);

  @override
  void initState() {
    super.initState();
  }

  /// Asks `who` again whenever the tab's harnesses change; an answer that
  /// arrives after a newer ask, or after the panel is gone, is dropped. A
  /// failed ask answers empty: the skeleton stops and nothing shows.
  Future<void> _load() async {
    final read = ++_whoReads;
    final who = await widget.app.sharedTabs.who(widget.sharedTabId);
    if (mounted && read == _whoReads) setState(() => _who = who);
  }

  Future<void> _run(Future<void> Function() action, {String? machine}) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await action();
    } on SharedTabsFailure catch (f) {
      if (mounted) {
        setState(() => _error = sharedTabErrorText(f, machine: machine));
      }
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _toggleLeader(String machineId, String agentId) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final error = await toggleLeaderReportingError(
        widget.app,
        machineId,
        agentId,
      );
      if (mounted && error != null) setState(() => _error = error);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  String _machineName(String machineId, {required bool mine}) {
    final state = widget.app.machineStates[machineId];
    if (mine && state != null && !state.belongsToOtherAccount) {
      final name = shortSharedText(state.machine.displayName, 24);
      if (name.isNotEmpty) return name;
    }
    return machineId.length <= 8 ? machineId : machineId.substring(0, 8);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: _listenable,
      builder: (context, _) => _content(context),
    );
  }

  Widget _content(BuildContext context) {
    final app = widget.app;
    final shares = app.sharedTabs;
    final tab = shares.tabForDesk(widget.deskTabId);
    final snapshot = shares.snapshot;
    final me = snapshot.me;
    if (tab == null || me == null) return const SizedBox.shrink();
    final harnessKeys = ([
      for (final h in tab.harnesses) h.key,
    ]..sort()).join('\n');
    if (harnessKeys != _whoFor) {
      _whoFor = harnessKeys;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted) unawaited(_load());
      });
    }
    final ownerHere =
        tab.ownedBy(me.accountId) && tab.ownerMachineId == me.machineId;
    final ownMachines = {
      me.machineId,
      for (final s in app.machineStates.values)
        if (!s.belongsToOtherAccount) s.machine.machineId,
    };
    final alerts = [
      for (final a in snapshot.alerts)
        if (a.sharedTabId == tab.sharedTabId) a,
    ];
    final relay = [
      for (final n in snapshot.notices)
        if (n.sharedTabId == tab.sharedTabId && n.kind == 'relay_taken') n,
    ];
    final untrusted = [
      for (final u in snapshot.untrusted)
        if (u.sharedTabId == tab.sharedTabId) u,
    ];
    final ownerName = _nameOf(tab.members, tab.ownerAccountId);
    final accounts =
        <({String accountId, String email, String name, bool owner})>[
          (
            accountId: tab.ownerAccountId,
            email: tab.ownerEmail,
            name: ownerName,
            owner: true,
          ),
          for (final m in tab.members)
            if (m.accountId != tab.ownerAccountId)
              (
                accountId: m.accountId,
                email: m.email,
                name: m.name,
                owner: false,
              ),
          for (final id in {for (final h in tab.harnesses) h.accountId})
            if (id != tab.ownerAccountId &&
                !tab.members.any((m) => m.accountId == id))
              (accountId: id, email: '', name: '', owner: false),
        ];
    final ownMachineName = _machineName(tab.ownerMachineId, mine: true);
    final machineForErrors = ownMachines.contains(tab.ownerMachineId)
        ? ownMachineName
        : null;
    final menu = sharedTabMenu(app, widget.deskTabId);
    final pending = [for (final i in tab.pendingInvites) i];

    return ListView(
      key: const ValueKey('shared-tab-people'),
      shrinkWrap: true,
      padding: EdgeInsets.zero,
      children: [
        for (final a in alerts)
          _Band(
            key: ValueKey('people-band:${a.id}'),
            text: sharedTabAlertText(a.code),
            onDismiss: () => unawaited(shares.dismiss(a.id)),
            actions: [
              if (a.code == 'unpinned_key')
                _BandAction(
                  key: const ValueKey('people-band-trust'),
                  label: 'Trust again',
                  onPressed: () =>
                      showTrustAgain(context, app, tab.sharedTabId),
                ),
            ],
          ),
        for (final n in relay)
          _Band(
            key: ValueKey('people-band:${n.id}'),
            text: sharedTabErrorText(
              const SharedTabsFailure('RELAY_TAKEN', ''),
            ),
            onDismiss: () => unawaited(shares.dismiss(n.id)),
          ),
        for (final u in untrusted)
          _Band(
            key: ValueKey('people-band:untrusted:${u.sharedTabId}'),
            text:
                '${_who2(u.ownerEmail.isEmpty ? tab.ownerEmail : u.ownerEmail)}\'s computer has a new key.',
            actions: [
              _BandAction(
                key: const ValueKey('people-band-trust'),
                label: 'Trust again',
                onPressed: () => showTrustAgain(context, app, u.sharedTabId),
              ),
            ],
          ),
        if (_error != null)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 4, 12, 4),
            child: Text(
              _error!,
              key: const ValueKey('people-error'),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(
                color: Theme.of(context).colorScheme.error,
              ),
            ),
          ),
        for (final account in accounts)
          _block(
            context,
            tab,
            me,
            account,
            ownerHere: ownerHere,
            ownMachines: ownMachines,
            machine: machineForErrors,
          ),
        if (ownerHere && pending.isNotEmpty) ...[
          const _SectionTitle('Invited'),
          for (final i in pending)
            PeopleRow(
              key: ValueKey('people-invite:${i.id}'),
              title: shortSharedText(i.email, 60),
              trailing: [
                PeopleRowAction(
                  key: ValueKey('people-revoke:${i.id}'),
                  label: 'Revoke',
                  onPressed: () => _run(
                    () => shares.act('share_revoke', {'inviteId': i.id}),
                    machine: machineForErrors,
                  ),
                ),
              ],
            ),
        ] else if (!ownerHere && tab.invites.isNotEmpty) ...[
          const _SectionTitle('Invited'),
          for (final i in tab.invites)
            PeopleRow(title: shortSharedText(i.email, 60)),
        ],
        const SizedBox(height: 8),
        Padding(
          padding: const EdgeInsets.symmetric(horizontal: 12),
          child: Wrap(
            spacing: 8,
            runSpacing: 8,
            children: [
              if (ownerHere)
                DesktopPill(
                  key: const ValueKey('people-invite'),
                  label: 'Invite People…',
                  compact: true,
                  onPressed: () => unawaited(
                    showInvitePeople(context, app, widget.deskTabId),
                  ),
                ),
              DesktopPill(
                key: const ValueKey('people-add-harnesses'),
                label: 'Add Harnesses…',
                compact: true,
                onPressed: () =>
                    unawaited(showAddHarnesses(context, app, tab.sharedTabId)),
              ),
              if (menu.stop)
                DesktopPill(
                  key: const ValueKey('people-stop'),
                  label: 'Stop Sharing…',
                  compact: true,
                  onPressed: () => unawaited(
                    confirmStopSharing(context, app, widget.deskTabId),
                  ),
                ),
              if (menu.moveHere)
                DesktopPill(
                  key: const ValueKey('people-move-here'),
                  label: 'Move here…',
                  compact: true,
                  onPressed: () => unawaited(
                    confirmMoveHere(context, app, widget.deskTabId),
                  ),
                ),
              if (menu.leave)
                DesktopPill(
                  key: const ValueKey('people-leave'),
                  label: 'Leave…',
                  compact: true,
                  onPressed: () => unawaited(
                    confirmLeaveTab(context, app, widget.deskTabId),
                  ),
                ),
            ],
          ),
        ),
        if (!ownerHere)
          Padding(
            padding: const EdgeInsets.fromLTRB(12, 12, 12, 4),
            child: Text(
              tab.ownedBy(me.accountId) ? _ownerElsewhere : _onlyOwner,
              key: const ValueKey('people-owner-only'),
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(),
            ),
          ),
      ],
    );
  }

  static String _who2(String email) {
    final short = shortSharedText(email, 40);
    return short.isEmpty ? 'The owner' : short;
  }

  static String _nameOf(List<SharedTabMember> members, String accountId) {
    for (final m in members) {
      if (m.accountId == accountId) return m.name;
    }
    return '';
  }

  Widget _block(
    BuildContext context,
    SharedTab tab,
    SharedTabMe me,
    ({String accountId, String email, String name, bool owner}) account, {
    required bool ownerHere,
    required Set<String> ownMachines,
    required String? machine,
  }) {
    final shares = widget.app.sharedTabs;
    final email = shortSharedText(account.email, 60);
    final name = shortSharedText(account.name, 40);
    final title = [
      if (email.isNotEmpty)
        email
      else if (name.isEmpty)
        account.accountId.length <= 8
            ? account.accountId
            : account.accountId.substring(0, 8),
      if (name.isNotEmpty) name,
    ].join(' · ');
    final harnesses = [
      for (final h in tab.harnesses)
        if (h.accountId == account.accountId) h,
    ];
    final removable =
        ownerHere && !account.owner && account.accountId != me.accountId;
    return Column(
      key: ValueKey('people-account:${account.accountId}'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        PeopleRow(
          title: title,
          bold: true,
          badge: account.owner
              ? 'owner'
              : (account.accountId == me.accountId ? 'you' : null),
          trailing: [
            if (removable)
              PeopleRowAction(
                key: ValueKey('people-remove-member:${account.accountId}'),
                label: 'Remove member',
                onPressed: () => unawaited(
                  confirmSharedAction(
                    context,
                    title:
                        'Remove ${email.isNotEmpty ? email : (name.isNotEmpty ? name : 'this member')} and their harnesses from this tab?',
                    body: 'They can be invited again.',
                    confirm: 'Remove',
                    destructive: true,
                    machine: machine,
                    run: () => shares.act('share_remove_member', {
                      'sharedTabId': tab.sharedTabId,
                      'accountId': account.accountId,
                    }),
                  ),
                ),
              ),
          ],
        ),
        for (final h in harnesses)
          _harness(
            tab,
            h,
            ownerHere: ownerHere,
            ownMachines: ownMachines,
            machine: machine,
          ),
      ],
    );
  }

  Widget _harness(
    SharedTab tab,
    SharedTabHarness h, {
    required bool ownerHere,
    required Set<String> ownMachines,
    required String? machine,
  }) {
    final shares = widget.app.sharedTabs;
    final machineState = widget.app.machineStates[h.machineId];
    final working =
        machineState?.processingAgentIds.contains(h.agentId) == true;
    // Idle only when the machine is known and connected; otherwise no claim.
    final known =
        machineState != null &&
        !machineState.isOffline &&
        (machineState.nodeOnline == true ||
            machineState.connectionStatus == ConnectionStatus.connected);
    final where = _who?[h.key];
    final repo = [
      if (where?.project case final p? when plainSharedText(p).isNotEmpty)
        shortSharedText(p, 40),
      if (where?.branch case final b? when plainSharedText(b).isNotEmpty)
        shortSharedText(b, 40),
    ].join('/');
    final engine = shortSharedText(h.engine, 24);
    final leader = widget.app.tabLeader(widget.deskTabId);
    final isLeader =
        leader?.machineId == h.machineId && leader?.agentId == h.agentId;
    final leaderAction = widget.app.leaderActionFor(h.machineId, h.agentId);
    final details = [
      if (engine.isNotEmpty) engine,
      _machineName(h.machineId, mine: ownMachines.contains(h.machineId)),
      if (working) 'working' else if (known) 'idle',
      if (repo.isNotEmpty) repo,
    ].join(' · ');
    final name = shortSharedText(h.name, 40);
    return PeopleRow(
      key: ValueKey('people-harness:${h.machineId}/${h.agentId}'),
      indent: 24,
      title: name.isEmpty ? h.agentId : name,
      badge: isLeader ? 'leader' : null,
      detail: details,
      detailSkeleton: _who == null,
      trailing: [
        // The setting lives with the tab's owner (`setTabLeader`), so it holds
        // while the sharing computer sleeps; only where the app says it may.
        if (leaderAction != null)
          PeopleRowAction(
            key: ValueKey('people-leader:${h.machineId}/${h.agentId}'),
            label: leaderAction == 'remove' ? 'Remove Leader' : 'Make Leader',
            onPressed: () => _toggleLeader(h.machineId, h.agentId),
          ),
        // A member's harness only: the owner's own are in the tab by being in
        // its desk tab, and the sharing computer refuses to take one out
        // (`OWNER_PANE`; final review of 1c, I2). The pane moves out instead.
        if (ownerHere && h.accountId != tab.ownerAccountId)
          PeopleRowAction(
            key: ValueKey('people-remove:${h.machineId}/${h.agentId}'),
            label: 'Remove',
            onPressed: () => unawaited(
              confirmSharedAction(
                context,
                title:
                    'Remove ${name.isEmpty ? h.agentId : name} from this tab?',
                body: 'Its owner can add it again.',
                confirm: 'Remove',
                destructive: true,
                machine: machine,
                run: () => shares.act('share_remove', {
                  'sharedTabId': tab.sharedTabId,
                  'machineId': h.machineId,
                  'agentId': h.agentId,
                }),
              ),
            ),
          ),
      ],
    );
  }
}

class _SectionTitle extends StatelessWidget {
  const _SectionTitle(this.text);

  final String text;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 12, 12, 2),
    child: Text(text, maxLines: 1, style: DesktopChrome.metadata()),
  );
}

class PeopleRow extends StatelessWidget {
  const PeopleRow({
    super.key,
    required this.title,
    this.detail,
    this.detailSkeleton = false,
    this.badge,
    this.bold = false,
    this.indent = 0,
    this.trailing = const [],
  });

  final String title;
  final String? detail, badge;
  final bool detailSkeleton, bold;
  final double indent;
  final List<Widget> trailing;

  @override
  Widget build(BuildContext context) => Padding(
    padding: EdgeInsets.fromLTRB(12 + indent, 4, 12, 4),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Row(
                children: [
                  Flexible(
                    child: Text(
                      title,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.control(medium: bold),
                    ),
                  ),
                  if (badge != null) ...[
                    const SizedBox(width: 8),
                    Text(badge!, maxLines: 1, style: DesktopChrome.metadata()),
                  ],
                ],
              ),
              if (detail != null) ...[
                const SizedBox(height: 2),
                if (detailSkeleton)
                  Row(
                    children: [
                      Flexible(
                        child: Text(
                          detail!,
                          maxLines: 1,
                          overflow: TextOverflow.ellipsis,
                          style: DesktopChrome.metadata(),
                        ),
                      ),
                      const SizedBox(width: 6),
                      Semantics(
                        label: 'Loading repo and branch',
                        child: const Skeleton.text(
                          key: ValueKey('people-who-skeleton'),
                          width: 72,
                          height: 10,
                        ),
                      ),
                    ],
                  )
                else
                  Text(
                    detail!,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.metadata(),
                  ),
              ],
            ],
          ),
        ),
        ...trailing,
      ],
    ),
  );
}

class PeopleRowAction extends StatelessWidget {
  const PeopleRowAction({
    super.key,
    required this.label,
    required this.onPressed,
  });

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: 6),
    child: DesktopPill(
      label: label,
      compact: true,
      quiet: true,
      onPressed: onPressed,
    ),
  );
}

/// A warning about the tab: amber, plain words, with what can be done and a
/// way to dismiss it.
class _Band extends StatelessWidget {
  const _Band({
    super.key,
    required this.text,
    this.onDismiss,
    this.actions = const [],
  });

  final String text;
  final VoidCallback? onDismiss;
  final List<Widget> actions;

  @override
  Widget build(BuildContext context) {
    final amber = grid.AppPalette.brandBolt;
    return Container(
      margin: const EdgeInsets.fromLTRB(0, 0, 0, 8),
      padding: const EdgeInsets.fromLTRB(12, 6, 6, 6),
      decoration: BoxDecoration(
        color: amber.withValues(alpha: .14),
        border: Border.all(color: amber.withValues(alpha: .5)),
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      ),
      child: Row(
        children: [
          Expanded(
            child: Text(
              text,
              maxLines: 2,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.text(size: 13),
            ),
          ),
          ...actions,
          if (onDismiss != null)
            Padding(
              padding: const EdgeInsets.only(left: 6),
              child: DesktopPill(
                key: const ValueKey('people-band-dismiss'),
                label: 'Dismiss',
                compact: true,
                quiet: true,
                onPressed: onDismiss,
              ),
            ),
        ],
      ),
    );
  }
}

class _BandAction extends StatelessWidget {
  const _BandAction({super.key, required this.label, required this.onPressed});

  final String label;
  final VoidCallback onPressed;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.only(left: 6),
    child: DesktopPill(label: label, compact: true, onPressed: onPressed),
  );
}
