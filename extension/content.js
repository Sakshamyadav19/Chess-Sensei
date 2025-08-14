console.log("[Sensei] content script alive. typeof Chess =", typeof Chess, "extId=", chrome.runtime?.id);
(() => {
  if (window.__senseiOverlay) return;
  window.__senseiOverlay = true;

  // UI ------------------------------------------------------------
  const root = document.createElement("div");
  root.id = "sensei-overlay";
  root.innerHTML = `
    <header>
      <span>SenseiBoard • Practice</span>
      <button class="close" title="Hide (Alt+A)">✕</button>
    </header>
    <div class="body">
      <div class="row">
        <label>FEN</label>
        <input id="fen" placeholder="paste FEN here…" />
      </div>
      <div class="row row-inline">
        <div style="flex:1">
          <label>Last move (SAN)</label>
          <input id="san" placeholder="e.g., Qh5" />
        </div>
        <div style="width:110px">
          <label>Side</label>
          <select id="side">
            <option value="">auto</option>
            <option>white</option>
            <option>black</option>
          </select>
        </div>
      </div>
      <div class="row row-inline">
        <div style="flex:1">
          <label>Think (ms)</label>
          <input id="think" type="number" value="350" />
        </div>
        <div style="flex:1">
          <label>Threat (ms)</label>
          <input id="threat" type="number" value="150" />
        </div>
      </div>
      <div class="row row-inline">
        <button id="analyze">Analyze (Alt+A)</button>
        <label class="pill"><input id="use-llm" type="checkbox" checked style="margin-right:6px">LLM phrasing</label>
        <button id="autograb" title="Try to read from the page">Auto-grab</button>
      </div>
      <div class="row">
        <label>Opponent</label>
        <div id="opp" class="out"></div>
      </div>
      <div class="row">
        <label>Your move</label>
        <div id="you" class="out"></div>
      </div>
      <div class="row">
        <label>Candidates</label>
        <div id="cand" class="out"></div>
      </div>
      <div class="row">
        <label>Threats</label>
        <div id="thr" class="out"></div>
      </div>
    </div>
  `;
  document.documentElement.appendChild(root);

  const els = {
    close: root.querySelector(".close"),
    fen: root.querySelector("#fen"),
    san: root.querySelector("#san"),
    side: root.querySelector("#side"),
    think: root.querySelector("#think"),
    threat: root.querySelector("#threat"),
    analyze: root.querySelector("#analyze"),
    useLLM: root.querySelector("#use-llm"),
    autograb: root.querySelector("#autograb"),
    opp: root.querySelector("#opp"),
    you: root.querySelector("#you"),
    cand: root.querySelector("#cand"),
    thr: root.querySelector("#thr"),
  };

  function toggle() {
    root.style.display = (root.style.display === "none") ? "block" : "none";
  }
  els.close.addEventListener("click", toggle);
  window.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "a") toggle();
  });

  async function analyze() {
    const fen = els.fen.value.trim();
    if (!fen) { els.opp.textContent = "Paste a FEN."; return; }

    const payload = {
      fen,
      last_move_san: els.san.value.trim() || null,
      side_to_move: els.side.value || null,
      movetime_ms: Number(els.think.value) || 350,
      threat_time_ms: Number(els.threat.value) || 150,
      use_llm: els.useLLM.checked
    };

    els.analyze.disabled = true;
    els.opp.textContent = "Thinking…";
    els.you.textContent = "";
    els.cand.textContent = "";
    els.thr.textContent = "";

    try {
      const reply = await chrome.runtime.sendMessage({
        type: "sensei.analyze",
        payload
      }).catch(err => ({ ok: false, error: String(err) }));

      if (!reply?.ok) {
        els.opp.innerHTML = `<span class="bad">Error:</span> ${reply?.error || reply?.status || "unknown"}`;
        return;
      }

      const data = reply.data || {};
      els.opp.textContent = data.opponent_comment || "";
      els.you.textContent = data.your_comment || "";
      els.cand.textContent = (data.candidates || []).join(", ");

      const t = data.threats || {};
      const bits = [];
      if (t.mate_threat) bits.push("mate threat");
      if (t.checks_available >= 2) bits.push(`${t.checks_available} checking moves`);
      else if (t.checks_available === 1) bits.push("a checking move");
      if ((t.hanging_ours || []).length) bits.push(`hanging: ${t.hanging_ours.join(", ")}`);
      els.thr.textContent = bits.join("; ");
    } catch (err) {
      els.opp.innerHTML = `<span class="bad">Message error:</span> ${String(err)}`;
    } finally {
      els.analyze.disabled = false;
    }
  }

  // ---------- FEN Grabbers ----------
  function fenFromUrl() {
    try {
      const sp = new URL(location.href).searchParams;
      const fen = sp.get("fen");
      return fen && fen.includes("/") ? fen : null;
    } catch { return null; }
  }

  function fenFromDomAttribute() {
    const node = document.querySelector("[data-fen]")
             || document.querySelector(".cg-board[data-fen]")
             || document.querySelector("[fen]")
             || document.querySelector("chess-board[fen], chess-board[position]");
    if (!node) return null;
    const fen = node.getAttribute("data-fen")
              || node.getAttribute("fen")
              || node.getAttribute("position");
    return fen && fen.includes("/") ? fen : null;
  }

  function collectSanCandidates() {
    const buckets = [
      document.querySelector('[aria-label*="Move List" i]'),
      document.querySelector('[class*="move-list" i]'),
      document.querySelector('[class*="vertical-move-list" i]'),
      document.querySelector('[class*="moves" i]'),
      document.querySelector('[id*="moves" i]'),
      document.body
    ].filter(Boolean);

    const SAN_RX = /\b(O-O-O|O-O|[KQRBN]?[a-h]?[1-8]?x?[a-h][1-8](?:=[QRBN])?[+#]?|[a-h]x[a-h][1-8][+#]?|[a-h][1-8][+#]?)(?:\s*\+|#)?\b/g;

    const seen = new Set();
    const tokens = [];

    for (const b of buckets) {
      const txt = (b.innerText || "").replace(/\d+\./g, " ");
      const iter = txt.matchAll(SAN_RX);
      for (const m of iter) {
        const san = m[1].trim();
        if (!seen.has(san)) {
          seen.add(san);
          tokens.push(san);
        }
      }
      if (tokens.length >= 4) break;
    }
    return tokens;
  }

  function fenFromMovesWithChessJS() {
    if (typeof Chess !== "function") return null;
    const moves = collectSanCandidates();
    if (!moves.length) return null;

    const game = new Chess();
    for (const san of moves) {
      try { game.move(san, { sloppy: true }); } catch {}
    }
    return game.fen();
  }

  function lastMoveFromMovesWithChessJS() {
    if (typeof Chess !== "function") return null;
    const moves = collectSanCandidates();
    if (!moves.length) return null;
    return moves[moves.length - 1] || null;
  }

  function detectSideFromFen(fen) {
    try {
      const side = fen.split(/\s+/)[1];
      if (side === "w") return "white";
      if (side === "b") return "black";
    } catch {}
    return null;
  }

  function autoGrabFen() {
    let fen = fenFromUrl();
    if (!fen) fen = fenFromDomAttribute();
    if (!fen) fen = fenFromChessComPieces();
    if (!fen) fen = fenFromMovesWithChessJS();

    if (fen) {
      els.fen.value = fen;
      const san = lastMoveFromMovesWithChessJS();
      if (san) els.san.value = san;
      const side = detectSideFromFen(fen);
      if (side) els.side.value = side;
      return fen;
    }
    return null;
  }

  els.autograb.addEventListener("click", () => {
    const fen = autoGrabFen();
    if (!fen) {
      els.opp.innerHTML = `<span class="bad">Couldn’t read from page.</span> Paste FEN or try on an analysis page.`;
    } else {
      analyze();
    }
  });

  // Optional: live updates on DOM changes (enable if you like)
  let autoObserver = null;
  function startAutoObserver() {
    if (autoObserver) return;
    autoObserver = new MutationObserver(() => {
      const fen = autoGrabFen();
      if (fen) analyze();
    });
    const target =
      document.querySelector('[aria-label*="Move List" i]') ||
      document.querySelector('[class*="move-list" i]') ||
      document.querySelector('[class*="vertical-move-list" i]') ||
      document.querySelector(".cg-board") ||
      document.body;

    autoObserver.observe(target, { childList: true, subtree: true, characterData: true });
  }
  startAutoObserver(); // keep if you want automatic refresh

  // Wire main button + helpful defaults
  els.analyze.addEventListener("click", analyze);
  els.fen.value = "rnbqkbnr/pppppppp/8/7Q/8/8/PPPPPPPP/RNB1KBNR b KQkq - 1 2";
  els.san.value = "Qh5";
})();


