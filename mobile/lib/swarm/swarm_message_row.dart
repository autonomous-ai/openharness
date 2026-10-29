import 'dart:async';

import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:lucide_icons_flutter/lucide_icons.dart';
import 'package:url_launcher/url_launcher.dart';

import 'package:harness_mobile/phone/tty.dart';
import 'package:harness_mobile/phone/tty_controls.dart';
import 'package:harness_mobile/shared/theme/app_ink.dart';
import 'package:harness_mobile/shared/theme/app_space.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';

import 'model.dart';
import 'swarm_attachment.dart';
import 'swarm_face.dart';
import 'swarm_ship_row.dart';

/// The host the backend serves message files from: a link anywhere else is
/// not opened (the desktop's `attachmentLink`).
const swarmAttachmentHost = String.fromEnvironment(
  'SUPER_TAB_ATTACHMENTS_HOST',
  defaultValue: 'cdn.harness.autonomous.ai',
);

/// [url] as a link to open, or null unless it is https on
/// [swarmAttachmentHost]: a message's url is whatever its sender's row says.
Uri? swarmAttachmentLink(String url) {
  final link = Uri.tryParse(url);
  return link != null &&
          link.scheme == 'https' &&
          link.host == swarmAttachmentHost
      ? link
      : null;
}

/// The chat's prose in the app's own face, as prototype v2 draws it: the
/// messages, quotes, names and the field. Times, roles and day dividers stay
/// in the terminal's.
TextStyle swarmChatText(
  double size, {
  Color? color,
  FontWeight weight = FontWeight.w400,
  double height = 1.35,
}) => TextStyle(
  fontSize: size,
  height: height,
  color: color ?? AppPalette.textPrimary,
  fontWeight: weight,
);

/// The hairline around the chat's cards, picker and field.
Color swarmChatHair(Tty tty) => tty.text.withValues(alpha: 0.12);

/// The ground of a card in the chat: a decision, the picker, a file.
Color swarmChatCard(Tty tty) =>
    Color.alphaBlend(tty.text.withValues(alpha: 0.05), tty.ground);

/// The names an @mention in a message is marked for, as the desktop and the
/// prototype mark them: the pattern that finds them is made once for every
/// message drawn with them.
class SwarmMentions {
  SwarmMentions(List<String> names)
    : names = List.unmodifiable(names),
      _pattern = names.isEmpty
          ? null
          : RegExp(
              // Longest first, so "@Nova2" is not read as "@Nova".
              '(?<![\\w@])@(?:${([...names]..sort((a, b) => b.length.compareTo(a.length))).map(RegExp.escape).join('|')})(?![\\w])',
              caseSensitive: false,
            );

  final List<String> names;
  final RegExp? _pattern;

  /// [text] with each @mention of one of [names] marked.
  TextSpan span(String text, TextStyle style) {
    final pattern = _pattern;
    if (pattern == null || !text.contains('@')) {
      return TextSpan(text: text, style: style);
    }
    return TextSpan(style: style, children: _marked(text, pattern));
  }
}

List<InlineSpan> _marked(String text, RegExp pattern) {
  final spans = <InlineSpan>[];
  var at = 0;
  for (final match in pattern.allMatches(text)) {
    if (match.start > at) {
      spans.add(TextSpan(text: text.substring(at, match.start)));
    }
    spans.add(
      TextSpan(
        text: match[0],
        style: TextStyle(
          color: AppPalette.accentOnSurface,
          backgroundColor: AppPalette.accentOnSurface.withValues(alpha: 0.13),
          fontWeight: FontWeight.w500,
        ),
      ),
    );
    at = match.end;
  }
  if (at < text.length) spans.add(TextSpan(text: text.substring(at)));
  return spans;
}

/// A message's frame: avatar, then who wrote it, their role and [trailing]
/// (its time) — none of it for a follow-up — then [body]. With [onAvatar],
/// the avatar and the room beside it are one thumb-sized target.
class SwarmMessageFrame extends StatelessWidget {
  const SwarmMessageFrame({
    super.key,
    required this.avatar,
    required this.grouped,
    required this.header,
    required this.body,
    this.onAvatar,
    this.avatarKey,
    this.avatarLabel,
  });

  final Widget avatar;
  final bool grouped;
  final Widget header;
  final List<Widget> body;
  final VoidCallback? onAvatar;
  final Key? avatarKey;

  /// What the avatar's target is read as.
  final String? avatarLabel;

  /// The avatar's column: the avatar and the room after it, a thumb wide.
  static const double column = 44;

  /// Around a message in the chat's column, a post's and a skeleton's too;
  /// one [grouped] under the message before it leaves no room above.
  static EdgeInsets padding({bool grouped = false}) => EdgeInsets.fromLTRB(
    AppSpace.s,
    grouped ? 0 : AppSpace.s,
    AppSpace.s,
    AppSpace.s,
  );

