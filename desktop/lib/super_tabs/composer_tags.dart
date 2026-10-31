import 'package:flutter/material.dart';
import 'package:flutter/services.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'identity.dart';
import 'model.dart';

/// `@` tags in a composer, the same in the main chat's box and a thread's
/// reply box: where a tag is being typed, who it offers, how a pick goes into
/// the text, the list of choices, its keys, and Backspace taking a whole tag.

/// A completion row: a workgroup, or someone to tag with their face and
/// whether they are a person or an agent ([kind]).
typedef SuperTabComposerChoice = ({
  String label,
  String? detail,
  VoidCallback choose,
  Widget? leading,
  String? kind,
});

/// The most choices a list shows.
const superTabCompletionLimit = 6;

/// The `@` tag typed up to the caret of [value]: where it starts and ends and
/// what follows the `@`, lowercased. None while text is selected or composed,
/// when the reader dismissed it here ([dismissed], the text before the caret
/// then), or once it says one of [tags] in full.
({int start, int end, String query})? superTabTagAtCaret(
  TextEditingValue value, {
  required String? dismissed,
  required Iterable<String> tags,
}) {
  if (!value.selection.isValid ||
      !value.selection.isCollapsed ||
      (value.composing.isValid && !value.composing.isCollapsed)) {
    return null;
  }
  final end = value.selection.baseOffset;
  final prefix = value.text.substring(0, end);
  final match = RegExp(r'(?:^|\s)@([^@\n]*)$').firstMatch(prefix);
  if (match == null || prefix == dismissed) return null;
  final query = match.group(1)!;
  if (tags.contains('@${query.trimRight()}')) return null;
  return (start: prefix.lastIndexOf('@'), end: end, query: query.toLowerCase());
}

/// An agent's name as the chat shows it.
String superTabAgentName(SuperTabController c, SuperTabAgent agent) =>
    c.snapshot?.agentName(agent.id, fallback: agent.name) ?? agent.name;

/// Who `@` offers in [group]: the people who read it, then its agents,
/// filtered by [query]. Never the reader; nobody is tagged in the Leads
/// conversation, so it offers agents alone. Without [agents] (a thread its
/// own Buddy session answers, where only that session hears a reply), people
/// alone. [choose] puts the picked one in the text.
List<SuperTabComposerChoice> superTabTagChoices(
  SuperTabController c,
  SuperTabConversation group,
  String query, {
  required String Function(String machineId) machineName,
  required void Function(String id, String name) choose,
  bool agents = true,
}) {
  final snapshot = c.snapshot;
  if (snapshot == null) return const [];
  final project = snapshot.projectFor(group.id);
  bool reads(SuperTabPerson person) => switch (group) {
    _ when group.kind == 'leads' => false,
    SuperTabConversation(:final audience?) => audience.contains(person.id),
    _ when group.buddyOwnerId != null => person.id == group.buddyOwnerId,
    _ =>
      project == null ||
          !project.isPrivate ||
          project.ownerId == person.id ||
          project.memberIds.contains(person.id),
  };
  final people = snapshot.people.where(
    (person) =>
        person.id != c.accountId &&
        reads(person) &&
        person.username.contains(query),
  );
  final offered = agents
      ? snapshot.agents.where(
          (agent) =>
              group.agentIds.contains(agent.id) &&
              // A thread's own session answers only there: nobody tags it.
              agent.buddySession == null &&
              '${superTabAgentName(c, agent)} ${agent.engine}'
                  .toLowerCase()
                  .contains(query),
        )
      : const <SuperTabAgent>[];
  return [
    for (final person in people)
      (
        label: person.username,
        detail: null,
        choose: () => choose(person.id, person.username),
        leading: SuperTabAvatar.person(person, size: SuperTabAvatar.rowSize),
        kind: 'person',
      ),
    for (final agent in offered)
      (
        label: superTabAgentName(c, agent),
        detail: '${agent.engine}  ${machineName(agent.machineId)}'.trim(),
        choose: () => choose(agent.id, superTabAgentName(c, agent)),
        leading: SuperTabAvatar.agent(agent, size: SuperTabAvatar.rowSize),
        kind: 'agent',
      ),
  ].take(superTabCompletionLimit).toList();
}

/// [value] with the tag typed at [at] replaced by [token] and a space, the
/// caret after it.
TextEditingValue superTabInsertTag(
  TextEditingValue value,
  ({int start, int end, String query}) at,
  String token,
) {
  final text = value.text.replaceRange(at.start, at.end, '$token ');
  return TextEditingValue(
    text: text,
    selection: TextSelection.collapsed(offset: at.start + token.length + 1),
  );
}

