// Bundles the window into dist/, or with --gallery the gallery into dist-gallery/. Classic scripts (iife), so the
// page needs no module loader and the CSP stays `default-src 'self'`.
import { build } from 'esbuild'
import { copyFile, mkdir } from 'node:fs/promises'

const gallery = process.argv.includes('--gallery')
const outdir = gallery ? 'dist-gallery' : 'dist'

await mkdir(outdir, { recursive: true })
await build({
  entryPoints: [gallery ? 'src/gallery.ts' : 'src/main.ts'],
  outfile: `${outdir}/${gallery ? 'gallery' : 'main'}.js`,
  bundle: true,
  format: 'iife',
  target: 'safari16',
  minify: !gallery,
})
if (!gallery) {
  await copyFile('index.html', `${outdir}/index.html`)
  await copyFile('src/styles.css', `${outdir}/styles.css`)
}
