import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_menu.dart';
import '../shared/widgets/app_select_field.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';
import 'controller.dart';
import 'model.dart';

// Teams above Swarms (docs/plans/2026-10-27-swarm-teams.md; backend
// superTabs/orgStore.ts, where a Team is an `org`). The menu names the open
// Swarm's Team and lists the person's Teams with the Swarms they may see; a
// Team's owners and admins manage its people from it.

/// The on-screen word for a Team, here alone (backend superTabs/orgs.ts
/// ORG_LABEL): the Product Manager may still change it, as "Team" also names the
/// Harness Team account.
const kTeamLabel = 'Team';

const _roleLabels = {
  'owner': 'Owner',
  'admin': 'Admin',
  'member': 'Member',
  'guest': 'Guest',
};

/// A Swarm as the Teams list shows it: [member] when the person is in it,
/// otherwise open to the Team (or listed for its owners and admins).
class SuperTabTeamSwarm {
  SuperTabTeamSwarm.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      name = row['name'] as String? ?? '',
      open = row['orgVisibility'] == 'org',
      member = row['member'] != false;
  final String id, name;
  final bool open, member;
}

class SuperTabTeam {
  SuperTabTeam.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      name = row['name'] as String? ?? kTeamLabel,
      role = row['role'] as String? ?? 'guest',
      swarms = [
        for (final swarm in row['swarms'] as List? ?? const [])
          SuperTabTeamSwarm.fromJson(superTabMap(swarm)),
      ];
  final String id, name, role;
  final List<SuperTabTeamSwarm> swarms;

  /// Owners and admins manage the Team's people.
  bool get manages => role == 'owner' || role == 'admin';
}

Future<List<SuperTabTeam>> readSuperTabTeams(SuperTabRequest request) async {
  final answer = await request('GET', '/api/super-tabs/orgs');
  return [
    for (final row in answer['orgs'] as List? ?? const [])
      SuperTabTeam.fromJson(superTabMap(row)),
  ];
}

/// The sidebar row naming the open Swarm's Team. It opens a menu of the
/// person's Teams and their Swarms; picking one opens it, joining it first when
/// it is open to the Team and the person is not in it yet.
class SuperTabTeamMenu extends StatefulWidget {
  const SuperTabTeamMenu({
    super.key,
    required this.controller,
    required this.onOpenSwarm,
  });
  final SuperTabController controller;
  final void Function(String id, String name) onOpenSwarm;

  @override
  State<SuperTabTeamMenu> createState() => _SuperTabTeamMenuState();
}

class _SuperTabTeamMenuState extends State<SuperTabTeamMenu> {
  final _menu = MenuController();
  List<SuperTabTeam>? _teams;
  String? _error;
  bool _busy = false;

  SuperTabController get c => widget.controller;

  SuperTabTeam? get _current {
    final orgId = c.snapshot?.orgId;
    return _teams?.where((t) => t.id == orgId).firstOrNull;
  }

  @override
  void initState() {
    super.initState();
    unawaited(_read());
  }

  Future<void> _read() async {
    try {
      final teams = await readSuperTabTeams(c.request);
      if (mounted) setState(() => _teams = teams);
    } on SuperTabFailure catch (failure) {
      if (mounted) setState(() => _error = failure.message);
    }
  }