  /// Between a message's header and its words.
  static const double bodyGap = AppSpace.xs;

  @override
  Widget build(BuildContext context) => Row(
    crossAxisAlignment: CrossAxisAlignment.start,
    children: [
      SizedBox(
        width: column,
        child: grouped
            ? null
            : onAvatar == null
            ? Align(alignment: Alignment.topLeft, child: avatar)
            : Semantics(
                button: true,
                label: avatarLabel,
                child: GestureDetector(
                  key: avatarKey,
                  behavior: HitTestBehavior.opaque,
                  onTap: onAvatar,
                  child: SizedBox(
                    height: column,
                    child: Align(alignment: Alignment.topLeft, child: avatar),
                  ),
                ),
              ),
      ),
      Expanded(
        child: Column(
          crossAxisAlignment: CrossAxisAlignment.start,
          children: [if (!grouped) header, ...body],
        ),
      ),
    ],
  );
}

/// One message: avatar, who wrote it, their role and when — none of it for a
/// follow-up — then what it answers, its text, its files and its
/// [reactions]. A tap opens its actions, a long-press [onLongPress]; lit for
/// a moment when a quote leads to it.
class SwarmMessageRow extends StatelessWidget {
  const SwarmMessageRow({
    super.key,
    required this.message,
    required this.name,
    required this.look,
    required this.role,
    required this.mentions,
    required this.grouped,
    required this.lit,
    this.followed = false,
    required this.quote,
    required this.actions,
    required this.onTap,
    required this.onReply,
    this.onAuthor,
    this.reactions,
    this.below,
    this.onLongPress,
  });

  final SuperTabMessage message;
  final String name;

  /// What its author wears.
  final SwarmLook look;
  final String? role;

  final SwarmMentions mentions;
  final bool grouped, lit, actions;

  /// The row a quote led to: lit, then fading. Only it animates — a fade on
  /// every row would give each its own ticker.
  final bool followed;
  final Widget? quote;
  final VoidCallback onTap;

  /// Null where the person cannot post.
  final VoidCallback? onReply;

  /// Who wrote it, in a sheet; null where nothing opens.
  final VoidCallback? onAuthor;

  /// Drawn under its text and files: its reaction counts.
  final Widget? reactions;

  /// Under its reactions: what the person may do with it besides Reply — the
  /// PM's private line answered in the project chat.
  final Widget? below;

  /// Null where the person cannot post: picks a reaction.
  final VoidCallback? onLongPress;

  @override
  Widget build(BuildContext context) {
    // A ship line is a card, not a message from its author.
    if (swarmShips(message)) {
      return SwarmShipRow(
        key: ValueKey('swarm-message-${message.id}'),
        message: message,
      );
    }
    // A row kept as it was is not built again: it follows a theme or font
    // change itself.
    AppTheme.watch(context);
    final tty = Tty.of(context);
    final at = message.createdAt?.toLocal();
    String two(int n) => n.toString().padLeft(2, '0');
    final key = ValueKey('swarm-message-${message.id}');
    final padding = SwarmMessageFrame.padding(grouped: grouped);
    final frame = SwarmMessageFrame(
      grouped: grouped,
      onAvatar: onAuthor,
      avatarKey: ValueKey('swarm-author-${message.id}'),
      avatarLabel: name,
      avatar: SwarmChatAvatar(
        name: name,
        id: message.authorId,
        agent: message.fromAgent,
        pm: role == 'PM',
        picture: look.picture,
        status: look.status,
      ),
      header: SwarmMessageHeader(
        name: name,
        agent: message.fromAgent,
        role: role,
        trailing: at == null
            ? null
            : Text(
                '${two(at.hour)}:${two(at.minute)}',
                style: tty.style(color: AppPalette.textFaint, size: 12.5),
              ),
      ),
      body: [
        if (lit) SizedBox(key: ValueKey('swarm-lit-${message.id}')),
        ?quote,
        if (message.text.isNotEmpty)
          Semantics(
            button: true,
            hint: 'Reply to this message',
            child: GestureDetector(
              behavior: HitTestBehavior.opaque,
              onTap: onTap,
              child: Padding(
                padding: const EdgeInsets.only(top: SwarmMessageFrame.bodyGap),
                child: SizedBox(
                  width: double.infinity,
                  child: Text.rich(
                    mentions.span(
                      message.text,
                      swarmChatText(16, height: 1.42),
                    ),
                  ),
                ),
              ),
            ),
          ),
        for (final file in message.attachments)
          SwarmAttachment(
            file: file,
            link: swarmAttachmentLink(file.url),
            chip: SwarmFileChip(
              file: file,
              link: swarmAttachmentLink(file.url),
            ),
          ),
        ?reactions,
        ?below,
        if (actions)
          Padding(
            padding: const EdgeInsets.only(top: AppSpace.s),
            child: Wrap(
              spacing: 6,
              runSpacing: 6,
              children: [
                if (onReply case final reply?)
                  SwarmSmallButton(
                    key: ValueKey('swarm-reply-${message.id}'),
                    icon: LucideIcons.reply,
                    label: 'Reply',
                    onTap: reply,
                  ),
                SwarmSmallButton(
                  icon: LucideIcons.copy,
                  label: 'Copy',
                  onTap: () => unawaited(
                    Clipboard.setData(ClipboardData(text: message.text)),
                  ),
                ),
              ],
            ),
          ),
      ],
    );
    final held = onLongPress == null
        ? frame
        : GestureDetector(
            behavior: HitTestBehavior.translucent,
            onLongPress: onLongPress,
            child: frame,
          );
    if (!followed) return Padding(key: key, padding: padding, child: held);
    return AnimatedContainer(
      key: key,
      duration: const Duration(milliseconds: 600),
      curve: Curves.easeOut,
      padding: padding,
      decoration: BoxDecoration(
        color: lit
            ? AppPalette.accentOnSurface.withValues(alpha: 0.16)
            : Colors.transparent,
        borderRadius: BorderRadius.circular(AppControl.rowRadius),
      ),
      child: held,
    );
  }
}

