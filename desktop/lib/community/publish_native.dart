import 'package:url_launcher/url_launcher.dart';

import '../state/app_state.dart';
import 'hub_links.dart';
import 'publish_files.dart' show NeedsOutput;
import 'publish_project.dart';
import 'viewer_picture.dart';

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
    await openHubPage(hubPublishPage, mode: LaunchMode.externalApplication);
    return 'This harness runs on another computer, so its files cannot be sent from here. '
        'Choose its project folder on the Hub page that opened.';
  }
  final tail = agent.sessionId == null
      ? null
      : await app.readSessionTail(machineId, agent.sessionId!, maxChars: 60000);
  Future<Map<String, dynamic>> draft({String? picture}) =>
      buildPublicationDraft(
        folder: agent.project!.cwd,
        title: agent.title ?? agent.name,
        engine: agent.engine ?? 'codex',
        harnessId: agent.dsh,
        tail: tail,
        viewerPicture: picture,
      );
  Map<String, dynamic> snapshot;
  try {
    snapshot = await draft();
  } on NeedsOutput {
    // No page of its own: what the harness shows now is the result, when it can be pictured.
    final picture = agent.viewerUrl == null
        ? null
        : await captureViewer(
            (payload) => app.viewerSurface(machineId, agentId, payload),
          );
    if (picture == null) rethrow;
    snapshot = await draft(picture: picture);
  }
  final handoff = await PublicationHandoff.start(snapshot);
  try {
    await openHubPage(handoff.url, mode: LaunchMode.externalApplication);
  } on FormatException {
    await handoff.close();
    rethrow;
  }
  return 'Review your files and conversation in the Hub, then publish.';
}
