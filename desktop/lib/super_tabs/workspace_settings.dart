import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/app_icon_button.dart';
import '../shared/widgets/app_menu.dart';
import '../shared/widgets/app_select_field.dart';
import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';
import 'controller.dart';
import 'workspaces.dart';

Future<void> showSwarmWorkspaceSettings(
  BuildContext context,
  SwarmWorkspaces workspaces,
  SwarmWorkspace workspace,
) => showAppDialog<void>(
  context: context,
  builder: (_) => SwarmWorkspaceSettingsDialog(
    workspaces: workspaces,
    workspaceId: workspace.id,
  ),
);

const _months = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/// Workspace settings, for its owners and admins: its name, its people and
/// their roles, invitations, and whether each Swarm is open to the Workspace.
/// The backend decides every change; a control is offered only where the
/// person's role may make it, and a refusal is shown in the backend's words.
class SwarmWorkspaceSettingsDialog extends StatefulWidget {
  const SwarmWorkspaceSettingsDialog({
    super.key,
    required this.workspaces,
    required this.workspaceId,
  });
  final SwarmWorkspaces workspaces;
  final String workspaceId;

  @override
  State<SwarmWorkspaceSettingsDialog> createState() =>
      _SwarmWorkspaceSettingsDialogState();
}

class _SwarmWorkspaceSettingsDialogState
    extends State<SwarmWorkspaceSettingsDialog> {
  final _name = TextEditingController();
  final _email = TextEditingController();
  SwarmWorkspaceRole? _inviteRole;
  SwarmWorkspacePeople? _people;
  String? _error;
  bool _busy = false;

  /// People removed here whose Swarms are still being left, with how many.
  final _leaving = <String, int>{};

  SwarmWorkspacesApi get _api => widget.workspaces.api;

  SwarmWorkspace? get _workspace => widget.workspaces.workspaces
      ?.where((w) => w.id == widget.workspaceId)
      .firstOrNull;

  @override
  void initState() {
    super.initState();
    _name.text = _workspace?.name ?? '';
    _email.addListener(() => setState(() {}));
    unawaited(_load());
  }

  @override
  void dispose() {
    _name.dispose();
    _email.dispose();
    super.dispose();
  }

  Future<void> _load() async {
    try {
      final people = await _api.members(widget.workspaceId);
      if (mounted) setState(() => _people = people);
    } on SuperTabFailure catch (failure) {
      if (mounted) setState(() => _error = failure.message);
    }
  }

  /// Runs one change, then reads the people and the Workspaces again.
  Future<void> _change(Future<void> Function() change) async {
    if (_busy) return;
    setState(() {
      _busy = true;
      _error = null;
    });
    try {
      await change();
      await Future.wait([_load(), widget.workspaces.refresh()]);
    } on SuperTabFailure catch (failure) {
      if (mounted) setState(() => _error = failure.message);
    } finally {
      if (mounted) setState(() => _busy = false);
    }
  }

  Future<bool> _confirm(String title, String body, String action) async =>
      await showAppDialog<bool>(
        context: context,
        builder: (context) => AlertDialog(
          title: Text(title),
          content: Text(body),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: () => Navigator.pop(context, true),
              child: Text(action),
            ),
          ],
        ),
      ) ==
      true;

  Future<void> _remove(SwarmWorkspaceMember person) async {
    final confirmed = await _confirm(
      'Remove ${person.email}?',
      'They leave every Swarm of this Workspace, and their agents there stop.',
      'Remove',
    );
    if (!confirmed || !mounted) return;
    await _change(() async {
      final pending = await _api.remove(widget.workspaceId, person.userId);
      if (pending > 0) _leaving[person.email] = pending;
    });
  }

  Future<void> _makeOwner(SwarmWorkspaceMember person) async {
    final confirmed = await _confirm(
      'Make ${person.email} the owner?',
      'You stay in this Workspace as an admin.',
      'Make owner',
    );
    if (!confirmed || !mounted) return;
    await _change(() => _api.transfer(widget.workspaceId, person.userId));
  }

  void _invite(SwarmWorkspaceRole role) {
    final email = _email.text.trim();
    if (email.isEmpty) return;
    unawaited(
      _change(() async {
        await _api.invite(
          widget.workspaceId,
          email: email,
          role: _inviteRole ?? role,
        );
        _email.clear();
      }),
    );
  }

  String _until(DateTime at) => 'until ${at.day} ${_months[at.month - 1]}';

  Widget _roleSelect({
    required Key key,
    required SwarmWorkspaceRole value,
    required List<SwarmWorkspaceRole> options,
    required String label,
    required ValueChanged<SwarmWorkspaceRole> onChanged,
  }) => ExcludeFocus(
    excluding: _busy,
    child: IgnorePointer(
      ignoring: _busy,
      child: AppSelectField<SwarmWorkspaceRole>(
        key: key,
        value: value,
        options: [
          for (final role in options)
            SelectOption(value: role, label: role.label),
        ],
        semanticLabel: label,
        textStyle: DesktopChrome.control(),
        width: 112,
        fillColor: Colors.transparent,
        selected: false,
        onChanged: (role) {
          if (!_busy && role != value) onChanged(role);
        },
      ),
    ),
  );

  Widget _personMenu(SwarmWorkspace workspace, SwarmWorkspaceMember person) =>
      MenuAnchor(
        consumeOutsideTap: true,
        style: grid.AppMenu.style(minWidth: 180),
        menuChildren: [
          if (workspace.role == SwarmWorkspaceRole.owner &&
              person.role == SwarmWorkspaceRole.admin)
            AppMenuItem(
              icon: AppIcons.shieldCheck,
              label: 'Make owner',
              onPressed: () => unawaited(_makeOwner(person)),
            ),
          AppMenuItem(
            icon: AppIcons.circleMinus,
            label: 'Remove',
            danger: true,
            onPressed: () => unawaited(_remove(person)),
          ),
        ],
        builder: (context, menu, _) => AppIconButton(
          key: const ValueKey('workspace-person-menu'),
          icon: AppIcons.ellipsis,
          tooltip: 'More for ${person.email}',
          onPressed: _busy
              ? null
              : () => menu.isOpen ? menu.close() : menu.open(),
        ),
      );

  Widget _person(SwarmWorkspace workspace, SwarmWorkspaceMember person) {
    final self = person.userId == widget.workspaces.client.account;
    final manages = !self && workspace.role.manages(person.role);
    return Padding(
      key: ValueKey('workspace-person-${person.email}'),
      padding: const EdgeInsets.symmetric(vertical: 4),
      child: Row(
        children: [
          Expanded(
            child: Text(
              person.email,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.text(),
            ),
          ),
          const SizedBox(width: 8),
          if (manages) ...[
            _roleSelect(
              key: const ValueKey('workspace-role'),
              value: person.role,
              options: workspace.role.gives,
              label: 'Role of ${person.email}',
              onChanged: (role) => unawaited(
                _change(
                  () => _api.setRole(widget.workspaceId, person.userId, role),
                ),
              ),
            ),
            const SizedBox(width: 4),
            _personMenu(workspace, person),
          ] else
            Padding(
              padding: const EdgeInsets.only(right: 4),
              child: Text(person.role.label, style: DesktopChrome.metadata()),
            ),
        ],
      ),
    );
  }

  Widget _heading(String text) => Padding(
    padding: const EdgeInsets.only(top: 20, bottom: 4),
    child: Text(text, style: DesktopChrome.control(medium: true)),
  );

  List<Widget> _nameRow(SwarmWorkspace workspace) => [
    Row(
      children: [
        Expanded(
          child: TextField(
            key: const ValueKey('workspace-name'),
            controller: _name,
            enabled: !_busy,
            decoration: const InputDecoration(hintText: 'Workspace name'),
            onSubmitted: (_) => _rename(workspace),
          ),
        ),
        const SizedBox(width: 8),
        TextButton(
          onPressed: _busy ? null : () => _rename(workspace),
          child: const Text('Rename'),
        ),
      ],
    ),
  ];

  void _rename(SwarmWorkspace workspace) {
    final name = _name.text.trim();
    if (name.isEmpty || name == workspace.name) return;
    unawaited(_change(() => _api.rename(widget.workspaceId, name)));
  }

  List<Widget> _inviteRow(SwarmWorkspace workspace, {required bool narrow}) {
    final roles = workspace.role.gives;
    final role = _inviteRole ?? SwarmWorkspaceRole.member;
    return [
      _heading('Invite'),
      Builder(
        builder: (context) {
          final email = TextField(
            key: const ValueKey('workspace-invite-email'),
            controller: _email,
            enabled: !_busy,
            keyboardType: TextInputType.emailAddress,
            textInputAction: TextInputAction.send,
            decoration: const InputDecoration(hintText: 'Email address'),
            onSubmitted: (_) => _invite(role),
          );
          final controls = [
            _roleSelect(
              key: const ValueKey('workspace-invite-role'),
              value: role,
              options: roles,
              label: 'Invitation role',
              onChanged: (role) => setState(() => _inviteRole = role),
            ),
            const SizedBox(width: 8),
            FilledButton(
              key: const ValueKey('workspace-invite-send'),
              onPressed: _busy || _email.text.trim().isEmpty
                  ? null
                  : () => _invite(role),
              child: const Text('Invite'),
            ),
          ];
          // A narrow window puts the role and Invite under the address.
          if (narrow) {
            return Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                email,
                const SizedBox(height: 8),
                Wrap(
                  alignment: WrapAlignment.end,
                  crossAxisAlignment: WrapCrossAlignment.center,
                  runSpacing: 8,
                  children: controls,
                ),
              ],
            );
          }
          return Row(
            children: [
              Expanded(child: email),
              const SizedBox(width: 8),
              ...controls,
            ],
          );
        },
      ),
    ];
  }

  /// Below this width the invite controls stack and selects narrow.
  static const _wideFrom = 400.0;

  Widget _swarmVisibility(SwarmWorkspaceSwarm swarm) => ExcludeFocus(
    excluding: _busy,
    child: IgnorePointer(
      ignoring: _busy,
      child: AppSelectField<bool>(
        key: ValueKey('workspace-swarm-${swarm.id}'),
        value: swarm.openToWorkspace,
        options: const [
          SelectOption(
            value: false,
            label: 'Invite only',
            detail: 'Only people invited to this Swarm see it',
          ),
          SelectOption(
            value: true,
            label: 'Open to Workspace',
            detail: 'Members see it and can join',
          ),
        ],
        semanticLabel: 'Who sees ${swarm.name}',
        textStyle: DesktopChrome.control(),
        width: 180,
        menuWidth: 260,
        menuAlignedToEnd: true,
        fillColor: Colors.transparent,
        selected: false,
        onChanged: (open) {
          if (_busy || open == swarm.openToWorkspace) return;
          unawaited(
            _change(() => _api.setSwarmOpenToWorkspace(swarm.id, open: open)),
          );
        },
      ),
    ),
  );

  Widget _swarmName(SwarmWorkspaceSwarm swarm) => Text(
    swarm.name,
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: DesktopChrome.text(),
  );

  /// Each Swarm with who sees it: beside its name, or under it when narrow.
  List<Widget> _swarms(SwarmWorkspace workspace, {required bool narrow}) => [
    _heading('Swarms'),
    for (final swarm in workspace.swarms)
      Padding(
        padding: const EdgeInsets.symmetric(vertical: 4),
        child: narrow
            ? Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [_swarmName(swarm), _swarmVisibility(swarm)],
              )
            : Row(
                children: [
                  Expanded(child: _swarmName(swarm)),
                  _swarmVisibility(swarm),
                ],
              ),
      ),
    if (workspace.swarms.isEmpty)
      Text('No Swarms yet', style: DesktopChrome.metadata()),
  ];

  List<Widget> _peopleList(SwarmWorkspace workspace) {
    final people = _people;
    if (people == null) {
      return [
        _heading('People'),
        if (_error == null) Text('Loading…', style: DesktopChrome.metadata()),
      ];
    }
    return [
      _heading('People'),
      for (final person in people.members) _person(workspace, person),
      for (final MapEntry(key: email, value: count) in _leaving.entries)
        if (!people.members.any((m) => m.email == email))
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Text(
              'Removing $email from $count ${count == 1 ? 'Swarm' : 'Swarms'}…',
              style: DesktopChrome.metadata(),
            ),
          ),
      if (people.invitations.isNotEmpty) ...[
        _heading('Invited'),
        // The address, and under it the role and the last day, as the
        // Share Swarm dialog lists its invitations.
        for (final invitation in people.invitations)
          Padding(
            padding: const EdgeInsets.symmetric(vertical: 4),
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  invitation.email,
                  maxLines: 1,
                  overflow: TextOverflow.ellipsis,
                  style: DesktopChrome.text(),
                ),
                Text(
                  '${invitation.role.label} · ${_until(invitation.expiresAt)}',
                  style: DesktopChrome.metadata(),
                ),
              ],
            ),
          ),
      ],
    ];
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.workspaces,
    builder: (context, _) {
      final workspace = _workspace;
      // A phone-width browser keeps a 16-point gutter around the dialog.
      final compact = MediaQuery.sizeOf(context).width < 600;
      return Dialog(
        insetPadding: compact ? const EdgeInsets.all(16) : null,
        backgroundColor: Colors.transparent,
        elevation: 0,
        shape: DesktopChrome.bareDialogShape,
        child: DesktopDialogSurface(
          child: ConstrainedBox(
            constraints: const BoxConstraints(maxWidth: 520),
            child: Padding(
              padding: EdgeInsets.all(compact ? 16 : 24),
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.stretch,
                children: [
                  DesktopDialogHeader(
                    title: 'Workspace settings',
                    padding: EdgeInsets.zero,
                    onClose: () => Navigator.maybePop(context),
                  ),
                  const SizedBox(height: 16),
                  if (workspace == null)
                    Text(
                      'This Workspace is no longer listed for you.',
                      style: DesktopChrome.metadata(),
                    )
                  else
                    Flexible(
                      child: DesktopPromptScrollBody(
                        child: LayoutBuilder(
                          builder: (context, constraints) {
                            final narrow = constraints.maxWidth < _wideFrom;
                            return Column(
                              mainAxisSize: MainAxisSize.min,
                              crossAxisAlignment: CrossAxisAlignment.stretch,
                              children: [
                                if (workspace.role.renames)
                                  ..._nameRow(workspace)
                                else
                                  Text(
                                    workspace.name,
                                    style: DesktopChrome.heading(),
                                  ),
                                if (workspace.role.managesPeople)
                                  ..._inviteRow(workspace, narrow: narrow),
                                if (_error != null)
                                  Padding(
                                    padding: const EdgeInsets.only(top: 8),
                                    child: Text(
                                      _error!,
                                      style: DesktopChrome.metadata(),
                                    ),
                                  ),
                                ..._peopleList(workspace),
                                if (workspace.role.managesPeople)
                                  ..._swarms(workspace, narrow: narrow),
                              ],
                            );
                          },
                        ),
                      ),
                    ),
                  const SizedBox(height: 24),
                  Align(
                    alignment: Alignment.centerRight,
                    child: TextButton(
                      onPressed: () => Navigator.maybePop(context),
                      child: const Text('Done'),
                    ),
                  ),
                ],
              ),
            ),
          ),
        ),
      );
    },
  );
}
