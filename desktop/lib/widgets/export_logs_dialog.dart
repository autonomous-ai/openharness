import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../core/harness_cli_runner.dart';
import '../core/reveal_folder.dart';
import '../logging/log_export.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/toolbar_pill.dart';

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

    return Dialog(
      child: ConstrainedBox(
        constraints: const BoxConstraints(maxWidth: 372),
        child: Padding(
          padding: const EdgeInsets.fromLTRB(18, 18, 18, 14),
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
                        failed
                            ? LucideIcons.circleAlert300
                            : LucideIcons.packageCheck300,
                        size: 18,
                        color: mark,
                      ),
              ),
              const SizedBox(height: 12),
              Text(
                title,
                style: grid.AppType.heading(color: grid.AppPalette.textPrimary),
              ),
              const SizedBox(height: 5),
              SelectableText(
                body,
                style: grid.AppType.body(
                  color: grid.AppPalette.textSecondary,
                  height: 1.5,
                ),
              ),
              if (!busy) ...[
                const SizedBox(height: 15),
                Row(
                  mainAxisAlignment: MainAxisAlignment.end,
                  children: [
                    if (result.path != null) ...[
                      ToolbarPill(
                        onTap: () => unawaited(revealFile(result.path!)),
                        rimmed: true,
                        child: _Label('Show in Finder'),
                      ),
                      const SizedBox(width: 8),
                    ],
                    ToolbarPill(
                      onTap: () => Navigator.of(context).pop(),
                      tinted: true,
                      child: _Label('Close', tinted: true),
                    ),
                  ],
                ),
              ],
            ],
          ),
        ),
      ),
    );
  }
}

class _Label extends StatelessWidget {
  const _Label(this.text, {this.tinted = false});

  final String text;
  final bool tinted;

  @override
  Widget build(BuildContext context) {
    return Text(
      text,
      style: grid.AppType.label(
        color: ToolbarPill.tint(tinted: tinted, enabled: true),
      ),
    );
  }
}
