/* ======================================================================
KONFIGURASI
====================================================================== */
const CLIENT_ID = "670272085628-e5s4aubec9fia1k31ppqm4k5c0tf64od.apps.googleusercontent.com";
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file https://www.googleapis.com/auth/userinfo.email";
const DATA_FILENAME = "catatan-app-data.json";
const CACHE_KEY = "catatan_cache_v7";
const COLORS = ["#FFD93D", "#FF5D8F", "#4CC9F0", "#B9E351", "#B98CE0", "#FF8B3D", "#6FE7C0"];

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
let activeTag = null;
let saveTimer = null;
let pageListDebounce = null;
let editorSaveLabelTimer = null;
let vditorInstance = null, vditorReady = false, pendingNote = null, suppressInput = false;
let collapsedSections = new Set();
let isResizing = false;
let sidebarCollapsed = localStorage.getItem("catatan_sidebar_collapsed") === "true";

function defaultState() {
  const nbId = uid(), secId = uid();
  return {
    notebooks: [{ id: nbId, name: "Work", color: 0 }],
    sections: [{ id: secId, notebookId: nbId, parentSectionId: null, name: "General", color: 0, order: 0 }],
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
      order: s.order !== undefined ? s.order : i,
      color: s.color !== undefined ? s.color : 0
    }));
    data.notes = (data.notes || []).map((n, i) => {
      if (n.notebookId) return { ...n, order: n.order !== undefined ? n.order : i };
      const sec = data.sections.find(s => s.id === n.sectionId);
      return { ...n, notebookId: sec ? sec.notebookId : (data.notebooks[0] ? data.notebooks[0].id : null), order: n.order !== undefined ? n.order : i };
    });
    return data;
  }
  return defaultState();
}

/* ======================================================================
BOOT & GOOGLE AUTH
====================================================================== */
window.addEventListener("load", () => {
  loadCache();
  applySidebarState();
  const check = setInterval(() => {
    if (window.google && google.accounts) { clearInterval(check); initGis(); }
  }, 100);
});

function loadCache() {
  const raw = localStorage.getItem(CACHE_KEY);
  if (raw) { try { state = migrate(JSON.parse(raw)); } catch (e) {} }
}

function saveCache() { 
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(state)); 
  } catch (error) {
    console.warn("Penyimpanan lokal browser penuh, aplikasi akan bergantung pada Google Drive.");
  }
}

function initGis() {
  tokenClient = google.accounts.oauth2.initTokenClient({
    client_id: CLIENT_ID, scope: DRIVE_SCOPE, callback: onTokenResponse,
  });
  document.getElementById("signin-btn").addEventListener("click", () => {
    setGateStatus("Opening Google sign-in...");
    tokenClient.requestAccessToken({ prompt: "consent" });
  });
  if (accessToken) {
    setGateStatus("Signing in automatically...");
    enterApp().catch(err => {
      console.error("Auto-login failed:", err);
      localStorage.removeItem("catatan_token");
      accessToken = null;
      setGateStatus("Session expired. Please sign in again.");
    });
  }
}

function setGateStatus(msg) { document.getElementById("gate-status").textContent = msg || ""; }

async function onTokenResponse(resp) {
  if (resp.error) {
    setGateStatus("Not signed in. Click the button to try again.");
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
    if (!r.ok) throw new Error("Failed to fetch user");
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
  setGateStatus("You have been signed out.");
});

/* ======================================================================
MASUK APLIKASI + SYNC DRIVE
====================================================================== */
async function enterApp() {
  document.getElementById("gate").classList.add("hidden");
  document.getElementById("app").classList.remove("hidden");
  fetchUserEmail();
  setSyncStatus("syncing...", "saving");
  try {
    await driveEnsureFile();
    const remote = await driveLoadData();
    if (remote) {
      state = migrate(remote);
      saveCache();
    } else { state = migrate(state); }
    setSyncStatus("connected", "ok");
  } catch (e) {
    console.error(e);
    setSyncStatus("offline mode", "offline");
  }
  initVditor();
  currentNotebookId = state.notebooks[0] ? state.notebooks[0].id : null;
  toggleEditorEmpty(true);
  if (currentNotebookId) selectNotebook(currentNotebookId);
  setMobileScreen("notebooks");
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
  if (!r.ok) throw new Error("Drive query failed");
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
  setSyncStatus("saving...", "saving");
  try {
    await fetch(`https://www.googleapis.com/upload/drive/v3/files/${fileId}?uploadType=media`, {
      method: "PATCH",
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      body: JSON.stringify(state)
    });
    setSyncStatus("connected", "ok");
  } catch (e) { setSyncStatus("offline mode", "offline"); }
}

function scheduleSave() {
  saveCache();
  clearTimeout(saveTimer);
  saveTimer = setTimeout(driveSaveData, 1200);
}

