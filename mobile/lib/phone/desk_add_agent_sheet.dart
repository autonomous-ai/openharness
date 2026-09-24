import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/widgets/engine_identity.dart';

import 'agent_context_line.dart';
import 'agent_index.dart';
import 'phone_status.dart';
import 'status_pill.dart';

/// What joins a tab: an agent the account already has, or one made now.
///
/// ```
/// ──────────────────────────────────
///   New tab
///   ▭ Macbook Pro       2 harnesses
///  ┌──────────────────────────────┐
///  │ ✳ api-3                      │
///  │   ◌ Working…  ·  app ⑂ main  │
///  │   ────────────────────────── │
///  │ ✳ docs                       │
///  │   ● Claude Code  ·  site     │
///  └──────────────────────────────┘
/// ──────────────────────────────────
///  [         +  New Harness       ]
/// ```
///
/// ⚠️ **Grouped under a heading per machine, and the machine is not on the
/// rows.** A row that carried its machine at the end of the context line lost
/// it to the ellipsis first — `claude-2026-09-2…  ·  Macbook Pro - …` — which
/// is the one fact that tells two agents of the same folder apart. On the
/// heading it is written once, in full, and the row's second line goes to what
/// it is doing and where.
///
/// ⚠️ **"New Harness" is pinned under the list, not the first row of it.**
/// Both `+`s on the tabs panel land here, and the common move is to put
/// something already running into the tab — so the agents keep the scrolling
/// space, and making one is a button that is in the same place under the thumb
/// however far the list has been scrolled.
///
/// [choices] is what this sheet may offer: for a tab, the agents it does not
/// already hold. An empty list is drawn as a sentence rather than as a hole —
/// an account whose every agent is already in the tab has nothing to pick, and
/// the "New Harness" button under it still works.
///
/// [onCreate] is null where no machine can host one (all asleep, or wanting a
/// password), which leaves the button out rather than drawn dead.
Future<void> showDeskAddAgentSheet(
  BuildContext context, {
  required String title,
  required List<AgentEntry> choices,
  required void Function(AgentEntry entry) onPick,
  required VoidCallback? onCreate,
}) => showModalBottomSheet<void>(
  context: context,
  useRootNavigator: true,
  showDragHandle: true,
  backgroundColor: AppPalette.panelBg,
  isScrollControlled: true,
  builder: (sheetContext) => _AddAgentSheet(
    title: title,
    choices: choices,
    // Closed first, then acted on — the same order every row in the tabs panel
    // takes, so a terminal this opens never arrives under a sheet still on its
    // way out.
    onPick: (entry) {
      Navigator.of(sheetContext).pop();
      onPick(entry);
    },
    onCreate: onCreate == null
        ? null
        : () {
            Navigator.of(sheetContext).pop();
            onCreate();
          },
  ),
);

/// The rows' side inset: `phoneListPadding`'s 16, the measure the tabs panel
/// gives its own rows.
const double _sideInset = 16;

/// A row's inner padding, left and right.
const double _rowInset = 14;

/// The box the engine mark sits in, and the gap after it — together with
/// [_rowInset], where a row's text starts and so where the hairline between two
/// rows starts too.
const double _markBox = 22;
const double _markGap = 12;

/// "Working…" as ink on a row, not [phoneToneColor]'s busy tone.
///
/// That tone is [AppPalette.accent], which is made to be a FILL under white
/// text: on the dark row fill (#202020) it is 2.95:1 as a 12.5pt label, under
/// the 4.5:1 floor. Lightened in dark to 6.9:1, still the same indigo; light
/// keeps the accent, which already clears it there (5.0:1 on #F3F3F2).
Color get _busyInk => AppTheme.pick(AppPalette.accent, const Color(0xFF8AA4FF));

class _AddAgentSheet extends StatelessWidget {
  const _AddAgentSheet({
    required this.title,
    required this.choices,
    required this.onPick,
    required this.onCreate,
  });

