import 'dart:async';

import 'package:flutter/foundation.dart' show kIsWeb;
import 'package:flutter/material.dart';

import '../core/models.dart' show Agent;
import '../shared/theme/app_theme.dart' as grid;
import '../sharing/share_harness_dialog.dart';
import '../state/app_state.dart';
import '../state/desk_sync.dart' show isDeskId;
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';
import '../widgets/terminal_prompt.dart';
import '../state/pane_layout_store.dart' show PaneLayoutStore;
import 'shared_tab_errors.dart';
import 'shared_tab_placement.dart' show plainSharedText, shortSharedText;
import 'shared_tabs.dart';
import 'shared_tabs_model.dart';

/// What a tab's menus (native, File, the Flutter tab, the web tab menu and
/// the palette) offer about sharing it with other accounts (1c).
///
/// Nothing while the shares cannot be read, except Invite People…: with
/// Agent Messages off it stays and opens the switch (Settings ▸ Experimental);
/// with a daemon too old for shared tabs it goes too.
@immutable
class SharedTabMenu {
  const SharedTabMenu({
    this.tab,
    this.owner = false,
    this.invite = false,
    this.moveHere = false,
  });

  static const none = SharedTabMenu();

  /// The shared tab this desk tab is; null for an unshared tab, and whenever
  /// the shares are not ready.
  final SharedTab? tab;

  /// Whether this account owns [tab].
  final bool owner;

  /// Invite People…: an unshared desk tab, or one this account shares from
  /// the computer asked (the only one that may invite).
  final bool invite;

  /// Move Here: the owner, in a native window, on a computer other than the
  /// one that shares the tab.
  final bool moveHere;

  bool get stop => tab != null && owner;
  bool get leave => tab != null && !owner;
  int? get count => tab?.harnesses.length;

  /// The per-tab native field: absent (null) for an unshared tab.
  Map<String, Object>? get native => tab == null
      ? null
      : {
          'count': tab!.harnesses.length,
          'role': owner ? 'owner' : 'member',
          'canMoveHere': moveHere,
        };

  /// The File menu's rows for the active tab, by native method name: only
  /// those offered.
  Map<String, bool> get actions => {
    if (invite) 'invitePeople': true,
    if (stop) 'stopSharingTab': true,
    if (moveHere) 'moveTabHere': true,
    if (leave) 'leaveTab': true,
  };
}

/// [SharedTabMenu] for the desk tab [deskTabId].
SharedTabMenu sharedTabMenu(AppNotifier app, String deskTabId) {
  final shares = app.sharedTabs;
  final state = shares.state;
  if (!app.swarms.any((swarm) => swarm.id == deskTabId)) {
    return SharedTabMenu.none;
  }
  final me = shares.snapshot.me?.accountId;
  final tab = state == SharedTabsState.ready && me != null
      ? shares.tabForDesk(deskTabId)
      : null;
  if (tab != null) {
    final owner = tab.ownedBy(me!);
    final here = app.localMachineState?.machine.machineId;
    return SharedTabMenu(
      tab: tab,
      owner: owner,
      // Only the computer that shares the tab invites (the others are refused
      // NOT_OWNER): the daemon asked, which is `me.machineId`, as People has it.
      invite: owner && tab.ownerMachineId == shares.snapshot.me?.machineId,
      moveHere:
          owner &&
          !kIsWeb &&
          app.viewer == null &&
          here != null &&
          tab.ownerMachineId != here,
    );
  }
  // Only a tab of this account's desk can be shared; the Store and a tab off
  // the desk have no Agent Messages log either.
  final invite =
      (state == SharedTabsState.ready || state == SharedTabsState.off) &&
      isDeskId(deskTabId) &&
      app.agentMessagesOffered(deskTabId);
  return invite ? const SharedTabMenu(invite: true) : SharedTabMenu.none;
}