/* ======================================================================
HELPERS
====================================================================== */
function uid() { return Math.random().toString(36).slice(2, 10) + Date.now().toString(36); }
function noteById(id) { return state.notes.find(n => n.id === id); }
function sectionById(id) { return state.sections.find(s => s.id === id); }
function notebookById(id) { return state.notebooks.find(n => n.id === id); }

function rootSectionsOf(nbId) {
  return state.sections
    .filter(s => s.notebookId === nbId && !s.parentSectionId);
}

function childSectionsOf(parentId) {
  return state.sections.filter(s => s.parentSectionId === parentId);
}

function allSectionsOf(nbId) {
  return state.sections.filter(s => s.notebookId === nbId);
}

function allNotesOf(secId) {
  return state.notes.filter(n => n.sectionId === secId);
}

function crumbFor(n) {
  if (n.sectionId) {
    const sec = sectionById(n.sectionId);
    const nb = sec ? notebookById(sec.notebookId) : null;
    return nb && sec ? `${nb.name} / ${sec.name}` : "";
  }
  const nb = notebookById(n.notebookId);
  return nb ? `${nb.name} / (no section)` : "";
}

function plainText(md) {
  if (!md) return ""; let s = md;
  s = s.replace(/!\[.*?\]\(.*?\)/g, " "); 
  s = s.replace(/\[(.*?)\]\(.*?\)/g, "$1");
  s = s.replace(/`[\s\S]*?`/g, " "); 
  s = s.replace(/[#>*_~-]/g, " "); 
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function plainSnippet(md) { const t = plainText(md); return t.length > 90 ? t.slice(0, 90) + "…" : t; }

function matchesSearch(n, q) {
  const hay = (n.title + " " + plainText(n.content) + " " + (n.categories || []).join(" ") + " " + crumbFor(n)).toLowerCase();
  return hay.includes(q);
}

function fmtDate(iso) { if (!iso) return ""; return new Date(iso).toLocaleDateString("en-US", { day: "numeric", month: "short" }); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, m => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function getAllTags() {
  const tags = new Set();
  state.notes.forEach(n => {
    (n.categories || []).forEach(t => tags.add(t.trim().toLowerCase()));
  });
  return Array.from(tags).sort();
}

// --- CUSTOM MODAL ---
let modalKeyHandler = null;
let selectedColor = null;

function showCustomModal({ title, message, showInput = false, inputValue = '', showSelect = false, selectOptions = [], confirmText = 'OK', confirmClass = 'btn-red', showColorPicker = false, initialColor = 0 }) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-modal');
    const titleEl = document.getElementById('modal-title');
    const msgEl = document.getElementById('modal-message');
    const inputEl = document.getElementById('modal-input');
    const selectEl = document.getElementById('modal-select');
    const colorPicker = document.getElementById('modal-color-picker');
    const confirmBtn = document.getElementById('modal-confirm');
    const cancelBtn = document.getElementById('modal-cancel');
    
    titleEl.textContent = title;
    msgEl.textContent = message;
    confirmBtn.textContent = confirmText;
    confirmBtn.className = 'btn-brut ' + confirmClass;
    
    if (showInput) {
      inputEl.classList.remove('hidden');
      inputEl.value = inputValue;
      setTimeout(() => inputEl.select(), 50);
    } else {
      inputEl.classList.add('hidden');
    }

    if (showSelect) {
      selectEl.classList.remove('hidden');
      selectEl.innerHTML = '';
      selectOptions.forEach(opt => {
        const option = document.createElement('option');
        option.value = opt.value;
        option.textContent = opt.label;
        selectEl.appendChild(option);
      });
    } else {
      selectEl.classList.add('hidden');
    }
    
    if (showColorPicker) {
      colorPicker.classList.remove('hidden');
      colorPicker.innerHTML = '';
      selectedColor = initialColor;
      COLORS.forEach((color, idx) => {
        const swatch = document.createElement('div');
        swatch.className = 'color-swatch' + (idx === initialColor ? ' selected' : '');
        swatch.style.background = color;
        swatch.onclick = () => {
          selectedColor = idx;
          colorPicker.querySelectorAll('.color-swatch').forEach(s => s.classList.remove('selected'));
          swatch.classList.add('selected');
        };
        colorPicker.appendChild(swatch);
      });
    } else {
      colorPicker.classList.add('hidden');
    }
    
    modal.classList.remove('hidden');
    
    const cleanup = (result) => {
      modal.classList.add('hidden');
      if (modalKeyHandler) {
        document.removeEventListener('keydown', modalKeyHandler);
        modalKeyHandler = null;
      }
      
      let finalResult = true;
      if (showInput) finalResult = inputEl.value.trim();
      else if (showSelect) finalResult = selectEl.value;
      
      if (showColorPicker) {
        resolve(result ? { value: finalResult, color: selectedColor } : false);
      } else {
        resolve(result ? finalResult : false);
      }
    };
    
    const newConfirm = confirmBtn.cloneNode(true);
    confirmBtn.parentNode.replaceChild(newConfirm, confirmBtn);
    newConfirm.id = 'modal-confirm';
    newConfirm.onclick = () => cleanup(true);
    
    const newCancel = cancelBtn.cloneNode(true);
    cancelBtn.parentNode.replaceChild(newCancel, cancelBtn);
    newCancel.id = 'modal-cancel';
    newCancel.onclick = () => cleanup(false);
    
    modalKeyHandler = (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        document.getElementById('modal-confirm').click();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        document.getElementById('modal-cancel').click();
      }
    };
    document.addEventListener('keydown', modalKeyHandler);
  });
}

