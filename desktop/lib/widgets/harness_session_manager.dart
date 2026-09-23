import 'dart:async';
import 'dart:math' as math;

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import '../shared/theme/app_theme.dart';
import '../shared/widgets/app_menu.dart';
import '../state/app_state.dart';
import '../state/harness_sessions.dart';
import '../state/swarm_navigation.dart';
import 'engine_identity.dart';
import '../notify/alert_sounds.dart';

/// A compact, live inventory. Action receipts belong to AppNotifier, so
/// dismissing this surface never cancels a pause or launches a second resume.
class HarnessSessionManager extends StatefulWidget {
  const HarnessSessionManager({
    super.key,
    required this.app,
    required this.recent,
    required this.onClose,
    required this.onOpen,
    this.initialFilter = SessionFilter.all,
  });
  final AppNotifier app;
  final List<String> recent;
  final VoidCallback onClose;
  final Future<bool> Function(HarnessSession) onOpen;
  final SessionFilter initialFilter;

  @override
  State<HarnessSessionManager> createState() => _HarnessSessionManagerState();
}

class _HarnessSessionManagerState extends State<HarnessSessionManager> {
  final _search = TextEditingController();
  final _searchFocus = FocusNode(debugLabel: 'Search harnesses');
  final _scroll = ScrollController();
  final _sortMenu = MenuController();
  final _pending = <String, HarnessSession>{};
  final _errors = <String, String>{};
  late SessionFilter _filter;
  Timer? _clock;
  SessionSort _sort = SessionSort.recent;
  String? _selected;
  int _selectedIndex = 0;
  final _rowKeys = <String, GlobalKey>{};
  String? _opening;

  @override
  void initState() {
    super.initState();
    _filter = widget.initialFilter;
    _clock = Timer.periodic(const Duration(minutes: 1), (_) => _changed());
    widget.app.addListener(_changed);
    // Its own notifier — marking one agent must not rebuild the workspace — so
    // this list asks for its own redraw while it is open.
    widget.app.agentUnread.addListener(_changed);
  }

