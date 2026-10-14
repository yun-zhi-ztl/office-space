
var DB={rooms:[],reservations:[],stalls:[],tools:[],requests:[],repairs:[],users:[],leaderboard:[],notices:[]};
var STATE={view:0,count:4,paused:false,ms:12000};
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
    if(m.type==='users')DB.users=m.users;
    if(m.type==='leaderboard')DB.leaderboard=m.rankings||[];
    if(m.type==='notices')DB.notices=m.notices||[];
    renderAll();
  }catch(e){}};
  ws.onclose=function(){ setTimeout(connect,1500); };
}
/* ---- 轮播 ---- */
function show(i){
  STATE.view=(i+STATE.count)%STATE.count;
  [0,1,2,3].forEach(function(k){
    var el=document.getElementById('view-'+['rooms','overview','stalls','notices'][k]);
    if(el){ el.classList.toggle('show', k===STATE.view); }
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
  qs('#chips').innerHTML=[
    ['🚻 坑位占用', occupied+'/'+DB.stalls.length],['📦 待处理申领', pendReq],['🛠️ 未办结报修', openRep],
    ['⏰ 逾期借用', overdue],['🟢 在线', DB.users.length],['🏢 会议室', DB.rooms.length]
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
function renderAll(){ buildRooms(); buildOverview(); buildStalls(); buildNotices(); }
/* ---- 启动 ---- */
[0,1,2,3].forEach(function(k){ var d=document.createElement('div'); d.className='dot'; d.onclick=function(){ show(k); }; document.getElementById('dots').appendChild(d); });
show(0);
setInterval(function(){
  var d=new Date(); document.getElementById('clock').textContent=pad(d.getHours())+':'+pad(d.getMinutes())+':'+pad(d.getSeconds());
  renderAll();
  if(!STATE.paused) show(STATE.view+1);
}, STATE.ms);
document.addEventListener('fullscreenchange', function(){ var b=document.getElementById('fsBtn'); if(b) b.textContent=document.fullscreenElement?'✕ 退出全屏':'⛶ 全屏'; });
connect();
