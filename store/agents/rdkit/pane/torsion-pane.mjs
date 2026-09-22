const $ = (id) => document.getElementById(id)
const element = (tag, text, className) => {
  const e = document.createElement(tag)
  e.textContent = text
  if (className) e.className = className
  return e
}

function validateStudy(value) {
  const count = value?.elements?.length
  if (
    value?.spec !== 'rdkit-torsion/1' ||
    !Number.isInteger(count) ||
    count < 4 ||
    count > 200 ||
    typeof value.source?.molblock !== 'string' ||
    typeof value.record?.name !== 'string' ||
    !Array.isArray(value.atoms) ||
    value.atoms.length !== 4 ||
    !value.atoms.every((i) => Number.isInteger(i) && i >= 0 && i < count) ||
    !Array.isArray(value.frames) ||
    ![13, 25, 37].includes(value.frames.length) ||
    !Number.isInteger(value.selectedIndex) ||
    value.selectedIndex < 0 ||
    value.selectedIndex >= value.frames.length ||
    !Number.isInteger(value.bestIndex) ||
    value.bestIndex < 0 ||
    value.bestIndex >= value.frames.length ||
    !value.frames.every(
      (frame) =>
        [frame.angle, frame.energy, frame.relativeEnergy].every(
          Number.isFinite
        ) &&
        Array.isArray(frame.coords) &&
        frame.coords.length === count &&
        frame.coords.every(
          (point) =>
            Array.isArray(point) &&
            point.length === 3 &&
            point.every(Number.isFinite)
        )
    )
  ) {
    throw new Error('This saved study is incomplete or has invalid coordinates')
  }
}

