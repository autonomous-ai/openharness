import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../core/app_version.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../shared/widgets/skeleton.dart';
import '../state/app_state.dart';
import '../update/desktop_updater.dart';
import '../update/manual_update_check.dart';
import 'window_chrome.dart';

/// "18.4 MB" — a download the user is about to authorise, in the unit they
/// think in. Bytes are what the manifest carries; nobody reads 19293798.
String formatDownloadSize(int bytes) {
  if (bytes <= 0) return '';
  const mb = 1024 * 1024;
  if (bytes >= mb) return '${(bytes / mb).toStringAsFixed(1)} MB';
  return '${(bytes / 1024).round()} KB';
}

/// The band across the top of the app when a newer build is out.
///
/// It carries three states off one flag pair on [AppNotifier]: an offer, the
/// install running, and a failed install. The failure keeps the offer alive —
/// nothing was changed on disk, so the only honest thing to show is a way to
/// try again.
class UpdateNotice extends StatelessWidget {
  final AppNotifier notifier;

  const UpdateNotice({super.key, required this.notifier});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final update = notifier.availableUpdate;
    if (update == null) return const SizedBox.shrink();

    final installing = notifier.isInstallingUpdate;
    final error = notifier.updateError;
    final failed = error != null && !installing;

    // Amber for a failure, the accent wash otherwise. Deliberately NOT green:
    // green is "machine online" everywhere else in this window, and a second
    // meaning for it here would make the rail's dots ambiguous.
    // ⚠️ COMPOSITED OVER THE WINDOW, NOT LEFT TRANSLUCENT. Both tints below are
    // washes — 8% and 10% — and this band is the one strip of the app that does
    // NOT sit inside a Scaffold: it takes a row of its own directly under
    // MaterialApp's home, so there is no surface behind it to tint. Left as-is
    // the wash lands on the bare window, which is still the platform's dark
    // ground, and the banner stays black while the whole app around it goes
    // light. Blending against the window colour keeps the designed tint and
    // gives it something to be a tint OF.
    final wash = failed
        ? grid.AppPalette.warn.withValues(alpha: 0.10)
        : grid.AppSurface.accentWash;
    final tint = Color.alphaBlend(wash, grid.AppPalette.windowBg);
    final rule = failed
        ? grid.AppPalette.warn.withValues(alpha: 0.28)
        : grid.AppPalette.accentOnSurface.withValues(alpha: 0.24);
    final markColor = failed
        ? grid.AppPalette.warn
        : grid.AppPalette.accentOnSurface;

    final String message;
    if (failed) {
      message = error;
    } else if (installing) {
      message = 'Installing Harness ${update.version}…';
    } else {
      message = 'Harness ${update.version} is available';
    }

