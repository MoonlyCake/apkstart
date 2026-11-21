'use strict';

// 只有明确选择 Windows 麦克风的用户才收到 Emulator 的 host-audio 开关。
// 安卓播放和宿主采集分开；-no-audio 是总开关，会同时关闭这两条路径。
function resolve(engine, platform = process.platform) {
  const playback = engine?.audio !== false;
  const microphone = platform === 'win32' && engine?.hostMicrophone === true;
  return {
    key: `audio:${Number(playback)}${Number(microphone)}`,
    ini: [
      `hw.audioInput=${microphone ? 'yes' : 'no'}`,
      `hw.audioOutput=${playback ? 'yes' : 'no'}`,
    ],
    args: microphone ? ['-allow-host-audio'] : playback ? [] : ['-no-audio'],
  };
}

const AUDIO_INI_KEYS = new Set(['hw.audioInput', 'hw.audioOutput']);
const AUDIO_ARGS = new Set([
  'allow-host-audio', 'no-audio', 'noaudio', 'audio', 'audiodev', 'audio-in', 'audio-out', 'soundhw',
]);

function isAudioIniKey(key) { return AUDIO_INI_KEYS.has(key); }

// 保留加载既有驱动的能力，但从执行参数中排除这些音频开关。
function isAudioDriverArg(flag, value) {
  const token = flag === '-qemu' ? value : flag;
  const option = /^--?([\w-]+)(?:=|$)/.exec(token || '');
  return !!option && AUDIO_ARGS.has(option[1]);
}

module.exports = { resolve, isAudioIniKey, isAudioDriverArg };
