import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'model.dart';
import 'swarm_buddy.dart' show swarmCanWrite;
import 'swarm_leaderboard.dart' show SwarmProjectSheetFrame;
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_row.dart';
import 'swarm_style.dart';

/// Whether the person may rename [projectId] and change its sharing: its
/// owner, while they may write (the desktop's `editable && owner`; the
/// server's `manageProject`).
bool swarmManagesProject(SwarmReader reader, String projectId) {
  final project = reader.accessRevoked
      ? null
      : reader.snapshot?.projectById(projectId);
  return project != null &&
      project.ownerId == reader.accountId &&
      swarmCanWrite(reader);
}

/// Renames [projectId] to [name], trimmed (backend `project.rename`); null
/// once the server kept it and the Swarm is read again, else the sentence to
/// show.
Future<String?> swarmRenameProject(
  SwarmReader reader,
  String projectId,
  String name,
) => _send(reader, projectId, {
  'type': 'project.rename',
  'projectId': projectId,
  'name': name.trim(),
});

/// Makes [projectId] private to its owner and [memberIds], or public to the
/// whole Swarm (backend `project.sharing`); null once the server kept it and
/// the Swarm is read again, else the sentence to show. Only people still in
/// the Swarm are sent: the server refuses an id it no longer has.
Future<String?> swarmShareProject(
  SwarmReader reader,
  String projectId, {
  required bool private,
  required Iterable<String> memberIds,
}) {
  final people = {
    for (final person in reader.snapshot?.people ?? const <SuperTabPerson>[])
      person.id,
  };
  return _send(reader, projectId, {
    'type': 'project.sharing',
    'projectId': projectId,
    'visibility': private ? 'private' : 'public',
    'memberIds': [
      for (final id in memberIds)
        if (people.contains(id)) id,
    ],
  });
}

Future<String?> _send(
  SwarmReader reader,
  String projectId,
  Map<String, dynamic> command,
) async {
  if (!swarmManagesProject(reader, projectId)) return _notAllowed;
  try {
    await reader.request(
      'POST',
      '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}/commands',
      body: {'operationId': superTabOperationId(), 'command': command},
    );
  } on SuperTabFailure catch (failure) {
    return failure.message;
  } catch (_) {
    // A call lost on the way (a timeout, a socket dropped) is no answer.
    return _notSent;
  }
  await reader.refresh();
  return null;
}

const _notAllowed = 'Only the project owner can manage this project.';
const _notSent = 'Could not reach this Swarm. Try again.';

/// The project menu's Project settings… (the desktop's `showProjectSettings`):
/// Rename project for its owner who may write, and Project details
/// ([onDetails]) for everyone who reads it. Each runs once the sheet has
/// closed. [onShown] is handed its route, for the page to take it down with
/// the project.
Future<void> showSwarmProjectSettings(
  BuildContext context,
  SwarmReader reader,
  String projectId, {
  required VoidCallback onDetails,
  void Function(Route<void> route)? onShown,
}) => showPhoneSheet(
  context,
  title: 'Project settings',
  onShown: onShown,
  // Made the owner's, or no longer, on another device meanwhile.
  rebuildOn: reader,
  rows: () => (
    actions: [
      if (swarmManagesProject(reader, projectId))
        PhoneSheetAction(
          icon: LucideIcons.pencil300,
          label: 'Rename project',
          onTap: () =>
              unawaited(showSwarmRenameProject(context, reader, projectId)),
        ),
      PhoneSheetAction(
        icon: LucideIcons.info300,
        label: 'Project details',
        chevron: true,
        onTap: onDetails,
      ),
    ],
    sections: const <PhoneSheetSection>[],
  ),
);

/// Renames project [projectId] in a dialog: its name to edit, Save, and the
/// server's refusal under the field. It goes once the person can no longer
/// manage the project ([swarmManagesProject]): access lost, a viewer now,
/// another owner, or the project gone.
Future<void> showSwarmRenameProject(
  BuildContext context,
  SwarmReader reader,
  String projectId,
) async {
  if (!context.mounted || !swarmManagesProject(reader, projectId)) return;
  await showDialog<void>(
    context: context,
    builder: (_) => SwarmGoesWithProject(
      reader: reader,
      projectId: projectId,
      child: SwarmRenameProjectDialog(reader: reader, projectId: projectId),
    ),
  );
}

/// Closes the route it is in once the person can no longer manage project
/// [projectId] ([swarmManagesProject]).
class SwarmGoesWithProject extends StatefulWidget {
  const SwarmGoesWithProject({
    super.key,
    required this.reader,
    required this.projectId,
    required this.child,
  });

