import 'package:flutter/material.dart';

import 'controller.dart';

/// Keep a modal tied to the account and tab that opened it. Revocation removes
/// its captured form contents before a different account can see or submit them.
class SuperTabDialogScope extends StatelessWidget {
  const SuperTabDialogScope({
    super.key,
    required this.controller,
    required this.child,
    this.requireWrite = true,
    this.projectId,
    this.conversationId,
  });

  final SuperTabController controller;
  final Widget child;
  final bool requireWrite;
  final String? projectId, conversationId;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: controller,
    builder: (context, _) {
      if (!controller.accessRevoked &&
          controller.snapshot != null &&
          (projectId == null ||
              controller.snapshot!.projects.any((p) => p.id == projectId)) &&
          (conversationId == null ||
              controller.snapshot!.conversation(conversationId!) != null) &&
          (!requireWrite || controller.canWrite)) {
        // The shared backdrop owns a fallback focus node for Escape. A form
        // gets its own scope so its initial editor wins that fallback.
        return FocusScope(autofocus: true, child: child);
      }
      return AlertDialog(
        content: const Text('This action is no longer available.'),
        actions: [
          TextButton(
            onPressed: () => Navigator.pop(context),
            child: const Text('Close'),
          ),
        ],
      );
    },
  );
}
