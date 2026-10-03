import 'package:web/web.dart' as web;

/// The page's `<base href>`: `/harness-web/` in a release, whatever the visible
/// URL is (`/`, `/s/:id`), since the host rewrites those onto its index.html.
Uri? pageBaseUri() => Uri.tryParse(web.document.baseURI);
