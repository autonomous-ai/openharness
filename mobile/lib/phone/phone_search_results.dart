import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/widgets/empty_state.dart';
import 'package:harness_mobile/state/app_state.dart';

import 'agent_index.dart';
import 'phone_destination.dart';
import 'phone_navigation.dart';
import 'phone_search_commands.dart';
import 'phone_search_controller.dart';
import 'phone_search_rank.dart';
import 'phone_search_row.dart';
import 'resume_agent.dart';

/// What the query reaches, drawn.
///
/// ⚠️ Public because two screens draw it: [PhoneSearchPage], and the terminal's
/// own in-place search (see `terminal_search.dart`), which fades up over the
/// terminal rather than pushing a route. Both hand it one
/// [PhoneSearchController], so the two cannot return different rows — or walk a
/// different pager — for the same words.
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
  });

  final AppNotifier notifier;
  final PhoneSearchController controller;

  /// Called the moment a row is tapped, before anything opens.
  ///
  /// ⚠️ For the in-place search, which is not a route and so is not popped by
  /// opening something. Its field still holds the keyboard, and the terminal it
  /// is covering is about to be replaced underneath it — this is what puts the
  /// search away first. Null on [PhoneSearchPage], where the pop does it.
  final VoidCallback? onOpen;

  @override
  State<PhoneSearchResults> createState() => _PhoneSearchResultsState();
}

class _PhoneSearchResultsState extends State<PhoneSearchResults> {
  /// The row whose agent is being brought back, if any — see [_open].
  ///
  /// One at a time: the resume is a round trip to the machine, and a list that
  /// let a second tap start another would leave two agents restarting for one
  /// person who only meant to open one.
  String? _resuming;

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
    unawaited(notifier.reachAllMachines());
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
      final rows = search.rows;
      if (rows.isEmpty) return _empty(search);
      final terms = phoneSearchTerms(search.matchQuery);
      final now = DateTime.now();
      final previews = widget.notifier.sessionPreviews;
      return ListView.builder(
        // The keyboard is up and the finger is already on the glass; dragging
        // the list is how somebody reaches a result without putting it away
        // first.
        keyboardDismissBehavior: ScrollViewKeyboardDismissBehavior.onDrag,
        padding: EdgeInsets.fromLTRB(
          16,
          4,
          16,
          MediaQuery.paddingOf(context).bottom + 16,
        ),
        itemCount: rows.length,
        itemBuilder: (context, index) {
          final row = rows[index];
          return PhoneSearchRow(
            row: row,
            terms: terms,
            now: now,
            openable: search.canSubmit(row) && _resuming == null,
            resuming: _resuming == row.id,
            // A row that is here for something said in its conversation quotes
            // it in place of its detail: nothing else on the row would explain
            // why it matched.
            quote: phoneContentSnippet(row, terms, previews),
            onTap: () => _tap(row),
          );
        },
      );
    },
  );

  Widget _empty(PhoneSearchController search) {
    if (search.total == 0 && search.matchQuery.trim().isEmpty) {
      return const EmptyState(
        icon: LucideIcons.laptopMinimal300,
        title: 'Nothing to search yet',
        message: 'Link a machine and its harnesses will be findable from here.',
      );
    }
    return EmptyState.noMatches(
      compact: false,
      message: 'Nothing matches “${search.matchQuery.trim()}”.',
    );
  }

  /// A tap goes to the controller first, which absorbs the ones that only move
  /// the search: a `?` row taking its mode, a project or machine narrowing it.
  /// What comes back is something to actually open.
  void _tap(PhoneDestination row) {
    final opened = widget.controller.submit(row);
    if (opened == null) return;
    if (opened.isCommand) {
      widget.onOpen?.call();
      _run(opened);
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
      ScaffoldMessenger.maybeOf(
        context,
      )?.showSnackBar(SnackBar(content: Text(error)));
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
    for (final command in widget.controller.commands?.call() ??
        const <PhoneCommand>[]) {
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
