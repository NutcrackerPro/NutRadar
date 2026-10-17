export const NODES = Object.freeze([
  {id:'Node 01',x:-5.4,y:1.2,z:-4.4}, {id:'Node 02',x:5.4,y:1.2,z:-4.4},
  {id:'Node 03',x:5.4,y:1.2,z:4.4}, {id:'Node 04',x:-5.4,y:1.2,z:4.4}
]);

/** Deterministic illustration only; never represents measured Wi-Fi data. */
export function demoFrame(time=0, scenario='occupancy', epoch=1700000000000) {
  const paths=[
    {id:'Target 01',x:Math.sin(time*.19)*2.9-1,y:0,z:Math.cos(time*.14)*1.5-1.5,confidence:.95+Math.sin(time*.7)*.02},
    {id:'Target 02',x:Math.cos(time*.13)*2.1+1.5,y:0,z:Math.sin(time*.18)*2.3+.7,confidence:.91+Math.sin(time*.6+2)*.025},
    {id:'Target 03',x:Math.sin(time*.09+2)*2.7,y:0,z:Math.cos(time*.12+3)*2.4,confidence:.88+Math.sin(time*.5+1)*.03}
  ];
  return {version:1,kind:'tracks',source:'simulation',timestamp:epoch+Math.round(time*1000),coordinateSystem:'room-meters-y-up',tracks:scenario==='empty'?[]:scenario==='single'?paths.slice(0,1):paths,nodes:NODES.map(n=>({...n})),rssiDbm:-48+Math.round(Math.sin(time*.8)*3),channel:6,fps:30};
}

export function syntheticAmplitude(time) {
  return .48+Math.sin(time*4.1)*.11+Math.sin(time*9.3)*.065+Math.cos(time*17.2)*.035+Math.sin(time*.7)*.12;
}
