import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'detail_dialog.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'project_add_people.dart' show projectHolds, projectPersonName;

/// Project settings ▸ People on a project on the Board (task #3820, #3819's Can chat): who may write in its chat.
/// Its owner and the Swarm's owner always may; the project's owner or the Swarm's owner grants it to others
/// (`project.canChat`), and the server refuses anyone else. Every member reads the list.
Future<void> showProjectPeople(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
) => showAppDialog<void>(
  context: context,
  builder: (context) => SuperTabDialogScope(
    controller: c,
    projectId: project.id,
    requireWrite: false,
    child: _ProjectPeople(controller: c, projectId: project.id),
  ),
);

class _ProjectPeople extends StatefulWidget {
  const _ProjectPeople({required this.controller, required this.projectId});

  final SuperTabController controller;
  final String projectId;

  @override
  State<_ProjectPeople> createState() => _ProjectPeopleState();
}

class _ProjectPeopleState extends State<_ProjectPeople> {
  SuperTabController get c => widget.controller;
  String? _error;

  Future<void> _set(SuperTabPerson person, bool granted) async {
    setState(() => _error = null);
    final refused = await c.setCanChat(
      widget.projectId,
      person.id,
      granted: granted,
    );
    if (mounted) setState(() => _error = refused);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: c,
      builder: (context, _) {
        final project = c.snapshot?.projectById(widget.projectId);
        if (project == null) return const SizedBox.shrink();
        final people = c.snapshot?.people ?? const <SuperTabPerson>[];
        final swarmOwner = c.snapshot?.ownerId;
        final members = [
          for (final p in people)
            if (p.id == project.ownerId || projectHolds(project, p)) p,
        ];
        // Only the project's owner or the Swarm's owner may grant it.
        final grants =
            c.canWrite &&
            !c.saving &&
            !c.hasPendingAction &&
            (project.ownerId == c.accountId || c.isOwner);
        return SuperTabDetailDialog(
          title: 'People',
          detail: project.name,
          body: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'Who may write in this project’s chat. Everyone else talks '
                'to their Buddy and proposes on the Board.',
                style: DesktopChrome.text(),
              ),
              const SizedBox(height: grid.AppDesktop.controlGap),
              for (final person in members)
                _row(
                  person,
                  always:
                      person.id == project.ownerId || person.id == swarmOwner,
                  granted: project.canChat(
                    person.id,
                    swarmOwner: person.id == swarmOwner,
                  ),
                  grants: grants,
                ),
              if (_error case final error?)
                Padding(
                  padding: const EdgeInsets.only(
                    top: grid.AppDesktop.controlGap,
                  ),
                  child: Text(
                    error,
                    key: const ValueKey('project-can-chat-error'),
                    style: DesktopChrome.metadata(),
                  ),
                ),
            ],
          ),
        );
      },
    );
  }

  Widget _row(
    SuperTabPerson person, {
    required bool always,
    required bool granted,
    required bool grants,
  }) {
    final enabled = grants && !always;
    void toggle(bool value) => unawaited(_set(person, value));
    return MergeSemantics(
      child: InkWell(
        key: ValueKey('project-can-chat-${person.id}'),
        onTap: enabled ? () => toggle(!granted) : null,
        child: Padding(
          padding: const EdgeInsets.symmetric(
            vertical: grid.AppDesktop.listRowGap,
          ),
          child: Row(
            children: [
              Expanded(
                child: Column(
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      projectPersonName(person),
                      style: DesktopChrome.control(),
                    ),
                    Text(
                      always ? 'Owner · always can chat' : 'Can chat',
                      style: DesktopChrome.metadata(),
                    ),
                  ],
                ),
              ),
              Switch(value: granted, onChanged: enabled ? toggle : null),
            ],
          ),
        ),
      ),
    );
  }
}