/// The name of the computer a shared tab's owner uses, when it is one of the
/// person's own and its name is known; otherwise null (the error text then
/// says "That computer").
String? _ownMachineName(AppNotifier app, SharedTab? tab) {
  final state = tab == null ? null : app.machineStates[tab.ownerMachineId];
  if (state == null || state.belongsToOtherAccount) return null;
  final name = state.machine.displayName;
  return name.isEmpty ? null : name;
}

String _deskTabName(AppNotifier app, String deskTabId, SharedTab? tab) {
  if (tab != null && plainSharedText(tab.name).isNotEmpty) {
    return plainSharedText(tab.name);
  }
  for (final s in app.swarms) {
    if (s.id == deskTabId) return s.name;
  }
  return 'Tab';
}

List<Map<String, dynamic>> _pending(SharedTab? tab) => [
  if (tab != null)
    if (tab.pendingInvites.isNotEmpty)
      for (final i in tab.pendingInvites)
        {'id': i.id, 'email': i.email, 'expiresAt': i.expiresAt}
    else
      // A daemon that does not list invitation ids: who is invited, without Revoke.
      for (final i in tab.invites) {'email': i.email, 'expiresAt': i.expiresAt},
];

/// Invite People: the Share form in tab mode. The first invitation shares the
/// tab, then invites; a shared tab only invites.
Future<void> showInvitePeople(
  BuildContext context,
  AppNotifier app,
  String deskTabId,
) {
  final controller = app.sharedTabs;
  var read = false;
  String? sharedId = controller.tabForDesk(deskTabId)?.sharedTabId;
  Future<Map<String, dynamic>> shares() async => {
    'shares': _pending(controller.tabForDesk(deskTabId)),
  };
  return showTerminalPrompt<void>(
    context,
    builder: (_) => ShareHarnessDialog(
      name: _deskTabName(app, deskTabId, controller.tabForDesk(deskTabId)),
      tabMode: true,
      errorMachine: _ownMachineName(app, controller.tabForDesk(deskTabId)),
      manage: (action, payload) async {
        switch (action) {
          case 'invite':
            if (sharedId == null) {
              final made = await controller.act('share_tab', {
                'tabId': deskTabId,
                'name': _deskTabName(app, deskTabId, null),
              });
              final sharedTabId = made['sharedTabId'];
              if (sharedTabId is! String || sharedTabId.isEmpty) {
                throw const SharedTabsFailure('INVALID_ANSWER', '');
              }
              sharedId = sharedTabId;
            }
            final answer = await controller.act('share_invite', {
              'sharedTabId': sharedId,
              'emails': payload['emails'],
              'days': payload['days'],
            });
            await controller.refresh();
            return {
              ...await shares(),
              'refused': answer['refused'] ?? const [],
            };
          case 'remove':
            await controller.act('share_revoke', {'inviteId': payload['id']});
            await controller.refresh();
            return shares();
          default:
            if (!read) {
              read = true;
              await controller.refresh();
            }
            return shares();
        }
      },
    ),
  );
}

/// Stop Sharing: everyone leaves the tab. Asks first.
Future<void> confirmStopSharing(
  BuildContext context,
  AppNotifier app,
  String deskTabId,
) {
  final tab = app.sharedTabs.tabForDesk(deskTabId);
  if (tab == null) return Future.value();
  return confirmSharedAction(
    context,
    title:
        'Stop sharing "${shortSharedText(_deskTabName(app, deskTabId, tab))}"?',
    body: 'Everyone in it loses its harnesses\' terminals and messages.',
    confirm: 'Stop Sharing',
    destructive: true,
    machine: _ownMachineName(app, tab),
    run: () =>
        app.sharedTabs.act('share_stop', {'sharedTabId': tab.sharedTabId}),
  );
}

