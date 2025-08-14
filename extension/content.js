console.log("[Sensei] content script alive. typeof Chess =", typeof Chess, "extId=", chrome.runtime?.id);

(() => {
    if (window.__senseiOverlay) return;
    window.__senseiOverlay = true;

    // ----- State -----
    const state = { isAnalyzing: false, lastPosition: null };

    // ----- Overlay -----
    const root = document.createElement("div");
    root.id = "sensei-overlay";
    root.innerHTML = `
    <style>
      #sensei-overlay {
        position: fixed; top: 20px; right: 20px; width: 380px;
        background: #1a1a2e; border: 1px solid #3a4a6b; border-radius: 12px;
        box-shadow: 0 8px 32px rgba(0,0,0,.6);
        font-family: -apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
        font-size: 14px; color: #e2e8f0; z-index: 2147483647;
        opacity: 0; transform: translateY(-20px); animation: slideIn .3s ease-out forwards;
        resize: both; overflow: auto; min-width: 320px; min-height: 200px; max-width: 500px;
      }
      @keyframes slideIn { to { opacity:1; transform: translateY(0);} }
      #sensei-overlay.hidden { display:none !important; }
      #sensei-overlay header {
        background: linear-gradient(90deg,#2d3748 0%,#4a5568 100%);
        padding: 12px 16px; border-radius: 12px 12px 0 0;
        display:flex; justify-content:space-between; align-items:center;
        cursor: move; user-select:none; border-bottom:1px solid #4a5568;
      }
      #sensei-overlay header span { font-weight:600; color:#f7fafc; display:flex; gap:8px; align-items:center; }
      #sensei-overlay header span::before { content:"♛"; font-size:16px; color:#ffd700; }
      #sensei-overlay .header-controls { display:flex; gap:8px; align-items:center; }
      #sensei-overlay .control-btn { background: rgba(255,255,255,.1); border:none; color:#e2e8f0; padding:6px 8px; border-radius:6px; cursor:pointer; font-size:12px; transition:all .2s; }
      #sensei-overlay .control-btn:hover { background: rgba(255,255,255,.2); transform:scale(1.05); }
      #sensei-overlay .body { padding:16px; max-height:500px; overflow-y:auto; }
      #sensei-overlay .row { margin-bottom:12px; }
      #sensei-overlay .row-inline { display:flex; gap:12px; align-items:end; flex-wrap: wrap; }
      #sensei-overlay label { display:block; margin-bottom:6px; font-weight:500; color:#cbd5e0; font-size:12px; text-transform:uppercase; letter-spacing:.5px; }
      #sensei-overlay input, #sensei-overlay select {
        width:100%; padding:10px 12px; background: rgba(255,255,255,.05);
        border:1px solid #4a5568; border-radius:8px; color:#f7fafc; font-size:14px; transition:all .2s;
      }
      #sensei-overlay input:focus, #sensei-overlay select:focus {
        outline:none; border-color:#63b3ed; box-shadow:0 0 0 3px rgba(99,179,237,.1); background: rgba(255,255,255,.08);
      }
      #sensei-overlay input::placeholder { color:#a0aec0; }
      #sensei-overlay button {
        background: linear-gradient(135deg,#4299e1 0%,#3182ce 100%); color:#fff; border:none;
        padding:12px 20px; border-radius:8px; font-weight:500; cursor:pointer; transition:all .2s; position:relative; overflow:hidden;
      }
      #sensei-overlay button:hover:not(:disabled){ transform:translateY(-2px); box-shadow:0 4px 12px rgba(66,153,225,.3); }
      #sensei-overlay button:disabled { background:#4a5568; cursor:not-allowed; opacity:.6; }
      #sensei-overlay button.loading{ color:transparent; }
      #sensei-overlay button.loading::after{
        content:""; position:absolute; top:50%; left:50%; width:16px; height:16px; border:2px solid transparent;
        border-top:2px solid currentColor; border-radius:50%; transform:translate(-50%,-50%); animation: spin 1s linear infinite; color:white;
      }
      @keyframes spin{ to{ transform:translate(-50%,-50%) rotate(360deg);} }
      #sensei-overlay .out {
        background: rgba(0,0,0,.2); border:1px solid #4a5568; border-radius:8px; padding:12px; min-height:24px;
        font-family: ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;
        font-size:13px; line-height:1.5; word-wrap:break-word; position:relative;
      }
      #sensei-overlay .out.loading {
        background: linear-gradient(90deg, rgba(255,255,255,.1) 25%, transparent 50%, rgba(255,255,255,.1) 75%);
        background-size: 200% 100%; animation: shimmer 1.5s infinite;
      }
      @keyframes shimmer { 0%{background-position:200% 0;} 100%{background-position:-200% 0;} }
      #sensei-overlay .good{ color:#68d391; } .bad{ color:#fc8181; } .warning{ color:#f6e05e; }
      #sensei-overlay .status-bar{ display:flex; justify-content:space-between; align-items:center; padding:8px 16px; background: rgba(0,0,0,.2); border-top:1px solid #4a5568; font-size:11px; color:#a0aec0; }
      #sensei-overlay .status-indicator{ display:flex; align-items:center; gap:6px; }
      #sensei-overlay .status-dot{ width:6px; height:6px; border-radius:50%; background:#68d391; animation:pulse 2s infinite; }
      @keyframes pulse{ 0%,100%{opacity:1;} 50%{opacity:.5;} }
      #sensei-overlay .candidates-grid{ display:grid; grid-template-columns:repeat(auto-fit,minmax(60px,1fr)); gap:8px; margin-top:8px; }
      #sensei-overlay .candidate-move{ background:rgba(255,255,255,.1); padding:6px 8px; border-radius:6px; text-align:center; font-weight:500; font-size:12px; border:1px solid transparent; transition:all .2s; cursor:pointer; }
      #sensei-overlay .candidate-move:hover{ background:rgba(255,255,255,.15); border-color:#63b3ed; transform:translateY(-1px); }
      #sensei-overlay .threat-item{ background:rgba(252,129,129,.1); border:1px solid rgba(252,129,129,.3); padding:8px 12px; border-radius:6px; margin-bottom:6px; font-size:12px;}
      #sensei-overlay .threat-item:last-child{ margin-bottom:0;}
      @media (max-width:480px){ #sensei-overlay{ width: calc(100vw - 40px); left:20px; right:20px; } }
    </style>

    <header>
      <span>SenseiBoard • Practice</span>
      <div class="header-controls">
        <button class="control-btn minimize" title="Minimize (Alt+M)">−</button>
        <button class="control-btn close" title="Hide (Alt+A)">✕</button>
      </div>
    </header>

    <div class="body">
      <div class="row">
        <label>Position (FEN)</label>
        <input id="fen" placeholder="Paste FEN or just click Analyze to auto-detect…" autocomplete="off" />
      </div>

      <div class="row row-inline">
        <div style="flex:1">
          <label>Last Move (SAN)</label>
          <input id="san" placeholder="e.g., Qh5, Nf3, O-O" autocomplete="off" />
        </div>
        <div style="width:110px">
          <label>Side to Move</label>
          <select id="side">
            <option value="">Auto</option>
            <option value="white">White</option>
            <option value="black">Black</option>
          </select>
        </div>
      </div>

      <div class="row row-inline">
        <div style="flex:1">
          <label>Think Time (ms)</label>
          <input id="think" type="number" value="350" min="50" max="5000" step="50" />
        </div>
        <div style="flex:1">
          <label>Threat Analysis (ms)</label>
          <input id="threat" type="number" value="150" min="50" max="2000" step="50" />
        </div>
      </div>

      <div class="row row-inline">
        <button id="analyze"><span>🧠 Analyze Position</span></button>
      </div>

      <div class="row">
        <label>🎯 Opponent Threats</label>
        <div id="opp" class="out"></div>
      </div>

      <div class="row">
        <label>💡 Your Best Response</label>
        <div id="you" class="out"></div>
      </div>

      <div class="row">
        <label>📋 Candidate Moves</label>
        <div id="cand" class="out"></div>
      </div>

      <div class="row">
        <label>⚠️ Tactical Threats</label>
        <div id="thr" class="out"></div>
      </div>
    </div>

    <div class="status-bar">
      <div class="status-indicator"><div class="status-dot"></div><span id="status-text">Ready</span></div>
      <div><span id="last-analysis-time">—</span></div>
    </div>
  `;
    document.documentElement.appendChild(root);

    // ----- Cache elements (INCLUDING header & minimize) -----
    const els = {
        header: root.querySelector('header'),
        minimize: root.querySelector('.minimize'),
        close: root.querySelector('.close'),
        body: root.querySelector('.body'),
        fen: root.querySelector('#fen'),
        san: root.querySelector('#san'),
        side: root.querySelector('#side'),
        think: root.querySelector('#think'),
        threat: root.querySelector('#threat'),
        analyze: root.querySelector('#analyze'),
        opp: root.querySelector('#opp'),
        you: root.querySelector('#you'),
        cand: root.querySelector('#cand'),
        thr: root.querySelector('#thr'),
        statusText: root.querySelector('#status-text'),
        lastAnalysisTime: root.querySelector('#last-analysis-time'),
    };

    // Restore saved window position
    try {
        const savedPos = localStorage.getItem('sensei-overlay-position');
        if (savedPos) {
            const { top, left } = JSON.parse(savedPos);
            root.style.top = top + 'px';
            root.style.left = left + 'px';
            root.style.right = 'auto';
        }
    } catch { }

    // ----- Status helpers -----
    function setStatus(text, type = 'normal') {
        els.statusText.textContent = text;
        els.statusText.className = type;
    }

    function toggleVisibility() {
        const isHidden = root.classList.toggle('hidden');
        localStorage.setItem('sensei-overlay-hidden', String(isHidden));
    }

    function minimizeToggle() {
        const isMin = els.body.style.display === 'none';
        els.body.style.display = isMin ? 'block' : 'none';
        els.minimize.textContent = isMin ? '−' : '+';
        els.minimize.title = isMin ? 'Minimize' : 'Restore';
    }

    // ----- Dragging -----
    (function makeDraggable() {
        let dragging = false, sx = 0, sy = 0, ox = 0, oy = 0;
        els.header.addEventListener('mousedown', (e) => {
            if (e.target.closest('button')) return;
            dragging = true; sx = e.clientX; sy = e.clientY;
            const r = root.getBoundingClientRect(); ox = r.left; oy = r.top;
            root.style.cursor = 'grabbing'; e.preventDefault();
        });
        window.addEventListener('mousemove', (e) => {
            if (!dragging) return;
            const dx = e.clientX - sx, dy = e.clientY - sy;
            const nl = Math.max(0, Math.min(window.innerWidth - 320, ox + dx));
            const nt = Math.max(0, Math.min(window.innerHeight - 100, oy + dy));
            root.style.left = nl + 'px'; root.style.top = nt + 'px'; root.style.right = 'auto';
        });
        window.addEventListener('mouseup', () => {
            if (!dragging) return; dragging = false; root.style.cursor = '';
            const rect = root.getBoundingClientRect();
            localStorage.setItem('sensei-overlay-position', JSON.stringify({ top: rect.top, left: rect.left }));
        });
    })();

    // ----- Events -----
    els.close.addEventListener('click', toggleVisibility);
    els.minimize.addEventListener('click', minimizeToggle);
    window.addEventListener('keydown', (e) => {
        if (!e.altKey) return;
        const k = e.key.toLowerCase();
        if (k === 'a') { e.preventDefault(); if (root.classList.contains('hidden')) toggleVisibility(); else analyze(); }
        if (k === 'm') { e.preventDefault(); minimizeToggle(); }
    });

    // ----- Analyze -----
    function setLoadingState(loading) {
        els.analyze.disabled = loading;
        els.analyze.classList.toggle('loading', loading);
        [els.opp, els.you, els.cand, els.thr].forEach(el => {
            el.classList.toggle('loading', loading);
            if (loading) el.textContent = '';
        });
    }

    function displayError(element, message) {
        element.innerHTML = `<span class="bad">⚠️ ${message}</span>`;
    }

    function displayThreats(threats) {
        const items = [];
        if (threats.mate_threat) items.push(`<div class="threat-item">🔥 <strong>Mate threat detected!</strong></div>`);
        if (threats.checks_available >= 2) items.push(`<div class="threat-item">⚡ ${threats.checks_available} checking moves available</div>`);
        else if (threats.checks_available === 1) items.push(`<div class="threat-item">⚡ One checking move available</div>`);
        const hanging = threats.hanging_ours || [];
        if (hanging.length) items.push(`<div class="threat-item">💥 Pieces at risk: ${hanging.map(escapeHtml).join(', ')}</div>`);
        els.thr.innerHTML = items.length ? items.join('') : '<span class="good">No tactical threats found</span>';
    }

    function displayResults(data) {
        els.opp.innerHTML = data.opponent_comment
            ? `<span class="warning">${escapeHtml(data.opponent_comment)}</span>`
            : '<span class="good">No immediate threats detected</span>';

        els.you.innerHTML = data.your_comment
            ? `<span class="good">${escapeHtml(data.your_comment)}</span>`
            : 'No specific recommendation';

        const cands = data.candidates || [];
        if (cands.length) {
            els.cand.innerHTML = `<div class="candidates-grid">${cands.map(m => `<div class="candidate-move" title="Click to copy">${escapeHtml(m)}</div>`).join('')}</div>`;
            els.cand.querySelectorAll('.candidate-move').forEach(el => {
                el.addEventListener('click', () => {
                    navigator.clipboard?.writeText(el.textContent);
                    el.style.background = 'rgba(104,211,145,.2)'; setTimeout(() => el.style.background = '', 500);
                });
            });
        } else {
            els.cand.textContent = 'No candidates found';
        }
        displayThreats(data.threats || {});
    }

    function escapeHtml(t) { const d = document.createElement('div'); d.textContent = t || ''; return d.innerHTML; }

    function isValidFen(fen) {
        try {
            const parts = fen.trim().split(/\s+/);
            if (parts.length < 1) return false;
            const board = parts[0];
            const ranks = board.split('/');
            if (ranks.length !== 8) return false;
            for (const r of ranks) {
                let n = 0;
                for (const ch of r) {
                    if (/[1-8]/.test(ch)) n += +ch;
                    else if (/[prnbqkPRNBQK]/.test(ch)) n += 1;
                    else return false;
                }
                if (n !== 8) return false;
            }
            return true;
        } catch { return false; }
    }

    // ----- FEN auto-detect (used ONLY when clicking Analyze) -----
    // chess.js constructor detection across builds
    function getChessCtor() {
        if (typeof window.Chess === "function") return window.Chess;
        if (window.Chess && typeof window.Chess.Chess === "function") return window.Chess.Chess;
        if (window.chess && typeof window.chess.Chess === "function") return window.chess.Chess;
        return null;
    }

    function fenFromUrl() {
        try {
            const sp = new URL(location.href).searchParams;
            const fen = sp.get("fen") || sp.get("position");
            return fen && fen.includes("/") ? fen : null;
        } catch { return null; }
    }

    function fenFromDomAttribute() {
        const sels = ["[data-whole-fen]", "[data-fen]", ".cg-board[data-fen]", "[fen]", "chess-board[fen]", "chess-board[position]", "[data-position]"];
        for (const s of sels) {
            const node = document.querySelector(s);
            if (!node) continue;
            const fen = node.getAttribute("data-whole-fen") || node.getAttribute("data-fen") || node.getAttribute("fen") || node.getAttribute("position") || node.getAttribute("data-position");
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
            document.querySelector('.notation'),
            document.querySelector('.moves'),
            document.body
        ].filter(Boolean);
        const SAN_RX = /\b(O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8][+#]?|[a-h][1-8][+#]?)(?:\s*[+#])?\b/g;
        const seen = new Set(), tokens = [];
        for (const c of containers) {
            const txt = (c.innerText || "").replace(/\d+\.\.\./g, " ").replace(/\d+\./g, " ");
            for (const m of txt.matchAll(SAN_RX)) {
                const san = (m[1] || "").trim();
                if (san && !seen.has(san)) { seen.add(san); tokens.push(san); }
            }
            if (tokens.length >= 8) break;
        }
        return tokens;
    }

    function fenFromMovesWithChessJS() {
        const ChessCtor = getChessCtor();
        if (!ChessCtor) return null;
        const moves = collectSanCandidates();
        if (!moves.length) return null;
        try {
            const game = new ChessCtor();
            let ok = 0;
            for (const san of moves) { try { if (game.move(san, { sloppy: true })) ok++; } catch { } }
            return ok ? game.fen() : null;
        } catch { return null; }
    }

    function lastMoveFromMovesWithChessJS() {
        const ChessCtor = getChessCtor();
        if (!ChessCtor) return null;
        const moves = collectSanCandidates();
        return moves.length ? moves[moves.length - 1] : null;
    }

    function fenFromChessComPieces() {
        const nodes = Array.from(document.querySelectorAll('.piece[class*="square-"]'));
        if (!nodes.length) return null;
        const board = Array.from({ length: 8 }, () => Array(8).fill(null));
        const pieceChar = (cls) => {
            const color = cls[0] === 'w' ? 'w' : 'b';
            const t = cls[1]; const map = { p: 'p', r: 'r', n: 'n', b: 'b', q: 'q', k: 'k' };
            const ch = map[t]; return ch ? (color === 'w' ? ch.toUpperCase() : ch) : null;
        };
        for (const el of nodes) {
            const classes = (el.className || "").split(/\s+/);
            const piece = classes.find(c => /^[wb][prnbqk]$/.test(c));
            const square = classes.find(c => /^square-\d{2}$/.test(c));
            if (!piece || !square) continue;
            const m = square.match(/^square-(\d)(\d)$/); if (!m) continue;
            const file = +m[1], rank = +m[2]; if (file < 1 || file > 8 || rank < 1 || rank > 8) continue;
            const row = 8 - rank, col = file - 1;
            const sym = pieceChar(piece); if (sym) board[row][col] = sym;
        }
        const rows = board.map(row => {
            let out = "", run = 0;
            for (const cell of row) {
                if (!cell) run++; else { if (run) { out += String(run); run = 0; } out += cell; }
            }
            if (run) out += String(run);
            return out || "8";
        });
        return `${rows.join("/")} w - - 0 1`;
    }

    function autoGrabFen() {
        setStatus("Scanning page for position…");
        const methods = [
            { name: "URL", fn: fenFromUrl },
            { name: "DOM", fn: fenFromDomAttribute },
            { name: "Pieces", fn: fenFromChessComPieces },
            { name: "Moves", fn: fenFromMovesWithChessJS },
        ];
        for (const m of methods) {
            try {
                const fen = m.fn();
                if (fen && isValidFen(fen)) {
                    els.fen.value = fen;
                    const last = lastMoveFromMovesWithChessJS(); if (last) els.san.value = last;
                    const side = detectSideFromFen(fen); if (side) els.side.value = side;
                    setStatus(`Position detected via ${m.name}`, "good");
                    return fen;
                }
            } catch (e) { console.warn("[Sensei] auto-grab", m.name, "failed:", e); }
        }
        setStatus("No position found on page", "warning");
        return null;
    }

    function detectSideFromFen(fen) {
        try { const s = fen.split(/\s+/)[1]; return s === "w" ? "white" : (s === "b" ? "black" : null); } catch { return null; }
    }

    // ----- Main analyze flow -----
    async function analyze() {
        if (state.isAnalyzing) return;

        // Auto-detect when empty
        let fen = (els.fen.value || "").trim();
        if (!fen) fen = autoGrabFen();
        if (!fen) { displayError(els.opp, "Please paste a FEN or open an analysis board."); return; }

        if (!isValidFen(fen)) { displayError(els.opp, "Invalid FEN format."); return; }

        const payload = {
            fen,
            last_move_san: (els.san.value || "").trim() || null,
            side_to_move: els.side.value || null,
            movetime_ms: Math.max(50, Math.min(5000, Number(els.think.value) || 350)),
            threat_time_ms: Math.max(50, Math.min(2000, Number(els.threat.value) || 150)),
            use_llm: true
        };

        state.isAnalyzing = true; state.lastPosition = fen;
        setLoadingState(true); setStatus("Analyzing…");
        const t0 = Date.now();

        try {
            const reply = await chrome.runtime.sendMessage({ type: "sensei.analyze", payload })
                .catch(err => ({ ok: false, error: String(err) }));

            els.lastAnalysisTime.textContent = `${((Date.now() - t0) / 1000).toFixed(1)}s`;

            if (!reply?.ok) {
                displayError(els.opp, `Analysis failed: ${reply?.error || reply?.status || "Unknown error"}`);
                setStatus("Analysis failed", "bad");
                return;
            }
            displayResults(reply.data || {});
            setStatus("Analysis complete", "good");
        } catch (err) {
            displayError(els.opp, `Connection error: ${String(err)}`); setStatus("Connection error", "bad");
        } finally {
            state.isAnalyzing = false; setLoadingState(false);
        }
    }

    // Wire button & defaults
    els.analyze.addEventListener('click', analyze);
    const wasHidden = localStorage.getItem('sensei-overlay-hidden') === 'true';
    if (wasHidden) root.classList.add('hidden');
    els.fen.value = "rnbqkbnr/pppppppp/8/7Q/8/8/PPPPPPPP/RNB1KBNR b KQkq - 1 2";
    els.san.value = "Qh5";
    setStatus("Ready — press Alt+A to analyze", "good");

    // Log chess.js availability once
    const chessCtor = (typeof window.Chess === "function") || (window.Chess && typeof window.Chess.Chess === "function");
    console.log("[Sensei] chess.js available =", chessCtor);
})();
