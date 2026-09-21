import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import 'agent_action_icons.dart';

/// Separate Open Agent and New Agent actions on the Harness start page.
class HarnessEntryActions extends StatelessWidget {
  const HarnessEntryActions({
    super.key,
    required this.onOpen,
    required this.onNew,
    required this.openKey,
    required this.newKey,
    this.filledOpen = false,
  });
  final VoidCallback? onOpen, onNew;
  final Key openKey, newKey;
  final bool filledOpen;

  Widget _keyboardAction(
    BuildContext context,
    VoidCallback? onPressed,
    Widget child,
  ) {
    final region = KeymapRegion.of(context);
    if (region?.contextKind == KeymapContext.picker) {
      child = KeymapRegion(
        contextKind: KeymapContext.picker,
        actions: {
          ...?region?.actions,
          'picker.accept': () => onPressed?.call(),
          'picker.add_here': () => onPressed?.call(),
        },
        child: child,
      );
    }
    return CallbackShortcuts(
      bindings: {
        const SingleActivator(LogicalKeyboardKey.enter): () =>
            onPressed?.call(),
        const SingleActivator(LogicalKeyboardKey.numpadEnter): () =>
            onPressed?.call(),
      },
      child: child,
    );
  }

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    const size = Size(140, 48);
    const padding = EdgeInsets.symmetric(horizontal: 20);
    return Wrap(
      spacing: 12,
      runSpacing: 12,
      children: [
        _keyboardAction(
          context,
          onOpen,
          OutlinedButton.icon(
            key: openKey,
            onPressed: onOpen,
            style: OutlinedButton.styleFrom(
              enabledMouseCursor: SystemMouseCursors.click,
              minimumSize: size,
              padding: padding,
              backgroundColor: filledOpen
                  ? grid.AppPalette.swarmSearchSurface
                  : Colors.transparent,
              foregroundColor: Colors.white,
              side: filledOpen
                  ? BorderSide.none
                  : const BorderSide(color: Colors.white24),
              shape: const StadiumBorder(),
            ),
            icon: const Icon(AgentActionIcons.open, size: 18),
            label: const Text('Open Harness'),
          ),
        ),
        _keyboardAction(
          context,
          onNew,
          FilledButton.icon(
            key: newKey,
            onPressed: onNew,
            icon: const Icon(AgentActionIcons.create, size: 18),
            label: const Text('New Harness'),
            style: FilledButton.styleFrom(
              enabledMouseCursor: SystemMouseCursors.click,
              minimumSize: size,
              padding: padding,
              backgroundColor: grid.AppPalette.swarmAccent,
              foregroundColor: grid.AppPalette.swarmTabBar,
              shape: const StadiumBorder(),
            ),
          ),
        ),
      ],
    );
  }
}
