import 'package:flutter/material.dart';

import 'controller.dart';
import 'message_text.dart';

Future<void> showSuperTabWork(
  BuildContext context,
  SuperTabController c,
  String groupId,
) => showDialog<void>(
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
                if (group?.brief.isNotEmpty == true)
                  SuperTabMessageText(group!.brief)
                else
                  const Text(
                    'The lead hasn’t defined an assignment in this conversation yet.',
                  ),
                if (assignment != null) ...[
                  const SizedBox(height: 16),
                  Text(
                    '${c.snapshot?.agent(assignment['agentId'] as String)?.name ?? 'Agent unavailable'} · ${(assignment['status'] as String).replaceAll('_', ' ')}',
                  ),
                ],
                for (final check
                    in group?.checks ?? <Map<String, dynamic>>[]) ...[
                  const SizedBox(height: 16),
                  Text(
                    check['description'] as String,
                    style: const TextStyle(fontWeight: FontWeight.w600),
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
                  const Text(
                    'Result',
                    style: TextStyle(fontWeight: FontWeight.w600),
                  ),
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
  await showDialog<void>(
    context: context,
    builder: (context) => StatefulBuilder(
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
  );
}