    return WindowDragArea(
      child: Material(
        color: Colors.transparent,
        child: DecoratedBox(
          decoration: BoxDecoration(
            color: tint,
            border: Border(bottom: BorderSide(color: rule)),
          ),
          child: Stack(
            children: [
              Padding(
                // Starts clear of the traffic lights: this band is the top edge
                // of the window when it shows, and the lights float over it.
                padding: EdgeInsets.fromLTRB(
                  14 + trafficLightClearance,
                  7,
                  10,
                  7,
                ),
                child: Row(
                  children: [
                    SizedBox(
                      width: 16,
                      height: 16,
                      child: installing
                          ? CircularProgressIndicator(
                              strokeWidth: 2,
                              color: grid.AppPalette.accentOnSurface,
                            )
                          : Icon(
                              failed
                                  ? LucideIcons.triangleAlert300
                                  : LucideIcons.arrowDownToLine300,
                              size: 16,
                              color: markColor,
                            ),
                    ),
                    const SizedBox(width: 10),
                    // ONE expanding child, holding the whole message. A
                    // Flexible text beside a Spacer splits the free space
                    // between them, which leaves the actions stranded
                    // mid-band instead of anchored to the right edge.
                    //
                    // Inside it the sentence yields before the size does: a
                    // truncated sentence still leaves both readable, whereas
                    // wrapping one would push the buttons out of the band.
                    Expanded(
                      child: Row(
                        children: [
                          Flexible(
                            child: Text(
                              message,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: grid.AppType.body(
                                color: grid.AppPalette.textPrimary,
                              ),
                            ),
                          ),
                          if (!installing && !failed && update.size > 0) ...[
                            const SizedBox(width: 8),
                            Text(
                              '· ${formatDownloadSize(update.size)}',
                              style: grid.AppType.monoMeta(
                                color: grid.AppPalette.textFaint,
                              ),
                            ),
                          ],
                        ],
                      ),
                    ),
                    const SizedBox(width: 12),
                    if (failed) ...[
                      _NoticeAction(
                        label: 'Dismiss',
                        onPressed: notifier.dismissUpdateError,
                      ),
                      const SizedBox(width: 6),
                      _NoticeAction(
                        key: const Key('retry-update-button'),
                        label: 'Try again',
                        kind: _ActionKind.ghost,
                        onPressed: () => unawaited(
                          notifier.installAvailableUpdate(update: update),
                        ),
                      ),
                    ] else ...[
                      _NoticeAction(
                        key: const Key('skip-update-button'),
                        label: 'Skip this version',
                        onPressed: installing
                            ? null
                            : () =>
                                  notifier.skipAvailableUpdate(update: update),
                      ),
                      const SizedBox(width: 6),
                      _NoticeAction(
                        key: const Key('install-update-button'),
                        label: 'Update',
                        kind: _ActionKind.primary,
                        onPressed: installing
                            ? null
                            : () => unawaited(
                                notifier.installAvailableUpdate(update: update),
                              ),
                      ),
                    ],
                  ],
                ),
              ),
              // Indeterminate on purpose: downloadAndStage() resolves once, with
              // no byte counter to read, so a percentage here would be invented.
              if (installing)
                Positioned(
                  left: 0,
                  right: 0,
                  bottom: 0,
                  child: LinearProgressIndicator(
                    minHeight: 2,
                    backgroundColor: Colors.transparent,
                    color: grid.AppPalette.accentOnSurface,
                  ),
                ),
            ],
          ),
        ),
      ),
    );
  }
}

enum _ActionKind { quiet, ghost, primary }

class _NoticeAction extends StatelessWidget {
  final String label;
  final VoidCallback? onPressed;
  final _ActionKind kind;

  const _NoticeAction({
    super.key,
    required this.label,
    required this.onPressed,
    this.kind = _ActionKind.quiet,
  });

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final primary = kind == _ActionKind.primary;
    return TextButton(
      onPressed: onPressed,
      style: TextButton.styleFrom(
        minimumSize: const Size(0, 26),
        padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        visualDensity: VisualDensity.standard,
        backgroundColor: primary
            ? grid.AppPalette.accentOnSurface
            : Colors.transparent,
        foregroundColor: primary
            ? grid.AppPalette.windowBg
            : grid.AppPalette.textSecondary,
        disabledForegroundColor: grid.AppPalette.textFaint,
        shape: RoundedRectangleBorder(
          borderRadius: BorderRadius.circular(7),
          side: kind == _ActionKind.ghost
              ? BorderSide(color: grid.AppGlass.hair)
              : BorderSide.none,
        ),
        textStyle: grid.AppType.label(
          fontWeight: primary ? grid.AppFont.semibold : grid.AppFont.regular,
        ),
      ),
      child: Text(label),
    );
  }
}

final _manualChecks = Expando<Future<void>>('manual desktop update checks');

/// The native menu and About share one check and one result dialog per window.
/// Invoking the other entry while a check is pending cannot stack two dialogs.
Future<void> checkForUpdatesAndShowResult(
  BuildContext context,
  AppNotifier notifier,
) {
  final navigator = Navigator.of(context, rootNavigator: true);
  final pending = _manualChecks[navigator];
  if (pending != null) return pending;
  // Schedule after assigning ownership, before notifying check-state listeners.
  final operation = Future<void>(() async {
    final result = await notifier.checkForUpdates();
    if (context.mounted) {
      await showUpdateCheckDialog(context, notifier, result);
    }
  }).whenComplete(() => _manualChecks[navigator] = null);
  _manualChecks[navigator] = operation;
  return operation;
}

