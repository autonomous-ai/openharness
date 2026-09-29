import 'package:flutter/widgets.dart';

/// Only the web build scans (a phone's browser camera). Native builds show a QR; they never read one.
bool get qrScanSupported => false;

Future<String?> scanQrCode(
  BuildContext context, {
  bool Function(String)? accept,
}) async => null;
