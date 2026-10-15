'use strict';
// 考勤打卡模块：attendConfig（管理员配置）/ attendCheckIn / attendCheckOut（成员打卡）
module.exports = function attendanceModule(api) {
  const { attendanceBroadcast, attendancePublic, attendanceStats, attendanceStreak, attendancePerfectMonths, newAttendanceConfig, todayKey, parseTime, isLateAt, broadcast, sendTo, serError, genId, saveEntity, saveProfile, recordWeekly, checkAchievements, isAdmin, sendToAccount } = api;

  function handleAttendance(ws, user, space, msg) {
    const now = Date.now();
    const date = todayKey(now);
    const key = `${user.account}::${date}`;

    if (msg.type === 'attendConfig') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可配置考勤规则'));
      const start = parseTime(msg.workStart);
      const end = parseTime(msg.workEnd);
      if (start == null || end == null) return sendTo(ws, serError('工作时间格式应为 HH:MM'));
      if (start >= end) return sendTo(ws, serError('下班时间需晚于上班时间'));
      const lateMinutes = msg.lateMinutes === undefined || msg.lateMinutes === '' ? api.ATTEND_DEFAULT_LATE_MINUTES : parseInt(msg.lateMinutes, 10);
      if (!Number.isInteger(lateMinutes) || lateMinutes < 0 || lateMinutes > 600) return sendTo(ws, serError('迟到宽限分钟需为 0-600'));
      space.attendanceConfig = { workStart: msg.workStart.trim(), workEnd: msg.workEnd.trim(), lateMinutes };
      saveEntity(space.id, 'attendance', 'config', space.attendanceConfig);
      attendanceBroadcast(space);
    } else if (msg.type === 'attendCheckIn') {
      if (space.paused) return sendTo(ws, serError('空间已暂停，暂不可打卡'));
      if (space.attendance.has(key)) return sendTo(ws, serError('今天已经打过上班卡了'));
      const cfg = space.attendanceConfig || newAttendanceConfig();
      const rec = { id: genId('at', null), account: user.account, name: user.nickname, date, checkInAt: now, checkOutAt: null, isLate: isLateAt(now, cfg), status: 'checked_in', workedMinutes: 0 };
      space.attendance.set(key, rec);
      user.stats.attendanceCount = (user.stats.attendanceCount || 0) + 1;
      if (!rec.isLate) user.stats.earlyCount = (user.stats.earlyCount || 0) + 1;
      user.stats.attendanceStreak = Math.max(user.stats.attendanceStreak || 0, attendanceStreak(space, user.account, now));
      user.stats.attendancePerfectMonths = attendancePerfectMonths(space, user.account);
      recordWeekly(user, 'attends');
      checkAchievements(user);
      saveProfile(user);
      saveEntity(space.id, 'attendance_record', rec.id, rec);
      attendanceBroadcast(space);
      sendToAccount(user.account, { type: 'attendanceCheckedIn', isLate: rec.isLate });
    } else if (msg.type === 'attendCheckOut') {
      const rec = space.attendance.get(key);
      if (!rec) return sendTo(ws, serError('还没有打卡记录，请先打上班卡'));
      if (rec.checkOutAt) return sendTo(ws, serError('今天已经打过下班卡了'));
      rec.checkOutAt = now;
      rec.workedMinutes = Math.max(0, Math.round((rec.checkOutAt - rec.checkInAt) / 60000));
      rec.status = 'checked_out';
      saveEntity(space.id, 'attendance_record', rec.id, rec);
      attendanceBroadcast(space);
      sendToAccount(user.account, { type: 'attendanceCheckedOut', workedMinutes: rec.workedMinutes });
    }
  }

  return { handleAttendance, attendanceBroadcast, attendancePublic, attendanceStats };
};
