
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
  DB:{ rooms:[], reservations:[], waitlist:[], waitlistTotal:0, tools:[], requests:[], materialTemplates:[], repairs:[], visitors:[], stalls:[], users:[], leaderboard:[], borrows:[], inventory:{items:[],issues:[]}, attendance:{records:[],stats:{},config:{workStart:'09:00',workEnd:'18:00',lateMinutes:15}}, desks:{desks:[],reservations:[],reservationTotal:0}, ooo:{records:[],stats:{}}, leaves:{leaves:[],stats:{}}, meetingNotes:{notes:[],stats:{}}, events:[], polls:[], knowledge:[], tasks:[], notifications:[] },
  visitorTotal:0, visitorOffset:0,
  borrowTotal:0, borrowOffset:0,
  eventTotal:0, eventOffset:0, pollTotal:0, pollOffset:0, knowledgeTotal:0, knowledgeOffset:0, taskTotal:0, taskStats:{}, notificationTotal:0, notificationUnread:0,
  roomStats:null,
  deskStats:null,
  lastRoomBook:null,
  _kbReply:null,
  favorites:[],
  weeklyReport:null,
  attendanceCalendar:null,
  admin:false, sockOpen:false,
};
const MODULES = [ ['rooms','会议室','🏢'],['tools','工具借用','🔧'],['materials','物资申领','📦'],['inventory','物资库存','🗃️'],['repairs','报修','🛠️'],['visitors','访客登记','🚶'],['attend','考勤打卡','🕒'],['desks','工位预约','🪑'],['ooo','外出登记','🧳'],['feedback','意见反馈','💬'],['mood','心情打卡','🌈'],['leave','请假审批','📅'],['meetingNotes','会议纪要','📝'],['events','活动管理','🎉'],['polls','投票','🗳️'],['knowledge','知识库','📘'],['tasks','待办任务','📝'],['notifications','通知中心','🔔'],['stalls','坑位看板','🚻'],['ach','成就墙','🏅'],['rem','我的待办','🔔'],['an','空间趋势','📈'],['dash','概览','📊'] ];

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
      if(S.me.stats && Array.isArray(S.me.stats.favoriteRooms)) S.favorites=S.me.stats.favoriteRooms;
      S.admin = m.role==='admin'; S.token=m.token;
      localStorage.setItem('os_token',m.token); localStorage.setItem('os_space',S.space?S.space.id:S.lastSpace);
      $('#gate').style.display='none'; $('#app').style.display='flex'; renderAll(); break;
    case 'rooms': S.DB.rooms=m.rooms; S.DB.reservations=m.reservations; S.DB.revTotal=m.reservationTotal||0; S.DB.revOffset=S.DB.reservations.length; S.DB.waitlist=m.waitlist||[]; S.DB.waitlistTotal=m.waitlistTotal||0; S.DB.roomInsights=m.insights||null; break;
    case 'tools': S.DB.tools=m.tools; S.DB.toolWaitlist=m.waitlist||[]; break;
    case 'inventory': S.DB.inventory={ items:m.items||[], issues:m.issues||[] }; break;
    case 'attendance': S.DB.attendance={ records:m.records||[], stats:m.stats||{}, config:m.config||{workStart:'09:00',workEnd:'18:00',lateMinutes:15} }; break;
    case 'desks': S.DB.desks={ desks:m.desks||[], reservations:m.reservations||[], reservationTotal:m.reservationTotal||0 }; break;
    case 'deskStats': S.deskStats=m.stats; break;
    case 'ooo': S.DB.ooo={ records:m.records||[], stats:m.stats||{} }; break;
    case 'feedback': S.DB.feedback={ records:m.records||[], stats:m.stats||{} }; break;
    case 'mood': S.DB.mood={ records:m.records||[], stats:m.stats||{} }; break;
    case 'leaves': S.DB.leaves={ leaves:m.leaves||[], stats:m.stats||{} }; break;
    case 'meetingNotes': S.DB.meetingNotes={ notes:m.notes||[], stats:m.stats||{} }; break;
    case 'events': S.DB.events=m.events||[]; S.eventTotal=m.total||0; S.eventOffset=S.DB.events.length; S.eventStats=m.stats||{}; break;
    case 'polls': S.DB.polls=m.polls||[]; S.pollTotal=m.total||0; S.pollOffset=S.DB.polls.length; S.pollStats=m.stats||{}; break;
    case 'knowledge': S.DB.knowledge=m.knowledge||[]; S.knowledgeTotal=m.total||0; S.knowledgeOffset=S.DB.knowledge.length; S.knowledgeStats=m.stats||{}; break;
    case 'tasks': S.DB.tasks=m.tasks||[]; S.taskTotal=m.total||0; S.taskStats=m.stats||{}; break;
    case 'notifications': S.DB.notifications=m.notifications||[]; S.notificationTotal=m.total||0; S.notificationUnread=m.unreadCount||0; renderSidebar(); break;
    case 'materials': S.DB.requests=m.requests; S.DB.materialTemplates=m.templates||[]; S.DB.matTotal=m.total||0; S.DB.matOffset=S.DB.requests.length; break;
    case 'repairs': S.DB.repairs=m.repairs; S.DB.repTotal=m.total||0; S.DB.repOffset=S.DB.repairs.length; S.DB.repairStats=m.stats||null; break;
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
    case 'weeklyReport': S.weeklyReport=m.report||null; if(m.report){ toast('📅 本周空间周报：会议 '+(m.report.meetings||0)+' · 借用 '+(m.report.borrows||0)+' · 申领 '+(m.report.requests||0)+' · 报修 '+(m.report.repairs||0)+'（已解决 '+(m.report.resolvedRepairs||0)+'） · 工位 '+(m.report.desks||0)+' · 外出 '+(m.report.ooo||0),'success'); } render(); break;
    case 'suggestRooms': S.suggestions=m.suggestions||[]; renderSugg(); break;
    case 'statusSet': toast('✔ 状态已更新','success'); break;
    case 'remindSent': toast('✔ 已提醒 '+(m.count||0)+' 人','success'); break;
    case 'remindOverdueSent': toast('✔ 已批量提醒 '+(m.count||0)+' 位逾期借用人','success'); render(); break;
    case 'borrowReminder': toast('🔔 '+(m.from||'有人')+'提醒你归还设备',"urge"); break;
    case 'overdueReminder': toast('⏰ 你借的设备已逾期，请尽快归还','urge'); break;
    case 'toolLowStock': toast('⚠️ 设备库存告急：'+(m.toolName||'')+' 可用 '+m.available+'（阈值 '+m.minAvailable+'）','warn'); render(); break;
    case 'inventoryLowStock': toast('⚠️ 物资库存告急：'+(m.itemName||'')+' 可用 '+m.available+'（阈值 '+m.minAvailable+'）','warn'); render(); break;
    case 'attendanceCheckedIn': toast(m.isLate?'⏰ 上班打卡成功（已迟到）':'✔ 上班打卡成功', m.isLate?'warn':'success'); render(); break;
    case 'attendanceCheckedOut': toast('✔ 下班打卡成功，今日工作 '+Math.round((m.workedMinutes||0)/60)+'h'+((m.workedMinutes||0)%60?(m.workedMinutes%60)+'m':''),'success'); render(); break;
    case 'oooBacked': toast('✔ 已确认返回（'+(m.category||'外出')+'）','success'); render(); break;
    case 'moodCheckedIn': toast('🌈 心情已记录：'+(m.emoji||''),'success'); render(); break;
    case 'leaveCreated': if(S.admin) toast('📅 有请假申请待审批：'+(m.name||'')+' · '+(m.category||''),'info'); break;
    case 'leaveApproved': toast('✔ 请假申请已批准：'+(m.category||''),'success'); render(); break;
    case 'leaveRejected': toast('✘ 请假申请已被驳回：'+(m.category||'')+(m.decideNote?' · '+m.decideNote:''),'warn'); render(); break;
    case 'leaveSla': toast('⏳ 请假申请待审批超时：'+(m.name||'')+' · '+(m.category||''),'warn'); render(); break;
    case 'meetingNoteCreated': if(S.admin) toast('📝 会议纪要已更新：'+(m.noteId||''),'info'); break;
    case 'meetingNoteUpdated': toast('✔ 会议纪要已保存','success'); render(); break;
    case 'eventCreated': toast('🎉 活动已创建','success'); render(); break;
    case 'eventRsvpChanged': { const ev=(S.DB.events||[]).find(e=>e.id===m.rsvpId); if(ev) ev.myRsvp=m.status; toast('✔ 已更新参与状态（'+({going:'参加',maybe:'可能',not_going:'不参加'}[m.status]||m.status)+'）','success'); render(); break; }
    case 'eventCancelled': toast('已取消活动','warn'); render(); break;
    case 'eventReminder': toast('🔔 活动「'+(m.title||'')+'」即将开始：'+fmtTime(m.startAt),'success'); break;
    case 'pollCreated': toast('🗳️ 投票已发起','success'); render(); break;
    case 'pollVoted': { const pl=(S.DB.polls||[]).find(p=>p.id===m.pollId); if(pl) pl.myVote=m.optionId; toast('✔ 投票已提交','success'); render(); break; }
    case 'pollClosed': toast('🔒 投票已关闭','info'); render(); break;
    case 'knowledgeCreated': toast('📘 知识已发布','success'); render(); break;
    case 'knowledgeUpdated': toast('✔ 文章已更新','success'); render(); break;
    case 'knowledgeLiked': { const k=(S.DB.knowledge||[]).find(x=>x.id===m.id); if(k){ k.liked=m.liked; k.likeCount=Math.max(0,(k.likeCount||0)+(m.liked?1:-1)); } toast(m.liked?'👍 已点赞':'已取消点赞','success'); render(); break; }
    case 'knowledgeCommented': { const k=(S.DB.knowledge||[]).find(x=>x.id===m.id); if(k){ k.commentCount=(k.commentCount||0)+1; } toast('💬 评论成功','success'); render(); break; }
    case 'taskCreated': toast('📝 任务已创建','success'); render(); break;
    case 'taskAssigned': toast('📌 任务已指派给你：'+(m.title||''),'info'); render(); break;
    case 'taskCommented': { const t=(S.DB.tasks||[]).find(x=>x.id===m.taskId); if(t){ t.commentCount=(t.commentCount||0)+1; } toast('💬 任务已评论','success'); render(); break; }
    case 'taskUpdated': toast('✔ 任务已更新','success'); render(); break;
    case 'taskStarted': toast('▶️ 任务已开始','info'); render(); break;
    case 'taskCompleted': toast('✅ 任务已完成','success'); render(); break;
    case 'taskRemoved': toast('已删除任务','info'); render(); break;
    case 'notificationRead': S.notificationUnread=Math.max(0,S.notificationUnread-1); renderSidebar(); break;
    case 'notificationReadAll': S.notificationUnread=0; renderSidebar(); break;
    case 'attendanceCalendar': S.attendanceCalendar=m.calendar||null; render(); break;
    case 'oooReturnSoon': toast('🔔 外出预计 '+fmtTime(m.expectedReturnAt)+' 返回，请记得回来','warn'); render(); break;
    case 'borrowDueSoon': toast('🔔 你借的设备即将到期，请按时归还','warn'); render(); break;
    case 'roomReminder': { const rm=(S.DB.rooms||[]).find(r=>r.id===m.roomId); toast('🔔 '+(rm?rm.name:'会议室')+' 即将开始：'+fmtTime(m.startAt),'success'); break; }
    case 'materialAssigned': toast('📌 物资申领已指派给你：'+(m.name||''),'info'); render(); break;
    case 'materialFulfilled': toast('✅ 物资申领已满足：'+(m.name||''),'success'); render(); break;
    case 'repairAssigned': toast('📌 报修已指派给你：'+(m.category||'')+' · '+(m.location||''),'info'); render(); break;
    case 'repairInProgress': toast('🔧 报修处理中：'+(m.category||'')+' · '+(m.location||''),'info'); render(); break;
    case 'repairResolved': toast('✅ 报修已解决：'+(m.category||'')+' · '+(m.location||''),'success'); render(); break;
    case 'repairSla': toast('⚠️ 报修超时未处理：'+(m.category||'')+' · '+(m.location||''),'warn'); render(); break;
    case 'repairEscalated': toast('🚨 高优先报修已升级：'+(m.category||'')+' · '+(m.location||'')+'，请尽快处理','warn'); render(); break;
    case 'repairCommented': { const r=(S.DB.repairs||[]).find(x=>x.id===m.repairId); if(r){ r.commentCount=(r.commentCount||0)+1; } toast('💬 报修已跟进','success'); render(); break; }
    case 'repairRated': toast('✔ 已评价：'+(m.satisfaction||'')+'⭐','success'); render(); break;
    case 'materialSla': toast('⚠️ 申领超时未处理：'+(m.name||'')+' ×'+(m.qty||1),'warn'); render(); break;
    case 'stats': if(S.me && m.stats){ S.me.stats = m.stats; if(m.achievements) S.me.achievements = m.achievements; render(); } break;
    case 'urgeNotification': toast('📣 有人催促你了（'+m.count+' 人）','urge'); break;
    case 'reservation': toast('✔ 预约成功','success'); break;
    case 'cancelSuccess': toast('✔ 已取消','success'); break;
    case 'reservationApproved': toast('✔ 会议室预约已批准：'+fmtTime(m.startAt),'success'); render(); break;
    case 'reservationRejected': toast('✘ 会议室预约已被驳回：'+(m.title||''),'warn'); render(); break;
    case 'roomApprovalRequested': if(S.admin) toast('📋 有会议室预约待审批','info'); break;
    case 'roomApprovalPending': if(S.admin) toast('🔔 会议室预约待审批已超时：'+(m.roomName||'')+' · '+(m.title||''),'warn'); break;
    case 'roomWaitlistPromoted': toast('🎉 候补已晋升：预约已自动创建（'+fmtTime(m.startAt)+'）','success'); render(); break;
    case 'meetingStarted': { const rm=(S.DB.rooms||[]).find(r=>r.id===m.roomId); toast('🔔 会议已开始：'+(rm?rm.name:'会议室')+' · '+(m.title||''),'success'); render(); break; }
    case 'meetingAttended': toast('✅ 已确认到场','success'); render(); break;
    case 'reservationRescheduled': toast('✔ 改期成功：'+fmtTime(m.startAt)+' → '+fmtTime(m.endAt),'success'); render(); break;
    case 'roomRated': toast('✔ 会议室评分已提交：'+m.score+' 分','success'); render(); break;
    case 'roomFavorites': S.favorites=m.favorites||[]; if(S.me && S.me.stats) S.me.stats.favoriteRooms=S.favorites; render(); break;
    case 'toolWaitlistJoined': toast('✔ 已加入排队，轮到你时会自动借用','success'); render(); break;
    case 'toolWaitlistPromoted': toast('🎉 排队已晋升：'+(m.toolName||'设备')+' 已为你自动借用','success'); render(); break;
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
    case 'adminSet': if(S.me && m.account===S.me.account){ S.admin=!!m.admin; renderSidebar(); } render(); break;
    case 'spaceKicked': if(S.me && m.account===S.me.account){ toast('你已被管理员移除空间','warn'); S.me=null; S.admin=false; S.space=null; renderGate(); } else { toast('已移除成员 '+(m.accountName||'')+'','info'); render(); } break;
    case 'noticeRemoved': toast('公告已删除','success'); break;
    case 'emergencyToggled': if(S.me) S.me.emergencyMode=!!m.enabled; toast(m.enabled?'🆘 已开启紧急模式':'✅ 已退出紧急模式'); render(); break;
    case 'autoRelease': case 'reservationExpired': toast('⏰ 坑位已超时释放','warn'); break;
    default: break;
  }
  if(['rooms','tools','materials','repairs','visitors','stalls','attendance','desks','deskStats','ooo','feedback','mood','leaves','meetingNotes','roomStats','users','leaderboard','achievements','myReminders','spaceTrend','notices','digest'].includes(m.type)) render();
}
/* 渲染入口：只重绘当前模块 */
function render(){ if(!S.me) return; renderPauseBanner(); renderSidebar(); if(S.module==='dash') renderDash(); else if(S.module==='rooms') renderRooms(); else if(S.module==='tools') renderTools(); else if(S.module==='materials') renderMaterials(); else if(S.module==='inventory') renderInventory(); else if(S.module==='repairs') renderRepairs(); else if(S.module==='visitors') renderVisitors(); else if(S.module==='stalls') renderStalls(); else if(S.module==='attend') renderAttendance(); else if(S.module==='desks') renderDesks(); else if(S.module==='ooo') renderOoo(); else if(S.module==='feedback') renderFeedback(); else if(S.module==='mood') renderMood(); else if(S.module==='leave') renderLeaves(); else if(S.module==='meetingNotes') renderMeetingNotes(); else if(S.module==='events') renderEvents(); else if(S.module==='polls') renderPolls(); else if(S.module==='knowledge') renderKnowledge(); else if(S.module==='tasks') renderTasks(); else if(S.module==='notifications') renderNotifications(); else if(S.module==='ach') renderAchievements(); else if(S.module==='rem') renderReminders(); else if(S.module==='an') renderTrend(); }
function renderPauseBanner(){
  const b=$('#pause-banner'); if(!b) return;
  if(S.space && S.space.paused){ b.style.display='block'; b.innerHTML='🔒 空间已暂停：'+(S.space.pausedReason?esc(S.space.pausedReason)+' · ':'')+'暂停预约 / 借用 / 申领 / 报修 / 访客登记'; }
  else { b.style.display='none'; }
}
function renderAll(){ render(); }
function switchModule(mod){ S.module=mod; const nav=$('#sidebar .nav button'); (nav?[...nav]:[]).forEach(b=>b.classList.toggle('active', b.dataset.m==mod)); render(); if(mod==='ach') wsSend({type:'getAchievements'}); if(mod==='rem') wsSend({type:'getMyReminders'}); if(mod==='an') wsSend({type:'getSpaceTrend',days:14}); if(mod==='attend') wsSend({type:'getAttendanceCalendar',year:new Date().getFullYear(),month:new Date().getMonth()+1}); }

