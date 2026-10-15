
/* ============ 工具 ============ */
function $(s){return document.querySelector(s);}
function esc(s){return String(s==null?'':s).replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));}
function toast(msg, kind){ const w=$('#toasts'),t=document.createElement('div'); t.className='toast '+(kind||''); t.textContent=msg; w.appendChild(t); setTimeout(()=>t.remove(), 3200); }
function pad(n){return (n<10?'0':'')+n;}
function fmtTime(ms){ const d=new Date(ms); return `${d.getMonth()+1}/${d.getDate()} ${pad(d.getHours())}:${pad(d.getMinutes())}`; }
function fmtCountdown(ms){ if(ms<=0)return '已到期'; const s=Math.floor(ms/1000); return `${Math.floor(s/60)}:${pad(s%60)}`; }
function http(method,path,body){ return fetch(path,{method,headers:body?{'Content-Type':'application/json'}:{},body:body?JSON.stringify(body):undefined}).then(r=>r.json().catch(()=>({}))); }

/* 弹窗 */
function openModal(html){ $('#modals').innerHTML = `<div class="modal-mask show" onclick="if(event.target===this)this.classList.remove('show')"><div class="modal">${html}</div></div>`; }
function closeModal(){ const m=$('#modals .modal-mask'); if(m) m.classList.remove('show'); }

/* ============ 全局状态 ============ */
const S = {
  token: localStorage.getItem('os_token')||'',
  lastSpace: localStorage.getItem('os_space')||'',
  ws: null, me:null, space:null, module:'rooms',
  pendingLogin:null,
  DB:{ rooms:[], reservations:[], waitlist:[], waitlistTotal:0, tools:[], requests:[], repairs:[], visitors:[], stalls:[], users:[], leaderboard:[], borrows:[] },
  visitorTotal:0, visitorOffset:0,
  borrowTotal:0, borrowOffset:0,
  roomStats:null,
  lastRoomBook:null,
  admin:false, sockOpen:false,
};
const MODULES = [ ['rooms','会议室','🏢'],['tools','工具借用','🔧'],['materials','物资申领','📦'],['repairs','报修','🛠️'],['visitors','访客登记','🚶'],['stalls','坑位看板','🚻'],['ach','成就墙','🏅'],['rem','我的待办','🔔'],['an','空间趋势','📈'],['dash','概览','📊'] ];

/* ============ WebSocket ============ */
function wsSend(msg){ if(S.ws && S.ws.readyState===1) S.ws.send(JSON.stringify(msg)); else toast('未连接服务器','error'); }
function connect(){
  const proto = location.protocol==='https:'?'wss://':'ws://';
  S.ws = new WebSocket(proto+location.host+'/ws');
  S.ws.onopen = ()=>{ S.sockOpen=true; const sid = S.space ? S.space.id : (S.pendingLogin ? S.lastSpace : null); if(sid) wsSend({type:'join',spaceId:sid}); };
  S.ws.onmessage = (ev)=>{ let m; try{m=JSON.parse(ev.data);}catch{return;} dispatch(m); };
  S.ws.onclose = ()=>{ S.sockOpen=false; if(S.me) setTimeout(connect, 1500); };
  S.ws.onerror = ()=>{};
}
function dispatch(m){
  switch(m.type){
    case 'error':
      if(m.code==='roomConflict'){ toast('✘ '+m.message,'warn'); if(S.lastRoomBook) openWaitlistModal(S.lastRoomBook); }
      else { toast('✘ '+m.message,'error'); if(!S.me) renderGate(); }
      break;
    case 'joined': S.space=m.space; renderSidebar(); if(S.pendingLogin){ const p=S.pendingLogin; S.pendingLogin=null; wsSend({type:'login',token:p.token!==undefined?p.token:undefined,account:p.account,password:p.password}); } break;
    case 'loginSuccess':
      S.me={account:m.account,nickname:m.nickname,avatar:m.avatar,role:m.role,token:m.token};
      if(m.stats) S.me.stats=m.stats;
      if(m.achievements) S.me.achievements=m.achievements;
      S.admin = m.role==='admin'; S.token=m.token;
      localStorage.setItem('os_token',m.token); localStorage.setItem('os_space',S.space?S.space.id:S.lastSpace);
      $('#gate').style.display='none'; $('#app').style.display='flex'; renderAll(); break;
    case 'rooms': S.DB.rooms=m.rooms; S.DB.reservations=m.reservations; S.DB.revTotal=m.reservationTotal||0; S.DB.revOffset=S.DB.reservations.length; S.DB.waitlist=m.waitlist||[]; S.DB.waitlistTotal=m.waitlistTotal||0; break;
    case 'tools': S.DB.tools=m.tools; break;
    case 'materials': S.DB.requests=m.requests; S.DB.matTotal=m.total||0; S.DB.matOffset=S.DB.requests.length; break;
    case 'repairs': S.DB.repairs=m.repairs; S.DB.repTotal=m.total||0; S.DB.repOffset=S.DB.repairs.length; break;
    case 'visitors': S.DB.visitors=m.visitors||[]; S.visitorTotal=m.total||0; S.visitorOffset=S.DB.visitors.length; break;
    case 'page': handlePage(m); break;
    case 'stalls': S.DB.stalls=m.stalls; break;
    case 'roomStats': S.roomStats=m.stats; render(); break;
    case 'users': S.DB.users=m.users; break;
    case 'leaderboard': S.DB.leaderboard=m.rankings||[]; break;
    case 'achievements': S.DB.achievements=m.achievements||[]; break;
    case 'myReminders': S.DB.reminders=m.reminders||{}; break;
    case 'spaceTrend': S.DB.trend=m.trend||[]; break;
    case 'notices': S.DB.notices=m.notices||[]; break;
    case 'digest': S.digest=m.digest; break;
    case 'suggestRooms': S.suggestions=m.suggestions||[]; renderSugg(); break;
    case 'statusSet': toast('✔ 状态已更新','success'); break;
    case 'remindSent': toast('✔ 已提醒 '+(m.count||0)+' 人','success'); break;
    case 'remindOverdueSent': toast('✔ 已批量提醒 '+(m.count||0)+' 位逾期借用人','success'); render(); break;
    case 'borrowReminder': toast('🔔 '+(m.from||'有人')+'提醒你归还设备',"urge"); break;
    case 'overdueReminder': toast('⏰ 你借的设备已逾期，请尽快归还','urge'); break;
    case 'borrowDueSoon': toast('🔔 你借的设备即将到期，请按时归还','warn'); render(); break;
    case 'roomReminder': { const rm=(S.DB.rooms||[]).find(r=>r.id===m.roomId); toast('🔔 '+(rm?rm.name:'会议室')+' 即将开始：'+fmtTime(m.startAt),'success'); break; }
    case 'materialAssigned': toast('📌 物资申领已指派给你：'+(m.name||''),'info'); render(); break;
    case 'materialFulfilled': toast('✅ 物资申领已满足：'+(m.name||''),'success'); render(); break;
    case 'repairAssigned': toast('📌 报修已指派给你：'+(m.category||'')+' · '+(m.location||''),'info'); render(); break;
    case 'repairInProgress': toast('🔧 报修处理中：'+(m.category||'')+' · '+(m.location||''),'info'); render(); break;
    case 'repairResolved': toast('✅ 报修已解决：'+(m.category||'')+' · '+(m.location||''),'success'); render(); break;
    case 'stats': if(S.me && m.stats){ S.me.stats = m.stats; if(m.achievements) S.me.achievements = m.achievements; render(); } break;
    case 'urgeNotification': toast('📣 有人催促你了（'+m.count+' 人）','urge'); break;
    case 'reservation': toast('✔ 预约成功','success'); break;
    case 'cancelSuccess': toast('✔ 已取消','success'); break;
    case 'roomWaitlistPromoted': toast('🎉 候补已晋升：预约已自动创建（'+fmtTime(m.startAt)+'）','success'); render(); break;
    case 'visitorCreated': toast('✔ 访客已登记，签到码：'+m.code,'success'); render(); break;
    case 'visitorCheckinNotification': toast('🔔 '+m.visitorName+' 已凭签到码到访','success'); render(); break;
    case 'visitorReminder': toast('🔔 '+m.visitorName+' 预计即将到访，请留意','warn'); render(); break;
    case 'visitorArrived': toast('🔔 '+m.visitorName+' 已到访','success'); render(); break;
    case 'visitorLeft': toast('🔔 '+m.visitorName+' 已离开','info'); render(); break;
    case 'visitorCheckedIn': toast('✔ '+m.visitorName+' 核销签到成功','success'); render(); break;
    case 'profileUpdated': if(S.me){ S.me.nickname=m.nickname; S.me.avatar=m.avatar; } toast('✔ 个人资料已更新','success'); render(); break;
    case 'passwordChanged': toast('✔ 密码已修改','success'); break;
    case 'spaceRenamed': if(S.space) S.space.name=m.name; renderSidebar(); render(); break;
    case 'spacePaused': if(S.space){ S.space.paused=!!m.paused; S.space.pausedReason=m.reason||''; } render(); break;
    case 'noticeRemoved': toast('公告已删除','success'); break;
    case 'emergencyToggled': if(S.me) S.me.emergencyMode=!!m.enabled; toast(m.enabled?'🆘 已开启紧急模式':'✅ 已退出紧急模式'); render(); break;
    case 'autoRelease': case 'reservationExpired': toast('⏰ 坑位已超时释放','warn'); break;
    default: break;
  }
  if(['rooms','tools','materials','repairs','visitors','stalls','roomStats','users','leaderboard','achievements','myReminders','spaceTrend','notices','digest'].includes(m.type)) render();
}
/* 渲染入口：只重绘当前模块 */
function render(){ if(!S.me) return; renderPauseBanner(); renderSidebar(); if(S.module==='dash') renderDash(); else if(S.module==='rooms') renderRooms(); else if(S.module==='tools') renderTools(); else if(S.module==='materials') renderMaterials(); else if(S.module==='repairs') renderRepairs(); else if(S.module==='visitors') renderVisitors(); else if(S.module==='stalls') renderStalls(); else if(S.module==='ach') renderAchievements(); else if(S.module==='rem') renderReminders(); else if(S.module==='an') renderTrend(); }
function renderPauseBanner(){
  const b=$('#pause-banner'); if(!b) return;
  if(S.space && S.space.paused){ b.style.display='block'; b.innerHTML='🔒 空间已暂停：'+(S.space.pausedReason?esc(S.space.pausedReason)+' · ':'')+'暂停预约 / 借用 / 申领 / 报修 / 访客登记'; }
  else { b.style.display='none'; }
}
function renderAll(){ render(); }
function switchModule(mod){ S.module=mod; const nav=$('#sidebar .nav button'); (nav?[...nav]:[]).forEach(b=>b.classList.toggle('active', b.dataset.m==mod)); render(); if(mod==='ach') wsSend({type:'getAchievements'}); if(mod==='rem') wsSend({type:'getMyReminders'}); if(mod==='an') wsSend({type:'getSpaceTrend',days:14}); }

