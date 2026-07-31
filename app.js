/* ======================================================================
KONFIGURASI
====================================================================== */
const CLIENT_ID = "670272085628-e5s4aubec9fia1k31ppqm4k5c0tf64od.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const DATA_FILENAME = "catatan-app-data.json";
const CACHE_KEY = "catatan_cache_v5";
const NB_COLORS = ["#FFD93D", "#FF5D8F", "#4CC9F0", "#B9E351", "#B98CE0", "#FF8B3D", "#6FE7C0"];

/* ======================================================================
STATE
====================================================================== */
let state = defaultState();
let fileId = localStorage.getItem("catatan_file_id") || null;
let accessToken = localStorage.getItem("catatan_token") || null;
let tokenClient = null;
let currentNotebookId = null;
let currentSectionId = null;
let currentNoteId = null;
let mode = "normal";
let searchQuery = "";
let saveTimer = null;
let pageListDebounce = null;
let editorSaveLabelTimer = null;
let vditorInstance = null, vditorReady = false, pendingNote = null, suppressInput = false;
let collapsedSections = new Set();
let isResizing = false;

function defaultState() {
  const nbId = uid(), secId = uid();
  return {
    notebooks: [{ id: nbId, name: "Kerja", color: 0 }],
    sections: [{ id: secId, notebookId: nbId, parentSectionId: null, name: "Umum", color: 0, order: 0 }],
    notes: []
  };
}

/* ======================================================================
MIGRASI
====================================================================== */
function migrate(data) {
  if (data && Array.isArray(data.notebooks)) {
    data.sections = (data.sections || []).map((s, i) => ({
      ...s,
      parentSectionId: s.parentSectionId || null,
      order: s.order !== undefined ? s.order : i
    }));
    data.notes = data.notes || [];
    return data;
  }
  if (data && Array.isArray(data.projects)) {
    const nbId = uid();
    const notebooks = [{ id: nbId, name: "Catatanku", color: 0 }];
    const sections = data.projects.map((p, i) => ({ 
      id: p.id, notebookId: nbId, parentSectionId: null, name: p.name, color: i, order: i 
    }));
    const fallbackSectionId = sections[0] ? sections[0].id : null;
    const notes = (data.notes || []).map((n, idx) => ({
      id: n.id, sectionId: n.projectId || fallbackSectionId, title: n.title || "", 
      content: htmlToMdBestEffort(n.content || ""), categories: n.categories || [], 
      isTask: !!n.isTask, done: !!n.done, due: n.due || null, order: idx,
      createdAt: n.createdAt || new Date().toISOString(), updatedAt: n.updatedAt || new Date().toISOString()
    }));
    return { notebooks, sections, notes };
  }
  return defaultState();
}

function stripTags(s) { const d = document.createElement("div"); d.innerHTML = s; return d.textContent || ""; }
function htmlToMdBestEffort(html) {
  if (!html) return ""; let s = html;
  s = s.replace(/<h3[^>]*>(.*?)<\/h3>/gi, (m, inner) => "### " + stripTags(inner) + "\n");
  s = s.replace(/<(b|strong)[^>]*>(.*?)<\/\1>/gi, (m, tag, inner) => "**" + stripTags(inner) + "**");
  s = s.replace(/<li[^>]*>(.*?)<\/li>/gi, (m, inner) => "- " + stripTags(inner) + "\n");
  s = s.replace(/<\/(ul|ol)>/gi, "\n").replace(/<(ul|ol)[^>]*>/gi, "");
  s = s.replace(/<br\s*\/?>/gi, "\n"); s = s.replace(/<div[^>]*>/gi, "\n").replace(/<\/div>/gi, "");
  s = stripTags(s); return s.replace(/\n{3,}/g, "\n\n").trim();
}

/* ======================================================================
BOOT & GOOGLE AUTH
====================================================================== */
window.addEventListener("load", () => {
  loadCache();
  const check = setInterval(() => {
    if (window.google && google.accounts) { clearInterval(check); initGis(); }
  }, 100);
});

