import 'dart:async';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/prompt_style.dart';
import '../shared/theme/status_line_style.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart';
import '../terminal/terminal_theme_store.dart';
import 'desktop_chrome.dart';
import 'status_line.dart';
import 'workspace_pull_request_label.dart';

class PromptCustomize extends StatelessWidget {
  const PromptCustomize({super.key, required this.store});
  final AppearancePrefsStore store;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([store, terminalThemeStore]),
      builder: (context, _) {
        final prefs = store.value.prompt;
        final theme = terminalThemeFor(
          grid.AppTheme.palette.value,
          terminalThemeStore.value,
        );
        void choose(PromptPrefs next) => unawaited(store.setPrompt(next));
        StatusLineParts example(StatusLineStyle format) => statusLineParts(
          provider: '',
          machine: prefs.machine ? 'M2' : '',
          project: prefs.project ? 'app' : '',
          branch: prefs.branch ? 'main' : null,
          style: format,
          separateMachine: true,
        );
        final previewContext = example(prefs.statusStyle);
        final joined =
            prefs.statusStyle.segmented && previewContext.segments.isNotEmpty;
        final prBackground = !joined
            ? null
            : statusLinePaintSegments(
                pullRequestStatusLineParts(
                  number: 298,
                  state: 'Merged',
                  style: prefs.statusStyle,
                ),
                theme,
                color: prefs.color,
                segmentOffset: previewContext.segments.length,
              ).single.background;
        return SingleChildScrollView(
          padding: const EdgeInsets.all(DesktopChrome.panelPadding),
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.stretch,
            children: [
              Text('Status line', style: DesktopChrome.heading()),
              const SizedBox(height: 8),
              Text(
                'Choose how the focused pane’s context appears in the footer. '
                'Changes save as you choose.',
                style: DesktopChrome.metadata(),
              ),
              for (final format in StatusLineStyle.values) ...[
                if (format == StatusLineStyle.standard ||
                    format == StatusLineStyle.agnoster)
                  Padding(
                    padding: const EdgeInsets.only(top: 24, bottom: 8),
                    child: Text(
                      format.segmented ? 'Powerline' : 'Minimal',
                      style: DesktopChrome.control(medium: true),
                    ),
                  ),
                _StatusStyleChoice(
                  key: ValueKey('prompt-style-${format.name}'),
                  format: format,
                  selected: prefs.statusStyle == format,
                  onPressed: () => choose(prefs.copyWith(statusStyle: format)),
                  preview: _StatusPreviewWell(
                    key: ValueKey('prompt-example-well-${format.name}'),
                    background: theme.background,
                    child: StatusLine(
                      key: ValueKey('prompt-example-${format.name}'),
                      parts: example(format),
                      color: prefs.color,
                      textAlign: TextAlign.left,
                    ),
                  ),
                ),
                const SizedBox(height: 4),
              ],
              const SizedBox(height: 20),
              Text('Preview', style: DesktopChrome.control(medium: true)),
              const SizedBox(height: 8),
              _StatusPreviewWell(
                key: const ValueKey('prompt-preview-well'),
                background: theme.background,
                child: Builder(
                  builder: (context) => Row(
                    mainAxisSize: MainAxisSize.min,
                    children: [
                      StatusLine(
                        key: const ValueKey('prompt-preview'),
                        parts: previewContext,
                        color: prefs.color,
                        textAlign: TextAlign.left,
                        workspaceBar: true,
                        nextBackground: prBackground,
                      ),
                      if (!joined)
                        SizedBox(width: terminalCellSizeOf(context).width),
                      WorkspacePullRequestLabel(
                        number: 298,
                        state: 'Merged',
                        color: prefs.color,
                        style: prefs.statusStyle,
                        segmentOffset: previewContext.segments.length,
                      ),
                    ],
                  ),
                ),
              ),
              const SizedBox(height: 24),
              Text(
                'Show in the footer',
                style: DesktopChrome.control(medium: true),
              ),
              const SizedBox(height: 8),
              _StatusToggle(
                key: const ValueKey('prompt-machine'),
                label: 'Machine',
                value: prefs.machine,
                onChanged: (value) => choose(prefs.copyWith(machine: value)),
              ),
              _StatusToggle(
                key: const ValueKey('prompt-project'),
                label: 'Project',
                value: prefs.project,
                onChanged: (value) => choose(prefs.copyWith(project: value)),
              ),
              _StatusToggle(
                key: const ValueKey('prompt-branch'),
                label: 'Branch',
                value: prefs.branch,
                onChanged: (value) => choose(prefs.copyWith(branch: value)),
              ),
              const SizedBox(height: 8),
              _StatusToggle(
                key: const ValueKey('prompt-color'),
                label: 'Use color',
                value: prefs.color,
                onChanged: (value) => choose(prefs.copyWith(color: value)),
              ),
              const SizedBox(height: 24),
              Align(
                alignment: Alignment.centerLeft,
                child: DesktopPill(
                  key: const ValueKey('prompt-reset'),
                  label: 'Reset status line',
                  onPressed: () => choose(
                    prefs.copyWith(
                      statusStyle: StatusLineStyle.standard,
                      machine: true,
                      project: true,
                      branch: true,
                      color: true,
                    ),
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

class _StatusStyleChoice extends StatelessWidget {
  const _StatusStyleChoice({
    super.key,
    required this.format,
    required this.selected,
    required this.onPressed,
    required this.preview,
  });

  final StatusLineStyle format;
  final bool selected;
  final VoidCallback onPressed;
  final Widget preview;

  @override
  Widget build(BuildContext context) {
    final highContrast = MediaQuery.highContrastOf(context);
    return MergeSemantics(
      child: Semantics(
        label: format.label,
        selected: selected,
        inMutuallyExclusiveGroup: true,
        child: TextButton(
          onPressed: onPressed,
          style:
              TextButton.styleFrom(
                alignment: Alignment.centerLeft,
                foregroundColor: DesktopChrome.foreground,
                backgroundColor: selected
                    ? DesktopChrome.selection
                    : Colors.transparent,
                minimumSize: const Size(0, DesktopChrome.controlHeight),
                padding: const EdgeInsets.all(10),
                tapTargetSize: MaterialTapTargetSize.shrinkWrap,
                splashFactory: NoSplash.splashFactory,
                shape: RoundedRectangleBorder(
                  borderRadius: BorderRadius.circular(
                    DesktopChrome.controlRadius,
                  ),
                ),
              ).copyWith(
                side: WidgetStateProperty.resolveWith(
                  (states) => BorderSide(
                    width: 1.5,
                    color: states.contains(WidgetState.focused)
                        ? DesktopChrome.accent
                        : highContrast && selected
                        ? DesktopChrome.foreground.withValues(alpha: .45)
                        : Colors.transparent,
                  ),
                ),
                overlayColor: WidgetStateProperty.resolveWith(
                  (states) => DesktopChrome.foreground.withValues(
                    alpha: states.contains(WidgetState.pressed)
                        ? .12
                        : states.contains(WidgetState.hovered)
                        ? (highContrast ? .10 : .05)
                        : 0,
                  ),
                ),
              ),
          child: ExcludeSemantics(
            child: Column(
              crossAxisAlignment: CrossAxisAlignment.stretch,
              children: [
                Row(
                  children: [
                    Icon(
                      selected ? AppIcons.circleDot : AppIcons.circle,
                      size: 18,
                      color: selected
                          ? DesktopChrome.accent
                          : DesktopChrome.muted,
                    ),
                    const SizedBox(width: 8),
                    Expanded(
                      child: Text(
                        format.label,
                        style: DesktopChrome.control(medium: selected),
                      ),
                    ),
                  ],
                ),
                const SizedBox(height: 8),
                preview,
              ],
            ),
          ),
        ),
      ),
    );
  }
}

/// These are real terminal/status samples, independent of the surrounding UI's
/// text scaling. A large terminal font scrolls without changing its glyphs.
class _StatusPreviewWell extends StatelessWidget {
  const _StatusPreviewWell({
    super.key,
    required this.background,
    required this.child,
  });

  final Color background;
  final Widget child;

  @override
  Widget build(BuildContext context) => DecoratedBox(
    decoration: BoxDecoration(
      color: background,
      borderRadius: BorderRadius.circular(6),
      border: Border.all(color: DesktopChrome.rim),
    ),
    child: Padding(
      padding: const EdgeInsets.symmetric(horizontal: 10, vertical: 8),
      // The choice's button label can be semibold; its terminal sample cannot
      // inherit that weight. Each renderer supplies its own font and colors.
      child: DefaultTextStyle(
        style: const TextStyle(
          fontWeight: FontWeight.normal,
          fontStyle: FontStyle.normal,
        ),
        child: MediaQuery.withNoTextScaling(
          child: SingleChildScrollView(
            scrollDirection: Axis.horizontal,
            child: child,
          ),
        ),
      ),
    ),
  );
}

class _StatusToggle extends StatefulWidget {
  const _StatusToggle({
    super.key,
    required this.label,
    required this.value,
    required this.onChanged,
  });

  final String label;
  final bool value;
  final ValueChanged<bool> onChanged;

  @override
  State<_StatusToggle> createState() => _StatusToggleState();
}

class _StatusToggleState extends State<_StatusToggle> {
  bool _focused = false;

  @override
  Widget build(BuildContext context) => CheckboxListTile(
    value: widget.value,
    onChanged: (value) => widget.onChanged(value!),
    onFocusChange: (value) => setState(() => _focused = value),
    controlAffinity: ListTileControlAffinity.leading,
    title: Text(widget.label, style: DesktopChrome.control()),
    activeColor: DesktopChrome.accent,
    checkColor: DesktopChrome.accent.computeLuminance() > .179
        ? Colors.black
        : Colors.white,
    side: BorderSide(color: DesktopChrome.muted, width: 1.5),
    contentPadding: const EdgeInsets.symmetric(horizontal: 8),
    minLeadingWidth: 0,
    horizontalTitleGap: 8,
    minTileHeight: DesktopChrome.controlHeight,
    visualDensity: VisualDensity.compact,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
      side: BorderSide(
        width: 1.5,
        color: _focused ? DesktopChrome.accent : Colors.transparent,
      ),
    ),
  );
}
