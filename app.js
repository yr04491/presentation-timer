(() => {
  'use strict';

  const $ = (sel) => document.querySelector(sel);
  const STORE_KEY = 'presentation-timer:settings:v1';
  const MAX_MIN = 180;

  const DEFAULTS = {
    duration: 15,
    bells: [
      { on: true, mode: 'remain', min: 3 },
      { on: true, mode: 'remain', min: 0 },
      { on: true, mode: 'elapsed', min: 20 },
    ],
  };

  // ---------- 設定 ----------
  function clampInt(v, lo, hi, fallback) {
    const n = Math.round(Number(v));
    if (!Number.isFinite(n)) return fallback;
    return Math.min(hi, Math.max(lo, n));
  }

  function normalize(raw) {
    const s = JSON.parse(JSON.stringify(DEFAULTS));
    if (!raw || typeof raw !== 'object') return s;
    s.duration = clampInt(raw.duration, 1, MAX_MIN, s.duration);
    if (Array.isArray(raw.bells)) {
      for (let i = 0; i < 3; i++) {
        const b = raw.bells[i];
        if (!b) continue;
        s.bells[i] = {
          on: Boolean(b.on),
          mode: b.mode === 'elapsed' ? 'elapsed' : 'remain',
          min: clampInt(b.min, 0, MAX_MIN, s.bells[i].min),
        };
      }
    }
    return s;
  }

  function loadSettings() {
    try {
      return normalize(JSON.parse(localStorage.getItem(STORE_KEY)));
    } catch (e) {
      return normalize(null);
    }
  }

  function saveSettings() {
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(settings));
    } catch (e) { /* 保存できない環境では無視 */ }
  }

  let settings = loadSettings();

  // ベルが鳴る時刻（経過ミリ秒）。鳴らせない設定なら null
  function bellTime(i) {
    const b = settings.bells[i];
    if (!b.on) return null;
    const ms = b.mode === 'elapsed' ? b.min * 60000 : (settings.duration - b.min) * 60000;
    return ms > 0 ? ms : null;
  }

  // ---------- 時間の表示 ----------
  function fmt(totalSec) {
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0');
  }

  // ---------- ベルの音（プログラムで合成し、WAVにして再生） ----------
  const SAMPLE_RATE = 44100;

  function synthBell(strikes) {
    const gap = 0.42;          // 打つ間隔（秒）
    const ring = 2.6;          // 1打の余韻（秒）
    const len = Math.ceil((gap * (strikes - 1) + ring) * SAMPLE_RATE);
    const data = new Float32Array(len);
    const base = 1480;
    // 卓上ベルのような、倍音が整数倍でない金属音
    const partials = [
      { r: 1.0, a: 1.0, d: 1.5 },
      { r: 1.0012, a: 0.6, d: 1.4 },   // わずかなうなり
      { r: 2.38, a: 0.45, d: 0.8 },
      { r: 4.12, a: 0.25, d: 0.45 },
      { r: 6.31, a: 0.12, d: 0.25 },
    ];
    for (let k = 0; k < strikes; k++) {
      const off = Math.floor(k * gap * SAMPLE_RATE);
      const n = Math.floor(ring * SAMPLE_RATE);
      for (let i = 0; i < n && off + i < len; i++) {
        const t = i / SAMPLE_RATE;
        const attack = Math.min(1, t / 0.002);
        let v = 0;
        for (const p of partials) {
          v += p.a * Math.exp(-t / p.d) * Math.sin(2 * Math.PI * base * p.r * t);
        }
        data[off + i] += v * attack;
      }
    }
    let peak = 0;
    for (let i = 0; i < len; i++) peak = Math.max(peak, Math.abs(data[i]));
    const gain = peak > 0 ? 0.9 / peak : 1;

    const buf = new ArrayBuffer(44 + len * 2);
    const dv = new DataView(buf);
    const str = (o, s) => { for (let i = 0; i < s.length; i++) dv.setUint8(o + i, s.charCodeAt(i)); };
    str(0, 'RIFF'); dv.setUint32(4, 36 + len * 2, true); str(8, 'WAVE');
    str(12, 'fmt '); dv.setUint32(16, 16, true); dv.setUint16(20, 1, true); dv.setUint16(22, 1, true);
    dv.setUint32(24, SAMPLE_RATE, true); dv.setUint32(28, SAMPLE_RATE * 2, true);
    dv.setUint16(32, 2, true); dv.setUint16(34, 16, true);
    str(36, 'data'); dv.setUint32(40, len * 2, true);
    for (let i = 0; i < len; i++) {
      const v = Math.max(-1, Math.min(1, data[i] * gain));
      dv.setInt16(44 + i * 2, v < 0 ? v * 0x8000 : v * 0x7fff, true);
    }
    return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
  }

  // iPhoneのマナーモードでも鳴るように「再生」扱いにする（対応ブラウザのみ）
  try {
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
  } catch (e) { /* 未対応 */ }

  const sounds = [1, 2, 3].map((n) => {
    const a = new Audio(synthBell(n));
    a.preload = 'auto';
    return a;
  });

  let audioUnlocked = false;
  function unlockAudio() {
    // スマホは、最初にボタンを押したときに一度再生しないと後で鳴らせない
    if (audioUnlocked) return;
    audioUnlocked = true;
    for (const a of sounds) {
      a.muted = true;
      const p = a.play();
      // 準備中に本当に鳴らした場合（muted が外れている）は止めない
      const done = () => {
        if (!a.muted) return;
        a.pause();
        a.currentTime = 0;
        a.muted = false;
      };
      if (p && p.then) p.then(done, done); else done();
    }
  }

  function ring(strikes) {
    const a = sounds[strikes - 1];
    a.muted = false;
    try { a.currentTime = 0; } catch (e) { /* 読み込み前 */ }
    const p = a.play();
    if (p && p.catch) p.catch(() => {});
  }

  // ---------- タイマーの状態 ----------
  let running = false;
  let startAt = 0;     // 動き始めた時刻（performance.now）
  let banked = 0;      // 止めるまでにたまった経過ミリ秒
  let rung = [false, false, false];
  let laps = [];
  let timerId = null;

  const now = () => performance.now();
  const elapsedMs = () => banked + (running ? now() - startAt : 0);

  // 設定を変えたとき、すでに過ぎたベルは鳴らさない
  function syncRung() {
    const e = elapsedMs();
    for (let i = 0; i < 3; i++) {
      const t = bellTime(i);
      rung[i] = t !== null && e >= t;
    }
  }

  function checkBells() {
    const e = elapsedMs();
    let toRing = 0;
    for (let i = 0; i < 3; i++) {
      const t = bellTime(i);
      if (!rung[i] && t !== null && e >= t) {
        rung[i] = true;
        toRing = Math.max(toRing, i + 1);
      }
    }
    // 同時に複数のベルの時刻を過ぎた場合は、いちばん後のベルだけ鳴らす
    if (toRing) ring(toRing);
  }

  // ---------- 画面 ----------
  const el = {
    display: $('.display'),
    remain: $('#remain'),
    elapsed: $('#elapsed'),
    lamps: [...document.querySelectorAll('.lamp')],
    start: $('#startBtn'),
    reset: $('#resetBtn'),
    bell: $('#bellBtn'),
    lap: $('#lapBtn'),
    duration: $('#duration'),
    bells: $('#bells'),
    laps: $('#laps'),
    lapsEmpty: $('#lapsEmpty'),
    offline: $('#offline'),
    fs: $('#fsBtn'),
  };

  function render() {
    const e = elapsedMs();
    const remMs = settings.duration * 60000 - e;
    let remText;
    if (remMs > 0) {
      remText = fmt(Math.ceil(remMs / 1000));
    } else {
      const over = Math.floor(-remMs / 1000);
      remText = over > 0 ? '-' + fmt(over) : fmt(0);
    }
    el.remain.textContent = remText;
    el.elapsed.textContent = fmt(Math.floor(e / 1000));

    el.display.classList.toggle('over', remMs <= 0);
    el.display.classList.toggle('warn', remMs > 0 && rung[0]);
    el.lamps.forEach((lamp, i) => lamp.classList.toggle('on', rung[i]));
    document.title = (running ? '▶ ' : '') + remText + ' | 発表タイマー';
  }

  function tick() {
    checkBells();
    render();
  }

  // ---------- 画面を消さない ----------
  let wakeLock = null;
  async function keepAwake(on) {
    try {
      if (on && 'wakeLock' in navigator && !wakeLock) {
        wakeLock = await navigator.wakeLock.request('screen');
        wakeLock.addEventListener('release', () => { wakeLock = null; });
      } else if (!on && wakeLock) {
        await wakeLock.release();
        wakeLock = null;
      }
    } catch (e) { /* 未対応・拒否 */ }
  }

  // ---------- 操作 ----------
  // 画面が隠れるとブラウザが通常のタイマーを遅らせるため、Workerからも時間を確かめる
  let worker = null;
  function startWorker() {
    try {
      const src = 'setInterval(function(){postMessage(0)},250);';
      worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
      worker.onmessage = () => { if (running) tick(); };
    } catch (e) { worker = null; }
  }
  function stopWorker() {
    if (worker) { worker.terminate(); worker = null; }
  }

  function start() {
    if (running) return;
    unlockAudio();
    running = true;
    startAt = now();
    timerId = setInterval(tick, 100);
    startWorker();
    keepAwake(true);
    updateButtons();
    tick();
  }

  function stop() {
    if (!running) return;
    banked = elapsedMs();
    running = false;
    clearInterval(timerId);
    timerId = null;
    stopWorker();
    keepAwake(false);
    updateButtons();
    render();
  }

  function reset() {
    stop();
    banked = 0;
    rung = [false, false, false];
    laps = [];
    renderLaps();
    updateButtons();
    render();
  }

  function addLap() {
    const e = elapsedMs();
    if (e <= 0) return;
    laps.push(e);
    renderLaps();
  }

  function renderLaps() {
    el.laps.textContent = '';
    for (let i = laps.length - 1; i >= 0; i--) {
      const li = document.createElement('li');
      const total = document.createElement('span');
      const split = document.createElement('span');
      split.className = 'split';
      total.textContent = '経過 ' + fmt(Math.floor(laps[i] / 1000));
      const prev = i > 0 ? laps[i - 1] : 0;
      split.textContent = '区間 ' + fmt(Math.floor(laps[i] / 1000) - Math.floor(prev / 1000));
      li.append(total, split);
      el.laps.append(li);
    }
    el.lapsEmpty.hidden = laps.length > 0;
  }

  function updateButtons() {
    el.start.textContent = running ? '停止' : (banked > 0 ? '再開' : '開始');
    el.start.classList.toggle('running', running);
    el.reset.disabled = running;
  }

  el.start.addEventListener('click', () => (running ? stop() : start()));
  el.reset.addEventListener('click', reset);
  el.bell.addEventListener('click', () => { unlockAudio(); ring(1); });
  el.lap.addEventListener('click', addLap);

  document.addEventListener('keydown', (ev) => {
    const tag = (ev.target && ev.target.tagName) || '';
    if (/^(INPUT|SELECT|TEXTAREA)$/.test(tag)) return;
    // ボタンにフォーカスがあるときのスペース・Enterは、そのボタンの操作にまかせる
    if (tag === 'BUTTON' && (ev.key === ' ' || ev.key === 'Enter')) return;
    if (ev.metaKey || ev.ctrlKey || ev.altKey) return;
    const k = ev.key.toLowerCase();
    if (k === ' ') { ev.preventDefault(); running ? stop() : start(); }
    else if (k === 'b') { unlockAudio(); ring(1); }
    else if (k === 'l') addLap();
    else if (k === 'f' && canFullscreen) toggleFullscreen();
  });

  // ---------- 全画面 ----------
  const canFullscreen = Boolean(document.documentElement.requestFullscreen) && document.fullscreenEnabled;
  function toggleFullscreen() {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else document.documentElement.requestFullscreen().catch(() => {});
  }
  if (canFullscreen) {
    el.fs.hidden = false;
    el.fs.addEventListener('click', toggleFullscreen);
    document.addEventListener('fullscreenchange', () => {
      el.fs.textContent = document.fullscreenElement ? '全画面を終了' : '全画面';
    });
  }

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      if (running) keepAwake(true);
      tick();
    }
  });

  // ---------- 設定画面 ----------
  const bellRows = [];

  function buildSettings() {
    el.duration.value = settings.duration;
    const tpl = $('#bellRow');
    for (let i = 0; i < 3; i++) {
      const row = tpl.content.firstElementChild.cloneNode(true);
      row.querySelector('.bell-name span').textContent = 'ベル' + (i + 1) + '（' + (i + 1) + '回）';
      const on = row.querySelector('.on');
      const mode = row.querySelector('.mode');
      const min = row.querySelector('.min');
      on.setAttribute('aria-label', 'ベル' + (i + 1) + 'を使う');
      mode.setAttribute('aria-label', 'ベル' + (i + 1) + 'の基準');
      min.setAttribute('aria-label', 'ベル' + (i + 1) + 'の分');
      on.checked = settings.bells[i].on;
      mode.value = settings.bells[i].mode;
      min.value = settings.bells[i].min;
      const update = () => {
        settings.bells[i] = {
          on: on.checked,
          mode: mode.value === 'elapsed' ? 'elapsed' : 'remain',
          min: clampInt(min.value, 0, MAX_MIN, settings.bells[i].min),
        };
        settingsChanged();
      };
      on.addEventListener('change', update);
      mode.addEventListener('change', update);
      min.addEventListener('input', update);
      min.addEventListener('change', () => { min.value = settings.bells[i].min; });
      el.bells.append(row);
      bellRows.push(row);
    }
    el.duration.addEventListener('input', () => {
      settings.duration = clampInt(el.duration.value, 1, MAX_MIN, settings.duration);
      settingsChanged();
    });
    el.duration.addEventListener('change', () => { el.duration.value = settings.duration; });
    updateHints();
  }

  function updateHints() {
    bellRows.forEach((row, i) => {
      const b = settings.bells[i];
      const hint = row.querySelector('.hint');
      row.classList.toggle('off', !b.on);
      const t = bellTime(i);
      if (!b.on) {
        hint.textContent = '使わない';
        hint.classList.remove('bad');
      } else if (t === null) {
        hint.textContent = '発表時間より長いため鳴りません';
        hint.classList.add('bad');
      } else {
        hint.textContent = '経過 ' + fmt(Math.round(t / 1000)) + ' で鳴る';
        hint.classList.remove('bad');
      }
    });
  }

  function settingsChanged() {
    saveSettings();
    syncRung();
    updateHints();
    render();
  }

  // ---------- オフライン対応 ----------
  function showNetState() {
    el.offline.textContent = navigator.onLine ? '' : 'オフラインで動作中';
  }
  window.addEventListener('online', showNetState);
  window.addEventListener('offline', showNetState);

  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    });
  }

  buildSettings();
  renderLaps();
  updateButtons();
  showNetState();
  render();
})();
