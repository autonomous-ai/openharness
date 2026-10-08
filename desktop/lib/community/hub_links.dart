import 'package:url_launcher/url_launcher.dart';

/// Where a publication is reviewed when the app cannot hand it over.
final hubPublishPage = Uri.parse('https://harness.autonomous.ai/hub/publish');

/// Opens a Hub page, or says where to go when nothing on this computer can.
Future<void> openHubPage(
  Uri url, {
  LaunchMode mode = LaunchMode.platformDefault,
}) async {
  if (!await launchUrl(url, mode: mode)) {
    throw const FormatException(
      'Could not open the Hub. Open harness.autonomous.ai/hub/publish to continue.',
    );
  }
}