function loadCache() {
  const raw = localStorage.getItem(CACHE_KEY);
  if (raw) { try { state = migrate(JSON.parse(raw)); } catch (e) {} }
}
function saveCache() { localStorage.setItem(CACHE_KEY, JSON.stringify(state)); }

function initGis() { 
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: DRIVE_SCOPE, callback: onTokenResponse,
  });
  document.getElementById("signin-btn").addEventListener("click", () => {
    setGateStatus("Membuka jendela masuk Google...");
    tokenClient.requestAccessToken({ prompt: "consent" });
  });
  
  // Auto-login jika sudah punya token
  if (accessToken) {
    tokenClient.requestAccessToken({ prompt: "" });
  }
}

function setGateStatus(msg) { document.getElementById("gate-status").textContent = msg || ""; }

async function onTokenResponse(resp) {
  if (resp.error) { 
    setGateStatus("Belum masuk. Klik tombol untuk mencoba lagi."); 
    localStorage.removeItem("catatan_token");
    accessToken = null;
    return; 
  }
  accessToken = resp.access_token;
  localStorage.setItem("catatan_token", accessToken);
  const ms = (resp.expires_in || 3500) * 1000 - 60000;
  setTimeout(() => tokenClient.requestAccessToken({ prompt: "" }), Math.max(ms, 10000));
  await enterApp();
}

async function fetchUserEmail() {
  try {
    const r = await fetch("https://www.googleapis.com/oauth2/v3/userinfo", { headers: { Authorization: `Bearer ${accessToken}` } });
    const d = await r.json();
    document.getElementById("user-email").textContent = d.email || "";
  } catch (e) {}
}

document.getElementById("signout-btn").addEventListener("click", () => {
  if (accessToken) google.accounts.oauth2.revoke(accessToken, () => {});
  accessToken = null;
  localStorage.removeItem("catatan_token");
  document.getElementById("app").classList.add("hidden");
  document.getElementById("gate").classList.remove("hidden");
  setGateStatus("Kamu sudah keluar.");
});

/* ======================================================================
MASUK APLIKASI + SYNC DRIVE
====================================================================== */
async function enterApp() {
  document.getElementById("gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  fetchUserEmail();
  setSyncStatus("menyinkronkan...", "saving");
  let migratedFromOld = false;
  try {
    await driveEnsureFile();
    const remote = await driveLoadData();
    if (remote) {
      migratedFromOld = Array.isArray(remote.projects) && !Array.isArray(remote.notebooks);
      state = migrate(remote);
      saveCache();
    } else { state = migrate(state); }
    setSyncStatus("tersambung", "ok");
  } catch (e) {
    console.error(e);
    setSyncStatus("mode luring (offline)", "offline");
  }
  initVditor();
  currentNotebookId = state.notebooks[0] ? state.notebooks[0].id : null;
  toggleEditorEmpty(true);
  if (currentNotebookId) selectNotebook(currentNotebookId);
  setMobileScreen("notebooks");
  if (migratedFromOld) scheduleSave();
  initResizeHandle();
}

function setSyncStatus(label, m) {
  const pill = document.getElementById("sync-pill");
  pill.classList.remove("saving", "offline");
  if (m === "saving") pill.classList.add("saving");
  if (m === "offline") pill.classList.add("offline");
  document.getElementById("sync-label").textContent = label;
}

async function driveEnsureFile() {
  if (fileId) return;
  const q = encodeURIComponent(`name='${DATA_FILENAME}' and trashed=false`);
  const r = await fetch(`https://www.googleapis.com/drive/v3/files?q=${q}&spaces=drive&fields=files(id,name)`, {
    headers: { Authorization: `Bearer ${accessToken}` }
  });
  const d = await r.json();
  if (d.files && d.files.length > 0) {
    fileId = d.files[0].id;
    localStorage.setItem("catatan_file_id", fileId);
    return;
  }
  fileId = await driveCreateFile(state);
  localStorage.setItem("catatan_file_id", fileId);
}

async function driveCreateFile(dataObj) {
  const boundary = "catatan_boundary_" + Date.now();
  const metadata = { name: DATA_FILENAME, mimeType: "application/json" };
  const body =
    `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n` +
    `--${boundary}\r\nContent-Type: application/json\r\n\r\n${JSON.stringify(dataObj)}\r\n` +
    `--${boundary}--`;
  const r = await fetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": `multipart/related; boundary=${boundary}` },
    body
  });
  const d = await r.json();
  return d.id;
}