/* 分页：广播已按最近 PAGE 下发，前端按 offset 加载更多 */
const PAGE = 30;
function handlePage(m){
  if(m.module==='materials'){ S.DB.requests=(S.DB.requests||[]).concat(m.items); S.DB.matOffset=m.offset+m.items.length; }
  else if(m.module==='repairs'){ S.DB.repairs=(S.DB.repairs||[]).concat(m.items); S.DB.repOffset=m.offset+m.items.length; }
  else if(m.module==='rooms'){ S.DB.reservations=(S.DB.reservations||[]).concat(m.items); S.DB.revOffset=m.offset+m.items.length; }
  else if(m.module==='visitors'){ S.DB.visitors=(S.DB.visitors||[]).concat(m.items); S.visitorOffset=m.offset+m.items.length; }
  else if(m.module==='borrows'){ S.DB.borrows=(S.DB.borrows||[]).concat(m.items); S.borrowOffset=m.offset+m.items.length; }
  render();
}
function loadMore(module){ wsSend({type:'fetchPage', module, offset: module==='materials'?S.DB.matOffset:module==='repairs'?S.DB.repOffset:module==='visitors'?S.visitorOffset:S.DB.revOffset, limit:PAGE}); }
/* ============ CSV 导出 ============ */
function csvCell(v){ let s=String(v==null?'':v); if(/[",\n\r]/.test(s)) s='"'+s.replace(/"/g,'""')+'"'; return s; }
function rowsToCsv(columns, rows){
  const head=columns.map(c=>csvCell(c.label)).join(',');
  const body=rows.map(r=>columns.map(c=>csvCell(c.fmt?c.fmt(r[c.key]):r[c.key])).join(',')).join('\r\n');
  return head+'\r\n'+body;
}
const CSV_FMT = { time: (v)=>v?fmtTime(v):'' };
const MAT_COLS=[{key:'requesterName',label:'申请人'},{key:'name',label:'物资'},{key:'qty',label:'数量'},{key:'unit',label:'单位'},{key:'reason',label:'说明'},{key:'status',label:'状态'},{key:'createdAt',label:'时间',fmt:CSV_FMT.time}];
const REP_COLS=[{key:'category',label:'类别'},{key:'priority',label:'优先级'},{key:'location',label:'位置'},{key:'description',label:'描述'},{key:'reporterName',label:'上报人'},{key:'status',label:'状态'},{key:'createdAt',label:'时间',fmt:CSV_FMT.time}];
const VIS_COLS=[{key:'hostName',label:'接待人'},{key:'visitorName',label:'访客'},{key:'purpose',label:'事由'},{key:'contact',label:'联系方式'},{key:'status',label:'状态'},{key:'expectedAt',label:'预计到访',fmt:CSV_FMT.time},{key:'createdAt',label:'登记时间',fmt:CSV_FMT.time}];
const ROOM_COLS=[{key:'title',label:'主题'},{key:'ownerName',label:'预约人'},{key:'startAt',label:'开始',fmt:CSV_FMT.time},{key:'endAt',label:'结束',fmt:CSV_FMT.time},{key:'status',label:'状态'}];
const BW_COLS=[{key:'toolName',label:'设备'},{key:'toolCategory',label:'类别'},{key:'borrowerName',label:'借用人'},{key:'qty',label:'数量'},{key:'borrowedAt',label:'借出',fmt:CSV_FMT.time},{key:'dueAt',label:'应还',fmt:CSV_FMT.time},{key:'returnedAt',label:'归还',fmt:CSV_FMT.time},{key:'status',label:'状态'}];
function downloadCsv(filename, csv){
  const blob=new Blob(['\ufeff'+csv], {type:'text/csv;charset=utf-8;'});
  const url=URL.createObjectURL(blob);
  const a=document.createElement('a'); a.href=url; a.download=filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url), 1000);
}
function nextPage(module, offset){
  return new Promise((resolve)=>{
    const handler=(ev)=>{ try{const m=JSON.parse(ev.data); if(m.type==='page'&&m.module===module){ S.ws.removeEventListener('message',handler); resolve(m); } }catch{} };
    S.ws.addEventListener('message', handler);
    wsSend({type:'fetchPage', module, offset, limit:PAGE});
  });
}
async function exportModuleCsv(module, columns){
  if(!S.ws || S.ws.readyState!==1){ toast('未连接服务器','error'); return; }
  while(true){
    const offset = module==='rooms'?S.DB.revOffset:module==='materials'?S.DB.matOffset:module==='repairs'?S.DB.repOffset:module==='borrows'?S.borrowOffset:S.visitorOffset;
    const total = module==='rooms'?S.DB.revTotal:module==='materials'?S.DB.matTotal:module==='repairs'?S.DB.repTotal:module==='borrows'?S.borrowTotal:S.visitorTotal;
    if(offset >= (total||0)) break;
    await nextPage(module, offset);
  }
  const rows = module==='rooms'?S.DB.reservations:module==='materials'?S.DB.requests:module==='repairs'?S.DB.repairs:module==='borrows'?S.DB.borrows:S.DB.visitors;
  const csv = rowsToCsv(columns, rows||[]);
  const name = {materials:'物资申领',repairs:'报修',visitors:'访客登记',rooms:'会议室预约',borrows:'借用记录'}[module]||module;
  downloadCsv(name+'_'+(S.space?S.space.name:'')+'.csv', csv);
  toast('已导出 '+(rows||[]).length+' 条记录','success');
}
/* ============ 侧栏 ============ */
const STATUS_OPTS = [['在岗',''],['开会','🧘'],['午饭','🍜'],['外出','🚪'],['休息','😴'],['勿扰','⚡']];
function myStatus(){ const u=(S.DB.users||[]).find(x=>x.account===S.me.account); return (u&&u.status)||{label:'在岗',emoji:''}; }
function setStatus(val){ const p=val.split('|'); wsSend({type:'setStatus', label:p[1], emoji:p[0]}); }
function toggleEmergency(){ wsSend({type:'toggleEmergency', enabled: !(S.me && S.me.emergencyMode)}); }
function renderSidebar(){
  const who = S.me ? `${S.me.avatar||'🧑'} ${esc(S.me.nickname||'')}<span class="role-tag ${S.admin?'admin':''}">${S.admin?'管理员':'成员'}</span>` : '未登录';
  const st = myStatus();
  const em = !!(S.me && S.me.emergencyMode);
  const badgeCount = (S.me && S.me.achievements) ? S.me.achievements.length : 0;
  $('#sidebar').innerHTML = `
    <div class="logo">OfficeSpace<small>办公空间管理</small></div>
    <div class="spacename"><b>${S.space?esc(S.space.name):'--'}</b>${S.admin?' · 管理员':''}</div>
    <nav class="nav">${MODULES.map(m=>`<button data-m="${m[0]}" class="${S.module===m[0]?'active':''}" onclick="switchModule('${m[0]}')"><span class="ic">${m[2]}</span>${m[1]}</button>`).join('')}
      <a class="nav" href="screen.html?space=${S.space?S.space.id:''}" target="_blank" style="text-decoration:none"><button style="width:100%"><span class="ic">📺</span>电视墙大屏</button></a></nav>
    <div class="sidefoot">
      <div class="who">${who}</div>
      <div class="fs" style="margin-bottom:8px"><label style="margin:0">状态</label><select style="width:100%" onchange="setStatus(this.value)">
        ${STATUS_OPTS.map(([l,e],i)=>`<option value="${e}|${l}" ${st.label===l?'selected':''}>${e||'🙂'} ${l}</option>`).join('')}
      </select></div>
      <button class="btn sm ${em?'danger':''}" onclick="toggleEmergency()">🆘 紧急模式</button>
      ${S.admin?`<button class="btn sm" onclick="openSpaceSettings()">⚙️ 空间设置</button>`:''}
      ${badgeCount?`<div class="hint" style="margin-bottom:8px">🏅 徽章 ${badgeCount} 枚</div>`:''}
      <button class="btn sm" onclick="openProfile()">个人资料</button>
      <button class="btn sm" onclick="doLogout()">退出登录</button>
    </div>`;
}

/* ============ 入口（空间 + 登录） ============ */
async function renderGate(){
  $('#app').style.display='none';
  const g=$('#gate'); g.style.display='block'; g.style.cssText='';
  const spaces = await http('GET','/api/spaces');
  g.innerHTML = `<div class="gate">
    <div class="head"><h2>🏢 OfficeSpace · 办公空间管理</h2><div class="hint">办公室 / 楼层 / 组织共用的空间管理看板：会议室、工具借用、物资申领、报修、坑位看板</div></div>
    <div class="tabs"><button class="active" id="tab-space" onclick="gateTab('space')">选择空间</button><button id="tab-acct" onclick="gateTab('acct')" style="display:none">账号</button></div>
    <div id="gate-space">
      <div class="form">
        ${spaces.length?`<div class="fld"><label>已有空间</label><div class="list">${spaces.map(s=>`<div class="row"><span><span class="who">${esc(s.name)}</span><span class="when"> · ${s.admin_count} 个管理员</span></span><button class="btn pri sm" onclick="pickSpace('${s.id}')">进入</button></div>`).join('')}</div></div>`:'<div class="hint">暂无空间，先创建一个吧</div>'}
        <div class="fld"><label>创建新空间</label><div class="fs"><input id="spName" placeholder="办公室名，如：三层研发">　<button class="btn pri" onclick="createSpace()">创建</button></div></div>
      </div>
    </div>
    <div id="gate-acct" style="display:none">
      <div class="tabs"><button class="active" id="a-login" onclick="acctTab('login')">登录</button><button id="a-reg" onclick="acctTab('reg')">注册</button></div>
      <div class="form">
        <div class="fld"><label>账号</label><input id="acAccount" placeholder="唯一账号（区分大小写）"></div>
        <div id="regNameWrap" class="fld" style="display:none"><label>展示名</label><input id="acName" placeholder="对外显示名（可重名）"></div>
        <div class="fld"><label>密码</label><input id="acPass" type="password"></div>
        <button class="btn pri" id="doLoginBtn" onclick="submitAccount()">登录</button>
        <div class="hint" id="gate-msg">正在使用空间：<span id="pickedSpace">--</span></div>
      </div>
    </div>
  </div>`;
  if(spaces.length) gateTab('space');
}
function gateTab(t){
  $('#gate-space').style.display = t==='space'?'block':'none';
  $('#gate-acct').style.display = t==='acct'?'block':'none';
}
function acctTab(m){ const isLogin=m==='login'; $('#a-login').className=isLogin?'active':''; $('#a-reg').className=isLogin?'':'active'; $('#regNameWrap').style.display=isLogin?'none':'flex'; $('#doLoginBtn').textContent=isLogin?'登录':'注册'; }
let pickedSpace='';
function pickSpace(id){ pickedSpace=id; $('#pickedSpace').textContent=id; gateTab('acct'); }
async function createSpace(){ const name=$('#spName').value.trim(); if(!name) return toast('请输入空间名','error'); const s=await http('POST','/api/spaces',{name}); if(s.id){ pickedSpace=s.id; gateTab('acct'); toast('空间已创建','success'); } }
async function submitAccount(){ const account=$('#acAccount').value.trim(), pass=$('#acPass').value; if(!account||!pass) return toast('请输入账号密码','error'); const isLogin=$('#a-login').classList.contains('active'); if(!pickedSpace) return toast('请先选择空间','error'); if(isLogin){ doLogin(account,pass); } else { const name=$('#acName').value.trim(); const r=await http('POST','/api/register',{account,password:pass,username:name||account}); if(r.ok) { toast('注册成功，正在登录','success'); doLogin(account,pass); } else toast(r.error||'注册失败','error'); } }
function doLogin(account,password){ S.lastSpace=pickedSpace; localStorage.setItem('os_space',pickedSpace); S.pendingLogin={account,password}; wsSend({type:'join',spaceId:pickedSpace}); }
function doLogout(){ wsSend({type:'logout'}); S.me=null; localStorage.removeItem('os_token'); location.reload(); }
function openProfile(){
  const me=S.me||{};
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>个人资料</h2><div class="form">
    <div class="fld"><label>展示名</label><input id="pfName" maxlength="12" value="${esc(me.nickname||'')}"></div>
    <div class="fld"><label>头像（1-4 字符）</label><input id="pfAvatar" maxlength="4" value="${esc(me.avatar||'🧑')}"></div>
    <button class="btn pri" onclick="submitProfileUpdate()">保存资料</button></div>
    <hr style="margin:16px 0;border:none;border-top:1px solid var(--line)">
    <div class="fld"><label>修改密码</label><div class="fs"><input id="pfOld" type="password" placeholder="旧密码"><input id="pfNew" type="password" placeholder="新密码"></div></div>
    <button class="btn" onclick="submitPasswordChange()">修改密码</button></div>`);
}
function submitProfileUpdate(){ wsSend({type:'profileUpdate',nickname:$('#pfName').value,avatar:$('#pfAvatar').value}); closeModal(); }
function submitPasswordChange(){ wsSend({type:'passwordChange',oldPassword:$('#pfOld').value,newPassword:$('#pfNew').value}); closeModal(); }

function openSpaceSettings(){
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>空间设置</h2><div class="form">
    <div class="fld"><label>空间名（最多 30 字）</label><input id="spNewName" maxlength="30" value="${esc(S.space?S.space.name:'')}"></div>
    <button class="btn pri" onclick="submitSpaceRename()">保存名称</button></div>
    <hr style="margin:16px 0;border:none;border-top:1px solid var(--line)">
    <div class="fld"><label>暂停状态</label><div class="fs"><select id="spPaused"><option value="">未暂停</option><option value="1" ${S.space&&S.space.paused?'selected':''}>已暂停</option></select>
    <input id="spPauseReason" placeholder="原因（如：办公室搬迁）" maxlength="40" style="flex:1"></div></div>
    <button class="btn pri" onclick="submitPause()">保存暂停状态</button>
    <div class="hint">暂停后全员暂不可预约、借用、申领、报修、登记访客</div></div>
    <hr style="margin:16px 0;border:none;border-top:1px solid var(--line)">
    <div class="fld"><label>蹲坑数量 (0-10)</label><input id="scSquat" type="number" min="0" max="10" value="${S.DB.stalls.reduce((a,s)=>s.type==='squat'?a+1:a,0)}"></div>
    <div class="fld"><label>尿槽数量 (0-10)</label><input id="scUr" type="number" min="0" max="10" value="${S.DB.stalls.reduce((a,s)=>s.type==='urinal'?a+1:a,0)}"></div>
    <button class="btn pri" onclick="submitConfig()">保存坑位配置</button>
    <div class="hint">坑位改动会使未开始的预约失效</div></div>`);
}
function submitSpaceRename(){ wsSend({type:'spaceRename', name:$('#spNewName').value}); closeModal(); }
function submitPause(){ const paused=!!$('#spPaused').value; wsSend({type:'spacePause', paused, reason:$('#spPauseReason').value}); closeModal(); }

