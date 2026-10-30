import 'package:flutter/material.dart';
import 'package:url_launcher/url_launcher.dart';

/// Autonomous's privacy policy: the one address every listing of Harness names for it — the MCP
/// bundle's `privacy_policies` (cli/packages/harness-mcp/mcpb/manifest.json) and the directory
/// submissions (docs/research/2026-10-11-listing-submissions.md, "use the same words everywhere").
///
/// ⚠️ **In the app because the stores ask for it there, not only beside the listing.** App Store
/// guideline 5.1.1(i) wants the policy "within the app in an easily accessible manner", and Play's
/// App content form asks for the same address (`mobile/RELEASE.md`). Settings ▸ About is where it is.
const kPrivacyPolicyUrl = 'https://www.autonomous.ai/privacy';

/// How the policy is opened: the system's in-app browser (Safari's sheet, a Custom Tab), the way
/// connectors open their sign-in pages, so Back is the way home. A field only so a test can see
/// what is opened without a browser.
@visibleForTesting
Future<bool> Function(Uri url) openPrivacyPolicyUrl = (url) =>
    launchUrl(url, mode: LaunchMode.inAppBrowserView);

/// Settings ▸ About ▸ Privacy Policy: opens the policy, and says so when no browser would — the
/// connectors' words for the same failure.
Future<void> openPrivacyPolicy(BuildContext context) async {
  final messenger = ScaffoldMessenger.maybeOf(context);
  var opened = false;
  try {
    opened = await openPrivacyPolicyUrl(Uri.parse(kPrivacyPolicyUrl));
  } catch (_) {
    // A platform that refused outright: the same answer as one that said no.
  }
  if (opened) return;
  messenger?.showSnackBar(
    const SnackBar(content: Text('Could not open the browser.')),
  );
}