  final String title;
  final List<AgentEntry> choices;
  final void Function(AgentEntry entry) onPick;
  final VoidCallback? onCreate;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final onCreate = this.onCreate;
    return SafeArea(
      child: Column(
        mainAxisSize: MainAxisSize.min,
        crossAxisAlignment: CrossAxisAlignment.stretch,
        children: [
          Padding(
            padding: const EdgeInsets.fromLTRB(_sideInset, 2, _sideInset, 14),
            child: Text(
              title,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: AppPalette.textPrimary,
                fontSize: 17,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          // One height, as the tabs panel keeps one, and for the same reason:
          // the sheet must not stand up and sit down as one account's three
          // agents give way to another's dozen.
          SizedBox(
            height: MediaQuery.sizeOf(context).height * 0.5,
            child: choices.isEmpty ? const _Empty() : _machineList(),
          ),
          if (onCreate != null) _NewHarnessBar(onTap: onCreate),
        ],
      ),
    );
  }

  Widget _machineList() {
    final groups = _byMachine(choices);
    return ListView(
      padding: const EdgeInsets.fromLTRB(_sideInset, 0, _sideInset, 16),
      children: [
        for (final (index, group) in groups.indexed) ...[
          if (index > 0) const SizedBox(height: 20),
          _MachineHeading(name: group.first.machineName, count: group.length),
          _MachineGroup(entries: group, onPick: onPick),
        ],
      ],
    );
  }
}

/// [entries] split by machine, the machines in the order their first agent
/// comes and each machine's agents in the order they came.
///
/// [choices] arrives in [visibleAgents] order — waiting, then working, then the
/// rest — so the machine with an agent waiting on the person heads the sheet,
/// and inside every group that same order still holds.
List<List<AgentEntry>> _byMachine(List<AgentEntry> entries) {
  final groups = <String, List<AgentEntry>>{};
  for (final entry in entries) {
    (groups[entry.machineId] ??= []).add(entry);
  }
  return groups.values.toList();
}

/// The line over one machine's agents: the machine, named in full, and how many
/// of its agents this sheet offers.
class _MachineHeading extends StatelessWidget {
  const _MachineHeading({required this.name, required this.count});

  final String name;
  final int count;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(4, 0, 4, 8),
      child: Row(
        children: [
          Icon(
            LucideIcons.laptopMinimal300,
            size: 15,
            color: AppPalette.textSecondary,
          ),
          const SizedBox(width: 8),
          Expanded(
            child: Text(
              name,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: TextStyle(
                color: AppPalette.textPrimary,
                fontSize: 13,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          const SizedBox(width: 8),
          Text(
            count == 1 ? '1 harness' : '$count harnesses',
            style: TextStyle(
              color: AppPalette.textSecondary,
              fontSize: 12.5,
              fontWeight: FontWeight.w500,
              fontFeatures: AppFont.tabularFigures,
            ),
          ),
        ],
      ),
    );
  }
}

/// One machine's agents as a single rounded group, a hairline between rows —
/// one object per machine rather than a card per agent, so the list reads as
/// machines holding agents.
class _MachineGroup extends StatelessWidget {
  const _MachineGroup({required this.entries, required this.onPick});

  final List<AgentEntry> entries;
  final void Function(AgentEntry entry) onPick;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final radius = BorderRadius.circular(AppCard.radius);
    return Container(
      clipBehavior: Clip.antiAlias,
      decoration: BoxDecoration(color: AppGlass.rowFill, borderRadius: radius),
      // The rim drawn OVER the rows, so a pressed row's fill runs to the
      // group's edge without covering it.
      foregroundDecoration: BoxDecoration(
        borderRadius: radius,
        border: Border.all(color: AppGlass.hair),
      ),
      child: Column(
        children: [
          for (final (index, entry) in entries.indexed) ...[
            if (index > 0)
              Padding(
                padding: const EdgeInsets.only(
                  left: _rowInset + _markBox + _markGap,
                ),
                child: Container(height: 1, color: AppPalette.divider),
              ),
            _AgentRow(entry: entry, onTap: () => onPick(entry)),
          ],
        ],
      ),
    );
  }
}

/// One agent: its engine, its name, and — on one line — what it is doing, the
/// folder and the branch. Its machine is the heading above it.
///
/// An agent with no terminal is drawn dimmed and does not open, as
/// `AgentTile` draws one — the tabs panel only offers agents that have one, so
/// this is the rule kept, not a state the sheet expects to show.
class _AgentRow extends StatefulWidget {
  const _AgentRow({required this.entry, required this.onTap});

  final AgentEntry entry;
  final VoidCallback onTap;

  @override
  State<_AgentRow> createState() => _AgentRowState();
}

class _AgentRowState extends State<_AgentRow> {
  bool _pressed = false;

  bool get _openable => widget.entry.agent.terminalAvailable;

