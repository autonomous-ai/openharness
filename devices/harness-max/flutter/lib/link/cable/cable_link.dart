// The live link: the Harness cable protocol to the computer's daemon, over USB (the board is a USB device on its
// Type-C port) or TCP port 7531 (port of devices/harness-pro/firmware/main/cable/ and the Max's linux/cable).
import '../../model/bar_model.dart';
import '../bar_link.dart';
import '../mic.dart';

/// mode: "usb" or "tcp".
BarLink createCableLink(BarModel model, {required String mode, Mic? mic}) => throw UnimplementedError();
