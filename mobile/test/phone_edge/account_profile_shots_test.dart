import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:harness_mobile/auth/auth_session.dart';
import 'package:harness_mobile/core/models.dart';
import 'package:harness_mobile/phone/account_profile_dialog.dart';
import 'package:harness_mobile/shared/theme/app_theme.dart';
import 'package:harness_mobile/shared/theme/color_palette.dart';

import 'edge_fixture.dart';

/// Profile's screenshots for review (#2655): the sheet with two Swarms, and a refusal under a username, in both
/// phone themes. Set ACCOUNT_PROFILE_SHOTS to a folder to write them.
final shots = Platform.environment['ACCOUNT_PROFILE_SHOTS'];
void main() {
  setUpAll(() async {
    if (shots == null || !Platform.isMacOS) return;
    final sf = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNS.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFont', 'Roboto']) {
      await (FontLoader(family)..addFont(Future.value(sf))).load();
    }
    final mono = ByteData.sublistView(
      await File('/System/Library/Fonts/SFNSMono.ttf').readAsBytes(),
    );
    for (final family in ['.AppleSystemUIFontMonospaced', 'monospace']) {
      await (FontLoader(family)..addFont(Future.value(mono))).load();
    }
    final manifest =
        jsonDecode(await rootBundle.loadString('FontManifest.json')) as List;
    for (final entry in manifest.cast<Map<String, dynamic>>()) {
      final loader = FontLoader(entry['family'] as String);
      for (final font in (entry['fonts'] as List).cast<Map>()) {
        loader.addFont(rootBundle.load(font['asset'] as String));
      }
      await loader.load();
    }
  });

  for (final brightness in Brightness.values) {
    testWidgets('Profile, ${brightness.name}', (tester) async {
      await tester.binding.setSurfaceSize(const Size(390, 844));
      addTearDown(() => tester.binding.setSurfaceSize(null));
      tester.view.padding = const FakeViewPadding(top: 47 * 3, bottom: 34 * 3);
      addTearDown(tester.view.resetPadding);
      final palette = brightness == Brightness.light ? HarnessPalette.paper : HarnessPalette.graphite;
      final before = (AppTheme.palette.value, AppTheme.brightness.value);
      AppTheme.palette.value = palette;
      AppTheme.brightness.value = brightness;
      addTearDown(() {
        AppTheme.palette.value = before.$1;
        AppTheme.brightness.value = before.$2;
      });
      final app = edgeApp();
      app.api = EdgeApi(app, AuthSession());
      app.currentUser = const CurrentUserProfile(id: 'u', name: 'Ada Lovelace', email: 'ada@example.com');
      final boundary = GlobalKey();
      AccountProfileSwarm swarm(String name, String username, {String? refuse}) => AccountProfileSwarm(
        name: name, username: username, personName: 'Ada Lovelace',
        setUsername: (_) async => refuse, setName: (_) async => null);
      final swarms = [swarm('Pilot', 'ada', refuse: 'That username is taken in this Swarm.'), swarm('Scout', 'ada-l')];
      await tester.pumpWidget(RepaintBoundary(key: boundary, child: phoneApp(
        Builder(builder: (context) => Scaffold(body: Center(child: TextButton(
          onPressed: () => showAccountProfile(context, app, swarms: swarms), child: const Text('open'))))),
        brightness: brightness)));
      await tester.tap(find.text('open'));
      await frames(tester);
      Future<void> shot(String name) => tester.runAsync(() async {
        final image = await (boundary.currentContext!.findRenderObject()! as RenderRepaintBoundary).toImage(pixelRatio: 3);
        final png = await image.toByteData(format: ui.ImageByteFormat.png);
        await Directory(shots!).create(recursive: true);
        await File('$shots/account-profile-$name-${brightness.name}.png').writeAsBytes(png!.buffer.asUint8List());
        image.dispose();
      });
      FocusManager.instance.primaryFocus?.unfocus();
      await frames(tester);
      await shot('open');
      await tester.enterText(find.byKey(const ValueKey('account-profile-username-0')), 'ada2');
      FocusManager.instance.primaryFocus?.unfocus();
      await tester.tap(find.text('Save'));
      await frames(tester);
      await shot('refused');
      await tester.pumpWidget(const SizedBox());
      await tester.pump(const Duration(seconds: 3));
      app.dispose();
      await tester.pump(const Duration(seconds: 30));
    }, skip: shots == null);
  }
}