/* 分页：广播已按最近 PAGE 下发，前端按 offset 加载更多 */
const PAGE = 30;
function handlePage(m){
  if(m.module==='materials'){ S.DB.requests=(S.DB.requests||[]).concat(m.items); S.DB.matOffset=m.offset+m.items.length; }
  else if(m.module==='repairs'){ S.DB.repairs=(S.DB.repairs||[]).concat(m.items); S.DB.repOffset=m.offset+m.items.length; }
  else if(m.module==='rooms'){ S.DB.reservations=(S.DB.reservations||[]).concat(m.items); S.DB.revOffset=m.offset+m.items.length; }
  else if(m.module==='visitors'){ S.DB.visitors=(S.DB.visitors||[]).concat(m.items); S.visitorOffset=m.offset+m.items.length; }
  else if(m.module==='borrows'){ S.DB.borrows=(S.DB.borrows||[]).concat(m.items); S.borrowOffset=m.offset+m.items.length; }
  else if(m.module==='events'){ S.DB.events=(S.DB.events||[]).concat(m.items); S.eventOffset=m.offset+m.items.length; }
  else if(m.module==='polls'){ S.DB.polls=(S.DB.polls||[]).concat(m.items); S.pollOffset=m.offset+m.items.length; }
  else if(m.module==='knowledge'){ S.DB.knowledge=(S.DB.knowledge||[]).concat(m.items); S.knowledgeOffset=m.offset+m.items.length; }
  render();
}
function loadMore(module){ wsSend({type:'fetchPage', module, offset: module==='materials'?S.DB.matOffset:module==='repairs'?S.DB.repOffset:module==='visitors'?S.visitorOffset:module==='events'?S.eventOffset:module==='polls'?S.pollOffset:module==='knowledge'?S.knowledgeOffset:S.DB.revOffset, limit:PAGE}); }
/* ============ CSV 导出 ============ */
function csvCell(v){ let s=String(v==null?'':v); if(/[",\n\r]/.test(s)) s='"'+s.replace(/"/g,'""')+'"'; return s; }
function rowsToCsv(columns, rows){
  const head=columns.map(c=>csvCell(c.label)).join(',');
  const body=rows.map(r=>columns.map(c=>csvCell(c.fmt?c.fmt(r[c.key]):r[c.key])).join(',')).join('\r\n');
  return head+'\r\n'+body;
}
const CSV_FMT = { time: (v)=>v?fmtTime(v):'' , condition: (v)=>({intact:'完好',damaged:'损坏',missing:'丢失'}[v]||v||'') };
const MAT_COLS=[{key:'requesterName',label:'申请人'},{key:'name',label:'物资'},{key:'qty',label:'数量'},{key:'unit',label:'单位'},{key:'reason',label:'说明'},{key:'status',label:'状态'},{key:'createdAt',label:'时间',fmt:CSV_FMT.time},{key:'handledAt',label:'处理时间',fmt:CSV_FMT.time}];
const REP_COLS=[{key:'code',label:'工单号'},{key:'category',label:'类别'},{key:'priority',label:'优先级'},{key:'location',label:'位置'},{key:'description',label:'描述'},{key:'reporterName',label:'上报人'},{key:'status',label:'状态'},{key:'createdAt',label:'时间',fmt:CSV_FMT.time},{key:'handledAt',label:'处理时间',fmt:CSV_FMT.time}];
const VIS_COLS=[{key:'hostName',label:'接待人'},{key:'visitorName',label:'访客'},{key:'purpose',label:'事由'},{key:'contact',label:'联系方式'},{key:'status',label:'状态'},{key:'expectedAt',label:'预计到访',fmt:CSV_FMT.time},{key:'createdAt',label:'登记时间',fmt:CSV_FMT.time}];
const ROOM_COLS=[{key:'title',label:'主题'},{key:'ownerName',label:'预约人'},{key:'startAt',label:'开始',fmt:CSV_FMT.time},{key:'endAt',label:'结束',fmt:CSV_FMT.time},{key:'status',label:'状态'}];
const BW_COLS=[{key:'toolName',label:'设备'},{key:'toolCategory',label:'类别'},{key:'borrowerName',label:'借用人'},{key:'qty',label:'数量'},{key:'borrowedAt',label:'借出',fmt:CSV_FMT.time},{key:'dueAt',label:'应还',fmt:CSV_FMT.time},{key:'returnedAt',label:'归还',fmt:CSV_FMT.time},{key:'condition',label:'归还状态',fmt:CSV_FMT.condition},{key:'status',label:'状态'}];
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
    <nav class="nav">${MODULES.map(m=>{ const badge = m[0]==='notifications' && S.notificationUnread ? `<span class="badge warn">${S.notificationUnread}</span>` : ''; return `<button data-m="${m[0]}" class="${S.module===m[0]?'active':''}" onclick="switchModule('${m[0]}')"><span class="ic">${m[2]}</span>${m[1]}${badge}</button>`; }).join('')}
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
    <div class="head"><h2>🏢 OfficeSpace · 办公空间管理</h2><div class="hint">办公室 / 楼层 / 组织共用的空间管理看板：会议室、工具借用、物资申领、报修、访客登记、考勤打卡、坑位看板</div></div>
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
  const memberRows=(S.DB.users||[]).map(u=>{ const isSelf=u.account===S.me.account; const admin=u.role==='admin'; return `<div class="row"><span><span class="who">${esc(u.display||u.username||u.account)}</span> <span class="badge ${admin?'info':'grey'}">${admin?'管理员':'成员'}</span>${isSelf?'<span class="hint">（自己）</span>':''}</span>${isSelf?'':(admin?`<button class="btn danger sm" onclick="setAdmin('${u.account}',false)">取消管理员</button>`:`<button class="btn sm" onclick="setAdmin('${u.account}',true)">设为管理员</button>`)}${isSelf?'':`<button class="btn danger sm" onclick="kickMember('${u.account}')">移除</button>`}</div>`; }).join('')||'<div class="hint">暂无在线成员</div>';
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>空间设置</h2><div class="form">
    <div class="fld"><label>空间名（最多 30 字）</label><input id="spNewName" maxlength="30" value="${esc(S.space?S.space.name:'')}"></div>
    <button class="btn pri" onclick="submitSpaceRename()">保存名称</button></div>
    <hr style="margin:16px 0;border:none;border-top:1px solid var(--line)">
    <div class="fld"><label>管理员管理</label><div class="list">${memberRows}</div><div class="hint">至少保留一名管理员，避免空间无人可管理</div></div>
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
function setAdmin(account, admin){ wsSend({type:'spaceAdminSet', account, admin}); closeModal(); }
function kickMember(account){ wsSend({type:'spaceKick', account}); closeModal(); }
function submitPause(){ const paused=!!$('#spPaused').value; wsSend({type:'spacePause', paused, reason:$('#spPauseReason').value}); closeModal(); }

/* ============ 概览 ============ */
const ACH = { punctual:'守时达人', endurance:'持久战', night:'夜行者', king:'蹲坑之王', grabber:'抢位达人', rater:'评论家', borrower:'借阅达人', requester:'物资管家', reporter:'热心市民', meeter:'会议达人', roomGuide:'会议室向导', collector:'收藏家', earlyBird:'早到达人', attendanceKing:'打卡达人', deskKnight:'工位达人', awayReporter:'外出报备达人' };
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
    ['今日打卡', ((S.DB.attendance&&S.DB.attendance.stats&&S.DB.attendance.stats.checkedIn)||0), '🕒'],
    ['今日工位', dig.deskTodayCount||0, '🪑'],
    ['外出中', dig.oooActiveCount||0, '🧳'],
  ];
  $('#main').innerHTML = `<div class="topbar"><div><h1>概览 <span class="view-tag">${esc(S.space?S.space.name:'')}</span></h1><div class="sub">空间内的公共资源使用概览</div></div></div>
    ${mvp?`<div class="row" style="border-color:var(--yellow)"><span><span class="who">👑 本周之星</span> <b>${esc(mvp.username)}</b> · 本周活跃 ${mvp.weekly} 次</span><span class="badge ok">MVP</span></div>`:''}
    <div class="cards">${cards.map(c=>`<div class="card"><h3>${c[2]} ${c[0]}</h3><div style="font-size:30px;font-weight:800">${c[1]}</div></div>`).join('')}</div>
    ${(S.roomStats&&S.roomStats.rooms&&S.roomStats.rooms.length)?`<h3 style="margin:22px 0 10px">📊 会议室今日占用 <span class="badge info">${S.roomStats.utilizationPct}%（9:00-21:00）</span> <span class="badge ok">⏱️ 共到场 ${Math.round((S.roomStats.totalActualMinutes||0)/60)}h</span></h3>
    <div class="list">${S.roomStats.rooms.map(r=>{ const cap=S.roomStats.capacityMinutes/S.roomStats.rooms.length||1; return `<div class="row"><span><span class="who">${esc(r.name)}</span> <span class="when">今日 ${r.todayCount} 场 · ${Math.round(r.todayMinutes/60)}h${r.todayMinutes%60?''+r.todayMinutes%60+'m':''} · 待开始 ${r.upcomingCount} · ⏱️ 到场 ${Math.round(r.actualMinutes/60)}h${r.actualMinutes%60?''+r.actualMinutes%60+'m':''}</span></span><span class="fs"><span class="bar"><i style="width:${Math.min(100,Math.round(r.todayMinutes/cap*100))}%"></i></span></span></div>`; }).join('')}</div>`:''}
    ${(S.deskStats&&S.deskStats.desks&&S.deskStats.desks.length)?`<h3 style="margin:22px 0 10px">🪑 工位今日占用 <span class="badge info">${S.deskStats.utilizationPct}%（9:00-21:00）</span></h3>
     <div class="list">${S.deskStats.desks.map(r=>`<div class="row"><span><span class="who">${esc(r.name)}</span> <span class="when">今日 ${r.todayCount} 场 · ${Math.round(r.todayMinutes/60)}h${r.todayMinutes%60?''+r.todayMinutes%60+'m':''} · 待开始 ${r.upcomingCount}</span></span><span class="fs"><span class="bar"><i style="width:${Math.min(100, Math.round(r.todayMinutes / (S.deskStats.capacityMinutes/S.deskStats.desks.length || 1) * 100))}%"></i></span></span></div>`).join('')}</div>`:''}
    ${dig?`<h3 style="margin:22px 0 10px">📌 每日看点</h3><div class="list">
      <div class="row"><span>今日会议 ${dig.todayMeetingCount} 场</span>${dig.todayMeetingCount?`<span class="when">${dig.todayMeetings.map(r=>`${esc(r.title)}(${esc(r.ownerName)})`).join('、')}</span>`:''}</div>
      ${dig.overdueCount?`<div class="row"><span>⚠️ 有 <b>${dig.overdueCount}</b> 笔借用逾期未还</span></div>`:''}
      ${dig.myBorrows?`<div class="row"><span>你还有 <b>${dig.myBorrows}</b> 件设备未归还</span></div>`:''}
      ${dig.pendingMaterialsCount?`<div class="row"><span>待处理申领 ${dig.pendingMaterialsCount}</span></div>`:''}
      ${dig.openRepairsCount?`<div class="row"><span>未办结报修 ${dig.openRepairsCount}</span></div>`:''}
      ${dig.pendingVisitorsCount?`<div class="row"><span>🚶 待接待访客 ${dig.pendingVisitorsCount}${dig.pendingVisitors&&dig.pendingVisitors.length?`（${dig.pendingVisitors.map(v=>esc(v.visitorName)).join('、')}）`:''}</span></div>`:''}
      ${dig.attendanceCheckedIn?`<div class="row"><span>🕒 今日打卡 ${dig.attendanceCheckedIn} 人${dig.attendanceLate?`（迟到 ${dig.attendanceLate} 人）`:''}</span></div>`:''}
      ${dig.oooActiveCount?`<div class="row"><span>🧳 外出中 ${dig.oooActiveCount} 人${dig.activeOoo&&dig.activeOoo.length?`（${dig.activeOoo.map(o=>esc(o.name)+'·'+esc(o.category)).join('、')}）`:''}</span></div>`:''}
      ${dig.todayBorrowMinutes?`<div class="row"><span>📅 今日归还借用累计 ${Math.round(dig.todayBorrowMinutes/60)} 小时</span></div>`:''}
    </div>`:''}
    <h3 style="margin:22px 0 10px">🟢 在线状态</h3>
    <div class="fs">${(d.users||[]).map(u=>`<span class="badge info">${esc(u.avatar||'' )} ${esc(u.display||u.username)}${u.emergencyMode?' 🆘':''}${u.status&&u.status.emoji?' '+esc(u.status.emoji):''} ${u.status?esc(u.status.label):'在岗'}</span>`).join('')||'<span class="hint">仅自己在线</span>'}</div>
    <h3 style="margin:22px 0 10px">📢 公告</h3>
    <div class="fs" style="margin-bottom:10px"><input id="annInput" placeholder="向整个空间喊一句话..."><button class="btn pri" onclick="doAnnounce()">喊话</button></div>
    <div class="list">${(d.notices||[]).map(n=>`<div class="row"><span><span class="who">${esc(n.from)}</span> <span class="when">${fmtTime(n.ts)}</span><div>${esc(n.text)}</div><div class="fs" style="margin-top:6px">${noticeReactions(n).map(r=>`<button class="btn sm ${r.me?'pri':''}" onclick="reactNotice('${n.id}','${r.e}')">${r.e} ${r.count}</button>`).join(' ')}</div></span>${S.admin?`<button class="btn danger sm" onclick="removeNotice('${n.id}')">删除</button>`:''}</div>`).join('')||'<div class="empty">还没有公告</div>'}
    </div>
    ${overdue.length?`<h3 style="margin:22px 0 10px">⏰ 逾期借用 · 占用王</h3><div class="list">${overdue.map(b=>`<div class="row"><span>${esc(b.borrowerName)} ×${b.qty} · 已借 ${b.days} 天</span><button class="btn danger sm" onclick="remindReturn('${b.id}')">提醒归还</button></div>`).join('')}</div>`:''}
    ${S.weeklyReport?`<h3 style="margin:22px 0 10px">📅 本周空间周报 <span class="badge info">${fmtTime(S.weeklyReport.weekStart)}</span></h3><div class="list">
      <div class="row"><span>会议 ${S.weeklyReport.meetings} 场 / ${Math.round(S.weeklyReport.meetingMinutes/60)}h</span></div>
      <div class="row"><span>借用 ${S.weeklyReport.borrows} · 申领 ${S.weeklyReport.requests}（已满足 ${S.weeklyReport.fulfilledMaterials}） · 报修 ${S.weeklyReport.repairs}（已解决 ${S.weeklyReport.resolvedRepairs}） · 访客 ${S.weeklyReport.visitors} · 工位 ${S.weeklyReport.desks||0} · 外出 ${S.weeklyReport.ooo||0}</span></div>
      ${S.weeklyReport.openRepairsCount?`<div class="row"><span>⏳ 未办结报修 ${S.weeklyReport.openRepairsCount}</span></div>`:''}
      ${S.weeklyReport.pendingMaterialsCount?`<div class="row"><span>⏳ 待处理申领 ${S.weeklyReport.pendingMaterialsCount}</span></div>`:''}
      ${(S.weeklyReport.lowStockTools||[]).length?`<div class="row"><span>⚠️ 库存告急：${S.weeklyReport.lowStockTools.map(t=>`${esc(t.name)} ${t.available}/${t.minAvailable}`).join('、')}</span></div>`:''}
    </div>`:''}
    ${S.me&&S.me.achievements&&S.me.achievements.length?`<h3 style="margin:22px 0 10px">🏅 我的徽章（${S.me.achievements.length} 枚）</h3><div class="fs">${S.me.achievements.map(a=>`<span class="badge ok">${ACH[a]||a}</span>`).join('')}</div>`:''}
    <h3 style="margin:22px 0 10px">🏅 活跃榜（本空间）</h3>
    <div class="list">${ (d.leaderboard||[]).length?d.leaderboard.slice(0,8).map((r,i)=>`<div class="row"><span>${r.mvp?'👑':i+1+'.'} <span class="who">${esc(r.username)}</span> ${r.weekly?`<span class="badge info">本周${r.weekly}</span>`:''} <span class="when">${esc(r.avatar||'' )} 使用${r.stats.totalVisits||0}次 · 借用${r.stats.borrowCount||0}次(${Math.round((r.stats.borrowDuration||0)/60)}h) · 会议${Math.round((r.stats.meetingDuration||0)/60)}h(准时${Math.round((r.stats.meetingOnTime||0)/(((r.stats.meetingOnTime||0)+(r.stats.meetingLate||0))||1)*100)}%) · 申领${r.stats.requestCount||0} · 报修${r.stats.repairCount||0}</span></span></div>`).join(''):'<div class="empty">暂无活动数据</div>'}
    </div>`;
}
function doAnnounce(){ const t=$('#annInput'); const v=(t?t.value:'').trim(); if(v){ wsSend({type:'announce',text:v}); if(t)t.value=''; } }
const NOTICE_EMOJIS=['👍','🎉','😮','🤝','🔥'];
function noticeReactions(n){ const arr=n.reactions||[]; return NOTICE_EMOJIS.map(e=>({e, count:arr.filter(r=>r.reaction===e).length, me:arr.some(r=>r.account===S.me.account&&r.reaction===e)})); }
function reactNotice(id, e){ wsSend({type:'noticeReact',noticeId:id,reaction:e}); }
function removeNotice(id){ if(confirm('确认删除该公告？')) wsSend({type:'removeNotice',noticeId:id}); }
function remindReturn(id){ wsSend({type:'remindReturn',borrowId:id}); }
function remindOverdue(){ wsSend({type:'remindOverdue'}); }

/* ============ 会议室 ============ */
function roomResBadge(st){ return st==='pending'?'<span class="badge warn">待开始</span>':st==='pending_approval'?'<span class="badge warn">待审批</span>':st==='active'?'<span class="badge info">进行中</span>':'<span class="badge grey">'+st+'</span>'; }
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
      const action = r.status==='pending_approval' ? `${S.admin?`<button class="btn green sm" onclick="reservationApprove('${r.id}')">批准</button><button class="btn danger sm" onclick="reservationReject('${r.id}')">驳回</button>`:''}${r.ownerAccount===me?`<button class="btn danger sm" onclick="cancelReservation('${r.id}')">取消</button>`:''}` : ((r.ownerAccount===me||S.admin)&&r.status==='pending') ? `<button class="btn sm" onclick="openReschedule('${r.id}')">改期</button>${r.ownerAccount===me?`<button class="btn danger sm" onclick="cancelReservation('${r.id}')">取消</button>`:''}` : '';
      return `<div class="row"><span><span class="who">${esc(rm?rm.name:'会议室')}</span> · ${esc(r.title)} <span class="when">${fmtTime(r.startAt)} → ${fmtTime(r.endAt)}</span>${r.actualStartAt&&r.actualEndAt?` <span class="hint">⏱️ 到场 ${Math.max(0,Math.round((r.actualEndAt-r.actualStartAt)/60000))} 分钟</span>`:''}</span><span class="fs">${roomResBadge(r.status)}${r.attendees&&r.attendees.length?`<span class="badge info">👥 到场 ${r.attendanceRate||0}%（${(r.attendedAccounts||[]).length}/${r.attendees.length}）</span>`:''}${action}${(r.status==='active'&&(r.attendees||[]).includes(me)&&!(r.attendedAccounts||[]).includes(me))?`<button class="btn green sm" onclick="meetingAttend('${r.id}')">✅ 确认到场</button>`:''}${(r.ownerAccount===me||S.admin)&&r.status==='completed'&&!r.rating?`<button class="btn sm" onclick="openRoomRate('${r.id}')">评分</button>`:''}${r.rating?`<span class="badge ok">已评 ${r.rating}⭐</span>`:''}</span></div>`;
    }
    const first=g.items[0]; const rm=d.rooms.find(x=>x.id===first.roomId);
    const pat=repeatLabel(g.repeat, first);
    const isOwner = first.ownerAccount===me;
    return `<div class="row"><span><span class="who">${esc(rm?rm.name:'会议室')}</span> · ${esc(first.title)} <span class="when">${pat} ${fmtTime(first.startAt)} → ${fmtTime(first.endAt)}（${g.items.length}场）</span></span><span class="fs">${roomResBadge(first.status)}${isOwner?`<button class="btn danger sm" onclick="cancelSeries('${g.seriesId}')">取消整组</button>`:''}</span></div>`;
  }).join('');
}
function renderRooms(){
  const d=S.DB, me=S.me.account, now=Date.now();
  const favFilter = S.favFilter || 'all';
  const favIds = S.favorites || [];
  const rooms = favFilter==='fav' ? d.rooms.filter(r=>favIds.includes(r.id)) : d.rooms;
  $('#main').innerHTML = `<div class="topbar"><div><h1>会议室预约</h1><div class="sub">预约时段、冲突自动检测、实时同步</div></div>
    <div class="btn grp"><button class="btn ${favFilter==='all'?'pri':''}" onclick="setRoomFavFilter('all')">全部</button><button class="btn ${favFilter==='fav'?'pri':''}" onclick="setRoomFavFilter('fav')">⭐ 我的收藏 (${favIds.length})</button><button class="btn" onclick="openSuggest()">✨ 智能选房</button><button class="btn" onclick="exportModuleCsv('rooms',ROOM_COLS)">导出 CSV</button>${S.admin?'<button class="btn pri" onclick="openRoomCreate()">＋ 新增会议室</button>':''}</div></div>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(280px,1fr))">${rooms.map(r=>roomCard(r)).join('')||'<div class="empty">还没有会议室，管理员可新增</div>'}</div>
    ${roomInsightsHtml()}
    <h3 style="margin:22px 0 10px">📅 全部预约</h3>
    <div class="list">${roomReservationListHtml(d, me)}</div>
    <h3 style="margin:22px 0 10px">⏳ 候补队列 <span class="badge info">${d.waitlistTotal||0}</span></h3>
    <div class="list">${(d.waitlist||[]).length?d.waitlist.map(w=>{ const rm=d.rooms.find(x=>x.id===w.roomId); const mine=w.ownerAccount===me; return `<div class="row"><span><span class="who">${esc(rm?rm.name:'会议室')}</span> · ${esc(w.title)} <span class="when">${fmtTime(w.startAt)} → ${fmtTime(w.endAt)}</span><div class="when">${esc(w.ownerName)}${mine?'（你）':''} · ${fmtTime(w.createdAt)}</div></span>
      <span class="fs">${mine?`<button class="btn danger sm" onclick="cancelWaitlist('${w.id}')">取消候补</button>`:'<span class="badge warn">候补中</span>'}</span></div>`; }).join(''):'<div class="empty">暂无候补</div>'}</div>
    ${(S.DB.revOffset||0)<(S.DB.revTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('rooms')">加载更多（${S.DB.revTotal-(S.DB.revOffset||0)}）</button></div>`:''}`;
}
// 会议室洞察：评分口碑榜 + 使用率排行
function roomInsightsHtml(){
  const ins = S.DB.roomInsights || null;
  if (!ins || (!ins.ratingRanking.length && !ins.usageRanking.length)) return '';
  const ratingRows = ins.ratingRanking.length ? ins.ratingRanking.map((r, i) => `<tr><td>${i+1}</td><td>${esc(r.name)}</td><td>${'⭐'.repeat(Math.round(r.avg))}${'☆'.repeat(5-Math.round(r.avg))} <b>${r.avg}</b></td><td>${r.count}</td></tr>`).join('') : '<tr><td colspan="4" style="color:var(--muted)">暂无评分数据</td></tr>';
  const usageRows = ins.usageRanking.length ? ins.usageRanking.map((r, i) => `<tr><td>${i+1}</td><td>${esc(r.name)}</td><td>${r.todayCount}</td><td>${r.todayMinutes} 分钟</td></tr>`).join('') : '';
  return `<h3 style="margin:22px 0 10px">💡 会议室洞察</h3>
    <div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(300px,1fr))">
      <div class="card"><h3>⭐ 评分口碑榜</h3><table><thead><tr><th>#</th><th>会议室</th><th>评分</th><th>评价数</th></tr></thead><tbody>${ratingRows}</tbody></table></div>
      <div class="card"><h3>📊 使用率排行</h3><table><thead><tr><th>#</th><th>会议室</th><th>今日场次</th><th>今日分钟</th></tr></thead><tbody>${usageRows||'<tr><td colspan="4" style="color:var(--muted)">今日暂无预约</td></tr>'}</tbody></table></div>
    </div>`;
}
function roomCard(r){
  const d=S.DB, me=S.me.account;
  const upcoming=d.reservations.filter(x=>x.roomId===r.id&&x.status==='pending').sort((a,b)=>a.startAt-b.startAt).slice(0,3);
  const fav = (S.favorites||[]).includes(r.id);
  const rate = r.rating ? `<div class="meta">评分 ${'⭐'.repeat(Math.round(r.rating.avg))}${'☆'.repeat(5-Math.round(r.rating.avg))} ${r.rating.avg} (${r.rating.count})${r.rating.dimensions?` · 环境 ${r.rating.dimensions.environment.avg} 设备 ${r.rating.dimensions.equipment.avg} 服务 ${r.rating.dimensions.service.avg}`:''}</div>` : '';
  return `<div class="card"><h3>${esc(r.name)} <button class="btn sm ${fav?'pri':''}" title="收藏" onclick="toggleFavorite('${r.id}')">${fav?'⭐':'☆'}</button> ${S.admin?`<span></span><button class="btn danger sm" onclick="removeRoom('${r.id}')">删</button>`:''}</h3>
    <div class="meta">容量 ${r.capacity} 人 · 预约 ${r.minMinutes||5}-${r.maxMinutes||720} 分钟${r.location?' · '+esc(r.location):''}${r.description?'<div>'+esc(r.description)+'</div>':''}${r.tags&&r.tags.length?'<div style="margin-top:4px">'+r.tags.map(t=>`<span class="badge grey">${esc(t)}</span>`).join('')+'</div>':''}${r.requireApproval?'<div style="margin-top:4px"><span class="badge warn">需审批</span></div>':''}</div>
    ${rate}
    <div class="meta">${upcoming.length?upcoming.map(u=>`· ${fmtTime(u.startAt)} → ${fmtTime(u.endAt)} <b>${esc(u.title)}</b>${u.ownerAccount===me?'（你）':''}`).join('<br>'):'今日暂无预约'}</div>
    <div class="foot"><button class="btn pri sm" onclick="openBook('${r.id}')">预约</button>${S.admin?`<button class="btn sm" onclick="openRoomTag('${r.id}')">标签</button><button class="btn ${r.requireApproval?'warn':''} sm" onclick="roomApproval('${r.id}',${!r.requireApproval})">${r.requireApproval?'审批关闭':'审批开启'}</button>`:''}</div></div>`;
}
function openRoomTag(id){
  const r=(S.DB.rooms||[]).find(x=>x.id===id); if(!r) return;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>编辑标签 · ${esc(r.name)}</h2><div class="form">
    <div class="fld"><label>标签（逗号分隔，最多 8 个）</label><input id="mrTags" value="${esc((r.tags||[]).join(','))}"></div>
    <button class="btn pri" onclick="submitRoomTag('${id}')">保存</button></div>`);
}
function submitRoomTag(id){ wsSend({type:'roomTag',roomId:id,tags:$('#mrTags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)}); closeModal(); }
function openRoomCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>新增会议室</h2><div class="form">
  <div class="fld"><label>名称</label><input id="mrName" placeholder="如：3F 大会议室"></div>
  <div class="fld"><label>容纳人数</label><input id="mrCap" type="number" min="1" value="8"></div>
  <div class="fld"><label>最短预约时长（分钟）</label><input id="mrMin" type="number" min="1" value="5"></div>
  <div class="fld"><label>最长预约时长（分钟）</label><input id="mrMax" type="number" min="1" value="720"></div>
  <div class="fld"><label>位置</label><input id="mrLoc" placeholder="如：三层东侧"></div>
  <div class="fld"><label>备注</label><input id="mrDesc" placeholder="可选"></div>
  <div class="fld"><label>标签（逗号分隔，最多 8 个）</label><input id="mrTags" placeholder="投影, 白板, 会议"></div>
  <button class="btn pri" onclick="submitRoomCreate()">创建</button></div>`); }
function submitRoomCreate(){ wsSend({type:'roomCreate',name:$('#mrName').value,capacity:parseInt($('#mrCap').value,10),minMinutes:parseInt($('#mrMin').value,10),maxMinutes:parseInt($('#mrMax').value,10),location:$('#mrLoc').value,description:$('#mrDesc').value,tags:$('#mrTags')?$('#mrTags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean):[]}); closeModal(); }
function removeRoom(id){ if(confirm('确认删除该会议室？')) wsSend({type:'roomRemove',roomId:id}); }
function toggleFavorite(id){ wsSend({type:'roomFavorite',roomId:id}); }
function setRoomFavFilter(v){ S.favFilter=v; render(); }
function openBook(roomId){
  const now=Date.now(), start=now+10*60000, end=start+60*60000;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>预约会议室</h2><div class="form">
    <div class="fld"><label>会议标题</label><input id="bkTitle" value="会议"></div>
    <div class="fld"><label>参会人数</label><input id="bkPart" type="number" min="1" value="1"></div>
    <div class="fld"><label>参会人账号（逗号分隔，可选）</label><input id="bkAttend" placeholder="如：zhangsan, lisi"></div>
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
  const attendees=$('#bkAttend').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean);
  S.lastRoomBook={roomId,startAt:st,endAt:en,title:$('#bkTitle').value,note:$('#bkNote').value,participants,attendees};
  wsSend({type:'roomBook',roomId,startAt:st,endAt:en,title:$('#bkTitle').value,note:$('#bkNote').value,participants,attendees,repeat,repeatCount:count});
  closeModal();
}
function cancelReservation(id){ wsSend({type:'reservationCancel',reservationId:id}); }
function cancelSeries(seriesId){ if(confirm('确认取消该周期预约的全部待开始场次？')) wsSend({type:'reservationCancelSeries',seriesId}); }
function meetingAttend(id){ wsSend({type:'meetingAttend',reservationId:id}); toast('✅ 已确认到场','success'); }
function roomApproval(id, v){ wsSend({type:'roomApproval',roomId:id,requireApproval:!!v}); }
function reservationApprove(id){ wsSend({type:'reservationApprove',reservationId:id}); }
function reservationReject(id){ wsSend({type:'reservationReject',reservationId:id}); }
/* 会议室改期：待开始的预约可调整时段（冲突自动检测） */
function openReschedule(id){
  const r=(S.DB.reservations||[]).find(x=>x.id===id); if(!r) return;
  const room=(S.DB.rooms||[]).find(x=>x.id===r.roomId);
  const d=(ms)=>{ const x=new Date(ms), off=x.getTimezoneOffset(); return new Date(ms-off).toISOString().slice(0,16); };
  S.lastReschedule={id};
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>改期 · ${esc(room?room.name:'会议室')}</h2><div class="form">
    <div class="fld"><label>会议标题</label><input id="rsTitle" value="${esc(r.title||'')}" disabled></div>
    <div class="fld"><label>开始时间</label><input id="rsStart" type="datetime-local"></div>
    <div class="fld"><label>结束时间</label><input id="rsEnd" type="datetime-local"></div>
    <button class="btn pri" onclick="submitReschedule()">确认改期</button>
    <div class="hint">改期时段需在开始时间之后，且与该会议室现有预约不冲突</div></div>`);
  const start=Date.now()+10*60000, end=start+60*60000;
  $('#rsStart').value=d(start); $('#rsEnd').value=d(end);
}
function submitReschedule(){
  const a=S.lastReschedule||{};
  const st=new Date($('#rsStart').value).getTime(), en=new Date($('#rsEnd').value).getTime();
  if(!(st>0)||!(en>st)) return toast('时间无效','error');
  wsSend({type:'reservationReschedule',reservationId:a.id,startAt:st,endAt:en});
  closeModal();
}
/* 会议室评分：结束的会议可给会议室打 1-5 分并留一句评价 */
function openRoomRate(id){
  const r=(S.DB.reservations||[]).find(x=>x.id===id); if(!r) return;
  const rm=(S.DB.rooms||[]).find(x=>x.id===r.roomId);
  S.lastRateId=id;
  S._rateScores={environment:3,equipment:3,service:3};
  const dimRows=[['environment','环境'],['equipment','设备'],['service','服务']].map(([k,label])=>`<div class="fld"><label>${label} <span class="dim-val" style="color:var(--muted)">3 分</span></label>${[1,2,3,4,5].map(n=>`<button class="btn ${n===3?'pri':''}" data-dim="${k}" data-val="${n}" onclick="rateClick(this,'${k}')">${'⭐'.repeat(n)}</button>`).join('')}</div>`).join('');
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>会议室评分 · ${esc(rm?rm.name:'会议室')}</h2><div class="form">
    ${dimRows}
    <div class="fld"><label>评价（可选，最多 60 字）</label><input id="rtComment" placeholder="如：隔音一般，投影清晰"></div>
    <button class="btn pri" onclick="submitRoomRate()">提交评分</button></div>`);
}
function rateClick(btn, dim){
  const n=parseInt(btn.dataset.val,10);
  S._rateScores[dim]=n;
  const row=btn.closest('.fld');
  row.querySelectorAll('button').forEach(b=>b.classList.toggle('pri', parseInt(b.dataset.val,10)===n));
  const val=row.querySelector('.dim-val'); if(val) val.textContent=n+' 分';
}
function submitRoomRate(){ wsSend({type:'roomRate',reservationId:S.lastRateId,scores:S._rateScores||{environment:3,equipment:3,service:3},comment:$('#rtComment').value||''}); closeModal(); }
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
  const wl=(d.toolWaitlist||[]).filter(w=>w.status==='waiting');
  const wlByTool={}; wl.forEach(w=>{ (wlByTool[w.toolId]=wlByTool[w.toolId]||[]).push(w); });
  $('#main').innerHTML = `<div class="topbar"><div><h1>工具借用</h1><div class="sub">测试电脑 / 测试机器 / 测试手机等在库设备的借还</div></div>
    ${S.admin?'<button class="btn pri" onclick="openToolCreate()">＋ 新增设备</button>':''}
    ${overdueCount?`<button class="btn danger" onclick="remindOverdue()">⏰ 批量催还 ${overdueCount} 人</button>`:''}
    <button class="btn" onclick="exportModuleCsv('borrows',BW_COLS)">导出 CSV</button></div>
    <div class="cards">${d.tools.map(t=>`<div class="card"><h3>${esc(t.name)} <span class="badge ${t.available>0?'ok':'bad'}">${t.available}/${t.total}</span></h3>
      <div class="meta">${t.category}${t.location?' · '+esc(t.location):''}${t.minAvailable&&t.minAvailable>1?' · 阈值 '+t.minAvailable:''}${wlByTool[t.id]&&wlByTool[t.id].length?` · 排队 ${wlByTool[t.id].length} 人`:''}${wlByTool[t.id]&&wlByTool[t.id].find(w=>w.account===me)?' · 你已排队':''}</div>
      <div class="meta">${t.lowStock?'<span class="badge bad">库存告急</span>':''}</div>
      <div class="bar"><i style="width:${t.total?Math.round(t.available/t.total*100):0}%"></i></div>
      <div class="foot fs">
        ${t.available>0?`<button class="btn pri sm" onclick="openBorrow('${t.id}','${esc(t.name)}',${t.available})">借用</button>`:`<button class="btn sm" onclick="openToolWaitlist('${t.id}','${esc(t.name)}',${t.total})">加入排队</button>`}
        ${S.admin?`<button class="btn danger sm" onclick="removeTool('${t.id}')">删</button><button class="btn sm" onclick="openAdjust('${t.id}','${esc(t.name)}',${t.total},${t.borrowedCount},${t.minAvailable||1})">改库存</button>`:''}
      </div>
      ${t.activeBorrows&&t.activeBorrows.length?`<div class="meta">在借：${t.activeBorrows.map(b=>{ const can=b.borrowerAccount===me||S.admin; return `${esc(b.borrowerName)}×${b.qty}${b.dueAt?' · 应还 '+fmtTime(b.dueAt):''}${b.days>=0?' · '+b.days+'天':''}${b.overdue?'<span class="badge bad">逾期</span>':''}${b.reminded?'<span class="badge grey">已提醒</span>':''}${b.dueSoon?'<span class="badge warn">即将到期</span>':''}${b.borrowerAccount===me?` <button class="btn green sm" onclick="openReturn('${b.id}')">归还</button>`:''}${can?(b.extensions>=2?'<span class="hint">续借已用完</span>':`<button class="btn sm" onclick="openExtend('${b.id}','${esc(b.borrowerName)}')">续借 (${2-(b.extensions||0)}次)</button>`):''}${b.borrowerAccount!==me&&b.overdue?` <button class="btn danger sm" onclick="remindReturn('${b.id}')">提醒</button>`:''}`; }).join('，')}</div>`:''}
    </div>`).join('')||'<div class="empty">还没有设备，管理员可新增</div>'}
    </div>`;
}
function openToolCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>新增设备</h2><div class="form">
  <div class="fld"><label>名称</label><input id="tlName" placeholder="如：测试手机 Pro"></div>
  <div class="fld"><label>类别</label><select id="tlCat"><option>测试电脑</option><option>测试机器</option><option>测试手机</option><option>其它</option></select></div>
  <div class="fld"><label>库存数量</label><input id="tlTotal" type="number" min="1" value="1"></div>
  <div class="fld"><label>库存告急阈值（0-库存）</label><input id="tlMin" type="number" min="0" value="1"></div>
  <div class="fld"><label>位置</label><input id="tlLoc" placeholder="可选"></div>
  <div class="fld"><label>备注</label><input id="tlDesc" placeholder="可选"></div>
  <button class="btn pri" onclick="submitToolCreate()">创建</button></div>`); }
function submitToolCreate(){ wsSend({type:'toolCreate',name:$('#tlName').value,category:$('#tlCat').value,total:parseInt($('#tlTotal').value,10),minAvailable:parseInt($('#tlMin').value,10),location:$('#tlLoc').value,description:$('#tlDesc').value}); closeModal(); }
function removeTool(id){ if(confirm('删除该设备？')) wsSend({type:'toolDelete',toolId:id}); }
function openAdjust(id,name,total,borrowed,min){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>调整库存 · ${esc(name)}</h2><div class="form">
  <div class="fld"><label>在借 ${borrowed} · 当前总库存 ${total}</label><input id="adTotal" type="number" min="1" value="${total}"></div>
  <div class="fld"><label>库存告急阈值（0-库存）</label><input id="adMin" type="number" min="0" value="${min||1}"></div>
  <button class="btn pri" onclick="submitAdjust('${id}')">保存</button></div>`); }
function submitAdjust(id){ wsSend({type:'toolAdjust',toolId:id,total:parseInt($('#adTotal').value,10),minAvailable:parseInt($('#adMin').value,10)}); closeModal(); }
function openBorrow(id,name,avail){
  const d=(ms)=>{ const x=new Date(ms), off=x.getTimezoneOffset(); return new Date(ms-off).toISOString().slice(0,16); };
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>借用 · ${esc(name)}</h2><div class="form">
   <div class="fld"><label>数量（可用 ${avail}）</label><input id="bwQty" type="number" min="1" max="${avail}" value="1"></div>
   <div class="fld"><label>自定义归还时间（可选，默认 7 天）</label><input id="bwDue" type="datetime-local"></div>
   <div class="hint">默认借出后 7 天归还，可续借最多 2 次</div>
   <button class="btn pri" onclick="submitBorrow('${id}')">借用</button></div>`);
  $('#bwDue').value=d(Date.now()+7*86400000);
}
function submitBorrow(id){
  const qty=parseInt($('#bwQty').value,10);
  let dueAt=0;
  const v=$('#bwDue').value;
  if(v){ const t=new Date(v).getTime(); if(t>0) dueAt=t; }
  wsSend({type:'toolBorrow',toolId:id,qty,dueAt:dueAt||0});
  closeModal();
}
function openToolWaitlist(id,name,total){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>加入排队 · ${esc(name)}</h2><div class="form">
  <div class="fld"><label>数量（库存 ${total}，当前无可用）</label><input id="wlQty" type="number" min="1" max="${total}" value="1"></div>
  <div class="hint">轮到你时会自动借用，并在归还后优先分配给你</div>
  <button class="btn pri" onclick="submitToolWaitlist('${id}')">加入排队</button></div>`); }
function submitToolWaitlist(id){ wsSend({type:'toolWaitlist',toolId:id,qty:parseInt($('#wlQty').value,10)}); closeModal(); }
/* 归还登记：选择归还状态（完好/损坏/丢失），丢失不恢复可用库存 */
function openReturn(id){
  const b=(S.DB.borrows||[]).find(x=>x.id===id);
  if(!b){ wsSend({type:'toolReturn',borrowId:id}); return; }
  S.lastReturnId=id;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>归还设备 · ${esc(b.toolName||'设备')}</h2><div class="form">
    <div class="fld"><label>归还状态</label><select id="rtCond"><option value="intact">完好</option><option value="damaged">损坏</option><option value="missing">丢失</option></select></div>
    <div class="hint">「丢失」不会恢复库存总数；「损坏」仍计入归还但记录状态</div>
    <button class="btn pri" onclick="submitReturn()">确认归还</button></div>`);
}
function submitReturn(){ wsSend({type:'toolReturn',borrowId:S.lastReturnId,condition:$('#rtCond').value}); closeModal(); }
function openExtend(id,name){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>续借 · ${esc(name)}</h2><div class="form">
  <div class="fld"><label>续借天数（1-30）</label><input id="exDays" type="number" min="1" max="30" value="7"></div>
  <button class="btn pri" onclick="submitExtend('${id}')">确认续借</button></div>`); }
function submitExtend(id){ wsSend({type:'toolExtend',borrowId:id,days:parseInt($('#exDays').value,10)||7}); closeModal(); }

/* ============ 物资申领 ============ */
function renderMaterials(){
  const d=S.DB, me=S.me.account;
  const tplList=(S.DB.materialTemplates||[]).map(t=>`<div class="row"><span><span class="who">📋 ${esc(t.name)}</span> <span class="when">默认 ×${t.defaultQty}${t.defaultUnit?' '+esc(t.defaultUnit):''}</span><div class="desc">${esc(t.defaultReason||'')}</div></span>${S.admin?`<button class="btn danger sm" onclick="deleteTemplate('${t.id}')">删除</button>`:''}</div>`).join('');
  $('#main').innerHTML = `<div class="topbar"><div><h1>物资申领</h1><div class="sub">需要电池、文具等物资时提交申请，由同事/管理员处理</div></div>
    <button class="btn pri" onclick="openMaterialRequest()">＋ 我要申领</button><button class="btn" onclick="exportModuleCsv('materials',MAT_COLS)">导出 CSV</button>${S.admin?'<button class="btn" onclick="openTemplateCreate()">＋ 常用模板</button>':''}</div>
    ${S.admin?`<h3 style="margin:14px 0 8px">📋 常用物资模板</h3><div class="list">${tplList||'<div class="empty">暂无模板</div>'}</div>`:''}
    <div class="list">${d.requests.map(r=>{ const st=r.status; const badge=st==='pending'?'warn':st==='fulfilled'?'ok':'grey'; const canAssign=r.requesterAccount===me||S.admin; const canFulfill=st==='pending'&&!(r.handlerAccount&&r.handlerAccount!==me&&!S.admin); const handled=r.handledAt?` · 处理 ${Math.max(0,Math.round((r.handledAt-r.createdAt)/60000))} 分钟`:''; return `<div class="row"><span><span class="who">${esc(r.requesterName)}</span> 申领 <b>${esc(r.name)}</b> ×${r.qty}${r.unit?' '+esc(r.unit):''}${r.handlerName?` · 负责人 ${esc(r.handlerName)}`:''}<div class="desc">${esc(r.reason||'')}</div><div class="when">${fmtTime(r.createdAt)}${handled}</div></span>
      <span class="fs"><span class="badge ${badge}">${st==='pending'?'待处理':st==='fulfilled'?'已满足':'已取消'}</span><span class="badge ${r.priority==='high'?'danger':r.priority==='low'?'grey':''}">${r.priority==='high'?'高':r.priority==='low'?'低':'普通'}</span>
      ${st==='pending'?`${r.requesterAccount===me?`<button class="btn danger sm" onclick="cancelRequest('${r.id}')">取消</button>`:(canFulfill?`<button class="btn green sm" onclick="fulfillRequest('${r.id}')">已满足</button>`:'')}${canAssign?`<button class="btn sm" onclick="openAssign('material','${r.id}')">指派</button><button class="btn sm" onclick="updateMaterialPriority('${r.id}','${r.priority}')">改优先级</button>`:''}`:''}
      </span></div>`; }).join('')||'<div class="empty">暂无申领记录</div>'}
    </div>
    ${(S.DB.matOffset||0)<(S.DB.matTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('materials')">加载更多（${S.DB.matTotal-(S.DB.matOffset||0)}）</button></div>`:''}`;
}
function openMaterialRequest(){
  const tpls=(S.DB.materialTemplates||[]).map(t=>`<option value="${t.id}">${esc(t.name)} · ×${t.defaultQty}${t.defaultUnit?' '+esc(t.defaultUnit):''}</option>`).join('');
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>物资申领</h2><div class="form">
  <div class="fld"><label>常用模板（可选）</label><select id="mtTpl" onchange="applyTemplate(this.value)"><option value="">不用模板</option>${tpls}</select></div>
  <div class="fld"><label>物资名称</label><input id="mtName" placeholder="如：5号电池"></div>
  <div class="fld"><label>数量</label><div class="fs"><input id="mtQty" type="number" min="1" value="1" style="width:100px"><input id="mtUnit" placeholder="单位（个/节/盒）" style="flex:1"></div></div>
  <div class="fld"><label>说明</label><input id="mtReason" placeholder="为什么需要"></div>
  <div class="fld"><label>优先级</label><select id="mtPri"><option value="normal">普通</option><option value="high">高</option><option value="low">低</option></select></div>
  <button class="btn pri" onclick="submitMaterial()">提交</button></div>`);
}
function applyTemplate(id){
  const t=(S.DB.materialTemplates||[]).find(x=>x.id===id); if(!t) return;
  $('#mtName').value=t.name; $('#mtQty').value=t.defaultQty; $('#mtUnit').value=t.defaultUnit||''; $('#mtReason').value=t.defaultReason||'';
}
function submitMaterial(){ wsSend({type:'materialRequest',templateId:$('#mtTpl').value,name:$('#mtName').value,qty:parseInt($('#mtQty').value,10),unit:$('#mtUnit').value,reason:$('#mtReason').value,priority:$('#mtPri').value}); closeModal(); }
function openTemplateCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>新增常用物资模板</h2><div class="form">
  <div class="fld"><label>模板名称</label><input id="tplName" placeholder="如：5号电池"></div>
  <div class="fld"><label>默认数量</label><div class="fs"><input id="tplQty" type="number" min="1" value="1" style="width:100px"><input id="tplUnit" placeholder="单位" style="flex:1"></div></div>
  <div class="fld"><label>默认说明</label><input id="tplReason" placeholder="如：遥控器/鼠标备用"></div>
  <button class="btn pri" onclick="submitTemplate()">保存模板</button></div>`); }
function submitTemplate(){ wsSend({type:'materialTemplateCreate',name:$('#tplName').value,defaultQty:parseInt($('#tplQty').value,10),defaultUnit:$('#tplUnit').value,defaultReason:$('#tplReason').value}); closeModal(); }
function deleteTemplate(id){ if(confirm('确认删除该常用模板？')) wsSend({type:'materialTemplateDelete',templateId:id}); }
function cancelRequest(id){ wsSend({type:'materialCancel',requestId:id}); }
function fulfillRequest(id){ wsSend({type:'materialFulfill',requestId:id}); }
function updateMaterialPriority(id, current){
  const opts=[['high','高'],['normal','普通'],['low','低']].map(([v,l])=>`<option value="${v}" ${v===current?'selected':''}>${l}</option>`).join('');
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>调整优先级</h2><div class="form">
    <div class="fld"><label>优先级</label><select id="mtPri2">${opts}</select></div>
    <button class="btn pri" onclick="submitMaterialPriority('${id}')">保存</button></div>`);
}
function submitMaterialPriority(id){ wsSend({type:'materialUpdate',requestId:id,priority:$('#mtPri2').value}); closeModal(); }

/* ============ 物资库存台账 ============ */
function renderInventory(){
  const me=S.me.account;
  const items=(S.DB.inventory&&S.DB.inventory.items)||[];
  $('#main').innerHTML = `<div class="topbar"><div><h1>物资库存</h1><div class="sub">登记办公文具、耗材等公共物资库存，成员按需领用并归还</div></div>
    ${S.admin?'<button class="btn pri" onclick="openInventoryCreate()">＋ 新增物资</button>':''}</div>
    <div class="cards">${items.map(it=>{ const overdue=(it.activeIssues||[]).filter(r=>r.overdue).length; return `<div class="card"><h3>${esc(it.name)} <span class="badge ${it.available>0?'ok':'bad'}">${it.available}/${it.total}${it.unit?' '+esc(it.unit):''}</span></h3>
      <div class="meta">${esc(it.category)}${it.location?' · '+esc(it.location):''}${it.minAvailable&&it.minAvailable>1?' · 阈值 '+it.minAvailable:''}${it.borrowedCount?' · 在领 '+it.borrowedCount:''}${overdue?' · <span class="badge bad">逾期</span>':''}</div>
      <div class="meta">${it.lowStock?'<span class="badge bad">库存告急</span>':''}</div>
      <div class="bar"><i style="width:${it.total?Math.round(it.available/it.total*100):0}%"></i></div>
      <div class="foot fs">
        ${it.available>0?`<button class="btn pri sm" onclick="openInventoryIssue('${it.id}','${esc(it.name)}',${it.available})">领用</button>`:'<span class="hint">库存已用尽</span>'}
        ${S.admin?`<button class="btn danger sm" onclick="removeInventory('${it.id}')">删</button><button class="btn sm" onclick="openInventoryAdjust('${it.id}','${esc(it.name)}',${it.total},${it.available},${it.minAvailable||1})">改库存</button>`:''}
      </div>
      ${(it.activeIssues||[]).length?`<div class="meta">在领：${it.activeIssues.map(r=>{ const can=r.issuerAccount===me||S.admin; return `${esc(r.issuerName)}×${r.qty}${r.dueAt?' · 应还 '+fmtTime(r.dueAt):''}${r.days>=0?' · '+r.days+'天':''}${r.overdue?'<span class="badge bad">逾期</span>':''}${can?` <button class="btn green sm" onclick="returnInventory('${r.id}')">归还</button>`:''}`; }).join('，')}</div>`:''}
    </div>`; }).join('')||'<div class="empty">暂无库存物资，管理员可新增</div>'}
    </div>`;
}
function openInventoryCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>新增物资</h2><div class="form">
  <div class="fld"><label>名称</label><input id="ivName" placeholder="如：5号电池"></div>
  <div class="fld"><label>类别</label><select id="ivCat"><option>办公文具</option><option>打印耗材</option><option>电池</option><option>清洁用品</option><option>食品饮料</option><option>其它</option></select></div>
  <div class="fld"><label>单位</label><input id="ivUnit" placeholder="个 / 节 / 盒"></div>
  <div class="fld"><label>库存数量</label><input id="ivTotal" type="number" min="1" value="10"></div>
  <div class="fld"><label>库存告急阈值（0-库存）</label><input id="ivMin" type="number" min="0" value="2"></div>
  <div class="fld"><label>位置</label><input id="ivLoc" placeholder="可选"></div>
  <div class="fld"><label>备注</label><input id="ivDesc" placeholder="可选"></div>
  <button class="btn pri" onclick="submitInventoryCreate()">创建</button></div>`); }
