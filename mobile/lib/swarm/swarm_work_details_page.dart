import 'dart:async';

import 'package:flutter/material.dart';

import 'package:harness_mobile/phone/phone_navigation.dart';
import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'linked_tasks.dart';
import 'model.dart';
import 'swarm_code_block.dart';
import 'swarm_message_row.dart' show swarmChatText;
import 'swarm_reader.dart';
import 'swarm_style.dart';

/// Whether chat [chatId] has Work details, where Desktop's chat menu offers
/// them (`view.dart` `_options`): a chat of a project's work, never the
/// project's own chat (whose menu is its project's), a Buddy chat, or a private
/// conversation, which is chat only. False once the chat can no longer be read.
bool swarmHasWorkDetails(SwarmReader reader, String chatId) {
  final snapshot = reader.snapshot;
  if (reader.accessRevoked || snapshot == null) return false;
  final chat = snapshot.conversation(chatId);
  return chat != null &&
      !snapshot.isProjectLead(chatId) &&
      !chat.isBuddyChat &&
      !reader.buddies.chatOwners.containsKey(chatId) &&
      chat.audience == null;
}

/// Opens chat [chatId]'s Work details over [context]'s page.
void openSwarmWorkDetails(
  BuildContext context, {
  required SwarmReader reader,
  required String chatId,
}) => unawaited(
  Navigator.of(context).push(
    phoneRoute((_) => SwarmWorkDetailsPage(reader: reader, chatId: chatId)),
  ),
);

/// A task's Work details, read only (Tony's mobile list, task 31; desktop
/// `work_details.dart`): its brief as written, its linked steps, who has it,
/// each acceptance check with its evidence, and the result. Desktop's words
/// and order, without Record check: the phone records nothing. It reads only
/// what the Swarm read holds, follows it, and goes once the chat can no longer
/// be read: access lost, signed out, or the chat gone.
class SwarmWorkDetailsPage extends StatefulWidget {
  const SwarmWorkDetailsPage({
    super.key,
    required this.reader,
    required this.chatId,
  });

  final SwarmReader reader;
  final String chatId;

  @override
  State<SwarmWorkDetailsPage> createState() => _SwarmWorkDetailsPageState();
}

class _SwarmWorkDetailsPageState extends State<SwarmWorkDetailsPage> {
  bool _leaving = false;

  SuperTabConversation? get _chat => widget.reader.accessRevoked
      ? null
      : widget.reader.snapshot?.conversation(widget.chatId);

  @override
  void initState() {
    super.initState();
    widget.reader.addListener(_changed);
  }

  @override
  void didUpdateWidget(SwarmWorkDetailsPage old) {
    super.didUpdateWidget(old);
    if (old.reader == widget.reader) return;
    old.reader.removeListener(_changed);
    widget.reader.addListener(_changed);
  }

  @override
  void dispose() {
    widget.reader.removeListener(_changed);
    super.dispose();
  }

  void _changed() {
    if (!mounted) return;
    if (_chat == null) {
      _leave();
    } else {
      setState(() {});
    }
  }

  /// Takes the page down once this frame is done: a page whose chat went may
  /// not change the navigator while it builds.
  void _leave() {
    if (_leaving) return;
    _leaving = true;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route != null && route.isActive) route.navigator?.removeRoute(route);
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final chat = _chat;
    if (chat == null) _leave();
    return Scaffold(
      backgroundColor: AppPalette.windowBg,
      body: SafeArea(
        bottom: false,
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.stretch,
          children: [
            SwarmTopBar(
              leading: SwarmBackButton(
                onPressed: () => Navigator.of(context).maybePop(),
              ),
              title: 'Work details',
              subtitle: chat?.label,
            ),
            Expanded(
              child: chat == null
                  ? const SizedBox.shrink()
                  : _body(context, chat),
            ),
          ],
        ),
      ),
    );
  }

  Widget _body(BuildContext context, SuperTabConversation chat) {
    final snapshot = widget.reader.snapshot!;
    final quiet = Tty.of(context)
        .style(color: AppPalette.textFaint, size: 12.5);
    final assignment = chat.assignment;
    final linked = superTabLinkedLine(snapshot, chat);
    Widget text(String value, {Key? key, Color? color}) => Padding(
      key: key,
      padding: const EdgeInsets.only(bottom: AppSpace.s),
      child: Text(value, style: swarmChatText(15, color: color)),
    );
    // Code fenced in a brief or evidence reads as code, as in the chat.
    List<Widget> written(String value) => [
      for (final part in swarmTextParts(value))
        if (part.code)
          SwarmCodeBlock(code: part.text, name: part.name)
        else
          text(part.text),
    ];
    return SelectionArea(
      child: ListView(
        key: const ValueKey('swarm-work-details'),
        padding: EdgeInsets.fromLTRB(
          AppSpace.m,
          AppSpace.xs,
          AppSpace.m,
          MediaQuery.paddingOf(context).bottom + AppSpace.xl,
        ),
        children: [
          // The brief as written (the backend writes a task's from its parts),
          // never parts of a fixed shape.
          if (chat.brief.isNotEmpty)
            ...written(chat.brief)
          else
            text(
              'This task has no description yet.',
              color: AppPalette.textSecondary,
            ),
          if (linked != null) ...[
            const SizedBox(height: AppSpace.s),
            text(linked),
          ],
          if (assignment != null) ...[
            const SizedBox(height: AppSpace.s),
            text(
              '${_agentName(snapshot, assignment['agentId'])} · '
              '${superTabWorkStatusLabel(assignment['status'] as String? ?? '')}',
            ),
          ],
          if (chat.checks.isNotEmpty) const SwarmCaption('Acceptance checks'),
          for (final check in chat.checks)
            Padding(
              key: ValueKey('swarm-work-check-${check['id']}'),
              padding: const EdgeInsets.only(bottom: AppSpace.m),
              child: Column(
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    check['description'] as String? ?? '',
                    style: swarmChatText(15)
                        .copyWith(fontWeight: FontWeight.w600),
                  ),
                  const SizedBox(height: 2),
                  if (check['evidence'] case final String evidence)
                    ...written(evidence),
                  Text(
                    check['passedBy'] == null ? 'Not verified' : 'Verified',
                    style: quiet,
                  ),
                ],
              ),
            ),
          if (assignment?['result'] case final String result) ...[
            const SwarmCaption('Result'),
            ...written(result),
          ],
        ],
      ),
    );
  }
}

/// The agent's name as the read gives it, as Desktop words one it no longer has.
String _agentName(SuperTabSnapshot snapshot, Object? agentId) =>
    agentId is String && snapshot.agent(agentId) != null
    ? snapshot.agentName(agentId)
    : 'Agent unavailable';
