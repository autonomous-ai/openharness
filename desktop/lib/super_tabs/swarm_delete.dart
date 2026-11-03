import 'dart:async';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/app_dialog.dart';
import '../state/app_state.dart';
import '../widgets/desktop_chrome.dart';
import 'controller.dart';
import 'dialog_scope.dart';
import 'model.dart';
import 'swarm_switcher.dart' show PersonalSwarm;

/// Deleting a Swarm (Dee, 10-31: "owners can delete a Swarm, like deleting a
/// Slack workspace"). Its owner picks Delete in the Swarm dropdown and types
/// its name; everyone loses it at once. For 7 days it is listed under the
/// dropdown's Restore rows, its owner's alone (backend superTabs/deletion.ts).

/// One deleted Swarm its owner can still restore.
typedef DeletedSwarm = ({String id, String name, DateTime purgeAt});

/// The signed-in owner's deleted Swarms, read when the dropdown opens and
/// after a delete; and restoring one.
class DeletedSwarms extends ChangeNotifier {
  DeletedSwarms._(this.app);
  static final _of = Expando<DeletedSwarms>();
  static DeletedSwarms of(AppNotifier app) => _of[app] ??= DeletedSwarms._(app);

  final AppNotifier app;
  String? _account;
  List<DeletedSwarm> _items = const [];
  int _reads = 0;
  final _restoring = <String>{};

  /// Why the last restore failed, for the Swarm it was for.
  ({String id, String message})? restoreError;

  /// The signed-in account's list, as last read for it; never another's.
  List<DeletedSwarm> get items =>
      _account != null && _account == app.currentUser?.id ? _items : const [];
  bool restoring(String id) => _restoring.contains(id);

  /// Reads the list again. An answer for an account no longer signed in, or
  /// overtaken by a later read, changes nothing. A failed read keeps what
  /// was shown; a backend from before deletion lists nothing.
  Future<void> read() async {
    final account = app.currentUser?.id;
    if (account == null) return;
    final read = ++_reads;
    try {
      final answer = await app.superTabs.map('GET', '/api/super-tabs/deleted');
      if (read != _reads || account != app.currentUser?.id) return;
      _account = account;
      _items = parseDeletedSwarms(answer);
    } on SuperTabFailure catch (failure) {
      if (read != _reads || account != app.currentUser?.id) return;
      if (failure.statusCode != 404) return;
      _account = account;
      _items = const [];
    } catch (_) {
      return;
    }
    notifyListeners();
  }

  /// Restores [id] and shows it in Swarm tab [tab]; the error for the row
  /// otherwise. One restore per Swarm at a time.
  Future<bool> restore(String id, {String? tab}) async {
    final account = app.currentUser?.id;
    if (account == null || !_restoring.add(id)) return false;
    restoreError = null;
    notifyListeners();
    try {
      await app.superTabs.request(
        'POST',
        '/api/super-tabs/${Uri.encodeComponent(id)}/commands',
        body: {
          'operationId': superTabOperationId(),
          'command': {'type': 'swarm.restore'},
        },
      );
      if (account != app.currentUser?.id) return false;
      final name = _items.where((s) => s.id == id).firstOrNull?.name;
      _items = [
        for (final s in _items)
          if (s.id != id) s,
      ];
      // The view that lost it is let go, so the next open reads it afresh.
      app.superTabs.release(id);
      PersonalSwarm.of(app).regained(id);
      await app.superTabs.refreshTabs();
      if (tab != null && account == app.currentUser?.id) {
        app.showSuperTabIn(tab, id, name ?? 'Swarm');
      }
      return true;
    } catch (failure) {
      if (account == app.currentUser?.id) {
        restoreError = (
          id: id,
          message: failure is SuperTabFailure && failure.statusCode == 404
              ? 'This Swarm can no longer be restored.'
              : 'Could not restore this Swarm. Try again.',
        );
        // Gone for good, or restored elsewhere: the list says which.
        unawaited(read());
      }
      return false;
    } finally {
      _restoring.remove(id);
      notifyListeners();
    }
  }
}

/// The deleted Swarms a `GET /api/super-tabs/deleted` answer names, newest
/// first. A row it cannot read is left out rather than failing the list.
List<DeletedSwarm> parseDeletedSwarms(Map<String, dynamic> answer) {
  final tabs = answer['tabs'];
  if (tabs is! List) return const [];
  return [
    for (final raw in tabs)
      if (raw is Map &&
          raw['id'] is String &&
          raw['name'] is String &&
          raw['purgeAt'] is num)
        (
          id: raw['id'] as String,
          name: raw['name'] as String,
          purgeAt: DateTime.fromMillisecondsSinceEpoch(
            (raw['purgeAt'] as num).toInt(),
          ),
        ),
  ];
}

/// "7 days left" just after a delete, "1 day left", or "Less than a day
/// left" until [purgeAt]: whole days to the nearest, a last day said so.
String restoreTimeLeft(DateTime purgeAt, DateTime now) {
  final left = purgeAt.difference(now);
  if (left < const Duration(days: 1)) return 'Less than a day left';
  final days = (left.inMinutes / Duration.minutesPerDay).round();
  return days == 1 ? '1 day left' : '$days days left';
}

