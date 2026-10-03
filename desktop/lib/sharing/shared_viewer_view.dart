import 'dart:typed_data';

import 'package:flutter/material.dart';

import '../shared/theme/app_theme.dart' as grid;
import '../shared/widgets/skeleton.dart';

/// The owner's live viewer as a reader sees it: the latest frame, or what the
/// owner machine says about it while there is none.
class SharedViewerView extends StatelessWidget {
  const SharedViewerView({
    super.key,
    required this.name,
    required this.image,
    required this.message,
    required this.ended,
  });

  final String name;
  final Uint8List? image;
  final String message;
  final bool ended;

  @override
  Widget build(BuildContext context) {
    grid.AppTheme.watch(context);
    final frame = image;
    return ColoredBox(
      color: grid.AppPalette.windowBg,
      child: Center(
        child: frame != null
            ? Image.memory(
                frame,
                gaplessPlayback: true,
                fit: BoxFit.contain,
                semanticLabel: 'Live output from $name',
                errorBuilder: (_, _, _) =>
                    const Text('Waiting for the next viewer frame.'),
              )
            : Padding(
                padding: const EdgeInsets.all(24),
                child: Column(
                  mainAxisSize: MainAxisSize.min,
                  children: [
                    if (!ended) const Skeleton(width: 220, height: 130),
                    const SizedBox(height: 14),
                    Text(
                      message,
                      textAlign: TextAlign.center,
                      style: grid.AppType.body(
                        color: grid.AppPalette.textSecondary,
                      ),
                    ),
                  ],
                ),
              ),
      ),
    );
  }
}