/// Leave: a member takes its harnesses out of the tab. Asks first.
Future<void> confirmLeaveTab(
  BuildContext context,
  AppNotifier app,
  String deskTabId,
) {
  final tab = app.sharedTabs.tabForDesk(deskTabId);
  if (tab == null) return Future.value();
  final owner = plainSharedText(tab.ownerEmail);
  return confirmSharedAction(
    context,
    title: 'Leave "${shortSharedText(_deskTabName(app, deskTabId, tab))}"?',
    body:
        'Your harnesses leave the tab. ${owner.isEmpty ? 'The owner' : shortSharedText(owner)} can invite you again.',
    confirm: 'Leave',
    destructive: true,
    machine: _ownMachineName(app, tab),
    run: () =>
        app.sharedTabs.act('share_leave', {'sharedTabId': tab.sharedTabId}),
  );
}

/// Move here: this computer becomes the one that shares the tab.
Future<void> confirmMoveHere(
  BuildContext context,
  AppNotifier app,
  String deskTabId,
) {
  final tab = app.sharedTabs.tabForDesk(deskTabId);
  if (tab == null) return Future.value();
  return confirmSharedAction(
    context,
    title: 'Move "${_deskTabName(app, deskTabId, tab)}" here?',
    body:
        'This computer will share the tab from now on. '
        'Members whose computers can\'t confirm the move will be asked to trust this computer.',
    confirm: 'Move here',
    destructive: false,
    machine: _ownMachineName(app, tab),
    run: () =>
        app.sharedTabs.act('share_move', {'sharedTabId': tab.sharedTabId}),
  );
}

Future<void> confirmSharedAction(
  BuildContext context, {
  required String title,
  required String body,
  required String confirm,
  required bool destructive,
  required String? machine,
  required Future<Object?> Function() run,
}) => showTerminalPrompt<void>(
  context,
  builder: (_) => _SharedTabConfirm(
    title: title,
    body: body,
    confirm: confirm,
    destructive: destructive,
    machine: machine,
    run: run,
  ),
);

class _SharedTabConfirm extends StatefulWidget {
  const _SharedTabConfirm({
    required this.title,
    required this.body,
    required this.confirm,
    required this.destructive,
    required this.machine,
    required this.run,
  });

  final String title, body, confirm;
  final bool destructive;
  final String? machine;
  final Future<Object?> Function() run;

  @override
  State<_SharedTabConfirm> createState() => _SharedTabConfirmState();
}

class _SharedTabConfirmState extends State<_SharedTabConfirm> {
  final _cancel = FocusNode(debugLabel: 'Cancel shared tab action');
  final _keys = FocusNode(debugLabel: 'Shared tab action');
  bool _busy = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) _cancel.requestFocus();
    });
  }

  @override
  void dispose() {
    _cancel.dispose();
    _keys.dispose();
    super.dispose();
  }

  Future<void> _go() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.run();
      if (mounted) Navigator.pop(context);
    } on SharedTabsFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = sharedTabErrorText(e, machine: widget.machine);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Something went wrong. Try again in a moment.';
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final danger = Theme.of(context).colorScheme.error;
    return TerminalPromptKeys(
      focusNode: _keys,
      cancel: () => Navigator.pop(context),
      child: DesktopPromptSurface(
        body: DesktopPromptScrollBody(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                widget.title,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.heading(),
              ),
              const SizedBox(height: DesktopChrome.groupGap),
              Text(widget.body, style: DesktopChrome.text(size: 13)),
            ],
          ),
        ),
        footer: _error != null
            ? Semantics(
                liveRegion: true,
                child: DesktopPromptMessage(_error!, color: danger),
              )
            : null,
        actions: [
          TextButton(
            focusNode: _cancel,
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('shared-tab-confirm'),
            style: widget.destructive ? grid.dangerButtonStyle() : null,
            onPressed: _busy ? null : () => unawaited(_go()),
            child: Text(_busy ? 'Working…' : widget.confirm),
          ),
        ],
      ),
    );
  }
}

/// One line of another account's text for a dialog: plain, never markup.
String _plain(String text, String fallback) {
  final plain = shortSharedText(text);
  return plain.isEmpty ? fallback : plain;
}

