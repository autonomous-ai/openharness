import 'dart:async';

import 'package:flutter/foundation.dart'
    show TargetPlatform, defaultTargetPlatform, kIsWeb;
import 'package:flutter/material.dart';

import '../notify/system_notifications.dart';
import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'identity.dart';
import 'machine_status.dart' show superTabAgo;
import 'model.dart';
import 'section_heading.dart';

/// A Lead's tag of the reader in one message (spec 2026-10-24-lead-mentions.md).
class SuperTabMention {
  SuperTabMention.fromJson(Map<String, dynamic> row)
    : id = row['id'] as String,
      projectId = row['projectId'] as String? ?? '',
      projectName = row['projectName'] as String? ?? '',
      conversationId = row['conversationId'] as String,
      conversationTitle = row['conversationTitle'] as String? ?? '',
      messageId = row['messageId'] as String,
      leadId = row['leadId'] as String?,
      leadName = row['leadName'] as String? ?? 'Lead',
      text = row['text'] as String? ?? '',
      createdAt = DateTime.tryParse(row['createdAt'] as String? ?? ''),
      resolvedBy = row['resolvedBy'] as String?;
  final String id, projectId, projectName, conversationId, conversationTitle;
  final String messageId, leadName, text;

  /// The Lead who tagged; null from a backend that does not send it.
  final String? leadId;
  final DateTime? createdAt;

  /// `reply` or `done` once it moved to Earlier; null while it waits.
  final String? resolvedBy;
}

/// Whether the menu bar's Harness menu lists the reader's tags and decisions,
/// with their count on the Dock: the Mac app's. Elsewhere the Swarm's sidebar
/// keeps its Notifications row.
bool get superTabNoticesInMenuBar =>
    !kIsWeb && defaultTargetPlatform == TargetPlatform.macOS;

/// What tells the person about a new tag outside the window: the operating
/// system, on Desktop only. The web shows only the badge and the list (spec
/// decision 6). The Settings switch for system notifications still applies.
/// A click on it opens the tag in its Swarm [tabId], at its message.
void Function(String tabId, SuperTabMention mention)? superTabMentionNotice(
  SystemNotifications system, {
  bool web = kIsWeb,
}) => web
    ? null
    : (tabId, mention) => system.postNotice(
        id: 'harness-mention:${mention.id}',
        title: '${mention.leadName} tagged you',
        body:
            '${mention.projectName} · ${mention.conversationTitle}: '
            '${mention.text}',
        mention: (tabId: tabId, mentionId: mention.id),
      );

/// The reader's tags in one Swarm: Waiting and Earlier, read from the backend
/// when the count or the digest of which tags wait moves (or, from a backend
/// without the digest, whenever the Swarm changes while a tag waits). One per
/// controller.
class SuperTabMentions extends ChangeNotifier {
  SuperTabMentions._(this.controller) {
    controller.addListener(_changed);
    _changed();
  }

  static final _all = Expando<SuperTabMentions>();
  static SuperTabMentions of(SuperTabController controller) =>
      _all[controller] ??= SuperTabMentions._(controller);

  final SuperTabController controller;

  /// A tag that arrived after the first read, while the app was open.
  void Function(SuperTabMention mention)? onArrived;

  List<SuperTabMention> waiting = const [], earlier = const [];
  String? error;
  int? _count;
  String? _digest;
  int _lastChangedAt = -1;
  int? _epoch;
  // Null until the first read: tags waiting then are not news.
  Set<String>? _seen;
  Future<void>? _loading;
  // Something changed while a read was under way: read once more after it.
  bool _dirty = false;
  // Reads in the order they were asked, and the latest one shown: an older
  // answer arriving late never replaces a newer one (review of #2088).
  int _asked = 0, _shown = 0;

  /// Starts from tags already announced elsewhere, so they are not news here.
  void seen(Set<String>? ids) {
    if (ids != null) _seen = {...?_seen, ...ids};
  }

