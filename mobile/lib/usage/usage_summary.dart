import 'package:flutter/foundation.dart';

/// The last figure the Usage page resolved, so the Settings row that opens it
/// can print something rather than a dash every single time.
///
/// ⚠️ **A cache, deliberately, and not a second poller.** That row is one line
/// in a list; giving it a `UsageController` of its own would put a minute-ly
/// relay round trip behind a screen whose whole job is to OFFER the screen that
/// already does that — two pollers asking the same machines the same question,
/// and a phone spending radio on a figure nobody asked to see. So the row shows
/// what the page last measured, and the page is where a fresh reading is
/// taken.
///
/// In memory only: a display convenience rather than a fact worth keeping
/// across launches, and a figure restored from disk would be printed with no
/// way to say how old it is.
///
/// ⚠️ **It belongs to the account that read it.** `AppNotifier` clears it when
/// that account leaves — a sign-out by hand or one from elsewhere — because
/// the next sign-in may be another account's, and its Settings row printed the
/// last one's figure until Usage was opened again. Here rather than beside the
/// page so the state can reach it without importing a screen.
final ValueNotifier<String?> lastUsageSummary = ValueNotifier<String?>(null);
