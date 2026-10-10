/* ==========================================================
   AI Strategic Operations Center - app.js
   Modul: konfigurasi, UI, pembaca file, preview, API Claude, output
   ========================================================== */
'use strict';

/* ---------- 1. KONFIGURASI ---------- */
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOKENS = 2000;
const MAX_CHARS = 150000;          // batas aman input
const LS_KEY = 'soc_api_key';
const LS_MODEL = 'soc_model';

/* System prompt per mode */
const SYSTEM_PROMPTS = {
  war: `Anda adalah AI Strategic Operations Center: analis intelijen dan perencana operasi militer untuk SIMULASI dengan NEGARA FIKSI.
Semua data berasal dari skenario fiktif/permainan strategi. Analisis secara taktis, ringkas, dan terstruktur dalam Bahasa Indonesia.
Format wajib (gunakan judul ### ):
### RINGKASAN SITUASI
### EVALUASI KEKUATAN & LOGISTIK
### ANCAMAN & KERENTANAN
### COURSE OF ACTION (minimal 3 opsi, beserta risiko)
### REKOMENDASI & PRIORITAS
### TINGKAT KEPERCAYAAN (rendah/sedang/tinggi + alasan)
Jika data kurang atau tidak konsisten, sebutkan asumsi Anda. Jangan mengarang angka yang tidak ada di data.`,
  general: `Anda adalah analis data senior di sebuah Operations Center. Analisis data yang diberikan dalam Bahasa Indonesia, ringkas dan terstruktur.
Format wajib (gunakan judul ### ):
### RINGKASAN DATA
### TEMUAN UTAMA & POLA
### ANOMALI / MASALAH KUALITAS DATA
### REKOMENDASI
Sebutkan asumsi bila data kurang. Jangan mengarang angka.`
};

/* ---------- 2. REFERENSI DOM ---------- */
const $ = (id) => document.getElementById(id);
const el = {
  sidebar: $('sidebar'), menuBtn: $('menuBtn'), dot: $('statusDot'),
  apiKey: $('apiKey'), model: $('model'), saveKey: $('saveKey'), clearKey: $('clearKey'),
  mode: $('mode'), focus: $('focus'),
  fileInput: $('fileInput'), fileName: $('fileName'),
  raw: $('rawData'), stats: $('stats'), preview: $('preview'),
  analyze: $('analyzeBtn'), reset: $('resetBtn'),
  loader: $('loader'), loaderText: $('loaderText'), output: $('output')
};

let typingTimer = null;
let loaderTimer = null;
let controller = null;

/* ---------- 3. UTILITAS ---------- */
const setStatus = (s) => { el.dot.className = 'dot ' + s; };