async function driveLoadData() {
  const r = await fetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`, { headers: { Authorization: `Bearer ${accessToken}` } });
  if (!r.ok) return null;
  const text = await r.text();
  if (!text) return null;
  try { return JSON.parse(text); } catch (e) { return null; }
}

async function driveSaveData() {
  if (!accessToken || !fileId) return;
  setSyncStatus("menyimpan...", "saving");
  try {
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    setSyncStatus("tersambung", "ok");
  } catch (e) { setSyncStatus("mode luring (offline)", "offline"); }
}

function scheduleSave() {
  saveCache();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(driveSaveData, 1200);
}

/* ======================================================================
HELPERS & CUSTOM MODAL / CONTEXT MENU
====================================================================== */
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function noteById(id) { return state.notes.find(n => n.id === id); }
function sectionById(id) { return state.sections.find(s => s.id === id); }
function notebookById(id) { return state.notebooks.find(n => n.id === id); }
function allSectionsOf(nbId) { return state.sections.filter(s => s.notebookId === nbId).sort((a,b) => a.name.localeCompare(b.name)); }
function allNotesOf(secId) { return state.notes.filter(n => n.sectionId === secId).sort((a,b) => (a.order||0) - (b.order||0)); }
function crumbFor(n) {
  const sec = sectionById(n.sectionId);
  const nb = sec ? notebookById(sec.notebookId) : null;
  return nb && sec ? `${nb.name} / ${sec.name}` : "";
}
function plainText(md) {
  if (!md) return ""; let s = md;
  s = s.replace(/```[\s\S]*?```/g, ""); s = s.replace(/`([^`]+)`/g, "$1");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, ""); s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/[#>*_~-]/g, ""); s = s.replace(/\s+/g, " ").trim();
  return s;
}
function plainSnippet(md) { const t = plainText(md); return t.length > 90 ? t.slice(0, 90) + "…" : t; }
function matchesSearch(n, q) {
  const hay = (n.title + " " + plainText(n.content) + " " + (n.categories || []).join(" ") + " " + crumbFor(n)).toLowerCase();
  return hay.includes(q);
}
function fmtDate(iso) { if (!iso) return ""; return new Date(iso).toLocaleDateString("id-ID", { day: "numeric", month: "short" }); }
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

// --- CUSTOM MODAL ---
function showCustomModal({ title, message, showInput = false, inputValue = '', confirmText = 'OK', confirmClass = 'btn-red' }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-modal');
    const titleEl = document.getElementById('modal-title');
    const msgEl = document.getElementById('modal-message');
    const inputEl = document.getElementById('modal-input');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');

    titleEl.textContent = title; msgEl.textContent = message;
    confirmBtn.textContent = confirmText;
    confirmBtn.className = 'btn-brut ' + confirmClass;
    
    if (showInput) {
      inputEl.classList.remove('hidden'); inputEl.value = inputValue;
      setTimeout(() => inputEl.select(), 50);
    } else { inputEl.classList.add('hidden'); }

    modal.classList.remove('hidden');
    const cleanup = (result) => { modal.classList.add('hidden'); resolve(result); };

    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
    newConfirm.onclick = () => cleanup(showInput ? inputEl.value.trim() : true);

    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    newCancel.onclick = () => cleanup(showInput ? null : false);
  });
}