/// A message's first line: who, in what role, then [trailing] — its time,
/// or how its post is going.
class SwarmMessageHeader extends StatelessWidget {
  const SwarmMessageHeader({
    super.key,
    required this.name,
    required this.agent,
    this.role,
    this.trailing,
  });

  final String name;
  final bool agent;
  final String? role;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Wrap(
      spacing: 6,
      crossAxisAlignment: WrapCrossAlignment.center,
      children: [
        Text(
          name,
          style: swarmChatText(
            13.5,
            color: agent ? tty.cyan : tty.green,
            weight: FontWeight.w600,
          ),
        ),
        if (role case final role?) SwarmRoleBadge(role),
        ?trailing,
      ],
    );
  }
}

/// A role's compact badge: PM, Dev, Rev.
class SwarmRoleBadge extends StatelessWidget {
  const SwarmRoleBadge(this.label, {super.key});

  final String label;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Container(
      padding: const EdgeInsets.symmetric(horizontal: AppSpace.xs),
      decoration: BoxDecoration(
        border: Border.all(color: swarmChatHair(tty)),
        borderRadius: BorderRadius.circular(AppCard.insetRadius),
      ),
      child: Text(
        label,
        style: tty
            .style(
              color: AppPalette.textSecondary,
              weight: FontWeight.w600,
              size: 11,
            )
            .copyWith(height: 16 / 11, letterSpacing: 0.44),
      ),
    );
  }
}

/// Who wrote a message, in a circle: an agent's initial on its own deep
/// colour — blue for a Product Manager, as the prototype has River — the
/// person's on theirs, white on each — or the picture they chose, and a
/// person's status emoji while it lasts.
class SwarmChatAvatar extends StatelessWidget {
  const SwarmChatAvatar({
    super.key,
    required this.name,
    required this.id,
    required this.agent,
    this.pm = false,
    this.picture,
    this.status,
  });

  static const double size = 32;

  /// The member palette, its first hue (blue) kept for the [pm].
  static const _agents = AppPalette.avatarPalette;

  final String name, id;
  final bool agent;

  /// A project's Product Manager: the prototype's blue, kept for them alone.
  final bool pm;

  /// What they chose to wear; null wears the initial.
  final SuperTabAvatarPicture? picture;

  /// A person's status; null for an agent.
  final SuperTabPersonStatus? status;

  @override
  Widget build(BuildContext context) {
    final fill = !agent
        ? AppPalette.avatarFill
        : pm
        ? _agents.first
        : _agents[1 +
              id.codeUnits.fold(0, (a, b) => a + b) % (_agents.length - 1)];
    final initial = name.trim().isEmpty
        ? '?'
        : name.trim().characters.first.toUpperCase();
    return SwarmStatusFace(
      name: name,
      size: size,
      status: status,
      face: SwarmFace(
        picture: picture,
        size: size,
        tint: fill,
        fallback: Container(
          width: size,
          height: size,
          alignment: Alignment.center,
          decoration: BoxDecoration(color: fill, shape: BoxShape.circle),
          child: Text(
            initial,
            style: swarmChatText(
              13.5,
              color: AppInk.onFill,
              weight: FontWeight.w600,
            ),
          ),
        ),
      ),
    );
  }
}