function submitInventoryCreate(){ wsSend({type:'inventoryCreate',name:$('#ivName').value,category:$('#ivCat').value,unit:$('#ivUnit').value,total:parseInt($('#ivTotal').value,10),minAvailable:parseInt($('#ivMin').value,10),location:$('#ivLoc').value,description:$('#ivDesc').value}); closeModal(); }
function removeInventory(id){ if(confirm('删除该物资？')) wsSend({type:'inventoryDelete',itemId:id}); }
function openInventoryAdjust(id,name,total,available,min){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>调整库存 · ${esc(name)}</h2><div class="form">
  <div class="fld"><label>在领 ${available==null?'':Math.max(0,total-available)} · 当前总库存 ${total}</label><input id="ivAdTotal" type="number" min="1" value="${total}"></div>
  <div class="fld"><label>库存告急阈值（0-库存）</label><input id="ivAdMin" type="number" min="0" value="${min||1}"></div>
  <button class="btn pri" onclick="submitInventoryAdjust('${id}')">保存</button></div>`); }
function submitInventoryAdjust(id){ wsSend({type:'inventoryAdjust',itemId:id,total:parseInt($('#ivAdTotal').value,10),minAvailable:parseInt($('#ivAdMin').value,10)}); closeModal(); }
function openInventoryIssue(id,name,avail){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>领用 · ${esc(name)}</h2><div class="form">
  <div class="fld"><label>可领用 ${avail}</label><input id="ivQty" type="number" min="1" value="1"></div>
  <div class="hint">领用后将扣减库存，默认 3 天内归还，逾期会在在领明细中标记</div>
  <button class="btn pri" onclick="submitInventoryIssue('${id}')">领用</button></div>`); }