  final SwarmReader reader;
  final String projectId;
  final Widget child;

  @override
  State<SwarmGoesWithProject> createState() => _SwarmGoesWithProjectState();
}

class _SwarmGoesWithProjectState extends State<SwarmGoesWithProject> {
  bool _closed = false;

  @override
  void initState() {
    super.initState();
    widget.reader.addListener(_moved);
  }

  @override
  void dispose() {
    widget.reader.removeListener(_moved);
    super.dispose();
  }

  void _moved() {
    if (_closed ||
        !mounted ||
        swarmManagesProject(widget.reader, widget.projectId)) {
      return;
    }
    _closed = true;
    // Not while the reader tells its listeners: once this frame is done,
    // and only its own route, whatever is over it.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      if (route.isCurrent) {
        Navigator.of(context).pop();
      } else {
        Navigator.of(context).removeRoute(route);
      }
    });
  }

  @override
  Widget build(BuildContext context) => widget.child;
}

/// What [showSwarmRenameProject] shows: the desktop's Rename project, its
/// name trimmed, never empty, at most the backend's 160 characters.
class SwarmRenameProjectDialog extends StatefulWidget {
  const SwarmRenameProjectDialog({
    super.key,
    required this.reader,
    required this.projectId,
  });

  final SwarmReader reader;
  final String projectId;

  @override
  State<SwarmRenameProjectDialog> createState() =>
      _SwarmRenameProjectDialogState();
}

class _SwarmRenameProjectDialogState extends State<SwarmRenameProjectDialog> {
  /// The backend's limit (commands.ts `title`).
  static const _maxLength = 160;

  late final _name = TextEditingController(
    text: widget.reader.snapshot?.projectById(widget.projectId)?.name ?? '',
  );
  bool _saving = false;
  String? _error;

  @override
  void dispose() {
    _name.dispose();
    super.dispose();
  }

  Future<void> _save() async {
    if (_saving || _name.text.trim().isEmpty) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final error = await swarmRenameProject(
      widget.reader,
      widget.projectId,
      _name.text,
    );
    // Closed meanwhile (access lost, the project gone): the answer is for
    // nobody.
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _saving = false;
      _error = error;
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final empty = _name.text.trim().isEmpty;
    return AlertDialog(
      // A short phone with the keyboard up still shows the field and Save.
      scrollable: true,
      title: Text(
        'Rename project',
        style: AppType.heading(color: AppPalette.textPrimary),
      ),
      content: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          TextField(
            key: const ValueKey('swarm-project-name'),
            controller: _name,
            autofocus: true,
            enabled: !_saving,
            maxLength: _maxLength,
            textInputAction: TextInputAction.done,
            style: AppType.body(color: AppPalette.textPrimary),
            decoration: InputDecoration(
              counterText: '',
              filled: true,
              fillColor: AppPalette.swarmField,
              border: OutlineInputBorder(
                borderRadius: BorderRadius.circular(AppControl.radius),
                borderSide: BorderSide.none,
              ),
            ),
            onChanged: (_) => setState(() => _error = null),
            onSubmitted: (_) => unawaited(_save()),
          ),
          if (_error case final error?)
            Padding(
              padding: const EdgeInsets.only(top: AppSpace.s),
              child: Text(
                error,
                key: const ValueKey('swarm-project-name-error'),
                style: AppType.caption(color: AppColors.danger),
              ),
            ),
        ],
      ),
      actions: [
        SwarmButton(
          key: const ValueKey('swarm-project-name-cancel'),
          label: 'Cancel',
          style: SwarmButtonStyle.link,
          onPressed: _saving ? null : () => Navigator.of(context).pop(),
        ),
        SwarmButton(
          key: const ValueKey('swarm-project-name-save'),
          label: 'Save',
          style: SwarmButtonStyle.fill,
          busy: _saving,
          busyLabel: 'Saving…',
          onPressed: _saving || empty ? null : () => unawaited(_save()),
        ),
      ],
    );
  }
}

/// A string at [key] of [map], when it is one with something in it.
String? _text(Map<String, dynamic>? map, String key) => switch (map?[key]) {
  final String value when value.trim().isNotEmpty => value,
  _ => null,
};

