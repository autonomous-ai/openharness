const {el,text}=svg,w=width,h=height,wide=w/h>1.5,square=!wide&&w/h>.85,base=Math.min(w,h),pad=base*.075;
const rows=values.csv.trim().split(/\r?\n/).filter(Boolean).map(line=>{const cells=line.split(',');return {label:cells[0]?.trim(),value:cells.length===2&&cells[1].trim()?Number(cells[1]):NaN};});
if(rows.length<2||rows.length>24||rows.some(r=>!r.label||!Number.isFinite(r.value)||r.value<0))throw new Error('Use 2–24 CSV rows: month, non-negative rainfall in mm.');
const max=Math.max(...rows.map(r=>r.value),1),scale=Math.ceil(max/50)*50,total=rows.reduce((n,r)=>n+r.value,0),cx=wide?w*.35:w*.5,cy=wide?h*.52:square?h*.40:h*.44;
const columns=wide?3:Math.min(6,rows.length),numberY=wide?h*.61:h-pad*.5-(Math.ceil(rows.length/columns)-1)*base*.026;
const tx=wide?w*.67:pad,ty=wide?h*.40:numberY-base*.188,legendY=wide?ty+base*.16:numberY-base*.03;
const radius=Math.min(base*(wide?.35:square?.29:.36),wide?Infinity:ty-base*.1-cy),gap=radius/(rows.length+2),parts=[el('rect',{width:w,height:h,fill:values.paper})];
const type={fill:values.ink,'font-family':'Arial, Helvetica, sans-serif'};
parts.push(text('OBSERVATION / 001',{...type,x:pad,y:pad,'font-size':base*.014,'letter-spacing':base*.003}));
parts.push(text(values.place,{...type,x:w-pad,y:pad,'text-anchor':'end','font-size':base*.013,'letter-spacing':base*.001}));
for(let i=0;i<rows.length;i++){
 const row=rows[i],r=(i+2)*gap,fraction=row.value/scale,start=-Math.PI/2,end=start+fraction*Math.PI*2;
 const x=cx+Math.cos(end)*r,y=cy+Math.sin(end)*r,stroke=gap*values.ring/100;
 parts.push(el('circle',{cx,cy,r,fill:'none',stroke:values.ink,'stroke-opacity':.09,'stroke-width':stroke}));
 const style={fill:'none',stroke:values.accent,'stroke-width':stroke,'stroke-linecap':'round',opacity:.35+.65*i/Math.max(rows.length-1,1)};
 if(fraction===1)parts.push(el('circle',{cx,cy,r,...style}));
 else if(row.value>0)parts.push(el('path',{d:`M${cx} ${cy-r} A${r} ${r} 0 ${fraction>.5?1:0} 1 ${x} ${y}`,...style}));
}
parts.push(text('A YEAR',{...type,x:tx,y:ty,'font-size':base*.077,'font-weight':500,'letter-spacing':-base*.004}));
parts.push(text('OF RAIN.',{...type,x:tx,y:ty+base*.078,'font-size':base*.077,'font-weight':500,'letter-spacing':-base*.004}));
parts.push(text(`${total.toFixed(0)} MM / ${rows.length} OBSERVATIONS`,{...type,x:tx,y:ty+base*.123,'font-size':base*.016,'letter-spacing':base*.001}));
parts.push(text(`INNER TO OUTER: CSV ORDER / FULL RING = ${scale} MM`,{...type,x:tx,y:legendY,'font-size':base*.009,'letter-spacing':base*.0002}));
if(values.numbers){
 const startX=wide?tx:pad,startY=numberY,colW=wide?base*.13:(w-pad*2)/columns;
 rows.forEach((row,i)=>parts.push(text(`${row.label.toUpperCase()} ${row.value}`,{...type,x:startX+i%columns*colW,y:startY+Math.floor(i/columns)*base*.026,'font-size':base*.011,'font-family':'monospace'})));
}
return parts.join('');