/* ============ 概览 ============ */
const ACH = { punctual:'守时达人', endurance:'持久战', night:'夜行者', king:'蹲坑之王', grabber:'抢位达人', rater:'评论家', borrower:'借阅达人', requester:'物资管家', reporter:'热心市民', meeter:'会议达人' };
function renderDash(){
  const d=S.DB; const st=(d.stalls||[]); const occupied=st.filter(s=>s.status==='occupied').length;
  const totalBorrowed=d.tools.reduce((a,t)=>a+t.borrowedCount,0);
  const overdue=(d.tools||[]).reduce((a,t)=>a.concat((t.activeBorrows||[]).filter(b=>b.overdue)),[]);
  const mvp=(d.leaderboard||[]).find(r=>r.mvp);
  const dig=S.digest;
  const myBorrowMin=(S.me&&S.me.stats&&S.me.stats.borrowDuration)||0;
  const myMeetingMin=(S.me&&S.me.stats&&S.me.stats.meetingDuration)||0;
  const fmtMin=(m)=>`${Math.floor(m/60)}h${m%60}m`;
  const cards=[
    ['会议室', d.rooms.length, MODULES[0][2]],
    ['工具设备', d.tools.length, '🔧'],
    ['在借数量', totalBorrowed, '📤'],
    ['待处理申领', d.requests.filter(r=>r.status==='pending').length, '📦'],
    ['处理中报修', d.repairs.filter(r=>r.status!=='resolved'&&r.status!=='cancelled').length, '🛠️'],
    ['累计借用时长', fmtMin(myBorrowMin), '📅'],
    ['累计会议时长', fmtMin(myMeetingMin), '⏱️'],
    ['访客登记', S.visitorTotal||0, '🚶'],
    ['坑位占用', occupied+'/'+st.length, '🚻'],
  ];
  $('#main').innerHTML = `<div class="topbar"><div><h1>概览 <span class="view-tag">${esc(S.space?S.space.name:'')}</span></h1><div class="sub">空间内的公共资源使用概览</div></div></div>
    ${mvp?`<div class="row" style="border-color:var(--yellow)"><span><span class="who">👑 本周之星</span> <b>${esc(mvp.username)}</b> · 本周活跃 ${mvp.weekly} 次</span><span class="badge ok">MVP</span></div>`:''}
    <div class="cards">${cards.map(c=>`<div class="card"><h3>${c[2]} ${c[0]}</h3><div style="font-size:30px;font-weight:800">${c[1]}</div></div>`).join('')}</div>
    ${(S.roomStats&&S.roomStats.rooms&&S.roomStats.rooms.length)?`<h3 style="margin:22px 0 10px">📊 会议室今日占用 <span class="badge info">${S.roomStats.utilizationPct}%（9:00-21:00）</span></h3>
    <div class="list">${S.roomStats.rooms.map(r=>{ const cap=S.roomStats.capacityMinutes/S.roomStats.rooms.length||1; return `<div class="row"><span><span class="who">${esc(r.name)}</span> <span class="when">今日 ${r.todayCount} 场 · ${Math.round(r.todayMinutes/60)}h${r.todayMinutes%60?''+r.todayMinutes%60+'m':''} · 待开始 ${r.upcomingCount}</span></span><span class="fs"><span class="bar"><i style="width:${Math.min(100,Math.round(r.todayMinutes/cap*100))}%"></i></span></span></div>`; }).join('')}</div>`:''}
    ${dig?`<h3 style="margin:22px 0 10px">📌 每日看点</h3><div class="list">
      <div class="row"><span>今日会议 ${dig.todayMeetingCount} 场</span>${dig.todayMeetingCount?`<span class="when">${dig.todayMeetings.map(r=>`${esc(r.title)}(${esc(r.ownerName)})`).join('、')}</span>`:''}</div>
      ${dig.overdueCount?`<div class="row"><span>⚠️ 有 <b>${dig.overdueCount}</b> 笔借用逾期未还</span></div>`:''}
      ${dig.myBorrows?`<div class="row"><span>你还有 <b>${dig.myBorrows}</b> 件设备未归还</span></div>`:''}
      ${dig.pendingMaterialsCount?`<div class="row"><span>待处理申领 ${dig.pendingMaterialsCount}</span></div>`:''}
      ${dig.openRepairsCount?`<div class="row"><span>未办结报修 ${dig.openRepairsCount}</span></div>`:''}
      ${dig.pendingVisitorsCount?`<div class="row"><span>🚶 待接待访客 ${dig.pendingVisitorsCount}${dig.pendingVisitors&&dig.pendingVisitors.length?`（${dig.pendingVisitors.map(v=>esc(v.visitorName)).join('、')}）`:''}</span></div>`:''}
      ${dig.todayBorrowMinutes?`<div class="row"><span>📅 今日归还借用累计 ${Math.round(dig.todayBorrowMinutes/60)} 小时</span></div>`:''}
    </div>`:''}
    <h3 style="margin:22px 0 10px">🟢 在线状态</h3>
    <div class="fs">${(d.users||[]).map(u=>`<span class="badge info">${esc(u.avatar||'' )} ${esc(u.display||u.username)}${u.emergencyMode?' 🆘':''}${u.status&&u.status.emoji?' '+esc(u.status.emoji):''} ${u.status?esc(u.status.label):'在岗'}</span>`).join('')||'<span class="hint">仅自己在线</span>'}</div>
    <h3 style="margin:22px 0 10px">📢 公告</h3>
    <div class="fs" style="margin-bottom:10px"><input id="annInput" placeholder="向整个空间喊一句话..."><button class="btn pri" onclick="doAnnounce()">喊话</button></div>
    <div class="list">${(d.notices||[]).map(n=>`<div class="row"><span><span class="who">${esc(n.from)}</span> <span class="when">${fmtTime(n.ts)}</span><div>${esc(n.text)}</div></span>${S.admin?`<button class="btn danger sm" onclick="removeNotice('${n.id}')">删除</button>`:''}</div>`).join('')||'<div class="empty">还没有公告</div>'}
    </div>
    ${overdue.length?`<h3 style="margin:22px 0 10px">⏰ 逾期借用 · 占用王</h3><div class="list">${overdue.map(b=>`<div class="row"><span>${esc(b.borrowerName)} ×${b.qty} · 已借 ${b.days} 天</span><button class="btn danger sm" onclick="remindReturn('${b.id}')">提醒归还</button></div>`).join('')}</div>`:''}
    ${S.me&&S.me.achievements&&S.me.achievements.length?`<h3 style="margin:22px 0 10px">🏅 我的徽章（${S.me.achievements.length} 枚）</h3><div class="fs">${S.me.achievements.map(a=>`<span class="badge ok">${ACH[a]||a}</span>`).join('')}</div>`:''}
    <h3 style="margin:22px 0 10px">🏅 活跃榜（本空间）</h3>
    <div class="list">${ (d.leaderboard||[]).length?d.leaderboard.slice(0,8).map((r,i)=>`<div class="row"><span>${r.mvp?'👑':i+1+'.'} <span class="who">${esc(r.username)}</span> ${r.weekly?`<span class="badge info">本周${r.weekly}</span>`:''} <span class="when">${esc(r.avatar||'' )} 使用${r.stats.totalVisits||0}次 · 借用${r.stats.borrowCount||0}次(${Math.round((r.stats.borrowDuration||0)/60)}h) · 会议${Math.round((r.stats.meetingDuration||0)/60)}h · 申领${r.stats.requestCount||0} · 报修${r.stats.repairCount||0}</span></span></div>`).join(''):'<div class="empty">暂无活动数据</div>'}
    </div>`;
}
function doAnnounce(){ const t=$('#annInput'); const v=(t?t.value:'').trim(); if(v){ wsSend({type:'announce',text:v}); if(t)t.value=''; } }
function removeNotice(id){ if(confirm('确认删除该公告？')) wsSend({type:'removeNotice',noticeId:id}); }
function remindReturn(id){ wsSend({type:'remindReturn',borrowId:id}); }
function remindOverdue(){ wsSend({type:'remindOverdue'}); }

