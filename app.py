# app.py
# SenseiBoard — Flask + Stockfish + Quick Threats (null-move scan)
# ---------------------------------------------------------------

import os
os.environ.setdefault("TOKENIZERS_PARALLELISM", "false")

import atexit
import threading
import subprocess
from typing import Optional, List, Tuple, Dict, Any

from flask import Flask, request, jsonify
from flask_cors import CORS

import chess
import chess.engine  # python-chess engine bridge
from chess.engine import EngineTerminatedError, EngineError

import rag_support
import gemini_support

app = Flask(__name__)
CORS(app, resources={r"/api/*": {"origins": "*"}})

# ----------------------------- Engine management -----------------------------
ENGINE = None
ENGINE_LOCK = threading.Lock()
ENGINE_READY = False


def find_engine_path() -> str:
    """Find Stockfish binary path from $STOCKFISH_PATH or assume 'stockfish' in PATH."""
    return os.getenv("STOCKFISH_PATH") or "stockfish"


def init_engine():
    """Start Stockfish once and configure light options."""
    global ENGINE, ENGINE_READY
    if ENGINE_READY and ENGINE is not None:
        return
    path = find_engine_path()
    try:
        # IMPORTANT: send stderr to DEVNULL so we don't fill an unread PIPE.
        ENGINE = chess.engine.SimpleEngine.popen_uci(
            path,
            setpgrp=True,
            stderr=subprocess.DEVNULL,
        )
        ENGINE.configure({
            "Threads": 2,   # keep it light and responsive
            "Hash": 64,     # MB
            # You can add tablebase or NNUE options here later if needed.
        })
        ENGINE_READY = True
        print(f"[engine] Stockfish started at: {path}")
    except Exception as e:
        print(f"[engine] Could not start Stockfish at '{path}': {e}")
        ENGINE = None
        ENGINE_READY = False


def restart_engine():
    """Kill & reinit the engine after a crash."""
    global ENGINE, ENGINE_READY
    try:
        if ENGINE is not None:
            ENGINE.quit()
    except Exception:
        pass
    ENGINE = None
    ENGINE_READY = False
    init_engine()


def engine_analyse_safe(board: chess.Board,
                        limit: chess.engine.Limit,
                        multipv: Optional[int] = None):
    """
    Wrapper around ENGINE.analyse that auto-restarts Stockfish once if it died.
    Returns dict or list[dict] like python-chess. Raises only after two failures.
    """
    global ENGINE_READY
    last_exc = None
    for attempt in (1, 2):
        try:
            if not ENGINE_READY or ENGINE is None:
                init_engine()
                if not ENGINE_READY:
                    raise RuntimeError("Stockfish not available")
            with ENGINE_LOCK:
                if multipv is not None:
                    return ENGINE.analyse(board, limit, multipv=multipv)
                return ENGINE.analyse(board, limit)
        except (EngineTerminatedError, EngineError, BrokenPipeError) as e:
            print(f"[engine] analyse failed ({type(e).__name__}); restarting (attempt {attempt})")
            last_exc = e
            restart_engine()
    raise last_exc or RuntimeError("Stockfish analyse failed")


@atexit.register
def close_engine():
    """Gracefully close on process exit."""
    global ENGINE
    try:
        if ENGINE is not None:
            ENGINE.quit()
    except Exception:
        pass


# ----------------------------- small board feature helpers (for RAG cues) -----------------------------
def is_castled_short(board: chess.Board, color: chess.Color) -> bool:
    k = board.king(color)
    return k in (chess.G1, chess.G8)


def queen_on_h5_or_h4(board: chess.Board, color: chess.Color) -> bool:
    sym = 'Q' if color == chess.WHITE else 'q'
    for sq in (chess.H5, chess.H4):
        p = board.piece_at(sq)
        if p and p.symbol() == sym:
            return True
    return False


def line_to_h7_or_h2(board: chess.Board, attacker_color: chess.Color, our_color: chess.Color) -> bool:
    target = chess.H7 if our_color == chess.WHITE else chess.H2
    for sq in board.attackers(attacker_color, target):
        pc = board.piece_at(sq)
        if pc and pc.color == attacker_color and pc.piece_type in (chess.BISHOP, chess.QUEEN):
            return True
    return False