  Future<void> _pick(SuperTabTeamSwarm swarm) async {
    _menu.close();
    if (swarm.id == c.tabId) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      if (!swarm.member) {
        await c.request(
          'POST',
          '/api/super-tabs/${Uri.encodeComponent(swarm.id)}/org-join',
          body: {'operationId': superTabOperationId()},
        );
      }
      widget.onOpenSwarm(swarm.id, swarm.name);
    } on SuperTabFailure catch (failure) {
      if (mounted) setState(() => _error = failure.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  void _settings(SuperTabTeam team) {
    _menu.close();
    unawaited(
      showAppDialog<void>(
        context: context,
        builder: (_) => SuperTabTeamSettings(controller: c, team: team),
      ).then((_) => _read()),
    );
  }

  Widget _heading(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 10, 12, 4),
    child: Text(text, style: DesktopChrome.metadata()),
  );

  @override
  Widget build(BuildContext context) {
    final current = _current;
    final teams = _teams ?? const <SuperTabTeam>[];
    return Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        MenuAnchor(
          controller: _menu,
          consumeOutsideTap: true,
          // Every Team and its Swarms in one list, with room for several Teams before it scrolls.
          style: grid.AppMenu.style(
            minWidth: 240,
            maxWidth: 320,
            maxHeight: 520,
          ),
          menuChildren: [
            for (final team in teams) ...[
              _heading(team.name),
              for (final swarm in team.swarms)
                AppMenuItem(
                  key: ValueKey('super-team-swarm-${swarm.id}'),
                  label: swarm.name,
                  icon: swarm.member ? AppIcons.users : AppIcons.plus,
                  detail: swarm.member ? null : 'Open to the $kTeamLabel: join',
                  selected: swarm.id == c.tabId,
                  onPressed: () => unawaited(_pick(swarm)),
                ),
            ],
            if (current != null && current.manages)
              AppMenuItem(
                key: const ValueKey('super-team-settings'),
                label: '$kTeamLabel settings',
                icon: AppIcons.settings,
                onPressed: () => _settings(current),
              ),
          ],
          builder: (context, menu, _) => Material(
            color: Colors.transparent,
            borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
            clipBehavior: Clip.antiAlias,
            child: InkWell(
              key: const ValueKey('super-team-menu'),
              onTap: _busy || _teams == null
                  ? null
                  : () => menu.isOpen ? menu.close() : menu.open(),
              hoverColor: grid.AppSurface.hoverFill,
              child: Padding(
                padding: const EdgeInsets.fromLTRB(10, 8, 10, 8),
                child: Row(
                  children: [
                    Icon(
                      AppIcons.users,
                      size: AppIcons.inlineSize,
                      color: DesktopChrome.foreground,
                    ),
                    const SizedBox(width: 10),
                    Expanded(
                      child: Text(
                        current?.name ?? kTeamLabel,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.control(medium: true),
                      ),
                    ),
                    Icon(
                      AppIcons.chevronDown,
                      size: AppIcons.inlineSize,
                      color: DesktopChrome.muted,
                    ),
                  ],
                ),
              ),
            ),
          ),
        ),
        if (_error case final error?)
          Padding(
            padding: const EdgeInsets.fromLTRB(10, 2, 10, 6),
            child: Text(error, style: DesktopChrome.metadata()),
          ),
      ],
    );
  }
}

/// A Team's people and roles, for its owners and admins: invite, change a role,
/// remove (from every Swarm of the Team too), and open the current Swarm to the
/// Team. What the role may do is the server's to decide; this shows only what it
/// would allow.
class SuperTabTeamSettings extends StatefulWidget {
  const SuperTabTeamSettings({
    super.key,
    required this.controller,
    required this.team,
  });
  final SuperTabController controller;
  final SuperTabTeam team;

  @override
  State<SuperTabTeamSettings> createState() => _SuperTabTeamSettingsState();
}

class _SuperTabTeamSettingsState extends State<SuperTabTeamSettings> {
  final _email = TextEditingController();
  String _inviteRole = 'member';
  List<Map<String, dynamic>>? _members;
  String? _error, _confirming;
  bool _busy = false;
  late bool _open = widget.controller.snapshot?.openToTeam ?? false;

  SuperTabController get c => widget.controller;
  String get _path =>
      '/api/super-tabs/orgs/${Uri.encodeComponent(widget.team.id)}';
  String get _role => widget.team.role;

  /// The roles this person may give: an owner any but owner, an admin member or guest.
  List<String> get _gives => _role == 'owner'
      ? const ['admin', 'member', 'guest']
      : const ['member', 'guest'];
  bool _manages(Map<String, dynamic> person) =>
      person['userId'] != c.accountId && _gives.contains(person['role']);

  @override
  void initState() {
    super.initState();
    unawaited(_load());
  }

  @override
  void dispose() {
    _email.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    final answer = await c.request('GET', '$_path/members');
    if (!mounted) return;
    setState(
      () => _members = [
        for (final row in answer['members'] as List? ?? const [])
          superTabMap(row),
      ],
    );
  }