/* ============ 会议室 ============ */
function roomResBadge(st){ return st==='pending'?'<span class="badge warn">待开始</span>':st==='active'?'<span class="badge info">进行中</span>':'<span class="badge grey">'+st+'</span>'; }
function repeatLabel(repeat, first){
  if(repeat==='daily') return '每天';
  if(repeat==='weekly') return '每周' + '日一二三四五六'[new Date(first.startAt).getDay()];
  return '';
}
function roomReservationGroups(list){
  const groups=[]; const map=new Map();
  for(const r of list){
    if(r.seriesId){
      let g=map.get(r.seriesId);
      if(!g){ g={ seriesId:r.seriesId, repeat:r.repeat, items:[] }; map.set(r.seriesId,g); groups.push(g); }
      g.items.push(r);
    } else { groups.push({ single:r }); }
  }
  groups.sort((a,b)=> (a.items?a.items[0].startAt:a.single.startAt) - (b.items?b.items[0].startAt:b.single.startAt));
  return groups;
}
function roomReservationListHtml(d, me){
  const list=d.reservations.filter(r=>r.status!=='cancelled'&&r.status!=='expired');
  if(!list.length) return '<div class="empty">暂无预约</div>';
  return roomReservationGroups(list).map(g=>{
    if(g.single){
      const r=g.single; const rm=d.rooms.find(x=>x.id===r.roomId);
      return `<div class="row"><span><span class="who">${esc(rm?rm.name:'会议室')}</span> · ${esc(r.title)} <span class="when">${fmtTime(r.startAt)} → ${fmtTime(r.endAt)}</span></span><span class="fs">${roomResBadge(r.status)}${r.ownerAccount===me&&r.status==='pending'?`<button class="btn danger sm" onclick="cancelReservation('${r.id}')">取消</button>`:''}</span></div>`;
    }
    const first=g.items[0]; const rm=d.rooms.find(x=>x.id===first.roomId);
    const pat=repeatLabel(g.repeat, first);
    const isOwner = first.ownerAccount===me;
    return `<div class="row"><span><span class="who">${esc(rm?rm.name:'会议室')}</span> · ${esc(first.title)} <span class="when">${pat} ${fmtTime(first.startAt)} → ${fmtTime(first.endAt)}（${g.items.length}场）</span></span><span class="fs">${roomResBadge(first.status)}${isOwner?`<button class="btn danger sm" onclick="cancelSeries('${g.seriesId}')">取消整组</button>`:''}</span></div>`;
  }).join('');
}
function renderRooms(){
  const d=S.DB, me=S.me.account, now=Date.now();
  $('#main').innerHTML = `<div class="topbar"><div><h1>会议室预约</h1><div class="sub">预约时段、冲突自动检测、实时同步</div></div>
    <div class="btn grp"><button class="btn" onclick="openSuggest()">✨ 智能选房</button><button class="btn" onclick="exportModuleCsv('rooms',ROOM_COLS)">导出 CSV</button>${S.admin?'<button class="btn pri" onclick="openRoomCreate()">＋ 新增会议室</button>':''}</div></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${d.rooms.map(r=>roomCard(r)).join('')||'<div class="empty">还没有会议室，管理员可新增</div>'}</div>
    <h3 style="margin:22px 0 10px">📅 全部预约</h3>
    <div class="list">${roomReservationListHtml(d, me)}</div>
    <h3 style="margin:22px 0 10px">⏳ 候补队列 <span class="badge info">${d.waitlistTotal||0}</span></h3>
    <div class="list">${(d.waitlist||[]).length?d.waitlist.map(w=>{ const rm=d.rooms.find(x=>x.id===w.roomId); const mine=w.ownerAccount===me; return `<div class="row"><span><span class="who">${esc(rm?rm.name:'会议室')}</span> · ${esc(w.title)} <span class="when">${fmtTime(w.startAt)} → ${fmtTime(w.endAt)}</span><div class="when">${esc(w.ownerName)}${mine?'（你）':''} · ${fmtTime(w.createdAt)}</div></span>
      <span class="fs">${mine?`<button class="btn danger sm" onclick="cancelWaitlist('${w.id}')">取消候补</button>`:'<span class="badge warn">候补中</span>'}</span></div>`; }).join(''):'<div class="empty">暂无候补</div>'}</div>
    ${(S.DB.revOffset||0)<(S.DB.revTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('rooms')">加载更多（${S.DB.revTotal-(S.DB.revOffset||0)}）</button></div>`:''}`;
}
function roomCard(r){
  const d=S.DB, me=S.me.account;
  const upcoming=d.reservations.filter(x=>x.roomId===r.id&&x.status==='pending').sort((a,b)=>a.startAt-b.startAt).slice(0,3);
  return `<div class="card"><h3>${esc(r.name)} ${S.admin?`<span></span><button class="btn danger sm" onclick="removeRoom('${r.id}')">删</button>`:''}</h3>
    <div class="meta">容量 ${r.capacity} 人${r.location?' · '+esc(r.location):''}${r.description?'<div>'+esc(r.description)+'</div>':''}</div>
    <div class="meta">${upcoming.length?upcoming.map(u=>`· ${fmtTime(u.startAt)} → ${fmtTime(u.endAt)} <b>${esc(u.title)}</b>${u.ownerAccount===me?'（你）':''}`).join('<br>'):'今日暂无预约'}</div>
    <div class="foot"><button class="btn pri sm" onclick="openBook('${r.id}')">预约</button></div></div>`;
}
function openRoomCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>新增会议室</h2><div class="form">
  <div class="fld"><label>名称</label><input id="mrName" placeholder="如：3F 大会议室"></div>
  <div class="fld"><label>容纳人数</label><input id="mrCap" type="number" min="1" value="8"></div>
  <div class="fld"><label>位置</label><input id="mrLoc" placeholder="如：三层东侧"></div>
  <div class="fld"><label>备注</label><input id="mrDesc" placeholder="可选"></div>
  <button class="btn pri" onclick="submitRoomCreate()">创建</button></div>`); }