/// Project details from Project settings…, read only, as the desktop's
/// details dialog has them: under the project's name, its description (its
/// chat's brief), its repository, and its coordinator by the name the project
/// gives it. Not the sheet a tap on the project's name opens
/// (`SwarmProjectDetailsSheet`), which is its actions. The page under it
/// closes it when the read, the access or the project is gone.
class SwarmProjectInfoSheet extends StatelessWidget {
  const SwarmProjectInfoSheet({
    super.key,
    required this.reader,
    required this.projectId,
  });

  final SwarmReader reader;
  final String projectId;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: reader,
    builder: (context, _) {
      AppTheme.watch(context);
      final snapshot = reader.accessRevoked ? null : reader.snapshot;
      final project = snapshot?.projectById(projectId);
      if (snapshot == null || project == null) return const SizedBox.shrink();
      final chat = snapshot.conversation(project.leadConversationId);
      final brief = chat?.brief.trim() ?? '';
      final repository =
          _text(project.repository, 'repositoryUrl') ??
          _text(project.repository, 'cwd') ??
          'Not set';
      final lead = chat?.leadId;
      return SwarmProjectSheetFrame(
        title: project.name,
        closeKey: 'swarm-project-info-close',
        child: ListView(
          key: ValueKey('swarm-project-info-$projectId'),
          padding: const EdgeInsets.fromLTRB(
            AppSpace.screenInset,
            AppSpace.xs,
            AppSpace.screenInset,
            AppSpace.l,
          ),
          children: [
            if (brief.isEmpty)
              Text(
                'No description yet',
                key: const ValueKey('swarm-project-info-description'),
                style: AppType.body(color: AppPalette.textSecondary),
              )
            else
              SelectableText(
                brief,
                key: const ValueKey('swarm-project-info-description'),
                style: AppType.body(color: AppPalette.textPrimary, height: 1.4),
              ),
            const SizedBox(height: AppSpace.l),
            SwarmGroup(
              children: [
                SwarmRow(
                  key: const ValueKey('swarm-project-info-repository'),
                  title: 'Repository',
                  detail: SelectableText(
                    repository,
                    style: AppType.caption(
                      color: AppPalette.textSecondary,
                      height: 1.35,
                    ),
                  ),
                  onTap: null,
                ),
                SwarmRow(
                  key: const ValueKey('swarm-project-info-coordinator'),
                  title: snapshot.coordinatorNameOf(project.id),
                  detail: SwarmRow.line(
                    lead == null ? 'Starting…' : snapshot.agentName(lead),
                  ),
                  onTap: null,
                ),
              ],
            ),
          ],
        ),
      );
    },
  );
}

/// The project menu's Sharing, for its owner who may write (the desktop's
/// Sharing dialog): Public or Private, and with Private the people of the
/// Swarm to tick, its owner always in; then Save. It goes once the person can
/// no longer manage the project ([SwarmGoesWithProject]); the page under it
/// closes it when the read or the project is gone.
class SwarmProjectSharingSheet extends StatefulWidget {
  const SwarmProjectSharingSheet({
    super.key,
    required this.reader,
    required this.projectId,
  });

  final SwarmReader reader;
  final String projectId;

  @override
  State<SwarmProjectSharingSheet> createState() =>
      _SwarmProjectSharingSheetState();
}

class _SwarmProjectSharingSheetState extends State<SwarmProjectSharingSheet> {
  late bool _private;

  /// Who is ticked: the project's members as the server counts them
  /// ([SuperTabProject.hasMember]), so someone who left the Swarm and came
  /// back is not, until ticked again.
  late final Set<String> _members;
  bool _saving = false;
  String? _error;

  @override
  void initState() {
    super.initState();
    final snapshot = widget.reader.snapshot;
    final project = snapshot?.projectById(widget.projectId);
    _private = project?.isPrivate ?? false;
    _members = {
      if (project != null)
        for (final person in snapshot!.people)
          if (project.hasMember(person)) person.id,
    };
  }

  Future<void> _save() async {
    if (_saving) return;
    setState(() {
      _saving = true;
      _error = null;
    });
    final error = await swarmShareProject(
      widget.reader,
      widget.projectId,
      private: _private,
      memberIds: _members,
    );
    // Closed meanwhile (access lost, the project gone): the answer is for
    // nobody.
    if (!mounted) return;
    if (error == null) {
      Navigator.of(context).pop();
      return;
    }
    setState(() {
      _saving = false;
      _error = error;
    });
  }