/// Accept an invitation: the promise first, then (after it succeeds) the
/// owner computer's fingerprint, or the note that the tab comes later, and
/// **Add harnesses**.
Future<void> showAcceptInvite(
  BuildContext context,
  AppNotifier app,
  SharedTabInvite invite,
) => showTerminalPrompt<void>(
  context,
  builder: (_) => _AcceptInvite(host: context, app: app, invite: invite),
);

class _AcceptInvite extends StatefulWidget {
  const _AcceptInvite({
    required this.host,
    required this.app,
    required this.invite,
  });

  final BuildContext host;
  final AppNotifier app;
  final SharedTabInvite invite;

  @override
  State<_AcceptInvite> createState() => _AcceptInviteState();
}

class _AcceptInviteState extends State<_AcceptInvite> {
  final _keys = FocusNode(debugLabel: 'Accept invitation');
  bool _busy = false;
  String? _error, _sharedTabId, _fingerprint;
  bool _pending = false;

  bool get _done => _sharedTabId != null;

  @override
  void dispose() {
    _keys.dispose();
    super.dispose();
  }

  Future<void> _accept() async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      final answer = await widget.app.sharedTabs.act('share_accept', {
        'inviteId': widget.invite.id,
      });
      final id = answer['sharedTabId'];
      if (!mounted) return;
      setState(() {
        _busy = false;
        _sharedTabId = id is String && id.isNotEmpty
            ? id
            : widget.invite.sharedTabId;
        _pending = answer['pending'] == true;
        final fingerprint = answer['fingerprint'];
        _fingerprint = fingerprint is String && fingerprint.isNotEmpty
            ? plainSharedText(fingerprint)
            : null;
      });
    } on SharedTabsFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = sharedTabErrorText(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = 'Something went wrong. Try again in a moment.';
      });
    }
  }

  void _addHarnesses() {
    final host = widget.host, app = widget.app, id = _sharedTabId!;
    Navigator.pop(context);
    if (host.mounted) {
      unawaited(
        showAddHarnesses(
          host,
          app,
          id,
          onNewHarness: app.requestNewHarnessInSharedTab,
        ),
      );
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final owner = _plain(widget.invite.ownerEmail, 'The owner');
    final name = _plain(widget.invite.tabName, 'a tab');
    final danger = Theme.of(context).colorScheme.error;
    return TerminalPromptKeys(
      focusNode: _keys,
      cancel: () => Navigator.pop(context),
      child: DesktopPromptSurface(
        body: DesktopPromptScrollBody(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                name,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.heading(),
              ),
              const SizedBox(height: 4),
              Text(
                owner,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.text(size: 13),
              ),
              const SizedBox(height: DesktopChrome.groupGap),
              if (!_done)
                Text(
                  '$owner and everyone in this tab will see the terminals of the harnesses you add. Only you can type into them.',
                  style: DesktopChrome.text(size: 13),
                )
              else if (_pending)
                Text(
                  'The tab will appear when $owner\'s computer is reachable.',
                  style: DesktopChrome.text(size: 13),
                )
              else ...[
                if (_fingerprint != null) ...[
                  SelectableText(
                    _fingerprint!,
                    style: DesktopChrome.text(size: 13)
                        .copyWith(fontFamily: 'monospace'),
                  ),
                  const SizedBox(height: 6),
                ],
                Text(
                  _fingerprint == null
                      ? 'You accepted the invitation.'
                      : 'Compare it with $owner if you want to be sure.',
                  style: DesktopChrome.text(size: 13),
                ),
              ],
            ],
          ),
        ),
        footer: _error != null
            ? Semantics(
                liveRegion: true,
                child: DesktopPromptMessage(_error!, color: danger),
              )
            : null,
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: Text(_done ? 'Done' : 'Cancel'),
          ),
          if (!_done)
            FilledButton(
              key: const Key('shared-invite-accept'),
              onPressed: _busy ? null : () => unawaited(_accept()),
              child: Text(_busy ? 'Working…' : 'Accept'),
            )
          else if (!_pending)
            FilledButton(
              key: const Key('shared-invite-add'),
              onPressed: _addHarnesses,
              child: const Text('Add harnesses'),
            ),
        ],
      ),
    );
  }
}