/// The people and agents who lose this Swarm, as the open Swarm says.
String swarmDeleteCounts(SuperTabSnapshot snapshot) {
  String count(int n, String one, String many) => '$n ${n == 1 ? one : many}';
  return '${count(snapshot.people.length, 'person', 'people')}, '
      '${count(snapshot.agents.length, 'agent', 'agents')}';
}

/// Asks the owner to type the Swarm's name, then deletes it. True once the
/// server confirmed. Closes by itself if the Swarm stops being theirs.
Future<bool> showDeleteSwarmDialog(
  BuildContext context,
  SuperTabController c,
) async {
  final deleted = await showAppDialog<bool>(
    context: context,
    builder: (context) => SuperTabDialogScope(
      controller: c,
      child: _DeleteSwarmDialog(controller: c),
    ),
  );
  return deleted ?? false;
}

class _DeleteSwarmDialog extends StatefulWidget {
  const _DeleteSwarmDialog({required this.controller});
  final SuperTabController controller;

  @override
  State<_DeleteSwarmDialog> createState() => _DeleteSwarmDialogState();
}

class _DeleteSwarmDialogState extends State<_DeleteSwarmDialog> {
  final _typed = TextEditingController();
  bool _busy = false;

  /// The name as it was when the dialog opened: a rename meanwhile does not
  /// make the typed name delete a Swarm it no longer names.
  late final String _name = widget.controller.snapshot?.name.trim() ?? '';

  SuperTabController get c => widget.controller;

  @override
  void initState() {
    super.initState();
    _typed.addListener(() => setState(() {}));
  }

  @override
  void dispose() {
    _typed.dispose();
    super.dispose();
  }

  bool get _pending {
    final pending = c.pendingCommand;
    return pending?['type'] == 'swarm.delete';
  }

  Future<void> _delete() async {
    setState(() => _busy = true);
    final result = _pending
        ? await c.retry()
        : await c.command({'type': 'swarm.delete', 'name': _typed.text.trim()});
    if (!mounted) return;
    if (result != null) {
      Navigator.pop(context, true);
    } else {
      setState(() => _busy = false);
    }
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: c,
    builder: (context, _) {
      final snapshot = c.snapshot;
      final matches = _name.isNotEmpty && _typed.text.trim() == _name;
      final canDelete =
          !_busy &&
          !c.saving &&
          c.isOwner &&
          (_pending || (!c.hasPendingAction && matches));
      return PopScope(
        canPop: !_busy,
        child: AlertDialog(
          key: const ValueKey('swarm-delete-dialog'),
          title: Text('Delete “$_name”?'),
          content: SizedBox(
            width: 420,
            child: SingleChildScrollView(
              child: Column(
                mainAxisSize: MainAxisSize.min,
                crossAxisAlignment: CrossAxisAlignment.start,
                children: [
                  Text(
                    'Everyone loses access at once: '
                    '${snapshot == null ? '' : swarmDeleteCounts(snapshot)}.',
                    key: const ValueKey('swarm-delete-counts'),
                    style: DesktopChrome.text(),
                  ),
                  const SizedBox(height: grid.AppDesktop.controlGap),
                  Text(
                    'Its chats and files are removed after 7 days. Until '
                    'then you can restore it from the Swarm menu, without '
                    'its agents and machines.',
                    style: DesktopChrome.text(),
                  ),
                  const SizedBox(height: grid.AppDesktop.groupGap),
                  Text(
                    'Type the Swarm’s name to confirm',
                    style: DesktopChrome.metadata(),
                  ),
                  const SizedBox(height: grid.AppDesktop.controlGap),
                  TextField(
                    key: const ValueKey('swarm-delete-name'),
                    controller: _typed,
                    autofocus: true,
                    enabled: !_busy && !_pending,
                    decoration: InputDecoration(hintText: _name),
                    onSubmitted: (_) {
                      if (canDelete) unawaited(_delete());
                    },
                  ),
                  if (c.operationError != null) ...[
                    const SizedBox(height: grid.AppDesktop.controlGap),
                    Text(
                      c.operationError!,
                      key: const ValueKey('swarm-delete-error'),
                      style: DesktopChrome.metadata(
                        color: grid.AppPalette.dangerFill,
                      ),
                    ),
                  ],
                ],
              ),
            ),
          ),
          actions: [
            TextButton(
              key: const ValueKey('swarm-delete-cancel'),
              onPressed: _busy ? null : () => Navigator.pop(context, false),
              child: const Text('Cancel'),
            ),
            FilledButton(
              key: const ValueKey('swarm-delete-confirm'),
              style: grid.dangerButtonStyle(),
              onPressed: canDelete ? () => unawaited(_delete()) : null,
              child: Text(_pending ? 'Retry' : 'Delete Swarm'),
            ),
          ],
        ),
      );
    },
  );
}
