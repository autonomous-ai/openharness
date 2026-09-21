import 'package:flutter/material.dart';

import 'package:harness_mobile/state/app_state.dart';

import 'phone_navigation.dart';
import 'settings_row.dart';
import 'usage_page.dart';

/// The Settings ▸ Usage row, built here rather than in `settings_page.dart` so
/// the page that owns the feature owns its entry point too.
///
/// What comes back is a [SettingsRow] — the same shape as every other row in a
/// [SettingsGroup] — with a [ValueListenableBuilder] around it, so the figure
/// refreshes when someone comes back from the page without Settings having to
/// know that it can. Settings decides WHERE the row goes; this decides what it
/// says.
///
/// The value is the tightest weekly figure across every account, which is the
/// one worth a glance from a list of rows: the account closest to running out is
/// the one that will stop the work. A dash when nothing has been read yet,
/// never a zero — `0% used` is a measurement, and this has none.
Widget buildUsageSettingsRow(BuildContext context, AppNotifier notifier) =>
    ValueListenableBuilder<String?>(
      valueListenable: lastUsageSummary,
      builder: (context, summary, _) => SettingsRow(
        title: 'Usage',
        value: summary ?? '—',
        onTap: () => Navigator.of(
          context,
        ).push(phoneRoute((_) => UsagePage(notifier: notifier))),
      ),
    );