/// Add harnesses: this account's own harnesses to put in the shared tab, or
/// New Harness in the tab ([onNewHarness] receives the shared tab id; its
/// desk tab is [AppNotifier.sharedDeskTabId]).
Future<void> showAddHarnesses(
  BuildContext context,
  AppNotifier app,
  String sharedTabId, {
  void Function(String sharedTabId)? onNewHarness,
}) => showTerminalPrompt<void>(
  context,
  builder: (_) => _AddHarnesses(
    app: app,
    sharedTabId: sharedTabId,
    onNewHarness: onNewHarness,
  ),
);

class _OwnHarness {
  const _OwnHarness(this.machineId, this.machine, this.agent);
  final String machineId, machine;
  final Agent agent;
  String get key => '$machineId\u0000${agent.id}';
  String get label => '${agent.name} · ${agent.engine ?? ''} · $machine'
      .replaceAll(' ·  ·', ' ·');
}

class _AddHarnesses extends StatefulWidget {
  const _AddHarnesses({
    required this.app,
    required this.sharedTabId,
    required this.onNewHarness,
  });

  final AppNotifier app;
  final String sharedTabId;
  final void Function(String sharedTabId)? onNewHarness;

  @override
  State<_AddHarnesses> createState() => _AddHarnessesState();
}

class _AddHarnessesState extends State<_AddHarnesses> {
  final _keys = FocusNode(debugLabel: 'Add harnesses');
  final _picked = <String>{};
  bool _busy = false;
  String? _error;

  @override
  void dispose() {
    _keys.dispose();
    super.dispose();
  }

  List<_OwnHarness> _own() {
    final inTab = {
      for (final h
          in widget.app.sharedTabs.snapshot.tabs
              .where((t) => t.sharedTabId == widget.sharedTabId)
              .expand((t) => t.harnesses))
        h.key,
    };
    return [
      for (final state in widget.app.machineStates.values)
        if (!state.belongsToOtherAccount)
          for (final agent in state.agents)
            if (!inTab.contains('${state.machine.machineId}\u0000${agent.id}'))
              _OwnHarness(
                state.machine.machineId,
                _plain(state.machine.displayName, 'This computer'),
                agent,
              ),
    ];
  }

  /// The desk tab the shared tab shows in: derived from the shared tab id for
  /// a member (R1), the tab it shared for the owner. Null until the roster has
  /// arrived and the desk has the tab.
  String? _deskTab() {
    final shares = widget.app.sharedTabs;
    final me = shares.snapshot.me?.accountId;
    final tab = shares.snapshot.tabs
        .where((t) => t.sharedTabId == widget.sharedTabId)
        .firstOrNull;
    final id = me == null ? null : tab?.deskTabId(me);
    if (id == null || !widget.app.swarms.any((s) => s.id == id)) return null;
    return id;
  }

  static final _fullText =
      'This tab already shows ${PaneLayoutStore.maxPanes} panes. Close one, then try again.';

