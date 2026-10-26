import 'package:flutter/material.dart';

import '../../shared/theme/app_icons.dart';
import '../../widgets/desktop_chrome.dart';

/// One computer on the connect page: its name, where it stands in words, and
/// a spinner or a button at the end.
class ComputerRow extends StatelessWidget {
  const ComputerRow({
    super.key,
    required this.name,
    required this.status,
    this.offline = false,
    this.trailing,
  });

  final String name;
  final String status;
  final bool offline;
  final Widget? trailing;

  @override
  Widget build(BuildContext context) => Container(
    padding: const EdgeInsets.symmetric(horizontal: 16, vertical: 12),
    decoration: BoxDecoration(
      color: DesktopChrome.field,
      border: Border.all(color: DesktopChrome.rim),
      borderRadius: BorderRadius.circular(DesktopChrome.dialogRadius),
    ),
    child: Row(
      children: [
        Icon(
          offline ? AppIcons.monitorOff : AppIcons.laptop,
          size: 18,
          color: DesktopChrome.foreground,
        ),
        const SizedBox(width: 12),
        Expanded(
          child: Column(
            crossAxisAlignment: CrossAxisAlignment.start,
            children: [
              Text(name, style: DesktopChrome.text(medium: true)),
              Semantics(
                liveRegion: true,
                child: Text(status, style: DesktopChrome.metadata()),
              ),
            ],
          ),
        ),
        ?trailing,
      ],
    ),
  );
}

/// A spinner the size the rows use.
class ComputerRowSpinner extends StatelessWidget {
  const ComputerRowSpinner({super.key});

  @override
  Widget build(BuildContext context) => SizedBox.square(
    dimension: 14,
    child: CircularProgressIndicator(
      strokeWidth: 1.5,
      color: DesktopChrome.muted,
    ),
  );
}