function submitInventoryIssue(id){ wsSend({type:'inventoryIssue',itemId:id,qty:parseInt($('#ivQty').value,10)}); closeModal(); }
function returnInventory(issueId){ wsSend({type:'inventoryReturn',issueId}); }

/* ============ 报修 ============ */
function renderRepairs(){
  const d=S.DB, me=S.me.account;
  const badge=s=>s==='reported'?'warn':s==='in_progress'?'info':s==='resolved'?'ok':'grey';
  const label=s=>s==='reported'?'待处理':s==='in_progress'?'处理中':s==='resolved'?'已解决':'已取消';
  const pBadge=p=>p==='high'?'bad':p==='normal'?'info':'grey';
  const pLabel=p=>p==='high'?'高':p==='normal'?'中':'低';
  $('#main').innerHTML = `<div class="topbar"><div><h1>报修</h1><div class="sub">上报厕所、灯光、空调等设施故障并及时跟进</div></div>
    <button class="btn pri" onclick="openRepair()">＋ 我要报修</button><button class="btn" onclick="exportModuleCsv('repairs',REP_COLS)">导出 CSV</button></div>
    ${repairStatsBarHtml()}
    <div class="list">${d.repairs.map(r=>{ const canAssign=r.reporterAccount===me||S.admin; const handled=r.handledAt?` · 处理 ${Math.max(0,Math.round((r.handledAt-r.createdAt)/60000))} 分钟`:''; return `<div class="row"><span><span class="who">${esc(r.category)} · ${esc(r.location)}</span> ${r.code?`<span class="badge ${r.status==='resolved'?'ok':r.status==='cancelled'?'grey':'info'}">${esc(r.code)}</span>`:''} <span class="when">${esc(r.reporterName)} ${fmtTime(r.createdAt)}${r.handlerName?` · 负责人 ${esc(r.handlerName)}`:''}${handled}</span><div class="desc">${esc(r.description)}</div>${repairCommentListHtml(r)}</span>
      <span class="fs">
      <span class="badge ${badge(r.status)}">${label(r.status)}</span>
      <span class="badge ${pBadge(r.priority)}">${pLabel(r.priority)}优先</span>
      ${r.escalated?'<span class="badge bad">已升级</span>':''}
      ${r.satisfaction?`<span class="badge ok">已评 ${r.satisfaction}⭐</span>`:''}
      ${r.commentCount?`<span class="badge ok">💬 ${r.commentCount}</span>`:''}
      ${r.status==='reported'?`<button class="btn sm" onclick="setRepair('${r.id}','in_progress')">开始处理</button>`:''}
      ${(r.status==='reported'||r.status==='in_progress')?`<button class="btn green sm" onclick="setRepair('${r.id}','resolved')">已解决</button>`:''}
      ${r.status==='resolved'&&!r.satisfaction&&(r.reporterAccount===me||S.admin)?`<button class="btn sm" onclick="openRepairRate('${r.id}')">评价</button>`:''}
      ${r.status==='reported'||r.status==='in_progress'?`${r.reporterAccount===me||S.admin?`<button class="btn sm" onclick="openPriority('${r.id}','${esc(r.priority||'normal')}')">改优先级</button>`:''}`:''}
      ${r.status==='reported'?`${canAssign?`<button class="btn sm" onclick="openAssign('repair','${r.id}')">指派</button>`:''}${r.reporterAccount===me?`<button class="btn danger sm" onclick="setRepair('${r.id}','cancelled')">撤销</button>`:''}`:''}
      ${(r.reporterAccount===me||r.handlerAccount===me||S.admin)?`<div style="margin-top:6px"><input placeholder="跟进评论…" maxlength="200" onkeydown="if(event.key==='Enter')repairComment('${r.id}',this.value)"/></div>`:''}
      </span></div>`; }).join('')||'<div class="empty">暂无报修记录</div>'}
    </div>
    ${(S.DB.repOffset||0)<(S.DB.repTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('repairs')">加载更多（${S.DB.repTotal-(S.DB.repOffset||0)}）</button></div>`:''}`;
}
// 报修满意度统计条：平均满意度、低分工单、高频故障位置
function repairStatsBarHtml(){
  const st = S.DB.repairStats || null;
  if (!st) return '';
  const hot = (st.hotspots||[]).map(h => `${esc(h.location)}×${h.count}`).join('、');
  return `<div style="display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin:10px 0;padding:10px 12px;border:1px solid var(--border);border-radius:10px;background:var(--panel)">
    <span class="badge info">共 ${st.total}</span>
    <span class="badge ${st.open?'warn':'ok'}">待处理 ${st.open}</span>
    <span class="badge ok">已解决 ${st.resolved}</span>
    <span class="badge ${st.avgSatisfaction>=4?'ok':st.avgSatisfaction>=3?'info':'bad'}">平均满意度 ${st.avgSatisfaction}⭐（${st.rated}/${st.resolved} 已评 ${st.ratedPct}%）</span>
    ${st.lowSatisfaction?`<span class="badge bad">低分工单 ${st.lowSatisfaction}</span>`:''}
    ${hot?`<span class="badge bad">高频故障 ${hot}</span>`:''}
  </div>`;
}
// 报修工单跟进评论：展示最近评论（倒序）
function repairCommentListHtml(r) {
  const comments = (r.comments || []).slice().reverse();
  if (!comments.length) return '';
  return `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">${comments.map((c) => `<div style="font-size:12px;margin-bottom:4px"><b>${esc(c.name||'')}</b> <span style="color:var(--muted)">${fmtTime(c.createdAt)}</span><br>${esc(c.text||'')}</div>`).join('')}</div>`;
}
function openRepair(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>提交报修</h2><div class="form">
  <div class="fld"><label>类别</label><select id="rpCat"><option>厕所</option><option>灯光</option><option>空调</option><option>其它</option></select></div>
  <div class="fld"><label>优先级</label><select id="rpPri"><option value="normal">中</option><option value="high">高</option><option value="low">低</option></select></div>
  <div class="fld"><label>位置</label><input id="rpLoc" placeholder="如：三层男厕第二个坑位"></div>
  <div class="fld"><label>描述</label><input id="rpDesc" placeholder="故障现象"></div>
  <div class="hint">同一位置的同类故障若仍有未处理报修，将被识别为重复报修并提示先处理旧单</div>
  <button class="btn pri" onclick="submitRepair()">提交</button></div>`); }
function submitRepair(){ wsSend({type:'repairCreate',category:$('#rpCat').value,priority:$('#rpPri').value,location:$('#rpLoc').value,description:$('#rpDesc').value}); closeModal(); }
function setRepair(id,status){ wsSend({type:'repairUpdate',repairId:id,status}); }
function repairComment(id, text){ wsSend({type:'repairComment',repairId:id,text}); }
/* 报修满意度评分：已解决的报修，上报人/管理员可打 1-5 星并留评 */
function openRepairRate(id){
  const r=(S.DB.repairs||[]).find(x=>x.id===id); if(!r) return;
  S.lastRateId=id;
  S._repairRate=5;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>报修满意度 · ${esc(r.location||'')}</h2><div class="form">
    <div class="fld"><label>总体满意度</label>${[1,2,3,4,5].map(n=>`<button class="btn ${n===5?'pri':''}" data-val="${n}" onclick="repairRateClick(this)">${'⭐'.repeat(n)}</button>`).join('')}</div>
    <div class="fld"><label>评价（可选，最多 60 字）</label><input id="rpRateComment" placeholder="如：上门很快，修好了"></div>
    <button class="btn pri" onclick="submitRepairRate('${id}')">提交评价</button></div>`);
}
function repairRateClick(btn){
  const n=parseInt(btn.dataset.val,10);
  S._repairRate=n;
  btn.closest('.fld').querySelectorAll('button').forEach(b=>b.classList.toggle('pri', parseInt(b.dataset.val,10)===n));
}
function submitRepairRate(id){
  const satisfaction=parseInt(S._repairRate||5,10);
  wsSend({type:'repairRate',repairId:id,satisfaction:satisfaction,satisfactionComment:$('#rpRateComment').value||''});
  closeModal();
}
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
  <button class="btn pri" onclick="submitVisitorCreate()">登记</button>
  <div class="hint">同一访客同一天的重复登记会被识别并拒绝</div></div>`); }
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
/* ============ 考勤打卡 ============ */
function myAttendanceRecord(){ const me=S.me?S.me.account:''; return (S.DB.attendance&&S.DB.attendance.records||[]).find(r=>r.account===me)||null; }
function attendBadge(st){ return st==='checked_out'?'<span class="badge ok">已下班</span>':'<span class="badge warn">上班中</span>'; }
function renderAttendance(){
  const d=S.DB.attendance||{records:[],stats:{},config:{}};
  const st=d.stats||{}, cfg=d.config||{};
  const me=S.me.account;
  const mine=myAttendanceRecord();
  const checkedIn = mine ? (mine.status==='checked_out'?'已下班':'上班中') : '未打卡';
  $('#main').innerHTML = `<div class="topbar"><div><h1>考勤打卡</h1><div class="sub">上班/下班打卡 · 规则 ${esc(cfg.workStart||'09:00')}-${esc(cfg.workEnd||'18:00')} · 迟到宽限 ${cfg.lateMinutes||15} 分钟</div></div>
    ${S.admin?`<button class="btn" onclick="openAttendConfig()">⚙️ 考勤规则</button>`:''}</div>
    <div class="cards">
      <div class="card"><h3>🕒 今日打卡</h3><div style="font-size:30px;font-weight:800">${st.checkedIn||0}</div><div class="meta">人已打卡上班</div></div>
      <div class="card"><h3>⏰ 今日迟到</h3><div style="font-size:30px;font-weight:800">${st.late||0}</div><div class="meta">人迟到</div></div>
      <div class="card"><h3>🌙 已下班</h3><div style="font-size:30px;font-weight:800">${st.checkedOut||0}</div><div class="meta">人已打下班卡</div></div>
      <div class="card"><h3>✅ 下班完成率</h3><div style="font-size:30px;font-weight:800">${st.completeRate||0}%</div><div class="meta">打卡 ${st.checkedIn||0} · 迟到率 ${st.lateRate||0}%</div></div>
      <div class="card"><h3>🔥 连续打卡</h3><div style="font-size:30px;font-weight:800">${(S.me.stats&&S.me.stats.attendanceStreak)||0}</div><div class="meta">天 · 全勤月 ${(S.me.stats&&S.me.stats.attendancePerfectMonths)||0}</div></div>
    </div>
    <h3 style="margin:22px 0 10px">🔖 我的打卡</h3>
    <div class="list">${mine?`<div class="row"><span><span class="who">${esc(mine.name||me)}</span> ${attendBadge(mine.status)}
        <div class="when">上班 ${mine.checkInAt?fmtTime(mine.checkInAt):'--'}${mine.isLate?' <span class="badge bad">迟到</span>':''}
        ${mine.checkOutAt?' · 下班 '+fmtTime(mine.checkOutAt)+'（工作 '+Math.round((mine.workedMinutes||0)/60)+'h'+((mine.workedMinutes||0)%60?(mine.workedMinutes%60)+'m':'')+'）':''}</div>
      </span><span class="fs">${mine.checkOutAt?'<span class="hint">今日已完成打卡</span>':`<button class="btn pri sm" onclick="attendCheckOut()">打下班卡</button>`}</span></div>`
      :`<div class="row"><span><span class="who">${esc(S.me.nickname||me)}</span> <span class="badge grey">未打卡</span></span>
        <span class="fs"><button class="btn pri sm" onclick="attendCheckIn()">打上班卡</button></span></div>`}</div>
    <h3 style="margin:22px 0 10px">📋 今日记录</h3>
    <div class="list">${(d.records||[]).length?d.records.map(r=>`<div class="row"><span><span class="who">${esc(r.name||r.account)}</span> ${attendBadge(r.status)}
        <div class="when">上班 ${r.checkInAt?fmtTime(r.checkInAt):'--'}${r.isLate?' <span class="badge bad">迟到</span>':''}
        ${r.checkOutAt?' · 下班 '+fmtTime(r.checkOutAt)+'（工作 '+Math.round((r.workedMinutes||0)/60)+'h'+((r.workedMinutes||0)%60?(r.workedMinutes%60)+'m':'')+'）':''}</div>
      </span></div>`).join(''):'<div class="empty">今日还没有人打卡</div>'}</div>
     <h3 style="margin:22px 0 10px">🗓️ 出勤日历</h3>
     ${attendanceCalendarHtml()}
   </div>`;
}
function attendCheckIn(){ wsSend({type:'attendCheckIn'}); }
function attendCheckOut(){ wsSend({type:'attendCheckOut'}); }
function attendanceCalendarHtml(){
  const c=S.attendanceCalendar;
  if(!c) return `<div class="card"><div class="empty">加载出勤日历…</div></div>`;
  const cells = c.cells.map(cell=>{
    if(!cell) return `<div class="calcell empty"></div>`;
    const cls = cell.isLate?'late':(cell.checkedIn?'ok':'');
    return `<div class="calcell ${cls}" title="${cell.date} ${cell.checkedIn?('上班打卡'+(cell.isLate?' 迟到':'')):'未打卡'}">${cell.date.slice(8)}</div>`;
  }).join('');
  return `<div class="fs" style="margin-bottom:8px"><button class="btn sm" onclick="loadAttendanceCalendar(${c.year}, ${c.month-1})">← 上月</button><b style="margin:0 8px">${c.year}年 ${c.month}月</b><button class="btn sm" onclick="loadAttendanceCalendar(${c.year}, ${c.month+1})">下月 →</button><span class="hint" style="margin-left:8px">🔥 连续 ${c.streak} 天 · 全勤月 ${c.perfectMonthCount} · 本月 ${c.currentMonthPerfect?'✅ 全勤':'有迟到'}</span></div>
    <div class="calgrid">${cells}</div>`;
}
function loadAttendanceCalendar(year, month){ wsSend({type:'getAttendanceCalendar',year,month}); }
function openAttendConfig(){
  const c=S.DB.attendance&&S.DB.attendance.config||{};
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>考勤规则</h2><div class="form">
    <div class="fld"><label>上班时间（HH:MM）</label><input id="acStart" value="${esc(c.workStart||'09:00')}"></div>
    <div class="fld"><label>下班时间（HH:MM）</label><input id="acEnd" value="${esc(c.workEnd||'18:00')}"></div>
    <div class="fld"><label>迟到宽限（分钟）</label><input id="acLate" type="number" min="0" max="600" value="${c.lateMinutes||15}"></div>
    <button class="btn pri" onclick="submitAttendConfig()">保存规则</button></div>`);
}
function submitAttendConfig(){ wsSend({type:'attendConfig',workStart:$('#acStart').value,workEnd:$('#acEnd').value,lateMinutes:parseInt($('#acLate').value,10)}); closeModal(); }