def our_back_rank_boxed(board: chess.Board, our_color: chess.Color) -> bool:
    k = board.king(our_color)
    if k not in (chess.E1, chess.G1, chess.C1, chess.E8, chess.G8, chess.C8):
        return False
    rank = 1 if our_color == chess.WHITE else 6
    pawns = 0
    for file_idx in (5, 6, 7):  # f,g,h
        sq = chess.square(file_idx, rank)
        p = board.piece_at(sq)
        if p and p.piece_type == chess.PAWN and p.color == our_color:
            pawns += 1
    return pawns >= 2


def their_major_on_open_file(board: chess.Board, opp_color: chess.Color) -> bool:
    for pt in (chess.ROOK, chess.QUEEN):
        for sq in board.pieces(pt, opp_color):
            file_idx = chess.square_file(sq)
            pawn_on_file = any(
                (board.piece_at(chess.square(file_idx, r)) and
                 board.piece_at(chess.square(file_idx, r)).piece_type == chess.PAWN)
                for r in range(8)
            )
            if not pawn_on_file:
                return True
    return False


def our_hanging_piece_exists(board: chess.Board, our_color: chess.Color) -> bool:
    opp = not our_color
    for sq, piece in board.piece_map().items():
        if piece.color != our_color:
            continue
        attacked = board.is_attacked_by(opp, sq)
        defended = board.is_attacked_by(our_color, sq)
        if attacked and not defended:
            return True
    return False


def their_king_castled_short(board: chess.Board, opp_color: chess.Color) -> bool:
    k = board.king(opp_color)
    return k in (chess.G1, chess.G8)


def our_bishop_attacks_h7_or_h2(board: chess.Board, our_color: chess.Color, opp_color: chess.Color) -> bool:
    target = chess.H7 if opp_color == chess.BLACK else chess.H2
    for sq in board.attackers(our_color, target):
        p = board.piece_at(sq)
        if p and p.color == our_color and p.piece_type == chess.BISHOP:
            return True
    return False


def our_knight_can_jump_g5_or_g4(board: chess.Board, our_color: chess.Color) -> bool:
    targets = [chess.G5, chess.G4]
    for from_sq in board.pieces(chess.KNIGHT, our_color):
        for t in targets:
            m = chess.Move(from_sq, t)
            if m in board.legal_moves:
                return True
    return False


def any_pinned_piece_to_king(board: chess.Board, opp_color: chess.Color) -> bool:
    for sq, piece in board.piece_map().items():
        if piece.color != opp_color:
            continue
        if board.is_pinned(opp_color, sq):
            return True
    return False


def xray_same_file_as_king_with_one_blocker(board: chess.Board, our_color: chess.Color, opp_color: chess.Color) -> bool:
    """Our rook/queen share file with enemy king, exactly one piece between."""
    ksq = board.king(opp_color)
    k_file = chess.square_file(ksq)
    for pt in (chess.ROOK, chess.QUEEN):
        for sq in board.pieces(pt, our_color):
            if chess.square_file(sq) != k_file:
                continue
            blockers = 0
            start_rank = chess.square_rank(sq)
            end_rank = chess.square_rank(ksq)
            step = 1 if end_rank > start_rank else -1
            for r in range(start_rank + step, end_rank, step):
                mid = chess.square(k_file, r)
                if board.piece_at(mid):
                    blockers += 1
                    if blockers > 1:
                        break
            if blockers == 1:
                return True
    return False