  Future<void> _add(List<_OwnHarness> all) async {
    if (_busy) return;
    final desk = _deskTab();
    if (desk == null) {
      final tab = widget.app.sharedTabs.snapshot.tabs
          .where((t) => t.sharedTabId == widget.sharedTabId)
          .firstOrNull;
      final owner = _plain(tab?.ownerEmail ?? '', 'the owner');
      setState(
        () => _error =
            'The tab will appear when $owner\'s computer is reachable.',
      );
      return;
    }
    setState(() {
      _busy = true;
      _error = null;
    });
    String? error;
    for (final h in all.where((h) => _picked.contains(h.key))) {
      // The pane goes into the shared tab as a person's add; that is what
      // sends share_add (once), and a refusal comes back here.
      SharedTabsFailure? refused;
      // The desk syncs 9 panes (the window's grid); a 10th would exist only here.
      final before = widget.app.swarms.where((s) => s.id == desk).firstOrNull;
      if (before != null &&
          widget.app.deskTabFull(before) &&
          !before.panes.any(
            (p) => p.machineId == h.machineId && p.agentId == h.agent.id,
          )) {
        error = _fullText;
        break;
      }
      try {
        await widget.app.assignAgentToPane(
          null,
          h.machineId,
          h.agent.id,
          swarmId: desk,
          focus: false,
          intent: AttachIntent.person,
          onShareFailure: (e) => refused = e,
        );
      } catch (_) {
        error = 'Something went wrong. Try again in a moment.';
        break;
      }
      if (refused != null) {
        error = sharedTabErrorText(refused!, machine: h.machine);
        break;
      }
      final deskSwarm = widget.app.swarms
          .where((s) => s.id == desk)
          .firstOrNull;
      final landed =
          deskSwarm?.panes.any(
            (p) => p.machineId == h.machineId && p.agentId == h.agent.id,
          ) ??
          false;
      if (!landed) {
        error = deskSwarm != null && widget.app.deskTabFull(deskSwarm)
            ? _fullText
            : 'Couldn\'t add ${_plain(h.agent.name, 'the harness')} to the tab. Try again in a moment.';
        break;
      }
      _picked.remove(h.key);
    }
    if (!mounted) return;
    if (error == null) {
      Navigator.pop(context);
      return;
    }
    setState(() {
      _busy = false;
      _error = error;
    });
  }

  void _newHarness() {
    final app = widget.app, id = widget.sharedTabId;
    Navigator.pop(context);
    final desk = app.sharedDeskTabId(id);
    if (desk != null && app.swarms.any((s) => s.id == desk)) {
      app.selectSwarm(desk);
    }
    widget.onNewHarness?.call(id);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final own = _own();
    final danger = Theme.of(context).colorScheme.error;
    return TerminalPromptKeys(
      focusNode: _keys,
      cancel: () => Navigator.pop(context),
      child: DesktopPromptSurface(
        body: DesktopPromptScrollBody(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Add harnesses', style: DesktopChrome.heading()),
              const SizedBox(height: DesktopChrome.groupGap),
              if (own.isEmpty)
                Text(
                  'You have no other harnesses to add.',
                  style: DesktopChrome.text(size: 13),
                ),
              for (final h in own)
                CheckboxListTile(
                  key: ValueKey('shared-add-${h.key}'),
                  dense: true,
                  contentPadding: EdgeInsets.zero,
                  controlAffinity: ListTileControlAffinity.leading,
                  value: _picked.contains(h.key),
                  onChanged: _busy
                      ? null
                      : (on) => setState(
                          () => on == true
                              ? _picked.add(h.key)
                              : _picked.remove(h.key),
                        ),
                  title: Text(
                    h.label,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: DesktopChrome.text(size: 13),
                  ),
                ),
            ],
          ),
        ),
        footer: _error != null
            ? Semantics(
                liveRegion: true,
                child: DesktopPromptMessage(_error!, color: danger),
              )
            : null,
        actions: [
          TextButton(
            key: const Key('shared-add-new'),
            onPressed: _busy ? null : _newHarness,
            child: const Text('New Harness here'),
          ),
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          FilledButton(
            key: const Key('shared-add-confirm'),
            onPressed: _busy || _picked.isEmpty
                ? null
                : () => unawaited(_add(own)),
            child: Text(_busy ? 'Working…' : 'Add'),
          ),
        ],
      ),
    );
  }
}

/// Trust again: the owner's computer has a new key. Shows its fingerprint
/// (and the one trusted before) and, on Confirm, trusts it.
Future<void> showTrustAgain(
  BuildContext context,
  AppNotifier app,
  String sharedTabId,
) => showTerminalPrompt<void>(
  context,
  builder: (_) => _TrustAgain(app: app, sharedTabId: sharedTabId),
);

