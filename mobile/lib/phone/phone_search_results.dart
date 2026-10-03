import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/notify/agent_notice.dart' show NoticeKind;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/external_session.dart';

import 'agent_index.dart';
import 'find_row.dart';
import 'fzf.dart' show fzfAge;
import 'phone_destination.dart';
import 'phone_navigation.dart';
import 'phone_search_catalog.dart' show phoneAgentId;
import 'phone_search_commands.dart';
import 'phone_search_controller.dart';
import 'phone_search_rank.dart';
import 'resume_agent.dart';
import 'search_result_text.dart'
    show phoneResultMatches, snippetLead, snippetRuns;
import 'tty.dart';
import 'tty_controls.dart';

/// What the query reaches, drawn.
///
/// ⚠️ Public because two screens draw it: Find, the terminal's own in-place
/// search (see `terminal_search.dart`), which slides over the terminal rather
/// than pushing a route, and the first screen after pairing
/// (`welcome/pick_up_page.dart`). Both hand it one [PhoneSearchController], so
/// the two cannot return different rows — or walk a different pager — for the
/// same words.
///
/// ⚠️ **One flat ranked list, no folder headers.** The desktop has none either,
/// and grouping fought the ranking it sat on: a folder whose best row was third
/// dragged its other two up past better matches, and a header over every
/// single-agent folder halved how many rows fit on a phone. Each row names its
/// own project and machine instead, which is what the desktop's detail line is.
///
/// Opening it also re-reaches every machine on the account
/// ([AppNotifier.reachAllMachines]), so the one screen that claims to search
/// every agent stops quietly missing whole machines of them.
class PhoneSearchResults extends StatefulWidget {
  const PhoneSearchResults({
    super.key,
    required this.notifier,
    required this.controller,
    this.onOpen,
    this.showing,
    this.onNewHarness,
  });

  /// Find's `+ New Harness` row — with a project's machine and folder when the query matched one
  /// (`+ New Harness in api`). Null leaves the row out.
  final void Function(({String machineId, String folder, String label})? place)?
  onNewHarness;

  final AppNotifier notifier;
  final PhoneSearchController controller;

  /// Called the moment a row is tapped, before anything opens.
  ///
  /// ⚠️ For the in-place search, which is not a route and so is not popped by
  /// opening something. Its field still holds the keyboard, and the terminal it
  /// is covering is about to be replaced underneath it — this is what puts the
  /// search away first. Null on the pick-up page, which is a route of its own.
  final VoidCallback? onOpen;

  /// The agent Find was opened over: its row says `current`, sits after the recent ones, and a
  /// tap on it is Cancel.
  final AgentRef? showing;

  @override
  State<PhoneSearchResults> createState() => PhoneSearchResultsState();
}

class PhoneSearchResultsState extends State<PhoneSearchResults> {
  /// Opens the first row a tap could open — Enter in the desktop's ⌘P, the return key here.
  void openFirst() {
    final search = widget.controller;
    final showing = widget.showing;
    final rows = search.matchQuery.trim().isEmpty && showing != null
        ? [
            for (final row in search.rows)
              if (!_isShowing(row, showing)) row,
          ]
        : search.rows;
    for (final row in rows) {
      if (search.canSubmit(row)) {
        _tap(row);
        return;
      }
    }
  }

  /// The row whose agent is being brought back, if any — see [_open].
  ///
  /// One at a time: the resume is a round trip to the machine, and a list that
  /// let a second tap start another would leave two agents restarting for one
  /// person who only meant to open one.
  String? _resuming;

  /// The order Find opened with — each row's section (needs you, recent, the one on screen,
  /// paused) and place in it, by id. Held while Find is open: a harness that starts or stops
  /// asking, pauses, or does something new keeps its place and only its words change, so the row
  /// under your finger is the row you meant. Rows that arrive later — a machine answering —
  /// join the end of their section. Null until the first rows are drawn.
  Map<String, (int, int)>? _openedOrder;