/// What a reply answers: its author and the start of its text, or that it
/// is not loaded. A tap leads to it.
class SwarmQuote extends StatelessWidget {
  const SwarmQuote({super.key, this.author, this.text, this.onTap});

  /// Null while the original is not loaded.
  final String? author, text;
  final VoidCallback? onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final quote = Container(
      width: double.infinity,
      margin: const EdgeInsets.symmetric(vertical: AppSpace.xs),
      padding: const EdgeInsets.symmetric(
        horizontal: AppSpace.m,
        vertical: AppSpace.s,
      ),
      decoration: BoxDecoration(
        color: tty.text.withValues(alpha: 0.05),
        border: Border(left: BorderSide(color: AppPalette.textFaint, width: 3)),
        borderRadius: const BorderRadius.horizontal(
          left: Radius.circular(4),
          right: Radius.circular(10),
        ),
      ),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (author case final author?)
            Text(
              author,
              maxLines: 1,
              overflow: TextOverflow.ellipsis,
              style: swarmChatText(13.5, weight: FontWeight.w600),
            ),
          Text(
            text ?? "The original message isn't loaded.",
            maxLines: 2,
            overflow: TextOverflow.ellipsis,
            style: swarmChatText(14, color: AppPalette.textSecondary),
          ),
        ],
      ),
    );
    if (onTap == null) return quote;
    return Semantics(
      button: true,
      label: 'Go to the quoted message',
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: quote,
      ),
    );
  }
}

/// A message's action — Reply, Copy, Send again: small, rounded, raised.
class SwarmSmallButton extends StatelessWidget {
  const SwarmSmallButton({
    super.key,
    required this.icon,
    required this.label,
    required this.onTap,
  });

  final IconData icon;
  final String label;
  final VoidCallback onTap;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    return Semantics(
      button: true,
      label: label,
      excludeSemantics: true,
      child: GestureDetector(
        behavior: HitTestBehavior.opaque,
        onTap: onTap,
        child: Container(
          constraints: const BoxConstraints(minHeight: 36),
          padding: const EdgeInsets.symmetric(horizontal: AppSpace.m),
          decoration: BoxDecoration(
            color: ttyRaised(tty),
            border: Border.all(color: swarmChatHair(tty)),
            borderRadius: BorderRadius.circular(AppControl.radius),
          ),
          child: Row(
            mainAxisSize: MainAxisSize.min,
            children: [
              Icon(icon, size: 16, color: AppPalette.textPrimary),
              const SizedBox(width: 8),
              Text(label, style: swarmChatText(14, weight: FontWeight.w500)),
            ],
          ),
        ),
      ),
    );
  }
}

/// A file's size as a chat shows it: whole kilobytes, rounded up, or megabytes to one place.
String swarmFileSize(int bytes) {
  final kb = (bytes / 1024).ceil();
  return kb < 1024 ? '$kb KB' : '${(kb / 1024).toStringAsFixed(1)} MB';
}

/// A message's file: opened in the browser when its link is the backend's.
class SwarmFileChip extends StatelessWidget {
  const SwarmFileChip({super.key, required this.file, required this.link});

  final SuperTabAttachment file;
  final Uri? link;

  @override
  Widget build(BuildContext context) {
    final tty = Tty.of(context);
    final size = swarmFileSize(file.size);
    final url = link;
    final color = url == null ? AppPalette.textFaint : tty.blue;
    return Padding(
      padding: const EdgeInsets.only(top: AppSpace.s),
      child: Semantics(
        button: url != null,
        label: 'File: ${file.name}, $size',
        excludeSemantics: true,
        child: GestureDetector(
          behavior: HitTestBehavior.opaque,
          onTap: url == null
              ? null
              : () => unawaited(
                  launchUrl(url, mode: LaunchMode.inAppBrowserView),
                ),
          child: Container(
            constraints: const BoxConstraints(minHeight: 40),
            padding: const EdgeInsets.symmetric(horizontal: AppSpace.m),
            decoration: BoxDecoration(
              color: swarmChatCard(tty),
              border: Border.all(color: swarmChatHair(tty)),
              borderRadius: BorderRadius.circular(AppControl.radius),
            ),
            child: Row(
              mainAxisSize: MainAxisSize.min,
              children: [
                Icon(LucideIcons.file, size: 16, color: color),
                const SizedBox(width: 8),
                Flexible(
                  child: Text(
                    file.name,
                    maxLines: 1,
                    overflow: TextOverflow.ellipsis,
                    style: swarmChatText(14, color: color),
                  ),
                ),
                const SizedBox(width: 8),
                Text(
                  size,
                  style: swarmChatText(13, color: AppPalette.textFaint),
                ),
              ],
            ),
          ),
        ),
      ),
    );
  }
}
