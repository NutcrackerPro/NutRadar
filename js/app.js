import {RadarScene} from './scene.js';
import {demoFrame,syntheticAmplitude} from './demo.js';
import {validateFrame,parseRecording,MAX_FRAMES,MAX_INPUT_BYTES} from './protocol.js';

const $=id=>document.getElementById(id);
const sourceDialog=$('source-dialog');
let mode='demo', frame=demoFrame(0), demoTime=0, epoch=Date.now(), selectedId='Target 01';
let paused=matchMedia('(prefers-reduced-motion: reduce)').matches, speed=1, lastRender=0, lastUI=0;
let recording=false, captured=[], capturedBytes=128, lastRecording=[], replay=[], replayElapsed=0, replayIndex=0;
let eventSource=null, serialPort=null, serialReader=null, serialTask=null, transportEpoch=0;
let lastReceived=0, receiveTimes=[], stale=false, lastCapturedTimestamp=null, toastTimer;
let signalHistory=Array.from({length:80},(_,i)=>syntheticAmplitude(i/10));
let lastDemoFrame=0;
const scene=new RadarScene($('scene-container'),{onSelect:id=>{selectedId=id;scene.selected=id;renderUI();}});
scene.selected=selectedId;

function toast(message){$('toast').textContent=message;$('toast').hidden=false;clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').hidden=true,5500);}
function closeDialogs(){document.querySelectorAll('dialog[open]').forEach(d=>d.close());}
function openDialog(id){closeDialogs();$(id).showModal();}
function showError(message){$('source-error').textContent=message;toast(message);}
function value(el,number,unit){const node=$(el);node.replaceChildren(document.createTextNode(number));const span=document.createElement('span');span.textContent=unit;node.append(span);}
function formatTime(ms){const seconds=Math.floor(Math.max(0,ms)/1000);return `${Math.floor(seconds/60)}:${String(seconds%60).padStart(2,'0')}`;}
function rssiText(number){return typeof number==='number'?String(Math.round(number)).replace('-','−'):'—';}
function labelForSource(){return mode==='demo'?'SIMULATED':mode==='replay'?'REPLAY':frame.source==='simulation'?'SYNTHETIC INPUT':frame.kind==='rssi'?'SIGNAL ONLY':frame.kind==='csi'?'RAW CSI':'EXTERNAL ESTIMATES';}

function renderUI(){
  const live=mode==='serial'||mode==='bridge', hasData=live&&lastReceived>0;
  const sourceSynthetic=frame.source==='simulation';
  const dataUsable=!live||hasData&&!stale;
  const tracks=dataUsable?frame.tracks:[];
  const signalOnly=frame.kind==='rssi';
  value('target-count',signalOnly?'—':String(tracks.length).padStart(2,'0'),signalOnly?'unavailable':'targets');
  value('node-count',String(dataUsable?signalOnly?1:frame.nodes.length:0).padStart(2,'0'),signalOnly?'device':'nodes');
  value('signal-strength',dataUsable?rssiText(frame.rssiDbm):'—','dBm');
  const rate=paused&&!live?0:receiveTimes.filter(t=>performance.now()-t<1000).length;
  value('frame-rate',dataUsable?String(rate):'0','Hz');
  $('target-caption').textContent=signalOnly?'RSSI cannot locate targets':mode==='demo'?'Simulated room occupancy':frame.kind==='csi'?'Raw CSI · no localization':mode==='replay'?'Recorded estimated positions':sourceSynthetic?'Synthetic external positions':'External estimated positions';
  $('node-caption').textContent=mode==='demo'?'Virtual mesh · 12 × 10 m':dataUsable?signalOnly?'Connected laptop · unpositioned':'Reported sensor anchors':'Waiting for sensor data';
  $('signal-caption').textContent=mode==='demo'?'Synthetic RSSI':mode==='replay'?'Recorded RSSI':sourceSynthetic?'Synthetic external RSSI':'Reported sensor RSSI';
  $('rate-caption').textContent=mode==='demo'?'Simulation output':mode==='replay'?'Recording playback':'Received frames / second';
  $('mode-label').textContent=mode==='demo'?'Demo mode':mode==='replay'?'Recording playback':stale?'Stream paused':hasData?'Sensor connected':'Waiting for data';
  $('mode-description').textContent=mode==='demo'?'Synthetic signals. Real possibilities. No hardware connected.':mode==='replay'?`Recorded ${sourceSynthetic?'synthetic':'hardware-reported'} data · ${replay.length.toLocaleString()} frames`:stale?'No valid frame for 3 seconds. Previous targets have been cleared.':!hasData?'Connection open. Waiting for a valid NutRadar frame.':sourceSynthetic?'Synthetic input received from external transport.':signalOnly?'Measured laptop Wi-Fi strength. No spatial or presence detection.':frame.kind==='csi'?'Raw CSI telemetry. 3D localization is not available.':'External estimated tracks. Illustrative avatars show reported coordinates.';
  $('scene-pill').textContent=labelForSource();
  $('stage-status').textContent=mode==='demo'?'DEMO STREAM':mode==='replay'?'RECORDED STREAM':stale?'STALE · NO DATA':hasData?`${mode==='serial'?'USB':'LOCAL'} STREAM`:'AWAITING STREAM';
  $('stage-subtitle').textContent=mode==='demo'?'ROOM 01 · 120 m²':signalOnly?'LAPTOP RSSI · NO SPATIAL ESTIMATE':frame.kind==='csi'?'CSI TELEMETRY · NO SPATIAL ESTIMATE':'COORDINATES · METERS · Y UP';
  $('signal-chart-title').textContent=signalOnly?'Wi-Fi signal strength':'Signal amplitude';
  $('signal-axis-label').textContent=signalOnly?'RELATIVE STRENGTH · −100 TO −20 dBm':'RELATIVE AMPLITUDE';
  $('signal-type').textContent=mode==='demo'?'SYNTHETIC CSI':signalOnly?(mode==='replay'?'RECORDED RSSI':sourceSynthetic?'SYNTHETIC RSSI':'MEASURED RSSI'):mode==='replay'?'RECORDED DATA':frame.kind==='csi'?'CSI AMPLITUDE':'NO CSI IN TRACK FRAME';
  $('signal-series-label').textContent=mode==='demo'?'Virtual node 01':signalOnly?(frame.noiseDbm==null?'Laptop Wi-Fi':`Noise ${rssiText(frame.noiseDbm)} dBm`):frame.kind==='csi'?(frame.nodeId||'Sensor amplitude'):'No amplitude samples';
  $('footer-status').textContent=recording?`Recording · ${captured.length.toLocaleString()} / ${MAX_FRAMES.toLocaleString()} frames`:mode==='demo'?'All processing happens on your device':mode==='replay'?'Local recording · no upload':`${mode==='serial'?'USB serial':'Local bridge'} · ${hasData?'last frame '+((performance.now()-lastReceived)/1000).toFixed(1)+' s ago':'awaiting frames'}`;
  $('empty-state').hidden=tracks.length>0;
  $('empty-message').textContent=!dataUsable?'Waiting for fresh sensor frames.':signalOnly?'Laptop RSSI measures signal strength, not position or presence.':frame.kind==='csi'?'Raw CSI is shown below. Estimated coordinates are required for 3D tracks.':mode==='demo'?'The simulated room is clear.':'No tracks reported in this frame.';
  document.body.classList.toggle('has-error',live&&stale);
  $('scenario').disabled=mode!=='demo';
  $('speed').disabled=live;
  $('pause-button').disabled=live;
  $('pause-button').setAttribute('aria-label',paused?'Resume playback':'Pause playback');
  $('pause-button').querySelector('use').setAttribute('href',paused?'#i-play':'#i-pause');
  $('replay-bar').hidden=mode!=='replay';
  if(mode==='replay'){
    const duration=replay.at(-1).timestamp-replay[0].timestamp;
    $('replay-position').value=duration?Math.round(replayElapsed/duration*1000):0;
    $('replay-time').textContent=`${formatTime(replayElapsed)} / ${formatTime(duration)}`;
  }
  if(!tracks.some(t=>t.id===selectedId))selectedId=tracks[0]?.id||null;
  scene.selected=selectedId;
  const selected=tracks.find(t=>t.id===selectedId);
  $('selected-name').replaceChildren(document.createTextNode(selected?.id||'No target selected'));
  const badge=document.createElement('span');badge.className='tracking-badge';badge.textContent=mode==='demo'?'SIMULATED':mode==='replay'?'RECORDED':'ESTIMATE';$('selected-name').append(badge);
  $('selection-indicator').textContent=selected?String(tracks.indexOf(selected)+1).padStart(2,'0'):'—';
  for(const axis of ['x','y','z'])$('selected-'+axis).textContent=selected?selected[axis].toFixed(2):'—';
  $('confidence-label').textContent=mode==='demo'?'Synthetic confidence':'Reported confidence';
  $('selected-confidence').textContent=selected?.confidence!=null?`${Math.round(selected.confidence*100)}%`:'—';
  $('confidence-bar').style.width=selected?.confidence!=null?`${selected.confidence*100}%`:'0%';
  $('table-count').textContent=tracks.length;
  const body=$('target-table');body.replaceChildren();
  for(const track of tracks){
    const row=document.createElement('tr'),name=document.createElement('td'),pos=document.createElement('td'),confidence=document.createElement('td');
    const button=document.createElement('button');button.className='target-select'+(track.id===selectedId?' selected':'');button.textContent=track.id;button.setAttribute('aria-label','Inspect '+track.id);button.addEventListener('click',()=>{selectedId=track.id;renderUI();});name.append(button);
    pos.textContent=`${track.x.toFixed(2)}, ${track.z.toFixed(2)}`;
    const bar=document.createElement('span'),inner=document.createElement('span');bar.className='confidence-mini';inner.style.width=`${(track.confidence??0)*100}%`;bar.append(inner);confidence.append(bar,document.createTextNode(track.confidence==null?'—':`${Math.round(track.confidence*100)}%`));row.append(name,pos,confidence);body.append(row);
  }
  $('table-empty').hidden=tracks.length>0;
}

function drawChart(){
  const canvas=$('signal-canvas'),rect=canvas.getBoundingClientRect(),dpr=Math.min(devicePixelRatio||1,2);
  const w=Math.round(rect.width*dpr),h=Math.round(rect.height*dpr);if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h;}
  const ctx=canvas.getContext('2d');if(!ctx||!w||!h)return;ctx.clearRect(0,0,w,h);
  ctx.strokeStyle='#26382d';ctx.lineWidth=dpr*.5;ctx.setLineDash([3*dpr,4*dpr]);
  for(let i=0;i<=2;i++){const y=(h-2)*i/2+1;ctx.beginPath();ctx.moveTo(0,y);ctx.lineTo(w,y);ctx.stroke();}ctx.setLineDash([]);
  const points=signalHistory;if(!points.length)return;
  const range=mode==='demo'||frame.kind==='rssi'?1:Math.max(1,...points)*1.15;
  ctx.beginPath();points.forEach((v,i)=>{const x=i/(points.length-1||1)*w,y=h-((v/range)*.83+.08)*h;i?ctx.lineTo(x,y):ctx.moveTo(x,y);});
  ctx.strokeStyle='#9bdfb4';ctx.lineWidth=dpr;ctx.stroke();ctx.lineTo(w,h);ctx.lineTo(0,h);ctx.closePath();const fill=ctx.createLinearGradient(0,0,0,h);fill.addColorStop(0,'#83d6a025');fill.addColorStop(1,'#83d6a002');ctx.fillStyle=fill;ctx.fill();
}

