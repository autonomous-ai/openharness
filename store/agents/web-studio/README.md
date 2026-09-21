# Web Studio

Turn an idea into an interactive page in the live preview. The included **Field** starter is a
generative instrument: explore Orbit, Weave and Bloom, rotate with your pointer, adjust the shape,
pause time and export a PNG. Touch, keyboard and reduced motion are supported. No network or build
step is needed to use the starter.

Try: “Make a calming, interactive sculpture with three distinct shapes and a way to save a frame.”

Install from the Harness Store, choose **Web Studio** in New Harness, and select an empty folder.
For a local checkout:

```sh
harness dsh install "$PWD/store/agents/web-studio" --link
harness dsh doctor autonomous/web-studio
```

Requires the shared Web Viewer (Node 20+). Optional agent-side browser verification uses Playwright
and the page's `proof.json`. GPU and software-renderer performance differ; the probe reports the
actual renderer. Changes to the page are saved files; controls and exported PNGs do not rewrite it.

## Credit and stewardship

The original wrapper and starter are MIT-licensed OpenHarness work. See
[PROVENANCE.md](PROVENANCE.md) for upstream tools, datasets and their separate
licenses. No upstream ownership or endorsement is implied. Wrapper issues belong
in OpenHarness; upstream maintainers are welcome to take stewardship of a package.
