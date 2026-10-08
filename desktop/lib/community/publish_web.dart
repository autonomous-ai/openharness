import '../state/app_state.dart';
import 'hub_links.dart';

/// A browser cannot read a harness's files, so the person chooses them on the Hub.
Future<String> publishHarness(
  AppNotifier app,
  String machineId,
  String agentId,
) async {
  await openHubPage(hubPublishPage);
  return 'A browser cannot send a harness\'s files. Choose its project folder on the Hub page that opened.';
}