function submitRoomCreate(){ wsSend({type:'roomCreate',name:$('#mrName').value,capacity:parseInt($('#mrCap').value,10),location:$('#mrLoc').value,description:$('#mrDesc').value}); closeModal(); }
function removeRoom(id){ if(confirm('确认删除该会议室？')) wsSend({type:'roomRemove',roomId:id}); }
function openBook(roomId){
  const now=Date.now(), start=now+10*60000, end=start+60*60000;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>预约会议室</h2><div class="form">
    <div class="fld"><label>会议标题</label><input id="bkTitle" value="会议"></div>
    <div class="fld"><label>参会人数</label><input id="bkPart" type="number" min="1" value="1"></div>
    <div class="fld"><label>开始时间</label><input id="bkStart" type="datetime-local"></div>
    <div class="fld"><label>结束时间</label><input id="bkEnd" type="datetime-local"></div>
    <div class="fld"><label>重复</label><select id="bkRepeat" onchange="document.getElementById('bkCountWrap').style.display=this.value?'block':'none'"><option value="">不重复</option><option value="daily">每天</option><option value="weekly">每周</option></select></div>
    <div class="fld" id="bkCountWrap" style="display:none"><label>次数</label><input id="bkCount" type="number" min="1" max="52" value="8"></div>
    <div class="fld"><label>备注</label><input id="bkNote" placeholder="可选"></div>
    <button class="btn pri" onclick="submitBook('${roomId}')">提交预约</button>
    <div class="hint">同一会议室时段不可重叠预约；周期预约会按天/周展开</div></div>`);
  const d=(ms)=>{ const x=new Date(ms), off=x.getTimezoneOffset(); return new Date(ms-off).toISOString().slice(0,16); };
  $('#bkStart').value=d(start); $('#bkEnd').value=d(end);
}
function submitBook(roomId){
  const st=new Date($('#bkStart').value).getTime(), en=new Date($('#bkEnd').value).getTime();
  if(!(st>0)||!(en>st)) return toast('时间无效','error');
  const repeat=$('#bkRepeat').value;
  const count=parseInt($('#bkCount').value,10)||1;
  const participants=Math.max(1, parseInt($('#bkPart').value,10)||1);
  S.lastRoomBook={roomId,startAt:st,endAt:en,title:$('#bkTitle').value,note:$('#bkNote').value,participants};
  wsSend({type:'roomBook',roomId,startAt:st,endAt:en,title:$('#bkTitle').value,note:$('#bkNote').value,participants,repeat,repeatCount:count});
  closeModal();
}
function cancelReservation(id){ wsSend({type:'reservationCancel',reservationId:id}); }
function cancelSeries(seriesId){ if(confirm('确认取消该周期预约的全部待开始场次？')) wsSend({type:'reservationCancelSeries',seriesId}); }
/* 会议室候补：时段冲突时加入队列，他人取消后自动晋升 */
function openWaitlistModal(attempt){
  const room=(S.DB.rooms||[]).find(r=>r.id===attempt.roomId);
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>加入候补 · ${esc(room?room.name:'会议室')}</h2><div class="form">
    <div class="hint">该时段已被占用，可先加入候补；一旦时段释放，将按先来先服务自动为你预约。</div>
    <div class="fld"><label>时段</label><input value="${fmtTime(attempt.startAt)} → ${fmtTime(attempt.endAt)}（${Math.round((attempt.endAt-attempt.startAt)/60000)} 分钟）"></div>
    <button class="btn pri" onclick="submitWaitlist()">加入候补</button>
    <div class="hint">同一时段只保留一条候补；候补成功后会收到通知</div></div>`);
}
function submitWaitlist(){ const a=S.lastRoomBook||{}; wsSend({type:'roomWaitlist',roomId:a.roomId,startAt:a.startAt,endAt:a.endAt,title:a.title||'会议',note:a.note||''}); closeModal(); }
function cancelWaitlist(id){ wsSend({type:'roomWaitlistCancel',waitlistId:id}); }
/* 智能选房：按时段+人数找空闲会议室 */
function openSuggest(){
  const now=Date.now(), start=now+10*60000, end=start+60*60000, d=(ms)=>{ const x=new Date(ms), off=x.getTimezoneOffset(); return new Date(ms-off).toISOString().slice(0,16); };
  S.suggestions=[];
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>✨ 智能选房</h2><div class="form">
    <div class="fld"><label>开始</label><input id="sgStart" type="datetime-local"></div>
    <div class="fld"><label>结束</label><input id="sgEnd" type="datetime-local"></div>
    <div class="fld"><label>容纳人数（可选）</label><input id="sgCap" type="number" min="1" placeholder="不限"></div>
    <button class="btn pri" onclick="findRooms()">🔍 查找空闲会议室</button>
    <div id="suggList"></div></div>`);
  $('#sgStart').value=d(start); $('#sgEnd').value=d(end);
}
function findRooms(){ wsSend({type:'suggestRoom', startAt:new Date($('#sgStart').value).getTime(), endAt:new Date($('#sgEnd').value).getTime(), capacity:parseInt($('#sgCap').value,10)}); }
function renderSugg(){ const el=$('#suggList'); if(!el) return; const L=S.suggestions||[]; el.innerHTML=L.length?L.map(r=>`<div class="row"><span><span class="who">${esc(r.name)}</span> · 容量 ${r.capacity}${r.location?' · '+esc(r.location):''}</span><button class="btn pri sm" onclick="bookSugg('${r.id}')">就订它</button></div>`).join(''):'<div class="hint">该时段没有空闲会议室，可放宽条件再查</div>'; }
function bookSugg(roomId){ const st=new Date($('#sgStart').value).getTime(), en=new Date($('#sgEnd').value).getTime(); if(!(st>0)||!(en>st)) return toast('时间无效','error'); wsSend({type:'roomBook',roomId,startAt:st,endAt:en,title:'会议'}); closeModal(); }
/* ============ 工具借用 ============ */
function renderTools(){
  const d=S.DB, me=S.me.account;
  const overdueCount=(d.tools||[]).reduce((a,t)=>a+(t.activeBorrows||[]).filter(b=>b.overdue).length,0);
  $('#main').innerHTML = `<div class="topbar"><div><h1>工具借用</h1><div class="sub">测试电脑 / 测试机器 / 测试手机等在库设备的借还</div></div>
    ${S.admin?'<button class="btn pri" onclick="openToolCreate()">＋ 新增设备</button>':''}
    ${overdueCount?`<button class="btn danger" onclick="remindOverdue()">⏰ 批量催还 ${overdueCount} 人</button>`:''}
    <button class="btn" onclick="exportModuleCsv('borrows',BW_COLS)">导出 CSV</button></div>
    <div class="cards">${d.tools.map(t=>`<div class="card"><h3>${esc(t.name)} <span class="badge ${t.available>0?'ok':'bad'}">${t.available}/${t.total}</span></h3>
      <div class="meta">${t.category}${t.location?' · '+esc(t.location):''}</div>
      <div class="bar"><i style="width:${t.total?Math.round(t.available/t.total*100):0}%"></i></div>
      <div class="foot fs">
        ${t.available>0?`<button class="btn pri sm" onclick="openBorrow('${t.id}','${esc(t.name)}',${t.available})">借用</button>`:'<span class="hint">已全部借出</span>'}
        ${S.admin?`<button class="btn danger sm" onclick="removeTool('${t.id}')">删</button><button class="btn sm" onclick="openAdjust('${t.id}','${esc(t.name)}',${t.total},${t.borrowedCount})">改库存</button>`:''}
      </div>
      ${t.activeBorrows&&t.activeBorrows.length?`<div class="meta">在借：${t.activeBorrows.map(b=>{ const can=b.borrowerAccount===me||S.admin; return `${esc(b.borrowerName)}×${b.qty}${b.dueAt?' · 应还 '+fmtTime(b.dueAt):''}${b.days>=0?' · '+b.days+'天':''}${b.overdue?'<span class="badge bad">逾期</span>':''}${b.reminded?'<span class="badge grey">已提醒</span>':''}${b.dueSoon?'<span class="badge warn">即将到期</span>':''}${b.borrowerAccount===me?` <button class="btn green sm" onclick="returnTool('${b.id}')">归还</button>`:''}${can?` <button class="btn sm" onclick="openExtend('${b.id}','${esc(b.borrowerName)}')">续借</button>`:''}${b.borrowerAccount!==me&&b.overdue?` <button class="btn danger sm" onclick="remindReturn('${b.id}')">提醒</button>`:''}`; }).join('，')}</div>`:''}
    </div>`).join('')||'<div class="empty">还没有设备，管理员可新增</div>'}
    </div>`;
}
function openToolCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>新增设备</h2><div class="form">
  <div class="fld"><label>名称</label><input id="tlName" placeholder="如：测试手机 Pro"></div>
  <div class="fld"><label>类别</label><select id="tlCat"><option>测试电脑</option><option>测试机器</option><option>测试手机</option><option>其它</option></select></div>
  <div class="fld"><label>库存数量</label><input id="tlTotal" type="number" min="1" value="1"></div>
  <div class="fld"><label>位置</label><input id="tlLoc" placeholder="可选"></div>
  <div class="fld"><label>备注</label><input id="tlDesc" placeholder="可选"></div>
  <button class="btn pri" onclick="submitToolCreate()">创建</button></div>`); }
