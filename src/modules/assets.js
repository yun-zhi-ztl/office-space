'use strict';
// 资产台账模块：assetCreate / assetUpdate / assetDelete / assetCheck
// 管理员维护空间资产（固定资产 / 办公设备 / 家具 / 电器），成员可标记资产状态。
module.exports = function assetsModule(api) {
  const { ASSET_CATEGORIES, ASSET_STATUSES, ASSET_CONDITIONS, spaceUserInfo, assetsPublic, assetsStats, broadcast, LIST_PAGE, isAdmin, sendTo, serError, genId, saveEntity, deleteEntity, pushNotification, sendToAccount, checkAchievements, saveProfile, recordWeekly, broadcastLeaderboard } = api;

  function assetsBroadcast(space) {
    const info = spaceUserInfo(space.id);
    broadcast(space.id, 'assets', { assets: assetsPublic(space, info), stats: assetsStats(space) });
  }

  function handleAssets(ws, user, space, msg) {
    if (msg.type === 'assetCreate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可维护资产台账'));
      const name = (msg.name || '').trim().slice(0, 40);
      if (!name) return sendTo(ws, serError('请输入资产名称'));
      const category = ASSET_CATEGORIES.includes(msg.category) ? msg.category : '其它';
      const location = (msg.location || '').trim().slice(0, 40);
      const owner = (msg.owner || '').trim().slice(0, 40);
      const status = ASSET_STATUSES.includes(msg.status) ? msg.status : 'in_use';
      const note = (msg.note || '').trim().slice(0, 120);
      const now = Date.now();
      const asset = { id: genId('ast', null), name, category, location, owner, status, condition: 'intact', note, checks: [], inspects: [], inspectIntervalDays: Math.max(0, parseInt(msg.inspectIntervalDays, 10) || 0), lastCheckAt: 0, createdAt: now, updatedAt: now };
      space.assets.set(asset.id, asset);
      saveEntity(space.id, 'asset', asset.id, asset);
      assetsBroadcast(space);
    } else if (msg.type === 'assetUpdate') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可维护资产台账'));
      const asset = space.assets.get(msg.id);
      if (!asset) return sendTo(ws, serError('资产不存在'));
      if (msg.name !== undefined) {
        const name = (msg.name || '').trim().slice(0, 40);
        if (!name) return sendTo(ws, serError('请输入资产名称'));
        asset.name = name;
      }
      if (msg.category !== undefined && ASSET_CATEGORIES.includes(msg.category)) asset.category = msg.category;
      if (msg.location !== undefined) asset.location = (msg.location || '').trim().slice(0, 40);
      if (msg.owner !== undefined) asset.owner = (msg.owner || '').trim().slice(0, 40);
      if (msg.status !== undefined && ASSET_STATUSES.includes(msg.status)) asset.status = msg.status;
      if (msg.note !== undefined) asset.note = (msg.note || '').trim().slice(0, 120);
      if (msg.inspectIntervalDays !== undefined) asset.inspectIntervalDays = Math.max(0, parseInt(msg.inspectIntervalDays, 10) || 0);
      asset.updatedAt = Date.now();
      saveEntity(space.id, 'asset', asset.id, asset);
      assetsBroadcast(space);
    } else if (msg.type === 'assetDelete') {
      if (!isAdmin(space, user.account)) return sendTo(ws, serError('仅管理员可删除资产'));
      const asset = space.assets.get(msg.id);
      if (!asset) return sendTo(ws, serError('资产不存在'));
      space.assets.delete(asset.id);
      deleteEntity(space.id, 'asset', asset.id);
      assetsBroadcast(space);
    } else if (msg.type === 'assetCheck') {
      const asset = space.assets.get(msg.id);
      if (!asset) return sendTo(ws, serError('资产不存在'));
      if (!ASSET_CONDITIONS.includes(msg.condition)) return sendTo(ws, serError('无效的资产状态'));
      const note = (msg.note || '').trim().slice(0, 120);
      asset.condition = msg.condition;
      asset.checks = asset.checks || [];
      asset.checks.push({ account: user.account, accountName: user.nickname, condition: msg.condition, note, at: Date.now() });
      asset.updatedAt = Date.now();
      if (msg.condition !== 'intact' && asset.status !== 'scrapped') asset.status = 'maintenance';
      saveEntity(space.id, 'asset', asset.id, asset);
      assetsBroadcast(space);
      broadcastLeaderboard(space);
      if (msg.condition !== 'intact') {
        pushNotification(space, { type: 'assetChecked', level: msg.condition === 'missing' ? 'warn' : 'info', title: '资产状态变更', body: asset.name + ' · ' + ({ intact: '完好', damaged: '损坏', missing: '丢失' }[msg.condition]) });
        sendToAccount(asset.owner || '', { type: 'assetChecked', assetId: asset.id, assetName: asset.name, condition: msg.condition });
      }
    } else if (msg.type === 'assetInspect') {
      const asset = space.assets.get(msg.id);
      if (!asset) return sendTo(ws, serError('资产不存在'));
      if (msg.result !== 'pass' && msg.result !== 'issue' && msg.result !== 'fail') return sendTo(ws, serError('请选择巡检结果'));
      const note = (msg.note || '').trim().slice(0, 120);
      asset.inspects = asset.inspects || [];
      asset.inspects.push({ account: user.account, accountName: user.nickname, result: msg.result, note, at: Date.now() });
      asset.lastCheckAt = Date.now();
      if (msg.result !== 'pass') {
        asset.condition = msg.result === 'fail' ? 'damaged' : 'damaged';
        if (asset.status !== 'scrapped') asset.status = 'maintenance';
      }
      asset.updatedAt = Date.now();
      saveEntity(space.id, 'asset', asset.id, asset);
      assetsBroadcast(space);
      broadcastLeaderboard(space);
      pushNotification(space, { type: 'assetInspected', level: msg.result === 'pass' ? 'info' : 'warn', title: '资产巡检登记', body: asset.name + ' · ' + ({ pass: '通过', issue: '发现问题', fail: '不通过' }[msg.result]) + (note ? ' · ' + note : '') });
      if (msg.result !== 'pass') sendToAccount(asset.owner || '', { type: 'assetInspected', assetId: asset.id, assetName: asset.name, result: msg.result });
    }
  }

  return { handleAssets };
};
