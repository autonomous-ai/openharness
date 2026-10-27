import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/widgets/app_dialog.dart';
import '../widgets/desktop_chrome.dart';

import 'controller.dart';
import 'dialog_scope.dart';
import 'message_text.dart';
import 'model.dart';

Future<void> showSuperTabWork(
  BuildContext context,
  SuperTabController c,
  String groupId,
) {
  // A closed group stays readable here: one not held yet is read by id.
  unawaited(c.loadGroup(groupId));
  return _showWork(context, c, groupId);
}

Future<void> _showWork(
  BuildContext context,
  SuperTabController c,
  String groupId,
) => showAppDialog<void>(
  context: context,
  builder: (context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final group = c.snapshot?.conversation(groupId);
      final assignment = group?.assignment;
      return AlertDialog(
        title: Text(group?.title ?? 'Work details'),
        content: SizedBox(
          width: 520,
          child: SingleChildScrollView(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (group?.task case final task?) ...[
                  for (final section in [
                    ('Goal', task.goal),
                    ('Changes', task.changes),
                    ('Constraints', task.constraints),
                    ('Owns', task.owns.map((area) => '- $area').join('\n')),
                  ]) ...[
                    Text(
                      section.$1,
                      style: DesktopChrome.control(medium: true),
                    ),
                    const SizedBox(height: 4),
                    SuperTabMessageText(section.$2),
                    const SizedBox(height: 16),
                  ],
                ] else if (group?.brief.isNotEmpty == true)
                  SuperTabMessageText(group!.brief)
                else
                  const Text(
                    'The product manager hasn’t defined an assignment in this conversation yet.',
                  ),
                if (c.reviewLine(group) case final line?) ...[
                  const SizedBox(height: 16),
                  Text(line),
                ],
                if (assignment != null) ...[
                  const SizedBox(height: 16),
                  Text(
                    '${c.snapshot?.agentName(assignment['agentId'] as String, fallback: 'Agent unavailable') ?? 'Agent unavailable'} · ${superTabWorkStatusLabel(assignment['status'] as String)}',
                  ),
                ],
                if (group?.checks.isNotEmpty == true) ...[
                  const SizedBox(height: 16),
                  Text(
                    'Acceptance checks',
                    style: DesktopChrome.control(medium: true),
                  ),
                ],
                for (final check
                    in group?.checks ?? <Map<String, dynamic>>[]) ...[
                  const SizedBox(height: 16),
                  Text(
                    check['description'] as String,
                    style: DesktopChrome.control(medium: true),
                  ),
                  if (check['independent'] == true)
                    const Text('Requires an independent check.'),
                  if (check['evidence'] is String)
                    SuperTabMessageText(check['evidence'] as String),
                  Text(check['passedBy'] == null ? 'Not verified' : 'Verified'),
                  if (c.canWrite && assignment != null)
                    TextButton(
                      onPressed: c.saving || c.hasPendingAction
                          ? null
                          : () => _record(
                              context,
                              c,
                              groupId,
                              assignment['id'] as String,
                              check['id'] as String,
                            ),
                      child: const Text('Record check'),
                    ),
                ],
                if (assignment?['result'] is String) ...[
                  const SizedBox(height: 20),
                  Text('Result', style: DesktopChrome.control(medium: true)),
                  SuperTabMessageText(assignment!['result'] as String),
                ],
                if (c.operationError != null) Text(c.operationError!),
                if (c.hasPendingAction)
                  TextButton(
                    onPressed: c.saving ? null : c.retry,
                    child: const Text('Check pending action'),
                  ),
              ],
            ),
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      );
    },
  ),
);

Future<void> _record(
  BuildContext context,
  SuperTabController c,
  String group,
  String attempt,
  String check,
) async {
  var evidence = '', passed = true, busy = false;
  await showAppDialog<void>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      child: StatefulBuilder(
        builder: (context, update) => AlertDialog(
          title: const Text('Record check'),
          content: SizedBox(
            width: 460,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                TextField(
                  autofocus: true,
                  minLines: 3,
                  maxLines: 8,
                  decoration: const InputDecoration(
                    hintText: 'What did you verify? Include the revision, method and result.',
                  ),
                  onChanged: (value) => update(() => evidence = value),
                ),
                SwitchListTile(
                  title: const Text('Passed'),
                  value: passed,
                  onChanged: busy
                      ? null
                      : (value) => update(() => passed = value),
                ),
                if (c.operationError != null) Text(c.operationError!),
              ],
            ),
          ),
          actions: [
            TextButton(
              onPressed: busy ? null : () => Navigator.pop(context),
              child: const Text('Cancel'),
            ),
            FilledButton(
              onPressed: busy || evidence.trim().isEmpty
                  ? null
                  : () async {
                      update(() => busy = true);
                      final result = await c.command({
                        'type': 'work.check',
                        'conversationId': group,
                        'assignmentId': attempt,
                        'checkId': check,
                        'passed': passed,
                        'evidence': evidence.trim(),
                      });
                      if (!context.mounted) return;
                      if (result != null) {
                        Navigator.pop(context);
                      } else {
                        update(() => busy = false);
                      }
                    },
              child: const Text('Save'),
            ),
          ],
        ),
      ),
    ),
  );
}
