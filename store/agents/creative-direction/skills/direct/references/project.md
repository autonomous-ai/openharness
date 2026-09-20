# Forme project contract

The source is `board/project.json`. `node tools/build.mjs` validates it, embeds local assets and
fonts, and compiles the portable `board/index.html`. Browser editing works on the same data.
Use stable IDs so revisions can retain the person's choices.

## Top level

- `spec: "forme/1"`, `id`, `title`, `brief`.
- `copy`: named text fields. Keys start with a lowercase letter and contain lowercase letters,
  digits, hyphens or underscores. Put shared business facts here.
- `fonts`: `{family, file, licenseFile}` relative to `board/`, or embedded `{family,data,license}`.
  The included families are `DM Sans` and `Fraunces`. Add suitable licensed families when needed.
- `assets`: `{id,name,file}` relative to `board/`, or `{id,name,data}` with a base64 image URL.
  PNG, JPEG, WebP and self-contained SVG are supported. Keep individual images under 10 MB.
- `directions`: authored visual systems; `active` selects a direction ID.
- `notes`: voice, brand-use guidance, decisions and unresolved issues.
- `approvals`: snapshots created by the studio. Preserve them during targeted revisions.
- `website`: title, CTA, destination link and authored sections, optionally a custom source file.

## A direction

```json
{
  "id": "primary", "name": "An authored concept", "rationale": "Why this fits the brief",
  "colors": {"ink":"#182A25", "paper":"#FAF7EC", "accent":"#EDCE55"},
  "fonts": {"display":"Fraunces", "body":"DM Sans"},
  "symbols": {"mark":{"viewBox":[0,0,100,100],"paths":[{"d":"M10 10H90V90H10Z","fill":"$ink"}]}},
  "boards": [],
  "logos": [{"id":"wordmark","board":"identity","layers":["mark","name"]}]
}
```

Replace the example geometry with an original mark or use the person's supplied logo. Symbols
are reusable vector paths, with `fillRule: "evenodd"` when needed. Logo lockups name layers of an
existing artboard; exports isolate those layers on transparency. Vector lockups also get ink and
paper variants. An image-based lockup retains the supplied image's actual colors.

## Applications and layers

An artboard has `id`, `name`, integer `width` and `height` (64–6000 px), `background` and `layers`.
Use `printMm: [width,height]` to specify the PDF page size. `role` can identify a logo, hero,
social post or another application. The website can use the hero or social artwork.

Every layer needs `id`, `type`, `x`, `y`, `width`, `height`. Colors use a role such as `$ink` or a
hex value; `none` is transparent. Shared options include `fill`, `stroke`, `strokeWidth`,
`opacity`, `rotation`, `hidden`, `locked` and `bleed` for intentional edge-crossing artwork.

- `text`: `text`, `size`, optional `minSize`, `font` (`display` or `body`), `weight` (100–900),
  `leading`, `tracking`, `align` (`left`, `center`, `right`). Text such as `{{name}}` binds to copy.
  The studio wraps with actual font metrics and shrinks only down to `minSize`; overflowing text
  is reported and blocks a complete kit export. Use separate aligned layers for menu prices.
- `rect`: optional `radius`.
- `ellipse`: fills its width and height.
- `line`: runs from its origin to its width/height endpoint.
- `path`: `d` contains SVG path geometry relative to x/y. Keep the declared box accurate.
- `symbol`: `symbol` names a reusable vector symbol, fitted into the layer box.
- `image`: `asset` names an embedded image. `fit: "cover"` crops; default contains the image.

The agent can add layouts and geometry directly. The person can move, edit, duplicate, reorder,
lock or delete layers in the pane. Exact `{{field}}` text bindings edit shared copy; **Edit only
here** detaches the binding for a local override. Do not detach approved bindings incidentally.

## Website

`website` needs `title`, `cta`, an HTTPS/mailto/tel `href`, and `sections: [{title,text}]`.
Those text fields can use `{{name}}` copy bindings. A default responsive composition is available.
For a different layout, author a complete static HTML/CSS document in `board/site.html` and set
`website.file: "site.html"`. The build embeds it as `website.html` in the portable project.

Custom HTML can bind `{{copy.name}}` (or another copy key), `{{color.ink}}`, `{{font.display}}`,
`{{site.href}}`, `{{site.cta}}`, `{{site.title}}`, `{{fontCSS}}` and `{{hero}}`. Font CSS and the
rendered hero are inserted directly; text is escaped. Scripts, event handlers and nested frames
are excluded from this static export. Implement an actual application separately when required.