def queen_bishop_same_diagonal_with_blocker(board: chess.Board, our_color: chess.Color) -> bool:
    """Our queen and bishop are aligned on a diagonal with exactly one friendly blocker between (discovered attack potential)."""
    qs = list(board.pieces(chess.QUEEN, our_color))
    bs = list(board.pieces(chess.BISHOP, our_color))
    for q in qs:
        for b in bs:
            df = abs(chess.square_file(q) - chess.square_file(b))
            dr = abs(chess.square_rank(q) - chess.square_rank(b))
            if df != dr:
                continue
            sf = 1 if chess.square_file(b) > chess.square_file(q) else -1
            sr = 1 if chess.square_rank(b) > chess.square_rank(q) else -1
            f, r = chess.square_file(q) + sf, chess.square_rank(q) + sr
            blockers = 0
            while f != chess.square_file(b) and r != chess.square_rank(b):
                sq = chess.square(f, r)
                piece = board.piece_at(sq)
                if piece:
                    if piece.color == our_color:
                        blockers += 1
                    else:
                        blockers = 99
                        break
                f += sf; r += sr
            if blockers == 1:
                return True
    return False


def f7_f2_under_pressure(board: chess.Board, our_color: chess.Color, opp_color: chess.Color) -> bool:
    """Attackers on f7/f2 outnumber defenders (rough threshold)."""
    target = chess.F7 if opp_color == chess.BLACK else chess.F2
    att = len(board.attackers(our_color, target))
    deff = len(board.attackers(opp_color, target))
    return att >= max(2, deff + 1)


def build_feature_tokens(board: chess.Board, last_move_san: Optional[str]) -> List[str]:
    our_color = board.turn
    opp_color = not our_color
    feats = []

    if last_move_san in ("Qh5", "Qh4"):
        feats.append("opponent_queen_on_h5_or_h4")

    if is_castled_short(board, our_color):
        feats.append("our_king_castled_short")
    if line_to_h7_or_h2(board, opp_color, our_color):
        feats.append("line_to_h7_or_h2")
    if our_back_rank_boxed(board, our_color):
        feats.append("our_back_rank_boxed")
    if their_major_on_open_file(board, opp_color):
        feats.append("their_major_on_open_file")
    if our_hanging_piece_exists(board, our_color):
        feats.append("our_hanging_piece_exists")

    if their_king_castled_short(board, opp_color):
        feats.append("their_king_castled_short")
    if our_bishop_attacks_h7_or_h2(board, our_color, opp_color):
        feats.append("our_bishop_attacks_h7_or_h2")
    if our_knight_can_jump_g5_or_g4(board, our_color):
        feats.append("our_knight_can_jump_g5_or_g4")
    if any_pinned_piece_to_king(board, opp_color):
        feats.append("their_piece_pinned_to_king")
    if xray_same_file_as_king_with_one_blocker(board, our_color, opp_color):
        feats.append("xray_same_file_as_king_with_one_blocker")
    if queen_bishop_same_diagonal_with_blocker(board, our_color):
        feats.append("queen_bishop_same_diagonal_with_blocker")
    if f7_f2_under_pressure(board, our_color, opp_color):
        feats.append("f7_or_f2_under_pressure")

    feats.append("phase_middlegame")  # safe default
    return feats


# ----------------------------- Small helpers -----------------------------
def short_human_eval(score: chess.engine.PovScore) -> str:
    """Convert engine score to a short human string for the side-to-move POV."""
    if score.is_mate():
        m = score.mate()
        return f"# {abs(m)} for you" if m and m > 0 else f"# {abs(m)} against you"
    cp = score.score(mate_score=100000)
    return f"{cp/100:+.2f}"


def san_of_move(board: chess.Board, move: chess.Move) -> str:
    try:
        return board.san(move)
    except Exception:
        return move.uci()


# ----------------------------- Core engine queries -----------------------------
def multipv_top(board: chess.Board, movetime_s: float = 0.4, lines: int = 3) -> List[Tuple[str, float]]:
    """Ask Stockfish for multiple principal variations (MultiPV)."""
    if not ENGINE_READY:
        return []
    try:
        info_list = engine_analyse_safe(board, chess.engine.Limit(time=movetime_s), multipv=lines)
    except Exception as e:
        print(f"[engine] multipv_top failed: {e}")
        return []

    if isinstance(info_list, dict):  # multipv=1 case
        info_list = [info_list]

    results: List[Tuple[str, float]] = []
    for info in info_list:
        pv = info.get("pv", [])
        score = info.get("score")
        if not pv or score is None:
            continue
        best = pv[0]
        san = san_of_move(board, best)
        pov = score.pov(board.turn)
        cp = pov.score(mate_score=100000)
        results.append((san, float(cp)))

    results.sort(key=lambda x: x[1], reverse=True)
    return results


