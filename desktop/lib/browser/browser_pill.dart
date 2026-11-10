import 'package:flutter/material.dart';

import '../shared/theme/app_icons.dart';
import '../widgets/desktop_chrome.dart';

/// Swarm New agent's Browser: an on/off pill beside Worktree, off by default, with one line under it when this
/// computer still has to set Browser up.
class BrowserPill extends StatelessWidget {
  const BrowserPill({
    super.key,
    required this.on,
    required this.onPressed,
    this.unavailable,
    this.needsSetup = false,
  });

  final bool on;
  final VoidCallback? onPressed;

  /// Why it cannot be ticked on the chosen machine, its tooltip; null when it can.
  final String? unavailable;

  /// This computer has no Podman yet: Start sets it up.
  final bool needsSetup;

  @override
  Widget build(BuildContext context) => Column(
    mainAxisSize: MainAxisSize.min,
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SizedBox(
        width: 100 * MediaQuery.textScalerOf(context).scale(1),
        child: Semantics(
          checked: on,
          child: DesktopPill(
            key: const ValueKey('new-harness-field-browser'),
            label: 'Browser',
            icon: on ? AppIcons.squareCheck : AppIcons.square,
            semanticLabel: 'Browser, ${on ? 'on' : 'off'}',
            quiet: true,
            compact: true,
            textSize: 12,
            foregroundColor: DesktopChrome.muted,
            tooltip: unavailable ?? 'A sandboxed Chrome the agent drives',
            onPressed: unavailable == null ? onPressed : null,
          ),
        ),
      ),
      if (needsSetup)
        Padding(
          padding: const EdgeInsets.only(left: 6),
          child: Text(
            'Needs setup · about 15 min',
            style: DesktopChrome.metadata(color: DesktopChrome.hint),
          ),
        ),
    ],
  );
}