/* ============ 工位预约 ============ */
function deskBadge(st){ return st==='pending'?'<span class="badge warn">已预约</span>':st==='completed'?'<span class="badge ok">已完成</span>':'<span class="badge grey">'+st+'</span>'; }
function deskHeatHtml(d){
  const desks = d.desks||[];
  const now = Date.now();
  const today = new Date(); today.setHours(0,0,0,0); const dStart=today.getTime(); const dEnd=dStart+86400000;
  if(!desks.length) return '';
  const startH = 9, endH = 21; const hours = endH - startH;
  const cols = `repeat(${hours}, 1fr)`;
  const labels = Array.from({length:hours}, (_,i)=>`${pad(startH+i)}:00`);
  const cellFor = (hourIdx, desk) => {
    const cellStart = dStart + hourIdx*3600000; const cellEnd = cellStart + 3600000;
    const res = (d.reservations||[]).find(r=>r.deskId===desk.id && r.status!=='cancelled' && r.status!=='expired' && r.startAt < cellEnd && r.endAt > cellStart);
    if(!res) return '';
    if(res.account===S.me.account) return 'background:#8b5cf6;';
    if(res.status==='pending') return 'background:#f59e0b;';
    if(res.status==='active') return 'background:#3b82f6;';
    return 'background:#10b981;';
  };
  return `<h3 style="margin:22px 0 10px">🔥 工位热力（今日 9:00-21:00）</h3>
    <div style="overflow:auto"><div style="min-width:720px;display:grid;grid-template-columns:110px ${cols};gap:4px;align-items:center">
      <div style="font-size:12px;color:var(--muted)"></div>${labels.map(l=>`<div style="font-size:12px;color:var(--muted);text-align:center">${l}</div>`).join('')}
      ${desks.map(k=>`<div style="font-size:12px;font-weight:700">${esc(k.name)}</div>${Array.from({length:hours},(_,i)=>`<div style="height:22px;border-radius:4px;${cellFor(i,k)}"></div>`).join('')}`).join('')}
    </div></div>`;
}
function renderDesks(){
  const d=S.DB.desks||{desks:[],reservations:[]};
  const me=S.me.account, now=Date.now();
  $('#main').innerHTML = `<div class="topbar"><div><h1>工位预约</h1><div class="sub">开放工位 / 共享座位的时段预约，实时占用</div></div>
    ${S.admin?'<button class="btn pri" onclick="openDeskCreate()">＋ 新增工位</button>':''}</div>
    <div class="cards">${(d.desks||[]).map(k=>{
      const mine=(d.reservations||[]).filter(r=>r.deskId===k.id&&(r.account===me));
      const upcoming=mine.filter(r=>r.status==='pending'&&r.startAt>=now);
      return `<div class="card"><h3>🪑 ${esc(k.name)} ${k.location?'· '+esc(k.location):''}</h3>
        <div class="meta">今日 ${k.todayCount} 场 · 待开始 ${k.upcomingCount} · 时长 ${Math.round(k.todayMinutes/60)}h${k.todayMinutes%60?''+k.todayMinutes%60+'m':''}</div>
        <div class="foot fs">${mine.some(r=>r.status==='pending')?'<span class="badge ok">你已预约</span>':`<button class="btn pri sm" onclick="openDeskReserve('${k.id}','${esc(k.name)}')">预约</button>`}</div></div>`;
    }).join('')||'<div class="empty">还没有工位，管理员可新增</div>'}</div>
    ${deskHeatHtml(d)}
    <h3 style="margin:22px 0 10px">📅 全部预约</h3>
    <div class="list">${(d.reservations||[]).map(r=>{
      const desk=(d.desks||[]).find(k=>k.id===r.deskId);
      const mine=r.account===me;
      return `<div class="row"><span><span class="who">🪑 ${esc(desk?desk.name:'工位')}</span> · ${esc(r.name)} <span class="when">${fmtTime(r.startAt)} → ${fmtTime(r.endAt)}</span><div class="desc">${esc(r.note||'')}</div></span>
        <span class="fs">${deskBadge(r.status)}${mine&&r.status==='pending'?`<button class="btn pri sm" onclick="deskStart('${r.id}')">签到</button><button class="btn danger sm" onclick="cancelDesk('${r.id}')">取消</button>`:''}${mine&&r.status==='active'?`<button class="btn green sm" onclick="deskEnd('${r.id}')">签退</button>`:''}</span></div>`;
    }).join('')||'<div class="empty">暂无工位预约</div>'}</div>`;
}
function openDeskCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>新增工位</h2><div class="form">
  <div class="fld"><label>名称</label><input id="dkName" placeholder="如：3F 工位 A"></div>
  <div class="fld"><label>位置</label><input id="dkLoc" placeholder="可选"></div>
  <div class="fld"><label>备注</label><input id="dkDesc" placeholder="可选"></div>
  <button class="btn pri" onclick="submitDeskCreate()">创建</button></div>`); }
function submitDeskCreate(){ wsSend({type:'deskCreate',name:$('#dkName').value,location:$('#dkLoc').value,description:$('#dkDesc').value}); closeModal(); }
function openDeskReserve(id,name){
  const d=(ms)=>{ const x=new Date(ms), off=x.getTimezoneOffset(); return new Date(ms-off).toISOString().slice(0,16); };
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>预约工位 · ${esc(name)}</h2><div class="form">
    <div class="fld"><label>开始时间</label><input id="dkStart" type="datetime-local"></div>
    <div class="fld"><label>结束时间</label><input id="dkEnd" type="datetime-local"></div>
    <div class="fld"><label>备注（可选）</label><input id="dkNote" placeholder="如：专注写方案"></div>
    <button class="btn pri" onclick="submitDeskReserve('${id}')">提交预约</button>
    <div class="hint">同一工位时段不可重叠；到点后自动流转为已完成</div></div>`);
  const start=Date.now()+10*60000, end=start+60*60000;
  $('#dkStart').value=d(start); $('#dkEnd').value=d(end);
}
function submitDeskReserve(id){
  const st=new Date($('#dkStart').value).getTime(), en=new Date($('#dkEnd').value).getTime();
  if(!(st>0)||!(en>st)) return toast('时间无效','error');
  wsSend({type:'deskReserve',deskId:id,startAt:st,endAt:en,note:$('#dkNote').value||''});
  closeModal();
}
function cancelDesk(id){ wsSend({type:'deskCancel',reservationId:id}); }
function deskStart(id){ wsSend({type:'deskStart',reservationId:id}); }
function deskEnd(id){ wsSend({type:'deskEnd',reservationId:id}); }
function removeDesk(id){ if(confirm('删除该工位？')) wsSend({type:'deskDelete',deskId:id}); }

