import 'package:flutter/material.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'phone_sheet.dart';

/// The one "Delete agent" confirmation on the phone, opened from every place an
/// agent can be deleted: the list row's hold and the terminal page's `⋯`.
///
/// Its own file for the reason the desktop's `widgets/delete_agent_dialog.dart`
/// is: two copies would be two wordings of one irreversible act, and two ways of
/// reporting that it failed. Same argument order as that one, so the pair reads
/// as the same function on two platforms.
///
/// ⚠️ The wording has to say the work goes with it. Unlinking a machine — the
/// other red row in the same sheet — only forgets a password and leaves every
/// agent running; this destroys the agent on the machine. Both arrive looking
/// identical, so only the sentence tells them apart.
///
/// Nothing here removes anything from the screen. [AppNotifier.deleteAgent]
/// drops the agent from its machine's list and detaches every pane still showing
/// it; the list rebuilds off the notifier, and an open terminal page leaves on
/// its own once its pane is gone (`terminal_page.dart`, the `_hadPane` branch).
Future<void> confirmDeleteAgent(
  BuildContext context,
  AppNotifier notifier,
  String machineId,
  String agentId,
  String agentName,
) async {
  final confirmed = await confirmPhoneAction(
    context,
    title: 'Delete $agentName?',
    message:
        'The agent and its terminal session are removed from the machine, '
        "along with any work it has not finished. This can't be undone.",
    confirmLabel: 'Delete',
  );
  if (!confirmed || !context.mounted) return;
  final error = await notifier.deleteAgent(machineId, agentId);
  if (error == null || !context.mounted) return;
  ScaffoldMessenger.maybeOf(context)
      ?.showSnackBar(SnackBar(content: Text(error)));
}
