import 'package:url_launcher/url_launcher.dart';

import '../state/app_state.dart';

/// A browser cannot read a harness's files, so the person chooses them on the Hub.
Future<String> publishHarness(
  AppNotifier app,
  String machineId,
  String agentId,
) async {
  if (!await launchUrl(
    Uri.parse('https://harness.autonomous.ai/hub/publish'),
  )) {
    throw const FormatException(
      'Could not open the Hub. Open harness.autonomous.ai/hub/publish to continue.',
    );
  }
  return 'A browser cannot send a harness\'s files. Choose its project folder on the Hub page that opened.';
}
