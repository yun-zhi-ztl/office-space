'use strict';
// 个人资料模块：profileUpdate（展示名/头像） / passwordChange（凭旧密码修改密码）
module.exports = function profileModule(api) {
  const { accounts, sendTo, serError, broadcastUsers, saveAccount, saveProfile, hashPassword, verifyPassword } = api;

  function handleProfile(ws, user, space, msg) {
    if (msg.type === 'profileUpdate') {
      const nickname = (msg.nickname || '').trim().slice(0, 12) || user.nickname;
      const avatar = (msg.avatar || '').slice(0, 4) || user.avatar;
      user.nickname = nickname;
      user.avatar = avatar;
      const acct = accounts.get(user.account);
      if (acct) { acct.username = nickname; acct.avatar = avatar; saveAccount(acct); }
      saveProfile(user);
      broadcastUsers(space);
      sendTo(ws, { type: 'profileUpdated', nickname: user.nickname, avatar: user.avatar });
    } else if (msg.type === 'passwordChange') {
      const oldPassword = String(msg.oldPassword || '');
      const newPassword = String(msg.newPassword || '');
      if (!oldPassword || !newPassword) return sendTo(ws, serError('请输入旧密码和新密码'));
      if (newPassword.length > 128) return sendTo(ws, serError('新密码过长'));
      const acct = accounts.get(user.account);
      if (!acct) return sendTo(ws, serError('账号不存在'));
      if (!verifyPassword(oldPassword, acct.passwordHash)) return sendTo(ws, serError('旧密码错误'));
      acct.passwordHash = hashPassword(newPassword);
      saveAccount(acct);
      sendTo(ws, { type: 'passwordChanged' });
    }
  }

  return { handleProfile };
};
