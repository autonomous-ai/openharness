import 'package:flutter/material.dart';

import '../../shared/theme/app_theme.dart' as grid;
import '../../widgets/desktop_chrome.dart';
import '../../widgets/desktop_prompt_surface.dart';
import '../../widgets/terminal_prompt.dart';

/// What to do with a tab's unsaved edits as it closes — Orca's choices.
enum FinderUnsavedChoice { save, discard }

/// How a choice's button reads: quiet, the way forward, or destructive.
enum _Tone { plain, primary, danger }

/// "Do you want to save the changes you made to [name]?" Null is Cancel.
Future<FinderUnsavedChoice?> askToSaveChanges(
  BuildContext context,
  String name,
) => _ask(
  context,
  title: 'Unsaved changes',
  message:
      'Do you want to save the changes you made to $name? '
      'Your changes will be lost if you don’t save them.',
  choices: const [
    ('Don’t Save', FinderUnsavedChoice.discard, _Tone.plain),
    ('Save', FinderUnsavedChoice.save, _Tone.primary),
  ],
);

/// Whether to throw away [what]: "Discard changes?" for tracked files, and
/// for untracked ones a move to the Trash.
Future<bool> confirmDiscard(
  BuildContext context, {
  required String what,
  required bool untracked,
}) async =>
    await _ask(
      context,
      title: untracked ? 'Move to Trash?' : 'Discard changes?',
      message: untracked
          ? '$what isn’t in Git yet. It goes to the Trash, where you can '
                'restore it.'
          : 'The changes to $what will be lost. This cannot be undone.',
      choices: [(untracked ? 'Move to Trash' : 'Discard', true, _Tone.danger)],
    ) ==
    true;

/// Whether to move [name] to the Trash from the tree.
Future<bool> confirmTrash(BuildContext context, String name) async =>
    await _ask(
      context,
      title: 'Move to Trash?',
      message: '“$name” goes to the Trash, where you can restore it.',
      choices: const [('Move to Trash', true, _Tone.danger)],
    ) ==
    true;

/// A prompt with Cancel and [choices]; each is (label, value, tone).
/// The last choice is the default (↵).
Future<T?> _ask<T>(
  BuildContext context, {
  required String title,
  required String message,
  required List<(String, T, _Tone)> choices,
}) => showTerminalPrompt<T>(
  context,
  builder: (context) {
    void cancel() => Navigator.pop(context);
    return TerminalPromptKeys(
      cancel: cancel,
      accept: () => Navigator.pop(context, choices.last.$2),
      child: DesktopPromptSurface(
        body: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            Text(title, style: DesktopChrome.heading()),
            const SizedBox(height: DesktopChrome.groupGap),
            Text(message, style: DesktopChrome.text(size: 13)),
          ],
        ),
        actions: [
          TextButton(onPressed: cancel, child: const Text('Cancel')),
          for (final (label, value, tone) in choices)
            tone == _Tone.plain
                ? TextButton(
                    key: ValueKey('finder-dialog-$label'),
                    onPressed: () => Navigator.pop(context, value),
                    child: Text(label),
                  )
                : FilledButton(
                    key: ValueKey('finder-dialog-$label'),
                    autofocus: tone == _Tone.primary,
                    onPressed: () => Navigator.pop(context, value),
                    style: tone == _Tone.danger
                        ? grid.dangerButtonStyle()
                        : null,
                    child: Text(label),
                  ),
        ],
      ),
    );
  },
);
