import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:share_plus/share_plus.dart';

import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/app_type.dart';
import 'package:harness_mobile/theme/app_theme.dart' show AppColors;

import 'swarm_invites.dart';
import 'swarm_leaderboard.dart' show SwarmProjectSheetFrame, swarmSheetRoute;
import 'swarm_reader.dart';
import 'swarm_row.dart';
import 'swarm_session.dart';
import 'swarm_style.dart';

/// Hands [text] to the phone's share sheet, anchored at [origin] for an iPad,
/// where it is a popover.
typedef SwarmShare = Future<void> Function(String text, {Rect? origin});

Future<void> swarmShareSheet(String text, {Rect? origin}) async {
  try {
    await SharePlus.instance.share(
      ShareParams(text: text, sharePositionOrigin: origin),
    );
  } catch (_) {
    // No share sheet came up: the person can press Share again.
  }
}

/// Invite people, as the desktop's Humans board has it: shown only to the
/// Swarm's owner, the one person who may invite there ([swarmMayInvite]), and
/// gone as soon as they no longer may. It opens [SwarmInvitesSheet] over
/// [reader], once at a time.
class SwarmInviteButton extends StatefulWidget {
  const SwarmInviteButton({
    super.key,
    required this.session,
    required this.reader,
    this.share = swarmShareSheet,
  });

  final SwarmSession session;
  final SwarmReader reader;
  final SwarmShare share;

  @override
  State<SwarmInviteButton> createState() => _SwarmInviteButtonState();
}

class _SwarmInviteButtonState extends State<SwarmInviteButton> {
  ModalRoute<void>? _open;

  Future<void> _show() async {
    if (_open != null || !swarmMayInvite(widget.reader)) return;
    final route = swarmSheetRoute<void>(
      context,
      builder: (_) => SwarmInvitesSheet(
        session: widget.session,
        reader: widget.reader,
        share: widget.share,
      ),
    );
    _open = route;
    await Navigator.of(context).push(route);
    if (identical(_open, route)) _open = null;
  }

  @override
  Widget build(BuildContext context) => ListenableBuilder(
    listenable: widget.reader,
    builder: (context, _) => swarmMayInvite(widget.reader)
        ? SwarmIconButton(
            key: const ValueKey('swarm-invite-people'),
            icon: LucideIcons.userPlus300,
            label: 'Invite people',
            onPressed: () => unawaited(_show()),
          )
        : const SizedBox.shrink(),
  );
}

/// The Swarm owner's Share Swarm on the phone, from the leaderboard's Invite
/// people:
/// the desktop's (`desktop/lib/super_tabs/sharing.dart`) email, access and
/// Invite; the invitations waiting, each with its access and when it expires,
/// to share a note about or revoke, after a confirmation; and the Swarm's
/// join link to share, when its general access has one.
///
/// It closes, keeping nothing typed or read, once the account's session, the
/// Swarm's read, or the person's being its owner is gone.
class SwarmInvitesSheet extends StatefulWidget {
  const SwarmInvitesSheet({
    super.key,
    required this.session,
    required this.reader,
    this.share = swarmShareSheet,
    this.now = DateTime.now,
  });

  final SwarmSession session;

  /// The Swarm's read as the sheet opened: one replaced since is another
  /// read, and the sheet goes rather than send through either.
  final SwarmReader reader;
  final SwarmShare share;
  final DateTime Function() now;

  @override
  State<SwarmInvitesSheet> createState() => _SwarmInvitesSheetState();
}

class _SwarmInvitesSheetState extends State<SwarmInvitesSheet> {
  final _email = TextEditingController();
  String _role = 'collaborator';
  String? _emailError;
  late final SwarmInvites _invites;
  bool _closing = false;

  /// The confirmation up over the sheet, if any: it goes with the sheet.
  ModalRoute<void>? _confirm;

  @override
  void initState() {
    super.initState();
    _invites = SwarmInvites(session: widget.session, reader: widget.reader);
    _email.addListener(_edited);
    if (_invites.live) unawaited(_invites.readLink());
  }

