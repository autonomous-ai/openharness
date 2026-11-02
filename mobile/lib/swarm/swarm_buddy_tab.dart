import 'dart:async';

import 'package:flutter/material.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';

import 'package:harness_mobile/phone/out_of_sight.dart';
import 'package:harness_mobile/phone/phone_sheet.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_buddy.dart';
import 'swarm_conversation_page.dart';
import 'swarm_home_top.dart' show swarmHomeListing, swarmHomeOffers;
import 'swarm_inbox.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';
import 'swarm_unread.dart';

/// The Swarm the Buddy tab shows: the one the person last used
/// ([SwarmHomePrefs.buddySwarmId]) or Home shows alone; before either, the one
/// whose Buddy chat moved last, else the first. Never one the account lost or
/// whose read was taken away; null with none.
SwarmListing? swarmBuddySwarm(SwarmSession session) {
  final inbox = session.inbox;
  final offered = [
    for (final swarm in inbox.swarms)
      if (swarmHomeOffers(inbox, swarm.id)) swarm,
  ];
  if (offered.isEmpty) return null;
  for (final id in [session.home.buddySwarmId, session.home.swarmId]) {
    if (offered.where((swarm) => swarm.id == id).firstOrNull
        case final swarm?) {
      return swarm;
    }
  }
  DateTime? moved(SwarmListing swarm) {
    final reader = inbox.reader(swarm.id);
    return reader == null
        ? null
        : swarmBuddyChat(reader, swarmBuddyKey)?.changedAt;
  }

  var newest = offered.first;
  for (final swarm in offered.skip(1)) {
    final (a, b) = (moved(swarm), moved(newest));
    if (a != null && (b == null || a.isAfter(b))) newest = swarm;
  }
  return newest;
}

/// Whether [swarmBuddySwarm] can be trusted to act on: a choice is kept, or
/// there is one Swarm, or every Swarm has answered its read. Before that the
/// tab waits rather than open a chat, or keep a pick, in the first Swarm listed
/// because the one used last has not been read yet.
bool swarmBuddySwarmSettled(SwarmSession session) {
  final inbox = session.inbox, home = session.home;
  if (!home.loaded) return false;
  final offered = [
    for (final swarm in inbox.swarms)
      if (swarmHomeOffers(inbox, swarm.id)) swarm.id,
  ];
  if (offered.length < 2 ||
      offered.contains(home.buddySwarmId) ||
      offered.contains(home.swarmId)) {
    return true;
  }
  return offered.every((id) => !(inbox.reader(id)?.loading ?? false));
}

/// The Swarms whose one Buddy chat has something unread: the tab's count. A
/// Swarm's older Buddy chats never count (the desktop's `_countedBuddyChats`),
/// nor does a muted chat.
int swarmBuddyTabBadge(SwarmSession session) {
  final inbox = session.inbox;
  var count = 0;
  for (final swarm in inbox.swarms) {
    final reader = inbox.reader(swarm.id);
    if (reader == null || reader.accessRevoked) continue;
    final chat = swarmBuddyChat(reader, swarmBuddyKey);
    if (chat != null && swarmUnreadShown(reader, chat)) count++;
  }
  return count;
}

/// How a Buddy stands on its dot: lit while it runs, quiet while it is down.
enum SwarmBuddyMark {
  running('running'),
  offline('offline');

  const SwarmBuddyMark(this.label);

  /// The word a screen reader says for the dot.
  final String label;
}

/// The dot for the person's one Buddy in [reader]'s Swarm: what the desktop's
/// # buddy row shows of it. None with no Buddy (none started, or one starting).
SwarmBuddyMark? swarmBuddyMark(SwarmReader reader) {
  if (reader.accessRevoked) return null;
  final agent = swarmBuddy(reader, swarmBuddyKey);
  if (agent == null) return null;
  return agent.downSince == null
      ? SwarmBuddyMark.running
      : SwarmBuddyMark.offline;
}

/// The dot on the tab's glyph: the Buddy of the Swarm the tab shows.
SwarmBuddyMark? swarmBuddyTabMark(SwarmSession session) {
  final swarm = swarmBuddySwarm(session);
  final reader = swarm == null ? null : session.inbox.reader(swarm.id);
  return reader == null ? null : swarmBuddyMark(reader);
}

/// [mark] as a small dot, green while the Buddy runs; [ring] sets it off from
/// what it sits on, as on the tab's glyph.
class SwarmBuddyDot extends StatelessWidget {
  const SwarmBuddyDot(this.mark, {super.key, this.ring});

  final SwarmBuddyMark mark;
  final Color? ring;

  @override
  Widget build(BuildContext context) => Container(
    width: 9,
    height: 9,
    decoration: BoxDecoration(
      color: mark == SwarmBuddyMark.running
          ? AppColors.success
          : AppPalette.textFaint,
      shape: BoxShape.circle,
      border: ring == null ? null : Border.all(color: ring!, width: 1.5),
    ),
  );
}

