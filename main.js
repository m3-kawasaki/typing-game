(() => {
  const els = {
    word: document.getElementById('word'),
    timerBar: document.getElementById('timerBar'),
    timeLabel: document.getElementById('timeLabel'),
    completedCount: document.getElementById('completedCount'),
    accuracy: document.getElementById('accuracy'),
    wpm: document.getElementById('wpm'),
    startBtn: document.getElementById('startBtn'),
    openSettings: document.getElementById('openSettings'),
    soundToggle: document.getElementById('soundToggle'),
    settingsDialog: document.getElementById('settingsDialog'),
    settingsForm: document.getElementById('settingsForm'),
    setDuration: document.getElementById('setDuration'),
    setCaseSensitive: document.getElementById('setCaseSensitive'),
    setMistakeMode: document.getElementById('setMistakeMode'),
    setPauseOnBlur: document.getElementById('setPauseOnBlur'),
    setSoundEnabled: document.getElementById('setSoundEnabled'),
    setSoundVolume: document.getElementById('setSoundVolume'),
    importWords: document.getElementById('importWords'),
    hiddenImport: document.getElementById('hiddenImport'),
    pausedHint: document.getElementById('pausedHint'),
    resultDialog: document.getElementById('resultDialog'),
    rCompleted: document.getElementById('rCompleted'),
    rAccuracy: document.getElementById('rAccuracy'),
    rWpm: document.getElementById('rWpm'),
    rBest: document.getElementById('rBest'),
    playAgain: document.getElementById('playAgain'),
    closeResult: document.getElementById('closeResult'),
    openImportFromResult: document.getElementById('openImportFromResult'),
    imeInput: document.getElementById('imeInput'),
    skipBtn: document.getElementById('skipBtn'),
  };

  const STORAGE_SETTINGS = 'typingGame:settings';
  const STORAGE_BEST = 'typingGame:bestCompleted';

  const defaults = {
    durationSeconds: 15,
    caseSensitive: true,
    mistakeMode: 'strict', // 'strict' | 'lenient'
    sound: { enabled: true, volume: 0.3 },
    pauseOnBlur: true,
  };

  let settings = { ...defaults };
  let words = [];
  const builtinWords = [
    { display: 'こんにちは', reading: 'こんにちは' },
    { display: 'てすと', reading: 'てすと' },
  ];

  const game = {
    status: 'idle', // idle|playing|paused|result
    timeLeft: 0,
    duration: 15,
    current: { display: '', reading: '' },
    index: 0, // position in reading (kana index)
    typed: [],
    hadErrorInWord: false,
    stats: { completed: 0, totalKeystrokes: 0, correctKeystrokes: 0 },
    lastTickSecond: null,
    timerId: null,
    romajiBuffer: '',
    errorAtCurrent: false,
    lastVowel: null,
  };

  // Simple audio using WebAudio (no external files needed)
  let audioCtx = null;
  function beep(freq = 440, ms = 80, type = 'sine', gain = 0.1) {
    if (!settings.sound.enabled) return;
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type; o.frequency.value = freq;
      g.gain.value = Math.max(0, Math.min(1, settings.sound.volume)) * gain;
      o.connect(g); g.connect(audioCtx.destination);
      o.start();
      setTimeout(() => { o.stop(); o.disconnect(); g.disconnect(); }, ms);
    } catch (_) { /* ignore */ }
  }
  const sfx = {
    success: () => beep(880, 100, 'triangle', 0.6),
    error: () => beep(220, 120, 'square', 0.7),
    tick: () => beep(600, 40, 'sine', 0.4),
  };

  function saveSettings() {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(settings));
  }
  function loadSettings() {
    try {
      const s = localStorage.getItem(STORAGE_SETTINGS);
      if (s) settings = { ...defaults, ...JSON.parse(s) };
    } catch (_) { /* ignore */ }
  }

  function updateSettingsUI() {
    els.setDuration.value = settings.durationSeconds;
    els.setCaseSensitive.checked = !!settings.caseSensitive;
    els.setMistakeMode.value = settings.mistakeMode;
    els.setPauseOnBlur.checked = !!settings.pauseOnBlur;
    els.setSoundEnabled.checked = !!settings.sound.enabled;
    els.setSoundVolume.value = settings.sound.volume;
    els.soundToggle.setAttribute('aria-pressed', String(!!settings.sound.enabled));
  }

  async function loadConfig() {
    try {
      const res = await fetch('config.json', { cache: 'no-cache' });
      if (res.ok) {
        const cfg = await res.json();
        settings = { ...settings, ...cfg };
      }
    } catch (_) { /* file:// or fetch fail, keep defaults */ }
  }

  function parseWordsText(txt) {
    return txt.split(/\r?\n/)
      .map(l => l.replace(/^\uFEFF/, '').trim()) // strip BOM on first line if present
      .filter(l => l && !l.startsWith('#'))
      .map(l => {
        const parts = l.split('\t');
        if (parts.length >= 2) return { display: parts[0], reading: (parts[1] || '').trim() };
        return { display: l, reading: l };
      });
  }

  async function loadWords() {
    async function tryFetch(url) {
      try {
        const res = await fetch(url, { cache: 'no-cache' });
        if (res.ok) return await res.text();
      } catch (_) { /* ignore */ }
      return null;
    }

    const candidates = [];
    try { candidates.push(new URL('assets/words.txt', document.baseURI).href); } catch (_) { candidates.push('assets/words.txt'); }
    try {
      const cs = document.currentScript && document.currentScript.src;
      if (cs) candidates.push(new URL('assets/words.txt', cs).href);
    } catch (_) { /* ignore */ }
    candidates.push('./assets/words.txt');
    candidates.push('/assets/words.txt');

    for (const u of candidates) {
      const txt = await tryFetch(u);
      if (txt) {
        const list = parseWordsText(txt);
        if (list.length) { words = list; return; }
      }
    }

    // If we reach here, loading failed; inform user when opened as file://
    if (location.protocol === 'file:') {
      showToast('words.txtを読み込めません。設定→「単語リストを読み込む」を使用');
    }
    words = builtinWords.slice();
  }

  function pickWord(prev) {
    if (!words.length) return { display: '', reading: '' };
    if (words.length === 1) return words[0];
    let w = prev;
    while (!w || w === prev) {
      w = words[Math.floor(Math.random() * words.length)];
    }
    return w;
  }

  function renderWord() {
    els.word.classList.remove('shake', 'glow');
    els.word.innerHTML = '';
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = game.current.display || '';
    const reading = document.createElement('div');
    reading.className = 'reading';
    const frag = document.createDocumentFragment();
    for (let i = 0; i < game.current.reading.length; i++) {
      const span = document.createElement('span');
      span.className = 'rchar';
      span.textContent = game.current.reading[i];
      frag.appendChild(span);
    }
    reading.appendChild(frag);
    els.word.appendChild(label);
    els.word.appendChild(reading);
    updateWordClasses();
  }

  function updateWordClasses() {
    const nodes = els.word.querySelectorAll('.rchar');
    for (let i = 0; i < nodes.length; i++) {
      const n = nodes[i];
      n.classList.remove('correct','current','error');
      if (i < game.index) n.classList.add('correct');
      if (i === game.index) n.classList.add('current');
      if (i === game.index && game.errorAtCurrent) n.classList.add('error');
    }
  }

  function equalChar(a, b) { return a === b; }

  // Romaji input handling for kana readings
  const VOWELS = ['a','i','u','e','o'];
  function isVowel(ch){ return VOWELS.includes(ch); }
  function isConsonant(ch){ return ch >= 'a' && ch <= 'z' && !isVowel(ch); }
  const SMALL_YOON = new Set(['ゃ','ゅ','ょ']);
  const SMALL_VOWELS = new Set(['ぁ','ぃ','ぅ','ぇ','ぉ','ゎ']);
  function getExpectedUnit(reading, idx){
    const c = reading[idx];
    if (!c) return '';
    const n = reading[idx+1];
    if (n && (SMALL_YOON.has(n) || SMALL_VOWELS.has(n))) return c + n; // e.g., きゃ, ふぉ
    return c;
  }
  function vowelOfKanaUnit(unit){
    const base = unit[0];
    const map = {
      'あ':'a','か':'a','さ':'a','た':'a','な':'a','は':'a','ま':'a','や':'a','ら':'a','わ':'a','が':'a','ざ':'a','だ':'a','ば':'a','ぱ':'a',
      'い':'i','き':'i','し':'i','ち':'i','に':'i','ひ':'i','み':'i','り':'i','ぎ':'i','じ':'i','ぢ':'i','び':'i','ぴ':'i',
      'う':'u','く':'u','す':'u','つ':'u','ぬ':'u','ふ':'u','む':'u','ゆ':'u','る':'u','ぐ':'u','ず':'u','づ':'u','ぶ':'u','ぷ':'u',
      'え':'e','け':'e','せ':'e','て':'e','ね':'e','へ':'e','め':'e','れ':'e','げ':'e','ぜ':'e','で':'e','べ':'e','ぺ':'e',
      'お':'o','こ':'o','そ':'o','と':'o','の':'o','ほ':'o','も':'o','よ':'o','ろ':'o','を':'o','ご':'o','ぞ':'o','ど':'o','ぼ':'o','ぽ':'o'
    };
    let v = map[base] || 'a';
    if (unit.endsWith('ゃ')) v = 'a';
    if (unit.endsWith('ゅ')) v = 'u';
    if (unit.endsWith('ょ')) v = 'o';
    return v;
  }
  const ROMAJI_KANA = {
    'a':'あ','i':'い','u':'う','e':'え','o':'お',
    'ka':'か','ki':'き','ku':'く','ke':'け','ko':'こ',
    'kya':'きゃ','kyu':'きゅ','kyo':'きょ',
    'sa':'さ','shi':'し','si':'し','su':'す','se':'せ','so':'そ',
    'sha':'しゃ','shu':'しゅ','sho':'しょ','sya':'しゃ','syu':'しゅ','syo':'しょ',
    'ta':'た','chi':'ち','ti':'ち','tsu':'つ','tu':'つ','te':'て','to':'と',
    'cha':'ちゃ','chu':'ちゅ','cho':'ちょ','tya':'ちゃ','tyu':'ちゅ','tyo':'ちょ',
    'na':'な','ni':'に','nu':'ぬ','ne':'ね','no':'の',
    'nya':'にゃ','nyu':'にゅ','nyo':'にょ',
    'ha':'は','hi':'ひ','fu':'ふ','hu':'ふ','he':'へ','ho':'ほ',
    'hya':'ひゃ','hyu':'ひゅ','hyo':'ひょ',
    'ma':'ま','mi':'み','mu':'む','me':'め','mo':'も',
    'mya':'みゃ','myu':'みゅ','myo':'みょ',
    'ya':'や','yu':'ゆ','yo':'よ',
    'ra':'ら','ri':'り','ru':'る','re':'れ','ro':'ろ',
    'rya':'りゃ','ryu':'りゅ','ryo':'りょ',
    'wa':'わ','wo':'を',
    'ga':'が','gi':'ぎ','gu':'ぐ','ge':'げ','go':'ご',
    'gya':'ぎゃ','gyu':'ぎゅ','gyo':'ぎょ',
    'za':'ざ','ji':'じ','zi':'じ','zu':'ず','ze':'ぜ','zo':'ぞ',
    'ja':'じゃ','ju':'じゅ','jo':'じょ','jya':'じゃ','jyu':'じゅ','jyo':'じょ','zya':'じゃ','zyu':'じゅ','zyo':'じょ',
    'da':'だ','di':'ぢ','du':'づ','de':'で','do':'ど',
    'dya':'ぢゃ','dyu':'ぢゅ','dyo':'ぢょ',
    'ba':'ば','bi':'び','bu':'ぶ','be':'べ','bo':'ぼ',
    'bya':'びゃ','byu':'びゅ','byo':'びょ',
    'pa':'ぱ','pi':'ぴ','pu':'ぷ','pe':'ぺ','po':'ぽ',
    'pya':'ぴゃ','pyu':'ぴゅ','pyo':'ぴょ',
    'fa':'ふぁ','fi':'ふぃ','fe':'ふぇ','fo':'ふぉ',
    'ltu':'っ','xtu':'っ','ltsu':'っ','xtsu':'っ',
  };
  const KANA_TO_ROMAJI = {};
  Object.entries(ROMAJI_KANA).forEach(([r,k]) => { (KANA_TO_ROMAJI[k] ||= []).push(r); });
  Object.values(KANA_TO_ROMAJI).forEach(list => list.sort((a,b)=>b.length-a.length));
  // Allow 'o' for 'を' in addition to the standard 'wo',
  // without breaking 'お' which also uses 'o'.
  (KANA_TO_ROMAJI['を'] ||= []).push('o');
  KANA_TO_ROMAJI['を'].sort((a,b)=>b.length-a.length);
  // Lenient yoon input: allow base+'i' + ya/yu/yo (e.g., siyo -> しょ)
  (function addYoonFallbacks(){
    const ymap = { 'ゃ':'ya', 'ゅ':'yu', 'ょ':'yo' };
    Object.keys(KANA_TO_ROMAJI).forEach(unit => {
      if (unit.length === 2 && ymap[unit[1]]) {
        const base = unit[0];
        const tail = ymap[unit[1]];
        const baseList = KANA_TO_ROMAJI[base] || [];
        const list = KANA_TO_ROMAJI[unit] || (KANA_TO_ROMAJI[unit] = []);
        baseList.forEach(br => {
          if (br.endsWith('i')) {
            const cand = br + tail;
            if (!list.includes(cand)) list.push(cand);
          }
        });
        list.sort((a,b)=>b.length-a.length);
      }
    });
  })();
  function possibleForUnit(unit){ return KANA_TO_ROMAJI[unit] || []; }
  function isPossiblePrefix(buffer, unit){ return possibleForUnit(unit).some(r => r.startsWith(buffer)); }
  function consumeIfMatches(){
    let progressed = false;
    const target = game.current.reading;
    while (game.index < target.length && game.romajiBuffer.length > 0) {
      const expectedUnit = getExpectedUnit(target, game.index);
      // syllabic N (ん)
      if (target[game.index] === 'ん') {
        // "nn" always commits ん
        if (game.romajiBuffer.startsWith('nn')) {
          game.romajiBuffer = game.romajiBuffer.slice(2);
          game.index += 1;
          progressed = true;
          game.errorAtCurrent = false;
          continue;
        }
        const b0 = game.romajiBuffer[0];
        const b1 = game.romajiBuffer[1];
        // "n" + consonant (except y) commits ん
        if (b0 === 'n' && b1 && isConsonant(b1) && b1 !== 'y') {
          game.romajiBuffer = game.romajiBuffer.slice(1);
          game.index += 1;
          progressed = true;
          game.errorAtCurrent = false;
          continue;
        }
        // Allow 'm' before b/p/m to commit ん
        if (b0 === 'm') {
          const nextUnit = getExpectedUnit(target, game.index + 1);
          const nextList = nextUnit ? possibleForUnit(nextUnit) : [];
          const nextStartsWithLabial = nextList.some(r => /^[bpm]/.test(r));
          if (nextStartsWithLabial) {
            game.romajiBuffer = game.romajiBuffer.slice(1);
            game.index += 1;
            progressed = true;
            game.errorAtCurrent = false;
            continue;
          }
        }
        break;
      }
      if (target[game.index] === 'っ') {
        if (/^([bcdfghjklmnpqrstvwxyz])\1/.test(game.romajiBuffer)) {
          game.romajiBuffer = game.romajiBuffer.slice(1);
          game.index += 1;
          progressed = true;
          game.errorAtCurrent = false;
          continue;
        } else { break; }
      }
      if (target[game.index] === 'ー') {
        if (game.lastVowel && game.romajiBuffer[0] === game.lastVowel) {
          game.romajiBuffer = game.romajiBuffer.slice(1);
          game.index += 1;
          progressed = true;
          game.errorAtCurrent = false;
          continue;
        } else { break; }
      }
      const candidates = possibleForUnit(expectedUnit);
      const match = candidates.find(r => game.romajiBuffer.startsWith(r));
      if (match) {
        game.romajiBuffer = game.romajiBuffer.slice(match.length);
        game.index += expectedUnit.length;
        game.stats.correctKeystrokes += match.length;
        game.lastVowel = match[match.length-1];
        progressed = true;
        game.errorAtCurrent = false;
        continue;
      }
      break;
    }
    return progressed;
  }

  function resetStats() {
    game.stats = { completed: 0, totalKeystrokes: 0, correctKeystrokes: 0 };
    updateStatsUI();
  }
  function updateStatsUI() {
    const acc = game.stats.totalKeystrokes ? (game.stats.correctKeystrokes / game.stats.totalKeystrokes) * 100 : 100;
    const elapsed = game.duration - game.timeLeft;
    const cpm = elapsed > 0 ? (game.stats.correctKeystrokes / (elapsed / 60)) : 0;
    const wpm = cpm / 5;
    els.completedCount.textContent = String(game.stats.completed);
    els.accuracy.textContent = acc.toFixed(1) + '%';
    els.wpm.textContent = wpm.toFixed(1);
  }

  function showNextWord() {
    const prev = game.current;
    game.current = pickWord(prev);
    game.index = 0;
    game.typed = [];
    game.hadErrorInWord = false;
    renderWord();
    game.romajiBuffer = '';
    game.errorAtCurrent = false;
    game.lastVowel = null;
  }

  function startGame() {
    if (game.status === 'playing') return;
    game.status = 'playing';
    game.duration = Number(settings.durationSeconds) || 15;
    game.timeLeft = game.duration;
    game.lastTickSecond = Math.ceil(game.timeLeft);
    resetStats();
    showNextWord();
    els.pausedHint.hidden = true;
    if (game.timerId) clearInterval(game.timerId);
    game.timerId = setInterval(onTick, 100);
  }

  function onTick() {
    if (game.status !== 'playing') return;
    game.timeLeft = Math.max(0, game.timeLeft - 0.1);
    const pct = (game.timeLeft / game.duration) * 100;
    els.timerBar.style.width = pct + '%';
    if (game.timeLeft <= 5) {
      els.timerBar.style.background = game.timeLeft <= 2 ? 'var(--bad)' : 'var(--warn)';
      const sec = Math.ceil(game.timeLeft);
      if (sec !== game.lastTickSecond) { game.lastTickSecond = sec; sfx.tick(); }
    } else {
      els.timerBar.style.background = 'var(--good)';
    }
    els.timeLabel.textContent = game.timeLeft.toFixed(1) + 's';
    updateStatsUI();
    if (game.timeLeft <= 0) endGame();
  }

  function endGame() {
    if (game.timerId) { clearInterval(game.timerId); game.timerId = null; }
    game.status = 'result';
    // Save best by completed words
    const best = Math.max(Number(localStorage.getItem(STORAGE_BEST) || 0), game.stats.completed);
    localStorage.setItem(STORAGE_BEST, String(best));
    // Show dialog
    const acc = game.stats.totalKeystrokes ? (game.stats.correctKeystrokes / game.stats.totalKeystrokes) * 100 : 100;
    const elapsed = game.duration;
    const cpm = elapsed > 0 ? (game.stats.correctKeystrokes / (elapsed / 60)) : 0;
    const wpm = cpm / 5;
    els.rCompleted.textContent = String(game.stats.completed);
    els.rAccuracy.textContent = acc.toFixed(1) + '%';
    els.rWpm.textContent = wpm.toFixed(1);
    els.rBest.textContent = String(best);
    els.resultDialog.showModal();
  }

  function handleKey(e) {
    if (game.status === 'idle' && (e.key === 'Enter' || e.code === 'Enter')) { startGame(); return; }
    if (game.status !== 'playing') return;
    const k = e.key.toLowerCase();
    if (k === 'backspace') {
      e.preventDefault();
      if (game.romajiBuffer.length > 0) {
        game.romajiBuffer = game.romajiBuffer.slice(0, -1);
        game.errorAtCurrent = false;
        updateWordClasses();
      } else if (game.index > 0) {
        const prevIdx = game.index - 1;
        const prevChar = game.current.reading[prevIdx];
        if (SMALL_YOON.has(prevChar) && game.index - 2 >= 0) {
          game.index -= 2;
        } else {
          game.index -= 1;
        }
        game.errorAtCurrent = false;
        updateWordClasses();
      }
      return;
    }
    // Accept '-' key as an alias for ー (long vowel mark)
    if (k === '-') {
      e.preventDefault();
      game.stats.totalKeystrokes += 1;
      const cur = game.current.reading[game.index];
      if (cur === 'ー' && game.lastVowel) {
        game.index += 1;
        game.stats.correctKeystrokes += 1;
        game.errorAtCurrent = false;
        updateWordClasses();
        if (game.index >= game.current.reading.length) {
          game.stats.completed += 1;
          els.word.classList.add('glow'); sfx.success();
          setTimeout(showNextWord, 120);
        }
      } else {
        game.hadErrorInWord = true;
        game.errorAtCurrent = true;
        els.word.classList.add('shake'); sfx.error();
        els.word.addEventListener('animationend', () => els.word.classList.remove('shake'), { once: true });
        updateWordClasses();
      }
      return;
    }
    if (k.length === 1 && k >= 'a' && k <= 'z') {
      e.preventDefault();
      game.stats.totalKeystrokes += 1;
      game.romajiBuffer += k;
      const progressed = consumeIfMatches();
      if (!progressed) {
        const expectedUnit = getExpectedUnit(game.current.reading, game.index) || game.current.reading[game.index];
        if (expectedUnit) {
          let dead = false;
          if (game.current.reading[game.index] === 'っ') {
            dead = !/^([bcdfghjklmnpqrstvwxyz])\1/.test(game.romajiBuffer);
          } else if (game.current.reading[game.index] === 'ー') {
            dead = !(game.lastVowel && game.romajiBuffer[0] === game.lastVowel);
          } else if (game.current.reading[game.index] === 'ん') {
            // possible prefixes: 'nn', 'n' + consonant (not y), or 'm' before b/p/m
            const b0 = game.romajiBuffer[0];
            const b1 = game.romajiBuffer[1];
            const nextUnit = getExpectedUnit(game.current.reading, game.index + 1);
            const nextList = nextUnit ? possibleForUnit(nextUnit) : [];
            const nextStartsWithLabial = nextList.some(r => /^[bpm]/.test(r));
            dead = !(
              game.romajiBuffer.startsWith('nn') ||
              (b0 === 'n' && (!b1 || b1 === 'n' || (isConsonant(b1) && b1 !== 'y'))) ||
              (b0 === 'm' && nextStartsWithLabial)
            );
          } else {
            dead = !isPossiblePrefix(game.romajiBuffer, expectedUnit);
          }
          // Try to recover by trimming invalid leading chars so the suffix becomes a valid prefix
          if (dead && expectedUnit && !['っ','ー','ん'].includes(game.current.reading[game.index])) {
            let buf = game.romajiBuffer;
            while (buf.length > 0 && !isPossiblePrefix(buf, expectedUnit)) buf = buf.slice(1);
            if (buf !== game.romajiBuffer) {
              game.romajiBuffer = buf;
              // If after trimming it's valid, clear error and attempt consume
              if (buf.length === 0 || isPossiblePrefix(buf, expectedUnit)) {
                const progressed2 = consumeIfMatches();
                game.errorAtCurrent = false;
                dead = false;
              }
            }
          }
          if (dead) {
            game.hadErrorInWord = true;
            game.errorAtCurrent = true;
            els.word.classList.add('shake'); sfx.error();
            els.word.addEventListener('animationend', () => els.word.classList.remove('shake'), { once: true });
          } else {
            game.errorAtCurrent = false;
          }
        }
      }
      updateWordClasses();
      if (game.index >= game.current.reading.length) {
        game.stats.completed += 1;
        els.word.classList.add('glow'); sfx.success();
        setTimeout(showNextWord, 120);
      }
    }
  }

  function applySettingsFromUI() {
    const dur = Math.max(5, Math.min(120, Number(els.setDuration.value || defaults.durationSeconds)));
    settings.durationSeconds = dur;
    settings.caseSensitive = !!els.setCaseSensitive.checked;
    settings.mistakeMode = els.setMistakeMode.value === 'lenient' ? 'lenient' : 'strict';
    settings.pauseOnBlur = !!els.setPauseOnBlur.checked;
    settings.sound.enabled = !!els.setSoundEnabled.checked;
    settings.sound.volume = Number(els.setSoundVolume.value || 0.3);
    saveSettings();
    updateSettingsUI();
  }

  function bindUI() {
    els.startBtn.addEventListener('click', startGame);
    if (els.skipBtn) {
      els.skipBtn.addEventListener('click', () => {
        if (game.status === 'playing') {
          sfx.error();
          showNextWord();
        }
      });
    }
    els.openSettings.addEventListener('click', () => { updateSettingsUI(); els.settingsDialog.showModal(); });
    els.soundToggle.addEventListener('click', () => {
      settings.sound.enabled = !settings.sound.enabled; saveSettings(); updateSettingsUI();
    });
    els.settingsDialog.addEventListener('close', () => {/* noop */});
    document.getElementById('saveSettings').addEventListener('click', (e) => { e.preventDefault(); applySettingsFromUI(); els.settingsDialog.close(); });

    // Import words from settings
    els.importWords.addEventListener('change', onImportFile);
    // Shortcut import from result
    els.openImportFromResult.addEventListener('click', () => els.hiddenImport.click());
    els.hiddenImport.addEventListener('change', onImportFile);

    els.playAgain.addEventListener('click', () => { els.resultDialog.close(); startGame(); });
    els.closeResult.addEventListener('click', () => els.resultDialog.close());

    els.word.addEventListener('animationend', (e) => { if (e.animationName === 'glow') els.word.classList.remove('glow'); });
    els.pausedHint.addEventListener('click', () => resume());

    document.addEventListener('keydown', handleKey);
    // IME input is not used in romaji mode

    if (settings.pauseOnBlur) {
      window.addEventListener('blur', pause);
      window.addEventListener('focus', resume);
    }
  }

  function onImportFile(e) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const txt = String(reader.result || '');
        const list = txt.split(/\r?\n/)
          .map(l => l.trim())
          .filter(l => l && !l.startsWith('#'))
          .map(l => {
            const parts = l.split('\t');
            if (parts.length >= 2) return { display: parts[0], reading: (parts[1]||'').trim() };
            return { display: l, reading: l };
          });
        if (list.length) { words = list; showToast('単語リストを読み込みました'); }
        else showToast('読み込める単語がありません');
      } catch (_) { showToast('読み込みに失敗しました'); }
    };
    reader.readAsText(file, 'utf-8');
    e.target.value = '';
  }

  function showToast(msg) {
    // minimal toast via aria-live
    els.timeLabel.textContent = msg;
    setTimeout(() => { els.timeLabel.textContent = game.timeLeft.toFixed(1) + 's'; }, 1500);
  }

  function pause() {
    if (settings.pauseOnBlur && game.status === 'playing') {
      game.status = 'paused';
      els.pausedHint.hidden = false;
    }
  }
  function resume() {
    if (settings.pauseOnBlur && game.status === 'paused') {
      game.status = 'playing';
      els.pausedHint.hidden = true;
    }
  }

  async function init() {
    loadSettings();
    await loadConfig();
    updateSettingsUI();
    await loadWords();
    bindUI();
    els.word.innerHTML = '<div class="label">日本語の表記</div><div class="reading">ローマ字で入力（Enterで開始）</div>';
    els.timerBar.style.width = '100%';
    els.timeLabel.textContent = (settings.durationSeconds || 15).toFixed(1) + 's';
  }

  init();
})();
