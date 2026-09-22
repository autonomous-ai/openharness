import 'dart:async';

import 'package:flutter/material.dart';
import 'package:harness/terminal/terminal_text.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/prompt_style.dart';
import 'box_chrome.dart';
import 'prompt_context.dart';

class PromptCustomize extends StatelessWidget {
  const PromptCustomize({super.key, required this.store});
  final AppearancePrefsStore store;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ValueListenableBuilder<AppearancePrefs>(
      valueListenable: store,
      builder: (context, appearance, _) {
        final prefs = appearance.prompt;
        void choose(PromptPrefs next) => unawaited(store.setPrompt(next));
        Widget toggle(
          String name,
          String label,
          bool value,
          ValueChanged<bool> onChanged,
        ) => TextButton(
          key: ValueKey('prompt-$name'),
          style: TextButton.styleFrom(
            alignment: Alignment.centerLeft,
            foregroundColor: grid.AppPalette.textPrimary,
            shape: const RoundedRectangleBorder(
              borderRadius: BorderRadius.all(
                Radius.circular(kTerminalCornerRadius),
              ),
            ),
          ),
          onPressed: () => onChanged(!value),
          child: Semantics(
            checked: value,
            label: label,
            child: ExcludeSemantics(
              child: Text(
                '${value ? '[x]' : '[ ]'} $label',
                style: grid.AppType.monoLabel(
                  color: grid.AppPalette.textPrimary,
                  fontWeight: FontWeight.w400,
                ),
              ),
            ),
          ),
        );
        return SingleChildScrollView(
          padding: const EdgeInsets.all(16),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text(
                'header style',
                style: grid.AppType.monoMeta(
                  color: grid.AppPalette.textSecondary,
                ),
              ),
              const SizedBox(height: 8),
              for (final style in PromptStyle.values)
                TextButton(
                  key: ValueKey('prompt-style-${style.name}'),
                  onPressed: () => choose(prefs.copyWith(style: style)),
                  style: TextButton.styleFrom(
                    alignment: Alignment.centerLeft,
                    backgroundColor: prefs.style == style
                        ? grid.AppSurface.selectedFill
                        : null,
                    padding: const EdgeInsets.symmetric(
                      horizontal: 10,
                      vertical: 10,
                    ),
                    shape: const RoundedRectangleBorder(
                      borderRadius: BorderRadius.all(
                        Radius.circular(kTerminalCornerRadius),
                      ),
                    ),
                  ),
                  child: Semantics(
                    selected: prefs.style == style,
                    child: Column(
                      crossAxisAlignment: CrossAxisAlignment.start,
                      children: [
                        Text(
                          '${prefs.style == style ? '>' : ' '} ${style.label}',
                          style: grid.AppType.monoLabel(
                            color: grid.AppPalette.textPrimary,
                            fontWeight: FontWeight.w400,
                          ),
                        ),
                        Padding(
                          padding: const EdgeInsets.only(left: 16, top: 3),
                          child: Text(
                            style.description,
                            style: grid.AppType.body(
                              color: grid.AppPalette.textSecondary,
                            ),
                          ),
                        ),
                      ],
                    ),
                  ),
                ),
              const SizedBox(height: 16),
              Text(
                'preview',
                style: grid.AppType.monoMeta(
                  color: grid.AppPalette.textSecondary,
                ),
              ),
              const SizedBox(height: 6),
              TerminalBox(
                child: Padding(
                  padding: const EdgeInsets.all(12),
                  child: PromptContextView(
                    key: const ValueKey('prompt-preview'),
                    store: store,
                    contextData: const PromptContext(
                      harness: 'Codex',
                      machine: 'devbox',
                      project: 'openharness',
                      branch: 'main',
                    ),
                  ),
                ),
              ),
              const SizedBox(height: 16),
              Text(
                'context',
                style: grid.AppType.monoMeta(
                  color: grid.AppPalette.textSecondary,
                ),
              ),
              toggle(
                'machine',
                'Machine',
                prefs.machine,
                (value) => choose(prefs.copyWith(machine: value)),
              ),
              toggle(
                'project',
                'Project',
                prefs.project,
                (value) => choose(prefs.copyWith(project: value)),
              ),
              toggle(
                'branch',
                'Branch',
                prefs.branch,
                (value) => choose(prefs.copyWith(branch: value)),
              ),
              toggle(
                'color',
                'Color',
                prefs.color,
                (value) => choose(prefs.copyWith(color: value)),
              ),
              const SizedBox(height: 8),
              Text(
                'Applies to agent search and pane headers. Changes are saved as you choose.',
                style: grid.AppType.body(color: grid.AppPalette.textSecondary),
              ),
              const SizedBox(height: 12),
              TextButton(
                key: const ValueKey('prompt-reset'),
                onPressed: () => choose(const PromptPrefs()),
                child: Text(
                  'Reset header style',
                  style: grid.AppType.label(
                    color: grid.AppPalette.textSecondary,
                  ),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
