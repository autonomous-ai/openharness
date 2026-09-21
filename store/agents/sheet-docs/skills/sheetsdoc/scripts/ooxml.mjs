#!/usr/bin/env node
/**
 * ooxml.mjs — a zero-dependency, pure-Node writer for minimal-but-valid OOXML documents.
 *
 * Ships the lightweight, always-testable path for Sheet & Docs Studio: with only Node (no python,
 * no LibreOffice) it can write a real .docx and real .xlsx from a small declarative source, so the
 * harness and its repo runner verify the artifact pipeline on every machine. PDF conversion is an
 * optional layer on top (LibreOffice) and is not required by this helper.
 *
 * CLI:  node ooxml.mjs <workspaceDir>
 *     reads  <workspaceDir>/doc.json
 *     writes <workspaceDir>/out.docx, <workspaceDir>/out.xlsx
 *
 * Library:  import { buildDocx, buildXlsx, write } from './ooxml.mjs'
 */
import { deflateRawSync } from 'node:zlib'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// Minimal ZIP writer (store + deflate entries, no external deps)
// ---------------------------------------------------------------------------
const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

export function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function u16(v) { const b = Buffer.alloc(2); b.writeUInt16LE(v, 0); return b }
function u32(v) { const b = Buffer.alloc(4); b.writeUInt32LE(v, 0); return b }
function utf8(s) { return Buffer.from(s, 'utf8') }

/** files: [{name, data: Buffer|string}] -> ZIP Buffer (deflate with stored fallback). */
export function zip(files) {
  const entries = files.map(f => {
    const name = utf8(f.name)
    const data = Buffer.isBuffer(f.data) ? f.data : utf8(f.data)
    const crc = crc32(data)
    const deflated = deflateRawSync(data, { level: 9 })
    const use = deflated.length < data.length ? deflated : data
    const method = use === data ? 0 : 8
    return { name, data, crc, enc: use, method }
  })
  const chunks = []
  let offset = 0
  const central = []
  for (const e of entries) {
    const lfh = Buffer.concat([
      u32(0x04034b50), u16(20), u16(0), u16(e.method), u16(0), u16(0),
      u32(e.crc), u32(e.enc.length), u32(e.data.length),
      u16(e.name.length), u16(0), e.name,
    ])
    chunks.push(lfh, e.enc)
    central.push({
      name: e.name, crc: e.crc, encSize: e.enc.length, size: e.data.length,
      method: e.method, offset,
    })
    offset += lfh.length + e.enc.length
  }
  const cdStart = offset
  const cdParts = central.map(c =>
    Buffer.concat([
      u32(0x02014b50), u16(20), u16(20), u16(0), u16(c.method), u16(0), u16(0),
      u32(c.crc), u32(c.encSize), u32(c.size),
      u16(c.name.length), u16(0), u16(0), u16(0), u16(0), u32(0),
      u32(c.offset), c.name,
    ]))
  const cdSize = cdParts.reduce((a, p) => a + p.length, 0)
  const eocd = Buffer.concat([
    u32(0x06054b50), u16(0), u16(0), u16(entries.length), u16(entries.length),
    u32(cdSize), u32(cdStart), u16(0),
  ])
  return Buffer.concat([...chunks, ...cdParts, eocd])
}

