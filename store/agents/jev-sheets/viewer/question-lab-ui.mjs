import { parseHeader, describeColumn } from '/grammar.mjs'

const el = (tag, cls, text) => {
  const node = document.createElement(tag)
  if (cls) node.className = cls
  if (text != null) node.textContent = text
  return node
}
const pct = (n) => `${Math.round(n * 100)}%`
const done = (t) => t && t.status !== 'running'

export function initQuestionLab({ post, getState, getSelected }) {
  const dialog = el('dialog', 'ql-dialog')
  // Only fixed markup is parsed as HTML. Rows, questions, model answers and notes use textContent.
  dialog.innerHTML = `
    <div class="ql-shell">
      <header class="ql-head"><div><div class="ql-eyebrow">JEV SHEETS / QUESTION LAB</div><h2>Try a sharper question.</h2><p>Compare on a few rows. Read what changed. Keep the evidence.</p></div><button id="qlClose" aria-label="Close Question Lab">×</button></header>
      <nav class="ql-nav"><button id="qlNew" class="on">New trial</button><button id="qlHistory">Kept & open trials</button><span id="qlMode" class="ql-mode"></span></nav>
      <div id="qlMessage" class="ql-message" role="status" hidden></div>
      <section id="qlSetup" class="ql-setup">
        <div class="ql-source"><label for="qlColumn">01 / Start with a question</label><select id="qlColumn"></select><p id="qlOriginal" class="ql-question"></p>
          <div class="ql-sample-controls"><label>Rows<select id="qlCount"><option>10</option><option>20</option><option>40</option></select></label><label>Choose rows<select id="qlMethod"><option value="challenge">Low confidence + spread</option><option value="spread">Spread across sheet</option><option value="visible">First rows in current view</option></select></label></div>
          <label class="ql-pin"><input type="checkbox" id="qlPin"> Include the selected sheet row</label><button id="qlPreview">Preview these rows</button>
        </div>
        <div class="ql-proposal"><label for="qlHeader">02 / Give it another wording</label><textarea id="qlHeader" maxlength="4000" spellcheck="false" placeholder="A clearer yes/no question? Or a choice with meanings: Topic: bug = broken behavior | idea = requested improvement"></textarea><p id="qlGrammar" class="ql-caption"></p><button id="qlStart" class="primary" disabled>Compare 10 rows</button><p id="qlCost" class="ql-caption">Both versions are asked again, together in one call per row. The sheet stays as it is.</p></div>
      </section>
      <section id="qlRun" class="ql-run" hidden>
        <div class="ql-question-pair"><div><span>ORIGINAL</span><p id="qlOldHeader"></p></div><div><span>NEW WORDING</span><p id="qlNewHeader"></p></div></div>
        <div class="ql-summary"><div id="qlNumbers"></div><div class="ql-actions"><button id="qlCancel">Cancel remaining calls</button><button id="qlKeep" class="primary">Keep this trial</button><a id="qlDownload" class="ql-button" hidden>Download trial.zip</a><button id="qlApply" hidden>Try on whole sheet</button></div></div>
        <p id="qlInterpret" class="ql-caption"></p>
      </section>
      <section id="qlHistoryList" class="ql-history" hidden></section>
      <div id="qlWorkspace" class="ql-workspace"><section class="ql-rows-pane"><div class="ql-list-head"><b id="qlListTitle">03 / Inspect the rows</b><label id="qlChangedLabel" hidden><input id="qlChanged" type="checkbox"> changed only</label></div><div id="qlRows" class="ql-rows"></div></section><section id="qlDetail" class="ql-detail"></section></div>
      <footer class="ql-footer"><span id="qlFoot">Selected rows are a deliberate test set, not a random sample.</span><span>Confidence is not accuracy.</span></footer>
    </div>`
  document.body.append(dialog)
  const $ = (id) => dialog.querySelector(`#${id}`)
  let draft = null,
    trial = null,
    selected = null,
    token = '',
    poll = null,
    busy = false,
    history = false,
    detailSig = '',
    pinned = null,
    openFocus = null
  const noteDrafts = new Map()
  let noteTimer = null,
    savePromise = Promise.resolve(),
    requestVersion = 0,
    listSig = ''
  const message = (text = '', error = false) => {
    $('qlMessage').hidden = !text
    $('qlMessage').textContent = text
    $('qlMessage').classList.toggle('error', error)
  }
  async function call(cmd, body = {}) {
    let reply = await post(cmd, {
      ...body,
      token: token || getState()?.questionLabToken
    })
    if (reply.code === 'LAB_TOKEN') {
      const response = await fetch('/state')
        .then((r) => r.json())
        .catch(() => null)
      token = response?.questionLabToken || ''
      reply = await post(cmd, { ...body, token })
    }
    return reply
  }
  const guard = async (work) => {
    if (busy) return
    busy = true
    requestVersion++
    updateButtons()
    try {
      await work()
    } catch (error) {
      message(error.message || String(error), true)
    } finally {
      busy = false
      updateButtons()
    }
  }
  function mode() {
    const providers = trial?.summary.providers.length
      ? trial.summary.providers
      : [getState()?.client || 'mock']
    const offline = !providers.length || providers.includes('mock')
    $('qlMode').textContent = offline
      ? 'OFFLINE STAND-IN · practice only'
      : `Jev · ${providers.join(' + ')}`
    $('qlMode').classList.toggle('offline', offline)
    $('qlCost').textContent =
      getState()?.client === 'mock'
        ? 'Offline stand-in: this tests the interaction, not Jev’s quality. No model calls or charges.'
        : `Both versions are asked again in ${draft?.rows.length || $('qlCount').value} calls, using the connected Jev provider. Only these rows and their metadata are sent.`
  }
  function updateButtons() {
    const parsed = parseHeader($('qlHeader').value)
    $('qlGrammar').textContent = $('qlHeader').value
      ? parsed.ok
        ? describeColumn(parsed.column)
        : parsed.error
      : 'Use the same header grammar as the sheet. Add meanings after option labels.'
    $('qlStart').disabled = busy || !draft || !parsed.ok
    $('qlPreview').disabled = busy || !getState()?.columns.length
    $('qlKeep').disabled = busy || !done(trial) || !!trial?.kept
    $('qlCancel').hidden = !trial || done(trial)
    $('qlCancel').disabled = busy || !!trial?.cancelRequested
    $('qlChanged').disabled = busy
    $('qlApply').hidden = !trial?.kept || trial.status !== 'complete'
    $('qlApply').disabled = busy || !!trial?.stale
    $('qlApply').textContent =
      `Try on whole sheet · ${getState()?.rows.length ?? trial?.population ?? 0} rows`
    $('qlDownload').hidden = !trial?.kept
    $('qlKeep').hidden = !!trial?.kept
  }
  function clearPreview() {
    draft = null
    selected = null
    detailSig = ''
    listSig = ''
    render()
    updateButtons()
  }
  function chooseColumn() {
    const col = getState()?.columns.find((c) => c.id === $('qlColumn').value)
    $('qlOriginal').textContent =
      col?.header || 'Add a question to your sheet first.'
    $('qlHeader').value = col?.header || ''
    clearPreview()
  }
  function setup() {
    const state = getState(),
      selectedCell = getSelected()
    $('qlColumn').replaceChildren(
      ...(state?.columns || []).map((c) => {
        const o = el('option', '', c.header)
        o.value = c.id
        return o
      })
    )
    if (state?.columns.some((c) => c.id === selectedCell?.col))
      $('qlColumn').value = selectedCell.col
    pinned = state?.rows.some((r) => r.id === selectedCell?.row)
      ? selectedCell.row
      : null
    $('qlPin').checked = !!pinned
    $('qlPin').disabled = !pinned
    chooseColumn()
    mode()
  }
  async function preview() {
    const res = await call('labPreview', {
      column: $('qlColumn').value,
      count: Number($('qlCount').value),
      method: $('qlMethod').value,
      pinned: $('qlPin').checked && pinned ? [pinned] : []
    })
    if (!res.ok) throw new Error(res.error)
    draft = res.draft
    selected = draft.rows[0]?.id
    detailSig = ''
    listSig = ''
    message()
    render()
  }
  function rowCard(row, isTrial) {
    const card = el('button', `ql-row${row.id === selected ? ' selected' : ''}`)
    card.dataset.row = row.id
    const top = el('div', 'ql-row-top')
    top.append(
      el('span', 'ql-row-number', `#${row.n}`),
      el(
        'span',
        'ql-row-reason',
        isTrial
          ? row.review?.vote
            ? `you prefer ${row.review.vote === 'candidate' ? 'new wording' : row.review.vote}`
            : row.status === 'answered'
              ? 'ready to review'
              : row.status
          : row.selectedBecause
      )
    )
    card.append(top, el('p', 'ql-row-text', row.text))
    if (isTrial && row.original && row.candidate) {
      const answers = el('div', 'ql-row-answers'),
        changed = row.original.shown !== row.candidate.shown
      answers.append(
        el('span', 'ql-answer-old', row.original.shown),
        el('span', 'ql-arrow', '→'),
        el(
          'span',
          changed ? 'ql-answer-new changed' : 'ql-answer-new',
          row.candidate.shown
        ),
        el('small', '', changed ? 'changed' : 'same label')
      )
      card.append(answers)
    }
    if (row.error) card.append(el('span', 'ql-row-error', row.error))
    card.addEventListener('click', () =>
      guard(async () => {
        await flushNotes()
        selected = row.id
        detailSig = ''
        render()
      })
    )
    return card
  }
  function answerPanel(column, result, label) {
    const panel = el('section', 'ql-answer-panel')
    panel.append(
      el('span', 'ql-eyebrow', label),
      el('h4', '', result.shown),
      el('p', 'ql-caption', `${pct(result.confidence)} confidence`)
    )
    const a = result.answer
    const probabilities =
      column.type === 'noul'
        ? [
            ['yes', a.noul],
            ['no', 1 - a.noul]
          ]
        : column.type === 'choice'
          ? column.options.map((o) => [o, a.probabilities?.[o]])
          : column.levels.map((l, i) => [l, a.probabilities?.[String(i)]])
    for (const [name, probability] of probabilities) {
      const line = el('div', 'ql-probability'),
        value = el(
          'span',
          '',
          Number.isFinite(probability) ? pct(probability) : '—'
        )
      line.append(el('span', '', name), value)
      const track = el('div', 'ql-prob-track'),
        fill = el('i')
      fill.style.width = Number.isFinite(probability)
        ? `${probability * 100}%`
        : '0%'
      track.append(fill)
      line.append(track)
      panel.append(line)
    }
    if (column.type === 'score')
      panel.append(
        el('p', 'ql-caption', `Raw score: ${Number(a.score).toFixed(3)}`)
      )
    return panel
  }
  function renderDetail() {
    const data = trial || draft,
      row = data?.rows.find((r) => r.id === selected),
      box = $('qlDetail')
    const sig = JSON.stringify([row, !!trial, trial?.kept, data?.context])
    if (sig === detailSig) return
    for (const button of box.querySelectorAll('[data-vote]')) {
      if (button.closest('.ql-review')?.dataset.row === row?.id)
        button.classList.toggle('on', button.dataset.vote === row.review?.vote)
    }
    // Polling cannot steal focus or replace a note while someone is writing it.
    if (
      box.contains(document.activeElement) &&
      ['TEXTAREA', 'INPUT'].includes(document.activeElement.tagName)
    )
      return
    detailSig = sig
    box.replaceChildren()
    if (!row) {
      box.append(
        el(
          'div',
          'ql-empty',
          'Preview a few rows, then write the question you wish you had asked.'
        )
      )
      return
    }
    box.append(
      el('div', 'ql-eyebrow', `ROW ${row.n} / ${row.id}`),
      el('p', 'ql-full-text', row.text)
    )
    if (Object.keys(row.meta || {}).length) {
      const meta = el('dl', 'ql-meta')
      for (const [key, value] of Object.entries(row.meta))
        meta.append(el('dt', '', key), el('dd', '', String(value)))
      box.append(meta)
    }
    const context = el('details', 'ql-context')
    context.append(
      el('summary', '', 'Context sent with both questions'),
      el('p', '', data.context || 'No extra context.')
    )
    box.append(context)
    if (!trial) {
      box.append(
        el(
          'p',
          'ql-caption',
          `Selected because: ${row.selectedBecause}. These exact rows are held for the comparison, even if the sheet changes.`
        )
      )
      return
    }
    if (!row.original || !row.candidate) {
      box.append(
        el(
          'p',
          'ql-caption',
          row.error ||
            (trial.status === 'running'
              ? 'The paired answers will appear here.'
              : 'This row was not answered.')
        )
      )
      return
    }
    const pair = el('div', 'ql-detail-pair')
    pair.append(
      answerPanel(trial.original, row.original, 'ORIGINAL'),
      answerPanel(trial.candidate, row.candidate, 'NEW WORDING')
    )
    box.append(pair)
    const review = el('div', 'ql-review')
    review.dataset.row = row.id
    review.append(
      el('h4', '', 'Which answer serves your purpose?'),
      el(
        'p',
        'ql-caption',
        'Your judgment stays separate from model confidence.'
      )
    )
    const votes = el('div', 'ql-votes')
    for (const [vote, label] of [
      ['original', 'Original'],
      ['candidate', 'New wording'],
      ['unsure', 'Unsure']
    ]) {
      const b = el('button', row.review?.vote === vote ? 'on' : '', label)
      b.dataset.vote = vote
      b.disabled = trial.kept
      b.addEventListener('click', () =>
        guard(async () => {
          await flushNotes()
          const res = await call('labReview', {
            id: trial.id,
            row: row.id,
            vote:
              trial.rows.find((r) => r.id === row.id)?.review?.vote === vote
                ? null
                : vote
          })
          if (!res.ok) throw new Error(res.error)
          trial = res.trial
          detailSig = ''
          render()
        })
      )
      votes.append(b)
    }
    review.append(votes)
    const label = el('label', '', 'Why?'),
      note = el('textarea', 'ql-row-note')
    label.htmlFor = 'qlRowNote'
    note.id = 'qlRowNote'
    note.maxLength = 800
    note.placeholder = 'What did the wording capture or miss?'
    const noteKey = `${trial.id}/${row.id}`
    note.value = noteDrafts.has(noteKey)
      ? noteDrafts.get(noteKey)
      : row.review?.note || ''
    note.disabled = trial.kept
    note.addEventListener('input', () => {
      noteDrafts.set(noteKey, note.value)
      requestVersion++
      queueNotes()
    })
    note.addEventListener('blur', () => {
      void flushNotes().catch(() => {})
    })
    review.append(label, note)
    box.append(review)
    box.append(
      el(
        'p',
        'ql-caption',
        `${row.provenance.client} · ${row.provenance.model} · ${Math.round(row.provenance.latencyMs)} ms for the pair`
      )
    )
    const wire = el('details', 'ql-context'),
      code = el(
        'pre',
        '',
        JSON.stringify(
          {
            questions: trial.questions,
            original: row.original.answer,
            candidate: row.candidate.answer
          },
          null,
          2
        )
      )
    wire.append(el('summary', '', 'Exact questions & raw answers'), code)
    box.append(wire)
  }
  function render() {
    $('qlSetup').hidden = !!trial || history
    $('qlRun').hidden = !trial || history
    $('qlWorkspace').hidden = history
    $('qlHistoryList').hidden = !history
    $('qlChangedLabel').hidden = !trial
    $('qlStart').textContent =
      `Compare ${draft?.rows.length || $('qlCount').value} rows`
    $('qlNew').classList.toggle('on', !history)
    $('qlHistory').classList.toggle('on', history)
    if (trial) {
      const s = trial.summary
      $('qlOldHeader').textContent = trial.original.header
      $('qlNewHeader').textContent = trial.candidate.header
      $('qlNumbers').replaceChildren(
        el('b', '', `${s.changed}`),
        el('span', '', ` changed · ${s.answered}/${s.total} compared`),
        el(
          'small',
          '',
          `${trial.kept ? 'KEPT' : trial.status.toUpperCase()} · ${s.calls} row calls · your preferences: original ${s.votes.original} / new ${s.votes.candidate} / unsure ${s.votes.unsure}`
        )
      )
      $('qlInterpret').textContent = trial.stale
        ? 'The current rows, context or original question changed. This frozen trial is still readable; start another before applying it.'
        : s.providers.includes('mock')
          ? 'Offline stand-in answers: use this to practice the flow, not to decide which wording is better.'
          : 'A changed answer is a reason to look closer. More confidence does not establish a better answer.'
      $('qlDownload').href = `/download/question-trial-${trial.id}.zip`
      $('qlDownload').download = `question-trial-${trial.id}.zip`
      $('qlListTitle').textContent = `${s.total} frozen rows · click to review`
      $('qlFoot').textContent = trial.kept
        ? 'Kept in .harness/question-trials · source file unchanged.'
        : 'Keep this trial to retain it across viewer restarts.'
    } else {
      $('qlListTitle').textContent = draft
        ? `${draft.rows.length} frozen rows · click to inspect`
        : '03 / Inspect the rows'
      $('qlFoot').textContent =
        'Selected rows are a deliberate test set, not a random sample.'
    }
    const data = trial || draft
    let rows = data?.rows || []
    if (trial && $('qlChanged').checked)
      rows = rows.filter(
        (r) =>
          r.original && r.candidate && r.original.shown !== r.candidate.shown
      )
    const sig = JSON.stringify([rows, selected, !!trial])
    if (sig !== listSig) {
      listSig = sig
      const scroll = $('qlRows').scrollTop
      $('qlRows').replaceChildren(...rows.map((row) => rowCard(row, !!trial)))
      if (!rows.length)
        $('qlRows').append(
          el(
            'p',
            'ql-empty',
            trial
              ? 'No changed answer labels in this view.'
              : 'Choose a question, then preview the rows.'
          )
        )
      $('qlRows').scrollTop = scroll
    }
    renderDetail()
    mode()
    updateButtons()
  }
  function queueNotes() {
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => {
      void flushNotes().catch(() => {})
    }, 600)
  }
  async function flushNotes() {
    clearTimeout(noteTimer)
    const row = trial?.rows.find((r) => r.id === selected)
    const key = `${trial?.id}/${row?.id}`
    if (
      !trial ||
      trial.kept ||
      !row?.original ||
      !row?.candidate ||
      !noteDrafts.has(key)
    )
      return savePromise
    const id = trial.id,
      rowId = row.id,
      note = noteDrafts.get(key)
    savePromise = savePromise
      .catch(() => {})
      .then(async () => {
        const res = await call('labReview', { id, row: rowId, note })
        if (!res.ok) {
          message(`Note not saved: ${res.error}`, true)
          throw new Error(res.error)
        }
        if (trial?.id === id) trial = res.trial
        if (noteDrafts.get(key) === note) noteDrafts.delete(key)
      })
    await savePromise
  }
  async function refresh() {
    if (!trial || history || !dialog.open || busy) return
    if (noteDrafts.has(`${trial.id}/${selected}`)) return
    const id = trial.id,
      version = requestVersion
    const res = await call('labGet', { id })
    if (id !== trial?.id || version !== requestVersion) return
    if (!res.ok) {
      message(
        `This trial is no longer available on the server: ${res.error}. Kept trials can be reopened from the shelf.`,
        true
      )
      return
    }
    trial = res.trial
    render()
  }
  async function showHistory() {
    await flushNotes()
    requestVersion++
    history = true
    const res = await call('labList')
    if (!res.ok) throw new Error(res.error)
    const box = $('qlHistoryList')
    box.replaceChildren()
    for (const [name, items] of [
      ['Open in this viewer', res.open],
      ['Kept trials', res.kept]
    ]) {
      box.append(el('h3', '', name))
      if (!items.length) box.append(el('p', 'ql-caption', 'No trials yet.'))
      for (const item of items) {
        const b = el('button', 'ql-history-card')
        b.append(
          el('b', '', item.candidate),
          el(
            'span',
            '',
            `${item.title} · ${item.summary.answered}/${item.summary.total} rows · ${item.summary.changed} changed · ${item.status}`
          )
        )
        b.addEventListener('click', () =>
          guard(async () => {
            const got = await call('labGet', { id: item.id })
            if (!got.ok) throw new Error(got.error)
            trial = got.trial
            draft = null
            history = false
            selected = trial.rows[0]?.id
            detailSig = ''
            listSig = ''
            message()
            render()
          })
        )
        box.append(b)
      }
    }
    render()
  }
  function show() {
    openFocus = document.activeElement
    token = getState()?.questionLabToken || token
    dialog.showModal()
    document.body.classList.add('ql-open')
    if (!trial && !draft) setup()
    render()
    clearInterval(poll)
    poll = setInterval(() => {
      void refresh()
    }, 850)
  }
  async function close() {
    await flushNotes()
    clearInterval(poll)
    dialog.close()
    document.body.classList.remove('ql-open')
    openFocus?.focus()
  }
  $('qlClose').addEventListener('click', () => guard(close))
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault()
    void guard(close)
  })
  $('qlColumn').addEventListener('change', chooseColumn)
  for (const id of ['qlCount', 'qlMethod', 'qlPin'])
    $(id).addEventListener('change', clearPreview)
  $('qlHeader').addEventListener('input', updateButtons)
  $('qlChanged').addEventListener('change', () =>
    guard(async () => {
      await flushNotes()
      if ($('qlChanged').checked && trial) {
        const changed = trial.rows.filter(
          (r) =>
            r.original && r.candidate && r.original.shown !== r.candidate.shown
        )
        if (!changed.some((r) => r.id === selected))
          selected = changed[0]?.id || null
      }
      detailSig = ''
      render()
    })
  )
  $('qlPreview').addEventListener('click', () => guard(preview))
  $('qlStart').addEventListener('click', () =>
    guard(async () => {
      let res = await call('labStart', {
        draft: draft.id,
        header: $('qlHeader').value
      })
      // A lost response must not create another paid trial. The preview id is the run id.
      if (!res.ok && !res.code) {
        const recover = await call('labGet', { id: draft.id })
        if (recover.ok) res = recover
      }
      if (!res.ok) throw new Error(res.error)
      trial = res.trial
      selected = trial.rows[0]?.id
      detailSig = ''
      listSig = ''
      requestVersion++
      message()
      render()
    })
  )
  $('qlCancel').addEventListener('click', () =>
    guard(async () => {
      const res = await call('labCancel', { id: trial.id })
      if (!res.ok) throw new Error(res.error)
      trial = res.trial
      message(
        'No more rows will start. Calls already in flight can still finish.'
      )
      render()
    })
  )
  $('qlKeep').addEventListener('click', () =>
    guard(async () => {
      await flushNotes()
      const res = await call('labKeep', { id: trial.id })
      if (!res.ok) throw new Error(res.error)
      trial = res.trial
      detailSig = ''
      message(
        'Kept with the frozen rows, exact questions, answers and your review.'
      )
      render()
    })
  )
  $('qlApply').addEventListener('click', () =>
    guard(async () => {
      const res = await call('labApply', { id: trial.id })
      if (!res.ok) throw new Error(res.error)
      message(
        `Added a separate column; ${res.applied.reused} trial rows reused. It will fill as the sheet runs. This column lasts in this pane; ask your agent to retain the wording in sheet.json.`
      )
      $('qlApply').textContent = 'Column added'
    })
  )
  $('qlHistory').addEventListener('click', () => guard(showHistory))
  $('qlNew').addEventListener('click', () =>
    guard(async () => {
      await flushNotes()
      requestVersion++
      trial = null
      draft = null
      history = false
      selected = null
      detailSig = ''
      listSig = ''
      $('qlChanged').checked = false
      message()
      setup()
      render()
    })
  )
  window.addEventListener('beforeunload', (e) => {
    if (trial && !trial.kept) {
      e.preventDefault()
      e.returnValue = ''
    }
  })
  return { show }
}