  /// ⚠️ **Three sources, and they answer different questions.**
  ///
  /// The controller says WHICH rows and in what order. The other two are what
  /// the rows SAY: `working` replacing an age, a quote appearing as its preview
  /// lands, an attention rim as an agent stops to ask something. The controller
  /// deliberately stays quiet through all of that — its catalog is cached, and a
  /// turn event changes no row's place — so without these the list would hold a
  /// minutes-old age while the terminal behind it streamed.
  late final Listenable _changes = Listenable.merge([
    widget.controller,
    widget.notifier,
    widget.notifier.sessionPreviews,
  ]);

  @override
  void initState() {
    super.initState();
    final notifier = widget.notifier;
    // ⚠️ **Opening the search is what re-reaches the fleet.** Until here the app
    // has only the machines that happened to answer at launch, and a machine the
    // account reported down was never even dialled. Asked on the way in, not
    // awaited: what is already known draws immediately, and each machine adds
    // its agents as it answers.
    //
    // ⚠️ After the frame, not in it: reaching can notify synchronously, and a notify while this
    // list is being mounted marks the page above it dirty mid-build.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (mounted) unawaited(notifier.reachAllMachines());
    });
    notifier.sessionPreviews.warm([
      for (final entry in recentAgents(agentIndex(notifier)))
        notifier.previewKey(entry.machineId, entry.agent),
    ], prioritize: true);
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _changes,
    builder: (context, _) {
      AppTheme.watch(context);
      final search = widget.controller;
      return _find(search, search.rows);
    },
  );

  /// Find's list: grows down from the field at the top. With nothing typed, `needs you` (newest
  /// question first) then `recent`, the harness on screen last, `+ New Harness` at the end; typed,
  /// the matches in their order, then the commands that match, then `+ New Harness in <project>`.
  /// See docs/plans/2026-09-26-003-mobile-find-new-spec.md.
  Widget _find(PhoneSearchController search, List<PhoneDestination> rows) {
    // The words, less any time ("dial last week" lights "dial").
    final terms = phoneSearchTerms(search.wordsQuery);
    final showing = widget.showing;
    final now = DateTime.now();
    final tty = Tty.of(context);
    final typed = search.matchQuery.trim().isNotEmpty;
    final plain =
        !search.isCommandMode &&
        !search.isHelpMode &&
        !search.isGroupMode &&
        !search.isModelMode &&
        !search.canGoBack;
    bool asking(PhoneDestination row) => row.entry?.isWaiting ?? false;
    DateTime since(PhoneDestination row) {
      final entry = row.entry;
      return entry?.machine.blockedAgents[entry.agent.id]?.since ??
          DateTime.fromMillisecondsSinceEpoch(0);
    }

    // Paused work has its own place at the end: last used lately, it is still not what is running.
    bool paused(PhoneDestination row) => row.entry?.agent.isStopped ?? false;
    List<PhoneDestination> needsYou;
    List<PhoneDestination> rest;
    var pausedRows = const <PhoneDestination>[];
    PhoneDestination? current;
    if (!typed && plain) {
      current = showing == null
          ? null
          : rows.where((row) => _isShowing(row, showing)).firstOrNull;
      needsYou = [
        for (final row in rows)
          if (asking(row) && row != current) row,
      ]..sort((a, b) => since(b).compareTo(since(a)));
      rest = [
        for (final row in rows)
          if (!asking(row) && row != current && !paused(row)) row,
      ];
      pausedRows = [
        for (final row in rows)
          if (!asking(row) && row != current && paused(row)) row,
      ];
    } else {
      current = null;
      needsYou = const [];
      rest = rows;
    }
    if (!typed && plain) {
      final frozen = _openedOrder ??= rows.isEmpty
          ? null
          : {
              for (final (i, row) in needsYou.indexed) row.id: (0, i),
              for (final (i, row) in rest.indexed) row.id: (1, i),
              if (current != null) current.id: (2, 0),
              for (final (i, row) in pausedRows.indexed) row.id: (3, i),
            };
      if (frozen != null) {
        // Back into the sections they opened in, in the order they opened in; newcomers after.
        final live = [
          for (final (i, row) in needsYou.indexed) (row, 0, i),
          for (final (i, row) in rest.indexed) (row, 1, i),
          if (current != null) (current, 2, 0),
          for (final (i, row) in pausedRows.indexed) (row, 3, i),
        ];
        final sections = List.generate(4, (_) => <(PhoneDestination, int)>[]);
        for (final (row, section, i) in live) {
          final (at, place) = frozen[row.id] ?? (section, 1 << 20 | i);
          sections[at].add((row, place));
        }
        for (final section in sections) {
          section.sort((a, b) => a.$2.compareTo(b.$2));
        }
        needsYou = [for (final (row, _) in sections[0]) row];
        rest = [for (final (row, _) in sections[1]) row];
        current = sections[2].firstOrNull?.$1;
        pausedRows = [for (final (row, _) in sections[3]) row];
      }
    }
    final ordered = [...needsYou, ...rest, ?current, ...pausedRows];
    final selectedAt = typed ? ordered.indexWhere(search.canSubmit) : -1;
    final newHarness = widget.onNewHarness;
    final project = search.projectMatch;
    final children = <Widget>[];
    var index = 0;
    Widget row(PhoneDestination row) =>
        _findRow(row, terms, now, tty, selected: index++ == selectedAt);
    if (needsYou.isNotEmpty) {
      children.add(FindHeader('needs you', color: tty.yellow));
      children.addAll(needsYou.map(row));
      children.add(const FindHeader('recent'));
    }
    children.addAll(rest.map(row));
    if (current != null) children.add(row(current));
    // At the end and without a heading: each one's own word on the right says `paused`.
    children.addAll(pausedRows.map(row));
    if (ordered.isEmpty) {
      children.add(
        Padding(
          padding: const EdgeInsets.fromLTRB(Tty.origin, 20, Tty.origin, 8),
          child: TtyText(
            search.total == 0 && !typed ? 'No harnesses running.' : 'No match.',
            color: tty.faint,
            size: TtySize.row,
          ),
        ),
      );
    }
    if (search.commandMatches.isNotEmpty) {
      children.add(const FindHeader('commands'));
      for (final command in search.commandMatches) {
        children.add(
          FindRow(
            title: command.title,
            terms: terms,
            state: command.shortcut,
            onTap: () => _tap(command),
          ),
        );
      }
    }
    if (newHarness != null && plain) {
      final place = project == null ? null : _projectPlace(project);
      children.add(const SizedBox(height: 8));
      children.add(
        FindAddRow(
          label: place == null
              ? 'New Harness'
              : 'New Harness in ${project!.title}',
          detail: place?.label,
          onTap: () => newHarness(place),
        ),
      );
    }
    children.add(const SizedBox(height: 24));
    return ListView(
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
      padding: EdgeInsets.zero,
      children: children,
    );
  }

  /// One harness (or command) as a Find row — see [FindRow].
  Widget _findRow(
    PhoneDestination row,
    List<String> terms,
    DateTime now,
    Tty tty, {
    required bool selected,
  }) {
    final entry = row.entry;
    final openable = widget.controller.canSubmit(row);
    final showing = widget.showing;
    final onScreen = showing != null && _isShowing(row, showing);
    // A conversation Harness did not start: where it was said, and `resume` — or, open in a
    // terminal or app elsewhere, that instead, and no tap.
    if (row.external case final external?) {
      final hit = widget.controller.contentHitFor(row.id);
      return FindRow(
        title: row.title,
        detail: row.detail,
        branch: null,
        tail: [
          external.engineLabel,
          if (row.lastAt case final at?) fzfAge(at, now),
        ].join(' · '),
        said: hit == null || hit.snippet.isEmpty || hit.field == 'name'
            ? null
            : (lead: snippetLead(hit.field), runs: snippetRuns(hit.snippet)),
        state: _resuming == row.id
            ? 'opening…'
            : external.open
            ? 'open in ${external.originLabel}'
            : 'resume',
        stateColor: external.open ? tty.faint : tty.text,
        terms: terms,
        selected: selected,
        enabled: openable || _resuming == row.id,
        onTap: _resuming != null ? null : () => _tap(row),
      );
    }
    if (entry == null) {
      return FindRow(
        title: row.title,
        detail: row.detail,
        terms: terms,
        selected: selected,
        enabled: openable,
        onTap: () => _tap(row),
      );
    }
    final question = entry.machine.blockedAgents[entry.agent.id]?.prompt.trim();
    final state = _stateOf(entry, openable, tty, resuming: _resuming == row.id);
    final asking = question != null && question.isNotEmpty && entry.isWaiting;
    final branch = entry.agent.displayProject?.branch;
    // Found in what was said rather than in its own name and place: the second line shows where
    // — the desktop Cmd-P's rule.
    final hit = widget.controller.contentHitFor(row.id);
    final said =
        hit != null &&
            hit.snippet.isNotEmpty &&
            hit.field != 'name' &&
            (terms.isEmpty ||
                phoneResultMatches(row, terms).length <
                    terms.take(12).toSet().length)
        ? (lead: snippetLead(hit.field), runs: snippetRuns(hit.snippet))
        : null;
    return FindRow(
      title: row.title,
      strict: true,
      said: said,
      // `M2:site ⑂ docs-v2 · 2m` — or, while it asks, its question.
      detail: asking
          ? '"${question.split('\n').first}"'
          : '${entry.machineName}:${entry.agent.displayProject?.label ?? entry.project?.name ?? ''}',
      branch: asking || branch == null || branch.isEmpty ? null : branch,
      tail: asking
          ? null
          : onScreen
          ? 'current'
          : fzfAge(entry.agent.updatedAt, now),
      detailColor: question != null && entry.isWaiting ? tty.text : null,
      state: state.word,
      stateColor: state.color,
      terms: terms,
      selected: selected,
      enabled: openable || _resuming == row.id,
      // The harness on screen is where Cancel goes: a tap on it is Cancel.
      onTap: _resuming != null
          ? null
          : onScreen
          ? widget.onOpen
          : () => _tap(row),
    );
  }

  ({String word, Color color}) _stateOf(
    AgentEntry entry,
    bool openable,
    Tty tty, {
    required bool resuming,
  }) {
    if (resuming) return (word: 'resuming', color: tty.faint);
    if (entry.isWaiting) return (word: 'asking', color: tty.yellow);
    if (entry.agent.isStopped) {
      return (word: openable ? 'paused' : 'stopped', color: tty.faint);
    }
    if (!openable) return (word: 'exited', color: tty.red);
    if (entry.isWorking) return (word: 'working', color: tty.green);
    final unread = widget.notifier.agentNotices.unread.kindFor((
      machineId: entry.machineId,
      agentId: entry.agent.id,
    ));
    if (unread == NoticeKind.done) return (word: 'done', color: tty.faint);
    return (word: 'idle', color: tty.faint);
  }

  /// Where a project lives, for `+ New Harness in <project>`: its machine and folder, read from the
  /// first harness in it.
  ({String machineId, String folder, String label})? _projectPlace(
    PhoneDestination project,
  ) {
    for (final entry in agentIndex(widget.notifier)) {
      if (!project.members.contains(
        phoneAgentId(entry.machineId, entry.agent.id),
      )) {
        continue;
      }
      final cwd = entry.agent.displayProject?.cwd ?? entry.project?.cwd;
      if (cwd == null || cwd.isEmpty) continue;
      return (
        machineId: entry.machineId,
        folder: cwd,
        label:
            '${entry.machineName}:${entry.agent.displayProject?.label ?? project.title}',
      );
    }
    return null;
  }

  static bool _isShowing(PhoneDestination row, AgentRef showing) =>
      row.entry?.machineId == showing.machineId &&
      row.entry?.agent.id == showing.agentId;

  /// A tap goes to the controller first, which absorbs the ones that only move
  /// the search: a `?` row taking its mode, a project or machine narrowing it.
  /// What comes back is something to actually open.
  void _tap(PhoneDestination row) {
    final opened = widget.controller.submit(row);
    if (opened == null) return;
    // The keyboard goes away with the search, not a frame after it —
    // dismissing it first keeps what opens from animating over a collapsing
    // inset. Only here, past the controller: a tap it absorbed is still a
    // search in progress, and the keyboard stays up for the rest of it.
    FocusManager.instance.primaryFocus?.unfocus();
    if (opened.isCommand) {
      widget.onOpen?.call();
      _run(opened);
      return;
    }
    if (opened.external case final external?) {
      unawaited(_resumeExternal(opened, external));
      return;
    }
    final entry = opened.entry;
    if (entry == null) return;
    if (entry.agent.isStopped) {
      unawaited(_resumeThenOpen(opened.id, entry));
      return;
    }
    _openAgent(entry);
  }

  /// A conversation Harness did not start, opened as a new harness that resumes it in its own
  /// folder (`claude --resume`, `codex resume`), then its terminal. The machine refuses one open
  /// elsewhere or already a harness, and the reason is said.
  Future<void> _resumeExternal(
    PhoneDestination row,
    ExternalSessionRef external,
  ) async {
    final machineId = row.machineId;
    if (machineId == null) return;
    setState(() => _resuming = row.id);
    final attempt = AgentCreationAttempt();
    final error = await widget.notifier.resumeConversation(
      machineId,
      engine: external.engine,
      folder: external.cwd,
      sessionId: external.sessionId,
      name: external.title.isEmpty ? null : external.title,
      attempt: attempt,
    );
    if (!mounted) return;
    setState(() => _resuming = null);
    final agentId = attempt.agentId;
    if (error != null || agentId == null) {
      ScaffoldMessenger.maybeOf(context)?.showSnackBar(
        SnackBar(content: Text(error ?? 'Could not open that conversation.')),
      );
      return;
    }
    widget.onOpen?.call();
    openAgent(context, widget.notifier, machineId, agentId);
  }

  /// Bring a stopped agent back, then open it — the desktop's
  /// `_resumeStoppedDestination` followed by its activation.
  ///
  /// ⚠️ **Awaited before the terminal is pushed, not alongside it.** A stopped
  /// agent has no terminal to attach to, so opening first would land on a screen
  /// with nothing on it and no reason given. The row says `Stopped`, then spins,
  /// then the terminal arrives.
  Future<void> _resumeThenOpen(String id, AgentEntry entry) async {
    setState(() => _resuming = id);
    final error = await resumeAgentForOpen(widget.notifier, entry);
    if (!mounted) return;
    setState(() => _resuming = null);
    if (error != null) {
      ScaffoldMessenger.maybeOf(context)
          ?.showSnackBar(SnackBar(content: Text(error)));
      return;
    }
    // ⚠️ Re-read from the catalog rather than reusing `entry`. The resume
    // replaced the agent in its machine's list (`_upsertAgent`), so the entry
    // captured before the await names a terminal that is still the old one.
    final resumed = widget.controller.rows
        .where((row) => row.id == id)
        .firstOrNull
        ?.entry;
    _openAgent(resumed ?? entry);
  }

  void _openAgent(AgentEntry entry) {
    widget.onOpen?.call();
    // The neighbours are the rows as drawn, not the Agents tab's list: swiping
    // walks exactly what the query returned, in the order the person was
    // looking at when they tapped.
    openAgentPager(
      context,
      widget.notifier,
      phoneSearchAgentEntries(widget.controller.rows),
      entry,
    );
  }

  void _run(PhoneDestination row) {
    final id = row.commandId;
    if (id == null) return;
    for (final command
        in widget.controller.commands?.call() ?? const <PhoneCommand>[]) {
      if (command.id != id) continue;
      unawaited(Future.sync(command.run));
      return;
    }
  }
}

/// The agent rows among [rows], in the order they are drawn — what a pager
/// opened from one of them swipes along.
///
/// ⚠️ **One entry out, one agent row in.** [PhoneDestination.entry] is null on
/// every other kind, so unwrapping it at the call site invites a null-collapse
/// that quietly drops a row. The pager walks this list BY INDEX against the rows
/// on screen: a list one shorter than the one somebody tapped sends the next
/// swipe to a different agent than the one beside it.
List<AgentEntry> phoneSearchAgentEntries(List<PhoneDestination> rows) => [
  for (final row in rows)
    if (row.isAgent && row.entry != null) row.entry!,
];
