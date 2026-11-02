import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../shared/theme/app_type.dart';
import '../shell/web_hidden_under_keyboard.dart';
import 'web_update_watcher.dart';

/// Everything below a quiet bar that says a newer release is out (task #2185,
/// Huy's mockup): "A new version of Harness is ready." and Reload. The bar
/// comes with [WebUpdateWatcher.updateReady] and stays until the page is
/// reloaded; nothing else asks for a decision.
///
/// One shape whether or not the bar shows: the app below must never be
/// remounted by a bar coming. The bar takes the top inset when it is the top
/// of the page (a phone's browser, no store bar over it), and the app below
/// starts under it.
class WebUpdateFrame extends StatelessWidget {
  const WebUpdateFrame({
    super.key,
    required this.watcher,
    required this.reload,
    required this.child,
  });

  final WebUpdateWatcher watcher;

  /// Loads the new build; tests pass a recorder.
  final VoidCallback reload;
  final Widget child;

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: watcher,
    builder: (context, _) {
      final shown = watcher.updateReady;
      final media = MediaQuery.of(context);
      return Column(
        children: [
          if (shown)
            WebHiddenUnderKeyboard(child: _WebUpdateBar(onReload: reload)),
          Expanded(
            key: const ValueKey('web-update-frame-app'),
            child: MediaQuery(
              data: shown ? media.removePadding(removeTop: true) : media,
              child: child,
            ),
          ),
        ],
      );
    },
  );
}

class _WebUpdateBar extends StatelessWidget {
  const _WebUpdateBar({required this.onReload});

  final VoidCallback onReload;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return Material(
      key: const ValueKey('web-update-bar'),
      color: grid.AppPalette.swarmTabBar,
      child: SafeArea(
        bottom: false,
        child: DecoratedBox(
          decoration: BoxDecoration(
            border: Border(bottom: BorderSide(color: grid.AppPalette.divider)),
          ),
          child: Padding(
            padding: const EdgeInsets.fromLTRB(16, 4, 8, 4),
            child: Row(
              children: [
                Expanded(
                  // Wraps on a narrow phone rather than losing its end.
                  child: Text(
                    'A new version of Harness is ready.',
                    maxLines: 2,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.label(color: grid.AppPalette.textPrimary),
                  ),
                ),
                const SizedBox(width: 8),
                TextButton(
                  key: const ValueKey('web-update-reload'),
                  onPressed: onReload,
                  style: TextButton.styleFrom(
                    minimumSize: const Size(64, 44),
                    padding: const EdgeInsets.symmetric(horizontal: 12),
                    tapTargetSize: MaterialTapTargetSize.padded,
                  ),
                  child: const Text('Reload'),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
