import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_icon_size.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';

import 'swarm_inbox.dart';
import 'swarm_start.dart';
import 'swarm_style.dart';

/// Home's card while no computer answers a Swarm read ([SwarmInbox.noComputer]):
/// the computers connecting, or offline, and Try again. Over what Home has —
/// the Home kept, or rows on their way — never a screen in its place: one
/// once took Home's place after a force-quit, with the Mac connecting all
/// along (owner's iPhone, 2026-10-28).
class SwarmConnectionNotice extends StatefulWidget {
  const SwarmConnectionNotice({
    super.key,
    required this.inbox,
    required this.computers,
  });

  final SwarmInbox inbox;

  /// The account's computers; null outside the shell, read as offline.
  final SwarmComputers? computers;

  @override
  State<SwarmConnectionNotice> createState() => _SwarmConnectionNoticeState();
}

class _SwarmConnectionNoticeState extends State<SwarmConnectionNotice> {
  /// Try again is looking: for the computers, then the Swarms through them.
  bool _looking = false;

  Future<void> _tryAgain() async {
    if (_looking) return;
    setState(() => _looking = true);
    try {
      await widget.computers?.recheck();
      await widget.inbox.refresh();
    } catch (_) {
      // Nothing found: the card stays, ready to try again.
    } finally {
      if (mounted) setState(() => _looking = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: Listenable.merge([widget.inbox, ?widget.computers]),
    builder: (context, _) {
      AppTheme.watch(context);
      final computers = widget.computers;
      // One not away for real is on its way back: its socket redialling.
      final connecting =
          computers?.computers?.any((computer) => !computer.away) ?? false;
      return SwarmGroup(
        key: const ValueKey('swarm-connection'),
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(
              AppSpace.m,
              AppSpace.m,
              AppSpace.xs,
              AppSpace.m,
            ),
            child: Row(
              children: [
                Icon(
                  connecting
                      ? LucideIcons.monitor300
                      : LucideIcons.monitorOff300,
                  size: AppIconSize.besideText,
                  color: AppPalette.textSecondary,
                ),
                const SizedBox(width: AppSpace.m),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        connecting
                            ? 'Connecting to your computers…'
                            : 'Your computers are offline.',
                        style: AppType.label(color: AppPalette.textPrimary),
                      ),
                      Text(
                        widget.inbox.swarms.isEmpty
                            ? 'Turn one on and open Harness.'
                            : 'Showing your last update.',
                        style: AppType.caption(color: AppPalette.textSecondary),
                      ),
                    ],
                  ),
                ),
                SwarmButton(
                  label: 'Try again',
                  style: SwarmButtonStyle.link,
                  busy: _looking || (computers?.rechecking ?? false),
                  busyLabel: 'Looking…',
                  onPressed: () => unawaited(_tryAgain()),
                ),
              ],
            ),
          ),
        ],
      );
    },
  );
}
