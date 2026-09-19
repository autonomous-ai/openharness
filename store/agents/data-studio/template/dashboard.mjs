import { parseCSV, numericColumns, inferFields, summarize, exportCSV } from './data.mjs';

const $ = id => document.getElementById(id);
const colors = ['#2b6451', '#88a965', '#c29a5c', '#829ea9', '#b57c75', '#817da3', '#4a8e89', '#9a8255'];
const NS = 'http://www.w3.org/2000/svg';
let table, fields, enabled, groups, periods, snapshot, mode = 'trend', selected = null;
const title = value => value.replaceAll('_', ' ').replace(/^\w/, c => c.toUpperCase());
// Units belong to the data, never guessed from a word such as "revenue".
const currency = () => fields.metric.match(/_(usd|eur|gbp|jpy|vnd)$/i)?.[1].toUpperCase();
const format = (value, compact = false) => new Intl.NumberFormat('en-US', {
  ...(currency() ? { style: 'currency', currency: currency() } : {}),
  maximumFractionDigits: compact ? 1 : 2, ...(compact ? { notation: 'compact' } : {})
}).format(value);
const color = group => colors[groups.indexOf(group) % colors.length];
function element(tag, attributes = {}, text, svg = false) {
  const node = svg ? document.createElementNS(NS, tag) : document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) node.setAttribute(key, value);
  if (text !== undefined) node.textContent = text;
  return node;
}
function options(id, values, chosen) {
  $(id).replaceChildren(...values.map(value => element('option', { value }, value)));
  $(id).value = chosen;
}
function configure() {
  groups = [...new Set(table.rows.map(row => row[fields.group]))].sort((a,b) => a.localeCompare(b));
  periods = [...new Set(table.rows.map(row => row[fields.period]))].sort((a,b) => a.localeCompare(b, undefined, { numeric: true }));
  enabled = new Set(groups); selected = null;
  options('start', periods, periods[0]); options('end', periods, periods.at(-1));
  options('period-field', table.headers, fields.period); options('group-field', table.headers, fields.group);
  options('metric-field', numericColumns(table), fields.metric);
  $('group-label').textContent = title(fields.group);
  $('regions').replaceChildren(...groups.map(group => {
    const button = element('button', { class: 'region', 'aria-pressed': 'true', 'aria-label': group });
    const dot = element('i', { class: 'dot', 'aria-hidden': 'true' }); dot.style.background = color(group);
    button.append(dot, element('span', {}, group), element('span', { class: 'count' }, table.rows.filter(row => row[fields.group] === group).length), element('span', { class: 'check', 'aria-hidden': 'true' }, '✓'));
    button.onclick = () => {
      enabled.has(group) ? enabled.delete(group) : enabled.add(group);
      button.setAttribute('aria-pressed', String(enabled.has(group)));
      button.querySelector('.check').textContent = enabled.has(group) ? '✓' : '';
      selected = null; render();
    };
    return button;
  }));
  render();
}
function render() {
  snapshot = summarize(table, fields, enabled, { start: $('start').value, end: $('end').value });
  const { total, rows, ranked, growth } = snapshot;
  const metric = title(fields.metric);
  $('headline').textContent = metric + ', in perspective.';
  $('takeaway').textContent = rows.length && ranked.length
    ? ranked[0].name + ' leads your selection with ' + format(ranked[0].value) + '. Explore what changes across ' + snapshot.periods.length + ' periods.'
    : 'Choose a group to start exploring.';
  $('total-label').textContent = 'Total ' + fields.metric.replaceAll('_',' ');
  $('total').textContent = rows.length ? format(total) : '—';
  $('row-count').textContent = rows.length + ' of ' + table.rows.length + ' rows selected';
  $('growth').textContent = growth === null || !rows.length ? '—' : (growth > 0 ? '+' : '') + (growth * 100).toFixed(1) + '%';
  $('growth-detail').textContent = snapshot.periods.length < 2 ? 'Choose more than one period' : snapshot.periods[0] + ' → ' + snapshot.periods.at(-1);
  $('leader').textContent = rows.length ? ranked[0]?.name || '—' : '—';
  $('leader-detail').textContent = rows.length ? format(ranked[0]?.value || 0) + ' in this selection' : 'No groups selected';
  $('chart-title').textContent = metric + ' over time';
  $('chart-subtitle').textContent = (currency() ? currency() + ' · ' : '') + title(fields.period) + ' / ' + title(fields.group);
  $('export').disabled = !rows.length;
  $('tooltip').hidden = true;
  drawChart(); drawRanking(); drawTable();
  $('legend').replaceChildren(...snapshot.series.map(series => {
    const item = element('span'), dot = element('i', { class: 'dot', 'aria-hidden': 'true' });
    dot.style.background = color(series.name); item.append(dot, document.createTextNode(series.name)); return item;
  }));
}
function drawChart() {
  const plot = $('plot'); plot.replaceChildren();
  if (!snapshot.rows.length) {
    const empty = element('div', { class: 'empty' });
    empty.append(element('strong', {}, 'A fresh perspective starts with a selection.'), document.createTextNode('Choose a group, or reset your filters.'));
    plot.append(empty); return;
  }
  const W = 900, H = 310, L = 70, R = 30, T = 30, B = 42, pw = W - L - R, ph = H - T - B;
  const values = snapshot.series.flatMap(series => series.values.map(point => point.value));
  let min = Math.min(0, ...values), max = Math.max(0, ...values);
  if (min === max) max = min + 1;
  const extent = max - min; if (min < 0) min -= extent * .08; if (max > 0) max += extent * .12;
  const y = value => T + ph * (max - value) / (max - min);
  const step = pw / Math.max(1, snapshot.periods.length);
  const x = index => L + step * (index + .5);
  const svg = element('svg', { viewBox: '0 0 '+W+' '+H, role: 'img', 'aria-label': fields.metric + ' by ' + fields.period + ' and ' + fields.group }, undefined, true);
  for (let i = 0; i <= 4; i++) {
    const value = min + (max - min) * i / 4, yy = y(value);
    svg.append(element('line', { x1: L, x2: W-R, y1: yy, y2: yy, stroke: '#e8ede5', 'stroke-dasharray': '3 5' }, undefined, true));
    svg.append(element('text', { x: L-12, y: yy+4, 'text-anchor': 'end' }, format(value,true), true));
  }
  svg.append(element('line', { x1:L, x2:W-R, y1:y(0), y2:y(0), stroke:'#dce4d8' }, undefined, true));
  const stride = Math.max(1, Math.ceil(snapshot.periods.length / 8));
  snapshot.periods.forEach((period,i) => {
    if (i % stride === 0 || i === snapshot.periods.length-1) svg.append(element('text', {x:x(i), y:H-14, 'text-anchor':'middle'}, period.length > 14 ? period.slice(0,12)+'…' : period, true));
  });
  snapshot.series.forEach((series, si) => {
    if (mode === 'trend') {
      const points = series.values.map((point,i) => x(i)+','+y(point.value)).join(' ');
      svg.append(element('polyline', { points, fill:'none', stroke:color(series.name), 'stroke-width':2.5, 'stroke-linejoin':'round', 'stroke-linecap':'round' }, undefined, true));
    }
    series.values.forEach((point, i) => {
      const label = series.name+' · '+point.period+' · '+format(point.value);
      let mark;
      if (mode === 'trend') mark = element('circle', {cx:x(i), cy:y(point.value), r:4, fill:'white', stroke:color(series.name), 'stroke-width':2}, undefined, true);
      else {
        const barWidth = Math.max(1, step * .64 / snapshot.series.length);
        mark = element('rect', {x:x(i)-step*.32+si*barWidth, y:Math.min(y(0),y(point.value)), width:Math.max(.5,barWidth-2), height:Math.max(1,Math.abs(y(point.value)-y(0))), rx:2, fill:color(series.name)}, undefined, true);
      }
      mark.setAttribute('class','point'); mark.setAttribute('tabindex','0'); mark.setAttribute('role','button'); mark.setAttribute('aria-label',label);
      const show = event => {
        const tip = $('tooltip'); tip.replaceChildren(element('span',{},series.name+' · '+point.period),element('strong',{},format(point.value)));
        tip.hidden = false;
        const rect = mark.getBoundingClientRect();
        const px = Number.isFinite(event.clientX) ? event.clientX : rect.x + rect.width/2;
        const py = Number.isFinite(event.clientY) ? event.clientY : rect.y;
        tip.style.left = Math.max(8,Math.min(innerWidth-tip.offsetWidth-8, px+14))+'px';
        tip.style.top = Math.max(8,Math.min(innerHeight-tip.offsetHeight-8,py-55))+'px';
      };
      mark.onpointerenter = show; mark.onfocus = show;
      mark.onpointerleave = () => $('tooltip').hidden = true;
      mark.onblur = () => $('tooltip').hidden = true;
      mark.onclick = event => { selected = { group: series.name, period: point.period }; drawTable(); show(event); };
      mark.onkeydown = event => { if (event.key==='Enter' || event.key===' ') { event.preventDefault(); mark.onclick(event); } if(event.key==='Escape') $('tooltip').hidden=true; };
      svg.append(mark);
    });
  });
  plot.append(svg);
}
function drawRanking() {
  const maximum = Math.max(1,...snapshot.ranked.map(row=>Math.abs(row.value)));
  $('ranking').replaceChildren(...snapshot.ranked.map(row => {
    const container = element('div',{class:'ranking-row'}), label = element('div',{class:'ranking-label'}), track=element('div',{class:'track'}), bar=element('i');
    label.append(element('span',{},row.name),element('span',{},format(row.value)));
    bar.style.width=(Math.abs(row.value)/maximum*100)+'%'; bar.style.background=color(row.name); track.append(bar); container.append(label,track); return container;
  }));
  if (!snapshot.rows.length) $('ranking').textContent='No groups selected.';
}
function drawTable() {
  const columns = [...new Set([fields.period,fields.group,fields.metric])];
  const head = element('tr'); head.append(...columns.map(key=>element('th',{scope:'col'},title(key))));
  $('table').querySelector('thead').replaceChildren(head);
  const rows = selected ? snapshot.rows.filter(row=>row[fields.group]===selected.group && row[fields.period]===selected.period) : snapshot.rows;
  $('table').querySelector('tbody').replaceChildren(...rows.slice(0,100).map(row=>{
    const tr = element('tr',selected?{class:'selected'}:{});
    tr.append(...columns.map(key=>element('td',{},key===fields.metric?format(Number(row[key])):row[key]))); return tr;
  }));
  $('table-note').textContent = selected ? 'Inspecting '+selected.group+' · '+selected.period+' — change a filter to clear' : (rows.length>100?'First 100 of '+rows.length+' rows · export for all rows':rows.length+' source rows · values are aggregated in the chart');
}
function failure(error) {
  $('error-message').textContent=error.message;
  $('error').hidden=false; $('dashboard').hidden=true; $('loading').hidden=true; $('export').disabled=true;
}
function accept(text,name) {
  try {
    if(text.length>5*1024*1024) throw new Error('Choose a CSV smaller than 5 MB for this interactive view.');
    const parsed = parseCSV(text);
    if(!parsed.rows.length) throw new Error('The header is present, but there are no data rows yet.');
    const inferred = inferFields(parsed);
    table=parsed; fields=inferred;
    $('source').textContent=name; $('error').hidden=true; $('loading').hidden=true; $('dashboard').hidden=false;
    configure();
  } catch(error) { failure(error); }
}
async function load() {
  $('loading').hidden=false; $('dashboard').hidden=true; $('error').hidden=true;
  try {
    const response=await fetch('data.csv');
    if(!response.ok) throw new Error('data.csv returned HTTP '+response.status+'. Add it to this workspace or open a CSV.');
    accept(await response.text(),'data.csv');
  } catch(error) { failure(error); }
}
$('open').onclick=()=>$('upload').click();
$('upload').onchange=async event=>{
  const file=event.target.files[0]; if(!file)return;
  if(file.size>5*1024*1024) failure(new Error('Choose a CSV smaller than 5 MB.'));
  else accept(await file.text(),file.name);
  event.target.value='';
};
$('retry').onclick=load;
$('reset').onclick=()=>configure();
for(const id of ['start','end']) $(id).onchange=()=>{
  if(periods.indexOf($('start').value)>periods.indexOf($('end').value)) $(id==='start'?'end':'start').value=$(id).value;
  selected=null; render();
};
for(const [id,key] of [['period-field','period'],['group-field','group'],['metric-field','metric']]) $(id).onchange=()=>{
  const value=$(id).value;
  if((key==='period' && value===fields.group)||(key==='group' && value===fields.period)) {
    const other=key==='period'?'group':'period'; fields[other]=fields[key];
  }
  fields[key]=value; configure();
};
for(const kind of ['trend','bars']) $(kind).onclick=()=>{
  mode=kind;
  for(const id of ['trend','bars']) $(id).setAttribute('aria-pressed',String(id===mode));
  drawChart();
};
$('export').onclick=()=>{
  const blob=new Blob([exportCSV(table.headers,snapshot.rows)],{type:'text/csv;charset=utf-8'});
  const url=URL.createObjectURL(blob), link=document.createElement('a');
  link.href=url; link.download='data-studio-selection.csv'; link.click(); setTimeout(()=>URL.revokeObjectURL(url),30000);
};
await load();