/// Picks the Swarm the Buddy tab shows, among those the account can read, by
/// name; the one shown says current, another with something unread says so. A
/// Swarm that leaves while it is open leaves the sheet, and is not picked.
Future<void> showSwarmBuddySwitcher(
  BuildContext context,
  SwarmSession session,
) => showPhoneSheet(
  context,
  title: 'Swarm',
  rebuildOn: Listenable.merge([session.inbox, session.home]),
  rows: () {
    final inbox = session.inbox;
    final shown = swarmBuddySwarm(session)?.id;
    return (
      actions: [
        for (final swarm in inbox.swarms)
          if (swarmHomeOffers(inbox, swarm.id))
            PhoneSheetAction(
              icon: LucideIcons.hexagon,
              label: swarm.name,
              value: swarm.id == shown
                  ? 'current'
                  : switch (inbox.reader(swarm.id)) {
                      final reader?
                          when switch (swarmBuddyChat(reader, swarmBuddyKey)) {
                            final chat? => swarmUnreadShown(reader, chat),
                            null => false,
                          } =>
                        'unread',
                      _ => null,
                    },
              onTap: () {
                if (swarmHomeOffers(inbox, swarm.id)) {
                  session.home.showBuddy(swarm.id);
                }
              },
            ),
      ],
      sections: const <PhoneSheetSection>[],
    );
  },
);

/// The Buddy tab (Tony, 11-02): the person's one Buddy chat of the Swarm they
/// last used ([swarmBuddySwarm]), opened at once, its Start there while no
/// Buddy runs. Several Swarms switch from its ⋮ ([showSwarmBuddySwitcher]).
///
/// A chat the read does not hold yet is opened on the server first, once for
/// each read of the Swarm; a refusal says so with Try again, and an answer
/// that comes after the Swarm was left or lost is dropped. A viewer, who opens
/// nothing, is told they have none.
class SwarmBuddyTabView extends StatefulWidget {
  const SwarmBuddyTabView({super.key});

  @override
  State<SwarmBuddyTabView> createState() => _SwarmBuddyTabViewState();
}

/// A request for one read of one Swarm: [generation] is its reader's at the
/// time ([SwarmReader.generation]), so a read anew from nothing asks again.
typedef _Ask = ({String swarmId, int generation});

class _SwarmBuddyTabViewState extends State<SwarmBuddyTabView> {
  SwarmSession? _session;
  bool _seen = false;

