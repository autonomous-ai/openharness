import 'dart:async';

import 'package:harness/shared/theme/app_icons.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../state/app_state.dart';
import '../state/harness_sessions.dart';
import '../state/swarm_catalog.dart';
import '../state/swarm_navigation.dart';
import '../state/welcome_sessions.dart';
import 'engine_identity.dart';
import 'desktop_chrome.dart';
import '../shared/theme/appearance_prefs_store.dart';
import '../shared/theme/status_line_style.dart';
import '../shared/theme/harness_background.dart';
import 'swarm_wallpaper.dart';
import 'terminal_text_action.dart';
import 'status_line.dart';
import '../shortcuts/app_keymap.dart';
import '../shortcuts/keymap.dart';
import '../shortcuts/keymap_commands.dart';
import '../terminal/terminal_text.dart';
import '../terminal/terminal_theme.dart' show lightTerminalTheme;

/// A quiet terminal welcome. Opening a command is always an explicit action.
///
/// With [app], it also offers what to pick up: the harnesses you were just
/// with and the Claude Code and Codex conversations on your machines that
/// Harness did not start ([WelcomeSessions]), limited to six recent visits.
/// [onOpen] opens one in this tab, as Cmd-P would.
class WorkspaceWelcome extends StatefulWidget {
  const WorkspaceWelcome({
    super.key,
    required this.onCommand,
    this.app,
    this.projects = const [],
    this.onOpen,
    this.composerBuilder,
  });

  final ValueChanged<String> onCommand;
  final AppNotifier? app;
  final List<SavedSwarmProject> projects;
  final ValueChanged<SwarmDestination>? onOpen;

  /// Embedded creation and the popup supply the exact same form. Welcome
  /// only contributes its existing recent-session data beneath that form.
  final Widget Function(Widget? recentSessions)? composerBuilder;

  @override
  State<WorkspaceWelcome> createState() => _WorkspaceWelcomeState();
}

class _WorkspaceWelcomeState extends State<WorkspaceWelcome> {
  // Resolve the icon at compile time. Lazy initialization of Lucide's large
  // generated library overflows the browser debug runtime's stack here.
  static const _phoneIcon = AppIcons.smartphone;
  WelcomeSessions? _sessions;
  int _cursor = 0;
  final _focus = FocusNode(debugLabel: 'Welcome sessions');

  ValueChanged<String> get onCommand => widget.onCommand;

  @override
  void initState() {
    super.initState();
    final app = widget.app;
    if (app != null && widget.onOpen != null) {
      _sessions = WelcomeSessions(app, projects: widget.projects)
        ..addListener(_changed);
      _sessions!.load();
      app.addListener(_appChanged);
      FocusManager.instance.addListener(_claimFocus);
      WidgetsBinding.instance.addPostFrameCallback((_) => _claimFocus());
    }
  }

  /// An empty tab gives its keys to the workspace around this page — on a new
  /// tab, and again when Cmd-P or a dialog closes. Keys start at the focused
  /// node and only go up, so that focus is taken here, where they are used.
  /// Focus anywhere else (a field, a dialog, Cmd-P) is left alone, and the
  /// app's shortcuts are read before any of this.
  void _claimFocus() {
    if (widget.composerBuilder != null) return;
    if (!mounted || _focus.hasPrimaryFocus || !_focus.canRequestFocus) return;
    final primary = FocusManager.instance.primaryFocus;
    if (primary != null && !_focus.ancestors.contains(primary)) return;
    scheduleMicrotask(() {
      final now = FocusManager.instance.primaryFocus;
      if (mounted && (now == null || _focus.ancestors.contains(now))) {
        _focus.requestFocus();
      }
    });
  }

