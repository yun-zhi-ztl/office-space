
var DB={rooms:[],reservations:[],stalls:[],tools:[],requests:[],repairs:[],visitors:[],visitorTotal:0,users:[],leaderboard:[],notices:[],tasks:[],vehicles:[],vehRes:[],parcels:[],parcelStats:{},lockers:[],lockRes:[],parking:[],parkRes:[]};
var STATE={view:0,count:10,paused:false,ms:12000};
var VIEWS=['rooms','overview','stalls','notices','visitors','tasks','vehicles','parcels','lockers','parking'];
var ws=null;
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function pad(n){return (n<10?'0':'')+n;}
function tt(ms){ var d=new Date(ms); return pad(d.getHours())+':'+pad(d.getMinutes()); }
function qs(s){return document.querySelector(s);}
function connect(){
  var id=new URLSearchParams(location.search).get('space')||'';
  ws=new WebSocket((location.protocol==='https:'?'wss://':'ws://')+location.host+'/ws');
  ws.onopen=function(){ if(id) ws.send(JSON.stringify({type:'join',spaceId:id})); };
  ws.onmessage=function(ev){ try{var m=JSON.parse(ev.data);
    if(m.type==='joined'){ document.title='OfficeSpace · '+m.space.name+' 大屏'; document.getElementById('spaceName').textContent=m.space.name; }
    if(m.type==='rooms'){DB.rooms=m.rooms;DB.reservations=m.reservations;}
    if(m.type==='tools')DB.tools=m.tools;
    if(m.type==='stalls')DB.stalls=m.stalls;
    if(m.type==='materials')DB.requests=m.requests;
    if(m.type==='repairs')DB.repairs=m.repairs;
    if(m.type==='visitors'){DB.visitors=m.visitors||[];DB.visitorTotal=m.total||0;}
    if(m.type==='users')DB.users=m.users;
    if(m.type==='leaderboard')DB.leaderboard=m.rankings||[];
    if(m.type==='notices')DB.notices=m.notices||[];
    if(m.type==='tasks')DB.tasks=m.tasks||[];
    if(m.type==='vehicles'){DB.vehicles=m.vehicles||[];DB.vehRes=m.reservations||[];}
    if(m.type==='parcels'){DB.parcels=m.parcels||[];DB.parcelStats=m.stats||{};}
    if(m.type==='lockers'){DB.lockers=m.lockers||[];DB.lockRes=m.reservations||[];}
    if(m.type==='parking'){DB.parking=m.spots||[];DB.parkRes=m.reservations||[];}
    renderAll();
  }catch(e){}};
  ws.onclose=function(){ setTimeout(connect,1500); };
}
/* ---- 轮播 ---- */
function show(i){
  STATE.view=(i+STATE.count)%STATE.count;
  VIEWS.forEach(function(k){
    var el=document.getElementById('view-'+k);
    if(el){ el.classList.toggle('show', k===VIEWS[STATE.view]); }
  });
  var dots=document.querySelectorAll('#dots .dot');
  [].forEach.call(dots,function(d,k){ d.classList.toggle('on', k===STATE.view); });
}
function togglePlay(){ STATE.paused=!STATE.paused; var b=document.getElementById('pauseBtn'); b.textContent=STATE.paused?'▶ 播放':'⏸ 暂停'; }
function toggleFullscreen(){
  var el=document.documentElement;
  if(!document.fullscreenElement){ if(el.requestFullscreen) el.requestFullscreen(); }
  else { if(document.exitFullscreen) document.exitFullscreen(); }
}
/* ---- 渲染 ---- */
function buildRooms(){
  var now=Date.now();
  var html=DB.rooms.length?DB.rooms.map(function(r){
    var rel=DB.reservations.filter(function(x){return x.roomId===r.id;});
    var cur=rel.find(function(x){return x.status==='active'||(x.status==='pending'&&x.startAt<=now&&x.endAt>now);});
    var nxt=rel.filter(function(x){return x.status==='pending'&&x.startAt>now;}).sort(function(a,b){return a.startAt-b.startAt;})[0];
    return '<div class="roomrow"><span>'+esc(r.name)+' ('+r.capacity+'人)</span><span>'
      +(cur?'<span class="now">现在：'+esc(cur.title)+' · '+esc(cur.ownerName)+'</span>':(nxt?'<span class="next">接下来 '+tt(nxt.startAt)+' '+esc(nxt.title)+'</span>':'<span class="next">空闲</span>'))+'</span></div>';
  }).join(''):'<div class="empty">还没有会议室</div>';
  qs('#rooms').innerHTML=html;
}
function buildOverview(){
  var occupied=DB.stalls.filter(function(s){return s.status==='occupied';}).length;
  var overdue=DB.tools.reduce(function(a,t){return a+(t.activeBorrows||[]).filter(function(b){return b.overdue;}).length;},0);
  var pendReq=DB.requests.filter(function(r){return r.status==='pending';}).length;
  var openRep=DB.repairs.filter(function(r){return r.status==='reported'||r.status==='in_progress';}).length;
  var pendVisitors=DB.visitors.filter(function(v){return v.status==='pending'||v.status==='arrived';}).length;
  qs('#chips').innerHTML=[
    ['🚻 坑位占用', occupied+'/'+DB.stalls.length],['📦 待处理申领', pendReq],['🛠️ 未办结报修', openRep],
    ['🚶 待接待访客', pendVisitors],['⏰ 逾期借用', overdue],['🟢 在线', DB.users.length],['🏢 会议室', DB.rooms.length],
    ['🚗 行驶车辆', DB.vehRes.filter(function(r){return r.status==='checked_in';}).length],['📦 待取包裹', DB.parcels.filter(function(p){return p.status==='incoming';}).length],
    ['🗄️ 占用储物柜', DB.lockRes.filter(function(r){return r.status==='reserved'||r.status==='checked_in';}).length],['🅿️ 停车占用', DB.parkRes.filter(function(r){return r.status==='checked_in';}).length]
  ].map(function(c){return '<div class="chip"><div class="n">'+c[1]+'</div><div class="t">'+c[0]+'</div></div>';}).join('');
  var mvp=DB.leaderboard.find(function(r){return r.mvp;});
  qs('#mvp').innerHTML = mvp ? ('👑 <b>'+esc(mvp.username)+'</b> 本周活跃 '+mvp.weekly+' 次') : '--';
}
function buildStalls(){
  qs('#stallgrid').innerHTML = (DB.stalls.length?DB.stalls.map(function(s){
    var cls = s.status==='free'?'ok':(s.status==='occupied'?'bad':'wait');
    var label = s.status==='free'?'空闲':(s.status==='occupied'?(s.currentBy?'占用': '占用'):'预约');
    return '<div class="ss"><div class="nm">'+esc(s.name)+(s.tier&&s.tier.name!=='新坑'?' '+s.tier.icon:'')+'</div><div class="st '+cls+'">'+label+(s.currentBy?' · '+esc(s.currentBy.display):'')+'</div></div>';
  }).join(''):'<div class="empty">暂无坑位</div>');
  qs('#status').innerHTML = DB.users.map(function(u){return '<span>'+esc(u.avatar||'')+' '+esc(u.display||u.username)+(u.status&&u.status.emoji?' '+esc(u.status.emoji):'')+' '+esc((u.status&&u.status.label)||'在岗')+'</span>';}).join('')||'<span>暂无人在线</span>';
}
function buildNotices(){ qs('#notices').innerHTML = DB.notices.slice(0,8).map(function(n){return '<div class="n"><b>'+esc(n.from)+'</b> '+esc(n.text)+'</div>';}).join('')||'<div class="empty">暂无公告</div>'; }
function buildVisitors(){
  var list=DB.visitors.filter(function(v){return v.status==='pending'||v.status==='arrived';});
  qs('#visitors').innerHTML = (list.length?list.map(function(v){
    return '<div class="roomrow"><span>'+esc(v.hostName)+' 接待 <b>'+esc(v.visitorName)+'</b> <span class="next">'+esc(v.purpose||'')+'</span></span><span class="'+(v.status==='pending'?'wait':'ok')+'">'+(v.status==='pending'?'待到访':'已到访')+'</span></div>';
  }).join(''):'<div class="empty">暂无待接待访客</div>');
}
function buildTasks(){
  var pri={high:'bad',normal:'',low:'ok'}, st={pending:'待办',in_progress:'进行中',done:'已完成',cancelled:'已取消'};
  var open=DB.tasks.filter(function(t){return t.status==='pending'||t.status==='in_progress';});
  qs('#tasks').innerHTML = (open.length?open.map(function(t){
    return '<div class="roomrow"><span>'+esc(t.title)+' <span class="badge '+pri[t.priority||'normal']+'">'+(({high:'高',normal:'中',low:'低'}[t.priority||'normal']))+'</span> '+(t.assigneeName?'→ '+esc(t.assigneeName):'开放认领')+'</span><span class="'+(t.status==='in_progress'?'now':'next')+'">'+st[t.status]+'</span></div>';
  }).join(''):'<div class="empty">暂无进行中 / 待办任务</div>');
}
function buildVehicles(){
  var inUse=DB.vehRes.filter(function(r){return r.status==='checked_in';});
  var upcoming=DB.vehRes.filter(function(r){return r.status==='reserved';}).sort(function(a,b){return a.startAt-b.startAt;}).slice(0,8);
  var html=inUse.length?inUse.map(function(r){return '<div class="roomrow"><span>🚗 '+esc(r.vehicleName)+' <span class="now">· '+esc(r.name)+'</span></span><span class="now">行驶中</span></div>';}).join(''):'<div class="empty">无车辆在行驶</div>';
  html+=upcoming.length?'<h3 style="margin:14px 0 6px;color:#94a3b8">待出车</h3>'+upcoming.map(function(r){return '<div class="roomrow"><span>'+esc(r.vehicleName)+' · '+esc(r.purpose||'借用')+'</span><span class="next">'+tt(r.startAt)+' '+esc(r.name)+'</span></div>';}).join(''):'';
  qs('#vehicles').innerHTML=html;
}
function buildParcels(){
  var list=DB.parcels.filter(function(p){return p.status==='incoming';});
  qs('#parcels').innerHTML=list.length?list.slice(0,12).map(function(p){return '<div class="roomrow"><span>📦 '+esc(p.recipientName||p.recipientAccount)+' <span class="next">· '+esc(p.courier||'')+(p.trackingNumber?' · '+esc(p.trackingNumber):'')+'</span></span><span class="wait">待取</span></div>';}).join(''):'<div class="empty">暂无待取包裹</div>';
}
function buildLockers(){
  var act=DB.lockRes.filter(function(r){return r.status==='reserved'||r.status==='checked_in';});
  var free=DB.lockers.reduce(function(a,l){return a+(l.available||0);},0);
  var grid='<div class="chips" style="grid-template-columns:repeat(3,1fr);flex:none"><div class="chip"><div class="n">'+DB.lockers.length+'</div><div class="t">柜位</div></div><div class="chip"><div class="n">'+free+'</div><div class="t">空闲格</div></div><div class="chip"><div class="n">'+act.length+'</div><div class="t">占用</div></div></div>';
  qs('#lockers').innerHTML=grid+(DB.lockers.length?DB.lockers.map(function(l){return '<div class="roomrow"><span>🗄️ '+esc(l.name)+'</span><span class="'+(l.available>0?'next':'wait')+'">可用 '+l.available+'/'+l.total+'</span></div>';}).join(''):'<div class="empty">暂无储物柜</div>');
}
function buildParking(){
  var inUse=DB.parkRes.filter(function(r){return r.status==='checked_in';});
  var free=DB.parking.reduce(function(a,s){return a+(s.available||0);},0);
  var grid='<div class="chips" style="grid-template-columns:repeat(3,1fr);flex:none"><div class="chip"><div class="n">'+DB.parking.length+'</div><div class="t">车位</div></div><div class="chip"><div class="n">'+free+'</div><div class="t">空闲</div></div><div class="chip"><div class="n">'+inUse.length+'</div><div class="t">占用</div></div></div>';
  qs('#parking').innerHTML=grid+(DB.parking.length?DB.parking.map(function(s){return '<div class="roomrow"><span>🅿️ '+esc(s.name)+'</span><span class="'+(s.available>0?'next':'wait')+'">'+s.available+'/'+s.total+' 空闲</span></div>';}).join(''):'<div class="empty">暂无车位</div>');
}
function renderAll(){ buildRooms(); buildOverview(); buildStalls(); buildNotices(); buildVisitors(); buildTasks(); buildVehicles(); buildParcels(); buildLockers(); buildParking(); }
/* ---- 启动 ---- */
VIEWS.forEach(function(k,idx){ var d=document.createElement('div'); d.className='dot'; d.onclick=function(){ show(idx); }; document.getElementById('dots').appendChild(d); });
show(0);
setInterval(function(){
  var d=new Date(); document.getElementById('clock').textContent=pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
  renderAll();
  if(!STATE.paused) show(STATE.view+1);
}, STATE.ms);
document.addEventListener('fullscreenchange', function(){ var b=document.getElementById('fsBtn'); if(b) b.textContent=document.fullscreenElement?'✕ 退出全屏':'⛶ 全屏'; });
connect();
