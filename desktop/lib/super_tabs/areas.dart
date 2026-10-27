import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'identity.dart';
import 'model.dart';

/// What each person covers in a project (devices, mobile, product...), so a
/// Lead picks a group's partner from it: set by that person or the project's
/// owner, read by its members (backend project.areas).

const _maxAreas = 10, _maxLength = 40;

/// The areas typed in [text], comma separated, each once; or why they cannot
/// be saved.
({List<String> areas, String? error}) superTabParseAreas(String text) {
  final areas = {
    for (final area in text.split(','))
      if (area.trim().isNotEmpty) area.trim(),
  }.toList();
  final error = areas.any((a) => a.length > _maxLength)
      ? 'Keep each area to $_maxLength characters.'
      : areas.length > _maxAreas
      ? 'List at most $_maxAreas areas.'
      : null;
  return (areas: areas, error: error);
}

/// The selected conversation's project, whose areas the roster shows.
SuperTabProject? _projectOf(SuperTabController c) => c.snapshot?.projects
    .where((p) => p.id == c.selected?.projectId)
    .firstOrNull;

/// A person in the Swarm: their email, role and areas in the selected
/// project, with Edit areas for them and for the project's owner.
Future<void> showSuperTabPerson(
  BuildContext context,
  SuperTabController c,
  SuperTabPerson person, {
  required VoidCallback onManage,
}) {
  final project = _projectOf(c);
  final areas = project?.areas[person.id] ?? const <String>[];
  final editable =
      project != null &&
      c.canWrite &&
      (person.id == c.accountId || project.ownerId == c.accountId);
  return showAppDialog<void>(
    context: context,
    builder: (context) => AlertDialog(
      title: Text(superTabPersonName(person.email)),
      content: Text(
        [
          person.email,
          person.role,
          if (areas.isNotEmpty) 'Areas: ${areas.join(', ')}',
        ].join('\n'),
      ),
      actions: [
        if (editable)
          TextButton(
            onPressed: () {
              Navigator.pop(context);
              _editAreas(context, c, project, person, areas);
            },
            child: const Text('Edit areas'),
          ),
        TextButton(
          onPressed: () {
            Navigator.pop(context);
            onManage();
          },
          child: const Text('Manage people'),
        ),
        TextButton(
          onPressed: () => Navigator.pop(context),
          child: const Text('Close'),
        ),
      ],
    ),
  );
}

Future<void> _editAreas(
  BuildContext context,
  SuperTabController c,
  SuperTabProject project,
  SuperTabPerson person,
  List<String> areas,
) {
  var text = areas.join(', ');
  String? error;
  return showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      projectId: project.id,
      child: StatefulBuilder(
        builder: (context, update) => AlertDialog(
          title: Text('${superTabPersonName(person.email)}\'s areas'),
          content: TextFormField(
            key: const ValueKey('super-areas-field'),
            initialValue: text,
            autofocus: true,
            decoration: InputDecoration(
              hintText: 'devices, mobile, product',
              helperText: 'Separate areas with commas.',
              errorText: error,
            ),
            onChanged: (value) => text = value,
          ),
          actions: [
            TextButton(
              onPressed: () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            TextButton(
              onPressed: () async {
                final parsed = superTabParseAreas(text);
                if (parsed.error != null) {
                  update(() => error = parsed.error);
                  return;
                }
                final saved = await c.command({
                  'type': 'project.areas',
                  'projectId': project.id,
                  'personId': person.id,
                  'areas': parsed.areas,
                });
                if (!context.mounted) return;
                if (saved == null) {
                  update(() => error = c.operationError);
                  return;
                }
                Navigator.pop(context);
              },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    ),
  );
}