  void _appChanged() => _sessions?.appChanged();

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    FocusManager.instance.removeListener(_claimFocus);
    _focus.dispose();
    if (_sessions != null) widget.app?.removeListener(_appChanged);
    _sessions
      ?..removeListener(_changed)
      ..dispose();
    super.dispose();
  }

  void _open(int index) {
    final rows = _sessions?.rows ?? const [];
    if (index < 0 || index >= rows.length) return;
    widget.onOpen?.call(rows[index]);
  }

  /// A tab with nothing in it has no pane to take keys: plain ones work here,
  /// as on the terminal client's home. Anything else goes on to the shortcuts.
  KeyEventResult _key(FocusNode node, KeyEvent event) {
    if (event is! KeyDownEvent && event is! KeyRepeatEvent) {
      return KeyEventResult.ignored;
    }
    final rows = _sessions?.rows ?? const [];
    if (rows.isEmpty ||
        HardwareKeyboard.instance.isMetaPressed ||
        HardwareKeyboard.instance.isControlPressed ||
        HardwareKeyboard.instance.isAltPressed) {
      return KeyEventResult.ignored;
    }
    final key = event.logicalKey;
    final digit = key.keyLabel.length == 1 ? int.tryParse(key.keyLabel) : null;
    if (digit != null && digit >= 1 && digit <= rows.length) {
      _open(digit - 1);
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowDown) {
      setState(() => _cursor = (_cursor + 1).clamp(0, rows.length - 1));
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.arrowUp) {
      setState(() => _cursor = (_cursor - 1).clamp(0, rows.length - 1));
      return KeyEventResult.handled;
    }
    if (key == LogicalKeyboardKey.enter ||
        key == LogicalKeyboardKey.numpadEnter) {
      _open(_cursor.clamp(0, rows.length - 1));
      return KeyEventResult.handled;
    }
    return KeyEventResult.ignored;
  }

  static const _actions = [
    ('agent.new', 'Start a harness'),
    ('harnesses.list', 'Manage all your harnesses'),
    ('models.list', 'Deploy a local model'),
    ('machines.list', 'Manage all your machines'),
    ('app.store', 'Build beyond code'),
  ];

  @override
  Widget build(BuildContext context) {
    TerminalFontScope.watch(context);
    return ListenableBuilder(
      listenable: Listenable.merge([terminalFontStore, appearancePrefsStore]),
      builder: (context, _) => _buildWelcome(context),
    );
  }

  Widget _buildWelcome(BuildContext context) {
    grid.AppTheme.watch(context);
    if (widget.composerBuilder case final composer?) {
      return Material(
        key: const ValueKey('workspace-welcome'),
        color: grid.AppPalette.windowBg,
        child: composer(_desktopSessions()),
      );
    }
    final palette = grid.AppTheme.surfacePalette;
    final background = appearancePrefsStore.value.background;
    final hasArtwork = background != HarnessBackground.plain;
    final ink = hasArtwork
        ? const Color(0xffdededb)
        : palette.foreground.withValues(alpha: .75);
    // Keys in the terminal's green. Artwork is dark, so over it — and on a dark
    // palette — the pale one; on a light palette's plain field, the light
    // terminal ramp's (5.9:1, where the pale one is 1.4:1).
    final accent = hasArtwork || palette.isDark
        ? const Color(0xffa5d786)
        : lightTerminalTheme.green;
    // The page stands where a terminal will, so it is set like one: the
    // terminal's face at the terminal's size, following ⌘+ and ⌘−.
    final style = terminalTextStyle(
      color: ink,
      fontWeight: FontWeight.w400,
      height: 1.5,
    );
    final keymap = KeymapTheme.of(context)?.current ?? harnessDefaultKeymap;
    final rows = [
      for (final (command, description) in _actions)
        (
          command: command,
          description: description,
          hint: keymap
              .bindingsFor(KeymapContext.workspace)
              .where((binding) => binding.command == command)
              .map(describeKeyBinding)
              .firstOrNull,
        ),
    ];
    double widthOf(String text) {
      final painter = TextPainter(
        text: TextSpan(text: text, style: style),
        textDirection: TextDirection.ltr,
        textScaler: MediaQuery.textScalerOf(context),
      )..layout();
      final width = painter.width;
      painter.dispose();
      return width;
    }

    final keyWidth = rows
        .map((row) => widthOf('${row.hint ?? ''}    '))
        .reduce((a, b) => a > b ? a : b);
    final descriptionWidth = rows
        .map((row) => widthOf(row.description))
        .reduce((a, b) => a > b ? a : b);
    final line = MediaQuery.textScalerOf(context).scale(style.fontSize!) * 1.5;
    final cell = widthOf('M');
    final commandsWidth = keyWidth + descriptionWidth;
    // The sessions to pick up, beside the commands: a fixed measure, so a long
    // title gives way rather than the page.
    final listWidth = cell * 44;
    final gap = cell * 2;
    final sessions = _sessionsList(
      style: style,
      ink: ink,
      accent: accent,
      cell: cell,
    );
    final footerInset = line + 52;
    return Focus(
      focusNode: _focus,
      canRequestFocus: _sessions != null,
      skipTraversal: true,
      onKeyEvent: _key,
      child: Material(
        key: const ValueKey('workspace-welcome'),
        color: grid.AppPalette.swarmWelcome,
        child: Stack(
          fit: StackFit.expand,
          children: [
            RepaintBoundary(
              key: const ValueKey('welcome-wallpaper'),
              child: SwarmWallpaper(background: background),
            ),
            LayoutBuilder(
              // Keep the text centered when it fits, but let large text scroll
              // above the fixed Customize button rather than underneath it.
              builder: (context, constraints) => Padding(
                padding: EdgeInsets.only(bottom: footerInset),
                child: SingleChildScrollView(
                  key: const ValueKey('welcome-scroll'),
                  padding: EdgeInsets.fromLTRB(24, footerInset + 24, 24, 24),
                  child: ConstrainedBox(
                    constraints: BoxConstraints(
                      minHeight: (constraints.maxHeight - footerInset * 2 - 48)
                          .clamp(0, double.infinity),
                    ),
                    child: Center(
                      child: DefaultTextStyle(
                        style: style,
                        textAlign: TextAlign.center,
                        child: Column(
                          key: const ValueKey('workspace-welcome-text'),
                          mainAxisSize: MainAxisSize.min,
                          children: [
                            Text(
                              'Harness like a boss.',
                              key: const ValueKey('welcome-tagline'),
                            ),
                            SizedBox(height: line * 2),
                            if (sessions == null)
                              _commands(
                                rows,
                                commandsWidth,
                                keyWidth,
                                style,
                                ink,
                                accent,
                              )
                            // Side by side when both fit; the commands go under
                            // the list in a narrow window.
                            else if (constraints.maxWidth - 48 >=
                                listWidth + gap * 2 + 1 + commandsWidth)
                              IntrinsicHeight(
                                child: Row(
                                  mainAxisSize: MainAxisSize.min,
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    SizedBox(width: listWidth, child: sessions),
                                    SizedBox(width: gap),
                                    Container(
                                      key: const ValueKey('welcome-rule'),
                                      width: 1,
                                      color: ink.withValues(alpha: .15),
                                    ),
                                    SizedBox(width: gap),
                                    _commands(
                                      rows,
                                      commandsWidth,
                                      keyWidth,
                                      style,
                                      ink,
                                      accent,
                                    ),
                                  ],
                                ),
                              )
                            else ...[
                              SizedBox(width: listWidth, child: sessions),
                              SizedBox(height: line),
                              _commands(
                                rows,
                                commandsWidth,
                                keyWidth,
                                style,
                                ink,
                                accent,
                              ),
                            ],
                          ],
                        ),
                      ),
                    ),
                  ),
                ),
              ),
            ),
            Positioned(
              right: 20,
              bottom: 16,
              child: TerminalTextAction(
                key: const ValueKey('welcome-customize'),
                onPressed: () => onCommand('app.customize'),
                label: 'Customize Harness',
                overArtwork: hasArtwork,
              ),
            ),
          ],
        ),
      ),
    );
  }

  Widget? _desktopSessions() {
    final sessions = _sessions;
    if (sessions == null || sessions.rows.isEmpty) return null;
    return Column(
      key: const ValueKey('welcome-sessions'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      mainAxisSize: MainAxisSize.min,
      children: [
        Padding(
          padding: const EdgeInsets.only(bottom: 8, left: 10),
          child: Semantics(
            header: true,
            child: Text('Recent harnesses', style: DesktopChrome.metadata()),
          ),
        ),
        for (final (index, row) in sessions.rows.indexed)
          TextButton(
            key: ValueKey('welcome-session-${row.id}'),
            onPressed: () => _open(index),
            style:
                TextButton.styleFrom(
                  foregroundColor: DesktopChrome.muted,
                  backgroundColor: Colors.transparent,
                  enabledMouseCursor: SystemMouseCursors.click,
                  alignment: Alignment.centerLeft,
                  padding: const EdgeInsets.symmetric(
                    horizontal: 10,
                    vertical: 8,
                  ),
                  shape: RoundedRectangleBorder(
                    borderRadius: BorderRadius.circular(
                      grid.AppDesktop.rowRadius,
                    ),
                  ),
                ).copyWith(
                  side: WidgetStateProperty.resolveWith(
                    (states) => BorderSide(
                      width: 1.5,
                      color: states.contains(WidgetState.focused)
                          ? (MediaQuery.highContrastOf(context)
                                ? DesktopChrome.accent
                                : DesktopChrome.focusRing)
                          : Colors.transparent,
                    ),
                  ),
                ),
            child: Row(
              children: [
                ExcludeSemantics(
                  child: EngineMark(engine: row.engine, size: 18),
                ),
                const SizedBox(width: 12),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Text(
                        row.title,
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.control(
                          color: DesktopChrome.muted,
                        ),
                      ),
                      if (_recentContext(row) case final context?) ...[
                        const SizedBox(height: 2),
                        context,
                      ],
                    ],
                  ),
                ),
                const SizedBox(width: 16),
                if (sessions.lastUsedAt(row) case final at?)
                  Text(
                    sessions.readAt.difference(at).inMinutes < 1
                        ? 'now'
                        : harnessActivityAge(at, sessions.readAt),
                    style: DesktopChrome.text(
                      size: 12,
                      color: DesktopChrome.muted,
                    ),
                  ),
              ],
            ),
          ),
      ],
    );
  }

  Widget? _recentContext(SwarmDestination row) {
    final context = row.promptContext;
    if (context == null) {
      return row.detail.isEmpty
          ? null
          : Text(
              row.detail,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: DesktopChrome.metadata(),
            );
    }
    final prefs = appearancePrefsStore.value.prompt;
    final parts = statusLineParts(
      provider: '',
      machine: prefs.machine ? context.machine ?? '' : '',
      project: prefs.project ? context.project ?? '' : '',
      branch: prefs.branch ? context.branch : null,
      style: prefs.statusStyle,
      separateMachine: true,
    );
    if (parts.text.isEmpty) return null;
    return Tooltip(
      message: parts.text,
      child: StatusLine(
        parts: parts,
        color: prefs.color,
        workspaceBar: true,
        textAlign: TextAlign.left,
        middleEllipsis: true,
        surfaceBackground: grid.AppPalette.windowBg,
        monochromeColor: DesktopChrome.muted,
      ),
    );
  }

  /// The commands, each with its shortcut: the whole page before there is
  /// anything to pick up, and the column beside the list after.
  Widget _commands(
    List<({String command, String description, String? hint})> rows,
    double width,
    double keyWidth,
    TextStyle style,
    Color ink,
    Color accent,
  ) => SizedBox(
    width: width,
    child: Column(
      mainAxisSize: MainAxisSize.min,
      children: [
        for (final row in rows)
          TextButton(
            key: ValueKey('welcome-${row.command}'),
            onPressed: () => onCommand(row.command),
            style: TextButton.styleFrom(
              foregroundColor: ink,
              textStyle: style,
              padding: const EdgeInsets.symmetric(vertical: 2),
              minimumSize: Size.zero,
              tapTargetSize: MaterialTapTargetSize.shrinkWrap,
              shape: const RoundedRectangleBorder(),
            ),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                SizedBox(
                  width: keyWidth,
                  child: Text(
                    row.hint ?? '',
                    style: TextStyle(color: accent),
                    textAlign: TextAlign.left,
                  ),
                ),
                Expanded(
                  child: Text(row.description, textAlign: TextAlign.left),
                ),
              ],
            ),
          ),
        // The phone, where everyone looks rather than only in the app menu —
        // after a blank row, since it has no shortcut to stand in the list.
        Text(' ', style: style),
        TextButton(
          key: const ValueKey('welcome-add-phone'),
          onPressed: () => onCommand('app.add_phone'),
          style: TextButton.styleFrom(
            foregroundColor: ink,
            textStyle: style,
            padding: const EdgeInsets.symmetric(vertical: 2),
            minimumSize: Size.zero,
            tapTargetSize: MaterialTapTargetSize.shrinkWrap,
            shape: const RoundedRectangleBorder(),
          ),
          // Laid out like the rows above: a phone where their key stands.
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.center,
            children: [
              SizedBox(
                width: keyWidth,
                child: Align(
                  alignment: Alignment.centerLeft,
                  // Drawn at the weight and height of the ⌘ keys beside it.
                  child: Icon(
                    _phoneIcon,
                    color: accent,
                    size: (style.fontSize ?? 13) * 1.15,
                  ),
                ),
              ),
              const Expanded(
                child: Text('Work from your phone', textAlign: TextAlign.left),
              ),
            ],
          ),
        ),
      ],
    ),
  );

  /// What to pick up, numbered: null when there is nothing to offer. Every row
  /// is alike — a harness or a conversation Harness did not start, its name
  /// and how long ago; where it came from is not this page's business.
  Widget? _sessionsList({
    required TextStyle style,
    required Color ink,
    required Color accent,
    required double cell,
  }) {
    final sessions = _sessions;
    if (sessions == null) return null;
    final rows = sessions.rows;
    final muted = ink.withValues(alpha: .55);
    if (rows.isEmpty) {
      return sessions.loading && widget.app!.searchableMachineIds.isNotEmpty
          ? Text(
              'Finding your harnesses…',
              textAlign: TextAlign.left,
              style: TextStyle(color: muted),
            )
          : null;
    }
    return Column(
      key: const ValueKey('welcome-sessions'),
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        for (final (index, row) in rows.indexed)
          _sessionRow(
            index,
            row,
            style: style,
            ink: ink,
            muted: muted,
            accent: accent,
            cell: cell,
          ),
      ],
    );
  }

  Widget _sessionRow(
    int index,
    SwarmDestination row, {
    required TextStyle style,
    required Color ink,
    required Color muted,
    required Color accent,
    required double cell,
  }) {
    final machine = widget.app!.stateOf(row.machineId ?? '');
    final agent = row.agentId == null
        ? null
        : machine?.agents.where((agent) => agent.id == row.agentId).firstOrNull;
    final at = _sessions!.lastUsedAt(row);
    final readAt = _sessions!.readAt;
    final age = at == null
        ? ''
        : readAt.difference(at).inMinutes < 1
        ? 'now'
        : harnessActivityAge(at, readAt);
    final selected = index == _cursor;
    return TextButton(
      key: ValueKey('welcome-session-${row.id}'),
      onPressed: () => _open(index),
      style: TextButton.styleFrom(
        foregroundColor: ink,
        backgroundColor: selected
            ? ink.withValues(alpha: .07)
            : Colors.transparent,
        textStyle: style,
        padding: const EdgeInsets.symmetric(vertical: 2),
        minimumSize: Size.zero,
        tapTargetSize: MaterialTapTargetSize.shrinkWrap,
        shape: const RoundedRectangleBorder(),
      ),
      child: Row(
        children: [
          SizedBox(
            width: cell * 3,
            child: Text(
              '${index + 1}',
              textAlign: TextAlign.left,
              style: TextStyle(color: accent),
            ),
          ),
          Padding(
            padding: EdgeInsets.only(right: cell),
            child: EngineMark(
              engine: agent?.identityEngine ?? row.engine,
              displayName: agent?.identityDisplayName,
              size: (style.fontSize ?? 13) * 1.1,
            ),
          ),
          Expanded(
            child: Text(
              row.title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              textAlign: TextAlign.left,
            ),
          ),
          SizedBox(
            width: cell * 5,
            child: Text(
              age,
              textAlign: TextAlign.right,
              style: TextStyle(color: muted),
            ),
          ),
        ],
      ),
    );
  }
}