// --- CONTEXT MENU ---
const ctxMenu = document.getElementById('context-menu');

function showContextMenu(e, type, id, name, extra = {}) {
  e.preventDefault();
  e.stopPropagation();
  let buttons = '';
  if (type === 'notebook') {
    buttons = `
      <button data-action="rename"><i class="ph-duotone ph-pencil-simple"></i> Rename</button>
      <button data-action="color"><i class="ph-duotone ph-palette"></i> Change Color</button>
      <div class="divider"></div>
      <button data-action="delete" class="danger"><i class="ph-duotone ph-trash"></i> Delete Notebook</button>
    `;
  } else if (type === 'section') {
    buttons = `
      <button data-action="rename"><i class="ph-duotone ph-pencil-simple"></i> Rename</button>
      <button data-action="color"><i class="ph-duotone ph-palette"></i> Change Color</button>
      <button data-action="new-sub"><i class="ph-duotone ph-folder-plus"></i> Add Subsection</button>
      <button data-action="new-page"><i class="ph-duotone ph-file-plus"></i> Add Note Here</button>
      <div class="divider"></div>
      <button data-action="delete" class="danger"><i class="ph-duotone ph-trash"></i> Delete Section</button>
    `;
  } else if (type === 'note') {
    buttons = `
      <button data-action="rename"><i class="ph-duotone ph-pencil-simple"></i> Rename</button>
      <button data-action="move"><i class="ph-duotone ph-arrow-square-out"></i> Move to...</button>
      <div class="divider"></div>
      <button data-action="delete" class="danger"><i class="ph-duotone ph-trash"></i> Delete Note</button>
    `;
  }
  ctxMenu.innerHTML = buttons;
  ctxMenu.classList.remove('hidden'); 
  
  let x = e.clientX;
  let y = e.clientY;
  const menuWidth = ctxMenu.offsetWidth;
  const menuHeight = ctxMenu.offsetHeight;
  
  // Agar tidak keluar / terpotong oleh layar
  if (x + menuWidth > window.innerWidth) x = window.innerWidth - menuWidth - 5;
  if (y + menuHeight > window.innerHeight) y = window.innerHeight - menuHeight - 5;
  
  ctxMenu.style.left = `${x}px`;
  ctxMenu.style.top = `${y}px`;
  
  ctxMenu.querySelectorAll('button').forEach(btn => {
    btn.onclick = async () => {
      ctxMenu.classList.add('hidden');
      const action = btn.dataset.action;
      if (action === 'rename') {
        const result = await showCustomModal({ title: "Rename", message: `New name for "${name}":`, showInput: true, inputValue: name, confirmText: "Save", confirmClass: "btn-lime" });
        if (result) handleRename(type, id, result);
      } else if (action === 'color') {
        const result = await showCustomModal({ title: "Change Color", message: `Choose a color for "${name}":`, showColorPicker: true, initialColor: extra.color || 0, confirmText: "Save", confirmClass: "btn-lime" });
        if (result) handleColorChange(type, id, result.color);
      } else if (action === 'delete') {
        const ok = await showCustomModal({ title: "Delete Item", message: `Delete "${name}"? This cannot be undone.`, confirmText: "Delete", confirmClass: "btn-red" });
        if (ok) handleDelete(type, id);
      } else if (action === 'new-sub') {
        const result = await showCustomModal({ title: "New Subsection", message: `Subsection name under "${name}":`, showInput: true, confirmText: "Create", confirmClass: "btn-lime" });
        if (result) handleNewSubSection(id, result);
      } else if (action === 'new-page') {
        handleNewPageInSection(id);
      } else if (action === 'move') {
        const sections = state.sections.filter(s => s.notebookId === currentNotebookId);
        const options = [{ value: 'root', label: '(No Section)' }, ...sections.map(s => ({ value: s.id, label: s.name }))];
        const result = await showCustomModal({ title: "Move Note", message: `Move "${name}" to:`, showSelect: true, selectOptions: options, confirmText: "Move", confirmClass: "btn-lime" });
        if (result) handleMoveNote(id, result);
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
  scheduleSave();
  renderAll();
}

function handleColorChange(type, id, colorIdx) {
  if (type === 'notebook') { const nb = notebookById(id); if(nb) nb.color = colorIdx; }
  else if (type === 'section') { const sec = sectionById(id); if(sec) sec.color = colorIdx; }
  scheduleSave();
  renderAll();
}

function handleDelete(type, id) {
  if (type === 'notebook') {
    const secIds = allSectionsOf(id).map(s => s.id);
    state.notes = state.notes.filter(n => !secIds.includes(n.sectionId) && !(!n.sectionId && n.notebookId === id));
    state.sections = state.sections.filter(s => s.notebookId !== id);
    state.notebooks = state.notebooks.filter(n => n.id !== id);
    if (currentNotebookId === id) { currentNotebookId = state.notebooks[0]?.id || null; toggleEditorEmpty(true); }
  } else if (type === 'section') {
    const idsToRemove = new Set();
    function collectIds(parentId) {
      idsToRemove.add(parentId);
      state.sections.filter(s => s.parentSectionId === parentId).forEach(s => collectIds(s.id));
    }
    collectIds(id);
    state.notes = state.notes.filter(n => !idsToRemove.has(n.sectionId));
    state.sections = state.sections.filter(s => !idsToRemove.has(s.id));
    if (idsToRemove.has(currentSectionId)) {
      const remaining = rootSectionsOf(currentNotebookId);
      currentSectionId = remaining[0]?.id || null;
      if (!currentSectionId) toggleEditorEmpty(true);
    }
  } else if (type === 'note') {
    state.notes = state.notes.filter(n => n.id !== id);
    if (currentNoteId === id) { currentNoteId = null; toggleEditorEmpty(true); }
  }
  scheduleSave();
  renderAll();
}

function handleNewSubSection(parentId, name) {
  const parentSec = sectionById(parentId);
  if (!parentSec) return;
  const siblings = childSectionsOf(parentId);
  const s = {
    id: uid(),
    notebookId: parentSec.notebookId,
    parentSectionId: parentId,
    name: name,
    color: parentSec.color,
    order: siblings.length
  };
  state.sections.push(s);
  collapsedSections.delete(parentId);
  currentSectionId = s.id;
  scheduleSave();
  renderAll();
}

function handleNewPageInSection(secId) {
  const sec = sectionById(secId);
  if (!sec) return;
  currentSectionId = secId;
  const n = {
    id: uid(), notebookId: sec.notebookId, sectionId: secId, title: "", content: "",
    categories: [], isTask: false, done: false, due: null, order: Date.now(),
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  state.notes.unshift(n);
  scheduleSave();
  renderPageList();
  openNote(n.id);
}

function handleMoveNote(noteId, targetSectionId) {
  const note = noteById(noteId);
  if (note) {
    note.sectionId = targetSectionId === 'root' ? null : targetSectionId;
    note.updatedAt = new Date().toISOString();
    scheduleSave();
    renderPageList();
  }
}

/* ======================================================================
SIDEBAR COLLAPSE & TAGS MINIMIZE
====================================================================== */
function applySidebarState() {
  const app = document.getElementById('app');
  if (sidebarCollapsed) {
    app.classList.add('sidebar-collapsed');
  } else {
    app.classList.remove('sidebar-collapsed');
  }
}

document.getElementById('btn-collapse-sidebar').addEventListener('click', () => {
  sidebarCollapsed = !sidebarCollapsed;
  localStorage.setItem('catatan_sidebar_collapsed', sidebarCollapsed);
  applySidebarState();
});

let tagsCollapsed = false;
document.getElementById('toggle-tags').addEventListener('click', () => {
  tagsCollapsed = !tagsCollapsed;
  document.getElementById('tag-cloud').classList.toggle('hidden', tagsCollapsed);
  const caret = document.getElementById('tags-caret');
  if(tagsCollapsed) {
    caret.classList.remove('ph-caret-down');
    caret.classList.add('ph-caret-right');
  } else {
    caret.classList.add('ph-caret-down');
    caret.classList.remove('ph-caret-right');
  }
});

/* ======================================================================
RESIZE HANDLE
====================================================================== */
function initResizeHandle() {
  const handle = document.getElementById('resize-handle');
  handle.addEventListener('mousedown', (e) => {
    isResizing = true;
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
    e.preventDefault();
  });
  document.addEventListener('mousemove', (e) => {
    if (!isResizing) return;
    const pagesCol = document.getElementById('col-pages');
    const newPagesWidth = e.clientX - pagesCol.getBoundingClientRect().left;
    if (newPagesWidth > 200 && newPagesWidth < 800) {
      document.documentElement.style.setProperty('--pages-width', newPagesWidth + 'px');
    }
  });
  document.addEventListener('mouseup', () => {
    if (isResizing) {
      isResizing = false;
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    }
  });
}

/* ======================================================================
VDITOR
====================================================================== */
function initVditor() {
  if (vditorInstance) return;
  vditorInstance = new Vditor("vditor-container", {
    lang: "en_US", // FIX TOOLTIP CHINESE
    mode: "ir",
    height: "100%",
    cache: { enable: false },
    toolbar: [
      { name: "headings", tipPosition: "s" },
      { name: "bold", tipPosition: "s" },
      { name: "italic", tipPosition: "s" },
      { name: "strike", tipPosition: "s" },
      "|",
      { name: "list", tipPosition: "s" },
      { name: "ordered-list", tipPosition: "s" },
      { name: "check", tipPosition: "s" },
      { name: "quote", tipPosition: "s" },
      "|",
      { name: "link", tipPosition: "s" },
      { name: "upload", tipPosition: "s" },
      "|",
      { name: "undo", tipPosition: "s" },
      { name: "redo", tipPosition: "s" }
    ],
    upload: {
      url: '',
      accept: 'image/',
      max: 10 * 1024 * 1024,
      handler(files) {
        const file = files[0];
        const reader = new FileReader();
        reader.onload = (e) => {
          const base64 = e.target.result;
          vditorInstance.insertValue(`![${file.name}](${base64})`);
        };
        reader.readAsDataURL(file);
        return '';
      }
    },
    paste: (event) => {
      const items = (event.clipboardData || event.originalEvent.clipboardData).items;
      let hasImage = false;
      // Perbaikan: Loop manual memastikan tidak memblokir copas text biasa
      for (let i = 0; i < items.length; i++) {
        if (items[i].kind === 'file' && items[i].type.startsWith('image/')) {
          hasImage = true;
          event.preventDefault();
          const file = items[i].getAsFile();
          const reader = new FileReader();
          reader.onload = (e) => {
            const img = new Image();
            img.onload = () => {
              const canvas = document.createElement('canvas');
              const ctx = canvas.getContext('2d');
              const MAX_WIDTH = 1000;
              let width = img.width;
              let height = img.height;
              
              if (width > MAX_WIDTH) {
                height *= MAX_WIDTH / width;
                width = MAX_WIDTH;
              }
              
              canvas.width = width;
              canvas.height = height;
              ctx.drawImage(img, 0, 0, width, height);
              const compressedBase64 = canvas.toDataURL('image/jpeg', 0.75);
              
              vditorInstance.insertValue(`\n![image](${compressedBase64})\n`);
            };
            img.src = e.target.result;
          };
          reader.readAsDataURL(file);
        }
      }
      if (hasImage) {
        return false; // Matikan default paste HANYA JIKA sedang paste gambar
      }
    },
    after: () => {
      vditorReady = true;
      if (pendingNote) {
        loadNoteIntoEditor(pendingNote);
        pendingNote = null;
      }
    },
    input: (value) => { onEditorInput(value); }
  });
}

function loadNoteIntoEditor(n) {
  if (!vditorReady) { pendingNote = n; return; }
  suppressInput = true;
  vditorInstance.setValue(n.content || "");
  setTimeout(() => { suppressInput = false; }, 100);
}

function onEditorInput(value) {
  if (suppressInput) return;
  const n = noteById(currentNoteId);
  if (!n) return;
  n.content = value;
  n.updatedAt = new Date().toISOString();
  markSavingLabel();
  scheduleSave();
}

function markSavingLabel() {
  document.getElementById("edit-savestate").textContent = "Saving...";
  clearTimeout(editorSaveLabelTimer);
  editorSaveLabelTimer = setTimeout(() => {
    document.getElementById("edit-savestate").textContent = "Saved";
  }, 1400);
}

/* ======================================================================
RENDER — KOLOM 1: NOTEBOOK + TAGS
====================================================================== */
function renderNotebooks() {
  const list = document.getElementById("notebook-list");
  list.innerHTML = "";
  const sortedNotebooks = [...state.notebooks].sort((a,b) => a.name.localeCompare(b.name));
  sortedNotebooks.forEach(nb => {
    const secIds = state.sections.filter(s => s.notebookId === nb.id).map(s => s.id);
    const count = state.notes.filter(n => secIds.includes(n.sectionId) || (!n.sectionId && n.notebookId === nb.id)).length;
    const li = document.createElement("li");
    li.className = "notebook-item" + (currentNotebookId === nb.id && mode === "normal" ? " active" : "");
    li.innerHTML = `<span class="nb-dot" style="background:${COLORS[nb.color % COLORS.length]}"></span><span class="nb-name">${escapeHtml(nb.name)}</span><span class="nb-count">${count}</span>`;
    li.addEventListener("click", () => selectNotebook(nb.id));
    li.addEventListener("contextmenu", (e) => showContextMenu(e, 'notebook', nb.id, nb.name, { color: nb.color }));
    list.appendChild(li);
  });
  
  const tagCloud = document.getElementById("tag-cloud");
  tagCloud.innerHTML = "";
  const tags = getAllTags();
  if (tags.length === 0) {
    tagCloud.innerHTML = '<div style="font-size:10px;color:var(--muted);">No tags yet</div>';
  } else {
    tags.forEach(tag => {
      const chip = document.createElement('div');
      chip.className = 'tag-chip' + (activeTag === tag ? ' active' : '');
      chip.textContent = '#' + tag;
      chip.onclick = () => {
        if (activeTag === tag) {
          activeTag = null;
          mode = "normal";
        } else {
          activeTag = tag;
          mode = "tag";
        }
        renderAll();
      };
      tagCloud.appendChild(chip);
    });
  }
}

document.getElementById("btn-new-notebook").addEventListener("click", async () => {
  const result = await showCustomModal({
    title: "New Notebook",
    message: "Give your notebook a name:",
    showInput: true,
    showColorPicker: true,
    confirmText: "Create",
    confirmClass: "btn-lime"
  });
  if (!result || !result.value) return;
  const nb = { id: uid(), name: result.value, color: result.color };
  const sec = { id: uid(), notebookId: nb.id, parentSectionId: null, name: "General", color: 0, order: 0 };
  state.notebooks.push(nb);
  state.sections.push(sec);
  scheduleSave();
  selectNotebook(nb.id);
});

document.getElementById("search-input").addEventListener("input", (e) => {
  searchQuery = e.target.value.trim().toLowerCase();
  mode = searchQuery ? "search" : "normal";
  activeTag = null;
  document.getElementById("search-clear").classList.toggle("hidden", !searchQuery);
  renderAll();
  if (mode === "search") setMobileScreen("pages");
});

document.getElementById("search-clear").addEventListener("click", () => {
  document.getElementById("search-input").value = "";
  searchQuery = "";
  mode = "normal";
  document.getElementById("search-clear").classList.add("hidden");
  renderAll();
});

/* ======================================================================
RENDER — KOLOM 2: SECTIONS + PAGES
====================================================================== */
function selectNotebook(id) {
  currentNotebookId = id;
  mode = "normal";
  activeTag = null;
  currentSectionId = null;
  renderAll();
  setMobileScreen("pages");
}

document.getElementById("notebook-title").addEventListener("click", async () => {
  if (!currentNotebookId || mode !== "normal") return;
  const nb = notebookById(currentNotebookId);
  if (!nb) return;
  const result = await showCustomModal({
    title: "Rename Notebook",
    message: `New name for "${nb.name}":`,
    showInput: true,
    inputValue: nb.name,
    confirmText: "Save",
    confirmClass: "btn-lime"
  });
  if (result) {
    nb.name = result;
    scheduleSave();
    renderAll();
  }
});

document.getElementById("btn-new-section").addEventListener("click", async () => {
  if (!currentNotebookId) return;
  const result = await showCustomModal({
    title: "New Section",
    message: "Section name:",
    showInput: true,
    showColorPicker: true,
    confirmText: "Create",
    confirmClass: "btn-lime"
  });
  if (!result || !result.value) return;
  const siblings = rootSectionsOf(currentNotebookId);
  const s = {
    id: uid(),
    notebookId: currentNotebookId,
    parentSectionId: null,
    name: result.value,
    color: result.color,
    order: siblings.length
  };
  state.sections.push(s);
  currentSectionId = s.id;
  scheduleSave();
  renderAll();
});

document.getElementById("btn-new-page").addEventListener("click", () => {
  if (mode !== "normal" || !currentNotebookId) return;
  const n = {
    id: uid(),
    notebookId: currentNotebookId,
    sectionId: currentSectionId || null,
    title: "",
    content: "",
    categories: [],
    isTask: false,
    done: false,
    due: null,
    order: Date.now(),
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  state.notes.unshift(n);
  scheduleSave();
  renderPageList();
  openNote(n.id);
});

function handleDropEvent(evt) {
  const item = evt.item;
  const toContainer = evt.to;
  const newSectionId = toContainer.dataset.sectionId === "root" ? null : toContainer.dataset.sectionId;

  if (item.classList.contains('page-item')) {
    const note = noteById(item.dataset.id);
    if (note) note.sectionId = newSectionId;
  } else if (item.classList.contains('section-group')) {
    const sec = sectionById(item.dataset.sectionId);
    if (sec) sec.parentSectionId = newSectionId;
  }

  Array.from(toContainer.children).forEach((el, idx) => {
    if (el.classList.contains('page-item')) {
      const n = noteById(el.dataset.id);
      if (n) n.order = idx;
    } else if (el.classList.contains('section-group')) {
      const s = sectionById(el.dataset.sectionId);
      if (s) s.order = idx;
    }
  });

  scheduleSave();
  setTimeout(renderPageList, 50);
}

function renderPageList() {
  const wrap = document.getElementById("page-list");
  wrap.innerHTML = "";
  let title = "—";
  
  if (mode === "search") {
    const rows = state.notes.filter(n => matchesSearch(n, searchQuery));
    title = `Search: "${searchQuery}"`;
    document.getElementById("notebook-title").textContent = title;
    document.getElementById("pages-empty").classList.toggle("hidden", rows.length !== 0);
    rows.forEach(n => wrap.appendChild(createPageItem(n, crumbFor(n))));
  } else if (mode === "tag") {
    const rows = state.notes.filter(n => (n.categories || []).some(t => t.trim().toLowerCase() === activeTag));
    title = `Tag: "${activeTag}"`;
    document.getElementById("notebook-title").textContent = title;
    document.getElementById("pages-empty").classList.toggle("hidden", rows.length !== 0);
    rows.forEach(n => wrap.appendChild(createPageItem(n, crumbFor(n))));
  } else if (mode === "normal" && currentNotebookId) {
    const nb = notebookById(currentNotebookId);
    title = nb ? nb.name : "—";
    document.getElementById("notebook-title").textContent = title;

    const rootItems = [
      ...state.notes.filter(n => n.notebookId === currentNotebookId && !n.sectionId).map(n => ({...n, _type: 'note'})),
      ...rootSectionsOf(currentNotebookId).map(s => ({...s, _type: 'section'}))
    ].sort((a,b) => (a.order||0) - (b.order||0));

    const rootWrap = document.createElement("div");
    rootWrap.className = "sections-wrap";
    rootWrap.dataset.sectionId = "root";

    rootItems.forEach(item => {
      if (item._type === 'note') rootWrap.appendChild(createPageItem(item, null));
      else rootWrap.appendChild(renderSectionGroup(item, 0));
    });

    wrap.appendChild(rootWrap);

    if (window.Sortable) {
      Sortable.create(rootWrap, {
        group: 'shared',
        animation: 150,
        filter: '.toggle',
        preventOnFilter: false, 
        ghostClass: 'sortable-ghost',
        onEnd: handleDropEvent
      });
    }

    document.getElementById("pages-empty").classList.toggle("hidden", rootItems.length > 0);
  }
}

function renderSectionGroup(sec, depth) {
  const childItems = [
    ...allNotesOf(sec.id).map(n => ({...n, _type: 'note'})),
    ...childSectionsOf(sec.id).map(s => ({...s, _type: 'section'}))
  ].sort((a,b) => (a.order||0) - (b.order||0));

  const group = document.createElement("div");
  group.className = "section-group";
  group.dataset.sectionId = sec.id;
  group.style.marginLeft = `${depth * 16}px`;

  const isCollapsed = collapsedSections.has(sec.id);
  const isActive = currentSectionId === sec.id;

  const header = document.createElement("div");
  header.className = "section-header" + (isCollapsed ? " collapsed" : "") + (isActive ? " active-section" : "");
  header.style.background = COLORS[sec.color % COLORS.length];
  header.innerHTML = `<span class="toggle">${isCollapsed ? '▶' : '▼'}</span><span class="sec-title">${escapeHtml(sec.name)}</span><span class="sec-count">${childItems.length}</span>`;

  header.addEventListener("click", (e) => {
    if (e.target.closest('.toggle')) {
      if (collapsedSections.has(sec.id)) collapsedSections.delete(sec.id);
      else collapsedSections.add(sec.id);
      renderPageList();
      return;
    }
    currentSectionId = isActive ? null : sec.id;
    renderPageList();
  });

  header.addEventListener("contextmenu", (e) => showContextMenu(e, 'section', sec.id, sec.name, { color: sec.color }));

  const pagesContainer = document.createElement("div");
  pagesContainer.className = "section-pages" + (isCollapsed ? " collapsed" : "");
  pagesContainer.dataset.sectionId = sec.id;

  childItems.forEach(item => {
    if (item._type === 'note') pagesContainer.appendChild(createPageItem(item, null));
    else pagesContainer.appendChild(renderSectionGroup(item, depth + 1));
  });

  group.appendChild(header);
  group.appendChild(pagesContainer);

  if (window.Sortable) {
    Sortable.create(pagesContainer, {
      group: 'shared',
      animation: 150,
      filter: '.toggle',
      preventOnFilter: false,
      ghostClass: 'sortable-ghost',
      onEnd: handleDropEvent
    });
  }

  return group;
}

function createPageItem(n, crumb) {
  const today = new Date().toISOString().slice(0, 10);
  const div = document.createElement("div");
  div.className = "page-item" + (currentNoteId === n.id ? " active" : "");
  div.dataset.id = n.id;
  
  const overdue = n.isTask && !n.done && n.due && n.due < today;
  const checkIcon = n.done ? '<i class="ph-bold ph-check"></i>' : '';
  const checkHtml = n.isTask ? `<span class="mini-check ${n.done ? 'done' : ''}" data-id="${n.id}">${checkIcon}</span>` : '';
  
  div.innerHTML = `${crumb ? `<div class="page-item-crumb">${escapeHtml(crumb)}</div>` : ''}<p class="page-item-title">${checkHtml}<span class="page-item-title-text">${escapeHtml(n.title || "Untitled")}</span></p><div class="page-item-snip">${escapeHtml(plainSnippet(n.content))}</div><div class="page-item-foot"><span>${fmtDate(n.updatedAt)}</span>${n.isTask && n.due ? `<span class="page-item-due ${overdue ? 'overdue' : ''}">${fmtDate(n.due)}</span>` : ''}</div>`;
  
  div.addEventListener("click", (e) => {
    if (e.target.closest(".mini-check")) return;
    openNote(n.id);
  });
  
  div.addEventListener("contextmenu", (e) => showContextMenu(e, 'note', n.id, n.title || "Untitled"));
  
  const chk = div.querySelector(".mini-check");
  if (chk) {
    chk.addEventListener("click", (e) => {
      e.stopPropagation();
      n.done = !n.done;
      n.updatedAt = new Date().toISOString();
      scheduleSave();
      
      // Jika terbuka di Editor, update juga tombol STATUS nya
      if (currentNoteId === n.id) {
         const tbDone = document.getElementById("tb-done");
         tbDone.classList.toggle("active", n.done);
         tbDone.innerHTML = n.done ? '<i class="ph-bold ph-check-circle"></i> COMPLETED' : '<i class="ph-bold ph-circle"></i> MARK DONE';
      }
      renderPageList();
    });
  }
  
  return div;
}

function renderAll() {
  renderNotebooks();
  renderPageList();
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
  currentNoteId = id;
  const n = noteById(id);
  if (!n) return;
  document.getElementById("edit-title").value = n.title || "";
  document.getElementById("edit-category").value = (n.categories || []).map(t => '#' + t).join(' ');
  document.getElementById("edit-due").value = n.due || "";
  document.getElementById("edit-due").classList.toggle("hidden", !n.isTask);
  
  document.getElementById("tb-task").classList.toggle("active", !!n.isTask);
  
  // Fitur Tombol Toggle Status "MARK DONE" di dalam Editor
  const tbDone = document.getElementById("tb-done");
  tbDone.classList.toggle("hidden", !n.isTask);
  if (n.isTask) {
    tbDone.classList.toggle("active", !!n.done);
    tbDone.innerHTML = n.done ? '<i class="ph-bold ph-check-circle"></i> COMPLETED' : '<i class="ph-bold ph-circle"></i> MARK DONE';
  }

  document.getElementById("edit-savestate").textContent = "";
  toggleEditorEmpty(false);
  loadNoteIntoEditor(n);
  renderPageList();
  setMobileScreen("editor");
}

document.getElementById("edit-title").addEventListener("keydown", (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    if (vditorInstance && vditorReady) {
      vditorInstance.focus();
    }
  }
});

document.getElementById("edit-title").addEventListener("input", () => {
  const n = noteById(currentNoteId);
  if (!n) return;
  n.title = document.getElementById("edit-title").value;
  n.updatedAt = new Date().toISOString();
  markSavingLabel();
  scheduleSave();
  queuePageListRefresh();
});

document.getElementById("edit-category").addEventListener("input", () => {
  const n = noteById(currentNoteId);
  if (!n) return;
  const raw = document.getElementById("edit-category").value;
  n.categories = raw.split(/\s+/)
    .map(s => s.trim())
    .filter(s => s.startsWith('#') && s.length > 1)
    .map(s => s.slice(1).toLowerCase());
  n.updatedAt = new Date().toISOString();
  markSavingLabel();
  scheduleSave();
  renderNotebooks();
});

document.getElementById("edit-due").addEventListener("input", () => {
  const n = noteById(currentNoteId);
  if (!n) return;
  n.due = document.getElementById("edit-due").value || null;
  n.updatedAt = new Date().toISOString();
  markSavingLabel();
  scheduleSave();
  queuePageListRefresh();
});

document.getElementById("tb-task").addEventListener("click", () => {
  const n = noteById(currentNoteId);
  if (!n) return;
  n.isTask = !n.isTask;
  document.getElementById("tb-task").classList.toggle("active", n.isTask);
  document.getElementById("edit-due").classList.toggle("hidden", !n.isTask);
  
  // Muncul/Hapus tombol Done
  const tbDone = document.getElementById("tb-done");
  tbDone.classList.toggle("hidden", !n.isTask);
  if (n.isTask) {
    tbDone.classList.toggle("active", !!n.done);
    tbDone.innerHTML = n.done ? '<i class="ph-bold ph-check-circle"></i> COMPLETED' : '<i class="ph-bold ph-circle"></i> MARK DONE';
  }

  n.updatedAt = new Date().toISOString();
  markSavingLabel();
  scheduleSave();
  queuePageListRefresh();
});

document.getElementById("tb-done").addEventListener("click", () => {
  const n = noteById(currentNoteId);
  if (!n || !n.isTask) return;
  n.done = !n.done;
  
  const tbDone = document.getElementById("tb-done");
  tbDone.classList.toggle("active", n.done);
  tbDone.innerHTML = n.done ? '<i class="ph-bold ph-check-circle"></i> COMPLETED' : '<i class="ph-bold ph-circle"></i> MARK DONE';
  
  n.updatedAt = new Date().toISOString();
  markSavingLabel();
  scheduleSave();
  queuePageListRefresh();
});

document.getElementById("btn-delete-note").addEventListener("click", async () => {
  if (!currentNoteId) return;
  const ok = await showCustomModal({
    title: "Delete Note?",
    message: "Deleted notes cannot be recovered. Continue?",
    confirmText: "Delete",
    confirmClass: "btn-red"
  });
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