  String get _path =>
      '/api/super-tabs/${Uri.encodeComponent(controller.tabId)}';

  /// A tag can arrive while another is answered, leaving the count as it was:
  /// the digest moves then. A backend without the digest leaves only the
  /// change of the Swarm to go by, so any is read while a tag waits, and so is
  /// any after a failed read. With none waiting and none answered (an idle
  /// Swarm, or a backend before tags) nothing is.
  void _changed() {
    final snapshot = controller.snapshot;
    if (snapshot == null) return;
    final epoch = controller.visibilityEpoch;
    if (epoch != null && epoch != _epoch) {
      final moved = _epoch != null;
      _epoch = epoch;
      if (moved) {
        // Who may read what changed: no tag read before shows until read
        // again, even while the count stays, as the decisions do.
        if (waiting.isNotEmpty || earlier.isNotEmpty) {
          waiting = earlier = const [];
          notifyListeners();
        }
        _lastChangedAt = controller.lastChangedAt;
        _count = snapshot.mentionsWaiting;
        _digest = snapshot.mentionsDigest;
        unawaited(load());
        return;
      }
    }
    // A tag that expires moves the count without changing the Swarm.
    final count = snapshot.mentionsWaiting;
    final digest = snapshot.mentionsDigest;
    final moved = count != _count || digest != _digest;
    final changed = controller.lastChangedAt != _lastChangedAt;
    if (!moved && !(changed && (digest == null || error != null))) return;
    _lastChangedAt = controller.lastChangedAt;
    _count = count;
    _digest = digest;
    if (count == 0 && (!moved || _seen == null)) {
      _seen ??= {};
      return;
    }
    unawaited(load());
  }

  /// Joins a read under way, and has it read once more when asked again.
  Future<void> load() {
    if (_loading case final running?) {
      _dirty = true;
      return running;
    }
    return _loading = () async {
      do {
        _dirty = false;
        await _read();
      } while (_dirty);
    }().whenComplete(() => _loading = null);
  }

  /// Whether the server lists [mentionId] among the reader's waiting tags
  /// now. A read that fails or is refused answers false: what was read before
  /// never stands in for it. A yes shows that same read as [waiting], so what
  /// opens the tag reads it from the answer that confirmed it, with no second
  /// read to decide otherwise.
  Future<bool> waitingNow(String mentionId) async {
    final epoch = _epoch, asked = ++_asked;
    final List<SuperTabMention> fresh;
    try {
      fresh = await _list('waiting');
    } catch (_) {
      return false;
    }
    // Who may read what changed while it was on its way: it says nothing now.
    // A Swarm just loaded learns its first epoch meanwhile; that is no change.
    final moved = epoch != null && epoch != _epoch;
    if (moved || !fresh.any((m) => m.id == mentionId)) return false;
    // A read asked after this one already shows what is newer.
    if (asked < _shown) return true;
    _shown = asked;
    if (!_sameMentions(waiting, fresh)) {
      waiting = fresh;
      notifyListeners();
    }
    return true;
  }

  Future<List<SuperTabMention>> _list(String state) async {
    final Map<String, dynamic> answer;
    try {
      answer = await controller.request('GET', '$_path/mentions?state=$state');
    } on SuperTabFailure catch (failure) {
      // A backend from before tags has no list: there is nothing to show.
      if (failure.statusCode == 404) return const [];
      rethrow;
    }
    return List.unmodifiable([
      for (final row in answer['mentions'] as List)
        SuperTabMention.fromJson(superTabMap(row)),
    ]);
  }