  void _edited() {
    if (mounted) setState(() {});
  }

  @override
  void dispose() {
    _email.dispose();
    _invites.dispose();
    super.dispose();
  }

  /// Closes the sheet once, after the frame it went blank in, with the
  /// confirmation over it.
  void _close() {
    if (_closing) return;
    _closing = true;
    // What was typed goes with it, without drawing again mid-frame.
    _email
      ..removeListener(_edited)
      ..clear();
    final confirm = _confirm;
    _confirm = null;
    WidgetsBinding.instance.addPostFrameCallback((_) {
      if (confirm != null && confirm.isActive) {
        confirm.navigator?.removeRoute(confirm);
      }
      if (!mounted) return;
      final route = ModalRoute.of(context);
      if (route == null || !route.isActive) return;
      if (route.isCurrent) {
        Navigator.of(context).pop();
      } else {
        Navigator.of(context).removeRoute(route);
      }
    });
  }

  Future<void> _invite() async {
    if (_invites.busy || !_invites.live) return;
    final email = _email.text.trim();
    if (!swarmInviteEmail.hasMatch(email)) {
      setState(() => _emailError = 'Enter an email address.');
      return;
    }
    setState(() => _emailError = null);
    final sent = await _invites.invite(email, _role);
    // Typed over meanwhile: what was typed since stays.
    if (sent && mounted && !_closing && _email.text.trim() == email) {
      _email.clear();
    }
  }

