import 'package:url_launcher/url_launcher.dart';

import '../state/app_state.dart';
import 'publish_project.dart';

Future<void> publishHarness(
  AppNotifier app,
  String machineId,
  String agentId,
) async {
  final machine = app.stateOf(machineId);
  final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
  if (agent == null) {
    throw const FormatException('This harness is no longer available.');
  }
  if (machine?.isLocalMachine != true || agent.project?.cwd == null) {
    await launchUrl(
      Uri.parse('https://harness.autonomous.ai/hub/publish'),
      mode: LaunchMode.externalApplication,
    );
    return;
  }
  final tail = agent.sessionId == null
      ? null
      : await app.readSessionTail(machineId, agent.sessionId!, maxChars: 60000);
  final snapshot = await buildPublicationDraft(
    folder: agent.project!.cwd,
    title: agent.title ?? agent.name,
    engine: agent.engine ?? 'codex',
    harnessId: agent.dsh,
    tail: tail,
  );
  final handoff = await PublicationHandoff.start(snapshot);
  if (!await launchUrl(handoff.url, mode: LaunchMode.externalApplication)) {
    await handoff.close();
    throw const FormatException(
      'Could not open the Hub. Open harness.autonomous.ai/hub/publish to continue.',
    );
  }
}
