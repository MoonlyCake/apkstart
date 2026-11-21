'use strict';

/**
 * 内存 / CPU / 数据分区这几项会直接决定虚拟机怎么开、能装多大的游戏，
 * 保存前统一收敛一次：手改 settings.json、旧版本残留的离谱值都在这里被拉回来，
 * 免得开机时 qemu 因为 -memory 32 直接退出，或者分区填到比磁盘还大。
 */
const sanitizeResourcePatch = (patch) => {
  if (!patch || !patch.engine) return patch;
  const res = require('../core/resources');
  const host = res.hostProfile();
  const eng = { ...patch.engine };
  if ('memoryMB' in eng) {
    const c = res.clampMemoryMB(eng.memoryMB, host.totalMB);
    eng.memoryMB = c.mb;
    if (c.mb > 0) eng.autoMemory = false;
  }
  if ('cores' in eng) eng.cores = res.clampCores(eng.cores, host.cores).cores;
  if ('dataPartitionGB' in eng) {
    eng.dataPartitionGB = Math.max(0, Math.min(256, Number(eng.dataPartitionGB) || 0));
  }
  return { ...patch, engine: eng };
};

module.exports = { sanitizeResourcePatch };