  Future<void> _revoke(SwarmPendingInvite invite) async {
    if (_invites.busy || !_invites.live) return;
    final route = DialogRoute<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: Text(
          'Revoke invitation?',
          style: AppType.heading(color: AppPalette.textPrimary),
        ),
        content: Text(
          '${invite.email} will no longer be able to join with it.',
          style: AppType.body(color: AppPalette.textSecondary),
        ),
        actions: [
          SwarmButton(
            key: const ValueKey('swarm-invite-revoke-cancel'),
            label: 'Cancel',
            style: SwarmButtonStyle.link,
            onPressed: () => Navigator.of(context).pop(false),
          ),
          SwarmButton(
            key: const ValueKey('swarm-invite-revoke-confirm'),
            label: 'Revoke',
            style: SwarmButtonStyle.fill,
            onPressed: () => Navigator.of(context).pop(true),
          ),
        ],
      ),
    );
    _confirm = route;
    final revoke = await Navigator.of(context).push(route);
    if (identical(_confirm, route)) _confirm = null;
    // Gone while it asked: nothing is sent.
    if (revoke != true || !mounted || _closing) return;
    await _invites.revoke(invite);
  }

  Rect? _origin(BuildContext context) {
    final box = context.findRenderObject() as RenderBox?;
    return box == null || !box.attached
        ? null
        : box.localToGlobal(Offset.zero) & box.size;
  }

  void _share(BuildContext context, String text) {
    if (!_invites.live) return;
    unawaited(widget.share(text, origin: _origin(context)));
  }

  Future<void> _pickRole() async {
    final role = await showModalBottomSheet<String>(
      context: context,
      backgroundColor: AppGlass.rowFill,
      shape: AppControl.sheetShape,
      showDragHandle: true,
      builder: (context) => SafeArea(
        child: Padding(
          padding: const EdgeInsets.fromLTRB(
            AppSpace.m,
            0,
            AppSpace.m,
            AppSpace.m,
          ),
          child: SwarmGroup(
            children: [
              for (final (value, label) in swarmInviteRoles)
                SwarmRow(
                  key: ValueKey('swarm-invite-role-$value'),
                  title: label,
                  trailing: value == _role
                      ? Icon(
                          LucideIcons.check300,
                          size: 18,
                          color: AppPalette.swarmAccent,
                        )
                      : const SizedBox.shrink(),
                  onTap: () => Navigator.of(context).pop(value),
                ),
            ],
          ),
        ),
      ),
    );
    if (role != null && mounted && !_closing) setState(() => _role = role);
  }

  @override
  Widget build(BuildContext context) {
    AppTheme.watch(context);
    final session = widget.session;
    return ListenableBuilder(
      listenable: Listenable.merge([session.inbox, widget.reader, _invites]),
      builder: (context, _) {
        // Signed out, another account, Swarm off, the read replaced or taken
        // away, or the person no longer the Swarm's owner: nothing of it
        // stays, and the sheet goes.
        if (_closing || SwarmScope.of(context) != session || !_invites.live) {
          _close();
          return const SizedBox.shrink();
        }
        final snapshot = widget.reader.snapshot!;
        final now = widget.now();
        final invites = swarmPendingInvites(snapshot);
        final busy = _invites.busy;
        final field = InputDecoration(
          hintText: 'Email address',
          hintStyle: TextStyle(color: AppPalette.textFaint),
          filled: true,
          fillColor: AppPalette.swarmField,
          border: OutlineInputBorder(
            borderRadius: BorderRadius.circular(AppControl.radius),
            borderSide: BorderSide.none,
          ),
        );
        return SwarmProjectSheetFrame(
          title: 'Share Swarm',
          closeKey: 'swarm-invites-close',
          child: ListView(
            key: const ValueKey('swarm-invites'),
            padding: EdgeInsets.fromLTRB(
              AppSpace.m,
              AppSpace.s,
              AppSpace.m,
              MediaQuery.viewInsetsOf(context).bottom +
                  MediaQuery.paddingOf(context).bottom +
                  AppSpace.xl,
            ),
            children: [
              TextField(
                key: const ValueKey('swarm-invite-email'),
                controller: _email,
                enabled: !busy,
                autocorrect: false,
                enableSuggestions: false,
                keyboardType: TextInputType.emailAddress,
                textInputAction: TextInputAction.send,
                inputFormatters: [
                  LengthLimitingTextInputFormatter(swarmInviteEmailMax),
                ],
                onSubmitted: (_) => unawaited(_invite()),
                style: AppType.body(color: AppPalette.textPrimary),
                decoration: field,
              ),
              if (_emailError case final error?)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpace.xs,
                    AppSpace.xs,
                    AppSpace.xs,
                    0,
                  ),
                  child: SwarmRow.line(
                    error,
                    key: const ValueKey('swarm-invite-email-error'),
                    color: AppColors.danger,
                  ),
                ),
              const SizedBox(height: AppSpace.s),
              Row(
                children: [
                  SwarmButton(
                    key: const ValueKey('swarm-invite-role'),
                    label: swarmInviteRoleName(_role),
                    style: SwarmButtonStyle.link,
                    icon: LucideIcons.chevronDown300,
                    onPressed: busy ? null : () => unawaited(_pickRole()),
                  ),
                  const Spacer(),
                  SwarmButton(
                    key: const ValueKey('swarm-invite-send'),
                    label: 'Invite',
                    style: SwarmButtonStyle.fill,
                    busy: _invites.sending,
                    busyLabel: 'Sending…',
                    onPressed: busy || _email.text.trim().isEmpty
                        ? null
                        : () => unawaited(_invite()),
                  ),
                ],
              ),
              if (_invites.error case final error?)
                Padding(
                  padding: const EdgeInsets.fromLTRB(
                    AppSpace.xs,
                    AppSpace.s,
                    AppSpace.xs,
                    0,
                  ),
                  child: SwarmRow.line(
                    error,
                    key: const ValueKey('swarm-invite-error'),
                    lines: 3,
                  ),
                ),
              if (_invites.unconfirmed)
                Align(
                  alignment: Alignment.centerLeft,
                  child: SwarmButton(
                    key: const ValueKey('swarm-invite-check'),
                    label: 'Check pending invitation',
                    style: SwarmButtonStyle.link,
                    onPressed: () => unawaited(_invites.check()),
                  ),
                ),
              SwarmCaption(
                'Invited',
                key: const ValueKey('swarm-invites-caption'),
              ),
              if (invites.isEmpty)
                Padding(
                  padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
                  child: SwarmRow.line(
                    'No invitations waiting.',
                    key: const ValueKey('swarm-invites-none'),
                  ),
                )
              else
                SwarmGroup(
                  children: [
                    for (final invite in invites)
                      _InviteRow(
                        key: ValueKey('swarm-invite-${invite.id}'),
                        invite: invite,
                        detail: swarmInviteDetail(invite, now),
                        expired: invite.expired(now),
                        busy: busy,
                        onShare: (context) => _share(
                          context,
                          swarmInviteNote(snapshot.name, invite),
                        ),
                        onRevoke: () => unawaited(_revoke(invite)),
                      ),
                  ],
                ),
              ..._link(context),
            ],
          ),
        );
      },
    );
  }

  /// The Swarm's join link, to share, when its general access has one; why
  /// it could not be read, with Try again. Nothing while it is read, and
  /// nothing when there is none: the general access is set on the desktop.
  List<Widget> _link(BuildContext context) {
    if (_invites.link case final link?) {
      return [
        const SizedBox(height: AppSpace.l),
        Builder(
          builder: (context) => Align(
            alignment: Alignment.centerLeft,
            child: SwarmButton(
              key: const ValueKey('swarm-invite-share-link'),
              label: 'Share link',
              icon: LucideIcons.link2300,
              onPressed: _invites.busy ? null : () => _share(context, link),
            ),
          ),
        ),
      ];
    }
    if (_invites.linkFailed && !_invites.readingLink) {
      return [
        const SizedBox(height: AppSpace.l),
        Row(
          children: [
            Expanded(
              child: SwarmRow.line(
                'Could not read this Swarm’s link.',
                key: const ValueKey('swarm-invite-link-error'),
                lines: 2,
              ),
            ),
            SwarmButton(
              key: const ValueKey('swarm-invite-link-retry'),
              label: 'Try again',
              onPressed: () => unawaited(_invites.readLink()),
            ),
          ],
        ),
      ];
    }
    return const [];
  }
}