  Future<void> _read() async {
    final epoch = _epoch, asked = ++_asked;
    try {
      final [nextWaiting, nextEarlier] = await Future.wait([
        _list('waiting'),
        _list('earlier'),
      ]);
      // Read before who may read what changed: the read asked again since
      // replaces it.
      if (epoch != _epoch) return;
      // Asked before a read already shown: older news. Read once more, so
      // both lists and what arrived come from one answer after it.
      if (asked < _shown) {
        _dirty = true;
        return;
      }
      _shown = asked;
      final same =
          error == null &&
          _sameMentions(waiting, nextWaiting) &&
          _sameMentions(earlier, nextEarlier);
      waiting = nextWaiting;
      earlier = nextEarlier;
      error = null;
      final seen = _seen;
      _seen = {...?seen, for (final m in waiting) m.id};
      if (seen != null) {
        for (final m in waiting.reversed) {
          if (!seen.contains(m.id)) onArrived?.call(m);
        }
      }
      // The same lists again: nothing to show, so nobody is told.
      if (same) return;
    } catch (_) {
      if (epoch != _epoch || asked < _shown) return;
      error = 'Could not load notifications. Try again.';
    }
    notifyListeners();
  }

  /// The reader is finished with [mention]. Any reader of the Swarm may, read
  /// only included, so this does not wait behind the composer's pending send.
  Future<bool> done(SuperTabMention mention) async {
    try {
      await controller.request(
        'POST',
        '$_path/commands',
        body: {
          'operationId': superTabOperationId(),
          'command': {'type': 'mention.done', 'mentionId': mention.id},
        },
      );
    } catch (_) {
      error = 'Could not mark it done. Try again.';
      notifyListeners();
      return false;
    }
    await load();
    unawaited(controller.refresh());
    return true;
  }
}

/// Whether [a] and [b] show the same tags the same way.
bool _sameMentions(List<SuperTabMention> a, List<SuperTabMention> b) {
  if (a.length != b.length) return false;
  for (var i = 0; i < a.length; i++) {
    final (x, y) = (a[i], b[i]);
    if (x.id != y.id ||
        x.projectId != y.projectId ||
        x.projectName != y.projectName ||
        x.conversationId != y.conversationId ||
        x.conversationTitle != y.conversationTitle ||
        x.messageId != y.messageId ||
        x.leadId != y.leadId ||
        x.leadName != y.leadName ||
        x.text != y.text ||
        x.createdAt != y.createdAt ||
        x.resolvedBy != y.resolvedBy) {
      return false;
    }
  }
  return true;
}

/// The reader's tags across the Swarm: Waiting first, then Earlier, newest
/// first in each. Opening one goes to its message.
class SuperTabNotifications extends StatefulWidget {
  const SuperTabNotifications({
    super.key,
    required this.mentions,
    required this.onOpen,
    this.now = DateTime.now,
    this.leading,
  });
  final SuperTabMentions mentions;
  final ValueChanged<SuperTabMention> onOpen;
  final DateTime Function() now;

  /// Shown first in the same list: the reader's decisions (decisions_view.dart).
  final Widget? leading;

  @override
  State<SuperTabNotifications> createState() => _SuperTabNotificationsState();
}

class _SuperTabNotificationsState extends State<SuperTabNotifications> {
  final _marking = <String>{};

  @override
  void initState() {
    super.initState();
    unawaited(widget.mentions.load());
  }

  Future<void> _done(SuperTabMention mention) async {
    setState(() => _marking.add(mention.id));
    await widget.mentions.done(mention);
    if (mounted) setState(() => _marking.remove(mention.id));
  }

  Widget _heading(String title) => Padding(
    padding: const EdgeInsets.fromLTRB(12, 16, 12, 4),
    child: SuperTabSectionHeading(title, endInset: 0),
  );

  Widget _empty(String text) => Padding(
    padding: const EdgeInsets.fromLTRB(16, 4, 16, 8),
    child: Text(text, style: DesktopChrome.metadata()),
  );

