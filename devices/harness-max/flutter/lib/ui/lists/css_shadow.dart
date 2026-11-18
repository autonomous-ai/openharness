// A CSS box-shadow as a Flutter BoxShadow that blurs the same.
import 'package:flutter/widgets.dart';

/// CSS blurs a shadow with a Gaussian of sigma = blur / 2; Flutter turns blurRadius into sigma as
/// radius * 0.57735 + 0.5. Passing the CSS numbers straight would blur 18 % wider than the mockup.
double cssBlurRadius(double blur) => blur <= 1 ? 0 : (blur / 2 - 0.5) / 0.57735;

/// `box-shadow: x y blur spread color`.
BoxShadow cssShadow(Color color, {double x = 0, double y = 0, double blur = 0, double spread = 0}) =>
    BoxShadow(color: color, offset: Offset(x, y), blurRadius: cssBlurRadius(blur), spreadRadius: spread);