function submitToolCreate(){ wsSend({type:'toolCreate',name:$('#tlName').value,category:$('#tlCat').value,total:parseInt($('#tlTotal').value,10),location:$('#tlLoc').value,description:$('#tlDesc').value}); closeModal(); }
function removeTool(id){ if(confirm('删除该设备？')) wsSend({type:'toolDelete',toolId:id}); }
function openAdjust(id,name,total,borrowed){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>调整库存 · ${esc(name)}</h2><div class="form">
  <div class="fld"><label>在借 ${borrowed} · 当前总库存 ${total}</label><input id="adTotal" type="number" min="1" value="${total}"></div>
  <button class="btn pri" onclick="submitAdjust('${id}')">保存</button></div>`); }
function submitAdjust(id){ wsSend({type:'toolAdjust',toolId:id,total:parseInt($('#adTotal').value,10)}); closeModal(); }
function openBorrow(id,name,avail){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>借用 · ${esc(name)}</h2><div class="form">
  <div class="fld"><label>数量（可用 ${avail}）</label><input id="bwQty" type="number" min="1" max="${avail}" value="1"></div>
  <button class="btn pri" onclick="submitBorrow('${id}')">借用</button></div>`); }
function submitBorrow(id){ wsSend({type:'toolBorrow',toolId:id,qty:parseInt($('#bwQty').value,10)}); closeModal(); }
function returnTool(id){ wsSend({type:'toolReturn',borrowId:id}); }
function openExtend(id,name){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>续借 · ${esc(name)}</h2><div class="form">
  <div class="fld"><label>续借天数（1-30）</label><input id="exDays" type="number" min="1" max="30" value="7"></div>
  <button class="btn pri" onclick="submitExtend('${id}')">确认续借</button></div>`); }
function submitExtend(id){ wsSend({type:'toolExtend',borrowId:id,days:parseInt($('#exDays').value,10)||7}); closeModal(); }

/* ============ 物资申领 ============ */
function renderMaterials(){
  const d=S.DB, me=S.me.account;
  $('#main').innerHTML = `<div class="topbar"><div><h1>物资申领</h1><div class="sub">需要电池、文具等物资时提交申请，由同事/管理员处理</div></div>
    <button class="btn pri" onclick="openMaterialRequest()">＋ 我要申领</button><button class="btn" onclick="exportModuleCsv('materials',MAT_COLS)">导出 CSV</button></div>
    <div class="list">${d.requests.map(r=>{ const st=r.status; const badge=st==='pending'?'warn':st==='fulfilled'?'ok':'grey'; const canAssign=r.requesterAccount===me||S.admin; const canFulfill=st==='pending'&&!(r.handlerAccount&&r.handlerAccount!==me&&!S.admin); return `<div class="row"><span><span class="who">${esc(r.requesterName)}</span> 申领 <b>${esc(r.name)}</b> ×${r.qty}${r.unit?' '+esc(r.unit):''}${r.handlerName?` · 负责人 ${esc(r.handlerName)}`:''}<div class="desc">${esc(r.reason||'')}</div><div class="when">${fmtTime(r.createdAt)}</div></span>
      <span class="fs"><span class="badge ${badge}">${st==='pending'?'待处理':st==='fulfilled'?'已满足':'已取消'}</span>
      ${st==='pending'?`${r.requesterAccount===me?`<button class="btn danger sm" onclick="cancelRequest('${r.id}')">取消</button>`:(canFulfill?`<button class="btn green sm" onclick="fulfillRequest('${r.id}')">已满足</button>`:'')}${canAssign?`<button class="btn sm" onclick="openAssign('material','${r.id}')">指派</button>`:''}`:''}
      </span></div>`; }).join('')||'<div class="empty">暂无申领记录</div>'}
    </div>
    ${(S.DB.matOffset||0)<(S.DB.matTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('materials')">加载更多（${S.DB.matTotal-(S.DB.matOffset||0)}）</button></div>`:''}`;
}
function openMaterialRequest(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>物资申领</h2><div class="form">
  <div class="fld"><label>物资名称</label><input id="mtName" placeholder="如：5号电池"></div>
  <div class="fld"><label>数量</label><div class="fs"><input id="mtQty" type="number" min="1" value="1" style="width:100px"><input id="mtUnit" placeholder="单位（个/节/盒）" style="flex:1"></div></div>
  <div class="fld"><label>说明</label><input id="mtReason" placeholder="为什么需要"></div>
  <button class="btn pri" onclick="submitMaterial()">提交</button></div>`); }
function submitMaterial(){ wsSend({type:'materialRequest',name:$('#mtName').value,qty:parseInt($('#mtQty').value,10),unit:$('#mtUnit').value,reason:$('#mtReason').value}); closeModal(); }
function cancelRequest(id){ wsSend({type:'materialCancel',requestId:id}); }
function fulfillRequest(id){ wsSend({type:'materialFulfill',requestId:id}); }

/* ============ 报修 ============ */
function renderRepairs(){
  const d=S.DB, me=S.me.account;
  const badge=s=>s==='reported'?'warn':s==='in_progress'?'info':s==='resolved'?'ok':'grey';
  const label=s=>s==='reported'?'待处理':s==='in_progress'?'处理中':s==='resolved'?'已解决':'已取消';
  const pBadge=p=>p==='high'?'bad':p==='normal'?'info':'grey';
  const pLabel=p=>p==='high'?'高':p==='normal'?'中':'低';
  $('#main').innerHTML = `<div class="topbar"><div><h1>报修</h1><div class="sub">上报厕所、灯光、空调等设施故障并及时跟进</div></div>
    <button class="btn pri" onclick="openRepair()">＋ 我要报修</button><button class="btn" onclick="exportModuleCsv('repairs',REP_COLS)">导出 CSV</button></div>
    <div class="list">${d.repairs.map(r=>{ const canAssign=r.reporterAccount===me||S.admin; return `<div class="row"><span><span class="who">${esc(r.category)} · ${esc(r.location)}</span> <span class="when">${esc(r.reporterName)} ${fmtTime(r.createdAt)}${r.handlerName?` · 负责人 ${esc(r.handlerName)}`:''}</span><div class="desc">${esc(r.description)}</div></span>
      <span class="fs">
      <span class="badge ${badge(r.status)}">${label(r.status)}</span>
      <span class="badge ${pBadge(r.priority)}">${pLabel(r.priority)}优先</span>
      ${r.status==='reported'?`<button class="btn sm" onclick="setRepair('${r.id}','in_progress')">开始处理</button>`:''}
      ${(r.status==='reported'||r.status==='in_progress')?`<button class="btn green sm" onclick="setRepair('${r.id}','resolved')">已解决</button>`:''}
      ${r.status==='reported'||r.status==='in_progress'?`${r.reporterAccount===me||S.admin?`<button class="btn sm" onclick="openPriority('${r.id}','${esc(r.priority||'normal')}')">改优先级</button>`:''}`:''}
      ${r.status==='reported'?`${canAssign?`<button class="btn sm" onclick="openAssign('repair','${r.id}')">指派</button>`:''}${r.reporterAccount===me?`<button class="btn danger sm" onclick="setRepair('${r.id}','cancelled')">撤销</button>`:''}`:''}
      </span></div>`; }).join('')||'<div class="empty">暂无报修记录</div>'}
    </div>
    ${(S.DB.repOffset||0)<(S.DB.repTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('repairs')">加载更多（${S.DB.repTotal-(S.DB.repOffset||0)}）</button></div>`:''}`;
}
function openRepair(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>提交报修</h2><div class="form">
  <div class="fld"><label>类别</label><select id="rpCat"><option>厕所</option><option>灯光</option><option>空调</option><option>其它</option></select></div>
  <div class="fld"><label>优先级</label><select id="rpPri"><option value="normal">中</option><option value="high">高</option><option value="low">低</option></select></div>
  <div class="fld"><label>位置</label><input id="rpLoc" placeholder="如：三层男厕第二个坑位"></div>
  <div class="fld"><label>描述</label><input id="rpDesc" placeholder="故障现象"></div>
  <button class="btn pri" onclick="submitRepair()">提交</button></div>`); }
function submitRepair(){ wsSend({type:'repairCreate',category:$('#rpCat').value,priority:$('#rpPri').value,location:$('#rpLoc').value,description:$('#rpDesc').value}); closeModal(); }
function setRepair(id,status){ wsSend({type:'repairUpdate',repairId:id,status}); }
function openPriority(id,cur){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>调整优先级</h2><div class="form">
  <div class="fld"><label>优先级</label><select id="ppPri"><option value="high" ${cur==='high'?'selected':''}>高</option><option value="normal" ${cur==='normal'?'selected':''}>中</option><option value="low" ${cur==='low'?'selected':''}>低</option></select></div>
  <button class="btn pri" onclick="submitPriority('${id}')">保存</button></div>`); }
function submitPriority(id){ wsSend({type:'repairUpdate',repairId:id,priority:$('#ppPri').value}); closeModal(); }
function openAssign(kind, id){
  const opts=(S.DB.users||[]).filter(u=>u.account!==S.me.account).map(u=>`<option value="${u.account}">${esc(u.display||u.username||u.account)}（${esc(u.account)}）</option>`).join('');
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>指派负责人</h2><div class="form">
    <div class="fld"><label>负责人（空间内在线成员）</label><select id="asAccount">${opts||'<option value="">暂无其他在线成员</option>'}</select></div>
    <button class="btn pri" onclick="submitAssign('${kind}','${id}')">指派</button></div>`);
}
function submitAssign(kind, id){
  const acc=$('#asAccount').value;
  if(!acc){ toast('请选择负责人','error'); return; }
  if(kind==='repair') wsSend({type:'repairAssign', repairId:id, handlerAccount:acc});
  else wsSend({type:'materialAssign', requestId:id, handlerAccount:acc});
  closeModal();
}
/* ============ 访客登记 ============ */
function visitorBadge(s){ return s==='pending'?'warn':s==='arrived'?'info':s==='left'?'ok':'grey'; }
function visitorLabel(s){ return s==='pending'?'待到访':s==='arrived'?'已到访':s==='left'?'已离开':'已取消'; }
function renderVisitors(){
  const d=S.DB, me=S.me.account;
  $('#main').innerHTML = `<div class="topbar"><div><h1>访客登记</h1><div class="sub">登记访客姓名、事由与预计到访，负责人可推进状态；访客凭签到码到访核销</div></div>
    <button class="btn pri" onclick="openVisitorCreate()">＋ 登记访客</button><button class="btn" onclick="openCheckin()">🔑 凭码核销</button><button class="btn" onclick="exportModuleCsv('visitors',VIS_COLS)">导出 CSV</button></div>
    <div class="list">${d.visitors.map(v=>{
      const mine = v.hostAccount===me;
      const can = mine||S.admin;
      return `<div class="row"><span><span class="who">${esc(v.hostName)}</span> 接待 <b>${esc(v.visitorName)}</b><div class="desc">${esc(v.purpose)}${v.contact?' · 联系方式 '+esc(v.contact):''}</div><div class="when">${fmtTime(v.createdAt)}${v.expectedAt?' · 预计 '+fmtTime(v.expectedAt):''}</div>${v.code?`<span class="badge ${v.expired?'bad':v.status==='pending'?'warn':'info'}">签到码 ${esc(v.code)}${v.expiresAt?' · 到期 '+fmtTime(v.expiresAt):''}</span>`:''}</span>
      <span class="fs"><span class="badge ${visitorBadge(v.status)}">${visitorLabel(v.status)}</span>
      ${can?(v.status==='pending'?`<button class="btn green sm" onclick="visitorAction('${v.id}','visitorArrived')">确认到访</button><button class="btn danger sm" onclick="visitorAction('${v.id}','visitorCancel')">取消</button>`:v.status==='arrived'?`<button class="btn green sm" onclick="visitorAction('${v.id}','visitorLeft')">离开</button>`:''):''}
      ${S.admin?`<button class="btn danger sm" onclick="visitorAction('${v.id}','visitorRemove')">删除</button>`:''}
      </span></div>`; }).join('')||'<div class="empty">暂无访客记录</div>'}
    </div>
    ${(S.visitorOffset||0)<(S.visitorTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('visitors')">加载更多（${S.visitorTotal-(S.visitorOffset||0)}）</button></div>`:''}`;
}
function openVisitorCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>登记访客</h2><div class="form">
  <div class="fld"><label>访客姓名</label><input id="vsName" placeholder="如：张三"></div>
  <div class="fld"><label>来访事由</label><input id="vsPurpose" placeholder="如：商务拜访 / 面试 / 送修"></div>
  <div class="fld"><label>联系方式（可选）</label><input id="vsContact" placeholder="手机号或内部短号"></div>
  <div class="fld"><label>预计到访（可选）</label><input id="vsExpected" type="datetime-local"></div>
  <button class="btn pri" onclick="submitVisitorCreate()">登记</button></div>`); }
function submitVisitorCreate(){ const st=$('#vsExpected').value?new Date($('#vsExpected').value).getTime():0; wsSend({type:'visitorCreate',visitorName:$('#vsName').value,purpose:$('#vsPurpose').value,contact:$('#vsContact').value,expectedAt:st||0}); closeModal(); }
/* 访客签到码核销：访客到访时输入/报出 6 位签到码 */
function openCheckin(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>🔑 凭签到码核销</h2><div class="form">
  <div class="fld"><label>访客签到码（6 位）</label><input id="ckCode" placeholder="如：ABC123" maxlength="6" style="text-transform:uppercase;letter-spacing:4px"></div>
  <button class="btn pri" onclick="submitCheckin()">核销签到</button></div>`); }
function submitCheckin(){ const code=$('#ckCode').value.trim(); if(!code) return toast('请输入签到码','error'); wsSend({type:'visitorCheckin',code}); closeModal(); }
function visitorAction(id,type){ wsSend({type, visitorId:id}); }

/* ============ 坑位看板 ============ */
function stallCard(s){
  const me=S.me?S.me.account:'';
  const own = s.currentBy && s.currentBy.account===me;
  const res = s.reservation;
  const remains = res ? res.endTime - Date.now() : 0;
  let badge='', buttons='';
  if(s.status==='free'){ badge='<span class="badge ok">空闲</span>'; buttons=`<button class="btn pri sm" onclick="openReserve(${s.id},'${s.type}')">预约</button><button class="btn sm" onclick="grabStall(${s.id})">⚡抢位</button>`; }
  else if(s.status==='reserved'){ badge='<span class="badge warn">已预约</span>'; buttons = own?`<button class="btn sm" onclick="cancelStall(${s.id})">取消</button>${Date.now()>=res.startTime?`<button class="btn green sm" onclick="startUse(${s.id})">到坑</button>`:''}` : '<span class="hint">他人预约</span>'; }
  else if(s.status==='waiting'){ badge='<span class="badge warn">可到坑</span>'; buttons = own?`<button class="btn green sm" onclick="startUse(${s.id})">确认到坑</button><button class="btn danger sm" onclick="cancelStall(${s.id})">取消</button>` : '<span class="hint">他人预约</span>'; }
  else if(s.status==='occupied'){ badge='<span class="badge bad">使用中</span>'; buttons = own?`<button class="btn green sm" onclick="finishStall(${s.id})">完成</button><button class="btn sm" onclick="releaseStall(${s.id})">释放</button>` : `<button class="btn sm" onclick="urgeStall(${s.id})">催促</button>`; buttons+=`<button class="btn sm" onclick="openRate(${s.id})">评分</button>`; }
  const ratings = s.ratings&&s.ratings.length ? `${Math.round(s.ratings.reduce((a,r)=>a+r.cleanliness,0)/s.ratings.length*10)/10}★(${s.ratings.length})` : '';
  return `<div class="stall"><div class="name">${esc(s.name)}</div>${badge}
    ${s.currentBy?`<span class="owner">${esc(s.currentBy.display)}</span>`:''}
    ${s.status==='occupied'?`<div class="count">⏳剩余 ${fmtCountdown(remains)}</div>`:s.status!=='free'?`<div class="count">${fmtTime(res.startTime)}</div>`:''}
    ${s.urgeCount?`<div class="count">📣已催促${s.urgeCount}</div>`:''}
    <div class="foot">${s.tier&&s.tier.name!=='新坑'?`<div class="hint">${s.tier.icon} ${s.tier.name} · ${s.tier.count}评</div>`:''}${ratings?'<div class="hint">'+ratings+'</div>':''}${buttons}</div></div>`;
}
function renderStalls(){
  const d=S.DB;
  $('#main').innerHTML = `<div class="topbar"><div><h1>坑位看板</h1><div class="sub">卫生间坑位实时状态 · 蹲坑倒计时 5 分钟 · 尿槽 1 分钟</div></div>
    ${S.admin?`<button class="btn" onclick="openStallConfig()">⚙️ 配置坑位</button>`:''}</div>
    <div class="grid">${d.stalls.map(stallCard).join('')}</div>`;
}
function renderAchievements(){
  const list = S.DB.achievements || [];
  $('#main').innerHTML = `<div class="topbar"><div><h1>成就墙</h1><div class="sub">办公冒险进度 · 达成条件即可解锁专属徽章</div></div></div>
    <div class="cards" style="grid-template-columns:repeat(auto-fill,minmax(230px,1fr))">${list.length?list.map(a=>`
      <div class="card achievement ${a.unlocked?'unlocked':''}">
        <div style="font-size:34px;line-height:1">${a.unlocked?a.icon:'🔒'}</div>
        <h3>${esc(a.name)} ${a.unlocked?'<span class="badge ok">已解锁</span>':'<span class="badge grey">未解锁</span>'}</h3>
        <div class="meta">${esc(a.desc)}</div>
        <div class="fs" style="flex-direction:column;align-items:stretch;gap:8px">
          <div class="bar"><i style="width:${a.pct}%"></i></div>
          <span class="when">${a.current}/${a.target}</span>
        </div>
      </div>`).join(''):'<div class="empty">暂无成就数据</div>'}</div>`;
}
function renderReminders(){
  const r = S.DB.reminders || {};
  const tools = S.DB.tools || [];
  const fmtMin = (ms) => `${Math.floor(ms/60000)}分钟`;
  const sec = (r) => {
    if (r.overdueCount) return `<h3 style="margin:22px 0 10px">⏰ 逾期借用 <span class="badge bad">${r.overdueCount}</span></h3><div class="list">${r.overdue.map(b=>{ const t=tools.find(x=>x.id===b.toolId); return `<div class="row"><span>${esc(t?t.name:b.toolId)} ×${b.qty} · 已借 ${b.days} 天</span><button class="btn danger sm" onclick="remindReturn('${b.id}')">提醒归还</button></div>`; }).join('')}</div>`;
    if (r.upcomingCount) return `<h3 style="margin:22px 0 10px">📅 临近会议 <span class="badge warn">${r.upcomingCount}</span></h3><div class="list">${r.upcoming.map(m=>`<div class="row"><span><span class="who">${esc(m.title)}</span> <span class="when">${fmtTime(m.startAt)} → ${fmtTime(m.endAt)}</span></span></div>`).join('')}</div>`;
    if (r.pendingVisitorCount) return `<h3 style="margin:22px 0 10px">🚶 待接待访客 <span class="badge warn">${r.pendingVisitorCount}</span></h3><div class="list">${r.pendingVisitors.map(v=>`<div class="row"><span>${esc(v.visitorName)} <span class="badge ${v.status==='pending'?'warn':'info'}">${v.status==='pending'?'待到访':'已到访'}</span></span></div>`).join('')}</div>`;
    if (r.assignedMaterialCount) return `<h3 style="margin:22px 0 10px">📦 指派给我的申领 <span class="badge warn">${r.assignedMaterialCount}</span></h3><div class="list">${r.assignedMaterials.map(m=>`<div class="row"><span>${esc(m.name)} <span class="badge ${m.status==='pending'?'warn':'info'}">${m.status}</span></span></div>`).join('')}</div>`;
    if (r.assignedRepairCount) return `<h3 style="margin:22px 0 10px">🛠️ 指派给我的报修 <span class="badge warn">${r.assignedRepairCount}</span></h3><div class="list">${r.assignedRepairs.map(x=>`<div class="row"><span>${esc(x.category)} ${esc(x.location)} <span class="badge ${x.status==='reported'?'warn':'info'}">${x.status}</span></span></div>`).join('')}</div>`;
    return '<div class="empty">🎉 一切就绪，暂无待办事项</div>';
  };
  $('#main').innerHTML = `<div class="topbar"><div><h1>我的待办</h1><div class="sub">按优先级聚合与你相关的到期、临期与待处理事项</div></div>
    <button class="btn" onclick="wsSend({type:'getMyReminders'})">刷新</button></div>${sec(r)}`;
}
function renderTrend(){
  const list = S.DB.trend || [];
  const metrics = [['meetings','🏢 会议'],['borrows','🔧 借用'],['requests','📦 申领'],['repairs','🛠️ 报修'],['visitors','🚶 访客']];
  const maxVal = Math.max(1, ...list.map((b) => Math.max(b.meetings, b.borrows, b.requests, b.repairs, b.visitors)));
  $('#main').innerHTML = `<div class="topbar"><div><h1>空间趋势</h1><div class="sub">近 ${list.length} 天各模块活动量</div></div>
    <div class="btn grp"><button class="btn" onclick="loadTrend(7)">近7天</button><button class="btn pri" onclick="loadTrend(14)">近14天</button><button class="btn" onclick="loadTrend(30)">近30天</button></div></div>
    ${list.length?metrics.map(([k,label])=>`
      <h3 style="margin:18px 0 8px">${label}</h3>
      <div class="chart">${list.map(b=>`<div class="barcol"><div class="barval">${b[k]||0}</div><div class="barwrap"><i style="height:${Math.round((b[k]||0)/maxVal*100)}%"></i></div><span class="xlab">${(b.date.getMonth()+1)}/${b.date.getDate()}</span></div>`).join('')}</div>`).join(''):'<div class="empty">暂无趋势数据</div>'}`;
}
function loadTrend(days){ wsSend({type:'getSpaceTrend',days}); }
setInterval(()=>{ if(S.module==='stalls' && S.me && document.visibilityState==='visible') renderStalls(); }, 1000);
function openReserve(id,type){
  const opts = type==='urinal' ? [['1分钟',1],['2分钟',2],['5分钟',5]] : [['15分钟',15],['30分钟',30],['45分钟',45]];
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>预约坑位 #${id}</h2><div class="form">
    <div class="fld"><label>使用时长</label>${opts.map(o=>`<button class="btn" onclick="doReserve(${id},${o[1]})">${o[0]}</button>`).join('')}</div>
    <div class="hint">1 分钟后到点，需在开始时间后再确认到坑</div></div>`);
}
function doReserve(id,dur){ wsSend({type:'reserve',stallId:id,duration:dur}); closeModal(); }
function grabStall(id){ if(confirm('临时抢位？抢到后需在倒计时内使用')) wsSend({type:'grab',stallId:id}); }
function startUse(id){ wsSend({type:'startUse',stallId:id}); }
function finishStall(id){ if(confirm('确认使用完成？')) wsSend({type:'finish',stallId:id}); }
function releaseStall(id){ if(confirm('提前释放坑位？')) wsSend({type:'release',stallId:id}); }
function cancelStall(id){ wsSend({type:'cancel',stallId:id}); }
function urgeStall(id){ wsSend({type:'urge',stallId:id}); }
function openRate(id){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>坑位评分</h2><div class="form">
  <div class="fld"><label>干净度 (1-5)</label><select id="rtClean">${[1,2,3,4,5].map(n=>`<option value="${n}">${n}</option>`).join('')}</select></div>
  <div class="fld"><label>信号 (1-5)</label><select id="rtSig"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></div>
  <div class="fld"><label>纸巾 (1-5)</label><select id="rtPaper"><option>1</option><option>2</option><option>3</option><option>4</option><option>5</option></select></div>
  <button class="btn pri" onclick="submitRate(${id})">提交</button></div>`); }
function submitRate(id){ wsSend({type:'rate',stallId:id,cleanliness:+$('#rtClean').value,signal:+$('#rtSig').value,paper:+$('#rtPaper').value}); closeModal(); }
function openStallConfig(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>配置坑位</h2><div class="form">
  <div class="fld"><label>蹲坑数量 (0-10)</label><input id="scSquat" type="number" min="0" max="10" value="${S.DB.stalls.reduce((a,s)=>s.type==='squat'?a+1:a,0)}"></div>
  <div class="fld"><label>尿槽数量 (0-10)</label><input id="scUr" type="number" min="0" max="10" value="${S.DB.stalls.reduce((a,s)=>s.type==='urinal'?a+1:a,0)}"></div>
  <button class="btn pri" onclick="submitConfig()">保存</button>
  <div class="hint">改动会使未开始的预约失效</div></div>`); }
function submitConfig(){ wsSend({type:'stallConfig',squat_count:parseInt($('#scSquat').value,10),urinal_count:parseInt($('#scUr').value,10)}); closeModal(); }

/* ============ 启动 ============ */
function init(){
  if(S.token && S.lastSpace && S.lastSpace!=='') {
    // 自动恢复会话
    $('#app').style.display='none';
    $('#gate').style.display='flex'; $('#gate').innerHTML = `<div class="gate"><div class="head"><h2>OfficeSpace</h2><div class="hint">正在恢复会话…</div></div></div>`;
    S.pendingLogin = { token: S.token };
    connect();
  } else {
    renderGate();
    connect();
  }
}
document.addEventListener('DOMContentLoaded', init);
