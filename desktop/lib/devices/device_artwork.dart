import 'package:flutter/material.dart';

/// The same product identity artwork is used by the native titlebar.
const kDeviceMarkAsset = 'assets/devices/harness-mark.png';

class DeviceMark extends StatelessWidget {
  const DeviceMark({super.key, this.size = 20, this.enabled = true});

  final double size;
  final bool enabled;

  @override
  Widget build(BuildContext context) => Opacity(
    opacity: enabled ? 1 : .45,
    child: Image.asset(
      kDeviceMarkAsset,
      width: size,
      height: size,
      cacheWidth: (size * MediaQuery.devicePixelRatioOf(context)).ceil(),
      fit: BoxFit.contain,
      filterQuality: FilterQuality.high,
      excludeFromSemantics: true,
    ),
  );
}

/// Bundled product photography, selected using the connected screen's shape.
class DeviceArtwork extends StatelessWidget {
  const DeviceArtwork({
    super.key,
    this.desk = false,
    this.side = false,
    this.closeUp = false,
    this.square = false,
  });
  final bool desk, side, closeUp, square;

  @override
  Widget build(BuildContext context) => ExcludeSemantics(
    child: ClipRect(
      child: Transform.scale(
        scale: closeUp && !square ? 1.85 : 1,
        alignment: const Alignment(-.22, .12),
        child: Image.asset(
          square
              ? 'assets/devices/harness-square.png'
              : 'assets/devices/harness-${desk
                    ? 'desk'
                    : side
                    ? 'side'
                    : 'front'}.webp',
          fit: BoxFit.cover,
          width: double.infinity,
          height: double.infinity,
          alignment: square ? Alignment.center : const Alignment(-.22, .12),
          filterQuality: FilterQuality.medium,
        ),
      ),
    ),
  );
}
