import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../widgets/desktop_chrome.dart';
import 'model.dart';

/// A workgroup's name as the Swarm shows it, in the sidebar and the chat
/// header alike: its number in grey and no #, so it does not read as a
/// "# project" channel, then its title ("196  Regression…").
class SuperTabWorkgroupName extends StatelessWidget {
  const SuperTabWorkgroupName(
    this.group, {
    super.key,
    required this.style,
    this.quietNumber = false,
  });
  final SuperTabConversation group;
  final TextStyle style;

  /// The sidebar's: the number two points smaller, fainter and in regular
  /// weight, so the title leads (Huy, 11-03, #2427).
  final bool quietNumber;

  /// The same name as plain text, for a tooltip.
  static String plain(SuperTabConversation group) =>
      [?group.number, group.title].join(' ');

  @override
  Widget build(BuildContext context) => Text.rich(
    TextSpan(
      children: [
        if (group.number case final number?)
          TextSpan(
            text: '$number  ',
            style: quietNumber
                ? style.copyWith(
                    color: grid.AppPalette.textFaint,
                    fontSize: (style.fontSize ?? 15) - 2,
                    fontWeight: grid.AppFont.regular,
                  )
                : style.copyWith(color: DesktopChrome.muted),
          ),
        TextSpan(text: group.title),
      ],
    ),
    maxLines: 1,
    overflow: TextOverflow.ellipsis,
    style: style,
  );
}