  Widget _row(SuperTabMention mention, {required bool waiting}) {
    final time = mention.createdAt;
    // An old Chat with PM an older server still sends opens the project's
    // chat, and is named so; every other place by its title.
    final c = widget.mentions.controller;
    final hidden = c.snapshot?.conversation(mention.conversationId);
    final place = hidden == null || !c.hiddenByBuddies(hidden)
        ? mention.conversationTitle
        : '#${c.snapshot?.projects.where((p) => p.id == mention.projectId).firstOrNull?.name ?? mention.projectName}';
    // A person who tagged the reader is named as they are now.
    final person = c.snapshot?.people
        .where((p) => p.id == mention.leadId)
        .firstOrNull;
    final author = person?.username ?? mention.leadName;
    // Who tagged, a person or a Lead: one face, in one place.
    final Widget? face = person != null
        ? SuperTabAvatar.person(person, size: 24)
        : switch (c.snapshot?.agent(mention.leadId ?? '')) {
            final lead? => SuperTabAvatar.agent(
              lead,
              name: mention.leadName,
              size: 24,
            ),
            null => null,
          };
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8, vertical: 1),
      child: Material(
        color: Colors.transparent,
        borderRadius: BorderRadius.circular(DesktopChrome.rowRadius),
        clipBehavior: Clip.antiAlias,
        child: InkWell(
          key: ValueKey('super-mention-${mention.id}'),
          onTap: () => widget.onOpen(mention),
          hoverColor: grid.AppSurface.hoverFill,
          focusColor: grid.AppSurface.hoverFill,
          child: Padding(
            padding: const EdgeInsets.fromLTRB(12, 10, 8, 10),
            child: Row(
              crossAxisAlignment: CrossAxisAlignment.start,
              children: [
                if (face != null)
                  Padding(
                    padding: const EdgeInsets.only(right: 10, top: 2),
                    child: face,
                  ),
                Expanded(
                  child: Column(
                    crossAxisAlignment: CrossAxisAlignment.start,
                    children: [
                      Row(
                        children: [
                          Flexible(
                            child: Text(
                              author,
                              maxLines: 1,
                              overflow: TextOverflow.ellipsis,
                              style: DesktopChrome.control(medium: waiting),
                            ),
                          ),
                          if (time != null) ...[
                            const SizedBox(width: 8),
                            Text(
                              superTabAgo(widget.now().difference(time)),
                              style: DesktopChrome.metadata(),
                            ),
                          ],
                        ],
                      ),
                      Text(
                        '${mention.projectName} · $place',
                        maxLines: 1,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.metadata(),
                      ),
                      const SizedBox(height: 2),
                      Text(
                        mention.text,
                        maxLines: 2,
                        overflow: TextOverflow.ellipsis,
                        style: DesktopChrome.control(
                          color: waiting ? null : DesktopChrome.muted,
                        ),
                      ),
                    ],
                  ),
                ),
                if (waiting)
                  Padding(
                    padding: const EdgeInsets.only(left: 8),
                    child: TextButton(
                      onPressed: _marking.contains(mention.id)
                          ? null
                          : () => unawaited(_done(mention)),
                      child: const Text('Mark done'),
                    ),
                  ),
              ],
            ),
          ),
        ),
      ),
    );
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.mentions,
    builder: (context, _) {
      grid.AppTheme.watch(context);
      final m = widget.mentions;
      return ListView(
        padding: const EdgeInsets.only(bottom: 16),
        children: [
          if (m.error case final error?)
            Padding(
              padding: const EdgeInsets.fromLTRB(16, 12, 16, 0),
              child: Row(
                children: [
                  Expanded(child: Text(error, style: DesktopChrome.control())),
                  TextButton(
                    onPressed: () => unawaited(m.load()),
                    child: const Text('Retry'),
                  ),
                ],
              ),
            ),
          ?widget.leading,
          _heading('Waiting'),
          if (m.waiting.isEmpty) _empty('Nothing waiting for you.'),
          for (final mention in m.waiting) _row(mention, waiting: true),
          _heading('Earlier'),
          if (m.earlier.isEmpty) _empty('Nothing earlier.'),
          for (final mention in m.earlier) _row(mention, waiting: false),
        ],
      );
    },
  );
}