/// Opens the result of a manual check. It never downloads
/// a release until the user chooses the primary action.
Future<void> showUpdateCheckDialog(
  BuildContext context,
  AppNotifier notifier,
  ManualUpdateCheck result,
) {
  return showAppDialog<void>(
    context: context,
    builder: (dialogContext) {
      var current = result;
      var checking = false;
      var installing = false;
      return StatefulBuilder(
        builder: (context, setState) {
          if (checking) {
            return const _UpdateDialog(
              icon: LucideIcons.refreshCw300,
              title: 'Checking for updates…',
              body: 'Looking for a newer version of Harness.',
              busy: true,
            );
          }
          if (current.status == DesktopUpdateCheckStatus.failed) {
            return _UpdateDialog(
              icon: LucideIcons.triangleAlert300,
              tone: _DialogTone.warning,
              title: 'Couldn’t check for updates',
              body:
                  'Harness couldn’t read the latest version. '
                  'Check your connection and try again.',
              actions: [
                _DialogAction(
                  label: 'Close',
                  onPressed: () async => Navigator.of(dialogContext).pop(),
                ),
                _DialogAction(
                  label: 'Retry',
                  primary: true,
                  onPressed: () async {
                    setState(() => checking = true);
                    final next = await notifier.checkForUpdates();
                    if (!context.mounted) return;
                    setState(() {
                      current = next;
                      checking = false;
                    });
                  },
                ),
              ],
            );
          }
          if (current.status == DesktopUpdateCheckStatus.disabled) {
            return const _UpdateDialog(
              icon: LucideIcons.info300,
              title: 'Updates are off for this build',
              body: 'This build does not check for or install desktop updates.',
            );
          }
          final update = current.update;
          if (update == null) {
            return const _UpdateDialog(
              icon: LucideIcons.circleCheck300,
              tone: _DialogTone.ok,
              title: 'You’re up to date',
              body: 'This copy of Harness already has the latest version.',
            );
          }
          return PopScope(
            canPop: !installing,
            child: _UpdateDialog(
              icon: LucideIcons.arrowDownToLine300,
              title: installing
                  ? 'Installing Harness ${update.version}…'
                  : 'Harness ${update.version} is available',
              body: installing
                  ? 'Don’t quit Harness. It will restart on its own.'
                  : current.isSkipped
                  ? 'You skipped this version earlier. You can still install it.'
                  : 'Download and install it now? Harness will restart when it '
                        'finishes.',
              busy: installing,
              update: installing ? null : update,
              actions: installing
                  ? const []
                  : [
                      _DialogAction(
                        key: const Key('close-update-dialog-button'),
                        label: 'Close',
                        onPressed: () async {
                          Navigator.of(dialogContext).pop();
                        },
                      ),
                      if (!current.isSkipped)
                        _DialogAction(
                          label: 'Skip ${update.version}',
                          onPressed: () async {
                            await notifier.skipAvailableUpdate(update: update);
                            if (dialogContext.mounted) {
                              Navigator.of(dialogContext).pop();
                            }
                          },
                        ),
                      _DialogAction(
                        label: 'Update',
                        primary: true,
                        onPressed: () async {
                          setState(() => installing = true);
                          final installed = await notifier
                              .installAvailableUpdate(update: update);
                          // A successful install never returns — the process is
                          // replaced. Reaching here means it failed, and the banner
                          // behind this dialog is already showing why.
                          if (!context.mounted || installed) return;
                          setState(() => installing = false);
                          Navigator.of(dialogContext).pop();
                        },
                      ),
                    ],
            ),
          );
        },
      );
    },
  );
}

enum _DialogTone { accent, ok, warning }

class _DialogAction {
  final Key? key;
  final String label;
  final bool primary;
  final Future<void> Function() onPressed;

  const _DialogAction({
    this.key,
    required this.label,
    required this.onPressed,
    this.primary = false,
  });
}

class _UpdateDialog extends StatelessWidget {
  final IconData icon;
  final String title;
  final String body;
  final _DialogTone tone;
  final bool busy;
  final UpdateInfo? update;
  final List<_DialogAction> actions;

  const _UpdateDialog({
    required this.icon,
    required this.title,
    required this.body,
    this.tone = _DialogTone.accent,
    this.busy = false,
    this.update,
    this.actions = const [],
  });

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final mark = switch (tone) {
      _DialogTone.ok => grid.AppPalette.online,
      _DialogTone.warning => grid.AppPalette.warn,
      _DialogTone.accent => grid.AppPalette.accentOnSurface,
    };