  Future<void> _run(
    String method,
    String path,
    Map<String, dynamic> body,
  ) async {
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await c.request(method, path, body: body);
      await _load();
    } on SuperTabFailure catch (failure) {
      if (mounted) setState(() => _error = failure.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<void> _invite() async {
    final email = _email.text.trim();
    if (email.isEmpty) return;
    await _run('POST', '$_path/invitations', {
      'email': email,
      'role': _inviteRole,
    });
    if (_error == null) _email.clear();
  }

  Widget _person(Map<String, dynamic> person) {
    final id = person['userId'] as String;
    final role = person['role'] as String;
    final manageable = _manages(person);
    return Padding(
      key: ValueKey('team-member-$id'),
      padding: const EdgeInsets.symmetric(vertical: 4),
      // One height whether or not the row has controls, so the list reads evenly.
      child: ConstrainedBox(
        constraints: const BoxConstraints(minHeight: 40),
        child: Row(
          children: [
            Expanded(
              child: Text(
                person['email'] as String? ?? id,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.control(),
              ),
            ),
            if (!manageable)
              Text(_roleLabels[role] ?? role, style: DesktopChrome.metadata())
            else ...[
              AppSelectField<String>(
                key: ValueKey('team-role-$id'),
                value: role,
                width: 110,
                semanticLabel: 'Role',
                options: [
                  for (final option in _gives)
                    SelectOption(value: option, label: _roleLabels[option]!),
                ],
                onChanged: (value) {
                  if (value == role) return;
                  unawaited(
                    _run('POST', '$_path/members/${Uri.encodeComponent(id)}', {
                      'role': value,
                    }),
                  );
                },
              ),
              const SizedBox(width: 8),
              if (_confirming == id)
                Tooltip(
                  message:
                      'Also removes them from every Swarm of the $kTeamLabel',
                  child: TextButton(
                    key: ValueKey('team-remove-confirm-$id'),
                    onPressed: _busy
                        ? null
                        : () {
                            setState(() => _confirming = null);
                            unawaited(
                              _run(
                                'POST',
                                '$_path/members/${Uri.encodeComponent(id)}/remove',
                                {},
                              ),
                            );
                          },
                    child: const Text('Remove'),
                  ),
                )
              else
                IconButton(
                  key: ValueKey('team-remove-$id'),
                  tooltip: 'Remove from the $kTeamLabel',
                  icon: Icon(AppIcons.trash2, size: AppIcons.inlineSize),
                  onPressed: _busy
                      ? null
                      : () => setState(() => _confirming = id),
                ),
            ],
          ],
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) {
    final members = _members;
    final here = c.snapshot?.orgId == widget.team.id;
    return Dialog(
      backgroundColor: Colors.transparent,
      elevation: 0,
      shape: DesktopChrome.bareDialogShape,
      child: DesktopDialogSurface(
        child: SizedBox(
          width: 480,
          child: Padding(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                DesktopDialogHeader(
                  title: widget.team.name,
                  detail: '$kTeamLabel settings',
                  padding: EdgeInsets.zero,
                  onClose: () => Navigator.pop(context),
                ),
                const SizedBox(height: 16),
                Flexible(
                  child: DesktopPromptScrollBody(
                    child: Column(
                      mainAxisSize: MainAxisSize.min,
                      crossAxisAlignment: CrossAxisAlignment.stretch,
                      children: [
                        Row(
                          children: [
                            Expanded(
                              child: TextField(
                                key: const ValueKey('team-invite-email'),
                                controller: _email,
                                enabled: !_busy,
                                keyboardType: TextInputType.emailAddress,
                                decoration: const InputDecoration(
                                  hintText: 'Email address',
                                ),
                                onChanged: (_) => setState(() {}),
                                onSubmitted: (_) => unawaited(_invite()),
                              ),
                            ),
                            const SizedBox(width: 8),
                            AppSelectField<String>(
                              key: const ValueKey('team-invite-role'),
                              value: _inviteRole,
                              width: 110,
                              semanticLabel: 'Invited as',
                              options: [
                                for (final option in _gives)
                                  SelectOption(
                                    value: option,
                                    label: _roleLabels[option]!,
                                  ),
                              ],
                              onChanged: (value) =>
                                  setState(() => _inviteRole = value),
                            ),
                            const SizedBox(width: 8),
                            FilledButton(
                              key: const ValueKey('team-invite-send'),
                              onPressed: _busy || _email.text.trim().isEmpty
                                  ? null
                                  : () => unawaited(_invite()),
                              child: const Text('Invite'),
                            ),
                          ],
                        ),
                        if (_error case final error?)
                          Padding(
                            padding: const EdgeInsets.only(top: 8),
                            child: Text(error, style: DesktopChrome.metadata()),
                          ),
                        const SizedBox(height: 16),
                        if (members == null)
                          const Center(child: CircularProgressIndicator())
                        else
                          for (final person in members) _person(person),
                        if (here) ...[
                          const SizedBox(height: 16),
                          SwitchListTile(
                            key: const ValueKey('team-swarm-open'),
                            contentPadding: EdgeInsets.zero,
                            value: _open,
                            title: Text(
                              'Open ${c.snapshot?.name ?? 'this Swarm'} to the $kTeamLabel',
                              style: DesktopChrome.control(),
                            ),
                            subtitle: Text(
                              'Members can find and join it. Guests still need an invitation.',
                              style: DesktopChrome.metadata(),
                            ),
                            onChanged: _busy
                                ? null
                                : (value) {
                                    setState(() => _open = value);
                                    unawaited(
                                      _run(
                                        'POST',
                                        '/api/super-tabs/${Uri.encodeComponent(c.tabId)}/org-visibility',
                                        {
                                          'visibility': value
                                              ? 'org'
                                              : 'invite-only',
                                        },
                                      ),
                                    );
                                  },
                          ),
                        ],
                      ],
                    ),
                  ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