function fenFromChessComPieces() {
  // find all piece nodes that carry square info
  const nodes = Array.from(document.querySelectorAll('.piece[class*="square-"]'));
  if (!nodes.length) return null;

  // 8x8 board, [rank8..rank1][file a..h]
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));

  const pieceChar = (cls) => {
    // cls like 'wp','wn','wb','wq','wk' or 'bp','bn','bb','bq','bk'
    const color = cls[0] === 'w' ? 'w' : 'b';
    const t = cls[1]; // p,r,n,b,q,k
    const char = ({ p:'p', r:'r', n:'n', b:'b', q:'q', k:'k' })[t];
    return color === 'w' ? char.toUpperCase() : char;
  };

  for (const el of nodes) {
    const classes = (el.className || "").split(/\s+/);
    const piece = classes.find(c => /^(w|b)[prnbqk]$/.test(c));
    const sq = classes.find(c => /^square-\d{2}$/.test(c));
    if (!piece || !sq) continue;

    const m = sq.match(/^square-(\d)(\d)$/);
    if (!m) continue;
    const file = Number(m[1]); // 1..8  (a..h)
    const rank = Number(m[2]); // 1..8  (1..8)

    // board index: ranks 8..1 => row = 8 - rank, files a..h => col = file - 1
    const row = 8 - rank;
    const col = file - 1;
    board[row][col] = pieceChar(piece);
  }

  // Build FEN rows
  const rows = board.map(row => {
    let out = "", run = 0;
    for (const cell of row) {
      if (!cell) { run++; }
      else {
        if (run) { out += String(run); run = 0; }
        out += cell;
      }
    }
    if (run) out += String(run);
    return out || "8";
  });

  // Side/castling/ep: we can’t know reliably; choose safe defaults.
  const fen = `${rows.join("/")} w - - 0 1`;
  return fen;
}

