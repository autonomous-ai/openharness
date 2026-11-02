import 'dart:async';

import 'package:flutter/foundation.dart';

import 'model.dart';
import 'swarm_reader.dart';
import 'swarm_request.dart';
import 'swarm_session.dart';

/// The access an invitation gives, in the desktop's words
/// (`desktop/lib/super_tabs/sharing.dart`).
const swarmInviteRoles = <(String, String)>[
  ('collaborator', 'Can collaborate'),
  ('viewer', 'Can view'),
];

String swarmInviteRoleName(String role) =>
    role == 'viewer' ? 'Can view' : 'Can collaborate';

/// The address the desktop takes before it sends an invitation; the backend
/// takes up to 320 characters (commands.ts `invite.create`).
final swarmInviteEmail = RegExp(r'^[^\s@]+@[^\s@]+\.[^\s@]+$');
const swarmInviteEmailMax = 320;

/// Whether the person reading [reader] may invite people to its Swarm and
/// revoke their invitations: its owner alone, as on the desktop, which shows
/// Invite and Revoke only to them — and the backend lists invitations only to
/// them (model.ts). Nobody may once the read is taken away.
bool swarmMayInvite(SwarmReader? reader) {
  if (reader == null || reader.accessRevoked) return false;
  final owner = reader.snapshot?.ownerId;
  return owner != null && owner.isNotEmpty && owner == reader.accountId;
}

/// One invitation waiting to be accepted, as the Swarm's owner reads it.
/// Accepted or revoked, it leaves the Swarm's list (commands.ts).
class SwarmPendingInvite {
  const SwarmPendingInvite({
    required this.id,
    required this.email,
    required this.role,
    required this.expiresAt,
  });

  final String id, email, role;
  final DateTime expiresAt;

  /// [row] of a Swarm's invitations; null when it is not one.
  static SwarmPendingInvite? read(Map<String, dynamic> row) {
    if (row
        case {
          'id': final String id,
          'email': final String email,
          'role': final String role,
          'expiresAt': final num expiresAt,
        }
        when id.isNotEmpty &&
            email.contains('@') &&
            swarmInviteRoles.any((r) => r.$1 == role)) {
      return SwarmPendingInvite(
        id: id,
        email: email,
        role: role,
        expiresAt: DateTime.fromMillisecondsSinceEpoch(
          expiresAt.toInt(),
          isUtc: true,
        ),
      );
    }
    return null;
  }

  bool expired(DateTime now) => !expiresAt.isAfter(now);
}

/// The invitations [snapshot] holds, in the Swarm's order.
List<SwarmPendingInvite> swarmPendingInvites(SuperTabSnapshot snapshot) => [
  for (final row in snapshot.invitations) ?SwarmPendingInvite.read(row),
];

/// "Can view · Expires in 6 days", or "· Expired" once it can no longer be
/// accepted (an hourly sweep then takes it away).
String swarmInviteDetail(SwarmPendingInvite invite, DateTime now) {
  final left = invite.expiresAt.difference(now);
  final when = left <= Duration.zero
      ? 'Expired'
      : left.inDays >= 1
      ? 'Expires in ${_count(left.inDays + (left.inHours % 24 >= 12 ? 1 : 0), 'day')}'
      : left.inHours >= 1
      ? 'Expires in ${_count(left.inHours, 'hour')}'
      : 'Expires soon';
  return '${swarmInviteRoleName(invite.role)} · $when';
}

String _count(int n, String unit) => '$n $unit${n == 1 ? '' : 's'}';

/// What the person sends with the share sheet for [invite]: it carries no
/// link or secret. The invitation waits in the invited account's own app,
/// as the desktop's does.
String swarmInviteNote(String swarmName, SwarmPendingInvite invite) =>
    'I invited you to $swarmName in Harness. Open Harness signed in as '
    '${invite.email} to accept.';

/// [value] as Swarm [tabId]'s join link (`harness://swarm/join/<id>`, with
/// its token when the link has one), or null when it is anything else: the
/// desktop's `SwarmJoinLink.parse`, and its check that the link is this
/// Swarm's.
String? swarmJoinUrl(Object? value, String tabId) {
  if (value is! String || value.length > 240) return null;
  final uri = Uri.tryParse(value);
  if (uri == null ||
      uri.scheme != 'harness' ||
      uri.host != 'swarm' ||
      uri.hasPort ||
      uri.userInfo.isNotEmpty ||
      uri.hasFragment ||
      uri.pathSegments.length != 2 ||
      uri.pathSegments.first != 'join' ||
      uri.pathSegments.last != tabId ||
      !RegExp(r'^[A-Za-z0-9_-]{1,160}$').hasMatch(tabId)) {
    return null;
  }
  final query = uri.queryParametersAll;
  if (query.isEmpty && !uri.hasQuery) return value;
  final tokens = query['token'];
  if (query.length != 1 ||
      tokens == null ||
      tokens.length != 1 ||
      !RegExp(r'^[A-Za-z0-9_-]{43}$').hasMatch(tokens.single)) {
    return null;
  }
  return value;
}