/* ============ 外出登记 ============ */
function renderOoo(){
  const d=S.DB.ooo||{records:[],stats:{}};
  const me=S.me.account;
  const st=d.stats||{};
  $('#main').innerHTML = `<div class="topbar"><div><h1>外出登记</h1><div class="sub">登记外出 / 请假 / 出差 / 调休，同事可看到你的状态与预计返回时间</div></div>
    <button class="btn pri" onclick="openOooCreate()">＋ 登记外出</button></div>
    <div class="cards">
      <div class="card"><h3>🧳 外出中</h3><div style="font-size:30px;font-weight:800">${st.activeCount||0}</div><div class="meta">人当前外出 / 请假</div></div>
      <div class="card"><h3>📅 今日登记</h3><div style="font-size:30px;font-weight:800">${st.todayCount||0}</div><div class="meta">人次</div></div>
      <div class="card"><h3>🏷️ 请假</h3><div style="font-size:30px;font-weight:800">${st.onLeaveCount||0}</div><div class="meta">人</div></div>
      <div class="card"><h3>✈️ 出差</h3><div style="font-size:30px;font-weight:800">${st.onTripCount||0}</div><div class="meta">人</div></div>
    </div>
    <h3 style="margin:22px 0 10px">📋 当前外出</h3>
    <div class="list">${(d.records||[]).length?d.records.map(r=>{
      const mine=r.account===me;
      return `<div class="row"><span><span class="who">${esc(r.name||r.account)}</span> <span class="badge warn">${esc(r.category)}</span>
        <div class="desc">${esc(r.reason||'')}</div>
        <div class="when">${fmtTime(r.startAt)}${r.expectedReturnAt?' · 预计返回 '+fmtTime(r.expectedReturnAt):''}</div>
      </span><span class="fs">${mine?`<button class="btn green sm" onclick="ooBack('${r.id}')">已返回</button><button class="btn danger sm" onclick="ooCancel('${r.id}')">取消</button>`:(S.admin?`<button class="btn danger sm" onclick="ooRemove('${r.id}')">删除</button>`:'')}</span></div>`;
    }).join(''):'<div class="empty">当前没有人外出</div>'}</div>`;
}
function openOooCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>登记外出</h2><div class="form">
  <div class="fld"><label>类型</label><select id="ooCat"><option>外出</option><option>请假</option><option>出差</option><option>调休</option><option>其他</option></select></div>
  <div class="fld"><label>事由（可选）</label><input id="ooReason" placeholder="如：客户拜访 / 家中有事"></div>
  <div class="fld"><label>预计返回时间（可选）</label><input id="ooReturn" type="datetime-local"></div>
  <button class="btn pri" onclick="submitOooCreate()">登记</button>
  <div class="hint">已有进行中的外出登记时需先返回或取消</div></div>`); }
function submitOooCreate(){ const rt=$('#ooReturn').value?new Date($('#ooReturn').value).getTime():0; wsSend({type:'oooCreate',category:$('#ooCat').value,reason:$('#ooReason').value,expectedReturnAt:rt||0}); closeModal(); }
function ooBack(id){ wsSend({type:'oooBack',oooId:id}); }
function ooCancel(id){ wsSend({type:'oooCancel',oooId:id}); }
function ooRemove(id){ wsSend({type:'oooRemove',oooId:id}); }

/* ============ 请假审批 ============ */
function renderLeaves(){
  const d=S.DB.leaves||{leaves:[],stats:{}};
  const me=S.me.account;
  const st=d.stats||{};
  const badge = {pending:'warn',approved:'ok',rejected:'grey',cancelled:'grey'};
  const label = {pending:'待审批',approved:'已批准',rejected:'已驳回',cancelled:'已取消'};
  $('#main').innerHTML = `<div class="topbar"><div><h1>请假审批</h1><div class="sub">成员提交请假申请，管理员审批；与外出登记互补，便于统一跟踪请假</div></div>
    <button class="btn pri" onclick="openLeaveCreate()">＋ 提交请假</button>${S.admin&&st.pendingCount>0?`<button class="btn green" onclick="leaveBatchApprove()">✔ 一键批准全部（${st.pendingCount}）</button><button class="btn danger" onclick="leaveBatchReject()">✘ 一键驳回全部</button>`:''}></div>
    <div class="cards">
      <div class="card"><h3>⏳ 待审批</h3><div style="font-size:30px;font-weight:800">${st.pendingCount||0}</div><div class="meta">个申请</div></div>
      <div class="card"><h3>📅 今日申请</h3><div style="font-size:30px;font-weight:800">${st.todayCount||0}</div><div class="meta">人次</div></div>
      <div class="card"><h3>✅ 已批准</h3><div style="font-size:30px;font-weight:800">${st.approvedCount||0}</div><div class="meta">累计</div></div>
      <div class="card"><h3>❌ 已驳回</h3><div style="font-size:30px;font-weight:800">${st.rejectedCount||0}</div><div class="meta">累计</div></div>
    </div>
    <h3 style="margin:22px 0 10px">📋 请假记录</h3>
    <div class="list">${(d.leaves||[]).length?d.leaves.map(r=>{
      const mine=r.account===me;
      return `<div class="row"><span><span class="who">${esc(r.name||r.account)}</span> <span class="badge ${badge[r.status]||'grey'}">${label[r.status]||r.status}</span>${r.status==='pending'&&r.slaRemindedAt?' <span class="badge warn">已超时</span>':''}
        <div class="desc">${esc(r.category)}${r.reason?' · '+esc(r.reason):''}</div>
        <div class="when">${fmtTime(r.startAt)} → ${fmtTime(r.endAt)}${r.decideNote?' · 备注：'+esc(r.decideNote):''}</div>
      </span><span class="fs">${mine&&r.status==='pending'?`<button class="btn danger sm" onclick="leaveCancel('${r.id}')">取消</button>`:''}${S.admin&&r.status==='pending'?`<button class="btn green sm" onclick="leaveApprove('${r.id}')">批准</button><button class="btn danger sm" onclick="openLeaveReject('${r.id}')">驳回</button>`:''}</span></div>`;
    }).join(''):'<div class="empty">还没有请假申请</div>'}</div>`;
}
function openLeaveCreate(){
  const d=(ms)=>{ const x=new Date(ms), off=x.getTimezoneOffset(); return new Date(ms-off).toISOString().slice(0,16); };
  const now=Date.now(), start=now+86400000, end=start+2*86400000;
  const cats=['事假','病假','年假','调休','婚假','产假','丧假','其他'];
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>提交请假</h2><div class="form">
    <div class="fld"><label>请假类型</label><select id="lvCat">${cats.map(c=>`<option>${esc(c)}</option>`).join('')}</select></div>
    <div class="fld"><label>开始时间</label><input id="lvStart" type="datetime-local"></div>
    <div class="fld"><label>结束时间</label><input id="lvEnd" type="datetime-local"></div>
    <div class="fld"><label>事由</label><input id="lvReason" placeholder="可选"></div>
    <button class="btn pri" onclick="submitLeaveCreate()">提交申请</button></div>`);
  $('#lvStart').value=d(start); $('#lvEnd').value=d(end);
}
function submitLeaveCreate(){
  const st=new Date($('#lvStart').value).getTime(), en=new Date($('#lvEnd').value).getTime();
  if(!(st>0)||!(en>st)) return toast('时间无效','error');
  wsSend({type:'leaveCreate',category:$('#lvCat').value,startAt:st,endAt:en,reason:$('#lvReason').value});
  closeModal();
}
function leaveCancel(id){ wsSend({type:'leaveCancel',leaveId:id}); }
function leaveApprove(id){ wsSend({type:'leaveApprove',leaveId:id}); }
function openLeaveReject(id){
  const r=(S.DB.leaves||[]).leaves.find(x=>x.id===id);
  S.lastLeaveReject=id;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>驳回请假 · ${esc(r?r.name:'')}</h2><div class="form">
    <div class="fld"><label>驳回原因（可选）</label><input id="lvNote" placeholder="可选"></div>
    <button class="btn danger" onclick="submitLeaveReject()">确认驳回</button></div>`);
}
function submitLeaveReject(){ wsSend({type:'leaveReject',leaveId:S.lastLeaveReject,decideNote:$('#lvNote').value}); closeModal(); }
function leaveBatchApprove(){ if(!confirm('一键批准当前全部待审批请假申请？')) return; wsSend({type:'leaveBatchApprove'}); render(); }
function leaveBatchReject(){ const note=(prompt('驳回全部待审批请假申请，可填共同原因（可选）')||'').trim(); if(note.length>120) return toast('原因最多 120 字','error'); if(!confirm('一键驳回当前全部待审批请假申请？'+(note?' 原因：'+note:''))) return; wsSend({type:'leaveBatchReject',decideNote:note}); render(); }

/* ============ 会议纪要 ============ */
function renderMeetingNotes(){
  const d=S.DB.meetingNotes||{notes:[],stats:{}};
  const me=S.me.account;
  const st=d.stats||{};
  $('#main').innerHTML = `<div class="topbar"><div><h1>会议纪要</h1><div class="sub">会议结束后把结论挂在对应预约上，便于复盘与分享</div></div>
    <button class="btn pri" onclick="openMeetingNoteCreate()">＋ 新建纪要</button></div>
    <div class="cards">
      <div class="card"><h3>📝 纪要总数</h3><div style="font-size:30px;font-weight:800">${st.total||0}</div><div class="meta">条</div></div>
      <div class="card"><h3>📅 今日更新</h3><div style="font-size:30px;font-weight:800">${st.todayCount||0}</div><div class="meta">条</div></div>
    </div>
    <h3 style="margin:22px 0 10px">🗒️ 会议纪要</h3>
    <div class="list">${(d.notes||[]).length?d.notes.map(n=>{
      const mine=n.account===me;
      const who=n.reservationTitle?(' · '+esc(n.reservationTitle)):(n.roomName?(' · '+esc(n.roomName)):'');
      return `<div class="row"><span><span class="who">${esc(n.title||'（无标题）')}</span> <span class="badge">${esc(n.name||n.account)}</span>
        <div class="desc">${esc((n.content||'').slice(0,120))}${(n.content||'').length>120?'…':''}</div>
        <div class="when">${n.reservationTitle?esc(n.reservationTitle)+' · ':''}${n.roomName?esc(n.roomName):''}${who} · ${fmtTime(n.updatedAt||n.createdAt)} 更新</div>
      </span><span class="fs">${(mine||S.admin)?`<button class="btn green sm" onclick="openMeetingNoteEdit('${n.id}')">编辑</button><button class="btn danger sm" onclick="meetingNoteRemove('${n.id}')">删除</button>`:''}</span></div>`;
    }).join(''):'<div class="empty">还没有会议纪要</div>'}</div>`;
}
function openMeetingNoteCreate(){
  const res=(S.DB.reservations||[]).filter(r=>r.status!=='cancelled');
  const opts=res.length?res.map(r=>`<option value="${r.id}">${esc(r.title||'')} · ${fmtTime(r.startAt)}（${r.ownerName||''}）</option>`).join(''):'';
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>新建会议纪要</h2><div class="form">
    <div class="fld"><label>关联会议</label><select id="mnRes">${opts}</select></div>
    <div class="fld"><label>标题</label><input id="mnTitle" placeholder="可选"></div>
    <div class="fld"><label>纪要内容</label><textarea id="mnContent" rows="6"></textarea></div>
    <button class="btn pri" onclick="submitMeetingNoteCreate()">保存纪要</button></div>`);
}
function submitMeetingNoteCreate(){
  const rid=$('#mnRes').value;
  const content=($('#mnContent').value||'').trim();
  if(!rid) return toast('请先选择关联会议','error');
  if(!content) return toast('请填写会议纪要内容','error');
  wsSend({type:'meetingNoteCreate',reservationId:rid,title:$('#mnTitle').value,content});
  closeModal();
}
function openMeetingNoteEdit(id){
  const n=(S.DB.meetingNotes||{}).notes.find(x=>x.id===id);
  if(!n) return;
  S.lastMeetingNote=id;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>编辑会议纪要 · ${esc(n.title||'（无标题）')}</h2><div class="form">
    <div class="fld"><label>标题</label><input id="mnTitle" value="${esc(n.title||'')}"></div>
    <div class="fld"><label>纪要内容</label><textarea id="mnContent" rows="8">${esc(n.content||'')}</textarea></div>
    <button class="btn pri" onclick="submitMeetingNoteEdit()">保存修改</button></div>`);
}
function submitMeetingNoteEdit(){
  wsSend({type:'meetingNoteEdit',noteId:S.lastMeetingNote,title:$('#mnTitle').value,content:$('#mnContent').value});
  closeModal();
}
function meetingNoteRemove(id){ wsSend({type:'meetingNoteRemove',noteId:id}); }

/* ============ 意见反馈 ============ */
function renderFeedback(){
  const d=S.DB.feedback||{records:[],stats:{}};
  const me=S.me.account;
  const st=d.stats||{};
  const statusBadge=(s)=> s==='open'?'<span class="badge warn">待处理</span>':s==='answered'?'<span class="badge ok">已回复</span>':'<span class="badge">已关闭</span>';
  $('#main').innerHTML = `<div class="topbar"><div><h1>意见反馈</h1><div class="sub">匿名 / 实名提建议、吐槽、问题或表扬，管理员回复后闭环</div></div>
    <button class="btn pri" onclick="openFeedbackCreate()">＋ 提反馈</button></div>
    <div class="cards">
      <div class="card"><h3>📥 待处理</h3><div style="font-size:30px;font-weight:800">${st.open||0}</div><div class="meta">条反馈等待回复</div></div>
      <div class="card"><h3>✅ 已回复</h3><div style="font-size:30px;font-weight:800">${st.answered||0}</div><div class="meta">条已闭环</div></div>
      <div class="card"><h3>🔒 已关闭</h3><div style="font-size:30px;font-weight:800">${st.closed||0}</div><div class="meta">条无需跟进</div></div>
    </div>
    <h3 style="margin:22px 0 10px">💌 反馈列表</h3>
    <div class="list">${(d.records||[]).length?d.records.map(r=>`
      <div class="row"><span><span class="who">${r.anonymous?'🕶️ ':'🙋 '}${esc(r.author)} <span class="badge">${esc(r.category)}</span> ${statusBadge(r.status)}</span>
        <div class="desc">${esc(r.content)}</div>
        <div class="when">${fmtTime(r.createdAt)}</div>
        ${(r.replies||[]).map(rp=>`<div class="reply"><span class="who">👤 ${esc(rp.name||rp.account)}</span><div class="desc">${esc(rp.content)}</div></div>`).join('')}
      </span><span class="fs">${S.admin&&r.status!=='closed'?`<button class="btn pri sm" onclick="openFeedbackReply('${r.id}')">回复</button><button class="btn danger sm" onclick="feedbackClose('${r.id}')">关闭</button>`:''}</span></div>`).join(''):'<div class="empty">还没有反馈，来提第一条吧</div>'}</div>`;
}
function openFeedbackCreate(){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>提反馈</h2><div class="form">
  <div class="fld"><label>类型</label><select id="fbCat"><option>建议</option><option>吐槽</option><option>问题</option><option>表扬</option></select></div>
  <div class="fld"><label>内容</label><textarea id="fbContent" rows="4" placeholder="描述你的建议或问题…"></textarea></div>
  <label class="check"><input id="fbAnon" type="checkbox"> 匿名提交</label>
  <button class="btn pri" onclick="submitFeedbackCreate()">提交</button></div>`); }