  void _changed() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    widget.app.removeListener(_changed);
    widget.app.agentUnread.removeListener(_changed);
    _clock?.cancel();
    _search.dispose();
    _searchFocus.dispose();
    _scroll.dispose();
    super.dispose();
  }

  List<HarnessSession> get _sessions {
    final rows = {for (final row in harnessSessions(widget.app)) row.id: row};
    // Keep the row steady while a confirmed pause refreshes the saved roster.
    for (final row in _pending.values) {
      rows.putIfAbsent(row.id, () => row);
    }
    return rows.values.toList();
  }

  Future<void> _toggle(HarnessSession row) async {
    if (_pending.containsKey(row.id) || !row.canControl) return;
    final current = widget.app
        .stateOf(row.machineId)
        ?.agents
        .where((agent) => agent.id == row.agent.id)
        .firstOrNull;
    if (!identical(widget.app.stateOf(row.machineId), row.machine) ||
        current == null ||
        current.sessionId != row.agent.sessionId ||
        current.isStopped != row.agent.isStopped) {
      return;
    }
    setState(() {
      _pending[row.id] = row;
      _errors.remove(row.id);
    });
    String? error;
    try {
      if (row.agent.isStopped) {
        error = (await widget.app.resumeAgent(
          row.machineId,
          row.agent.id,
        )).error;
      } else {
        error = await widget.app.pauseAgent(row.machineId, row.agent.id);
      }
    } catch (_) {
      error =
          'Could not ${row.agent.isStopped ? 'resume' : 'pause'} this harness. Try again.';
    }
    if (!mounted) return;
    setState(() {
      _pending.remove(row.id);
      if (error != null) {
        _errors[row.id] = error.replaceFirst('Stop failed:', 'Pause failed:');
      }
    });
  }

  Future<void> _open(HarnessSession row, {bool answering = false}) async {
    // Going to the harness is what makes its news read. Done here rather than
    // after the open succeeds: the person has decided to look, and a mark that
    // outlived the click would read as the click not having worked.
    widget.app.markAgentSeen(row.machine.machine.machineId, row.agent.id);
    if (answering) {
      final current = widget.app.questionFor(row.machineId, row.agent.id);
      if (current == null || row.question?.sameAs(current) != true) return;
    }
    final awaitingInput =
        row.agent.terminalAvailable && row.agent.launchState == 'starting';
    if (_opening != null ||
        (_pending.containsKey(row.id) && !awaitingInput) ||
        !row.canOpen) {
      return;
    }
    setState(() {
      _opening = row.id;
      _errors.remove(row.id);
    });
    try {
      final opened = await widget.onOpen(row);
      if (mounted && opened) widget.onClose();
    } on SwarmResumeFailure catch (failure) {
      if (mounted) setState(() => _errors[row.id] = failure.message);
    } catch (_) {
      if (mounted) {
        setState(
          () => _errors[row.id] = 'Could not open this harness. Try again.',
        );
      }
    } finally {
      if (mounted) setState(() => _opening = null);
    }
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final all = _sessions;
    final rows = visibleHarnessSessions(
      all,
      query: _search.text,
      filter: _filter,
      sort: _sort,
      recent: widget.recent,
    );
    final running = all.where((row) => row.running).length;
    final paused = all.where((row) => row.agent.isStopped).length;
    final needsInput = all.where((row) => row.needsInput).length;
    final now = DateTime.now();
    final showingQuestions = _filter == SessionFilter.needsInput;
    final selected =
        rows.where((row) => row.id == _selected).firstOrNull ??
        (rows.isEmpty
            ? null
            : rows[_selected == null
                  ? 0
                  : _selectedIndex.clamp(0, rows.length - 1)]);
    if (_selected != null && selected != null) {
      _selected = selected.id;
      _selectedIndex = rows.indexOf(selected);
    }
    final scale = MediaQuery.textScalerOf(context);
    final rowHeight =
        math.max(
          62.0,
          scale.scale(AppType.bodySize) * 1.4 +
              scale.scale(AppType.monoMetaSize) * 1.4 +
              26,
        ) +
        (showingQuestions ? scale.scale(AppType.monoMetaSize) * 1.4 + 6 : 0);
    return FocusScope(
      child: CallbackShortcuts(
        bindings: {
          const SingleActivator(LogicalKeyboardKey.escape): widget.onClose,
        },
        child: Focus(
          onKeyEvent: (_, event) {
            if (event is! KeyDownEvent ||
                rows.isEmpty ||
                !_searchFocus.hasFocus) {
              return KeyEventResult.ignored;
            }
            final key = event.logicalKey;
            if ((key == LogicalKeyboardKey.enter ||
                    key == LogicalKeyboardKey.numpadEnter) &&
                _search.value.composing.isCollapsed) {
              final row = selected!;
              unawaited(_open(row, answering: row.needsInput));
              return KeyEventResult.handled;
            }
            if (key != LogicalKeyboardKey.arrowDown &&
                key != LogicalKeyboardKey.arrowUp) {
              return KeyEventResult.ignored;
            }
            final at = rows.indexOf(selected!);
            final next = _selected == null
                ? (key == LogicalKeyboardKey.arrowDown ? 0 : rows.length - 1)
                : (at + (key == LogicalKeyboardKey.arrowDown ? 1 : -1)).clamp(
                    0,
                    rows.length - 1,
                  );
            setState(() => _selected = rows[next].id);
            void reveal() {
              final context = _rowKeys[rows[next].id]?.currentContext;
              if (!mounted || context == null) return;
              Scrollable.ensureVisible(
                context,
                alignmentPolicy: key == LogicalKeyboardKey.arrowDown
                    ? ScrollPositionAlignmentPolicy.keepVisibleAtEnd
                    : ScrollPositionAlignmentPolicy.keepVisibleAtStart,
              );
            }

            if (_rowKeys[rows[next].id]?.currentContext != null) {
              reveal();
            } else if (_scroll.hasClients) {
              // Materialize a distant row, then use its real bounds. Question
              // text, errors, row padding and enlarged type all affect height.
              _scroll.jumpTo(
                (6 + next * (rowHeight + 2)).clamp(
                  0,
                  _scroll.position.maxScrollExtent,
                ),
              );
              WidgetsBinding.instance.addPostFrameCallback((_) => reveal());
            }
            return KeyEventResult.handled;
          },
          child: Material(
            key: const ValueKey('session-manager'),
            color: AppPalette.panelBg,
            borderRadius: BorderRadius.circular(14),
            clipBehavior: Clip.antiAlias,
            child: Column(
              mainAxisSize: MainAxisSize.min,
              children: [
                Padding(
                  padding: const EdgeInsets.fromLTRB(20, 10, 12, 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: Text('Harnesses', style: AppType.heading()),
                      ),
                      IconButton(
                        tooltip: 'Close harnesses',
                        onPressed: widget.onClose,
                        icon: const Icon(LucideIcons.x, size: 16),
                      ),
                    ],
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: 16),
                  child: TextField(
                    key: const ValueKey('session-search'),
                    controller: _search,
                    focusNode: _searchFocus,
                    autofocus: true,
                    style: AppType.monoLabel(),
                    onChanged: (_) => setState(() => _selected = null),
                    onSubmitted: (_) {
                      if (selected != null) unawaited(_open(selected));
                    },
                    decoration: InputDecoration(
                      hintText:
                          'Search harnesses, machines, projects, branches…',
                      hintStyle: AppType.monoLabel(color: AppPalette.textFaint),
                      prefixIcon: Icon(
                        LucideIcons.search,
                        size: 15,
                        color: AppPalette.textFaint,
                      ),
                      prefixIconConstraints: const BoxConstraints(minWidth: 36),
                      suffixIcon: _search.text.isEmpty
                          ? null
                          : IconButton(
                              tooltip: 'Clear search',
                              icon: const Icon(LucideIcons.x, size: 14),
                              onPressed: () {
                                _search.clear();
                                setState(() => _selected = null);
                                _searchFocus.requestFocus();
                              },
                            ),
                      isDense: true,
                      filled: true,
                      fillColor: AppPalette.windowBg,
                      contentPadding: const EdgeInsets.symmetric(
                        vertical: 12,
                        horizontal: 12,
                      ),
                      border: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: BorderSide.none,
                      ),
                      focusedBorder: OutlineInputBorder(
                        borderRadius: BorderRadius.circular(8),
                        borderSide: BorderSide(
                          color: AppPalette.accent.withValues(alpha: .8),
                        ),
                      ),
                    ),
                  ),
                ),
                Padding(
                  padding: const EdgeInsets.fromLTRB(16, 10, 12, 8),
                  child: Row(
                    children: [
                      Expanded(
                        child: SingleChildScrollView(
                          scrollDirection: Axis.horizontal,
                          child: Row(
                            children: [
                              for (final filter in SessionFilter.values)
                                Padding(
                                  padding: const EdgeInsets.only(right: 4),
                                  child: Semantics(
                                    selected: _filter == filter,
                                    child: TextButton(
                                      key: ValueKey(
                                        'session-filter:${filter.name}',
                                      ),
                                      onPressed: () => setState(() {
                                        _filter = filter;
                                        _selected = null;
                                      }),
                                      style: TextButton.styleFrom(
                                        backgroundColor: _filter == filter
                                            ? AppPalette.textPrimary.withValues(
                                                alpha: .08,
                                              )
                                            : Colors.transparent,
                                        foregroundColor: _filter == filter
                                            ? AppPalette.textPrimary
                                            : AppPalette.textSecondary,
                                        minimumSize: const Size(0, 30),
                                        padding: const EdgeInsets.symmetric(
                                          horizontal: 10,
                                        ),
                                        textStyle: AppType.monoMeta(),
                                        shape: RoundedRectangleBorder(
                                          borderRadius: BorderRadius.circular(
                                            6,
                                          ),
                                        ),
                                      ),
                                      child: Text(switch (filter) {
                                        SessionFilter.all =>
                                          'All ${all.length}',
                                        SessionFilter.needsInput =>
                                          'Needs input $needsInput',
                                        SessionFilter.running =>
                                          'Running $running',
                                        SessionFilter.paused =>
                                          'Paused $paused',
                                      }),
                                    ),
                                  ),
                                ),
                            ],
                          ),
                        ),
                      ),
                      MenuAnchor(
                        controller: _sortMenu,
                        menuChildren: [
                          for (final sort in SessionSort.values)
                            AppMenuItem(
                              label: sort.label,
                              selected: _sort == sort,
                              onPressed: () {
                                _sortMenu.close();
                                setState(() {
                                  _sort = sort;
                                  _selected = null;
                                });
                              },
                            ),
                        ],
                        builder: (context, controller, child) => Tooltip(
                          message: 'Sort harnesses',
                          child: TextButton.icon(
                            onPressed: () => controller.isOpen
                                ? controller.close()
                                : controller.open(),
                            style: TextButton.styleFrom(
                              foregroundColor: AppPalette.textSecondary,
                              minimumSize: const Size(0, 30),
                              padding: const EdgeInsets.symmetric(
                                horizontal: 8,
                              ),
                              textStyle: AppType.monoMeta(),
                            ),
                            icon: const Icon(
                              LucideIcons.arrowDownWideNarrow,
                              size: 13,
                            ),
                            label: Text(
                              _sort == SessionSort.recent
                                  ? 'Recent'
                                  : _sort.label,
                            ),
                          ),
                        ),
                      ),
                    ],
                  ),
                ),
                Divider(
                  height: 1,
                  color: AppPalette.textPrimary.withValues(alpha: .08),
                ),
                Flexible(
                  child: rows.isEmpty
                      ? Padding(
                          padding: const EdgeInsets.symmetric(
                            vertical: 42,
                            horizontal: 24,
                          ),
                          child: Column(
                            mainAxisSize: MainAxisSize.min,
                            children: [
                              Icon(
                                LucideIcons.layers,
                                size: 25,
                                color: AppPalette.textFaint,
                              ),
                              const SizedBox(height: 12),
                              Text(
                                all.isEmpty
                                    ? 'Your harnesses live here'
                                    : showingQuestions &&
                                          _search.text.trim().isEmpty
                                    ? 'No harnesses need your input'
                                    : 'No matching harnesses',
                                style: AppType.label(height: 1.3),
                              ),
                              if (!showingQuestions ||
                                  _search.text.trim().isNotEmpty ||
                                  all.isEmpty) ...[
                                const SizedBox(height: 6),
                                Text(
                                  all.isEmpty
                                      ? 'Open a harness to get started.'
                                      : 'Try another search or filter.',
                                  style: AppType.body(
                                    color: AppPalette.textSecondary,
                                  ),
                                ),
                              ],
                            ],
                          ),
                        )
                      : Scrollbar(
                          controller: _scroll,
                          child: ListView.builder(
                            controller: _scroll,
                            shrinkWrap: true,
                            padding: const EdgeInsets.symmetric(
                              horizontal: 8,
                              vertical: 6,
                            ),
                            itemCount: rows.length,
                            itemBuilder: (context, index) {
                              final row = rows[index];
                              final pendingStop =
                                  (widget.app.pendingAgentPause(
                                        row.machineId,
                                        row.agent.id,
                                      ) ??
                                      widget.app.pendingAgentStop(
                                        row.machineId,
                                        row.agent.id,
                                      )) !=
                                  null;
                              final pendingResume = widget.app
                                  .restartAttempt(row.machineId, row.agent.id)
                                  .busy;
                              final busy =
                                  _pending.containsKey(row.id) ||
                                  pendingStop ||
                                  pendingResume ||
                                  _opening == row.id;
                              return _SessionRow(
                                key: _rowKeys.putIfAbsent(
                                  row.id,
                                  () => GlobalKey(),
                                ),
                                row: row,
                                height: rowHeight,
                                now: now,
                                showQuestion: showingQuestions,
                                unread: widget.app.agentUnread.kindFor(
                                  row.machine.machine.machineId,
                                  row.agent.id,
                                ),
                                selected:
                                    _selected != null && selected?.id == row.id,
                                busy: busy,
                                pendingLabel: _opening == row.id
                                    ? 'Opening…'
                                    : pendingStop
                                    ? 'Pausing…'
                                    : row.agent.isStopped
                                    ? 'Resuming…'
                                    : 'Pausing…',
                                error: _errors[row.id],
                                onOpen: () =>
                                    _open(row, answering: row.needsInput),
                                onAnswer: () => _open(row, answering: true),
                                onToggle: () => _toggle(row),
                              );
                            },
                          ),
                        ),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}

class _SessionRow extends StatelessWidget {
  const _SessionRow({
    super.key,
    required this.row,
    required this.height,
    required this.now,
    required this.showQuestion,
    required this.unread,
    required this.selected,
    required this.busy,
    required this.pendingLabel,
    required this.onOpen,
    required this.onToggle,
    required this.onAnswer,
    this.error,
  });
  final HarnessSession row;
  final double height;
  final DateTime now;
  final bool selected, busy, showQuestion;
  final String pendingLabel;

  /// News nobody has looked at yet, or null. Drawn beside the name, so the mark
  /// sits with the thing it is about rather than in a column of its own.
  final AlertKind? unread;

  final VoidCallback onOpen, onToggle, onAnswer;
  final String? error;

  @override
  Widget build(BuildContext context) {
    // Login or permission review may be required before a native resume hook.
    final canOpen =
        row.canOpen &&
        (!busy ||
            (row.agent.terminalAvailable &&
                row.agent.launchState == 'starting'));
    // Play/pause carries normal state; only exceptions need another label.
    final attention = switch (row.status) {
      'Ready' || 'Paused' || 'Working' || 'Needs input' => null,
      final status => status,
    };
    final activity = row.lastActiveAt == null
        ? 'Last activity unavailable'
        : 'Last active ${harnessActivityAge(row.lastActiveAt, now)} ago';
    Widget detail(IconData icon, String text, Color color, {String? tooltip}) =>
        Flexible(
          child: Tooltip(
            message: tooltip ?? text,
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(icon, size: 11, color: color),
                const SizedBox(width: 5),
                Flexible(
                  child: Text(
                    text,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: AppType.monoMeta(color: color, height: 1.3),
                  ),
                ),
              ],
            ),
          ),
        );
    return Padding(
      padding: const EdgeInsets.symmetric(vertical: 1),
      child: DecoratedBox(
        decoration: BoxDecoration(
          color: selected
              ? AppPalette.textPrimary.withValues(alpha: .06)
              : Colors.transparent,
          borderRadius: BorderRadius.circular(8),
        ),
        child: Column(
          children: [
            SizedBox(
              height: height,
              child: Row(
                children: [
                  Expanded(
                    child: Semantics(
                      key: ValueKey('session-open:${row.id}'),
                      selected: selected,
                      container: true,
                      button: true,
                      enabled: canOpen,
                      label:
                          '${row.agent.isStopped ? 'Resume and open' : 'Open'} ${row.agent.displayName}',
                      value: [
                        row.machine.machine.displayName,
                        row.project?.label,
                        row.project?.shownBranch,
                        row.question?.prompt,
                        activity,
                        busy ? pendingLabel : row.status,
                      ].whereType<String>().join(', '),
                      onTap: canOpen ? onOpen : null,
                      excludeSemantics: true,
                      child: InkWell(
                        onTap: canOpen ? onOpen : null,
                        borderRadius: BorderRadius.circular(8),
                        child: Padding(
                          padding: const EdgeInsets.fromLTRB(12, 10, 6, 10),
                          child: Row(
                            children: [
                              EngineMark(
                                engine: row.agent.identityEngine,
                                size: 22,
                              ),
                              const SizedBox(width: 12),
                              Expanded(
                                child: Column(
                                  mainAxisAlignment: MainAxisAlignment.center,
                                  crossAxisAlignment: CrossAxisAlignment.start,
                                  children: [
                                    Row(
                                      children: [
                                        Flexible(
                                          child: Tooltip(
                                            message: row.agent.displayName,
                                            child: Text(
                                              row.agent.displayName,
                                              maxLines: 1,
                                              overflow: TextOverflow.ellipsis,
                                              style: AppType.label(height: 1.3),
                                            ),
                                          ),
                                        ),
                                        if (attention != null && !busy)
                                          Padding(
                                            padding: const EdgeInsets.only(
                                              left: 12,
                                            ),
                                            child: Text(
                                              attention,
                                              style: AppType.monoMeta(
                                                color: AppPalette.textSecondary,
                                              ),
                                            ),
                                          ),
                                      ],
                                    ),
                                    const SizedBox(height: 6),
                                    Row(
                                      children: [
                                        detail(
                                          LucideIcons.monitor,
                                          row.machine.machine.displayName,
                                          AppPalette.textSecondary,
                                        ),
                                        if (row.project
                                            case final project?) ...[
                                          const SizedBox(width: 12),
                                          detail(
                                            LucideIcons.folder,
                                            project.label,
                                            const Color(0xff79bbaf),
                                            tooltip: project.cwd,
                                          ),
                                          if (project.shownBranch
                                              case final branch?) ...[
                                            const SizedBox(width: 12),
                                            detail(
                                              LucideIcons.gitBranch,
                                              branch,
                                              const Color(0xff8dbb79),
                                            ),
                                          ],
                                        ],
                                        const SizedBox(width: 12),
                                        detail(
                                          LucideIcons.clock3,
                                          harnessActivityAge(
                                            row.lastActiveAt,
                                            now,
                                          ),
                                          AppPalette.textSecondary,
                                          tooltip: row.lastActiveAt == null
                                              ? activity
                                              : 'Last active ${row.lastActiveAt!.toLocal()}',
                                        ),
                                      ],
                                    ),
                                    if (showQuestion)
                                      if (row.question
                                          case final question?) ...[
                                        const SizedBox(height: 6),
                                        Tooltip(
                                          message: question.prompt,
                                          child: Text(
                                            question.prompt.replaceAll(
                                              RegExp(r'\s+'),
                                              ' ',
                                            ),
                                            maxLines: 1,
                                            overflow: TextOverflow.ellipsis,
                                            style: AppType.monoMeta(
                                              color: _UnreadMark.waitingTint,
                                              height: 1.3,
                                            ),
                                          ),
                                        ),
                                      ],
                                  ],
                                ),
                              ),
                            ],
                          ),
                        ),
                      ),
                    ),
                  ),
                  const SizedBox(width: 8),
                  if (row.needsInput)
                    IconButton(
                      key: ValueKey('session-answer:${row.id}'),
                      tooltip: 'Needs input: ${row.question!.prompt}',
                      onPressed: canOpen ? onAnswer : null,
                      color: const Color(0xffd9ad70),
                      icon: Icon(
                        LucideIcons.messageCircleQuestionMark,
                        size: 17,
                        semanticLabel:
                            'Needs input for ${row.agent.displayName}',
                      ),
                    )
                  // The SAME SLOT, never both: a row is either waiting on a
                  // person or it is not, and the amber question already says
                  // the first case. This says the other one — work that is done
                  // and has not been looked at — in the one place the eye is
                  // already checking for a row's state.
                  else if (unread == AlertKind.done)
                    IconButton(
                      key: ValueKey('session-unread-done:${row.id}'),
                      tooltip: 'Finished',
                      onPressed: canOpen ? onOpen : null,
                      color: _UnreadMark.doneTint,
                      icon: Icon(
                        LucideIcons.circleCheckBig,
                        size: 17,
                        semanticLabel:
                            'Finished, not yet seen: ${row.agent.displayName}',
                      ),
                    ),
                  Tooltip(
                    message: busy
                        ? pendingLabel
                        : row.controlUnavailable ??
                              (row.agent.isStopped
                                  ? 'Resume harness'
                                  : 'Pause harness'),
                    child: SizedBox(
                      width: 40,
                      height: 40,
                      child: busy
                          ? Semantics(
                              liveRegion: true,
                              label: '$pendingLabel ${row.agent.displayName}',
                              child: Center(
                                child: SizedBox(
                                  width: 15,
                                  height: 15,
                                  child: CircularProgressIndicator(
                                    strokeWidth: 1.5,
                                    color: AppPalette.textSecondary,
                                  ),
                                ),
                              ),
                            )
                          : IconButton(
                              key: ValueKey('session-toggle:${row.id}'),
                              onPressed: row.canControl ? onToggle : null,
                              icon: Icon(
                                row.agent.isStopped
                                    ? LucideIcons.play
                                    : LucideIcons.pause,
                                size: 17,
                                semanticLabel:
                                    '${row.agent.isStopped ? 'Resume' : 'Pause'} ${row.agent.displayName}',
                              ),
                              style: IconButton.styleFrom(
                                foregroundColor: AppPalette.textPrimary,
                                disabledForegroundColor: AppPalette.textFaint
                                    .withValues(alpha: .4),
                              ),
                            ),
                    ),
                  ),
                  const SizedBox(width: 6),
                ],
              ),
            ),
            if (error != null)
              Padding(
                padding: const EdgeInsets.fromLTRB(46, 0, 12, 12),
                child: Semantics(
                  liveRegion: true,
                  child: Text(
                    error!,
                    style: AppType.body(color: const Color(0xffe4a19b)),
                  ),
                ),
              ),
          ],
        ),
      ),
    );
  }
}

/// The two tints an unread harness is drawn in.
///
/// Named here rather than written at each use, so this and the "needs input"
/// button beside it cannot drift into two different yellows.
///
/// There is no widget any more. A left-hand pip was tried and removed: the row
/// already had a place for its state — the amber question button on the right —
/// so a second marker beside the name said the same thing twice for a question,
/// while putting "finished" somewhere the eye was not looking. Both live in
/// that one slot now, and never both at once.
abstract final class _UnreadMark {
  /// Waiting on a person. The amber the question button has always used.
  static const waitingTint = Color(0xffd9ad70);

  /// Finished. Green because it is the one colour nobody reads as "act now",
  /// which is exactly the difference being drawn.
  static const doneTint = Color(0xff6fbf8b);
}