// --- CONTEXT MENU ---
const ctxMenu = document.getElementById('context-menu');
function showContextMenu(e, type, id, name) {
  e.preventDefault(); e.stopPropagation();
  let buttons = '';
  if (type === 'notebook') {
    buttons = `<button data-action="rename">✏️ Ubah Nama</button><button data-action="delete" class="danger">🗑️ Hapus Notebook</button>`;
  } else if (type === 'section') {
    buttons = `
      <button data-action="rename">✏️ Ubah Nama</button>
      <button data-action="delete" class="danger">🗑️ Hapus Bagian</button>`;
  } else if (type === 'note') {
    buttons = `<button data-action="rename">✏️ Ubah Judul</button><button data-action="delete" class="danger">🗑️ Hapus Catatan</button>`;
  }

  ctxMenu.innerHTML = buttons;
  ctxMenu.style.left = `${e.clientX}px`; ctxMenu.style.top = `${e.clientY}px`;
  ctxMenu.classList.remove('hidden');

  ctxMenu.querySelectorAll('button').forEach(btn => {
    btn.onclick = async () => {
      ctxMenu.classList.add('hidden');
      const action = btn.dataset.action;
      if (action === 'rename') {
        const newName = await showCustomModal({ title: "Ubah Nama", message: `Nama baru untuk "${name}":`, showInput: true, inputValue: name, confirmText: "Simpan", confirmClass: "btn-lime" });
        if (newName) handleRename(type, id, newName);
      } else if (action === 'delete') {
        const ok = await showCustomModal({ title: "Hapus Item", message: `Hapus "${name}"? Tindakan ini tidak bisa dibatalkan.`, confirmText: "Ya, Hapus", confirmClass: "btn-red" });
        if (ok) handleDelete(type, id);
      }
    };
  });
}
document.addEventListener('click', () => ctxMenu.classList.add('hidden'));
window.addEventListener('blur', () => ctxMenu.classList.add('hidden'));

function handleRename(type, id, newName) {
  if (type === 'notebook') { const nb = notebookById(id); if(nb) nb.name = newName; }
  else if (type === 'section') { const sec = sectionById(id); if(sec) sec.name = newName; }
  else if (type === 'note') { const n = noteById(id); if(n) { n.title = newName; n.updatedAt = new Date().toISOString(); if(currentNoteId === id) document.getElementById('edit-title').value = newName; } }
  scheduleSave(); renderAll();
}

function handleDelete(type, id) {
  if (type === 'notebook') {
    const secIds = allSectionsOf(id).map(s => s.id);
    state.notes = state.notes.filter(n => !secIds.includes(n.sectionId));
    state.sections = state.sections.filter(s => s.notebookId !== id);
    state.notebooks = state.notebooks.filter(n => n.id !== id);
    if (currentNotebookId === id) { currentNotebookId = state.notebooks[0]?.id || null; toggleEditorEmpty(true); }
  } else if (type === 'section') {
    state.notes = state.notes.filter(n => n.sectionId !== id);
    state.sections = state.sections.filter(s => s.id !== id);
    if (currentSectionId === id) { currentSectionId = null; toggleEditorEmpty(true); }
  } else if (type === 'note') {
    state.notes = state.notes.filter(n => n.id !== id);
    if (currentNoteId === id) { currentNoteId = null; toggleEditorEmpty(true); }
  }
  scheduleSave(); renderAll();
}

/* ======================================================================
RESIZE HANDLE
====================================================================== */
function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  const app = document.getElementById('app');
  
  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    e.preventDefault();
  });
  
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const newWidth = e.clientX;
    if (newWidth > 150 && newWidth < 500) {
      document.documentElement.style.setProperty('--pages-width', newWidth + 'px');
    }
  });
  
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
    }
  });
}

/* ======================================================================
VDITOR
====================================================================== */
function initVditor() {
  if (vditorInstance) return;
  vditorInstance = new Vditor("vditor-container", {
    mode: "ir", height: "100%", cache: { enable: false },
    toolbar: ["headings", "bold", "italic", "strike", "|", "list", "ordered-list", "check", "quote", "|", "undo", "redo"],
    after: () => { vditorReady = true; if (pendingNote) { loadNoteIntoEditor(pendingNote); pendingNote = null; } },
    input: (value) => { onEditorInput(value); }
  });
}
function loadNoteIntoEditor(n) {
  if (!vditorReady) { pendingNote = n; return; }
  suppressInput = true; vditorInstance.setValue(n.content || "");
  setTimeout(() => { suppressInput = false; }, 100);
}
function onEditorInput(value) {
  if (suppressInput) return;
  const n = noteById(currentNoteId); if (!n) return;
  n.content = value; n.updatedAt = new Date().toISOString();
  markSavingLabel(); scheduleSave();
}
function markSavingLabel() {
  document.getElementById("edit-savestate").textContent = "Menyimpan...";
  clearTimeout(editorSaveLabelTimer);
  editorSaveLabelTimer = setTimeout(() => { document.getElementById("edit-savestate").textContent = "Tersimpan"; }, 1400);
}