def quick_threat_scan(board: chess.Board, time_s: float = 0.2) -> Dict[str, Any]:
    """Very fast 'what if we pass the move?' scan using a null move."""
    b = board.copy(stack=False)
    try:
        b.push(chess.Move.null())  # "do nothing", switch side to move
    except Exception:
        return {"mate_threat": False, "checks_available": 0, "best_reply": None,
                "opp_eval_if_idle_cp": None, "hanging_ours": [], "engine_down": False}

    best_reply_san = None
    opp_eval_cp = None
    mate_threat = False
    engine_down = False

    try:
        info = engine_analyse_safe(b, chess.engine.Limit(time=time_s))
    except Exception as e:
        print(f"[engine] quick_threat_scan failed: {e}")
        info = None
        engine_down = True

    if info is not None:
        score_pov_opp = info["score"].pov(b.turn)
        if score_pov_opp.is_mate():
            m = score_pov_opp.mate()
            mate_threat = bool(m and m > 0)
            opp_eval_cp = 10000.0  # treat as huge
        else:
            opp_eval_cp = score_pov_opp.score(mate_score=100000) / 100.0

        pv = info.get("pv", [])
        if pv:
            best_reply_san = san_of_move(b, pv[0])

    checks = 0
    for mv in b.legal_moves:
        try:
            if b.gives_check(mv):
                checks += 1
        except Exception:
            continue

    our_color = board.turn
    opp_color = not our_color
    hanging: List[str] = []
    for sq, piece in board.piece_map().items():
        if piece.color != our_color:
            continue
        attacked_by_opp = board.is_attacked_by(opp_color, sq)
        defended_by_us = board.is_attacked_by(our_color, sq)
        if attacked_by_opp and not defended_by_us:
            name = piece.symbol().upper() if our_color == chess.WHITE else piece.symbol().lower()
            hanging.append(f"{name}{chess.square_name(sq)}")

    return {
        "mate_threat": mate_threat,
        "checks_available": checks,
        "best_reply": best_reply_san,
        "opp_eval_if_idle_cp": opp_eval_cp,
        "hanging_ours": hanging,
        "engine_down": engine_down,
    }


def best_line_comment(board: chess.Board, last_move_san: Optional[str], movetime_s: float = 0.4):
    """
    Drive engine once, produce short comments:
    - Opponent summary: last move + quick eval
    - Your suggestion: best move SAN + eval
    """
    if not ENGINE_READY:
        return ("Engine warming up…", "Retry in a moment.", [], None)

    top = multipv_top(board, movetime_s=movetime_s, lines=3)
    if not top:
        return ("Engine recovering…", "Retry shortly.", [], None)

    best_san, _ = top[0]
    candidates = [m for m, _ in top]

    try:
        info = engine_analyse_safe(board, chess.engine.Limit(time=0.2))
        human_eval = short_human_eval(info["score"].pov(board.turn))
        eval_cp = info["score"].pov(board.turn).score(mate_score=100000) / 100.0
    except Exception as e:
        print(f"[engine] best_line_comment quick eval failed: {e}")
        human_eval = "+0.00"
        eval_cp = 0.0

    opp_text = f"{last_move_san} — position eval {human_eval}." if last_move_san else f"Position eval {human_eval}."
    your_text = f"Try {best_san}. It’s strongest here."

    return (opp_text, your_text, candidates, eval_cp)


