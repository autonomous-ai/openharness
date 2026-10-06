import 'package:url_launcher/url_launcher.dart';

import '../state/app_state.dart';

Future<void> publishHarness(
  AppNotifier app,
  String machineId,
  String agentId,
) async {
  await launchUrl(Uri.parse('https://harness.autonomous.ai/hub/publish'));
}