/// The Swarm owner's invitations from the phone, over one read of the Swarm
/// ([reader]): invite someone by email (`invite.create`), revoke an
/// invitation (`invite.revoke`), and the Swarm's join link when its general
/// access has one — the desktop's Share Swarm, without changing the general
/// access, which stays on the desktop.
///
/// Each command goes under one receipt. An answer that never came keeps it,
/// and nothing else is sent until [check] sends it again: a retry is the same
/// invitation, never a second one. Nothing is sent, and no late answer is
/// taken, once the read is replaced, taken away or no longer the owner's
/// ([live]); the join link is held in memory only while this is.
class SwarmInvites extends ChangeNotifier {
  SwarmInvites({required this.session, required this.reader});

  final SwarmSession session;
  final SwarmReader reader;

  bool _disposed = false;

  /// What was sent and not yet answered either way.
  ({String operationId, Map<String, dynamic> command})? _pending;

  /// A command's answer is awaited.
  bool sending = false;

  /// Why the last command did not go through, as a sentence.
  String? error;

  /// The Swarm's join link, when its general access has one.
  String? link;

  /// The link is being read, or could not be: neither is "no link".
  bool readingLink = false, linkFailed = false;
  int _linkReads = 0;

  String get _path => '/api/super-tabs/${Uri.encodeComponent(reader.tabId)}';

  /// The read this was made over is still the session's, readable, and its
  /// person still the Swarm's owner.
  bool get live =>
      !_disposed &&
      identical(session.inbox.reader(reader.tabId), reader) &&
      swarmMayInvite(reader);

  /// A command is on its way or unconfirmed: nothing else is sent.
  bool get busy => sending || _pending != null;

  /// A command was sent and its answer never came.
  bool get unconfirmed => _pending != null && !sending;

  /// Invites [email] with [role]. True once the backend took it.
  Future<bool> invite(String email, String role) => _send({
    'type': 'invite.create',
    'email': email.trim(),
    'role': role,
    // As the desktop sends it: an invitation lands in the Swarm, not in a
    // chat, and the backend keeps this legacy landing (commands.ts).
    'conversationId': 'lead',
  });

  /// Revokes [invite], unless it already left the list (accepted or revoked
  /// meanwhile): there is nothing to revoke then.
  Future<bool> revoke(SwarmPendingInvite invite) {
    final snapshot = reader.snapshot;
    if (snapshot == null ||
        !swarmPendingInvites(snapshot).any((i) => i.id == invite.id)) {
      return Future.value(false);
    }
    return _send({'type': 'invite.revoke', 'inviteId': invite.id});
  }

  /// Sends the unconfirmed command again under its receipt.
  Future<bool> check() => _pending == null ? Future.value(false) : _send(null);

  Future<bool> _send(Map<String, dynamic>? command) async {
    if (!live || sending || (command != null && _pending != null)) {
      return false;
    }
    final pending = _pending ??= (
      operationId: superTabOperationId(),
      command: command!,
    );
    sending = true;
    error = null;
    notifyListeners();
    try {
      await reader.request(
        'POST',
        '$_path/commands',
        body: {'operationId': pending.operationId, 'command': pending.command},
      );
      if (!live) return false;
      _pending = null;
      unawaited(reader.refresh());
      return true;
    } on SuperTabFailure catch (failure) {
      if (!live) return false;
      if (_refused(failure)) {
        _pending = null;
        error = _why(failure, pending.command['type']);
      } else {
        error = _unconfirmed(pending.command['type']);
      }
      return false;
    } catch (_) {
      if (live) error = _unconfirmed(pending.command['type']);
      return false;
    } finally {
      if (!_disposed) {
        sending = false;
        notifyListeners();
      }
    }
  }

  /// The backend answered and said no: the command did not run. No answer,
  /// a server fault, a timeout or a rate limit leaves it unknown.
  static bool _refused(SuperTabFailure failure) =>
      failure.statusCode >= 400 &&
      failure.statusCode < 500 &&
      !const {408, 429}.contains(failure.statusCode);

  static String _unconfirmed(Object? type) => type == 'invite.revoke'
      ? 'Could not confirm the revoke. Check it again.'
      : 'Could not confirm this invitation. Check it again.';

  static String _why(SuperTabFailure failure, Object? type) =>
      switch (failure.code) {
        'OWNER_REQUIRED' ||
        'FORBIDDEN' => 'Only the Swarm’s owner can manage invitations.',
        'ALREADY_MEMBER' => 'This person is already in this Swarm.',
        // A server without these commands. Any other refusal, an address it
        // will not take included, is the server's own words.
        'UNKNOWN_COMMAND' =>
          type == 'invite.revoke'
              ? 'This Swarm’s server can’t revoke invitations from here.'
              : 'This Swarm’s server can’t send invitations from here.',
        _ => failure.message,
      };

  /// Reads the Swarm's join link. A server without sharing links has none;
  /// a read that fails says so, and is tried again only when asked.
  Future<void> readLink() async {
    if (!live) return;
    final read = ++_linkReads;
    readingLink = true;
    linkFailed = false;
    notifyListeners();
    String? found;
    var failed = false;
    try {
      final answer = superTabMap(await reader.request('GET', '$_path/sharing'));
      found = swarmJoinUrl(answer['joinUrl'], reader.tabId);
    } on SuperTabFailure catch (failure) {
      failed = failure.statusCode != 404 && failure.code != 'NOT_FOUND';
    } catch (_) {
      failed = true;
    }
    if (!live || read != _linkReads) return;
    link = found;
    linkFailed = failed;
    readingLink = false;
    notifyListeners();
  }

  @override
  void dispose() {
    _disposed = true;
    link = null;
    _pending = null;
    super.dispose();
  }
}