/// What a key does while [choices] show under a focused composer: arrows move
/// the selection ([move]), Tab and Enter pick, Escape [dismiss]es the list.
/// Null for any other key, a key with a modifier, or none shown: the box
/// handles it as usual. [choices] is read only for a plain key press.
KeyEventResult? superTabCompletionKey(
  KeyEvent event, {
  required List<SuperTabComposerChoice> Function() choices,
  required int index,
  required void Function(int index) move,
  required VoidCallback dismiss,
}) {
  final keys = HardwareKeyboard.instance;
  if (event is! KeyDownEvent ||
      keys.isControlPressed ||
      keys.isMetaPressed ||
      keys.isAltPressed ||
      keys.isShiftPressed) {
    return null;
  }
  final shown = choices();
  if (shown.isEmpty) return null;
  final key = event.logicalKey;
  if (key == LogicalKeyboardKey.arrowDown ||
      key == LogicalKeyboardKey.arrowUp) {
    move(
      (index + (key == LogicalKeyboardKey.arrowDown ? 1 : -1)) % shown.length,
    );
    return KeyEventResult.handled;
  }
  if (key == LogicalKeyboardKey.tab || key == LogicalKeyboardKey.enter) {
    shown[index.clamp(0, shown.length - 1)].choose();
    return KeyEventResult.handled;
  }
  if (key == LogicalKeyboardKey.escape) {
    dismiss();
    return KeyEventResult.handled;
  }
  return null;
}

/// The list of [choices] above a composer, [index] selected; each row keyed
/// by [rowKeys] so a move can scroll it into view.
class SuperTabCompletionList extends StatelessWidget {
  const SuperTabCompletionList({
    super.key,
    required this.listKey,
    required this.choices,
    required this.index,
    required this.rowKeys,
  });

  final Key listKey;
  final List<SuperTabComposerChoice> choices;
  final int index;
  final List<GlobalKey> rowKeys;

  @override
  Widget build(BuildContext context) => Material(
    color: DesktopChrome.surface,
    shape: RoundedRectangleBorder(
      borderRadius: BorderRadius.circular(DesktopChrome.controlRadius),
      side: BorderSide(color: DesktopChrome.rim),
    ),
    clipBehavior: Clip.antiAlias,
    child: ConstrainedBox(
      constraints: BoxConstraints(
        maxHeight: MediaQuery.sizeOf(context).height * .3,
      ),
      child: ListView(
        key: listKey,
        shrinkWrap: true,
        padding: const EdgeInsets.symmetric(
          vertical: grid.AppDesktop.controlGap / 2,
        ),
        children: [
          for (var i = 0; i < choices.length; i++)
            ListTile(
              key: rowKeys[i],
              dense: true,
              selected: i == index.clamp(0, choices.length - 1),
              selectedTileColor: grid.AppSurface.selectedFill,
              selectedColor: DesktopChrome.foreground,
              contentPadding: const EdgeInsets.symmetric(
                horizontal: grid.AppDesktop.groupGap,
              ),
              leading: choices[i].leading,
              trailing: choices[i].kind == null
                  ? null
                  : Text(choices[i].kind!, style: DesktopChrome.metadata()),
              title: Text(
                choices[i].label,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: DesktopChrome.control(),
              ),
              subtitle: choices[i].detail == null
                  ? null
                  : Text(
                      choices[i].detail!,
                      maxLines: 1,
                      overflow: TextOverflow.ellipsis,
                      style: DesktopChrome.metadata(),
                    ),
              onTap: choices[i].choose,
            ),
        ],
      ),
    ),
  );
}

/// Backspace right after a tag takes the whole tag, as in Slack: deleting the
/// character before the caret, where one of [tags] ends, removes that tag.
/// The draft then no longer holds it, so its agent is no longer addressed.
class SuperTabTagBackspace extends TextInputFormatter {
  SuperTabTagBackspace(this.tags);

  final Iterable<String> Function() tags;

  @override
  TextEditingValue formatEditUpdate(
    TextEditingValue oldValue,
    TextEditingValue newValue,
  ) {
    final caret = oldValue.selection;
    if (!caret.isValid ||
        !caret.isCollapsed ||
        caret.baseOffset == 0 ||
        (newValue.composing.isValid && !newValue.composing.isCollapsed)) {
      return newValue;
    }
    final end = caret.baseOffset;
    if (newValue.selection != TextSelection.collapsed(offset: end - 1) ||
        newValue.text != oldValue.text.replaceRange(end - 1, end, '')) {
      return newValue;
    }
    final before = oldValue.text.substring(0, end);
    final after = oldValue.text.substring(end);
    if (after.isNotEmpty && !after.startsWith(RegExp(r'[\s.,!?;:]'))) {
      return newValue;
    }
    for (final tag in tags()) {
      final start = end - tag.length;
      if (!before.endsWith(tag) ||
          (start > 0 && !before[start - 1].contains(RegExp(r'\s')))) {
        continue;
      }
      return TextEditingValue(
        text: oldValue.text.replaceRange(start, end, ''),
        selection: TextSelection.collapsed(offset: start),
      );
    }
    return newValue;
  }
}
