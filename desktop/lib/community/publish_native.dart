import 'package:url_launcher/url_launcher.dart';

import '../state/app_state.dart';
import 'publish_project.dart';

final _hubPublish = Uri.parse('https://harness.autonomous.ai/hub/publish');

/// Sends a local harness's draft to the Hub and returns what the person should do next there.
Future<String> publishHarness(
  AppNotifier app,
  String machineId,
  String agentId,
) async {
  final machine = app.stateOf(machineId);
  final agent = machine?.agents.where((a) => a.id == agentId).firstOrNull;
  if (agent == null) {
    throw const FormatException('This harness is no longer available.');
  }
  // Only this computer's files can be read from here.
  // TODO: read another machine's project through its CLI, the way readSessionTail reads its session.
  if (machine?.isLocalMachine != true || agent.project?.cwd == null) {
    await _open(_hubPublish);
    return 'This harness runs on another computer, so its files cannot be sent from here. '
        'Choose its project folder on the Hub page that opened.';
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
  try {
    await _open(handoff.url);
  } on FormatException {
    await handoff.close();
    rethrow;
  }
  return 'Review your files and conversation in the Hub, then publish.';
}

Future<void> _open(Uri url) async {
  if (!await launchUrl(url, mode: LaunchMode.externalApplication)) {
    throw const FormatException(
      'Could not open the Hub. Open harness.autonomous.ai/hub/publish to continue.',
    );
  }
}