  Widget _visibility(String id, String title, String detail, IconData icon) {
    final on = (id == 'private') == _private;
    return SwarmRow(
      key: ValueKey('swarm-sharing-$id'),
      leading: Icon(
        icon,
        size: AppIconSize.besideText,
        color: AppPalette.textSecondary,
      ),
      title: title,
      detail: SwarmRow.line(detail),
      trailing: on
          ? Semantics(
              label: 'Selected',
              excludeSemantics: true,
              child: Icon(
                LucideIcons.check300,
                size: AppIconSize.besideText,
                color: AppPalette.swarmAccent,
              ),
            )
          : null,
      chevron: null,
      onTap: _saving
          ? null
          : () => setState(() {
              _private = id == 'private';
              _error = null;
            }),
    );
  }

  Widget _person(SuperTabPerson person, String ownerId) {
    final owner = person.id == ownerId;
    final ticked = owner || _members.contains(person.id);
    void toggle() => setState(() {
      _error = null;
      if (!_members.remove(person.id)) _members.add(person.id);
    });
    final enabled = !owner && !_saving;
    return SwarmRow(
      key: ValueKey('swarm-sharing-person-${person.id}'),
      // By the name the Swarm shows them by, over the email the desktop
      // lists: two of one name are still told apart.
      title: person.shownName,
      detail: SwarmRow.line(
        [person.email, if (owner) 'Project owner'].join(' · '),
      ),
      trailing: Checkbox(
        key: ValueKey('swarm-sharing-person-${person.id}-check'),
        value: ticked,
        visualDensity: VisualDensity.compact,
        materialTapTargetSize: MaterialTapTargetSize.shrinkWrap,
        onChanged: enabled ? (_) => toggle() : null,
      ),
      chevron: null,
      onTap: enabled ? toggle : null,
    );
  }

  @override
  Widget build(BuildContext context) => SwarmGoesWithProject(
    reader: widget.reader,
    projectId: widget.projectId,
    child: ListenableBuilder(
      listenable: widget.reader,
      builder: (context, _) {
        AppTheme.watch(context);
        final snapshot = widget.reader.accessRevoked
            ? null
            : widget.reader.snapshot;
        final project = snapshot?.projectById(widget.projectId);
        if (snapshot == null || project == null) {
          return const SizedBox.shrink();
        }
        return SwarmProjectSheetFrame(
          title: 'Sharing',
          closeKey: 'swarm-sharing-close',
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Expanded(
                child: ListView(
                  key: const ValueKey('swarm-sharing-list'),
                  padding: const EdgeInsets.fromLTRB(
                    AppSpace.screenInset,
                    AppSpace.xs,
                    AppSpace.screenInset,
                    AppSpace.l,
                  ),
                  children: [
                    SwarmGroup(
                      children: [
                        _visibility(
                          'public',
                          'Public',
                          'Everyone in this Swarm',
                          LucideIcons.users300,
                        ),
                        _visibility(
                          'private',
                          'Private',
                          'Only people you invite to this project',
                          LucideIcons.lock300,
                        ),
                      ],
                    ),
                    Padding(
                      padding: const EdgeInsets.fromLTRB(
                        AppSpace.xs,
                        AppSpace.l,
                        AppSpace.xs,
                        AppSpace.s,
                      ),
                      child: Text(
                        _private
                            ? 'Only the people below can open this project.'
                            : 'Everyone in this Swarm can open this project.',
                        key: const ValueKey('swarm-sharing-line'),
                        style: AppType.body(color: AppPalette.textSecondary),
                      ),
                    ),
                    if (_private)
                      SwarmGroup(
                        children: [
                          for (final person in snapshot.people)
                            _person(person, project.ownerId),
                        ],
                      ),
                  ],
                ),
              ),
              Padding(
                padding: EdgeInsets.fromLTRB(
                  AppSpace.screenInset,
                  AppSpace.s,
                  AppSpace.screenInset,
                  AppSpace.l + MediaQuery.paddingOf(context).bottom,
                ),
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.stretch,
                  children: [
                    if (_error case final error?)
                      Padding(
                        padding: const EdgeInsets.only(bottom: AppSpace.s),
                        child: Text(
                          error,
                          key: const ValueKey('swarm-sharing-error'),
                          style: AppType.caption(color: AppColors.danger),
                        ),
                      ),
                    SwarmButton(
                      key: const ValueKey('swarm-sharing-save'),
                      label: 'Save',
                      style: SwarmButtonStyle.fill,
                      wide: true,
                      busy: _saving,
                      busyLabel: 'Saving…',
                      onPressed: _saving ? null : () => unawaited(_save()),
                    ),
                  ],
                ),
              ),
            ],
          ),
        );
      },
    ),
  );
}