    return Dialog(
      // No backgroundColor, no shape: `dialogTheme` supplies both, at
      // AppGlass.surfaceFill and AppCard.radius (12). The rim this used to
      // carry is gone with them — §1 allows exactly one border in the app and
      // it belongs to the menu panel, not to a dialog.
      child: ConstrainedBox(
        constraints: BoxConstraints(
          maxWidth: 372 * grid.appTextScaleOf(context),
        ),
        child: SingleChildScrollView(
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
                    borderRadius: BorderRadius.circular(
                      grid.AppCard.insetRadius,
                    ),
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
                      : Icon(icon, size: 18, color: mark),
                ),
                const SizedBox(height: 12),
                Text(
                  title,
                  style: grid.AppType.heading(
                    color: grid.AppPalette.textPrimary,
                  ),
                ),
                const SizedBox(height: 5),
                Text(
                  body,
                  style: grid.AppType.body(
                    color: grid.AppPalette.textSecondary,
                    height: 1.5,
                  ),
                ),
                if (update != null) ...[
                  const SizedBox(height: 12),
                  Divider(height: 1, color: grid.AppGlass.hair),
                  const SizedBox(height: 10),
                  _Fact(label: 'Installed', value: _InstalledVersion()),
                  const SizedBox(height: 6),
                  _Fact(label: 'New version', value: Text(update!.version)),
                  if (update!.size > 0) ...[
                    const SizedBox(height: 6),
                    _Fact(
                      label: 'Download',
                      value: Text(formatDownloadSize(update!.size)),
                    ),
                  ],
                ],
                if (actions.isNotEmpty) ...[
                  const SizedBox(height: 15),
                  Align(
                    alignment: Alignment.centerRight,
                    child: Wrap(
                      alignment: WrapAlignment.end,
                      spacing: 8,
                      runSpacing: 8,
                      children: [
                        for (final action in actions) ...[
                          _NoticeAction(
                            key: action.key,
                            label: action.label,
                            kind: action.primary
                                ? _ActionKind.primary
                                : _ActionKind.quiet,
                            onPressed: () => unawaited(action.onPressed()),
                          ),
                        ],
                      ],
                    ),
                  ),
                ],
                if (actions.isEmpty && !busy) ...[
                  const SizedBox(height: 15),
                  Row(
                    mainAxisAlignment: MainAxisAlignment.end,
                    children: [
                      _NoticeAction(
                        label: 'Close',
                        kind: _ActionKind.ghost,
                        onPressed: () => Navigator.of(context).pop(),
                      ),
                    ],
                  ),
                ],
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// One `label · value` line in the dialog's fact block.
class _Fact extends StatelessWidget {
  final String label;
  final Widget value;

  const _Fact({required this.label, required this.value});

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Row(
      crossAxisAlignment: CrossAxisAlignment.start,
      children: [
        SizedBox(
          width: 96 * grid.appTextScaleOf(context),
          child: Text(
            label,
            style: grid.AppType.body(color: grid.AppPalette.textFaint),
          ),
        ),
        Expanded(
          // Versions and sizes: copied into a report, so set in mono.
          child: DefaultTextStyle(
            style: grid.AppType.monoLabel(
              fontWeight: FontWeight.w400,
              color: grid.AppPalette.textSecondary,
            ),
            child: value,
          ),
        ),
      ],
    );
  }
}

class _InstalledVersion extends StatefulWidget {
  @override
  State<_InstalledVersion> createState() => _InstalledVersionState();
}

class _InstalledVersionState extends State<_InstalledVersion> {
  // Built once, not in `build`: `runningAppVersion` reads a file on Linux, and
  // a future rebuilt per frame would put the placeholder back each time.
  late final Future<String> _info = runningAppVersion();

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return FutureBuilder<String>(
      future: _info,
      builder: (context, snapshot) {
        final version = snapshot.data;
        if (version == null) {
          // Still reading: a blank measured against the ambient mono style the
          // row sets, so it and the version it becomes are the same line.
          // Answered with nothing: the dash, which is a value.
          return snapshot.connectionState == ConnectionState.done
              ? const Text('—')
              : SkeletonText(
                  style: DefaultTextStyle.of(context).style,
                  width: 44,
                );
        }
        return Text(version);
      },
    );
  }
}
