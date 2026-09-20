const {el, text}=svg, w=width,h=height,wide=w/h>1.6,square=!wide&&w/h>.85,base=Math.min(w,h),pad=base*.065,r=rng('engraving');
const out=[el('rect',{width:w,height:h,fill:values.paper})];
const ink={fill:values.ink,'font-family':'Georgia, serif'};
out.push(el('rect',{x:pad*.6,y:pad*.6,width:w-pad*1.2,height:h-pad*1.2,fill:'none',stroke:values.ink,'stroke-width':base*.002}));
function leaf(x,y,size,angle){
 const leaf=[];
 leaf.push(el('path',{d:`M0 0 C${-size*.8} ${-size*.4},${-size*.35} ${-size*1.15},0 ${-size*1.6} C${size*.65} ${-size*.9},${size*.65} ${-size*.2},0 0Z`,fill:values.ink}));
 leaf.push(el('path',{d:`M0 0Q${size*.04} ${-size*.7},0 ${-size*1.48}`,fill:'none',stroke:values.paper,'stroke-width':size*.022}));
 for(let i=1;i<values.detail;i++){
  const t=i/values.detail,yy=-size*1.48*t,extent=Math.sin(t*Math.PI)*size*.33;
  leaf.push(el('path',{d:`M0 ${yy} Q${-extent*.5} ${yy+size*.12},${-extent} ${yy+size*.20} M0 ${yy} Q${extent*.5} ${yy+size*.08},${extent} ${yy+size*.16}`,fill:'none',stroke:values.paper,'stroke-width':size*.009}));
 }
 return el('g',{transform:`translate(${x} ${y}) rotate(${angle})`},leaf);
}
const cx=wide?w*.73:w*.51,cy=wide?h*.70:square?h*.66:h*.62,size=base*(square?.14:.20);
let branch=el('path',{d:`M${cx} ${cy} Q${cx-size*.5} ${cy-size*.6},${cx+size*.2} ${cy-size*2}`,fill:'none',stroke:values.ink,'stroke-width':size*.028});
for(let i=0;i<5;i++){
 const y=cy-i*size*.36,x=cx+Math.sin(i)*size*.10;
 branch+=leaf(x,y,size*(.63+r()*.2),(i%2?-1:1)*(45+r()*22));
 if(i<4){branch+=el('circle',{cx:x+size*.16,cy:y-size*.10,r:size*.09,fill:values.accent});branch+=el('circle',{cx:x+size*.27,cy:y-size*.17,r:size*.075,fill:values.accent});}
}
out.push(branch);
const textX=wide?w*.09:w/2,anchor=wide?'start':'middle',font=Math.min(base*(square?.12:.14),(wide?w*.48:w*.82)/Math.max(values.brand.length,1)*1.4);
out.push(text('SMALL LOT / SLOW ROASTED',{...ink,x:textX,y:h*(wide?.25:square?.09:.10),'text-anchor':anchor,'font-family':'Arial, sans-serif','font-size':base*.014,'letter-spacing':base*.003}));
out.push(text(values.brand,{...ink,x:textX,y:h*(wide?.41:square?.23:.20),'text-anchor':anchor,'font-size':font,'letter-spacing':-font*.06}));
out.push(text('COFFEE ROASTERS',{...ink,x:textX,y:h*(wide?.47:square?.28:.235),'text-anchor':anchor,'font-family':'Arial, sans-serif','font-size':base*.017,'letter-spacing':base*.004}));
const y=h*(wide?.65:square?.79:.76);
out.push(text(values.origin,{...ink,x:textX,y,'text-anchor':anchor,'font-family':'Arial, sans-serif','font-size':base*.025,'font-weight':700}));
out.push(text(values.lot,{...ink,x:textX,y:y+base*.048,'text-anchor':anchor,'font-family':'Arial, sans-serif','font-size':base*.017}));
out.push(text(values.tasting,{...ink,x:textX,y:y+base*.093,'text-anchor':anchor,'font-family':'Arial, sans-serif','font-size':base*.012,'letter-spacing':base*.0007}));
out.push(text(values.weight,{...ink,x:w-pad,y:h-pad,'text-anchor':'end','font-size':base*.023}));
if(assets.logo)out.push(el('image',{href:assets.logo,x:pad,y:h-pad-base*.07,width:base*.07,height:base*.07}));
return out.join('');
