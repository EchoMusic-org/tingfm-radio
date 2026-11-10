// ============================================================
// 听FM网络电台 —— 浏览器直连播放版
// 电台列表以云端 data.json 为权威，首次或更新时回写本地缓存，
// 机制参考抓取插件（本地兜底 + 每日版本检查）。
// data.json 仅提供 { id, img }，音频流地址 fmurl 在播放时实时
// 按 id 向 tingfm.net 接口获取（参考 tingfm-data/fetch.js）。
// 真实声音由浏览器 <audio>/Hls 直接输出；电台曲目会通过音源
// 解析接口注册一个本地静音 WAV 占位源：引擎正常进入播放态，
// 不再因解析不到音源而弹「播放失败」并自动切歌；播放/暂停/
// 音量/进度联动均由宿主原生驱动，插件只需同步浏览器音频。
// ============================================================
export default async function (ctx) {
  const { defineComponent, h, ref, watch, computed } = ctx.vue

  // ---------------- 本地数据层（data.json） ----------------
  // 结构：{ version, update, fmdata: { 大区: { 地域: { 电台名: { id, img } } } } }
  // 注意：data.json 不再提供 fmurl，流地址统一在播放时实时按 id 获取（见 fetchFmUrl）
  let fmData = null
  let regionGroups = []
  let stationById = new Map()
  let flatStations = []

  // 兜底：img 为空时使用的默认占位图标
  const DEFAULT_LOGO_EMOJI = '📻'

  // 云端数据源（本地 data.json 仅为回写缓存），机制参考 github-accelerate
  const DATA_URL = 'https://oss.xt-url.com/EchoMusic/tingfm-radio/data.json'
  const DATA_PATH = () => `${ctx.descriptor.directory}/data.json`

  // 实时流地址接口（参考 tingfm-data/fetch.js 的获取方式）
  const STREAM_API = 'https://tingfm.net/wp-json/query/wndt_streams'
  // 会话级流地址缓存：postId -> { url, exp }，exp 到期后重新拉取
  const streamCache = new Map()

  // 按电台 id 实时获取 fmurl：优先 m3u8，否则取第一个有 url 的流
  async function fetchFmUrl(postId) {
    const cached = streamCache.get(postId)
    if (cached && (typeof cached.exp !== 'number' || cached.exp > Math.floor(Date.now() / 1000))) {
      return cached.url
    }
    const res = await ctx.net.fetch(`${STREAM_API}?post_id=${postId}&in_web=true`, {
      headers: {
        'Referer': 'https://tingfm.net/',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Safari/537.36',
      },
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const payload = await res.json()
    let fmurl = ''
    let exp = undefined
    if (payload && payload.status === 1 && payload.data && Array.isArray(payload.data.streams)) {
      const list = payload.data.streams
      const m3u8 = list.find((s) => s.type === 'm3u8' && s.url)
      fmurl = m3u8 ? m3u8.url : (list.find((s) => s.url) || {}).url || ''
      if (typeof payload.data.exp === 'number') exp = payload.data.exp
    }
    streamCache.set(postId, { url: fmurl, exp })
    return fmurl
  }

  // 简易 semver 比较，x.y.z 格式
  const compareVersion = (a, b) => {
    const pa = String(a || '').split('.').map(Number)
    const pb = String(b || '').split('.').map(Number)
    for (let i = 0; i < 3; i++) {
      if ((pa[i] || 0) > (pb[i] || 0)) return 1
      if ((pa[i] || 0) < (pb[i] || 0)) return -1
    }
    return 0
  }

  // 获取今日日期字符串 YYYY-MM-DD
  const todayStr = () => new Date().toISOString().slice(0, 10)

  // 从云端获取 data.json
  const fetchRemoteFmData = async () => {
    const res = await ctx.net.fetch(DATA_URL)
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    const text = await res.text()
    const cfg = JSON.parse(text)
    if (!cfg || typeof cfg.fmdata !== 'object') throw new Error('云端 fmdata 字段无效')
    return { text, cfg }
  }

  async function loadFmData() {
    let loadedFromRemote = false
    // 1. 本地兜底：读插件目录 data.json 缓存
    try {
      const result = await ctx.fs.readTextFile(DATA_PATH())
      if (result && result.ok) {
        fmData = JSON.parse(result.content)
      }
    } catch (err) {
      console.warn('[TingFM] 本地 data.json 缺失或损坏:', err.message)
      fmData = null
    }

    // 2. 本地缺失/损坏则云端拉取并回写
    if (!fmData) {
      try {
        const { text, cfg } = await fetchRemoteFmData()
        fmData = cfg
        loadedFromRemote = true
        await ctx.fs.writeFile(DATA_PATH(), text, { overwrite: true })
      } catch (err) {
        console.error('[TingFM] 加载电台数据失败:', err)
        ctx.toast?.danger && ctx.toast.danger(`加载电台数据失败: ${err.message}`)
        fmData = null
        regionGroups = []
        stationById = new Map()
        flatStations = []
        return
      }
    }

    // 3. 每日首次运行时检查云端更新
    if (!loadedFromRemote) {
      const lastUpdateDate = await ctx.storage.get('lastUpdateDate')
      if (lastUpdateDate !== todayStr()) {
        try {
          const { text, cfg } = await fetchRemoteFmData()
          if (cfg.version && compareVersion(cfg.version, fmData.version) > 0) {
            const writeResult = await ctx.fs.writeFile(DATA_PATH(), text, { overwrite: true })
            if (writeResult.ok) fmData = cfg
          }
        } catch {
          /* 静默失败，继续使用本地数据 */
        }
        await ctx.storage.set('lastUpdateDate', todayStr())
      }
    } else {
      /* 已从云端加载，标记今日已检查 */
      await ctx.storage.set('lastUpdateDate', todayStr())
    }

    buildStationsIndex()
  }

  // 依据 data.json 结构构建内存索引：大区 -> 地域 -> 电台
  function buildStationsIndex() {
    regionGroups = []
    stationById = new Map()
    flatStations = []
    const fmRoot = fmData && fmData.fmdata
    if (!fmRoot || typeof fmRoot !== 'object') return
    for (const groupName of Object.keys(fmRoot)) {
      const regionsMap = fmRoot[groupName]
      if (!regionsMap || typeof regionsMap !== 'object') continue
      const regions = []
      for (const regionName of Object.keys(regionsMap)) {
        const stationsMap = regionsMap[regionName]
        if (!stationsMap || typeof stationsMap !== 'object') continue
        const stations = []
        for (const title of Object.keys(stationsMap)) {
          const raw = stationsMap[title] || {}
          const id = String(raw.id != null ? raw.id : title)
          const station = {
            id,
            title,
            coverUrl: String(raw.img || ''),
          }
          stations.push(station)
          if (!stationById.has(id)) stationById.set(id, station)
          flatStations.push(station)
        }
        regions.push({ name: regionName, stations })
      }
      regionGroups.push({ name: groupName, regions })
    }
  }

  // ---------------- 浏览器音频层（真实声音） ----------------
  const audio = new Audio()
  audio.crossOrigin = 'anonymous'
  audio.preload = 'auto'
  audio.loop = false
  let hls = null
  // 当前正在播放的电台 id（null 表示未播放）
  const currentPlayingId = ref(null)
  let currentStreamUrl = null

  // ---------------- 浏览器音频控制 ----------------
  function destroyHls() {
    if (hls) {
      try { hls.destroy() } catch (e) { /* 忽略 */ }
      hls = null
    }
  }

  function attachStream(url) {
    destroyHls()
    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: false })
      hls.loadSource(url)
      hls.attachMedia(audio)
      hls.on(Hls.Events.ERROR, (_, data) => {
        if (!data || !data.fatal) return
        if (data.type === Hls.ErrorTypes.NETWORK_ERROR) {
          hls && hls.startLoad()
        } else if (data.type === Hls.ErrorTypes.MEDIA_ERROR) {
          hls && hls.recoverMediaError()
        } else {
          destroyHls()
        }
      })
      return
    }
    if (audio.canPlayType('application/vnd.apple.mpegurl')) {
      audio.src = url
      return
    }
    throw new Error('当前环境不支持 HLS 流播放')
  }

  function safePlay(retries = 3) {
    const attempt = () => {
      const p = audio.play()
      if (!p || typeof p.catch !== 'function') return Promise.resolve()
      return p.catch((err) => {
        // 自动播放可能被浏览器拦截，短暂延迟后重试
        if (retries > 0 && err && err.name === 'NotAllowedError') {
          return new Promise((resolve) => {
            window.setTimeout(() => {
              resolve(safePlay(retries - 1))
            }, 300)
          })
        }
        return undefined
      })
    }
    return attempt()
  }

  async function playStationAudio(url, isHls) {
    if (isHls || /\.m3u8(\?|#|$)/i.test(url)) {
      attachStream(url)
    } else {
      destroyHls()
      audio.src = url
    }
    await safePlay()
  }

  function resumeStationAudio() {
    if (audio.src || hls) {
      void safePlay(2)
    }
  }

  function pauseStationAudio() {
    audio.pause()
  }

  function stopStationAudio() {
    pauseStationAudio()
    destroyHls()
    audio.removeAttribute('src')
    audio.load()
    currentPlayingId.value = null
    currentStreamUrl = null
  }

  function setBrowserVolume(v) {
    const n = Number(v)
    // 主程序音量 ctx.player.volume 量程为 0-100，需换算为 audio.volume 的 0-1
    audio.volume = Number.isFinite(n) ? Math.min(1, Math.max(0, n / 100)) : 1
  }

  // ---------------- 引擎占位音源（本地静音 WAV） ----------------
  // 电台曲目仅用于底栏展示，真实声音由上面的浏览器音频输出。若让引擎
  // 自己解析 url 为空的电台曲目，会触发「播放失败 · 暂时无法获取可用
  // 音源」，并在队列里还有其他歌曲时 3 秒后自动切歌，把真声音一起带走。
  // 因此向引擎注册一个本地静音 WAV 占位音源：引擎正常进入播放态，失败
  // 链路不再触发；占位源接近播完时回拉进度，避免自然结束触发切歌。
  //
  // 时长与回拉阈值的选择依据宿主引擎的无缝/智能混音预取窗口：
  // 引擎在「距结尾 30 秒（无缝 gapless）～75 秒（智能混音 automix）」就会
  // 预取下一首并提前无缝切换，所以占位源必须远长于该窗口、并且进度必须在
  // 进入预取窗口之前回拉到位，否则仍会被切走。这里取 180 秒 + 30 秒回拉，
  // 保证 currentTime 始终远离 180-75=105 秒的预取边界。
  const SILENCE_WAV_SECONDS = 180
  const SILENCE_SEEK_BACK_AT_SECS = 30
  let silenceSourceUrl = null
  let silenceSourcePromise = null

  // 生成 8kHz 16bit 单声道、全零采样的 WAV（数据段无需填充，默认即为静音）
  function buildSilenceWav() {
    const sampleRate = 8000
    const channels = 1
    const bitsPerSample = 16
    const bytesPerSample = bitsPerSample / 8
    const dataBytes = sampleRate * channels * bytesPerSample * SILENCE_WAV_SECONDS
    const buffer = new ArrayBuffer(44 + dataBytes)
    const view = new DataView(buffer)
    const writeText = (offset, text) => {
      for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
    }
    writeText(0, 'RIFF')
    view.setUint32(4, 36 + dataBytes, true)
    writeText(8, 'WAVE')
    writeText(12, 'fmt ')
    view.setUint32(16, 16, true)
    view.setUint16(20, 1, true) // PCM
    view.setUint16(22, channels, true)
    view.setUint32(24, sampleRate, true)
    view.setUint32(28, sampleRate * channels * bytesPerSample, true)
    view.setUint16(32, channels * bytesPerSample, true)
    view.setUint16(34, bitsPerSample, true)
    writeText(36, 'data')
    view.setUint32(40, dataBytes, true)
    return buffer
  }

  // 生成（或复用）插件目录下的静音 WAV，并转成引擎可加载的 file:// 地址
  async function ensureSilenceSource() {
    if (silenceSourceUrl) return silenceSourceUrl
    if (!silenceSourcePromise) {
      silenceSourcePromise = (async () => {
        const path = `${ctx.descriptor.directory}/silence.wav`
        const writeResult = await ctx.fs.writeFile(path, buildSilenceWav(), { overwrite: true })
        if (writeResult && writeResult.ok === false) {
          throw new Error(writeResult.error || '静音占位音源写入失败')
        }
        const urlResult = await ctx.fs.getFileUrl(path)
        if (!urlResult || urlResult.ok === false || !urlResult.url) {
          throw new Error((urlResult && urlResult.error) || '静音占位音源地址获取失败')
        }
        silenceSourceUrl = urlResult.url
        return silenceSourceUrl
      })()
      silenceSourcePromise.catch(() => {
        // 失败后允许下次重试
        silenceSourcePromise = null
      })
    }
    return silenceSourcePromise
  }

  // ---------------- 数据访问（本地内存索引，无网络请求） ----------------
  function getStationById(postId) {
    return stationById.get(String(postId)) || null
  }

  function searchStations(keyword) {
    const kw = String(keyword || '').trim()
    if (!kw) return []
    return flatStations.filter((s) => s.title.indexOf(kw) >= 0)
  }

  function getRegionStations(regionName) {
    for (const group of regionGroups) {
      const region = group.regions.find((r) => r.name === regionName)
      if (region) return region.stations
    }
    return []
  }

  function getDefaultRegion() {
    const firstGroup = regionGroups[0]
    return firstGroup && firstGroup.regions[0] ? firstGroup.regions[0] : null
  }

  async function loadSavedStations() {
    const rows = await ctx.storage.get('stations')
    savedStations.value = Array.isArray(rows) ? rows : []
    await saveStations()
  }

  async function saveStations() {
    await ctx.storage.set('stations', savedStations.value)
  }

  // 已保留的电台若在 data.json 中有最新数据，则回填标题/封面
  // 收藏项仅保存 id + addedAt，其余元数据由 data.json 实时解析
  function savedItem(id) {
    return { id: String(id), addedAt: Date.now() }
  }

  // 渲染/播放时把收藏项(id)解析为完整电台数据（含 title/coverUrl，fmurl 由 fetchFmUrl 实时获取）
  function fillSavedStation(station) {
    const current = getStationById(station.id)
    if (!current) {
      return { ...station, title: station.title || `电台 ${station.id}`, coverUrl: '' }
    }
    return { ...station, ...current }
  }

  // 电台 LOGO 渲染：有图用图，无图用默认占位
  function renderStationLogo(item, size = 44) {
    const coverUrl = item && item.coverUrl
    if (coverUrl) {
      return h('img', {
        class: 'tf-logo',
        src: coverUrl,
        alt: (item && item.title) || '',
        style: { width: size + 'px', height: size + 'px' },
      })
    }
    return h('div', {
      class: 'tf-logo',
      style: {
        background: 'linear-gradient(135deg, #e74c3c, #c0392b)',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: '#fff',
        fontSize: '18px',
        width: size + 'px',
        height: size + 'px',
      },
    }, DEFAULT_LOGO_EMOJI)
  }

  function createStationSong(station) {
    return {
      id: `tingfm:${station.id}`,
      title: station.title || `电台 ${station.id}`,
      name: station.title || `电台 ${station.id}`,
      artist: '听FM网络电台',
      artists: [{ name: '听FM网络电台' }],
      singers: [{ name: '听FM网络电台' }],
      album: station.title || '',
      albumName: station.title || '',
      coverUrl: station.coverUrl || '',
      url: '',
      audioUrl: '',
      hash: String(station.id),
      source: 'tingfm',
      songId: String(station.id),
      mixSongId: 0,
      albumAudioId: '',
      fileId: station.id ? Number(station.id) : undefined,
    }
  }

  // 播放（插件自治）：播放时实时按 id 获取 fmurl 驱动浏览器音频播放
  // playSong 仅用于把电台放进引擎队列、让宿主底栏显示标题/封面，
  // 引擎本身不参与真实播放（不投喂音频数据）。
  async function playStation(station) {
    const postId = String(station.id || '')
    if (!postId) return
    // 统一按 id 解析 data.json 最新元数据（收藏/搜索/分区均可获得标题与封面）
    const resolved = getStationById(postId) || station
    let streamUrl
    try {
      streamUrl = await fetchFmUrl(postId)
    } catch (err) {
      console.warn('[TingFM] 获取直播源失败:', err)
      ctx.toast.danger('获取直播源失败，请重试')
      return
    }
    if (!streamUrl) {
      ctx.toast.warning('该电台暂无可用直播源')
      return
    }
    currentPlayingId.value = postId
    const isHls = /\.m3u8(\?|#|$)/i.test(streamUrl)
    if (currentStreamUrl === streamUrl) {
      void resumeStationAudio()
    } else {
      currentStreamUrl = streamUrl
      void playStationAudio(streamUrl, isHls)
    }
    const song = createStationSong(resolved)
    if (typeof ctx.player?.playSong === 'function') {
      ctx.player.playSong(song)
    } else if (typeof ctx.player?.replaceQueueAndPlay === 'function') {
      ctx.player.replaceQueueAndPlay([song])
    }
  }

  function stopCurrent() {
    stopStationAudio()
    try {
      if (typeof ctx.player?.stop === 'function') ctx.player.stop()
    } catch (e) { /* 忽略 */ }
  }

  // 点卡切换：未播放则播放，正在播放则停止
  function handlePlayToggle(station) {
    if (currentPlayingId.value === station.id) {
      stopCurrent()
    } else {
      void playStation(station)
    }
  }

  async function addStation(postId) {
    if (savedStations.value.some((s) => s.id === postId)) {
      ctx.toast.info('该电台已添加')
      return
    }
    const meta = getStationById(postId)
    if (!meta) {
      ctx.toast.danger('未找到该电台')
      return
    }
    savedStations.value.push(savedItem(meta.id))
    await saveStations()
    ctx.toast.success(`已添加「${meta.title}」`)
  }

  async function removeStation(postId) {
    if (currentPlayingId.value === postId) stopCurrent()
    savedStations.value = savedStations.value.filter((s) => s.id !== postId)
    await saveStations()
  }

  function isStationSaved(postId) {
    return savedStations.value.some((s) => s.id === postId)
  }

  // 底栏红心收藏切换：命中正在播放的电台时，加入/移除插件的「我的电台」列表
  // 仅改动收藏列表，不停止音频（区别于列表删除按钮 removeStation 会停播）
  async function toggleFavoriteStation() {
    const postId = currentPlayingId.value
    if (!postId) return
    const meta = getStationById(postId)
    if (!meta) return
    if (isStationSaved(postId)) {
      savedStations.value = savedStations.value.filter((s) => s.id !== postId)
      await saveStations()
      ctx.toast.info(`已取消收藏「${meta.title}」`)
    } else {
      savedStations.value.push(savedItem(meta.id))
      await saveStations()
      ctx.toast.success(`已收藏「${meta.title}」`)
    }
    syncRadioFavorite()
  }

  // 我的电台列表（收藏）
  let savedStations = ref([])

  // ================= 引擎播放状态联动（替代旧的播放按钮劫持） =================
  // 电台曲目在引擎侧播的是静音占位音源，真实声音由插件浏览器音频输出。
  // 底栏播放/暂停按钮、系统媒体键、蓝牙耳机的暂停恢复都由引擎原生处理，
  // 插件只需监听引擎 isPlaying 同步浏览器音频：
  // - 引擎暂停 -> 浏览器音频同步暂停；引擎恢复 -> 同步恢复
  // - 插件页「停止」会清空音频源，引擎再次进入播放态时重新拉流播放
  const isOurTrackActive = () => {
    const id = ctx.player.currentTrackId ? ctx.player.currentTrackId.value : null
    return !!id && String(id).startsWith('tingfm:') && !!currentPlayingId.value
  }

  const playingWatch = watch(
    () => (ctx.player.isPlaying ? ctx.player.isPlaying.value : false),
    (playing) => {
      const id = ctx.player.currentTrackId ? ctx.player.currentTrackId.value : null
      if (!id || !String(id).startsWith('tingfm:')) return
      if (!playing) {
        pauseStationAudio()
        return
      }
      if (currentPlayingId.value && (audio.src || hls)) {
        void safePlay(2)
        return
      }
      // 音频源缺失（如插件页停止后再按底栏播放）：按引擎曲目 id 重新拉流
      const postId = currentPlayingId.value || String(id).slice('tingfm:'.length)
      const station = getStationById(postId)
      if (station) void playStation(station)
    },
  )

  // 占位音源时长很长（180 秒），在引擎进入无缝/智能混音预取窗口前
  // 就把进度拉回开头，避免占位源接近结尾被引擎预取下一首而无缝切走
  const progressWatch = watch(
    () => (ctx.player.currentTime ? ctx.player.currentTime.value : 0),
    (time) => {
      if (!currentPlayingId.value) return
      const playing = ctx.player.isPlaying ? ctx.player.isPlaying.value : false
      if (playing && isOurTrackActive() && time > SILENCE_SEEK_BACK_AT_SECS) {
        ctx.player.seek(0)
      }
    },
  )

  // 宿主音量变化 -> 浏览器音频
  const stopVolumeWatch = watch(
    () => (ctx.player.volume ? ctx.player.volume.value : 0),
    (v) => setBrowserVolume(v),
    { immediate: true },
  )
  // 宿主切到非电台曲目 -> 停止本插件播放
  const stopTrackWatch = watch(
    () => (ctx.player.currentTrackId ? ctx.player.currentTrackId.value : null),
    (id) => {
      if (id && !String(id).startsWith('tingfm:')) stopStationAudio()
      syncErrorBadgeClass()
    },
  )

  // ---------------- 屏蔽引擎播放失败的红色感叹号 ----------------
  // 电台曲目仅用于底栏展示，引擎并未真实播放，其音源解析失败会触发
  // 底栏 .player-error-indicator 红色感叹号。命中电台曲目时给 body
  // 挂一个 class，用 CSS 隐藏该徽标；非电台曲目时移除。
  const HIDE_ERROR_CLASS = 'tf-hide-radio-error'
  const syncErrorBadgeClass = () => {
    try {
      const api = ctx.player && ctx.player.currentTrackId
      const id = api ? api.value : null
      const hide = !!id && String(id).startsWith('tingfm:') && !!currentPlayingId.value
      document.body.classList.toggle(HIDE_ERROR_CLASS, hide)
    } catch (e) { /* 忽略 */ }
  }
  const errorBadgeWatch = watch(
    () => {
      const api = ctx.player && ctx.player.currentTrackId
      return api ? api.value : null
    },
    () => syncErrorBadgeClass(),
    { immediate: true },
  )
  // 兜底：徽标出现且命中电台曲目时，直接隐藏该元素，避免时序漏网。
  // 目标都在底栏内，观察根收敛到 .player-bar，避免 body 级全文档扫描；
  // 底栏尚未挂载时退回 body 观察（宿主初始 scan 会兜底命中）
  const playerBarRoot = typeof document !== 'undefined' ? document.querySelector('.player-bar') : null
  const errBadgeObserve = ctx.dom.observe('.player-error-indicator', (el) => {
    if (isOurTrackActive() && el && typeof el.style !== 'undefined') {
      el.style.display = 'none'
    }
  }, playerBarRoot ? { root: playerBarRoot } : undefined)

  // ================= 劫持底栏收藏(红心)按钮 =================
  // 命中本插件正在播放的电台曲目时，截获底栏 .player-bar button[title="收藏"]
  // 的 click，改为操作插件「我的电台」列表。
  // 红心点亮/熄灭不再直接改 DOM，而是把电台歌曲以 { source:'tingfm' } 身份
  // 写进/移出宿主 playlist.favorites，宿主 isFavorite 响应式系统据此自动渲染。
  const playlistStore = ctx.stores && ctx.stores.playlist

  const isHeartFaved = () => {
    return isOurTrackActive() && isStationSaved(currentPlayingId.value)
  }

  // 同步宿主收藏数据：把正在播放且已收藏的电台写入宿主 favorites，
  // 否则从 favorites 中清除本插件的临时收藏条目（按 source 标记识别）。
  function syncRadioFavorite() {
    if (!playlistStore || !Array.isArray(playlistStore.favorites)) return
    try {
      const current = playlistStore.favorites
      const next = current.filter((s) => !s || s.source !== 'tingfm')
      if (isHeartFaved()) {
        const station = getStationById(currentPlayingId.value) || fillSavedStation({
          id: currentPlayingId.value,
        })
        if (station && station.title) {
          next.unshift(createStationSong(station))
        }
      }
      if (next.length !== current.length || next[0] !== current[0]) {
        playlistStore.favorites = next
      }
    } catch (err) {
      console.warn('[TingFM] 同步宿主收藏数据失败:', err)
    }
  }

  let favoriteClickListener = null
  const hijackFavorite = (btn) => {
    if (!favoriteClickListener) {
      favoriteClickListener = (e) => {
        if (!isOurTrackActive()) return
        e.preventDefault()
        e.stopImmediatePropagation()
        void toggleFavoriteStation()
      }
    }
    btn.addEventListener('click', favoriteClickListener, true)
  }
  // 收藏按钮同样收敛到底栏根，理由同上
  const removeFavoriteHijack = ctx.dom.observe(
    '.player-bar button[title="收藏"]',
    hijackFavorite,
    playerBarRoot ? { root: playerBarRoot } : undefined,
  )

  // 播放电台/收藏列表变化时同步宿主红心数据
  const favoriteStateWatch = watch(
    () => {
      const id = currentPlayingId.value
      const faved = id && isStationSaved(id) ? id + ':1' : (id || '') + ':0'
      return faved
    },
    () => syncRadioFavorite(),
    { immediate: true },
  )

  // ---------------- 样式 ----------------
  const removeStyle = ctx.css.inject(`
    .tf-station-card {
      display: flex;
      align-items: center;
      gap: 14px;
      height: 72px;
      padding: 0 18px;
      border-radius: 16px;
      background: var(--color-bg-elevated);
      border: 1px solid var(--border-subtle);
      cursor: pointer;
      transition: all 0.15s;
    }
    .tf-station-card:hover {
      background: var(--color-bg-secondary);
    }
    .tf-station-card .tf-logo {
      width: 44px;
      height: 44px;
      border-radius: 12px;
      object-fit: cover;
      flex-shrink: 0;
      background: var(--color-bg-tertiary);
    }
    .tf-station-card .tf-info {
      flex: 1;
      min-width: 0;
    }
    .tf-station-card .tf-name {
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text-main);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tf-station-card .tf-meta {
      font-size: 12px;
      color: color-mix(in srgb, var(--color-text-main) 60%, transparent);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .tf-station-card .tf-action {
      width: 30px;
      height: 30px;
      border-radius: 10px;
      display: flex;
      align-items: center;
      justify-content: center;
      background: color-mix(in srgb, var(--color-primary) 12%, transparent);
      color: var(--color-primary);
      cursor: pointer;
      flex-shrink: 0;
    }
    .tf-station-card .tf-action:hover {
      opacity: 0.85;
    }
    .tf-station-card .tf-action.active {
      background: var(--color-primary);
      color: #fff;
    }
    .tf-search-bar {
      display: flex;
      gap: 8px;
      margin-bottom: 16px;
    }
    .tf-search-bar input {
      flex: 1;
      padding: 8px 14px;
      border-radius: 10px;
      border: 1px solid var(--border-subtle);
      background: var(--color-bg-elevated);
      color: var(--color-text-main);
      font-size: 14px;
      outline: none;
    }
    .tf-search-bar input:focus {
      border-color: var(--color-primary);
    }
    .tf-search-bar button {
      padding: 8px 18px;
      border-radius: 10px;
      border: none;
      background: var(--color-primary);
      color: #fff;
      font-size: 14px;
      cursor: pointer;
    }
    .tf-search-bar button:hover {
      opacity: 0.9;
    }
    .tf-search-bar button:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
    .tf-section-title {
      font-size: 14px;
      font-weight: 600;
      color: var(--color-text-secondary);
      margin: 16px 0 10px;
      display: flex;
      align-items: center;
      gap: 8px;
    }
    .tf-empty {
      text-align: center;
      padding: 32px 16px;
      color: var(--color-text-secondary);
      font-size: 13px;
    }
    .tf-station-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .tf-fm-page {
      height: 100%;
      overflow-y: auto;
      padding: 4px 8px 152px;
      scrollbar-width: thin;
    }
    .tf-fm-header {
      display: flex;
      align-items: center;
      justify-content: space-between;
      margin-bottom: 16px;
    }
    .tf-fm-title {
      font-size: 18px;
      font-weight: 600;
      color: var(--color-text-main);
      letter-spacing: 0.2px;
    }
    .tf-fm-update {
      font-size: 12px;
      color: var(--color-text-secondary);
      font-weight: 500;
    }
    .tf-fm-panel {
      border: 1px solid var(--border-subtle);
      border-radius: 14px;
      background: color-mix(in srgb, var(--surface-card-base) 86%, transparent);
      padding: 14px;
      margin-bottom: 16px;
    }
    .tf-fm-category-row {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 16px;
    }
    .tf-fm-panel-label {
      min-width: 0;
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--color-text-secondary);
      font-size: 12px;
      font-weight: 600;
    }
    .tf-fm-panel-label span {
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .tf-fm-category-tabs {
      flex-shrink: 0;
      display: flex;
      align-items: center;
      gap: 4px;
      padding: 4px;
      border-radius: 10px;
      background: var(--control-muted-bg);
    }
    .tf-fm-category-btn {
      height: 28px;
      padding: 0 12px;
      border-radius: 8px;
      border: none;
      background: transparent;
      color: var(--color-text-secondary);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }
    .tf-fm-category-btn:hover {
      color: var(--color-text-main);
      background: var(--control-hover-bg);
    }
    .tf-fm-category-btn.active {
      color: var(--color-text-main);
      background: var(--color-bg-elevated);
      box-shadow: 0 1px 3px rgba(15, 23, 42, 0.08);
    }
    .tf-fm-tag-row {
      margin-top: 12px;
      display: flex;
      align-items: center;
      gap: 8px;
      overflow-x: auto;
      padding-bottom: 2px;
      scrollbar-width: none;
    }
    .tf-fm-tag-row::-webkit-scrollbar {
      display: none;
    }
    .tf-fm-tag-btn {
      height: 32px;
      flex-shrink: 0;
      border-radius: 10px;
      padding: 0 12px;
      border: 1px solid transparent;
      background: var(--control-bg);
      color: var(--color-text-secondary);
      font-size: 12px;
      font-weight: 700;
      cursor: pointer;
      white-space: nowrap;
    }
    .tf-fm-tag-btn:hover {
      color: var(--color-text-main);
      border-color: var(--control-border-hover);
    }
    .tf-fm-tag-btn.active {
      color: var(--color-primary);
      border-color: var(--color-primary);
      background: var(--control-active-bg);
    }
    .tf-fm-placeholder {
      height: 160px;
      display: flex;
      align-items: center;
      justify-content: center;
      color: color-mix(in srgb, var(--color-text-main) 56%, transparent);
      font-size: 12px;
    }
    .tf-fm-station-list {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    body.tf-hide-radio-error .player-error-indicator {
      display: none !important;
    }
    @media (max-width: 820px) {
      .tf-fm-category-row {
        align-items: flex-start;
        flex-direction: column;
      }
      .tf-fm-category-tabs {
        width: 100%;
        overflow-x: auto;
      }
    }
  `)

  // ---------------- 搜索面板（本地过滤） ----------------
  const SearchPanel = defineComponent({
    setup() {
      const keyword = ref('')
      const results = ref([])
      const searching = ref(false)

      function doSearch() {
        const kw = keyword.value.trim()
        searching.value = true
        results.value = searchStations(kw)
        searching.value = false
      }

      async function addAndPlay(item) {
        const exists = savedStations.value.some((s) => s.id === item.id)
        if (!exists) {
          savedStations.value.push(savedItem(item.id))
          await saveStations()
        }
        handlePlayToggle(item)
      }

      return () => h('div', { style: { padding: '0 4px' } }, [
        h('div', { class: 'tf-search-bar' }, [
          h('input', {
            placeholder: '搜索电台名称...',
            value: keyword.value,
            onInput: (e) => { keyword.value = e.target.value },
            onKeydown: (e) => { if (e.key === 'Enter') doSearch() },
          }),
          h('button', { disabled: searching.value, onClick: doSearch },
            searching.value ? '搜索中...' : '搜索'),
        ]),
        results.value.length > 0
          ? h('div', { class: 'tf-section-title' }, `搜索结果 (${results.value.length})`)
          : null,
        h('div', { class: 'tf-station-list' },
          results.value.map((item) => {
            const active = currentPlayingId.value === item.id
            return h('div', { class: 'tf-station-card', onClick: () => addAndPlay(item) }, [
              renderStationLogo(item),
              h('div', { class: 'tf-info' }, [
                h('div', { class: 'tf-name' }, item.title),
                h('div', { class: 'tf-meta' }, '听FM网络电台'),
              ]),
              h('div', { class: 'tf-action' + (active ? ' active' : '') },
                active ? '⏹' : '▶'),
            ])
          }),
        ),
        results.value.length === 0 && !searching.value
          ? h('div', { class: 'tf-empty' }, '输入电台名称搜索')
          : null,
      ])
    },
  })

  // ---------------- 我的电台（收藏） ----------------
  const SavedPanel = defineComponent({
    setup() {
      return () => h('div', { style: { padding: '0 4px' } }, [
        h('div', { class: 'tf-section-title' },
          `我的电台 (${savedStations.value.length})`),
        savedStations.value.length === 0
          ? h('div', { class: 'tf-empty' }, '暂无收藏，去分区或搜索中添加')
          : h('div', { class: 'tf-station-list' },
              savedStations.value.map((saved) => {
                const item = fillSavedStation(saved)
                const active = currentPlayingId.value === item.id
                return h('div', { class: 'tf-station-card', onClick: () => handlePlayToggle(item) }, [
                  renderStationLogo(item),
                  h('div', { class: 'tf-info' }, [
                    h('div', { class: 'tf-name' }, item.title),
                    h('div', { class: 'tf-meta' }, '我的电台 · 听FM网络电台'),
                  ]),
                  h('div', {
                    class: 'tf-action' + (active ? ' active' : ''),
                    onClick: (e) => {
                      e.stopPropagation()
                      void removeStation(item.id)
                    },
                  }, '✕'),
                ])
              }),
            ),
      ])
    },
  })

  // ---------------- 网络FM板块（分区浏览，数据来自 data.json） ----------------
  const NetworkFmPanel = defineComponent({
    setup() {
      const defaultRegion = getDefaultRegion()
      const activeGroupName = ref(defaultRegion ? (regionGroups[0]?.name ?? '') : '')
      const activeRegionName = ref(defaultRegion ? defaultRegion.name : '')
      const stations = ref(defaultRegion ? defaultRegion.stations : [])
      const searchKeyword = ref('')
      // 搜索输入防抖定时器：一次性短定时器，组件卸载时残留的回调仅写一个 ref，无副作用
      let searchDebounceTimer = null

      const activeGroup = computed(() => {
        return regionGroups.find((g) => g.name === activeGroupName.value) ?? regionGroups[0]
      })
      const filteredStations = computed(() => {
        const kw = searchKeyword.value.trim()
        if (!kw) return stations.value
        return stations.value.filter((s) => s.title.indexOf(kw) >= 0)
      })

      function selectRegion(group, region) {
        activeGroupName.value = group.name
        activeRegionName.value = region.name
        stations.value = region.stations
      }

      function playStationInRegion(item) {
        handlePlayToggle(item)
      }

      return () => h('div', { class: 'tf-fm-page' }, [
        h('div', { class: 'tf-fm-header' }, [
          h('div', { class: 'tf-fm-title' }, '网络FM'),
          fmData && fmData.update
            ? h('div', { class: 'tf-fm-update' }, `更新 ${fmData.update}`)
            : null,
        ]),
        h('div', { class: 'tf-fm-panel' }, [
          h('div', { class: 'tf-section-title' }, '搜索电台'),
          h(SearchPanel),
        ]),
        h('div', { class: 'tf-fm-panel' }, [
          h(SavedPanel),
        ]),
        h('div', { class: 'tf-fm-panel' }, [
          h('div', { class: 'tf-fm-category-row' }, [
            h('div', { class: 'tf-fm-panel-label' },
              h('span', `${activeGroupName.value} · ${activeRegionName.value}`)),
            h('div', { class: 'tf-fm-category-tabs' },
              regionGroups.map((group) =>
                h('button', {
                  class: 'tf-fm-category-btn' + (activeGroupName.value === group.name ? ' active' : ''),
                  onClick: () => {
                    const first = group.regions[0]
                    if (first) selectRegion(group, first)
                  },
                }, group.name),
              ),
            ),
          ]),
          h('div', { class: 'tf-fm-tag-row' },
            (activeGroup.value?.regions ?? []).map((region) =>
              h('button', {
                class: 'tf-fm-tag-btn' + (activeRegionName.value === region.name ? ' active' : ''),
                onClick: () => selectRegion(activeGroup.value, region),
              }, region.name),
            ),
          ),
          h('div', { class: 'tf-search-bar', style: { marginTop: '12px', marginBottom: '0' } }, [
            h('input', {
              placeholder: `筛选 ${activeRegionName.value} 电台...`,
              value: searchKeyword.value,
              // 输入防抖：每敲一个字符会触发过滤 + 全部卡片重渲，长关键词连续输入时开销放大
              onInput: (e) => {
                const value = e.target.value
                if (searchDebounceTimer) clearTimeout(searchDebounceTimer)
                searchDebounceTimer = setTimeout(() => {
                  searchDebounceTimer = null
                  searchKeyword.value = value
                }, 180)
              },
            }),
          ]),
        ]),
        stations.value.length === 0
          ? h('div', { class: 'tf-fm-placeholder' }, '暂无电台')
          : h('div', { class: 'tf-fm-station-list' },
              filteredStations.value.map((item) => {
                const active = currentPlayingId.value === item.id
                return h('div', { class: 'tf-station-card', onClick: () => playStationInRegion(item) }, [
                  renderStationLogo(item),
                  h('div', { class: 'tf-info' }, [
                    h('div', { class: 'tf-name' }, item.title),
                    h('div', { class: 'tf-meta' }, `${activeRegionName.value} · 听FM网络电台`),
                  ]),
                  h('div', { class: 'tf-action' + (active ? ' active' : '') },
                    active ? '⏹' : '▶'),
                ])
              }),
            ),
      ])
    },
  })

  await loadFmData()
  await loadSavedStations()

  // 注册引擎音源解析：电台曲目统一解析为静音占位音源，让引擎正常进入
  // 播放态，不再弹「播放失败」并在 3 秒后自动切下一首。解析失败（如磁盘
  // 异常）时返回 null，交回引擎默认兜底链（此时报错是真实故障）。
  let removeAudioSourceResolver = null
  try {
    removeAudioSourceResolver = ctx.player.audioSource.register({
      id: 'tingfm-station-silence',
      match: (context) => {
        const track = context && context.track
        if (!track) return false
        return track.source === 'tingfm' || String(track.id || '').startsWith('tingfm:')
      },
      resolve: async () => {
        const url = await ensureSilenceSource()
        return url ? { url } : null
      },
    })
  } catch (err) {
    console.warn('[TingFM] 注册占位音源失败（宿主可能不支持音源解析能力）:', err)
  }

  // 在「发现音乐」侧边栏分组下新增「网络FM」板块（插件页）
  const removeNetworkFmPage = ctx.ui.addPage({
    id: 'network-fm',
    title: '网络FM',
    component: NetworkFmPanel,
    order: 100,
    sidebar: {
      section: 'discover',
      title: '网络FM',
      order: 30,
    },
  })

  const removeQuickPlayCommand = ctx.commands.register(
    'tingfm-radio:open',
    () => ctx.router.push('/main/plugin/tingfm-radio/network-fm'),
    { title: '听FM网络电台' },
  )

  ctx.dispose(() => {
    // 卸载时从宿主收藏中清除本插件的临时收藏条目
    try {
      if (playlistStore && Array.isArray(playlistStore.favorites)) {
        playlistStore.favorites = playlistStore.favorites.filter((s) => !s || s.source !== 'tingfm')
      }
    } catch (e) { /* 忽略 */ }
    removeStyle()
    removeQuickPlayCommand()
    removeNetworkFmPage()
    if (typeof removeAudioSourceResolver === 'function') removeAudioSourceResolver()
    removeFavoriteHijack()
    favoriteStateWatch()
    playingWatch()
    progressWatch()
    stopVolumeWatch()
    stopTrackWatch()
    errorBadgeWatch()
    errBadgeObserve()
    document.body.classList.remove(HIDE_ERROR_CLASS)
    stopStationAudio()
  })
}