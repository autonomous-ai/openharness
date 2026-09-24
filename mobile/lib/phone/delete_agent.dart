import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

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
  // Where it runs, under the title — "machine · folder", the line the rename dialog carries — read
  // off the notifier as it stands now. An agent already gone from the list names the machine alone.
  final machine = notifier.stateOf(machineId);
  final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
  final confirmed = await confirmPhoneAction(
    context,
    // The Stop row's own icon — see [confirmPhoneAction].
    icon: LucideIcons.trash2300,
    title: 'Stop $agentName?',
    detail: [
      ?machine?.machine.displayName,
      ?agent?.project?.label,
    ].where((part) => part.isNotEmpty).join(' · '),
    // ⚠️ **The desktop's own sentence, word for word**, because it is the same
    // `agent_delete` on the wire (`AppNotifier.deleteAgent`, and desktop's
    // `widgets/delete_agent_dialog.dart`) — and the two used to describe it
    // differently. This phone said the unfinished work went with it; the
    // desktop says the files and the conversation stay. One call cannot be both,
    // and the desktop's is the one that matches what the daemon does: the
    // harness and its terminal session end, the folder on the machine does not.
    message:
        'Stop this harness? Project files and saved conversation history are '
        'kept.',
    confirmLabel: 'Stop',
  );
  if (!confirmed || !context.mounted) return;
  final error = await notifier.deleteAgent(machineId, agentId);
  if (error == null || !context.mounted) return;
  ScaffoldMessenger.maybeOf(context)
      ?.showSnackBar(SnackBar(content: Text(error)));
}