  /// The chat being opened on the server, the one it answered with, and what
  /// went wrong: each for the Swarm and read it names.
  _Ask? _asking;
  ({_Ask ask, String chatId})? _opened;
  ({_Ask ask, String text})? _failed;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    final session = SwarmScope.of(context);
    final seen = session != null && !OutOfSight.of(context);
    if (identical(session, _session) && seen == _seen) return;
    final same = identical(session, _session);
    _see(false);
    if (!same) {
      // Another account, or signed out: nothing of the last one stays.
      _asking = null;
      _opened = null;
      _failed = null;
    }
    _session = session;
    _see(seen);
  }

  /// In sight: the Swarms are read, and their notices keep quiet.
  void _see(bool seen) {
    final session = _session;
    if (session == null || seen == _seen) return;
    _seen = seen;
    if (seen) {
      session.enter();
      unawaited(session.inbox.refresh());
    } else {
      session.leave();
    }
  }

  @override
  void dispose() {
    _see(false);
    super.dispose();
  }

  /// Opens the one Buddy chat of [ask]'s Swarm on the server. An answer once
  /// another ask took over is dropped; one kept counts only for the same Swarm
  /// and read ([_body] compares the ask), so access lost, which reads anew, or
  /// another Swarm shown never takes it up.
  Future<void> _open(SwarmSession session, SwarmReader reader, _Ask ask) async {
    _asking = ask;
    String? id, error;
    try {
      id = await openSwarmBuddyChat(reader, swarmBuddyKey);
      if (id == null) error = 'Your Buddy chat is not ready yet. Try again.';
    } on SuperTabFailure catch (failure) {
      error = failure.message;
    } catch (_) {
      error = 'Could not open your Buddy chat. Try again.';
    }
    if (!mounted || !identical(_session, session) || _asking != ask) return;
    setState(() {
      _asking = null;
      if (id != null) {
        _opened = (ask: ask, chatId: id);
        // Read now, so its state shows at once rather than at the next poll.
        unawaited(reader.refresh());
      }
      if (error != null) _failed = (ask: ask, text: error);
    });
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = _session;
    return Material(
      color: AppPalette.windowBg,
      child: session == null
          ? const SizedBox.shrink()
          : ListenWhileInSight(
              listenable: Listenable.merge([session.inbox, session.home]),
              builder: (context) => _body(context, session),
            ),
    );
  }

  Widget _body(BuildContext context, SwarmSession session) {
    final inbox = session.inbox;
    final swarm = swarmBuddySwarm(session);
    if (swarm == null) {
      if (inbox.error case final error? when !inbox.loaded) {
        return _Plain(
          note: error,
          retryKey: 'swarm-buddy-retry-list',
          onRetry: () => unawaited(inbox.refresh()),
        );
      }
      return swarmHomeListing(inbox)
          ? const _Plain(loading: true)
          : const _Plain(note: 'No Swarm yet.');
    }
    if (!swarmBuddySwarmSettled(session)) return const _Plain(loading: true);
    final reader = inbox.reader(swarm.id);
    final snapshot = reader?.snapshot;
    final several =
        inbox.swarms.where((s) => swarmHomeOffers(inbox, s.id)).length > 1;
    void pick() => unawaited(showSwarmBuddySwitcher(context, session));
    final title = several ? pick : null;
    if (reader == null || snapshot == null) {
      if (reader?.error case final error?) {
        return _Plain(
          note: error,
          retryKey: 'swarm-buddy-retry-read',
          onRetry: () => unawaited(reader!.refresh()),
          onTitle: title,
        );
      }
      return _Plain(loading: true, onTitle: title);
    }
    if (!snapshot.swarmBuddy) {
      // What the phone kept from an older read says nothing of it yet.
      return reader.reads.value == 0
          ? _Plain(loading: true, onTitle: title)
          : _Plain(
              note: 'Update your Harness server to use Buddy here.',
              onTitle: title,
            );
    }
    final ask = (swarmId: swarm.id, generation: reader.generation);
    final chat =
        reader.buddies.ownChats[swarmBuddyKey] ??
        (_opened?.ask == ask ? _opened!.chatId : null);
    if (chat != null) {
      // Used now: a chat moving in another Swarm does not take the tab there.
      if (session.home.loaded && session.home.buddySwarmId != swarm.id) {
        WidgetsBinding.instance.addPostFrameCallback((_) {
          if (mounted && swarmBuddySwarm(session)?.id == swarm.id) {
            session.home.showBuddy(swarm.id);
          }
        });
      }
      return SwarmConversationPage(
        key: ValueKey('swarm-buddy-tab-${swarm.id}/$chat'),
        swarmId: swarm.id,
        conversationId: chat,
        tabRoot: true,
        swarmSwitch: several ? (name: swarm.name, open: pick) : null,
      );
    }
    if (!swarmCanWrite(reader)) {
      return _Plain(note: 'You have no Buddy in this Swarm.', onTitle: title);
    }
    if (_failed case final failed? when failed.ask == ask) {
      return _Plain(
        note: failed.text,
        retryKey: 'swarm-buddy-retry-open',
        onRetry: () => setState(() => _failed = null),
        onTitle: title,
      );
    }
    if (_asking != ask) {
      // Once for this read; a build while it is out asks nothing more.
      _asking = ask;
      WidgetsBinding.instance.addPostFrameCallback((_) {
        if (mounted && _asking == ask && identical(_session, session)) {
          unawaited(_open(session, reader, ask));
        }
      });
    }
    return _Plain(loading: true, onTitle: title);
  }
}

/// The tab before there is a chat to show: its title, then a skeleton while
/// [loading], or [note] with Try again when [onRetry] is given. [onTitle]
/// switches Swarm, with several to switch between.
class _Plain extends StatelessWidget {
  const _Plain({
    this.loading = false,
    this.note,
    this.retryKey,
    this.onRetry,
    this.onTitle,
  });

  final bool loading;
  final String? note;
  final String? retryKey;
  final VoidCallback? onRetry;
  final VoidCallback? onTitle;

  @override
  Widget build(BuildContext context) => SafeArea(
    bottom: false,
    child: Column(
      crossAxisAlignment: CrossAxisAlignment.stretch,
      children: [
        SwarmTabHeader(
          'Buddy',
          onTitle: onTitle,
          titleLabel: onTitle == null ? null : 'Buddy. Switch Swarm',
        ),
        if (loading)
          Padding(
            padding: const EdgeInsets.all(AppSpace.m),
            child: SwarmSkeletonRows(id: 'swarm-buddy-loading'),
          )
        else if (note case final note?)
          Padding(
            padding: const EdgeInsets.symmetric(
              horizontal: AppSpace.screenInset,
              vertical: AppSpace.s,
            ),
            child: Row(
              children: [
                Expanded(
                  child: Text(
                    note,
                    key: const ValueKey('swarm-buddy-note'),
                    style: AppType.body(color: AppPalette.textSecondary),
                  ),
                ),
                if (onRetry != null)
                  SwarmButton(
                    key: retryKey == null ? null : ValueKey<String>(retryKey!),
                    label: 'Try again',
                    style: SwarmButtonStyle.link,
                    onPressed: onRetry,
                  ),
              ],
            ),
          ),
      ],
    ),
  );
}