class _TrustAgain extends StatefulWidget {
  const _TrustAgain({required this.app, required this.sharedTabId});

  final AppNotifier app;
  final String sharedTabId;

  @override
  State<_TrustAgain> createState() => _TrustAgainState();
}

class _TrustAgainState extends State<_TrustAgain> {
  final _keys = FocusNode(debugLabel: 'Trust again');
  bool _busy = true;
  String? _error, _owner, _pub, _fingerprint, _before;

  @override
  void initState() {
    super.initState();
    unawaited(_check());
  }

  @override
  void dispose() {
    _keys.dispose();
    super.dispose();
  }

  String _generic() => 'Something went wrong. Try again in a moment.';

  Future<void> _check() async {
    try {
      final a = await widget.app.sharedTabs.act('share_retrust_check', {
        'sharedTabId': widget.sharedTabId,
      });
      final pub = a['ownerPub'], fingerprint = a['fingerprint'];
      if (!mounted) return;
      if (pub is! String || fingerprint is! String) {
        setState(() {
          _busy = false;
          _error = _generic();
        });
        return;
      }
      final before = a['pinnedFingerprint'], owner = a['ownerEmail'];
      setState(() {
        _busy = false;
        _pub = pub;
        _fingerprint = plainSharedText(fingerprint);
        _before = before is String && before.isNotEmpty
            ? plainSharedText(before)
            : null;
        _owner = owner is String ? owner : null;
      });
    } on SharedTabsFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = sharedTabErrorText(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _generic();
      });
    }
  }

  Future<void> _confirm() async {
    if (_busy || _pub == null) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await widget.app.sharedTabs.act('share_retrust', {
        'sharedTabId': widget.sharedTabId,
        'ownerPub': _pub,
      });
      if (mounted) Navigator.pop(context);
    } on SharedTabsFailure catch (e) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = sharedTabErrorText(e);
      });
    } catch (_) {
      if (!mounted) return;
      setState(() {
        _busy = false;
        _error = _generic();
      });
    }
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final owner = _plain(_owner ?? '', 'The owner');
    final danger = Theme.of(context).colorScheme.error;
    final mono = DesktopChrome.text(size: 13).copyWith(fontFamily: 'monospace');
    return TerminalPromptKeys(
      focusNode: _keys,
      cancel: () => Navigator.pop(context),
      child: DesktopPromptSurface(
        body: DesktopPromptScrollBody(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                '$owner\'s computer has a new key.',
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.heading(),
              ),
              const SizedBox(height: DesktopChrome.groupGap),
              if (_fingerprint == null && _error == null)
                Text(
                  'Reading the new key…',
                  style: DesktopChrome.text(size: 13),
                )
              else if (_fingerprint != null) ...[
                SelectableText('New: $_fingerprint', style: mono),
                if (_before != null) ...[
                  const SizedBox(height: 4),
                  SelectableText('Before: $_before', style: mono),
                ],
                const SizedBox(height: 8),
                Text(
                  'Compare it with $owner before you trust it.',
                  style: DesktopChrome.text(size: 13),
                ),
              ],
            ],
          ),
        ),
        footer: _error != null
            ? Semantics(
                liveRegion: true,
                child: DesktopPromptMessage(_error!, color: danger),
              )
            : null,
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Cancel'),
          ),
          if (_fingerprint == null && _error != null)
            OutlinedButton(
              key: const Key('shared-trust-retry'),
              onPressed: () {
                setState(() {
                  _busy = true;
                  _error = null;
                });
                unawaited(_check());
              },
              child: const Text('Try again'),
            ),
          FilledButton(
            key: const Key('shared-trust-confirm'),
            onPressed: _busy || _pub == null
                ? null
                : () => unawaited(_confirm()),
            child: Text(_busy && _pub != null ? 'Working…' : 'Trust'),
          ),
        ],
      ),
    );
  }
}
