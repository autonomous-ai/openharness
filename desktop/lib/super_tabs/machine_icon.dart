import 'dart:typed_data';

import 'package:flutter/widgets.dart';

import '../core/system_symbols.dart';
import '../shared/theme/app_icons.dart';

/// The SF Symbol for a machine of [deviceType], as the machine reports it
/// (`MacBook Pro`, `Mac Studio`, a PC's product name): each Mac its own shape,
/// anything else, or nothing known, a plain display.
String superTabMachineSymbol(String? deviceType) {
  final type = deviceType?.trim().toLowerCase() ?? '';
  if (type.startsWith('macbook')) return 'laptopcomputer';
  if (type.startsWith('mac studio')) return 'macstudio';
  if (type.startsWith('mac mini')) return 'macmini';
  if (type.startsWith('imac')) return 'desktopcomputer';
  return 'display';
}

/// A machine row's leading mark: AppKit's symbol for its type on a Mac, the
/// catalogue's laptop or display everywhere else, and while or when AppKit
/// has no picture for it. Never empty.
class SuperTabMachineIcon extends StatefulWidget {
  const SuperTabMachineIcon({
    super.key,
    required this.deviceType,
    required this.color,
    this.size = AppIcons.inlineSize,
    this.symbols,
  });

  final String? deviceType;
  final Color color;
  final double size;

  /// Where the symbols come from; [SystemSymbols.shared] when not given.
  final SystemSymbols? symbols;

  @override
  State<SuperTabMachineIcon> createState() => _SuperTabMachineIconState();
}

class _SuperTabMachineIconState extends State<SuperTabMachineIcon> {
  Uint8List? _png;
  String? _asked;

  @override
  void didChangeDependencies() {
    super.didChangeDependencies();
    _ask();
  }

  @override
  void didUpdateWidget(SuperTabMachineIcon oldWidget) {
    super.didUpdateWidget(oldWidget);
    _ask();
  }

  void _ask() {
    final symbols = widget.symbols ?? SystemSymbols.shared;
    final name = superTabMachineSymbol(widget.deviceType);
    final size = widget.size;
    final scale = MediaQuery.devicePixelRatioOf(context);
    final asked = '$name@$size@$scale';
    if (asked == _asked) return;
    _asked = asked;
    _png = symbols.drawn(name, size: size, scale: scale);
    if (_png != null || !symbols.available) return;
    symbols.png(name, size: size, scale: scale).then((png) {
      if (mounted && _asked == asked && png != null) setState(() => _png = png);
    });
  }

  @override
  Widget build(BuildContext context) {
    final fallback = Icon(
      superTabMachineSymbol(widget.deviceType) == 'laptopcomputer'
          ? AppIcons.laptop
          : AppIcons.monitor,
      size: widget.size,
      color: widget.color,
    );
    final png = _png;
    if (png == null) return fallback;
    return Image.memory(
      png,
      width: widget.size,
      height: widget.size,
      color: widget.color,
      colorBlendMode: BlendMode.srcIn,
      gaplessPlayback: true,
      excludeFromSemantics: true,
      // Until its first frame decodes, the catalogue's icon holds the place.
      frameBuilder: (_, child, frame, synchronous) =>
          frame == null && !synchronous ? fallback : child,
      errorBuilder: (_, _, _) => fallback,
    );
  }
}
