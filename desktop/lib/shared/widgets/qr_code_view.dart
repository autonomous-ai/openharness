import 'package:flutter/material.dart';
import 'package:qr/qr.dart';

/// [data] as a QR code: dark modules on a white square with its quiet zone.
///
/// ⚠️ White and black whatever the theme. A dark-mode QR — light modules on a
/// dark field — is one many phone cameras will not read, and the four-module
/// white margin (the "quiet zone") is part of the code, not decoration: it is
/// how a scanner finds the edges. So the white square stays, on every palette.
class QrCodeView extends StatelessWidget {
  const QrCodeView({super.key, required this.data, required this.side, required this.semanticLabel});

  /// What the code says — the whole link, secret included.
  final String data;
  final double side;

  /// What a screen reader says it is — what the code is FOR.
  final String semanticLabel;

  static const _quietModules = 4;

  // A few entries, the most recently drawn kept: the dialog rebuilds on every
  // font or palette change, and choosing the best of eight mask patterns is not
  // free. ⚠️ Not one: Add Phone shows three codes at once — the App Store's,
  // Google Play's and the pairing code — and a single entry recomputed all
  // three on every rebuild.
  static final _cached = <String, QrImage>{};
  static const _cacheSize = 4;

  static QrImage _imageOf(String data) {
    if (_cached.remove(data) case final image?) {
      _cached[data] = image;
      return image;
    }
    final image = QrImage(
      QrCode.fromData(data: data, errorCorrectLevel: QrErrorCorrectLevel.M),
    );
    _cached[data] = image;
    if (_cached.length > _cacheSize) _cached.remove(_cached.keys.first);
    return image;
  }

  @override
  Widget build(BuildContext context) {
    final image = _imageOf(data);
    final module = side / (image.moduleCount + _quietModules * 2);
    return Semantics(
      image: true,
      label: semanticLabel,
      child: Container(
        width: side,
        height: side,
        decoration: BoxDecoration(
          color: Colors.white,
          borderRadius: BorderRadius.circular(module * 2),
        ),
        child: CustomPaint(painter: _QrPainter(image, data)),
      ),
    );
  }
}

class _QrPainter extends CustomPainter {
  _QrPainter(this.image, this.data);

  final QrImage image;
  final String data;

  @override
  void paint(Canvas canvas, Size size) {
    final count = image.moduleCount;
    final total = count + QrCodeView._quietModules * 2;
    // Snapped to half a point — a whole device pixel on a Retina screen — so
    // neighbouring modules meet exactly instead of leaving hairline seams.
    final module = (size.shortestSide / total * 2).floorToDouble() / 2;
    final origin = Offset(
      (size.width - module * count) / 2,
      (size.height - module * count) / 2,
    );
    final path = Path();
    for (var y = 0; y < count; y++) {
      for (var x = 0; x < count; x++) {
        if (!image.isDark(y, x)) continue;
        path.addRect(
          Rect.fromLTWH(
            origin.dx + x * module,
            origin.dy + y * module,
            module,
            module,
          ),
        );
      }
    }
    canvas.drawPath(
      path,
      Paint()
        ..color = Colors.black
        ..isAntiAlias = false,
    );
  }

  @override
  bool shouldRepaint(_QrPainter oldDelegate) => oldDelegate.data != data;
}