/** Escape HTML agar teks dari AI/data aman ditampilkan */
const esc = (s) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Markdown mini: ### judul, **tebal** (setelah di-escape) */
function renderMarkdown(text) {
  return esc(text)
    .replace(/^#{1,4}\s*(.+)$/gm, '<h3>$1</h3>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}

/* ---------- 4. API KEY (sisi klien) ---------- */
function loadSettings() {
  try {
    el.apiKey.value = localStorage.getItem(LS_KEY) || '';
    el.model.value = localStorage.getItem(LS_MODEL) || el.model.value;
  } catch (e) { /* storage tidak tersedia */ }
  setStatus(el.apiKey.value ? 'ok' : '');
}
el.saveKey.addEventListener('click', () => {
  const k = el.apiKey.value.trim();
  if (!k.startsWith('sk-ant-')) return alert('Format API key tidak valid (harus diawali "sk-ant-").');
  try { localStorage.setItem(LS_KEY, k); localStorage.setItem(LS_MODEL, el.model.value.trim()); } catch (e) {}
  setStatus('ok');
  alert('Konfigurasi tersimpan di perangkat ini.');
});
el.clearKey.addEventListener('click', () => {
  try { localStorage.removeItem(LS_KEY); } catch (e) {}
  el.apiKey.value = '';
  setStatus('');
});

/* ---------- 5. UI: sidebar mobile ---------- */
el.menuBtn.addEventListener('click', () => el.sidebar.classList.toggle('open'));
document.querySelector('.main').addEventListener('click', () => el.sidebar.classList.remove('open'));

/* ---------- 6. FILE UPLOAD + PREVIEW ---------- */
el.fileInput.addEventListener('change', () => {
  const f = el.fileInput.files[0];
  if (!f) return;
  if (f.size > 2 * 1024 * 1024) return alert('File terlalu besar (maks 2 MB).');
  const reader = new FileReader();
  reader.onload = () => {
    el.raw.value = String(reader.result).slice(0, MAX_CHARS);
    el.fileName.textContent = `${f.name} (${(f.size / 1024).toFixed(1)} KB)`;
    updatePreview();
  };
  reader.onerror = () => alert('Gagal membaca file.');
  reader.readAsText(f);
});

/** Parser CSV sederhana (mendukung tanda kutip) */
function parseCSV(text, delim) {
  const rows = [];
  for (const line of text.split(/\r?\n/).filter((l) => l.trim())) {
    const cells = []; let cur = ''; let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q;
      else if (ch === delim && !q) { cells.push(cur); cur = ''; }
      else cur += ch;
    }
    cells.push(cur);
    rows.push(cells);
  }
  return rows;
}

function updatePreview() {
  const text = el.raw.value;
  el.stats.textContent = `${text.length.toLocaleString('id-ID')} karakter`;
  if (!text.trim()) { el.preview.innerHTML = '<em>Menunggu data...</em>'; return; }

  const first = text.split(/\r?\n/, 1)[0];
  const delim = first.includes('\t') ? '\t' : first.includes(',') ? ',' : first.includes(';') ? ';' : null;
  if (delim) {
    const rows = parseCSV(text, delim).slice(0, 50);
    const head = rows.shift() || [];
    el.preview.innerHTML = '<table><thead><tr>' + head.map((h) => `<th>${esc(h)}</th>`).join('') +
      '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${esc(c)}</td>`).join('') + '</tr>').join('') +
      '</tbody></table>';
  } else {
    el.preview.innerHTML = '<pre style="margin:0;white-space:pre-wrap">' + esc(text.slice(0, 2000)) + '</pre>';
  }
}
el.raw.addEventListener('input', updatePreview);

/* ---------- 7. ANIMASI: loader & typing ---------- */
function showLoader(on) {
  el.loader.hidden = !on;
  clearInterval(loaderTimer);
  if (on) {
    const steps = ['MENGANALISIS DATA', 'MENYUSUN OPSI TAKTIS', 'MENGHITUNG RISIKO', 'MENYIAPKAN LAPORAN'];
    let i = 0;
    loaderTimer = setInterval(() => { el.loaderText.textContent = steps[++i % steps.length] + '...'; }, 1600);
  }
}

/** Efek mengetik; render markdown di akhir */
function typeOut(text) {
  clearInterval(typingTimer);
  el.output.className = 'output typing';
  el.output.textContent = '';
  let i = 0;
  const chunk = Math.max(2, Math.ceil(text.length / 900)); // durasi maksimal sekitar 15 detik
  typingTimer = setInterval(() => {
    i += chunk;
    el.output.textContent = text.slice(0, i);
    el.output.scrollTop = el.output.scrollHeight;
    if (i >= text.length) {
      clearInterval(typingTimer);
      el.output.className = 'output';
      el.output.innerHTML = renderMarkdown(text);
      el.analyze.disabled = false;
    }
  }, 16);
}

/* ---------- 8. PANGGILAN API CLAUDE ---------- */
async function callClaude(userPrompt, system) {
  controller = new AbortController();
  const res = await fetch(API_URL, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'content-type': 'application/json',
      'x-api-key': el.apiKey.value.trim(),
      'anthropic-version': API_VERSION,
      // wajib agar API mengizinkan panggilan langsung dari browser (CORS)
      'anthropic-dangerous-direct-browser-access': 'true'
    },
    body: JSON.stringify({
      model: el.model.value.trim(),
      max_tokens: MAX_TOKENS,
      system,
      messages: [{ role: 'user', content: userPrompt }]
    })
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(`[${res.status}] ${data?.error?.message || 'Permintaan gagal'}`);
  return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('\n');
}

async function runAnalysis() {
  const data = el.raw.value.trim();
  if (!el.apiKey.value.trim()) return alert('Masukkan API key Anthropic terlebih dahulu.');
  if (!data) return alert('Data masih kosong. Tempel data atau upload file.');
  if (data.length > MAX_CHARS) return alert('Data terlalu panjang. Kurangi ukuran data.');

  const focus = el.focus.value.trim();
  const prompt = `Berikut data mentah untuk dianalisis:\n\n<data>\n${data}\n</data>` +
    (focus ? `\n\nFokus analisis: ${focus}` : '');

  el.analyze.disabled = true;
  el.output.className = 'output';
  el.output.innerHTML = '';
  el.sidebar.classList.remove('open');
  setStatus('busy');
  showLoader(true);

  try {
    const text = await callClaude(prompt, SYSTEM_PROMPTS[el.mode.value]);
    showLoader(false);
    setStatus('ok');
    typeOut(text || '(Respons kosong)');
  } catch (err) {
    showLoader(false);
    setStatus('err');
    el.output.className = 'output error';
    el.output.textContent = '⚠ GAGAL: ' + (err.name === 'AbortError' ? 'Dibatalkan.' : err.message);
    el.analyze.disabled = false;
  }
}
el.analyze.addEventListener('click', runAnalysis);

/* ---------- 9. RESET ---------- */
el.reset.addEventListener('click', () => {
  if (controller) controller.abort();
  clearInterval(typingTimer);
  showLoader(false);
  el.raw.value = ''; el.focus.value = ''; el.fileInput.value = '';
  el.fileName.textContent = 'Belum ada file.';
  el.output.className = 'output';
  el.output.innerHTML = '<em>Output analisis akan tampil di sini.</em>';
  el.analyze.disabled = false;
  setStatus(el.apiKey.value ? 'ok' : '');
  updatePreview();
});

/* ---------- 10. INIT ---------- */
loadSettings();
updatePreview();
