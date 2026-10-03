import 'dart:async';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../core/harness_cli_runner.dart';
import '../core/reveal_folder.dart';
import '../logging/log_export.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import 'desktop_chrome.dart';
import 'desktop_prompt_surface.dart';

/// Help ▸ Export Logs… — the one thing a bug report needs, from a menu every
/// build has.
///
/// Settings ▸ Debug carries the same action, but that pane is developer
/// furniture and a shipped app does not show it; the person whose dial got
/// stuck is running a shipped app. So the export also lives here, in the menu
/// bar, and the dialog says where the file went and shows it in Finder.
///
/// The work itself is the CLI's (`harness logs export`, see
/// `logging/log_export.dart`); this only reports.
Future<void> showExportLogsDialog(
  BuildContext context, {
  Future<LogExportResult> Function()? export,
}) {
  return showAppDialog<void>(
    context: context,
    barrierDismissible: false,
    builder: (dialogContext) => _ExportLogsDialog(
      export: export ?? () => exportLogs(HarnessCliRunner()),
    ),
  );
}

class _ExportLogsDialog extends StatefulWidget {
  const _ExportLogsDialog({required this.export});

  final Future<LogExportResult> Function() export;

  @override
  State<_ExportLogsDialog> createState() => _ExportLogsDialogState();
}

class _ExportLogsDialogState extends State<_ExportLogsDialog> {
  LogExportResult? _result;

  @override
  void initState() {
    super.initState();
    unawaited(_run());
  }

  Future<void> _run() async {
    final result = await widget.export();
    if (!mounted) return;
    setState(() => _result = result);
    final path = result.path;
    if (path != null) await revealFile(path);
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final result = _result;
    final busy = result == null;
    final failed = result?.path == null && !busy;
    final mark = failed
        ? grid.AppPalette.dangerFill
        : busy
        ? grid.AppPalette.accentOnSurface
        : grid.AppPalette.online;
    final title = busy
        ? 'Exporting logs…'
        : failed
        ? 'Could not export logs'
        : 'Logs exported';
    final body = busy
        ? 'Zipping the last seven days of Harness, CLI and dial logs. '
              'Secrets are stripped first.'
        : failed
        ? result.error ?? 'The CLI did not answer.'
        : 'Saved to ${result.path}\n'
              'Send this file with your report. It holds no credentials.';

    return DesktopPromptSurface(
      body: DesktopPromptScrollBody(
        child: Column(
          mainAxisSize: MainAxisSize.min,
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [
            Container(
              width: 34,
              height: 34,
              decoration: BoxDecoration(
                color: mark.withValues(alpha: 0.13),
                borderRadius: BorderRadius.circular(grid.AppCard.insetRadius),
              ),
              alignment: Alignment.center,
              child: busy
                  ? SizedBox(
                      width: 17,
                      height: 17,
                      child: CircularProgressIndicator(
                        strokeWidth: 2,
                        color: mark,
                      ),
                    )
                  : Icon(
                      failed ? AppIcons.circleAlert : AppIcons.packageCheck,
                      size: 18,
                      color: mark,
                    ),
            ),
            const SizedBox(height: 12),
            Text(title, style: DesktopChrome.heading()),
            const SizedBox(height: 8),
            SelectableText(
              body,
              style: DesktopChrome.text(color: DesktopChrome.muted),
            ),
          ],
        ),
      ),
      actions: [
        if (!busy && result.path != null)
          TextButton(
            onPressed: () => unawaited(revealFile(result.path!)),
            child: const Text('Show in Finder'),
          ),
        if (!busy)
          FilledButton(
            autofocus: true,
            onPressed: () => Navigator.of(context).pop(),
            child: const Text('Close'),
          ),
      ],
    );
  }
}