  void _press(bool pressed) {
    if (!_openable || _pressed == pressed) return;
    setState(() => _pressed = pressed);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final agent = widget.entry.agent;
    return GestureDetector(
      behavior: HitTestBehavior.opaque,
      onTapDown: (_) => _press(true),
      onTapUp: (_) => _press(false),
      onTapCancel: () => _press(false),
      onTap: _openable ? widget.onTap : null,
      child: AnimatedContainer(
        duration: AppMotion.press,
        curve: AppMotion.curve,
        color: _pressed ? AppGlass.rowHoverFill : AppGlass.rowFill,
        padding: const EdgeInsets.symmetric(
          horizontal: _rowInset,
          vertical: 10,
        ),
        child: Opacity(
          opacity: _openable ? 1 : 0.55,
          child: Row(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              // Down a point, so the mark sits on the name's line rather than
              // above it.
              Padding(
                padding: const EdgeInsets.only(top: 1),
                child: SizedBox.square(
                  dimension: _markBox,
                  child: Center(
                    child: EngineMark(
                      engine: agent.engine,
                      displayName: agent.engineDisplayName,
                      size: 20,
                    ),
                  ),
                ),
              ),
              const SizedBox(width: _markGap),
              Expanded(
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  crossAxisAlignment: CrossAxisAlignment.start,
                  children: [
                    Text(
                      agent.displayName,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: TextStyle(
                        color: AppPalette.textPrimary,
                        fontSize: 15.5,
                        fontWeight: FontWeight.w600,
                      ),
                    ),
                    const SizedBox(height: 4),
                    _StatusLine(entry: widget.entry),
                  ],
                ),
              ),
            ],
          ),
        ),
      ),
    );
  }
}

/// `◌ Working…  ·  harness  ⑂ main` — the status first, then [AgentContextLine]
/// without its machine.
///
/// ⚠️ **The label keeps its width and the place gives way.** The label is one
/// of a few short words, and it is the part a glance at the sheet is for; the
/// folder and branch ellipsise inside what is left, the branch first — see
/// [AgentContextLine]. The label is still capped, so an engine with a long name
/// cannot push the place off the row entirely.
class _StatusLine extends StatelessWidget {
  const _StatusLine({required this.entry});

  final AgentEntry entry;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final summary = entry.summary;
    final project = entry.project;
    final (color, weight) = switch (summary.tone) {
      PhoneTone.busy => (_busyInk, FontWeight.w500),
      PhoneTone.attention => (AppPalette.warn, FontWeight.w600),
      PhoneTone.quiet => (AppPalette.textSecondary, FontWeight.w500),
      PhoneTone.good ||
      PhoneTone.bad => (phoneToneColor(summary.tone), FontWeight.w500),
    };
    return Row(
      children: [
        StatusDot(
          summary: summary,
          spinnerColor: summary.tone == PhoneTone.busy ? _busyInk : null,
        ),
        const SizedBox(width: 6),
        ConstrainedBox(
          constraints: const BoxConstraints(maxWidth: 150),
          child: Text(
            summary.label,
            maxLines: 1,
            overflow: TextOverflow.ellipsis,
            style: TextStyle(color: color, fontSize: 12.5, fontWeight: weight),
          ),
        ),
        if (project != null) ...[
          Text(
            '  ·  ',
            style: TextStyle(color: AppPalette.textFaint, fontSize: 12.5),
          ),
          Flexible(child: AgentContextLine(project: project)),
        ],
      ],
    );
  }
}

/// Nothing left to offer: every agent this phone can open is in the tab
/// already. Said in the list's own space, so the button under it stays where it
/// always is.
class _Empty extends StatelessWidget {
  const _Empty();

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return Padding(
      padding: const EdgeInsets.fromLTRB(_sideInset + 4, 8, _sideInset + 4, 0),
      child: Text(
        'Every harness this phone can open is already here.',
        style: TextStyle(color: AppPalette.textSecondary, fontSize: 13.5),
      ),
    );
  }
}

/// "New Harness", the sheet's one filled button — the app's primary action,
/// drawn as the form it opens draws "Create Harness": the same fill, radius and
/// 44pt height, so the two read as one flow.
class _NewHarnessBar extends StatelessWidget {
  const _NewHarnessBar({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return DecoratedBox(
      decoration: BoxDecoration(
        border: Border(top: BorderSide(color: AppPalette.divider)),
      ),
      child: Padding(
        padding: const EdgeInsets.fromLTRB(_sideInset, 12, _sideInset, 8),
        child: SizedBox(
          height: 44,
          child: FilledButton.icon(
            style: FilledButton.styleFrom(
              shape: RoundedRectangleBorder(
                borderRadius: BorderRadius.circular(AppCard.radius),
              ),
            ),
            onPressed: onTap,
            icon: const Icon(LucideIcons.plus, size: 18),
            label: const Text(
              'New Harness',
              style: TextStyle(fontSize: 15, fontWeight: FontWeight.w600),
            ),
          ),
        ),
      ),
    );
  }
}
