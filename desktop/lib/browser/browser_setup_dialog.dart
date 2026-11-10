import 'package:flutter/material.dart';

import '../widgets/desktop_chrome.dart';
import '../widgets/desktop_prompt_surface.dart';
import '../widgets/terminal_prompt.dart';

/// Set up Browser: asked once, on Start, only at the computer being set up. True on Install.
Future<bool> showBrowserSetupDialog(
  BuildContext context, {
  required bool restart,
  required bool ownMachine,
}) async =>
    await showTerminalPrompt<bool>(
      context,
      builder: (context) =>
          BrowserSetupPrompt(restart: restart, ownMachine: ownMachine),
    ) ==
    true;

/// What [showBrowserSetupDialog] shows. [restart]: Windows without WSL 2 restarts once. [ownMachine]: the person's
/// Podman machine will not start, so Harness makes its own beside it.
class BrowserSetupPrompt extends StatelessWidget {
  const BrowserSetupPrompt({
    super.key,
    required this.restart,
    required this.ownMachine,
  });

  final bool restart, ownMachine;

  @override
  Widget build(BuildContext context) {
    void answer(bool install) => Navigator.pop(context, install);
    final body = DesktopChrome.text(size: 13);
    return TerminalPromptKeys(
      cancel: () => answer(false),
      accept: () => answer(true),
      child: DesktopPromptSurface(
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          spacing: DesktopChrome.controlGap,
          children: [
            Padding(
              padding: const EdgeInsets.only(bottom: DesktopChrome.controlGap),
              child: Text('Set up Browser', style: DesktopChrome.heading()),
            ),
            Text(
              'Installs Podman on this computer to run the agent\'s Chrome. '
              'Asks for your password once. About 15 minutes, 3 GB.',
              style: body,
            ),
            if (ownMachine)
              Text(
                'Podman on this computer won\'t start. Harness will set up '
                'its own.',
                style: body,
              ),
            if (restart) Text('Windows restarts once.', style: body),
          ],
        ),
        actions: [
          TextButton(
            onPressed: () => answer(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            autofocus: true,
            onPressed: () => answer(true),
            child: const Text('Install'),
          ),
        ],
      ),
    );
  }
}