function submitFeedbackCreate(){ wsSend({type:'feedbackCreate',category:$('#fbCat').value,content:$('#fbContent').value,anonymous:$('#fbAnon').checked}); closeModal(); }
function openFeedbackReply(id){ openModal(`<span class="close" onclick="closeModal()">×</span><h2>回复反馈</h2><div class="form">
  <div class="fld"><label>回复内容</label><textarea id="fbReply" rows="4" placeholder="感谢反馈，我们会跟进…"></textarea></div>
  <button class="btn pri" onclick="submitFeedbackReply('${id}')">回复</button></div>`); }
function submitFeedbackReply(id){ wsSend({type:'feedbackReply',feedbackId:id,content:$('#fbReply').value}); closeModal(); }
function feedbackClose(id){ wsSend({type:'feedbackClose',feedbackId:id}); }

/* ============ 心情打卡 ============ */
function renderMood(){
  const d=S.DB.mood||{records:[],stats:{}};
  const me=S.me.account;
  const my=d.records.find(r=>r.account===me);
  const emojis=['😊','😐','😴','😡','🤩','🥲'];
  const st=d.stats||{};
  $('#main').innerHTML = `<div class="topbar"><div><h1>心情打卡</h1><div class="sub">每天记录一下今天的心情，看看团队整体状态</div></div>
    <button class="btn pri" onclick="openMoodPicker()">${my?'更改今日心情':'记录今日心情'}</button></div>
    <div class="cards">
      <div class="card"><h3>🌈 今日已记录</h3><div style="font-size:30px;font-weight:800">${st.total||0}</div><div class="meta">人 / 共 ${emojis.length} 种心情</div></div>
      ${emojis.map(e=>`<div class="card"><h3>${e}</h3><div style="font-size:30px;font-weight:800">${(st.counts||{})[e]||0}</div><div class="meta">人</div></div>`).join('')}
    </div>
    <h3 style="margin:22px 0 10px">📊 今日心情</h3>
    <div class="list">${d.records.length?d.records.map(r=>`
      <div class="row"><span><span class="who">${esc(r.name||r.account)} ${r.account===me?'<span class="badge ok">我</span>':''}</span> <span style="font-size:22px">${esc(r.emoji)}</span></span>
        <span class="fs">${fmtTime(r.createdAt)}</span></div>`).join(''):'<div class="empty">还没有人记录心情</div>'}</div>`;
}
function openMoodPicker(){
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>记录今日心情</h2><div class="form">
    <div class="fld"><label>选择心情</label><div style="display:flex;gap:10px;justify-content:center">${['😊','😐','😴','😡','🤩','🥲'].map(e=>`<button class="btn pri sm mood-pick" onclick="pickMood('${e}')">${e}</button>`).join('')}</div></div>
  </div>`);
}
function pickMood(e){ wsSend({type:'moodCheckIn',emoji:e}); closeModal(); }

/* ============ 活动管理 ============ */
function eventStatusBadge(s){ return s==='upcoming'?'<span class="badge warn">即将开始</span>':s==='ongoing'?'<span class="badge ok">进行中</span>':s==='cancelled'?'<span class="badge bad">已取消</span>':'<span class="badge">已结束</span>'; }
function renderEvents(){
  const list=S.DB.events||[]; const me=S.me.account; const st=S.eventStats||{};
  $('#main').innerHTML = `<div class="topbar"><div><h1>活动管理</h1><div class="sub">培训 / 分享会 / 团建 / 生日会，发起活动并收集 RSVP</div></div>
    <button class="btn pri" onclick="openEventCreate()">＋ 发起活动</button></div>
    <div class="cards">
      <div class="card"><h3>📅 即将开始</h3><div style="font-size:30px;font-weight:800">${st.upcoming||0}</div><div class="meta">场活动</div></div>
      <div class="card"><h3>🟢 进行中</h3><div style="font-size:30px;font-weight:800">${st.ongoing||0}</div><div class="meta">场活动</div></div>
      <div class="card"><h3>✅ 已结束</h3><div style="font-size:30px;font-weight:800">${st.ended||0}</div><div class="meta">场活动</div></div>
      <div class="card"><h3>🏢 活动总数</h3><div style="font-size:30px;font-weight:800">${st.total||0}</div><div class="meta">场活动</div></div>
    </div>
    <h3 style="margin:22px 0 10px">🎉 活动列表</h3>
    <div class="list">${list.length?list.map(e=>`
      <div class="row"><span><span class="who">${esc(e.title)} <span class="badge">${esc(e.category)}</span> ${eventStatusBadge(e.status)}</span>
        <div class="desc">${esc(e.description||'')} ${e.location?'· 📍 '+esc(e.location):''}</div>
        <div class="when">${fmtTime(e.startAt)} → ${fmtTime(e.endAt)} · 主办 ${esc(e.hostName||'')} · 参加 ${e.goingCount||0}/${e.capacity||'不限'}（${e.goingCount+e.maybeCount+e.notGoingCount||0} 人回复）</div>
        ${e.status==='upcoming'&&e.myRsvp?`<div class="fs"><span class="badge ok">我：${({going:'参加',maybe:'可能',not_going:'不参加'}[e.myRsvp])||''}</span></div>`:''}
      </span><span class="fs">${e.status==='upcoming'?`<button class="btn sm ${e.myRsvp==='going'?'green':''}" onclick="eventRsvp('${e.id}','going')">参加</button><button class="btn sm" onclick="eventRsvp('${e.id}','maybe')">可能</button><button class="btn sm" onclick="eventRsvp('${e.id}','not_going')">不参加</button>`:''}${e.hostAccount===me||S.admin?`<button class="btn danger sm" onclick="eventCancel('${e.id}')">取消</button>`:''}${S.admin?`<button class="btn danger sm" onclick="eventRemove('${e.id}')">删除</button>`:''}</span></div>`).join(''):'<div class="empty">还没有活动，来发起第一个吧</div>'}</div>
    ${(S.eventOffset||0)<(S.eventTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('events')">加载更多（${S.eventTotal-(S.eventOffset||0)}）</button></div>`:''}`;
}
function openEventCreate(){
  const mins=(n)=>{ const d=new Date(Date.now()+n*60000); return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`; };
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>发起活动</h2><div class="form">
    <div class="fld"><label>标题</label><input id="evTitle" maxlength="50" placeholder="如：Q4 技术分享会"></div>
    <div class="fld"><label>描述</label><textarea id="evDesc" rows="3" placeholder="活动说明…"></textarea></div>
    <div class="fld"><label>类型</label><select id="evCat">${['培训','分享会','团建','生日会','会议','其它'].map(c=>`<option>${c}</option>`).join('')}</select></div>
    <div class="fld"><label>地点（可选）</label><input id="evLoc" maxlength="30" placeholder="如：3F 会议室"></div>
    <div class="fld"><label>开始时间</label><input id="evStart" type="datetime-local" value="${mins(60)}"></div>
    <div class="fld"><label>结束时间</label><input id="evEnd" type="datetime-local" value="${mins(120)}"></div>
    <div class="fld"><label>人数上限（可选，0=不限）</label><input id="evCap" type="number" min="0" value="0"></div>
    <button class="btn pri" onclick="submitEventCreate()">发起</button></div>`);
}
function submitEventCreate(){ wsSend({type:'eventCreate',title:$('#evTitle').value,description:$('#evDesc').value,category:$('#evCat').value,location:$('#evLoc').value,startAt:Date.parse($('#evStart').value),endAt:Date.parse($('#evEnd').value),capacity:parseInt($('#evCap').value,10)||0}); closeModal(); }
function eventRsvp(id,status){ wsSend({type:'eventRsvp',rsvpId:id,status}); }
function eventCancel(id){ wsSend({type:'eventCancel',rsvpId:id}); }
function eventRemove(id){ wsSend({type:'eventRemove',rsvpId:id}); }

/* ============ 投票 ============ */
function renderPolls(){
  const list=S.DB.polls||[]; const me=S.me.account; const st=S.pollStats||{};
  $('#main').innerHTML = `<div class="topbar"><div><h1>投票</h1><div class="sub">午饭吃什么、办公怎么改，一个投票快速达成共识</div></div>
    <button class="btn pri" onclick="openPollCreate()">＋ 发起投票</button></div>
    <div class="cards">
      <div class="card"><h3>🗳️ 进行中</h3><div style="font-size:30px;font-weight:800">${st.open||0}</div><div class="meta">个投票</div></div>
      <div class="card"><h3>🔒 已关闭</h3><div style="font-size:30px;font-weight:800">${st.closed||0}</div><div class="meta">个投票</div></div>
      <div class="card"><h3>📊 投票总数</h3><div style="font-size:30px;font-weight:800">${st.total||0}</div><div class="meta">个投票</div></div>
      <div class="card"><h3>🙋 累计参与</h3><div style="font-size:30px;font-weight:800">${st.totalVotes||0}</div><div class="meta">人次</div></div>
    </div>
    <h3 style="margin:22px 0 10px">🗳️ 投票列表</h3>
    <div class="list">${list.length?list.map(p=>`
      <div class="row"><span><span class="who">${esc(p.question)} ${p.anonymous?'<span class="badge">匿名</span>':''} ${p.closed?'<span class="badge bad">已截止</span>':p.status==='closed'?'<span class="badge">已关闭</span>':'<span class="badge ok">进行中</span>'}</span>
        <div class="when">${esc(p.creatorName||'')} 发起 · ${p.deadline?'截止 '+fmtTime(p.deadline):'无截止时间'} · ${p.totalVotes} 票</div>
        ${p.options.map(o=>`<div class="pollopt ${p.myVote===o.id?'voted':''}"><span>${o.count}</span><i>${o.text}</i>${p.closed?'':`<button class="btn sm" onclick="pollVote('${p.id}','${o.id}')">${p.myVote===o.id?'已投':'投票'}</button>`}</div>`).join('')}
      </span><span class="fs">${p.creatorAccount===me||S.admin?`<button class="btn sm" onclick="pollClose('${p.id}')">关闭</button>`:''}${S.admin?`<button class="btn danger sm" onclick="pollRemove('${p.id}')">删除</button>`:''}</span></div>`).join(''):'<div class="empty">还没有投票</div>'}</div>
    ${(S.pollOffset||0)<(S.pollTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('polls')">加载更多（${S.pollTotal-(S.pollOffset||0)}）</button></div>`:''}`;
}
function openPollCreate(){
  const d=new Date(Date.now()+24*3600000);
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>发起投票</h2><div class="form">
    <div class="fld"><label>问题</label><input id="plQ" maxlength="50" placeholder="午饭吃什么？"></div>
    <div class="fld"><label>选项（2-5 个）</label><div class="fs" style="flex-direction:column;align-items:stretch">${[1,2,3].map(i=>`<div class="fs"><input id="plO${i}" maxlength="20" placeholder="选项 ${i}"><button class="btn sm danger" onclick="this.parentNode.remove()">×</button></div>`).join('')}<button class="btn sm" onclick="addPollOption()">＋ 添加选项</button></div></div>
    <div class="fld"><label>截止时间（可选）</label><input id="plDead" type="datetime-local" value="${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}T${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}"></div>
    <label class="check"><input id="plAnon" type="checkbox"> 匿名投票</label>
    <button class="btn pri" onclick="submitPollCreate()">发起</button></div>`);
}
function addPollOption(){ const wrap=$('#modals'); if(!wrap) return; if(wrap.querySelectorAll('input[id^="plO"]').length>=5) return; const i=wrap.querySelectorAll('input[id^="plO"]').length+1; const row=document.createElement('div'); row.className='fs'; row.innerHTML=`<input id="plO${i}" maxlength="20" placeholder="选项 ${i}"><button class="btn sm danger" onclick="this.parentNode.remove()">×</button>`; const addBtn=wrap.querySelector('button[onclick="addPollOption()"]'); addBtn.before(row); }
function submitPollCreate(){ const opts=[...document.querySelectorAll('#modals input[id^="plO"]')].map(i=>i.value).filter(Boolean); wsSend({type:'pollCreate',question:$('#plQ').value,options:opts,deadline:Date.parse($('#plDead').value)||null,anonymous:$('#plAnon').checked}); closeModal(); }
function pollVote(id,optId){ wsSend({type:'pollVote',pollId:id,optionId:optId}); }
function pollClose(id){ wsSend({type:'pollClose',pollId:id}); }
function pollRemove(id){ wsSend({type:'pollRemove',pollId:id}); }