function stopRecording(download=true){
  if(!recording)return;recording=false;$('record-button').classList.remove('recording');$('record-text').textContent='Record';
  lastRecording=captured;captured=[];lastCapturedTimestamp=null;
  $('export-last').disabled=!lastRecording.length;
  $('recording-summary').textContent=lastRecording.length?`${lastRecording.length.toLocaleString()} frames · ${formatTime(lastRecording.at(-1).timestamp-lastRecording[0].timestamp)} · ${lastRecording[0].source==='simulation'?'Synthetic':'Hardware-reported'} data`:'No frames were captured. Connect a source and try again.';
  if(download&&lastRecording.length)exportRecording(lastRecording);
}
function exportRecording(frames){
  const content=JSON.stringify({format:'nutradar-recording',version:1,frames},null,0),blob=new Blob([content],{type:'application/json'});
  const url=URL.createObjectURL(blob),link=document.createElement('a');link.href=url;link.download=`nutradar-${new Date().toISOString().replace(/[:.]/g,'-')}.json`;link.click();setTimeout(()=>URL.revokeObjectURL(url),1000);toast(`Exported ${frames.length.toLocaleString()} frames to your device.`);
}
function capture(){
  if(!recording||frame.timestamp===lastCapturedTimestamp)return;
  if((mode==='serial'||mode==='bridge')&&(!lastReceived||stale))return;
  // Store only protocol fields; derived amplitudes are recomputed during import.
  const {amplitudes,variation,time,...packet}=frame;
  const serialized=JSON.stringify(packet),bytes=new TextEncoder().encode(serialized).length+1;
  if(captured.length>=MAX_FRAMES||capturedBytes+bytes>MAX_INPUT_BYTES-1024){stopRecording();toast('Recording limit reached. Your session has been exported.');return;}
  captured.push(JSON.parse(serialized));capturedBytes+=bytes;lastCapturedTimestamp=frame.timestamp;
}
async function disconnect(){
  ++transportEpoch;
  eventSource?.close();eventSource=null;
  const reader=serialReader,port=serialPort,task=serialTask;
  serialReader=null;serialPort=null;serialTask=null;
  if(reader){try{await reader.cancel();}catch{}try{await task;}catch{}}
  if(port){try{await port.close();}catch{}}
}
function clearStream(){lastReceived=0;receiveTimes=[];stale=false;signalHistory=[];frame={version:1,kind:'tracks',source:'hardware',timestamp:Date.now(),coordinateSystem:'room-meters-y-up',tracks:[],nodes:[]};}
function receive(input){
  const next=validateFrame(input);if(next.kind!==frame.kind)signalHistory=[];
  if(recording&&captured.length&&next.timestamp<captured.at(-1).timestamp)stopRecording();
  frame=next;lastReceived=performance.now();noteFrame(lastReceived);stale=false;
  const sample=signalValue(next);if(sample!==null){signalHistory.push(sample);if(signalHistory.length>80)signalHistory.shift();}else signalHistory=[];
  capture();
}
function rms(packet){return Math.sqrt(packet.amplitudes.reduce((sum,a)=>sum+a*a,0)/packet.amplitudes.length);}
function signalValue(packet){return packet.kind==='rssi'?Math.max(0,Math.min(1,(packet.rssiDbm+100)/80)):packet.kind==='csi'&&packet.amplitudes.length?rms(packet):null;}
function noteFrame(now=performance.now()){receiveTimes.push(now);receiveTimes=receiveTimes.filter(t=>now-t<1000);}
function rebuildReplayChart(){signalHistory=replay.slice(Math.max(0,replayIndex-79),replayIndex+1).filter(f=>f.kind===frame.kind).map(signalValue).filter(v=>v!==null);}
async function startDemo(){stopRecording(false);await disconnect();mode='demo';paused=false;demoTime=0;epoch=Date.now();receiveTimes=[];frame=demoFrame(0,$('scenario').value,epoch);signalHistory=Array.from({length:80},(_,i)=>syntheticAmplitude(i/10));$('source-error').textContent='';closeDialogs();renderUI();}
async function connectSerial(){
  if(!('serial' in navigator)){showError('Web Serial is available in supporting desktop browsers such as Chrome or Edge. Open this site there, or use the local bridge.');return;}
  let port;
  try{port=await navigator.serial.requestPort();}catch(error){if(error.name!=='NotFoundError')showError(error.message);return;}
  stopRecording(false);await disconnect();mode='serial';clearStream();paused=false;renderUI();
  const current=transportEpoch;
  try{
    await port.open({baudRate:115200});if(current!==transportEpoch){await port.close();return;}serialPort=port;serialReader=port.readable.getReader();const reader=serialReader;closeDialogs();toast('USB connected. Waiting for NutRadar JSON frames.');
    serialTask=(async()=>{
      const decoder=new TextDecoder();let buffer='',badLines=0;
      try{while(current===transportEpoch){const {value,done}=await reader.read();if(done)break;buffer+=decoder.decode(value,{stream:true});if(buffer.length>1048576)throw new Error('Serial line exceeds 1 MB. Expected newline-delimited NutRadar JSON.');const lines=buffer.split('\n');buffer=lines.pop();for(const line of lines){if(!line.trim())continue;try{receive(JSON.parse(line));badLines=0;}catch(error){if(++badLines===5)toast(`Sensor format: ${error.message}. See the hardware guide.`);}}}}
      catch(error){if(current===transportEpoch)toast('USB stream ended: '+error.message);}
      finally{try{reader.releaseLock();}catch{}if(current===transportEpoch){serialReader=null;serialTask=null;try{await port.close();}catch{}serialPort=null;stale=true;stopRecording(false);renderUI();}}
    })();
  }catch(error){try{await port.close();}catch{}showError('Could not open USB sensor: '+error.message);stale=true;renderUI();}
}
async function connectBridge(){
  if(!['localhost','127.0.0.1','[::1]'].includes(location.hostname)){showError('Start the free local bridge, then open http://127.0.0.1:8765 and connect there. GitHub Pages cannot run the bridge.');return;}
  stopRecording(false);await disconnect();mode='bridge';clearStream();paused=false;renderUI();
  const current=transportEpoch;eventSource=new EventSource('/events');
  eventSource.onmessage=event=>{if(current!==transportEpoch)return;try{receive(JSON.parse(event.data));}catch(error){toast('Invalid bridge frame: '+error.message);}};
  eventSource.onopen=()=>{closeDialogs();toast('Local bridge connected. Waiting for sensor frames.');};
  eventSource.onerror=()=>{if(current!==transportEpoch)return;stale=true;renderUI();toast('Bridge unavailable. Run python3 tools/bridge.py and open its local URL.');};
}
async function importRecording(file){
  if(!file)return;
  try{
    if(file.size>MAX_INPUT_BYTES)throw new Error('Recording exceeds the 20 MB limit.');
    const frames=parseRecording(await file.text());
    stopRecording(false);await disconnect();mode='replay';replay=frames;replayElapsed=0;replayIndex=0;frame=replay[0];paused=false;receiveTimes=[];signalHistory=[];closeDialogs();renderUI();toast(`Loaded ${frames.length.toLocaleString()} frames. Playback stays on your device.`);
  }catch(error){toast('Could not load recording: '+error.message);}
  finally{$('file-input').value='';}
}

