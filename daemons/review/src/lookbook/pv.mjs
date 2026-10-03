// node pv.mjs <id> [cols=56] [t=0] [mood=idle] [age=2.0] [paper]
const root = 'REPO/daemons'
const { plate } = await import(root + '/tools/plate.mjs?' + Date.now())
const m = await import(root + '/plates/' + process.argv[2] + '.mjs?' + Date.now())
const [cols = 56, t = 0, mood = 'idle', age = '2.0', paper] = process.argv.slice(3)
const out = plate(m.model({ t: +t, mood, age }), +cols, { paper: paper === 'paper' })
console.log(out.map((l) => '|' + l + '|').join('\n'))
