/// Bundled, still artwork. Each New Tab chooses once, independently of builds.
enum NewTabWallpaper {
  flight('assets/welcome/leonardo-flight.png'),
  wings('assets/welcome/leonardo-wings.png'),
  mechanisms('assets/welcome/leonardo-mechanisms.png');

  const NewTabWallpaper(this.asset);
  final String asset;

  static NewTabWallpaper fromName(Object? name) =>
      values.where((wallpaper) => wallpaper.name == name).firstOrNull ?? flight;
}
