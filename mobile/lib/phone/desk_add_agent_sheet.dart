import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'agent_index.dart';
import 'agent_tile.dart';
import 'phone_card.dart';

/// What joins a tab: an agent the account already has, or one made now.
///
/// ```
/// ──────────────────────────────────
///   Add to “harness mobile”
///  ┌────────────────────────────┐
///  │ ＋  New agent              │
///  └────────────────────────────┘
///  ┌────────────────────────────┐
///  │ ◆  api-3        Live     › │
///  └────────────────────────────┘
/// ```
///
/// ⚠️ **The agents come first and "New agent" sits above them, rather than the
/// two being a choice made before either is seen.** Both `+`s on the tabs panel
/// land here, and in both cases the common move is to put something that is
/// already running somewhere else — a person who wants a NEW agent is one tap
/// from the form they would have opened anyway, and one who wants an existing
/// one is looking at it.
///
/// [choices] is what this sheet may offer: for a tab, the agents it does not
/// already hold. An empty list is drawn as a sentence rather than as a hole —
/// an account whose every agent is already in the tab has nothing to pick, and
/// the "New agent" row above still works.
///
/// [onCreate] is null where no machine can host one (all asleep, or wanting a
/// password), which leaves that row out rather than drawn dead.
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

/// The rows' side inset: [phoneListPadding]'s 16, the measure the tabs panel
/// gives its own rows.
const double _sideInset = 16;

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
            padding: const EdgeInsets.fromLTRB(_sideInset, 2, _sideInset, 12),
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
            child: ListView.separated(
              padding: EdgeInsets.fromLTRB(
                _sideInset,
                0,
                _sideInset,
                MediaQuery.paddingOf(context).bottom + 8,
              ),
              itemCount: choices.length + (onCreate == null ? 0 : 1),
              separatorBuilder: (context, index) =>
                  const SizedBox(height: kPhoneCardGap),
              itemBuilder: (context, index) {
                if (onCreate != null && index == 0) {
                  return _NewAgentRow(onTap: onCreate);
                }
                final entry = choices[index - (onCreate == null ? 0 : 1)];
                return AgentTile(
                  machine: entry.machine,
                  agent: entry.agent,
                  onTap: () => onPick(entry),
                );
              },
            ),
          ),
          if (choices.isEmpty)
            Padding(
              padding: const EdgeInsets.fromLTRB(_sideInset, 0, _sideInset, 8),
              child: Text(
                'Every harness this phone can open is already here.',
                style: TextStyle(
                  color: AppPalette.textSecondary,
                  fontSize: 13.5,
                ),
              ),
            ),
        ],
      ),
    );
  }
}

/// "New agent", drawn as a card the same height as the agents under it so the
/// list reads as one column of things that can be put in a tab.
class _NewAgentRow extends StatelessWidget {
  const _NewAgentRow({required this.onTap});

  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    return PhoneCard(
      height: kPhoneAgentCardHeight,
      onTap: onTap,
      child: Row(
        children: [
          PhoneCardGlyph(
            child: Icon(
              LucideIcons.plus300,
              size: 22,
              color: AppPalette.accentOnSurface,
            ),
          ),
          const SizedBox(width: 14),
          Expanded(
            child: Text(
              'New Harness',
              style: TextStyle(
                color: AppPalette.textPrimary,
                fontSize: 15.5,
                fontWeight: FontWeight.w600,
              ),
            ),
          ),
          Icon(
            LucideIcons.chevronRight300,
            size: 18,
            color: AppPalette.textFaint,
          ),
        ],
      ),
    );
  }
}