/* ======================================================================
RENDER — KOLOM 1: NOTEBOOK
====================================================================== */
function renderNotebooks() {
  const list = document.getElementById("notebook-list");
  list.innerHTML = "";
  const sortedNotebooks = [...state.notebooks].sort((a,b) => a.name.localeCompare(b.name));
  
  sortedNotebooks.forEach(nb => {
    const secIds = state.sections.filter(s => s.notebookId === nb.id).map(s => s.id);
    const count = state.notes.filter(n => secIds.includes(n.sectionId)).length;

    const li = document.createElement("li");
    li.className = "notebook-item" + (currentNotebookId === nb.id && mode === "normal" ? " active" : "");
    li.innerHTML = `<span style="display:flex;align-items:center;gap:8px;"><span class="nb-dot" style="background:${NB_COLORS[nb.color % NB_COLORS.length]}"></span>${escapeHtml(nb.name)}</span><span class="nb-count">${count}</span>`;
    li.addEventListener("click", () => selectNotebook(nb.id));
    li.addEventListener("contextmenu", (e) => showContextMenu(e, 'notebook', nb.id, nb.name));
    list.appendChild(li);
  });
}

document.getElementById("btn-new-notebook").addEventListener("click", async () => {
  const name = await showCustomModal({ title: "Notebook Baru", message: "Berikan nama untuk notebook baru:", showInput: true, confirmText: "Buat", confirmClass: "btn-lime" });
  if (!name) return;
  const nb = { id: uid(), name: name, color: state.notebooks.length };
  const sec = { id: uid(), notebookId: nb.id, parentSectionId: null, name: "Umum", color: 0, order: 0 };
  state.notebooks.push(nb); state.sections.push(sec);
  scheduleSave(); selectNotebook(nb.id);
});

document.getElementById("search-input").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  mode = searchQuery ? "search" : "normal";
  document.getElementById("search-clear").classList.toggle("hidden", !searchQuery);
  renderAll(); if (mode === "search") setMobileScreen("pages");
});

document.getElementById("search-clear").addEventListener("click", () => {
  document.getElementById("search-input").value = "";
  searchQuery = "";
  mode = "normal";
  document.getElementById("search-clear").classList.add("hidden");
  renderAll();
});

/* ======================================================================
RENDER — KOLOM 2: SECTIONS + PAGES (GROUPED)
====================================================================== */
function selectNotebook(id) {
  currentNotebookId = id; mode = "normal";
  if (allSectionsOf(id).length === 0) {
    const s = { id: uid(), notebookId: id, parentSectionId: null, name: "Umum", color: 0, order: 0 };
    state.sections.push(s); scheduleSave();
  }
  currentSectionId = allSectionsOf(id)[0].id;
  renderAll(); setMobileScreen("pages");
}

document.getElementById("btn-new-section").addEventListener("click", async () => {
  if (!currentNotebookId) return;
  const name = await showCustomModal({ title: "Bagian Baru", message: "Nama bagian baru:", showInput: true, confirmText: "Buat", confirmClass: "btn-lime" });
  if (!name) return;
  const s = { id: uid(), notebookId: currentNotebookId, parentSectionId: null, name: name, color: 0, order: Date.now() };
  state.sections.push(s); currentSectionId = s.id;
  scheduleSave(); renderAll();
});