export function installTorsionPane(adapter) {
  let snapshot = null,
    input = null,
    study = null,
    selected = 0,
    working = false,
    timer = null,
    sequence = 0
  let savedId = null,
    pending = false
  function status(text, error = false) {
    $('scanStatus').textContent = text
    $('scanStatus').classList.toggle('error', error)
  }
  function sync() {
    $('scanStart').disabled = working || !adapter.source()
    $('scanClose').hidden = !snapshot
    $('scanClose').disabled = working
    for (const id of [
      'scanBond',
      'scanStep',
      'scanRun',
      'scanMeasured',
      'scanKeep',
      'scanTitle',
      'scanNote',
      'scanScrub',
      'scanPlay',
      'scanBest',
      'scanGhost'
    ])
      $(id).disabled = working
    $('scanKeep').textContent = working ? 'Working…' : 'Keep study'
    $('scanPending').hidden = !pending
    $('scanRun').disabled = working || !input || !$('scanBond').options.length
  }
  async function api(action, payload) {
    const token = document.querySelector('meta[name="torsion-token"]')
    const send = () =>
      fetch('/api/torsion/' + action, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-torsion-token': token.content
        },
        body: JSON.stringify(payload)
      })
    let response = await send()
    if (response.status === 403) {
      const page = new DOMParser().parseFromString(
        await (await fetch('/', { cache: 'no-store' })).text(),
        'text/html'
      )
      const fresh = page.querySelector('meta[name="torsion-token"]')?.content
      if (fresh) {
        token.content = fresh
        response = await send()
      }
    }
    const result = await response.json()
    if (!response.ok)
      throw new Error(result.error || 'The bond scan could not run')
    return result
  }
  function begin() {
    if (!snapshot) snapshot = adapter.capture()
  }
  function pause() {
    clearInterval(timer)
    timer = null
    $('scanPlay').textContent = 'Play scan'
  }
  function reset() {
    pause()
    study = null
    input = null
    savedId = null
    $('scanControls').hidden = true
    $('scanResult').hidden = true
    $('scanKept').replaceChildren()
  }
  async function start() {
    if (working) return
    if (snapshot) {
      adapter.restore(snapshot)
      snapshot = null
    }
    const source = adapter.source()
    if (!source) {
      status('Use a 3D SDF or MOL structure for a bond scan.', true)
      return
    }
    reset()
    begin()
    input = source
    working = true
    const ticket = ++sequence
    sync()
    status('Finding non-ring single bonds with RDKit…')
    try {
      const result = await api('options', input)
      if (ticket !== sequence) return
      $('scanBond').replaceChildren(
        ...result.candidates.map((candidate) => {
          const option = element(
            'option',
            candidate.label + ' · ' + Math.round(candidate.angle) + '°'
          )
          option.value = JSON.stringify(candidate.atoms)
          return option
        })
      )
      $('scanControls').hidden = false
      status(
        result.candidates.length
          ? 'Choose a bond, or use the last four-atom dihedral you measured.'
          : 'This molecule has no eligible non-ring single bond. Ring bonds stay closed.'
      )
    } catch (error) {
      status(error.message, true)
    } finally {
      working = false
      sync()
    }
  }
  function measured() {
    const atoms = adapter.measured()
    if (!atoms) {
      status(
        'Measure a dihedral first: press T, then pick four connected atoms in 3D or 2D.',
        true
      )
      return
    }
    const option = element('option', 'Measured · ' + atoms.join('–'))
    option.value = JSON.stringify(atoms)
    $('scanBond').append(option)
    $('scanBond').value = option.value
    sync()
    status('The scan will validate the selected atom chain with RDKit.')
  }
  async function run() {
    if (working || !input || !$('scanBond').value) return
    pause()
    working = true
    sync()
    status('Rotating the bond and calculating each pose with MMFF94…')
    try {
      const result = await api('scan', {
        ...input,
        atoms: JSON.parse($('scanBond').value),
        step: Number($('scanStep').value)
      })
      study = result
      savedId = null
      selected = study.frames.reduce(
        (best, frame, i) =>
          Math.abs(frame.angle - study.source.angle) <
          Math.abs(study.frames[best].angle - study.source.angle)
            ? i
            : best,
        0
      )
      $('scanResult').hidden = false
      $('scanScrub').max = String(study.frames.length - 1)
      $('scanTitle').value =
        `${input.name} · bond ${study.atoms[1]}–${study.atoms[2]}`
      $('scanKept').replaceChildren()
      $('scanNote').value = ''
      show(selected, true)
      status(
        `${study.frames.length} poses calculated · RDKit ${study.rdkitVersion}. Drag the curve to turn the molecule.`
      )
    } catch (error) {
      status(
        error.message + (study ? ' The previous scan remains available.' : ''),
        true
      )
    } finally {
      working = false
      sync()
    }
  }
  function show(index, fit = false) {
    if (!study) return
    selected = Math.max(0, Math.min(study.frames.length - 1, index))
    $('scanScrub').value = String(selected)
    const pose = study.frames[selected]
    $('scanScrub').setAttribute(
      'aria-valuetext',
      `${pose.angle} degrees, relative energy ${pose.relativeEnergy.toFixed(2)} kilocalories per mole`
    )
    $('scanAngle').textContent = `${pose.angle}°`
    $('scanEnergy').textContent =
      `ΔE ${pose.relativeEnergy.toFixed(2)} kcal/mol`
    adapter.present(study, selected, { ghost: $('scanGhost').checked, fit })
    draw()
  }
  function draw() {
    if (!study || $('panel-scan').hidden) return
    const canvas = $('scanPlot'),
      rect = canvas.getBoundingClientRect(),
      ratio = devicePixelRatio || 1
    if (!rect.width) return
    canvas.width = Math.round(rect.width * ratio)
    canvas.height = Math.round(160 * ratio)
    const ctx = canvas.getContext('2d')
    ctx.scale(ratio, ratio)
    const width = rect.width,
      left = 43,
      top = 14,
      right = width - 12,
      bottom = 132
    const high =
      Math.max(0.1, ...study.frames.map((f) => f.relativeEnergy)) * 1.08
    const x = (angle) => left + ((angle + 180) / 360) * (right - left)
    const y = (energy) => bottom - (energy / high) * (bottom - top)
    ctx.font = '10px system-ui'
    ctx.lineWidth = 1
    for (let i = 0; i < 4; i++) {
      const energy = (high * i) / 3,
        at = y(energy)
      ctx.strokeStyle = '#e5e5e2'
      ctx.beginPath()
      ctx.moveTo(left, at)
      ctx.lineTo(right, at)
      ctx.stroke()
      ctx.fillStyle = '#62615b'
      ctx.textAlign = 'right'
      ctx.fillText(energy.toFixed(high > 50 ? 0 : 1), left - 6, at + 3)
    }
    ctx.textAlign = 'center'
    for (const angle of [-180, -90, 0, 90, 180])
      ctx.fillText(angle + '°', x(angle), 151)
    ctx.strokeStyle = '#2f5bea'
    ctx.lineWidth = 2
    ctx.beginPath()
    study.frames.forEach((frame, i) =>
      i
        ? ctx.lineTo(x(frame.angle), y(frame.relativeEnergy))
        : ctx.moveTo(x(frame.angle), y(frame.relativeEnergy))
    )
    ctx.stroke()
    for (const frame of study.frames) {
      ctx.fillStyle = '#2f5bea'
      ctx.beginPath()
      ctx.arc(x(frame.angle), y(frame.relativeEnergy), 2, 0, Math.PI * 2)
      ctx.fill()
    }
    const point = study.frames[selected]
    ctx.strokeStyle = '#8e8d86'
    ctx.lineWidth = 1
    ctx.setLineDash([3, 3])
    ctx.beginPath()
    ctx.moveTo(x(point.angle), top)
    ctx.lineTo(x(point.angle), bottom)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#ea580c'
    ctx.beginPath()
    ctx.arc(x(point.angle), y(point.relativeEnergy), 5, 0, Math.PI * 2)
    ctx.fill()
  }
  function seek(event) {
    if (!study || working) return
    pause()
    const rect = $('scanPlot').getBoundingClientRect()
    show(
      Math.round(
        ((event.clientX - rect.left - 43) / (rect.width - 55)) *
          (study.frames.length - 1)
      )
    )
  }
  async function keep() {
    if (!study || !input || working) return
    const title = $('scanTitle').value.trim()
    if (!title) {
      $('scanTitle').focus()
      status('Name this study before keeping it.', true)
      return
    }
    pause()
    working = true
    sync()
    status('Rechecking the calculation and keeping the study…')
    try {
      const result = await api('keep', {
        ...input,
        atoms: study.atoms,
        step: study.step,
        fingerprint: study.fingerprint,
        title,
        selected,
        note: $('scanNote').value
      })
      savedId = result.id
      const link = element('a', 'Download kept study')
      link.href = `/${result.path}/study.zip`
      link.download = 'study.zip'
      $('scanKept').replaceChildren(link)
      status(`Kept “${title}”. The original molecule is unchanged.`)
      await refresh()
    } catch (error) {
      status(error.message + ' Your scan is still here.', true)
    } finally {
      working = false
      sync()
    }
  }
  async function open(id) {
    if (working) return
    pause()
    working = true
    sync()
    try {
      const response = await fetch(
        `/out/torsions/${encodeURIComponent(id)}/study.json`,
        { cache: 'no-store' }
      )
      if (!response.ok) throw new Error('This study is no longer available')
      const value = await response.json()
      validateStudy(value)
      begin()
      study = value
      savedId = id
      input = { molblock: study.source.molblock, name: study.record.name }
      $('scanResult').hidden = false
      $('scanControls').hidden = true
      $('scanScrub').max = String(study.frames.length - 1)
      $('scanTitle').value = study.title
      $('scanNote').value = study.note || ''
      const link = element('a', 'Download kept study')
      link.href = `/out/torsions/${id}/study.zip`
      link.download = 'study.zip'
      $('scanKept').replaceChildren(link)
      show(study.selectedIndex, true)
      status(
        `Kept study · ${study.frames.length} poses · RDKit ${study.rdkitVersion}`
      )
    } catch (error) {
      status(error.message, true)
    } finally {
      working = false
      sync()
    }
  }
  async function refresh() {
    try {
      const response = await fetch('/api/torsions', { cache: 'no-store' })
      if (!response.ok) throw new Error('Could not load kept studies')
      const items = await response.json()
      $('scanStudies').replaceChildren(
        ...items.map((item) => {
          const card = element('article', '', 'scan-study'),
            button = element('button', item.title, 'scan-open')
          button.onclick = () => open(item.id)
          card.append(
            button,
            element('p', `${item.molecule} · kept at ${item.angle}°`)
          )
          const links = element('div', '', 'scan-links')
          for (const [label, file] of [
            ['Selected SDF', 'selected.sdf'],
            ['CSV', 'energies.csv'],
            ['Source + poses', 'study.zip']
          ]) {
            const link = element('a', label)
            link.href = `/out/torsions/${item.id}/${file}`
            link.download = file
            links.append(link)
          }
          card.append(links)
          return card
        })
      )
      if (!items.length)
        $('scanStudies').append(
          element(
            'p',
            'Kept scans will appear here with their source, poses and calculations.',
            'scan-method'
          )
        )
    } catch (error) {
      status(error.message, true)
    }
  }
  function close({ refreshSource = true } = {}) {
    if (working) return false
    ++sequence
    reset()
    const previous = snapshot
    snapshot = null
    if (previous) adapter.restore(previous)
    const wasPending = pending
    pending = false
    sync()
    status('Choose a conformer to explore, or reopen a kept study.')
    if (refreshSource && wasPending) adapter.refresh()
    return true
  }
  $('scanStart').onclick = start
  $('scanRun').onclick = run
  $('scanMeasured').onclick = measured
  $('scanKeep').onclick = keep
  $('scanRefresh').onclick = refresh
  $('scanClose').onclick = () => close()
  $('scanScrub').oninput = () => {
    pause()
    show(Number($('scanScrub').value))
  }
  $('scanBest').onclick = () => {
    pause()
    show(study?.bestIndex || 0)
  }
  $('scanGhost').onchange = () => show(selected)
  $('scanPlay').onclick = () => {
    if (timer) {
      pause()
      return
    }
    if (!study || working) return
    $('scanPlay').textContent = 'Pause scan'
    timer = setInterval(() => show((selected + 1) % study.frames.length), 300)
  }
  $('scanPlot').onpointerdown = (event) => {
    $('scanPlot').setPointerCapture(event.pointerId)
    seek(event)
  }
  $('scanPlot').onpointermove = (event) => {
    if (event.buttons) seek(event)
  }
  new ResizeObserver(draw).observe($('scanPlot'))
  refresh()
  sync()
  return {
    loaded: sync,
    draw,
    close,
    active: () => !!snapshot,
    changed() {
      if (!snapshot) return false
      pending = true
      sync()
      return true
    },
    // Read-only state for acceptance checks and inspection.
    inspect: () => ({ study, selected, savedId, working, active: !!snapshot })
  }
}
