import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';

/// One page of Manage Intern 3 (intern_manage_dialog.dart): what it manages, and Back to the list.
abstract class InternPage extends StatefulWidget {
  const InternPage({
    super.key,
    required this.app,
    required this.machineId,
    required this.onBack,
  });

  final AppNotifier app;
  final String machineId;
  final VoidCallback onBack;

  /// The computer as the account names it.
  String get name =>
      app.machineStates[machineId]?.machine.displayName ?? 'The computer';
}

/// A row to open, or one fact: its name, what it is now, and a chevron where a click opens it.
class InternRow extends StatelessWidget {
  const InternRow({
    super.key,
    required this.title,
    this.value,
    this.valueColor,
    this.onTap,
    this.danger = false,
    this.chevron = true,
  });

  final String title;
  final String? value;
  final Color? valueColor;
  final VoidCallback? onTap;

  /// It cannot be taken back: the danger color, no chevron.
  final bool danger;
  final bool chevron;

  @override
  Widget build(BuildContext context) {
    final color = danger ? Theme.of(context).colorScheme.error : null;
    final value = this.value;
    return InkWell(
      borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
      onTap: onTap,
      child: Padding(
        padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 9),
        child: Row(
          children: [
            Expanded(
              child: Text(
                title,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.text(size: 13, color: color),
              ),
            ),
            if (value != null)
              Padding(
                padding: const EdgeInsets.only(left: 8),
                child: Text(
                  value,
                  style: DesktopChrome.metadata(color: valueColor),
                ),
              ),
            SizedBox(
              width: 24,
              child: chevron && !danger && onTap != null
                  ? Icon(
                      AppIcons.chevronRight,
                      size: 14,
                      color: DesktopChrome.muted,
                    )
                  : null,
            ),
          ],
        ),
      ),
    );
  }
}
