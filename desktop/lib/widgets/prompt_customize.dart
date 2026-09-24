import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/prompt_style.dart';
import '../shared/theme/status_line_style.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'status_line.dart';

class PromptCustomize extends StatelessWidget {
  const PromptCustomize({super.key, required this.store});
  final AppearancePrefsStore store;

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([store, terminalThemeStore]),
      builder: (context, _) {
        final prefs = store.value.prompt;
        final cell = terminalCellSizeOf(context);
        final theme = terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        );
        final style = terminalContentStyle(color: theme.foreground);
        void choose(PromptPrefs next) => unawaited(store.setPrompt(next));
        StatusLineParts example(StatusLineStyle format) => statusLineParts(
          provider: '',
          machine: prefs.machine ? 'M2' : '',
          project: prefs.project ? 'app' : '',
          branch: prefs.branch ? 'main' : null,
          style: format,
        );
        final previewContext = example(prefs.statusStyle);
        final preview = StatusLineParts(prefs.statusStyle, [
          ...previewContext.segments,
          if (!prefs.statusStyle.segmented &&
              previewContext.segments.isNotEmpty)
            const StatusLineSegment(' '),
          ...pullRequestStatusLineParts(
            number: 298,
            state: 'Merged',
            style: prefs.statusStyle,
          ).segments,
        ]);
        final buttonStyle = TextButton.styleFrom(
          alignment: Alignment.centerLeft,
          foregroundColor: theme.foreground,
          minimumSize: Size.zero,
          padding: EdgeInsets.symmetric(horizontal: cell.width),
          tapTargetSize: MaterialTapTargetSize.shrinkWrap,
          shape: const RoundedRectangleBorder(),
          textStyle: style,
        );
        Widget toggle(
          String name,
          String label,
          bool value,
          ValueChanged<bool> change,
        ) => SizedBox(
          height: cell.height,
          child: TextButton(
            key: ValueKey('prompt-$name'),
            style: buttonStyle,
            onPressed: () => change(!value),
            child: Semantics(
              checked: value,
              label: label,
              child: ExcludeSemantics(
                child: Text('${value ? '[x]' : '[ ]'} $label', style: style),
              ),
            ),
          ),
        );
        return SingleChildScrollView(
          padding: EdgeInsets.symmetric(
            horizontal: cell.width * 2,
            vertical: cell.height,
          ),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Status line', style: style),
              SizedBox(height: cell.height),
              for (final format in StatusLineStyle.values) ...[
                SizedBox(
                  height: cell.height,
                  child: TextButton(
                    key: ValueKey('prompt-style-${format.name}'),
                    style: buttonStyle.copyWith(
                      backgroundColor: WidgetStatePropertyAll(
                        prefs.statusStyle == format
                            ? theme.selection
                            : Colors.transparent,
                      ),
                    ),
                    onPressed: () =>
                        choose(prefs.copyWith(statusStyle: format)),
                    child: Semantics(
                      selected: prefs.statusStyle == format,
                      child: Text(
                        '${prefs.statusStyle == format ? '>' : ' '} ${format.label}',
                        style: style,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                      ),
                    ),
                  ),
                ),
                Padding(
                  padding: EdgeInsets.only(left: cell.width * 3),
                  child: SizedBox(
                    height: cell.height,
                    child: StatusLine(
                      key: ValueKey('prompt-example-${format.name}'),
                      parts: example(format),
                      color: prefs.color,
                      textAlign: TextAlign.left,
                    ),
                  ),
                ),
                SizedBox(height: cell.height),
              ],
              Text('Preview', style: style),
              SizedBox(height: cell.height),
              ColoredBox(
                color: theme.background,
                child: Padding(
                  padding: EdgeInsets.symmetric(
                    horizontal: cell.width,
                    vertical: cell.height,
                  ),
                  child: StatusLine(
                    key: const ValueKey('prompt-preview'),
                    parts: preview,
                    color: prefs.color,
                    textAlign: TextAlign.left,
                  ),
                ),
              ),
              SizedBox(height: cell.height),
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
              SizedBox(height: cell.height),
              Text(
                'Applies to the focused pane in the top bar. Saved as you choose.',
                style: style.copyWith(
                  color: theme.foreground.withValues(alpha: .6),
                ),
              ),
              SizedBox(height: cell.height),
              SizedBox(
                height: cell.height,
                child: TextButton(
                  key: const ValueKey('prompt-reset'),
                  style: buttonStyle,
                  onPressed: () => choose(
                    prefs.copyWith(
                      statusStyle: StatusLineStyle.standard,
                      machine: true,
                      project: true,
                      branch: true,
                      color: true,
                    ),
                  ),
                  child: Text('[ Reset status line ]', style: style),
                ),
              ),
            ],
          ),
        );
      },
    );
  }
}
