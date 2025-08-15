console.log("[Sensei] content script alive. typeof Chess =", typeof Chess, "extId=", chrome.runtime?.id);

(() => {
  if (window.__senseiOverlay) return;
  window.__senseiOverlay = true;

  // State
  const state = {
    isAnalyzing: false,
    lastPosition: null,   // holds the most recently detected FEN
    autoMode: false
  };

  // Constants (no user controls)
  const DEFAULT_THINK_MS = 350;
  const DEFAULT_THREAT_MS = 150;

  // UI
  const root = document.createElement("div");
  root.id = "sensei-overlay";
  root.innerHTML = `
    <style>
      #sensei-overlay {
        position: fixed; top: 20px; right: 20px; width: 380px;
        background: #1a1a2e; border: 1px solid #3a4a6b; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,.6); font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        font-size: 14px; color: #e2e8f0; z-index: 2147483647; opacity: 0; transform: translateY(-20px);
        animation: slideIn .3s ease-out forwards; resize: both; overflow: auto; min-width: 320px; min-height: 200px; max-width: 500px;
      }
      @keyframes slideIn { to { opacity: 1; transform: translateY(0); } }
      #sensei-overlay.hidden { display: none !important; }

      #sensei-overlay header {
        background: linear-gradient(90deg,#2d3748 0%,#4a5568 100%);
        padding: 12px 16px; border-radius: 12px 12px 0 0; display:flex; justify-content:space-between; align-items:center;
        cursor: move; user-select:none; border-bottom:1px solid #4a5568;
      }
      #sensei-overlay header span { font-weight:600; color:#f7fafc; display:flex; align-items:center; gap:8px; }
      #sensei-overlay header span::before { content:"♛"; font-size:16px; color:#ffd700; }
      #sensei-overlay .header-controls { display:flex; gap:8px; align-items:center; }
      #sensei-overlay .control-btn {
        background: rgba(255,255,255,.1); border:none; color:#e2e8f0; padding:6px 8px; border-radius:6px; cursor:pointer; font-size:12px; transition:all .2s;
      }
      #sensei-overlay .control-btn:hover { background: rgba(255,255,255,.2); transform: scale(1.05); }

      #sensei-overlay .body { padding:16px; max-height:500px; overflow-y:auto; }
      #sensei-overlay .row { margin-bottom:12px; }

      #sensei-overlay button {
        background: linear-gradient(135deg,#4299e1 0%,#3182ce 100%); color:white; border:none; padding:12px 20px; border-radius:8px;
        font-weight:500; cursor:pointer; transition:all .2s; position:relative; overflow:hidden;
      }
      #sensei-overlay button:hover:not(:disabled) { transform: translateY(-2px); box-shadow: 0 4px 12px rgba(66,153,225,.3); }
      #sensei-overlay button:disabled { background:#4a5568; cursor:not-allowed; opacity:.6; }
      #sensei-overlay .btn-full { width: 100%; margin-top: 8px; }

      #sensei-overlay .out {
        background: rgba(0,0,0,.2); border:1px solid #4a5568; border-radius:8px; padding:12px; min-height:24px;
        font-family:'SF Mono','Monaco','Cascadia Code',monospace; font-size:13px; line-height:1.5; word-wrap:break-word;
      }
      #sensei-overlay .out.loading {
        background: linear-gradient(90deg, rgba(255,255,255,.1) 25%, transparent 50%, rgba(255,255,255,.1) 75%);
        background-size:200% 100%; animation: shimmer 1.5s infinite;
      }
      @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
      #sensei-overlay .good { color:#68d391; }
      #sensei-overlay .bad { color:#fc8181; }
      #sensei-overlay .warning { color:#f6e05e; }
      #sensei-overlay .hint { font-size:11px; color:#a0aec0; margin-top:4px; font-style:italic; }

      #sensei-overlay .status-bar {
        display:flex; justify-content:space-between; align-items:center; padding:8px 16px;
        background: rgba(0,0,0,.2); border-top:1px solid #4a5568; font-size:11px; color:#a0aec0;
      }
      #sensei-overlay .status-indicator { display:flex; align-items:center; gap:6px; }
      #sensei-overlay .status-dot { width:6px; height:6px; border-radius:50%; background:#68d391; animation:pulse 2s infinite; }
      @keyframes pulse { 0%,100%{opacity:1} 50%{opacity:.5} }

      @media (max-width:480px){ #sensei-overlay{ width: calc(100vw - 40px); left:20px; right:20px; } }
    </style>

    <header>
      <span>SenseiBoard • Practice</span>
      <div class="header-controls">
        <button class="control-btn minimize" title="Minimize">−</button>
        <button class="control-btn close" title="Hide">✕</button>
      </div>
    </header>

    <div class="body">
      <div class="row">
        <button id="autograb" class="btn-full" title="Scan the page for the current position">Analyze position</button>
      </div>

      <div class="row">
        <label>🎯 Opponent Threats</label>
        <div id="opp" class="out"></div>
      </div>

      <div class="row">
        <label>💡 Your Best Response</label>
        <div id="you" class="out"></div>
      </div>
    </div>

    <div class="status-bar">
      <div class="status-indicator">
        <div class="status-dot"></div>
        <span id="status-text">Ready</span>
      </div>
      <div><span id="last-analysis-time">—</span></div>
    </div>
  `;

  // Position restore
  const savedPosition = localStorage.getItem("sensei-overlay-position");
  if (savedPosition) {
    const { top, left } = JSON.parse(savedPosition);
    root.style.top = top + "px";
    root.style.left = left + "px";
    root.style.right = "auto";
  }
  document.documentElement.appendChild(root);

  // Elements
  const els = {
    header: root.querySelector("header"),
    minimize: root.querySelector(".minimize"),
    close: root.querySelector(".close"),
    body: root.querySelector(".body"),
    autograb: root.querySelector("#autograb"),
    opp: root.querySelector("#opp"),
    you: root.querySelector("#you"),
    statusText: root.querySelector("#status-text"),
    lastAnalysisTime: root.querySelector("#last-analysis-time"),
  };

  // UI helpers
  function setStatus(text, type = "normal") {
    els.statusText.textContent = text;
    els.statusText.className = type;
  }
  function toggleVisibility() {
    const isHidden = root.classList.toggle("hidden");
    localStorage.setItem("sensei-overlay-hidden", isHidden.toString());
  }
  function minimizeToggle() {
    const isMinimized = els.body.style.display === "none";
    els.body.style.display = isMinimized ? "block" : "none";
    els.minimize.textContent = isMinimized ? "−" : "+";
    els.minimize.title = isMinimized ? "Minimize" : "Restore";
  }

  // Dragging
  (function makeDraggable() {
    let dragging = false, startX, startY, initialLeft, initialTop;
    els.header.addEventListener("mousedown", (e) => {
      if (e.target.closest("button")) return;
      dragging = true;
      startX = e.clientX; startY = e.clientY;
      const rect = root.getBoundingClientRect();
      initialLeft = rect.left; initialTop = rect.top;
      root.style.cursor = "grabbing";
      e.preventDefault();
    });
    document.addEventListener("mousemove", (e) => {
      if (!dragging) return;
      const newLeft = Math.max(0, Math.min(window.innerWidth - 320, initialLeft + (e.clientX - startX)));
      const newTop = Math.max(0, Math.min(window.innerHeight - 100, initialTop + (e.clientY - startY)));
      root.style.left = newLeft + "px";
      root.style.top = newTop + "px";
      root.style.right = "auto";
    });
    document.addEventListener("mouseup", () => {
      if (!dragging) return;
      dragging = false;
      root.style.cursor = "";
      const rect = root.getBoundingClientRect();
      localStorage.setItem("sensei-overlay-position", JSON.stringify({ top: rect.top, left: rect.left }));
    });
  })();

  // Events
  els.close.addEventListener("click", toggleVisibility);
  els.minimize.addEventListener("click", minimizeToggle);

  els.autograb.addEventListener("click", () => {
    const fen = autoGrabFen();
    if (!fen) {
      els.opp.innerHTML = `<span class="bad">Couldn’t read from page.</span> Try on an analysis page or open the game’s move list.`;
    } else {
      state.lastPosition = fen;
      setStatus("Position captured", "good");
      analyze(); // auto-run after capture
    }
  });

  // Analyze using the latest captured FEN (LLM phrasing ON, side auto, default times)
  async function analyze() {
    // If we don't have a position yet, try to grab one now.
    if (!state.lastPosition) {
      const fen = autoGrabFen();
      if (fen) state.lastPosition = fen;
    }

    const fen = state.lastPosition;
    if (!fen) {
      els.opp.innerHTML = `<span class="bad">No position captured.</span> Click <strong>Auto-grab position</strong>.`;
      return;
    }

    const payload = {
      fen,
      last_move_san: null,
      side_to_move: null, // auto
      movetime_ms: DEFAULT_THINK_MS,
      threat_time_ms: DEFAULT_THREAT_MS,
      use_llm: true
    };

    state.isAnalyzing = true;
    setLoadingState(true);
    setStatus("Analyzing position...", "normal");
    const startTime = Date.now();

    try {
      const reply = await chrome.runtime.sendMessage({ type: "sensei.analyze", payload })
        .catch(err => ({ ok: false, error: String(err) }));

      els.lastAnalysisTime.textContent = `${((Date.now() - startTime) / 1000).toFixed(1)}s`;

      if (!reply?.ok) {
        els.opp.innerHTML = `<span class="bad">Analysis failed:</span> ${escapeHtml(reply?.error || reply?.status || "Unknown error")}`;
        setStatus("Analysis failed", "bad");
        return;
      }

      displayResults(reply.data || {});
      setStatus("Analysis complete", "good");
    } catch (err) {
      els.opp.innerHTML = `<span class="bad">Connection error:</span> ${escapeHtml(String(err))}`;
      setStatus("Connection error", "bad");
    } finally {
      state.isAnalyzing = false;
      setLoadingState(false);
    }
  }

  function setLoadingState(loading) {
    [els.opp, els.you].forEach(el => {
      el.classList.toggle("loading", loading);
      if (loading) el.textContent = "";
    });
  }

  function displayResults(data) {
    els.opp.innerHTML = data.opponent_comment
      ? `<span class="warning">${escapeHtml(data.opponent_comment)}</span>`
      : '<span class="good">No immediate threats detected</span>';

    els.you.innerHTML = data.your_comment
      ? `<span class="good">${escapeHtml(data.your_comment)}</span>`
      : 'No specific recommendation';
  }

  function escapeHtml(text) {
    const div = document.createElement("div");
    div.textContent = text ?? "";
    return div.innerHTML;
  }

  // --- FEN detection helpers (no UI binding; just return a string) ---
  function isValidFen(fen) {
    try {
      const parts = fen.trim().split(/\s+/);
      if (parts.length < 4) return false;
      const ranks = parts[0].split("/");
      if (ranks.length !== 8) return false;
      for (const rank of ranks) {
        let count = 0;
        for (const ch of rank) {
          if (/[1-8]/.test(ch)) count += parseInt(ch, 10);
          else if (/[prnbqkPRNBQK]/.test(ch)) count += 1;
          else return false;
        }
        if (count !== 8) return false;
      }
      return true;
    } catch { return false; }
  }

  function fenFromUrl() {
    try {
      const sp = new URL(location.href).searchParams;
      const fen = sp.get("fen") || sp.get("position");
      return fen && fen.includes("/") ? fen : null;
    } catch { return null; }
  }

  function fenFromDomAttribute() {
    const selectors = ["[data-fen]", ".cg-board[data-fen]", "[fen]", "chess-board[fen]", "chess-board[position]", "[data-position]"];
    for (const sel of selectors) {
      const node = document.querySelector(sel);
      if (!node) continue;
      const fen = node.getAttribute("data-fen") || node.getAttribute("fen") || node.getAttribute("position") || node.getAttribute("data-position");
      if (fen && fen.includes("/")) return fen;
    }
    return null;
  }

  function collectSanCandidates() {
    const containers = [
      document.querySelector('[aria-label*="Move List" i]'),
      document.querySelector('[class*="move-list" i]'),
      document.querySelector('[class*="vertical-move-list" i]'),
      document.querySelector('[class*="moves" i]'),
      document.querySelector('[id*="moves" i]'),
      document.querySelector(".notation"),
      document.querySelector(".moves"),
      document.body
    ].filter(Boolean);

    const SAN_RX = /\b(O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8][+#]?|[a-h][1-8][+#]?)(?:\s*[+#])?\b/g;
    const seen = new Set(); const tokens = [];
    for (const c of containers) {
      const text = (c.innerText || "").replace(/\d+\./g, " ");
      const matches = text.matchAll(SAN_RX);
      for (const m of matches) {
        const san = (m[1] || "").trim();
        if (san.length >= 2 && !seen.has(san)) { seen.add(san); tokens.push(san); }
      }
      if (tokens.length >= 6) break;
    }
    return tokens;
  }

  function fenFromMovesWithChessJS() {
    if (typeof Chess !== "function") return null;
    const moves = collectSanCandidates();
    if (!moves.length) return null;
    try {
      const game = new Chess();
      let validMoves = 0;
      for (const san of moves) { try { if (game.move(san, { sloppy: true })) validMoves++; } catch {} }
      return validMoves > 0 ? game.fen() : null;
    } catch { return null; }
  }

  function fenFromChessComPieces() {
    const nodes = Array.from(document.querySelectorAll('.piece[class*="square-"]'));
    if (!nodes.length) return null;

    const board = Array.from({ length: 8 }, () => Array(8).fill(null));
    const pieceChar = (cls) => {
      const color = cls[0] === 'w' ? 'w' : 'b';
      const type = cls[1];
      const map = { p:'p', r:'r', n:'n', b:'b', q:'q', k:'k' };
      const ch = map[type];
      return ch ? (color === 'w' ? ch.toUpperCase() : ch) : null;
    };

    for (const el of nodes) {
      const classes = (el.className || "").split(/\s+/);
      const piece = classes.find(c => /^[wb][prnbqk]$/.test(c));
      const square = classes.find(c => /^square-\d{2}$/.test(c));
      if (!piece || !square) continue;

      const m = square.match(/^square-(\d)(\d)$/);
      if (!m) continue;
      const file = Number(m[1]), rank = Number(m[2]);
      if (file < 1 || file > 8 || rank < 1 || rank > 8) continue;

      const row = 8 - rank, col = file - 1;
      const sym = pieceChar(piece);
      if (sym) board[row][col] = sym;
    }

    const rows = board.map(row => {
      let out = "", run = 0;
      for (const cell of row) {
        if (!cell) run++;
        else { if (run) { out += String(run); run = 0; } out += cell; }
      }
      if (run) out += String(run);
      return out || "8";
    });

    return `${rows.join("/")} w - - 0 1`;
  }

  // Auto-grab pipeline: tries multiple methods and returns a valid FEN (does not touch UI)
  function autoGrabFen() {
    setStatus("Scanning page for position...", "normal");
    const methods = [
      { name: "URL parameters", fn: fenFromUrl },
      { name: "DOM attributes", fn: fenFromDomAttribute },
      { name: "Chess.com pieces", fn: fenFromChessComPieces },
      { name: "Move notation", fn: fenFromMovesWithChessJS }
    ];

    for (const method of methods) {
      try {
        const fen = method.fn();
        if (fen && isValidFen(fen)) {
          setStatus(`Position detected via ${method.name}`, "good");
          return fen;
        }
      } catch (e) { console.warn("[Sensei]", method.name, "failed:", e); }
    }
    setStatus("No position found on page", "warning");
    return null;
  }

  // Observer (kept for optional auto mode)
  let autoObserver = null, observerTimeout = null;
  function startAutoObserver() {
    if (autoObserver) return;
    const sel = [
      '[aria-label*="Move List" i]','[class*="move-list" i]','[class*="vertical-move-list" i]',
      '.cg-board','.notation','.moves'
    ];
    let target = null; for (const s of sel) { target = document.querySelector(s); if (target) break; }
    if (!target) target = document.body;
    autoObserver = new MutationObserver(() => {
      clearTimeout(observerTimeout);
      observerTimeout = setTimeout(() => {
        if (!state.isAnalyzing && state.autoMode) {
          const newFen = autoGrabFen();
          if (newFen && newFen !== state.lastPosition) {
            state.lastPosition = newFen;
            analyze();
          }
        }
      }, 1000);
    });
    autoObserver.observe(target, { childList:true, subtree:true, characterData:true, attributes:false });
  }

  // Setup
  function setupAccessibility() {
    // Keep ARIA semantics; no shortcuts or titles referencing shortcuts
    root.setAttribute("role", "dialog");
    root.setAttribute("aria-label", "Chess Analysis Tool");
    els.autograb.title = "Scan the page for the current position";
  }

  function createContextMenu() {
    const menu = document.createElement("div");
    menu.id = "sensei-context-menu";
    menu.innerHTML = `
      <div class="context-item" data-action="clear-all">Clear Captured Position</div>
    `;
    const css = document.createElement("style");
    css.textContent = `
      #sensei-context-menu { position:absolute; background:#2d3748; border:1px solid #4a5568; border-radius:6px; box-shadow:0 4px 12px rgba(0,0,0,.3); padding:4px 0; min-width:180px; z-index:2147483648; display:none; font-size:13px; }
      #sensei-context-menu .context-item { padding:8px 16px; cursor:pointer; color:#e2e8f0; transition:background .2s; }
      #sensei-context-menu .context-item:hover { background: rgba(255,255,255,.1); }
    `;
    document.head.appendChild(css); document.body.appendChild(menu);
    root.addEventListener("contextmenu", (e) => {
      if (e.target.closest("#sensei-overlay")) {
        e.preventDefault();
        menu.style.display = "block"; menu.style.left = e.pageX + "px"; menu.style.top = e.pageY + "px";
      }
    });
    document.addEventListener("click", () => { menu.style.display = "none"; });
    menu.addEventListener("click", (e) => {
      menu.style.display = "none";
      const action = e.target.dataset.action;
      if (action === "clear-all") {
        state.lastPosition = null;
        [els.opp, els.you].forEach(out => out.textContent = "");
        setStatus("Cleared captured position", "good");
      }
    });
  }

  function initialize() {
    setupAccessibility();
    createContextMenu();
    startAutoObserver();

    if (localStorage.getItem("sensei-overlay-hidden") === "true") root.classList.add("hidden");
    setStatus("Ready", "good");
  }

  initialize();
})();
