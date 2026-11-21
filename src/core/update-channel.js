'use strict';

const OWNER = 'MoonlyCake';
const REPO = 'apkstart';
const CHANNEL = OWNER + '/' + REPO;
const RELEASES_URL = 'https://github.com/' + CHANNEL + '/releases';
const LATEST_API = 'https://api.github.com/repos/' + CHANNEL + '/releases/latest';
const CACHE_TTL = 10 * 60 * 1000;

function versionFromTag(tag) {
  return typeof tag === 'string' && /^v?(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/.test(tag)
    ? tag.replace(/^v/, '') : '';
}

function matchesReleaseUrl(raw, suffix) {
  if (typeof raw !== 'string') return false;
  try {
    const url = new URL(raw);
    const prefix = '/' + CHANNEL + '/releases';
    return url.origin === 'https://github.com' && !url.username && !url.password && !url.search && !url.hash
      && url.pathname.slice(0, prefix.length).toLowerCase() === prefix.toLowerCase()
      && url.pathname.slice(prefix.length) === suffix;
  } catch (_) {
    return false;
  }
}

function releasePageUrl(raw) {
  const match = typeof raw === 'string' && /\/tag\/([^/]+)$/.exec(raw);
  const tag = match && match[1];
  return versionFromTag(tag) && matchesReleaseUrl(raw, '/tag/' + tag)
    ? RELEASES_URL + '/tag/' + tag : RELEASES_URL;
}

function releaseAssetUrl(asset, tag) {
  if (!asset || typeof asset.name !== 'string' || !/^ApkStart[A-Za-z0-9._-]+$/i.test(asset.name) || !versionFromTag(tag)) {
    return '';
  }
  const suffix = '/download/' + tag + '/' + asset.name;
  return matchesReleaseUrl(asset.url, suffix) ? RELEASES_URL + suffix : '';
}

class UpdateChannel {
  constructor(fetchRelease = globalThis.fetch) {
    this.fetchRelease = fetchRelease;
    this.cached = null;
    this.inFlight = null;
  }

  async latest({ force = false } = {}) {
    // 手动刷新可以跳过已有缓存，但不用和后台检查争用或覆盖同一份结果。
    if (this.inFlight) return this.inFlight;
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_TTL) return this.cached.release;
    this.inFlight = this._fetchLatest().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async _fetchLatest() {
    // 安装程序只认本 fork；运行时的 Gitee / 镜像设置不参与版本检查。
    const response = await this.fetchRelease(LATEST_API, {
      headers: { Accept: 'application/vnd.github+json' },
      redirect: 'error',
      signal: AbortSignal.timeout(9000),
    });
    let release = null;
    if (response.status !== 404) {
      if (!response.ok) throw new Error('GitHub 发布服务返回 HTTP ' + response.status);
      const data = await response.json();
      const tag = data?.tag_name;
      const version = versionFromTag(tag);
      if (!version || data.draft || data.prerelease) throw new Error('GitHub 返回的正式版本无效');

      const assets = [];
      for (const item of Array.isArray(data.assets) ? data.assets : []) {
        const asset = { name: item?.name, size: Number(item?.size) || 0, url: item?.browser_download_url };
        const url = releaseAssetUrl(asset, tag);
        if (url) assets.push({ ...asset, url });
      }
      release = {
        tag, version, assets,
        name: data.name || tag,
        notes: data.body || '',
        publishedAt: data.published_at || '',
        htmlUrl: RELEASES_URL + '/tag/' + tag,
      };
    }
    this.cached = { at: Date.now(), release };
    return release;
  }
}

module.exports = { UpdateChannel, OWNER, REPO, CHANNEL, RELEASES_URL, releasePageUrl, releaseAssetUrl, versionFromTag };