/* ============ 知识库 ============ */
function renderKnowledge(){
  const list=S.DB.knowledge||[]; const me=S.me.account; const st=S.knowledgeStats||{};
  const q=(S.kbQuery||'').toLowerCase();
  const filtered=q?list.filter(k=>(k.title+k.content+(k.tags||[]).join('')+k.category).toLowerCase().includes(q)):list;
  $('#main').innerHTML = `<div class="topbar"><div><h1>知识库</h1><div class="sub">规章制度 / 操作指引 / 设备说明 / 常见问题，一查就有</div></div>
    <div class="fs"><input id="kbQ" placeholder="搜索标题、内容、标签…" value="${esc(S.kbQuery||'')}" oninput="S.kbQuery=this.value;render();"></div>
    <button class="btn pri" onclick="openKnowledgeCreate()">＋ 发布文章</button></div>
    <div class="cards">
      <div class="card"><h3>📘 文章总数</h3><div style="font-size:30px;font-weight:800">${st.total||0}</div><div class="meta">篇</div></div>
      <div class="card"><h3>👍 累计点赞</h3><div style="font-size:30px;font-weight:800">${st.liked||0}</div><div class="meta">次</div></div>
      <div class="card"><h3>💬 评论</h3><div style="font-size:30px;font-weight:800">${st.comments||0}</div><div class="meta">条</div></div>
      <div class="card"><h3>✍️ 贡献者</h3><div style="font-size:30px;font-weight:800">${st.authors||0}</div><div class="meta">人</div></div>
    </div>
    <h3 style="margin:22px 0 10px">📚 文章列表</h3>
    <div class="list">${filtered.length?filtered.map(k=>`
      <div class="row"><span><span class="who">${esc(k.title)} <span class="badge">${esc(k.category)}</span> ${k.tags.map(t=>`<span class="badge grey">${esc(t)}</span>`).join('')} ${k.commentCount?`<span class="badge ok">💬 ${k.commentCount}</span>`:''}</span>
        <div class="desc">${esc((k.content||'').slice(0,120))}${(k.content||'').length>120?'…':''}</div>
        <div class="when">${esc(k.authorName||'')} · ${fmtTime(k.createdAt)} · 👍 ${k.likeCount} · 💬 ${k.commentCount||0}</div>
        ${knowledgeCommentListHtml(k)}
        <div style="margin-top:6px"><input placeholder="发表评论…" maxlength="300" onkeydown="if(event.key==='Enter')knowledgeComment('${k.id}',this.value)"/></div>
      </span><span class="fs"><button class="btn sm ${k.liked?'green':''}" onclick="knowledgeLike('${k.id}')">${k.liked?'👍 已赞':'👍 点赞'}</button>${k.authorAccount===me||S.admin?`<button class="btn sm" onclick="openKnowledgeEdit('${k.id}')">编辑</button><button class="btn danger sm" onclick="knowledgeDelete('${k.id}')">删除</button>`:''}</span></div>`).join(''):(q?'<div class="empty">没有匹配的文章</div>':'<div class="empty">还没有知识文章</div>')}</div>
    ${(S.knowledgeOffset||0)<(S.knowledgeTotal||0)?`<div style="text-align:center;margin-top:12px"><button class="btn" onclick="loadMore('knowledge')">加载更多（${S.knowledgeTotal-(S.knowledgeOffset||0)}）</button></div>`:''}`;
}
// 知识库评论列表：顶级评论 + 一级回复，支持就地回复输入
function knowledgeCommentListHtml(k) {
  const comments = (k.comments || []).slice().reverse();
  const tops = comments.filter((c) => !c.parentId);
  const replies = comments.filter((c) => c.parentId);
  if (!tops.length && !replies.length) return '';
  const replyOf = (id) => replies.filter((r) => r.parentId === id);
  const body = tops.map((c) => {
    const rs = replyOf(c.id);
    const replyBlock = rs.map((r) => `<div style="margin:6px 0 0 28px;padding:6px 10px;background:var(--panel);border-left:3px solid var(--border)"><b>${esc(r.name||'')}</b> <span style="color:var(--muted)">回复 ${esc(r.parentName||'')} · ${fmtTime(r.createdAt)}</span><br>${esc(r.text||'')}</div>`).join('');
    return `<div style="margin-bottom:8px"><b>${esc(c.name||'')}</b> <span style="color:var(--muted)">${fmtTime(c.createdAt)}</span><br>${esc(c.text||'')}</div>${replyBlock}${knowledgeReplyControl(k,c)}`;
  }).join('');
  return `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">${body}</div>`;
}
function knowledgeReplyControl(k, c) {
  const t = S._kbReply;
  if (t && t.kId === k.id && t.cmId === c.id) {
    return `<div style="margin-top:6px;display:flex;gap:6px"><input id="kbReplyInput" placeholder="回复 ${esc(t.name)}…" maxlength="300" autofocus onkeydown="if(event.key==='Enter')submitKnowledgeReply()"/><button class="btn sm pri" onclick="submitKnowledgeReply()">回复</button><button class="btn sm" onclick="cancelKnowledgeReply()">取消</button></div>`;
  }
  return `<button class="btn sm" onclick="knowledgeReplyTarget('${k.id}','${c.id}')">回复</button>`;
}
function knowledgeReplyTarget(kId, cmId){ const k=(S.DB.knowledge||[]).find(x=>x.id===kId); const c=(k&&k.comments||[]).find(x=>x.id===cmId); S._kbReply = { kId, cmId, name: c ? (c.name||'') : '' }; render(); setTimeout(()=>{ const el=$('#kbReplyInput'); if(el) el.focus(); },0); }
function submitKnowledgeReply(){ const t=S._kbReply; if(!t) return; const input=$('#kbReplyInput'); if(!input) return; knowledgeComment(t.kId, input.value, t.cmId); S._kbReply=null; render(); }
function cancelKnowledgeReply(){ S._kbReply=null; render(); }
function openKnowledgeCreate(){
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>发布文章</h2><div class="form">
    <div class="fld"><label>标题</label><input id="kbTitle" maxlength="50"></div>
    <div class="fld"><label>分类</label><select id="kbCat">${['规章制度','操作指引','设备说明','常见问题','其他'].map(c=>`<option>${c}</option>`).join('')}</select></div>
    <div class="fld"><label>标签（逗号分隔，最多 10 个）</label><input id="kbTags" placeholder="A4 纸, 打印"></div>
    <div class="fld"><label>内容</label><textarea id="kbContent" rows="6"></textarea></div>
    <button class="btn pri" onclick="submitKnowledgeCreate()">发布</button></div>`);
}
function submitKnowledgeCreate(){ wsSend({type:'knowledgeCreate',title:$('#kbTitle').value,content:$('#kbContent').value,category:$('#kbCat').value,tags:$('#kbTags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)}); closeModal(); }
function openKnowledgeEdit(id){
  const k=(S.DB.knowledge||[]).find(x=>x.id===id); if(!k) return;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>编辑文章</h2><div class="form">
    <div class="fld"><label>标题</label><input id="kbTitle" maxlength="50" value="${esc(k.title)}"></div>
    <div class="fld"><label>分类</label><select id="kbCat">${['规章制度','操作指引','设备说明','常见问题','其他'].map(c=>`<option ${c===k.category?'selected':''}>${c}</option>`).join('')}</select></div>
    <div class="fld"><label>标签（逗号分隔）</label><input id="kbTags" value="${esc((k.tags||[]).join(','))}"></div>
    <div class="fld"><label>内容</label><textarea id="kbContent" rows="6">${esc(k.content||'')}</textarea></div>
    <button class="btn pri" onclick="submitKnowledgeEdit('${id}')">保存</button></div>`);
}
function submitKnowledgeEdit(id){ wsSend({type:'knowledgeEdit',id,title:$('#kbTitle').value,content:$('#kbContent').value,category:$('#kbCat').value,tags:$('#kbTags').value.split(/[,，]/).map(s=>s.trim()).filter(Boolean)}); closeModal(); }
function knowledgeDelete(id){ wsSend({type:'knowledgeDelete',id}); }
function knowledgeLike(id){ wsSend({type:'knowledgeLike',id}); }
function knowledgeComment(id, text, parentId){ wsSend({type:'knowledgeComment',id,text,parentId: parentId||null}); }

/* ============ 待办任务 ============ */
function taskBadge(t){
  const pri = { high:'badge bad', normal:'badge', low:'badge grey' }[t.priority||'normal'];
  const st = { pending:'待办', in_progress:'进行中', done:'已完成', cancelled:'已取消' }[t.status];
  return `<span class="${pri}">${({high:'高',normal:'中',low:'低'}[t.priority||'normal'])}优先</span> ${t.status==='done'?'<span class="badge ok">已完成</span>':t.status==='cancelled'?'<span class="badge grey">已取消</span>':'<span class="badge warn">'+st+'</span>'}`;
}
function taskActions(t){
  const me=S.me.account;
  const canAssign=t.creatorAccount===me||S.admin;
  const canAdvance=t.assigneeAccount===me||t.creatorAccount===me||S.admin;
  const canRemove=t.creatorAccount===me||S.admin;
  if(t.status==='done'||t.status==='cancelled') return canRemove?`<button class="btn danger sm" onclick="taskRemove('${t.id}')">删除</button>`:'';
  const btns=[];
  if(canAssign) btns.push(`<button class="btn sm" onclick="openTaskAssign('${t.id}')">指派</button>`);
  if(t.status==='pending'&&canAdvance) btns.push(`<button class="btn sm" onclick="taskStart('${t.id}')">开始</button>`);
  if(t.status!=='done'&&canAdvance) btns.push(`<button class="btn green sm" onclick="taskComplete('${t.id}')">完成</button>`);
  if(canRemove) btns.push(`<button class="btn danger sm" onclick="taskRemove('${t.id}')">删除</button>`);
  return btns.join('');
}
function renderTasks(){
  const list=S.DB.tasks||[]; const st=S.taskStats||{};
  $('#main').innerHTML = `<div class="topbar"><div><h1>待办任务</h1><div class="sub">今天要做什么：发起任务、指派或认领，推动闭环</div></div>
    <button class="btn pri" onclick="openTaskCreate()">＋ 新建任务</button></div>
    <div class="cards">
      <div class="card"><h3>📝 待办</h3><div style="font-size:30px;font-weight:800">${st.pending||0}</div><div class="meta">个未开始</div></div>
      <div class="card"><h3>⏳ 进行中</h3><div style="font-size:30px;font-weight:800">${st.in_progress||0}</div><div class="meta">个进行中</div></div>
      <div class="card"><h3>✅ 已完成</h3><div style="font-size:30px;font-weight:800">${st.done||0}</div><div class="meta">个已完成</div></div>
      <div class="card"><h3>🙋 开放认领</h3><div style="font-size:30px;font-weight:800">${st.open||0}</div><div class="meta">个未指派</div></div>
    </div>
    <h3 style="margin:22px 0 10px">📝 任务列表</h3>
    <div class="list">${list.length?list.map(t=>`
      <div class="row"><span><span class="who">${esc(t.title)} ${taskBadge(t)} ${t.commentCount?`<span class="badge ok">💬 ${t.commentCount}</span>`:''}</span>
        <div class="desc">${esc(t.description||'')}</div>
        <div class="when">${esc(t.creatorName||'')} ${t.assigneeAccount?'→ '+esc(t.assigneeName||''):'（开放认领）'} · ${t.dueAt?'截止 '+fmtTime(t.dueAt):'无截止时间'}${t.completedAt?' · 完成于 '+fmtTime(t.completedAt):''}</div>
        ${taskCommentListHtml(t)}
      </span><span class="fs">${taskActions(t)}${(t.creatorAccount===me||t.assigneeAccount===me||S.admin)?`<div style="margin-top:6px"><input placeholder="评论…" maxlength="200" onkeydown="if(event.key==='Enter')taskComment('${t.id}',this.value)"/></div>`:''}</span></div>`).join(''):'<div class="empty">还没有任务，来创建第一个吧</div>'}</div>`;
}
// 任务评论列表：展示最近评论（倒序）
function taskCommentListHtml(t) {
  const comments = (t.comments || []).slice().reverse();
  if (!comments.length) return '';
  return `<div style="margin-top:8px;border-top:1px solid var(--border);padding-top:8px">${comments.map((c) => `<div style="font-size:12px;margin-bottom:4px"><b>${esc(c.name||'')}</b> <span style="color:var(--muted)">${fmtTime(c.createdAt)}</span><br>${esc(c.text||'')}</div>`).join('')}</div>`;
}
function openTaskCreate(){
  const d=new Date(Date.now()+86400000);
  const v=(t)=>`${t.getFullYear()}-${String(t.getMonth()+1).padStart(2,'0')}-${String(t.getDate()).padStart(2,'0')}T${String(t.getHours()).padStart(2,'0')}:${String(t.getMinutes()).padStart(2,'0')}`;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>新建任务</h2><div class="form">
    <div class="fld"><label>标题</label><input id="tkTitle" maxlength="60" placeholder="如：整理周报"></div>
    <div class="fld"><label>描述</label><textarea id="tkDesc" rows="3" placeholder="任务说明…"></textarea></div>
    <div class="fld"><label>优先级</label><select id="tkPri">${['high','normal','low'].map(p=>`<option value="${p}">${({high:'高',normal:'中',low:'低'}[p])}</option>`).join('')}</select></div>
    <div class="fld"><label>截止时间（可选）</label><input id="tkDue" type="datetime-local" value="${v(d)}"></div>
    <div class="fld"><label>指派给（可选，留空则开放认领）</label><select id="tkAssign"><option value="">（开放认领）</option>${(S.DB.users||[]).map(u=>`<option value="${u.account}">${esc(u.display||u.username)}</option>`).join('')}</select></div>
    <button class="btn pri" onclick="submitTaskCreate()">创建</button></div>`);
}
function submitTaskCreate(){ wsSend({type:'taskCreate',title:$('#tkTitle').value,description:$('#tkDesc').value,priority:$('#tkPri').value,dueAt:Date.parse($('#tkDue').value)||null,assigneeAccount:$('#tkAssign').value||undefined}); closeModal(); }
function openTaskAssign(id){
  const t=(S.DB.tasks||[]).find(x=>x.id===id); if(!t) return;
  openModal(`<span class="close" onclick="closeModal()">×</span><h2>指派任务</h2><div class="form">
    <div class="hint">${esc(t.title)}</div>
    <div class="fld"><label>指派给</label><select id="tkAssign2"><option value="">（开放认领）</option>${(S.DB.users||[]).map(u=>`<option value="${u.account}" ${u.account===t.assigneeAccount?'selected':''}>${esc(u.display||u.username)}</option>`).join('')}</select></div>
    <button class="btn pri" onclick="submitTaskAssign('${id}')">保存</button></div>`);
}
function submitTaskAssign(id){ wsSend({type:'taskAssign',taskId:id,assigneeAccount:$('#tkAssign2').value||undefined}); closeModal(); }
function taskStart(id){ wsSend({type:'taskStart',taskId:id}); }
function taskComplete(id){ wsSend({type:'taskComplete',taskId:id}); }
function taskRemove(id){ wsSend({type:'taskRemove',taskId:id}); }
function taskComment(id, text){ wsSend({type:'taskComment',taskId:id,text}); }

/* ============ 通知中心 ============ */
function renderNotifications(){
  const list=S.DB.notifications||[];
  $('#main').innerHTML = `<div class="topbar"><div><h1>通知中心</h1><div class="sub">系统重要事件留痕：指派、完成、超时、提醒等</div></div>
    <button class="btn pri" onclick="notificationReadAll()">全部已读</button></div>
    ${S.notificationUnread?`<div class="card" style="border-left:4px solid var(--warn)"><h3>🔔 你有 ${S.notificationUnread} 条未读通知</h3><div class="meta">点击「全部已读」或逐条标记，已读状态按人独立记录</div></div>`:''}
    <h3 style="margin:22px 0 10px">🔔 通知流</h3>
    <div class="list">${list.length?list.map(n=>`
      <div class="row ${n.read?'':'unread'}" onclick="notificationRead('${n.id}')"><span><span class="who">${esc(n.title)} ${n.level==='warn'?'<span class="badge warn">警告</span>':n.level==='success'?'<span class="badge ok">成功</span>':''} ${n.read?'':'<span class="badge">未读</span>'}</span>
        <div class="desc">${esc(n.body||'')}</div>
        <div class="when">${fmtTime(n.createdAt)}</div>
      </span></div>`).join(''):'<div class="empty">暂无通知</div>'}</div>`;
}
function notificationRead(id){ wsSend({type:'notificationRead',notificationId:id}); }
function notificationReadAll(){ wsSend({type:'notificationReadAll'}); }

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
  const sections = [];
  if (r.overdueCount) sections.push(`<h3 style="margin:22px 0 10px">⏰ 逾期借用 <span class="badge bad">${r.overdueCount}</span></h3><div class="list">${r.overdue.map(b=>{ const t=tools.find(x=>x.id===b.toolId); return `<div class="row"><span>${esc(t?t.name:b.toolId)} ×${b.qty} · 已借 ${b.days} 天</span><button class="btn danger sm" onclick="remindReturn('${b.id}')">提醒归还</button></div>`; }).join('')}</div>`);
  if (r.upcomingCount) sections.push(`<h3 style="margin:22px 0 10px">📅 临近会议 <span class="badge warn">${r.upcomingCount}</span></h3><div class="list">${r.upcoming.map(m=>`<div class="row"><span><span class="who">${esc(m.title)}</span> <span class="when">${fmtTime(m.startAt)} → ${fmtTime(m.endAt)}</span></span></div>`).join('')}</div>`);
  if (r.upcomingDeskCount) sections.push(`<h3 style="margin:22px 0 10px">🪑 临近工位 <span class="badge warn">${r.upcomingDeskCount}</span></h3><div class="list">${r.upcomingDesk.map(m=>{ const desk=(S.DB.desks||[]).find(x=>x.id===m.deskId); return `<div class="row"><span><span class="who">${esc(desk?desk.name:'工位')}</span> <span class="when">${fmtTime(m.startAt)} → ${fmtTime(m.endAt)}</span></span><span class="fs">${deskBadge('pending')}<button class="btn danger sm" onclick="cancelDesk('${m.id}')">取消</button></span></div>`; }).join('')}</div>`);
  if (r.activeOooCount) sections.push(`<h3 style="margin:22px 0 10px">🧳 外出中 <span class="badge warn">${r.activeOooCount}</span></h3><div class="list">${r.activeOoo.map(o=>`<div class="row"><span><span class="who">${esc(o.category)}</span> <span class="when">${o.expectedReturnAt?'预计返回 '+fmtTime(o.expectedReturnAt):''}</span></span><span class="fs"><button class="btn green sm" onclick="ooBack('${o.id}')">已返回</button><button class="btn danger sm" onclick="ooCancel('${o.id}')">取消</button></span></div>`).join('')}</div>`);
  if (r.pendingVisitorCount) sections.push(`<h3 style="margin:22px 0 10px">🚶 待接待访客 <span class="badge warn">${r.pendingVisitorCount}</span></h3><div class="list">${r.pendingVisitors.map(v=>`<div class="row"><span>${esc(v.visitorName)} <span class="badge ${v.status==='pending'?'warn':'info'}">${v.status==='pending'?'待到访':'已到访'}</span></span></div>`).join('')}</div>`);
  if (r.assignedMaterialCount) sections.push(`<h3 style="margin:22px 0 10px">📦 指派给我的申领 <span class="badge warn">${r.assignedMaterialCount}</span></h3><div class="list">${r.assignedMaterials.map(m=>`<div class="row"><span>${esc(m.name)} <span class="badge ${m.status==='pending'?'warn':'info'}">${m.status}</span></span></div>`).join('')}</div>`);
  if (r.assignedRepairCount) sections.push(`<h3 style="margin:22px 0 10px">🛠️ 指派给我的报修 <span class="badge warn">${r.assignedRepairCount}</span></h3><div class="list">${r.assignedRepairs.map(x=>`<div class="row"><span>${esc(x.category)} ${esc(x.location)} <span class="badge ${x.status==='reported'?'warn':'info'}">${x.status}</span></span></div>`).join('')}</div>`);
  if (!sections.length) sections.push('<div class="empty">🎉 一切就绪，暂无待办事项</div>');
  $('#main').innerHTML = `<div class="topbar"><div><h1>我的待办</h1><div class="sub">按优先级聚合与你相关的到期、临期与待处理事项</div></div>
    <button class="btn" onclick="wsSend({type:'getMyReminders'})">刷新</button></div>${sections.join('')}`;
}
function renderTrend(){
  const list = S.DB.trend || [];
  const metrics = [['meetings','🏢 会议'],['borrows','🔧 借用'],['requests','📦 申领'],['repairs','🛠️ 报修'],['visitors','🚶 访客'],['attends','🕒 打卡'],['desks','🪑 工位'],['ooo','🧳 外出']];
  const maxVal = Math.max(1, ...list.map((b) => Math.max(b.meetings, b.borrows, b.requests, b.repairs, b.visitors, b.attends, b.desks||0, b.ooo||0)));
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