$('connect-button').onclick=()=>{$('source-error').textContent='';openDialog('source-dialog');};
$('about-button').onclick=()=>openDialog('about-dialog');
$('nav-overview').onclick=()=>{closeDialogs();window.scrollTo({top:0,behavior:'smooth'});};
$('nav-recordings').onclick=()=>openDialog('recordings-dialog');
$('nav-hardware').onclick=()=>openDialog('source-dialog');
$('demo-return').onclick=startDemo;
$('serial-connect').onclick=connectSerial;
$('bridge-connect').onclick=connectBridge;
$('laptop-setup').onclick=()=>{$('laptop-instructions').hidden=!$('laptop-instructions').hidden;};
for(const id of ['import-button','source-import'])$(id).onclick=()=>$('file-input').click();
$('file-input').onchange=event=>importRecording(event.target.files[0]);
$('export-last').onclick=()=>lastRecording.length&&exportRecording(lastRecording);
document.querySelectorAll('.close-dialog').forEach(button=>button.onclick=()=>button.closest('dialog').close());
document.querySelectorAll('dialog').forEach(dialog=>dialog.addEventListener('click',event=>{if(event.target===dialog){const r=dialog.getBoundingClientRect();if(event.clientX<r.left||event.clientX>r.right||event.clientY<r.top||event.clientY>r.bottom)dialog.close();}}));
$('scenario').onchange=()=>{stopRecording(false);demoTime=0;epoch=Date.now();frame=demoFrame(0,$('scenario').value,epoch);$('scenario-help').textContent={occupancy:'Three moving targets in a virtual room.',single:'One simulated target moving through the room.',empty:'No targets. The synthetic mesh remains active.'}[$('scenario').value];renderUI();};
$('speed').oninput=()=>{speed=Number($('speed').value);$('speed-value').textContent=speed+'×';renderUI();};
document.querySelectorAll('[data-view]').forEach(button=>button.onclick=()=>{scene.setView(button.dataset.view);document.querySelectorAll('[data-view]').forEach(b=>{b.classList.toggle('selected',b===button);b.setAttribute('aria-pressed',String(b===button));});});
$('reset-view').onclick=()=>{scene.setView('perspective');document.querySelector('[data-view="perspective"]').click();};
for(const layer of ['trails','sweep','heatmap','grid'])$('layer-'+layer).onchange=()=>scene.setOptions({[layer]:$('layer-'+layer).checked});
$('pause-button').onclick=()=>{if(mode==='replay'&&replayElapsed>=replay.at(-1).timestamp-replay[0].timestamp){replayElapsed=0;replayIndex=0;frame=replay[0];}paused=!paused;renderUI();};
$('record-button').onclick=()=>{if(recording){stopRecording();}else{recording=true;captured=[];capturedBytes=128;lastCapturedTimestamp=null;$('record-button').classList.add('recording');$('record-text').textContent='Stop & save';capture();toast('Recording started. Stop to download the session.');}renderUI();};
$('replay-position').oninput=()=>{if(mode!=='replay')return;stopRecording(false);replayElapsed=Number($('replay-position').value)/1000*(replay.at(-1).timestamp-replay[0].timestamp);replayIndex=0;while(replayIndex<replay.length-1&&replay[replayIndex+1].timestamp-replay[0].timestamp<=replayElapsed)replayIndex++;frame=replay[replayIndex];rebuildReplayChart();renderUI();};
window.addEventListener('pagehide',()=>{eventSource?.close();serialReader?.cancel().catch(()=>{});});

