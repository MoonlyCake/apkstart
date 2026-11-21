'use strict';

const armFor = {
  x86_64: ['arm64-v8a'],
  x86: ['armeabi-v7a', 'armeabi'],
};
const arm = new Set(Object.values(armFor).flat());
const known = new Set([...Object.keys(armFor), ...arm, 'mips', 'mips64', 'riscv64']);
const isArmAbi = (abi) => arm.has(abi);

function nativeLibraries(names) {
  const groups = new Map();
  for (const entry of names) {
    const match = /^lib\/([a-z0-9_-]+)\/(lib[^/\\]+\.so)$/.exec(entry);
    if (!match || !known.has(match[1])) continue;
    if (!groups.has(match[1])) groups.set(match[1], new Set());
    groups.get(match[1]).add(match[2]);
  }
  return Object.fromEntries([...groups].map(([abi, libs]) => [abi, [...libs]]));
}

function thinAlternatives(meta) {
  const libs = meta?.nativeLibs;
  if (!libs || meta.explicitAbiPolicy) return {};
  const pairs = {};
  for (const [x86, translated] of Object.entries(armFor)) {
    const native = libs[x86];
    if (!native?.length || native.length > 4) continue;
    // 少量跨架构通用库不代表完整 x86 实现；只接受明显稀疏且无独有库的严格子集。
    const compatible = translated.filter((abi) => {
      const candidate = libs[abi];
      return candidate?.length >= Math.max(8, 3 * native.length)
        && native.every((lib) => candidate.includes(lib));
    });
    if (compatible.length) pairs[x86] = compatible;
  }
  return pairs;
}

function chooseAbi(meta, guestAbis, pairs = thinAlternatives(meta)) {
  if (!meta?.nativeLibs || !guestAbis.length) return null;
  const first = guestAbis.find((abi) => meta.nativeLibs[abi]?.length);
  if (!Object.hasOwn(pairs, first)) return null;
  // 另一个受支持的 x86 版本如果不是已证实的稀疏库，也交给 Android 选择。
  if (guestAbis.some((abi) => Object.hasOwn(armFor, abi) && meta.nativeLibs[abi]?.length && !pairs[abi])) return null;
  return guestAbis.find((abi) => pairs[first].includes(abi)) || null;
}

async function preferredArmAbi(meta, client) {
  const pairs = thinAlternatives(meta);
  if (Object.keys(pairs).length === 0) return null;
  try {
    const result = String(await client.shell('getprop ro.product.cpu.abilist', { timeout: 6000 })).trim();
    const guestAbis = result.split(',').map((abi) => abi.trim());
    if (!result || guestAbis.some((abi) => !/^[a-z0-9_-]+$/.test(abi))) return null;
    return chooseAbi(meta, guestAbis, pairs);
  } catch (_) { return null; }
}

module.exports = { nativeLibraries, preferredArmAbi, isArmAbi };