// Portable report writer. Native LibreOffice conversion is a separate verified step.
const esc=value=>{const s=String(value);if(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/.test(s))throw new Error('Text contains invalid XML control characters.');return s.replace(/[<>&'"]/g,c=>({'<':'&lt;','>':'&gt;','&':'&amp;',"'":'&apos;','"':'&quot;'}[c]));};
const NS='http://schemas.openxmlformats.org/';
const xml=body=>'<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'+body;
const relationship=(id,type,target)=>'<Relationship Id="'+id+'" Type="'+NS+'officeDocument/2006/relationships/'+type+'" Target="'+target+'"/>';
const rels=items=>xml('<Relationships xmlns="'+NS+'package/2006/relationships">'+items.join('')+'</Relationships>');
const types=items=>xml('<Types xmlns="'+NS+'package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/>'+items.map(([path,type])=>'<Override PartName="/'+path+'" ContentType="application/vnd.openxmlformats-officedocument.'+type+'+xml"/>').join('')+'</Types>');
const col=i=>{let s='';for(let n=i+1;n>0;n=Math.floor((n-1)/26))s=String.fromCharCode(65+(n-1)%26)+s;return s;};
function text(value,label,max=2000){if(typeof value!=='string'||!value.trim()||value.length>max)throw new Error(label+' must be nonempty text under '+max+' characters.');esc(value);return value;}
export function prepare(source){
 if(!source||typeof source!=='object'||Array.isArray(source))throw new Error('doc.json must be an object.');
 const title=text(source.title,'title',200),subtitle=source.subtitle?text(source.subtitle,'subtitle',400):'',paragraphs=source.paragraphs||[];
 if(!Array.isArray(paragraphs)||paragraphs.length>40)throw new Error('Provide at most 40 paragraphs.');paragraphs.forEach(p=>text(p,'paragraph',10000));
 const model={title,subtitle,paragraphs:[...paragraphs],source:source.source?text(source.source,'source',2000):'Source: workspace doc.json',table:[],sheet:[],name:'Data',summary:null};
 if(source.comparison){
  const c=source.comparison;if(!Array.isArray(c.periods)||c.periods.length!==2)c.periods=null;
  if(!c.periods)throw new Error('comparison.periods needs two labels.');c.periods.forEach(p=>text(p,'period',40));
  if(!/^[A-Z]{3}$/.test(c.currency))throw new Error('comparison.currency needs a three-letter currency code.');const currency=c.currency;
  let money;try{money=n=>new Intl.NumberFormat('en-US',{style:'currency',currency,maximumFractionDigits:0}).format(n);money(0);}catch{throw new Error('Invalid comparison currency.');}
  if(!Array.isArray(c.rows)||!c.rows.length||c.rows.length>200)throw new Error('comparison.rows needs 1–200 regions.');
  const names=new Set(),rows=c.rows.map(row=>{text(row.region,'region',80);if(names.has(row.region))throw new Error('Region names must be unique.');names.add(row.region);for(const key of ['prior','current'])if(typeof row[key]!=='number'||!Number.isFinite(row[key])||row[key]<0||row[key]>1e12)throw new Error('Revenue inputs must be nonnegative finite numbers up to 1e12.');return {...row,delta:row.current-row.prior,growth:row.prior===0?null:(row.current-row.prior)/row.prior};});
  const prior=rows.reduce((n,r)=>n+r.prior,0),current=rows.reduce((n,r)=>n+r.current,0),delta=current-prior,growth=prior===0?null:delta/prior,largest=Math.max(...rows.map(r=>r.delta)),leaders=rows.filter(r=>r.delta===largest).map(r=>r.region);
  model.summary={prior,current,delta,growth,leaders,currency};model.name='Regional revenue';model.periods=c.periods;model.currency=currency;
  model.paragraphs.unshift('Revenue '+(delta>=0?'increased':'decreased')+' by '+money(Math.abs(delta))+(growth===null?'':', or '+(Math.abs(growth)*100).toFixed(1)+'%')+', from '+money(prior)+' in '+c.periods[0]+' to '+money(current)+' in '+c.periods[1]+'. '+(largest>0?leaders.join(' and ')+' contributed the largest absolute increase ('+money(largest)+(leaders.length>1?' each':'')+').':'No region recorded a positive increase.'));
  const percent=n=>n===null?'n.a.':(n*100).toFixed(1)+'%';
  model.table=[[ 'Region',...c.periods,'Change','Growth'],...rows.map(r=>[r.region,money(r.prior),money(r.current),money(r.delta),percent(r.growth)]),['Total',money(prior),money(current),money(delta),percent(growth)]];
  model.sheet=[[ 'Region',...c.periods,'Change ('+currency+')','Growth'],...rows.map((r,i)=>[r.region,r.prior,r.current,{formula:'C'+(i+7)+'-B'+(i+7),value:r.delta},{formula:'IF(B'+(i+7)+'=0,"n.a.",D'+(i+7)+'/B'+(i+7)+')',value:r.growth===null?'n.a.':r.growth}])];
  const total=rows.length+7;model.sheet.push(['Total',{formula:'SUM(B7:B'+(total-1)+')',value:prior},{formula:'SUM(C7:C'+(total-1)+')',value:current},{formula:'C'+total+'-B'+total,value:delta},{formula:'IF(B'+total+'=0,"n.a.",D'+total+'/B'+total+')',value:growth===null?'n.a.':growth}]);
  model.note='Amounts in '+currency+'. Growth is (current - prior) / prior; a zero prior value is shown as n.a. Totals and narrative are derived from the inputs, not typed separately.';
 }else{
  const sheet=source.sheet;if(!sheet||!Array.isArray(sheet.rows)||!sheet.rows.length||sheet.rows.length>1000)throw new Error('Provide comparison data or sheet.rows (1–1000 rows).');
  model.name=sheet.name||'Data';if(!model.name||model.name.length>31||/[\\/*?:[\]]/.test(model.name)||model.name.startsWith("'")||model.name.endsWith("'"))throw new Error('Invalid worksheet name.');
  const width=sheet.rows[0].length;if(!width||width>10)throw new Error('Generic sheets support 1–10 columns.');
  for(const row of sheet.rows){if(!Array.isArray(row)||row.length!==width)throw new Error('Sheet rows must be rectangular.');for(const cell of row)if(typeof cell!=='string'&&(typeof cell!=='number'||!Number.isFinite(cell)))throw new Error('Sheet cells must be literal text or finite numbers.');else esc(cell);}
  model.sheet=sheet.rows;model.table=sheet.rows.slice(0,31);model.note=sheet.rows.length>31?'The document displays the first 30 data rows; the workbook contains every row.':'Text beginning with = is stored as literal text. Generated cells do not execute user-supplied formulas.';
 }
 return model;
}
export function buildDocx(source){
 const m=prepare(source);
 const p=(value,style='Normal')=>'<w:p><w:pPr><w:pStyle w:val="'+style+'"/></w:pPr><w:r><w:t xml:space="preserve">'+esc(value)+'</w:t></w:r></w:p>';
 const width=9360,cols=m.table[0].length,first=cols===5?2500:Math.floor(width/cols),rest=Math.floor((width-first)/(cols-1||1)),widths=Array.from({length:cols},(_,i)=>i===0?first:i===cols-1?width-first-rest*(cols-2):rest);
 const table='<w:tbl><w:tblPr><w:tblW w:w="'+width+'" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>'+['top','left','bottom','right','insideH'].map(edge=>'<w:'+edge+' w:val="single" w:sz="4" w:color="D8DDD8"/>').join('')+'</w:tblBorders><w:tblCellMar><w:top w:w="100" w:type="dxa"/><w:left w:w="100" w:type="dxa"/><w:bottom w:w="100" w:type="dxa"/><w:right w:w="100" w:type="dxa"/></w:tblCellMar></w:tblPr><w:tblGrid>'+widths.map(w=>'<w:gridCol w:w="'+w+'"/>').join('')+'</w:tblGrid>'+m.table.map((row,r)=>'<w:tr><w:trPr>'+(r===0?'<w:tblHeader/>':'')+'<w:cantSplit/></w:trPr>'+row.map((value,i)=>'<w:tc><w:tcPr><w:tcW w:w="'+widths[i]+'" w:type="dxa"/>'+(r===0?'<w:shd w:fill="E8EDE8"/>':'')+'</w:tcPr><w:p><w:pPr><w:spacing w:after="0"/><w:jc w:val="'+(i?'right':'left')+'"/></w:pPr><w:r><w:rPr><w:sz w:val="20"/>'+((r===0||(m.summary&&r===m.table.length-1))?'<w:b/>':'')+'</w:rPr><w:t>'+esc(value)+'</w:t></w:r></w:p></w:tc>').join('')+'</w:tr>').join('')+'</w:tbl>';
 const body=p(m.title,'Title')+(m.subtitle?p(m.subtitle,'Subtitle'):'')+p('At a glance','Heading1')+m.paragraphs.map(v=>p(v)).join('')+p(m.summary?'Revenue by region':'Working data','Heading1')+table+p(m.note,'Caption')+p('Source and use','Heading1')+p(m.source);
 const document=xml('<w:document xmlns:w="'+NS+'wordprocessingml/2006/main" xmlns:r="'+NS+'officeDocument/2006/relationships"><w:body>'+body+'<w:sectPr><w:footerReference w:type="default" r:id="rId2"/><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1080" w:right="1440" w:bottom="1080" w:left="1440" w:header="500" w:footer="500"/></w:sectPr></w:body></w:document>');
 const styles=xml('<w:styles xmlns:w="'+NS+'wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Arial" w:hAnsi="Arial"/><w:sz w:val="22"/><w:color w:val="202820"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="140" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style><w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:after="180"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="48"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Subtitle"><w:name w:val="Subtitle"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="320"/><w:keepNext/></w:pPr><w:rPr><w:color w:val="667066"/><w:sz w:val="22"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="260" w:after="120"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:color w:val="000000"/><w:sz w:val="27"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="Caption"><w:name w:val="Caption"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:before="140" w:after="180"/></w:pPr><w:rPr><w:sz w:val="18"/><w:color w:val="667066"/></w:rPr></w:style></w:styles>');
 const footer=xml('<w:ftr xmlns:w="'+NS+'wordprocessingml/2006/main">'+p('SHEET & DOCS STUDIO  |  Editable source: doc.json','Caption')+'</w:ftr>');
 return zip([{name:'[Content_Types].xml',data:types([['word/document.xml','wordprocessingml.document.main'],['word/styles.xml','wordprocessingml.styles'],['word/footer1.xml','wordprocessingml.footer']])},{name:'_rels/.rels',data:rels([relationship('rId1','officeDocument','word/document.xml')])},{name:'word/document.xml',data:document},{name:'word/styles.xml',data:styles},{name:'word/footer1.xml',data:footer},{name:'word/_rels/document.xml.rels',data:rels([relationship('rId1','styles','styles.xml'),relationship('rId2','footer','footer1.xml')])}]);
}
export function buildXlsx(source){
 const m=prepare(source),last=m.sheet.length+5,width=m.sheet[0].length,lastCol=col(width-1);
 const cell=(value,r,c,style)=>{const ref=col(c)+r;let content;if(typeof value==='object'){content=(typeof value.value==='string'?' t="str"':'')+'><f>'+esc(value.formula)+'</f><v>'+esc(value.value)+'</v>';}else if(typeof value==='number')content='><v>'+value+'</v>';else content=' t="inlineStr"><is><t xml:space="preserve">'+esc(value)+'</t></is>';return '<c r="'+ref+'" s="'+style+'"'+content+'</c>';};
 const rows=[
 '<row r="1" ht="35" customHeight="1">'+cell(m.title,1,0,1)+'</row>',
 '<row r="2" ht="25" customHeight="1">'+cell(m.subtitle,2,0,5)+'</row>',
 '<row r="4" ht="42" customHeight="1">'+cell(m.source,4,0,5)+'</row>',
 ...m.sheet.map((row,i)=>'<row r="'+(i+6)+'" ht="28" customHeight="1">'+row.map((v,c)=>cell(v,i+6,c,i===0?2:m.summary?(i===m.sheet.length-1?(c===4?8:7):c===1||c===2?3:c===4?6:4):typeof v==='number'?4:0)).join('')+'</row>'),
 '<row r="'+(last+2)+'" ht="46" customHeight="1">'+cell(m.note,last+2,0,5)+'</row>',
 '<row r="'+(last+4)+'" ht="36" customHeight="1">'+cell(m.summary?'Blue cells are editable inputs. Black cells calculate change, growth and totals. Edit doc.json and rebuild to refresh the Word/PDF report.':'Edit doc.json and rebuild to refresh all deliverables together.',last+4,0,5)+'</row>'
 ];
 const columns='<col min="1" max="1" width="25" customWidth="1"/>'+(width>1?'<col min="2" max="'+width+'" width="20" customWidth="1"/>':'');
 const merges=width>1?'<mergeCells count="5">'+[1,2,4,last+2,last+4].map(r=>'<mergeCell ref="A'+r+':'+lastCol+r+'"/>').join('')+'</mergeCells>':'';
 const worksheet=xml('<worksheet xmlns="'+NS+'spreadsheetml/2006/main"><dimension ref="A1:'+lastCol+(last+4)+'"/><sheetViews><sheetView showGridLines="0" workbookViewId="0"><pane ySplit="6" topLeftCell="A7" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="22"/><cols>'+columns+'</cols><sheetData>'+rows.join('')+'</sheetData><autoFilter ref="A6:'+lastCol+(m.summary?last-1:last)+'"/>'+merges+'<printOptions horizontalCentered="1"/><pageMargins left="0.5" right="0.5" top="0.6" bottom="0.6" header="0.2" footer="0.2"/><pageSetup paperSize="1" orientation="landscape" fitToWidth="1" fitToHeight="0"/></worksheet>');
 const money=m.summary?'&quot;'+m.currency+' &quot;#,##0;(&quot;'+m.currency+' &quot;#,##0);&quot;-&quot;':'#,##0.00;(#,##0.00);&quot;-&quot;';
 const font=(color,bold=false,size=11)=>'<font><sz val="'+size+'"/><color rgb="FF'+color+'"/><name val="Arial"/>'+(bold?'<b/>':'')+'</font>';
 const xf=(fontId=0,fillId=0,numFmtId=0,borderId=0,wrap=false)=>'<xf numFmtId="'+numFmtId+'" fontId="'+fontId+'" fillId="'+fillId+'" borderId="'+borderId+'" xfId="0" applyNumberFormat="1" applyFont="1" applyFill="1" applyAlignment="1" applyBorder="1"><alignment vertical="center"'+(wrap?' wrapText="1"':'')+'/></xf>';
 const styles=xml('<styleSheet xmlns="'+NS+'spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="'+money+'"/><numFmt numFmtId="165" formatCode="0.0%;(0.0%);&quot;-&quot;"/></numFmts><fonts count="6">'+font('253E34')+font('172D24',true,22)+font('FFFFFF',true)+font('2563A8')+font('66766B',false,10)+font('253E34',true)+'</fonts><fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF315443"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border/><border><top style="thin"><color rgb="FFAABCAF"/></top></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="9">'+xf()+xf(1)+xf(2,2)+xf(3,0,164)+xf(0,0,164)+xf(4,0,0,0,true)+xf(0,0,165)+xf(5,0,164,1)+xf(5,0,165,1)+'</cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>');
 const workbook=xml('<workbook xmlns="'+NS+'spreadsheetml/2006/main" xmlns:r="'+NS+'officeDocument/2006/relationships"><sheets><sheet name="'+esc(m.name)+'" sheetId="1" r:id="rId1"/></sheets><definedNames><definedName name="_xlnm.Print_Area" localSheetId="0">&apos;'+esc(m.name.replace(/'/g,"''"))+'&apos;!$A$1:$'+lastCol+'$'+(last+4)+'</definedName></definedNames><calcPr calcId="191029" fullCalcOnLoad="1" forceFullCalc="1"/></workbook>');
 return zip([{name:'[Content_Types].xml',data:types([['xl/workbook.xml','spreadsheetml.sheet.main'],['xl/worksheets/sheet1.xml','spreadsheetml.worksheet'],['xl/styles.xml','spreadsheetml.styles']])},{name:'_rels/.rels',data:rels([relationship('rId1','officeDocument','xl/workbook.xml')])},{name:'xl/workbook.xml',data:workbook},{name:'xl/_rels/workbook.xml.rels',data:rels([relationship('rId1','worksheet','worksheets/sheet1.xml'),relationship('rId2','styles','styles.xml')])},{name:'xl/worksheets/sheet1.xml',data:worksheet},{name:'xl/styles.xml',data:styles}]);
}
export function write(workspaceDir,source){const docx=buildDocx(source),xlsx=buildXlsx(source);writeFileSync(join(workspaceDir,'out.docx'),docx);writeFileSync(join(workspaceDir,'out.xlsx'),xlsx);return {docx:docx.length,xlsx:xlsx.length};}
if(process.argv[1]&&process.argv[1].endsWith('/ooxml.mjs')){const workspace=process.argv[2];if(!workspace)throw new Error('Usage: node ooxml.mjs WORKSPACE');console.log(write(workspace,JSON.parse(readFileSync(join(workspace,'doc.json'),'utf8'))));}