# ----------------------------- Flask routes -----------------------------
@app.post("/api/analyze")
def analyze():
    # lazy init engine
    if not ENGINE_READY:
        init_engine()

    # lazy init RAG index
    if not rag_support.has_index():
        rag_support.init_index("corpus/motifs")

    data = request.get_json(silent=True) or {}
    fen = data.get("fen")
    if not fen:
        return jsonify({"error": "fen is required"}), 400

    last_move_san = data.get("last_move_san")
    side_to_move = data.get("side_to_move")
    movetime_ms = float(data.get("movetime_ms", 400))
    threat_time_ms = float(data.get("threat_time_ms", 200))
    movetime_s = max(0.08, min(1.0, movetime_ms / 1000.0))
    threat_time_s = max(0.05, min(0.6, threat_time_ms / 1000.0))

    try:
        board = chess.Board(fen)
    except Exception as e:
        return jsonify({"error": f"Invalid FEN: {e}"}), 400

    if side_to_move:
        stm_is_white = (side_to_move.lower() == "white")
        if stm_is_white != board.turn:
            board.turn = chess.WHITE if stm_is_white else chess.BLACK

    # 1) threats (safe)
    threats = quick_threat_scan(board, time_s=threat_time_s)

    # 2) best moves (safe)
    opp_comment, your_comment, candidates, eval_cp = best_line_comment(board, last_move_san, movetime_s)

    # 3) RAG: retrieve motif cards using cheap board features
    feat_tokens = build_feature_tokens(board, last_move_san)
    cards = rag_support.retrieve_motifs(feat_tokens, top_k=5)
    primary_card = cards[0] if cards else None
    rag_text = rag_support.format_comments_from_cards(cards, last_move_san)

    # Merge RAG comments
    if rag_text["opponent_comment"]:
        opp_comment = rag_text["opponent_comment"]
    if rag_text["your_comment"]:
        if threats["mate_threat"] or threats["checks_available"] >= 1 or threats["hanging_ours"]:
            your_comment = "Parry threats first. " + rag_text["your_comment"]
        else:
            your_comment = rag_text["your_comment"]

    # LLM phrasing layer (Gemini)
    use_llm = bool(os.getenv("GOOGLE_API_KEY")) and bool(data.get("use_llm", False))
    if use_llm:
        engine_best_san = candidates[0] if candidates else None
        llm_out = gemini_support.generate_comments(
            last_move_san=last_move_san,
            engine_best_san=engine_best_san or "",
            candidates=candidates,
            eval_cp=eval_cp,
            threats=threats,
            motif_card=primary_card,
        )
        if llm_out.get("opponent_comment"):
            opp_comment = llm_out["opponent_comment"]
        if llm_out.get("your_comment"):
            if (threats["mate_threat"] or threats["checks_available"] >= 1 or threats["hanging_ours"]) \
               and not llm_out["your_comment"].lower().startswith("parry"):
                your_comment = "Parry threats first. " + llm_out["your_comment"]
            else:
                your_comment = llm_out["your_comment"]

    # Append a concise threat blurb for transparency
    bits = []
    if threats["mate_threat"]:
        bits.append("mate threat")
    if threats["checks_available"] >= 2:
        bits.append(f"{threats['checks_available']} checking moves")
    elif threats["checks_available"] == 1:
        bits.append("a checking move")
    if threats["hanging_ours"]:
        bits.append(f"hanging: {', '.join(threats['hanging_ours'])}")
    if bits:
        opp_comment = f"{opp_comment} Threat: " + "; ".join(bits) + "."

    return jsonify({
        "llm_available": bool(os.getenv("GOOGLE_API_KEY")),
        "llm_used": bool(os.getenv("GOOGLE_API_KEY")) and bool(data.get("use_llm", False)),
        "opponent_comment": opp_comment,
        "your_comment": your_comment,
        "candidates": candidates,
        "eval_hint": None if eval_cp is None else round(eval_cp, 2),
        "threats": threats,
        "features": feat_tokens,
        "rag_cards_used": [c["id"] for c in cards]
    }), 200


@app.get("/api/health")
def health():
    return jsonify({"engine_ready": ENGINE_READY})


if __name__ == "__main__":
    init_engine()
    # init RAG on startup if you like; it will also lazy init in the route
    rag_support.init_index("corpus/motifs")
    app.run(host="127.0.0.1", port=8000, debug=True)