function animate(now){
  requestAnimationFrame(animate);const dt=lastRender?Math.min((now-lastRender)/1000,.1):0;lastRender=now;
  if(mode==='demo'&&!paused){demoTime+=dt*speed;if(now-lastDemoFrame>=1000/30){frame=demoFrame(demoTime,$('scenario').value,epoch);lastDemoFrame=now;noteFrame(now);capture();}}
  if(mode==='replay'&&!paused){
    replayElapsed=Math.min(replayElapsed+dt*1000*speed,replay.at(-1).timestamp-replay[0].timestamp);
    let changed=false;while(replayIndex<replay.length-1&&replay[replayIndex+1].timestamp-replay[0].timestamp<=replayElapsed){replayIndex++;changed=true;}
    frame=replay[replayIndex];if(changed){noteFrame(now);const sample=signalValue(frame);if(sample!==null){signalHistory.push(sample);if(signalHistory.length>80)signalHistory.shift();}else signalHistory=[];capture();}
    if(replayIndex===replay.length-1)paused=true;
  }
  const live=mode==='serial'||mode==='bridge';if(live&&lastReceived&&now-lastReceived>3000){stale=true;signalHistory=[];}
  const displayed=live&&(!lastReceived||stale)?{...frame,tracks:[],nodes:[]}:frame;
  scene.update({...displayed,time:frame.timestamp/1000},paused&&!live?0:dt);
  if(now-lastUI>100){
    if(mode==='demo'&&!paused){signalHistory.push(syntheticAmplitude(demoTime));if(signalHistory.length>80)signalHistory.shift();}
    renderUI();drawChart();lastUI=now;$('clock').textContent=new Date().toLocaleTimeString('en-GB',{hour12:false});
  }
}
renderUI();requestAnimationFrame(animate);
