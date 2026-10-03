import 'package:flutter/material.dart';

import 'desktop_chrome.dart';

/// Setup occupies the same canvas slot as the eventual agent terminal. A DSH
/// must not lose its conversation pane when its machine or agent is unavailable.
class HarnessConversationPlaceholder extends StatelessWidget {
  const HarnessConversationPlaceholder({
    super.key,
    required this.name,
    required this.opening,
    required this.onRetry,
    this.error,
  });

  final String name;
  final bool opening;
  final String? error;
  final VoidCallback onRetry;

  @override
  Widget build(BuildContext context) => Column(
    crossAxisAlignment: CrossAxisAlignment.stretch,
    children: [
      Padding(
        padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
        child: Text('$name chat', style: DesktopChrome.control(medium: true)),
      ),
      const Divider(height: 1),
      Expanded(
        child: Center(
          child: SingleChildScrollView(
            padding: const EdgeInsets.all(24),
            child: Column(
              mainAxisSize: MainAxisSize.min,
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                Text(
                  opening ? 'Opening your chat…' : 'Chat isn’t ready yet',
                  style: DesktopChrome.heading(),
                ),
                const SizedBox(height: 12),
                Semantics(
                  liveRegion: true,
                  child: Text(
                    opening
                        ? 'Your conversation will appear here. You can keep using the dashboard.'
                        : error ??
                              'Start a conversation to work with your agent.',
                    style: DesktopChrome.text(color: DesktopChrome.muted),
                  ),
                ),
                const SizedBox(height: 20),
                if (opening)
                  const SizedBox(
                    width: 20,
                    height: 20,
                    child: CircularProgressIndicator(strokeWidth: 2),
                  )
                else
                  FilledButton(
                    onPressed: onRetry,
                    child: const Text('Try again'),
                  ),
              ],
            ),
          ),
        ),
      ),
    ],
  );
}
