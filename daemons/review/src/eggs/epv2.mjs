const { plate } = await import('./plate.mjs?' + Date.now())
const m = await import('./egg2.mjs?' + Date.now())
const [kind, stage, level = 0, b = 0, p = 0, cols = 56] = process.argv.slice(2)
const mats = []
const out = plate(m.model({ kind, stage, level: +level, b: +b, p: +p }), +cols, { mats })
out.forEach((l, i) => { if (l.trim()) console.log('|' + l + '|  ' + mats[i].replace(/\./g, ' ')) })
