// Harness Max Demo V3: the bar's pages in Flutter on the Orange Pi 4 Pro's 1480 x 320 bar (flutter-pi), or on a Mac
// for development. HARNESS_MAX_MODE: demo (the default; the scripted computer inside the program, which a person drives
// unless HARNESS_MAX_DEMO=story), usb or tcp (a real daemon on the cable), fixture (HARNESS_MAX_FIXTURE: a still page
// from the mockup's data).
import 'dart:async';
import 'dart:io';

import 'package:flutter/widgets.dart';

import 'demo/demo_link.dart';
import 'dev/fixtures.dart';
import 'link/arecord_mic.dart';
import 'link/cable/cable_link.dart';
import 'model/bar_model.dart';
import 'ui/bar_frame.dart';
import 'ui/bar_screen.dart';
import 'ui/pet.dart';
import 'ui/tokens.dart';

Future<void> main() async {
  WidgetsFlutterBinding.ensureInitialized();
  await preloadPets();
  final env = Platform.environment;
  final mode = env['HARNESS_MAX_MODE'] ?? 'demo';
  final BarModel model;
  if (mode == 'fixture') {
    model = mockupModel(app: env['HARNESS_MAX_FIXTURE_APP'] ?? 'orca');
  } else {
    model = BarModel();
    final mic = createMic();
    // HARNESS_MAX_DEMO=story plays max_demo.c's story by itself, over and over; otherwise a person drives the demo.
    model.link = mode == 'demo'
        ? DemoLink(model, mic: mic, manual: env['HARNESS_MAX_DEMO'] != 'story')
        : createCableLink(model, mode: mode, mic: mic);
    Timer.periodic(const Duration(milliseconds: 100), (_) => model.tick());
  }
  runApp(WidgetsApp(
    color: Ink.bg,
    debugShowCheckedModeBanner: false,
    builder: (context, _) => BarFrame(child: BarScreen(model: model)),
  ));
  if (mode != 'fixture') await model.link.start();
}