/// One invitation waiting: the address over its access and when it expires,
/// then Share and Revoke.
class _InviteRow extends StatelessWidget {
  const _InviteRow({
    super.key,
    required this.invite,
    required this.detail,
    required this.expired,
    required this.busy,
    required this.onShare,
    required this.onRevoke,
  });

  final SwarmPendingInvite invite;
  final String detail;
  final bool expired, busy;
  final void Function(BuildContext context) onShare;
  final VoidCallback onRevoke;

  @override
  Widget build(BuildContext context) => Padding(
    padding: const EdgeInsets.fromLTRB(AppSpace.l, AppSpace.m, 0, AppSpace.m),
    child: Row(
      children: [
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            mainAxisSize: MainAxisSize.min,
            children: [
              Text(
                invite.email,
                maxLines: 1,
                overflow: TextOverflow.ellipsis,
                style: AppType.label(color: AppPalette.textPrimary),
              ),
              const SizedBox(height: 2),
              SwarmRow.line(
                detail,
                key: ValueKey('swarm-invite-detail-${invite.id}'),
                color: expired ? AppColors.danger : null,
              ),
            ],
          ),
        ),
        // An expired invitation can no longer be accepted: nothing to tell.
        if (!expired)
          Builder(
            builder: (context) => SwarmButton(
              key: ValueKey('swarm-invite-share-${invite.id}'),
              label: 'Share',
              style: SwarmButtonStyle.link,
              onPressed: busy ? null : () => onShare(context),
            ),
          ),
        SwarmButton(
          key: ValueKey('swarm-invite-revoke-${invite.id}'),
          label: 'Revoke',
          style: SwarmButtonStyle.link,
          onPressed: busy ? null : onRevoke,
        ),
      ],
    ),
  );
}