document.getElementById("btn-new-page").addEventListener("click", () => {
  if (mode !== "normal" || !currentNotebookId) return;
  const targetSectionId = currentSectionId || allSectionsOf(currentNotebookId)[0].id;
  const n = {
    id: uid(), sectionId: targetSectionId, title: "", content: "",
    categories: [], isTask: false, done: false, due: null, order: Date.now(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  state.notes.unshift(n); scheduleSave();
  renderPageList(); openNote(n.id);
});

function renderPageList() {
  const wrap = document.getElementById("page-list");
  wrap.innerHTML = "";
  let title = "—";

  if (mode === "search") {
    const rows = state.notes.filter(n => matchesSearch(n, searchQuery));
    title = `Hasil pencarian "${searchQuery}"`;
    document.getElementById("notebook-title").textContent = title;
    document.getElementById("pages-empty").classList.toggle("hidden", rows.length !== 0);
    
    rows.forEach(n => {
      const div = createPageItem(n, crumbFor(n));
      wrap.appendChild(div);
    });
  } else if (mode === "normal" && currentNotebookId) {
    const sections = allSectionsOf(currentNotebookId);
    const nb = notebookById(currentNotebookId);
    title = nb ? nb.name : "—";
    document.getElementById("notebook-title").textContent = title;
    
    let hasAnyNotes = false;
    
    sections.forEach(sec => {
      const notes = allNotesOf(sec.id);
      if (notes.length === 0) return;
      hasAnyNotes = true;
      
      const group = document.createElement("div");
      group.className = "section-group";
      
      const isCollapsed = collapsedSections.has(sec.id);
      const header = document.createElement("div");
      header.className = "section-header" + (isCollapsed ? " collapsed" : "");
      header.innerHTML = `<span class="toggle">▼</span><span>${escapeHtml(sec.name)}</span><span style="margin-left:auto;font-size:10px;opacity:.7;">${notes.length}</span>`;
      header.addEventListener("click", () => {
        if (collapsedSections.has(sec.id)) collapsedSections.delete(sec.id);
        else collapsedSections.add(sec.id);
        renderPageList();
      });
      header.addEventListener("contextmenu", (e) => showContextMenu(e, 'section', sec.id, sec.name));
      
      const pagesContainer = document.createElement("div");
      pagesContainer.className = "section-pages" + (isCollapsed ? " collapsed" : "");
      pagesContainer.dataset.sectionId = sec.id;
      
      notes.forEach(n => {
        const div = createPageItem(n, null);
        pagesContainer.appendChild(div);
      });
      
      group.appendChild(header);
      group.appendChild(pagesContainer);
      wrap.appendChild(group);
      
      // Init SortableJS untuk drag-drop pages
      if (window.Sortable && !isCollapsed) {
        Sortable.create(pagesContainer, {
          group: 'pages',
          animation: 150,
          ghostClass: 'sortable-ghost',
          onEnd: (evt) => {
            const newSectionId = evt.to.dataset.sectionId;
            const noteId = evt.item.dataset.id;
            const note = noteById(noteId);
            if (note) {
              note.sectionId = newSectionId;
              note.order = evt.newIndex;
              // Reorder other notes in the section
              const items = evt.to.querySelectorAll('.page-item');
              items.forEach((el, idx) => {
                const n = noteById(el.dataset.id);
                if (n) n.order = idx;
              });
              scheduleSave();
              renderPageList();
            }
          }
        });
      }
    });
    
    document.getElementById("pages-empty").classList.toggle("hidden", hasAnyNotes);
  }
}

function createPageItem(n, crumb) {
  const today = new Date().toISOString().slice(0, 10);
  const div = document.createElement("div");
  div.className = "page-item" + (currentNoteId === n.id ? " active" : "");
  div.dataset.id = n.id;
  const overdue = n.isTask && !n.done && n.due && n.due < today;
  const checkHtml = n.isTask ? `<span class="mini-check ${n.done ? "done" : ""}" data-id="${n.id}">${n.done ? "✓" : ""}</span>` : "";
  div.innerHTML = `${crumb ? `<div class="page-item-crumb">${escapeHtml(crumb)}</div>` : ""}
    <p class="page-item-title">${checkHtml}${escapeHtml(n.title || "Tanpa judul")}</p>
    <div class="page-item-snip">${escapeHtml(plainSnippet(n.content))}</div>
    <div class="page-item-foot"><span>${fmtDate(n.updatedAt)}</span>${n.isTask && n.due ? `<span class="page-item-due ${overdue ? "overdue" : ""}">${fmtDate(n.due)}</span>` : ""}</div>`;
  
  div.addEventListener("click", (e) => {
    if (e.target.classList.contains("mini-check")) return;
    openNote(n.id);
  });
  div.addEventListener("contextmenu", (e) => showContextMenu(e, 'note', n.id, n.title || "Tanpa judul"));
  
  const chk = div.querySelector(".mini-check");
  if (chk) chk.addEventListener("click", (e) => {
    e.stopPropagation(); n.done = !n.done; n.updatedAt = new Date().toISOString();
    scheduleSave(); renderPageList();
  });
  
  return div;
}

function renderAll() {
  renderNotebooks(); renderPageList();
}

function queuePageListRefresh() {
  clearTimeout(pageListDebounce);
  pageListDebounce = setTimeout(renderPageList, 350);
}

/* ======================================================================
RENDER — KOLOM 3: EDITOR
====================================================================== */
function toggleEditorEmpty(showEmpty) {
  document.getElementById("editor-empty").classList.toggle("hidden", !showEmpty);
  document.getElementById("edit-title").classList.toggle("hidden", showEmpty);
  document.getElementById("meta-row").classList.toggle("hidden", showEmpty);
  document.getElementById("vditor-container").classList.toggle("hidden", showEmpty);
  document.getElementById("btn-delete-note").classList.toggle("hidden", showEmpty);
}

function openNote(id) {
  currentNoteId = id; const n = noteById(id); if (!n) return;
  document.getElementById("edit-title").value = n.title || "";
  document.getElementById("edit-category").value = (n.categories || []).join(", ");
  document.getElementById("edit-due").value = n.due || "";
  document.getElementById("edit-due").classList.toggle("hidden", !n.isTask);
  document.getElementById("tb-task").classList.toggle("active", !!n.isTask);
  document.getElementById("edit-savestate").textContent = "";
  toggleEditorEmpty(false); loadNoteIntoEditor(n);
  renderPageList(); setMobileScreen("editor");
}

document.getElementById("edit-title").addEventListener("input", () => {
  const n = noteById(currentNoteId); if (!n) return;
  n.title = document.getElementById("edit-title").value;
  n.updatedAt = new Date().toISOString(); markSavingLabel(); scheduleSave(); queuePageListRefresh();
});
document.getElementById("edit-category").addEventListener("input", () => {
  const n = noteById(currentNoteId); if (!n) return;
  n.categories = document.getElementById("edit-category").value.split(",").map(s => s.trim()).filter(Boolean);
  n.updatedAt = new Date().toISOString(); markSavingLabel(); scheduleSave();
});
document.getElementById("edit-due").addEventListener("input", () => {
  const n = noteById(currentNoteId); if (!n) return;
  n.due = document.getElementById("edit-due").value || null;
  n.updatedAt = new Date().toISOString(); markSavingLabel(); scheduleSave(); queuePageListRefresh();
});
document.getElementById("tb-task").addEventListener("click", () => {
  const n = noteById(currentNoteId); if (!n) return;
  n.isTask = !n.isTask;
  document.getElementById("tb-task").classList.toggle("active", n.isTask);
  document.getElementById("edit-due").classList.toggle("hidden", !n.isTask);
  n.updatedAt = new Date().toISOString(); markSavingLabel(); scheduleSave(); queuePageListRefresh();
});

document.getElementById("btn-delete-note").addEventListener("click", async () => {
  if (!currentNoteId) return;
  const ok = await showCustomModal({ title: "Hapus Catatan?", message: "Catatan yang dihapus tidak bisa dikembalikan. Yakin ingin melanjutkan?", confirmText: "Ya, Hapus", confirmClass: "btn-red" });
  if (!ok) return;
  handleDelete('note', currentNoteId);
});

/* ======================================================================
NAVIGASI MOBILE
====================================================================== */
function setMobileScreen(name) {
  const show = { notebooks: "col-notebooks", pages: "col-pages", editor: "col-editor" }[name];
  ["col-notebooks", "col-pages", "col-editor"].forEach(id => {
    document.getElementById(id).classList.toggle("mobile-show", id === show);
  });
}
document.getElementById("btn-back-to-notebooks").addEventListener("click", () => setMobileScreen("notebooks"));
document.getElementById("btn-back-to-pages").addEventListener("click", () => setMobileScreen("pages"));