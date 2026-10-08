import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/core/last_opened_agent.dart' show AgentRef;
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/notify/agent_notice.dart' show NoticeKind;
import 'package:harness_mobile/state/app_state.dart';
import 'package:harness_mobile/state/external_session.dart';

import 'agent_index.dart';
import 'desk_groups.dart';
import 'desk_tab_filter_bar.dart';
import 'find_row.dart';
import 'fzf.dart' show fzfAge;
import 'phone_destination.dart';
import 'phone_navigation.dart';
import 'phone_search_catalog.dart' show phoneAgentId;
import 'phone_search_commands.dart';
import 'phone_search_controller.dart';
import 'phone_search_rank.dart';
import 'phone_status.dart';
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
    this.opening,
  });

  /// The sheet this list slides up in, while it does: the machines are reached once it is up
  /// rather than during the slide. Null — a page of its own — reaches after the first frame.
  final Animation<double>? opening;

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
    final shown = _narrowed(search.rows, _tab(_tabs(search)));
    final rows = search.matchQuery.trim().isEmpty && showing != null
        ? [
            for (final row in shown)
              if (!_isShowing(row, showing)) row,
          ]
        : shown;
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

  /// The desk tab the list is narrowed to; null is All. Only ever a choice: a tab closed on another
  /// computer while it was picked leaves the list on All ([_tab]) rather than on a filter nothing
  /// on screen names.
  String? _tabId;

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
    final sliding = widget.opening?.status;
    _rowsDue = sliding == null || sliding == AnimationStatus.completed;
    // ⚠️ **Opening the search is what re-reaches the fleet.** Until here the app
    // has only the machines that happened to answer at launch, and a machine the
    // account reported down was never even dialled. Asked on the way in, not
    // awaited: what is already known draws immediately, and each machine adds
    // its agents as it answers.
    //
    // ⚠️ After the frame, not in it: reaching can notify synchronously, and a notify while this
    // list is being mounted marks the page above it dirty mid-build.
    //
    // ⚠️ **And not while the sheet is still sliding up.** Reaching releases the launch's held
    // machines and dials every machine whose list is not current — a token, an end-to-end session
    // and a socket each, all on this thread — and every answer redraws. Started on the first
    // frame, that work landed in the middle of the slide, and the slide stuttered (frames of
    // 300–900ms measured in a debug build, 2026-10-05). The rows already on screen are the lists
    // the phone has; the reach only adds to them, a few hundred milliseconds later.
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      if (!_rowsDue) setState(() => _rowsDue = true);
      final opening = widget.opening;
      if (opening == null || opening.status == AnimationStatus.completed) {
        unawaited(notifier.reachAllMachines());
        return;
      }
      _opening = opening..addStatusListener(_reachOnceOpen);
    });
    // ⚠️ **No `agent_recent` reads from Find, not on open and not per row (owner, 2026-10-01).**
    // Each row used to ask for its session's last words as it was built, so opening Find — or
    // the app, which opens on it — put a read per visible session on the relay beside the
    // terminal being attached. What a session said is found by the machines' own index
    // (`session_search`, [PhoneSearchController.contentHitFor]); the store still answers from
    // the live events and from whatever the agents list read. See `AppNotifier.sessionPreviews`.
  }

  /// The sheet still sliding up, waited on before the machines are reached — see [initState].
  Animation<double>? _opening;

  /// False on the sheet's first frame alone, while it is on its way up: the rows are built on the
  /// next one.
  ///
  /// ⚠️ **One frame carried the sheet, its field and a screen of rows at once** — 16–23ms, a
  /// dropped frame on every opening, most of it the rows being built and their text laid out
  /// (measured on a phone, 2026-10-05). On that first frame the sheet has barely left the
  /// screen's edge, so the list arriving a frame later is not something anyone sees.
  bool _rowsDue = true;

  /// Only `completed` ends the wait: a sheet dragged by a finger passes through every other
  /// status on its way up, and one closed again before it was up takes this list — and the
  /// listener, in [dispose] — down with it.
  void _reachOnceOpen(AnimationStatus status) {
    if (status != AnimationStatus.completed) return;
    _stopWaiting();
    if (mounted) unawaited(widget.notifier.reachAllMachines());
  }

  void _stopWaiting() {
    _opening?.removeStatusListener(_reachOnceOpen);
    _opening = null;
  }

  @override
  void dispose() {
    _stopWaiting();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: _changes,
    builder: (context, _) {
      AppTheme.watch(context);
      final search = widget.controller;
      final all = search.rows;
      final tabs = _tabs(search);
      final tab = _tab(tabs);
      return Column(
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          // Under the field, and only over the plain list of harnesses: a mode lists commands,
          // models or places, none of which is on a tab.
          if (tabs.isNotEmpty)
            DeskTabFilterBar(
              choices: [
                DeskTabFilterChoice(
                  id: null,
                  name: 'All',
                  count: _sessions(all),
                ),
                for (final each in tabs)
                  DeskTabFilterChoice(
                    id: each.id,
                    name: each.name,
                    count: all.where((row) => _inTab(each, row)).length,
                  ),
              ],
              selected: tab?.id,
              onSelected: (id) => setState(() => _tabId = id),
            ),
          Expanded(
            child: _rowsDue
                ? _find(
                    search,
                    _narrowed(all, tab),
                    tab: tab,
                    everywhere: _sessions(all),
                  )
                : const SizedBox.shrink(),
          ),
        ],
      );
    },
  );

  /// Whether this is Find's plain list of harnesses — no mode (`>`, `?`, a group, `:`) and not
  /// walked into one project or machine. The only list the tab chips narrow.
  static bool _plain(PhoneSearchController search) =>
      !search.isCommandMode &&
      !search.isHelpMode &&
      !search.isGroupMode &&
      !search.isModelMode &&
      !search.canGoBack;

  /// The desk's tabs as the chips offer them: none off the plain list, and none where the desk has
  /// no tabs or has not answered — and then no chips are drawn at all.
  List<DeskTabFilter> _tabs(PhoneSearchController search) =>
      _plain(search) ? deskTabFilters(widget.notifier) : const [];

  /// The picked tab among [tabs]; null is All.
  DeskTabFilter? _tab(List<DeskTabFilter> tabs) =>
      tabs.where((tab) => tab.id == _tabId).firstOrNull;

  static bool _inTab(DeskTabFilter tab, PhoneDestination row) {
    final entry = row.entry;
    return entry != null && tab.holds(entry);
  }

  /// [rows] narrowed to [tab] — to harnesses only, since a tab holds nothing else: a machine, a
  /// project, a conversation Harness did not start are on no tab.
  static List<PhoneDestination> _narrowed(
    List<PhoneDestination> rows,
    DeskTabFilter? tab,
  ) => tab == null
      ? rows
      : [
          for (final row in rows)
            if (_inTab(tab, row)) row,
        ];

  /// The sessions among [rows] — harnesses and the conversations Harness did not start — which is
  /// what All's chip counts.
  static int _sessions(List<PhoneDestination> rows) =>
      rows.where((row) => row.isAgent || row.external != null).length;

  /// Find's list: grows down from the field at the top. With nothing typed, `needs you` (newest
  /// question first) then `recent`, the harness on screen last, `+ New Harness` at the end; typed,
  /// the matches in their order, then the commands that match, then `+ New Harness in <project>`.
  /// See docs/plans/2026-09-26-003-mobile-find-new-spec.md.
  Widget _find(
    PhoneSearchController search,
    List<PhoneDestination> rows, {
    required DeskTabFilter? tab,
    required int everywhere,
  }) {
    // The words, less any time ("dial last week" lights "dial").
    final terms = phoneSearchTerms(search.wordsQuery);
    final showing = widget.showing;
    final now = DateTime.now();
    final tty = Tty.of(context);
    final typed = search.matchQuery.trim().isNotEmpty;
    final plain = _plain(search);
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
    // ⚠️ **Built as they scroll in, not all at once.** Each entry makes its widget only when the
    // list asks for it, so a hundred sessions cost the rows in view: their state words and their
    // lit matches. An eager list did that for every row on every rebuild, and this screen rebuilds
    // on every preview the store publishes.
    final items = <Widget Function()>[];
    // Where each session's entry is, so a row keeps its own element when the ranking moves it.
    final rowAt = <String, int>{};
    var index = 0;
    void row(PhoneDestination row) {
      final selected = index++ == selectedAt;
      rowAt[row.id] = items.length;
      items.add(() => _session(row, terms, now, tty, selected: selected));
    }

    if (needsYou.isNotEmpty) {
      items.add(() => FindHeader('needs you', color: tty.yellow));
      needsYou.forEach(row);
      items.add(() => const FindHeader('recent'));
    }
    rest.forEach(row);
    if (current != null) row(current);
    // At the end and without a heading: each one's own word on the right says `paused`.
    pausedRows.forEach(row);
    if (ordered.isEmpty) {
      items.add(
        () => Padding(
          padding: const EdgeInsets.fromLTRB(Tty.origin, 20, Tty.origin, 8),
          child: TtyText(
            switch (tab) {
              null =>
                search.total == 0 && !typed
                    ? 'No harnesses running.'
                    : 'No match.',
              _ when typed => 'No match in ${tab.name}.',
              _ when tab.isEmpty => 'No harnesses in ${tab.name} yet.',
              _ => 'Nothing in ${tab.name} can be reached right now.',
            },
            color: tty.faint,
            size: TtySize.row,
          ),
        ),
      );
      // The way out of an empty tab, where the eye already is — rather than back up at a chip the
      // rail may have scrolled away.
      if (tab != null && (!typed || everywhere > 0)) {
        items.add(
          () => FindRow(
            title: 'Show all tabs',
            detail: typed
                ? '$everywhere ${everywhere == 1 ? 'match' : 'matches'} in all tabs'
                : null,
            onTap: () => setState(() => _tabId = null),
          ),
        );
      }
    }
    if (search.commandMatches.isNotEmpty) {
      items.add(() => const FindHeader('commands'));
      for (final command in search.commandMatches) {
        items.add(
          () => FindRow(
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
      items.add(() => const SizedBox(height: 8));
      items.add(
        () => FindAddRow(
          label: place == null
              ? 'New Harness'
              : 'New Harness in ${project!.title}',
          detail: place?.label,
          onTap: () => newHarness(place),
        ),
      );
    }
    items.add(() => const SizedBox(height: 24));
    return ListView.builder(
      // ⚠️ **A scroll keeps the keyboard.** Scrolling is looking through what the query found, not
      // done with the query — put away on every drag, the next letter meant tapping the field
      // again. A row picked ([_tap]) or the return key is what puts the keys away.
      keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.manual,
      padding: EdgeInsets.zero,
      itemCount: items.length,
      itemBuilder: (context, i) => items[i](),
      findChildIndexCallback: (key) =>
          key is ValueKey<String> ? rowAt[key.value] : null,
    );
  }

  /// One session's entry in the list: its row.
  ///
  /// ⚠️ **No recap under it any more (owner, 2026-09-30),** and no read of what the session last
  /// said either (2026-10-01) — see the note at the end of [initState].
  ///
  /// Keyed by the row's id — what [ListView.builder]'s `findChildIndexCallback` looks it up by — so
  /// the row keeps its element when a match moves it up the list.
  Widget _session(
    PhoneDestination row,
    List<String> terms,
    DateTime now,
    Tty tty, {
    required bool selected,
  }) {
    return KeyedSubtree(
      key: ValueKey(row.id),
      child: _findRow(row, terms, now, tty, selected: selected),
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
        tail: external.engineLabel,
        // Beside the state, as a harness row's age is.
        stateTail: fzfAge(row.lastAt, now),
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
      final machine = row.isMachine ? _machineStateOf(row, tty) : null;
      return FindRow(
        title: row.title,
        detail: row.detail,
        // A locked machine's line is the one thing on it to act on.
        detailColor: (machine?.asks ?? false) ? tty.text : null,
        state: machine?.word,
        stateColor: machine?.color,
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
      // `M2:site ⑂ docs-v2` — or, while it asks, its question.
      detail: asking
          ? '"${question.split('\n').first}"'
          : '${entry.machineName}:${entry.agent.displayProject?.label ?? entry.project?.name ?? ''}',
      branch: asking || branch == null || branch.isEmpty ? null : branch,
      detailColor: question != null && entry.isWaiting ? tty.text : null,
      state: state.word,
      stateColor: state.color,
      // `idle · 2m` on line 1, where a long folder and branch on line 2 cannot cut the age off.
      stateTail: asking
          ? null
          : onScreen
          ? 'current'
          : fzfAge(entry.agent.updatedAt, now),
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

  /// A machine's word at the right edge, in a harness row's colours: green for one that answers,
  /// yellow for one that needs something from the person, faint for the rest. Read off the
  /// machine live, like the harness rows' words; the line under it comes with the catalog, which
  /// rebuilds on the same changes (`PhoneSearchCatalogCache`). Null for a row without its machine.
  ({String word, Color color, bool asks})? _machineStateOf(
    PhoneDestination row,
    Tty tty,
  ) {
    final machine = row.machine;
    if (machine == null) return null;
    return switch (phoneMachineStatusOf(machine)) {
      PhoneMachineStatus.ready => (
        word: 'online',
        color: tty.green,
        asks: false,
      ),
      PhoneMachineStatus.needsPassword => (
        word: 'locked',
        color: tty.yellow,
        asks: true,
      ),
      PhoneMachineStatus.connecting => (
        word: 'connecting',
        color: tty.faint,
        asks: false,
      ),
      PhoneMachineStatus.offline => (
        word: 'offline',
        color: tty.faint,
        asks: false,
      ),
    };
  }

  /// The word at a harness row's right edge, or null for an idle one.
  ///
  /// ⚠️ **Idle says nothing (owner, 2026-09-30).** It is what a harness is when none of the words
  /// above apply — most of the list, most of the time — so `idle` stood on nearly every row and
  /// said nothing any of them needed saying, while the words that DO ask for something (`asking`,
  /// `done`, `exited`) were lost among them. The row keeps its age (`1h`) in that place.
  ({String? word, Color color}) _stateOf(
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
    return (word: null, color: tty.faint);
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
    final search = widget.controller;
    final tab = _tab(_tabs(search));
    // ⚠️ **The tab picked here is the tab Home opens in (owner, 2026-10-01).** The chips narrowed
    // this list to one tab, and the session tapped is that tab's — but Home chose its tab on its
    // own, from the tab the phone was last in ([activeDeskGroup]), so a session that sits in two
    // tabs opened in the other one, and the swipe then walked that tab's panes rather than the ones
    // just looked at. Selected before the open, so the pager is built in it. Only for a session the
    // tab holds, and never on All: there the phone's own last tab still decides.
    if (tab != null && tab.holds(entry)) {
      widget.notifier.selectDeskTab(tab.id);
    }
    openAgentPager(
      context,
      widget.notifier,
      phoneSearchAgentEntries(_narrowed(search.rows, tab)),
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
