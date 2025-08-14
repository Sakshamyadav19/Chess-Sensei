# gemini_support.py
# Minimal Gemini phrasing layer for SenseiBoard. Keeps outputs short & grounded.

from __future__ import annotations
import os, json
from typing import Dict, Any, List

import google.generativeai as genai

# Configure once
_API_KEY = os.getenv("GOOGLE_API_KEY")
_MODEL_NAME = os.getenv("gemini-2.5-pro")  

def _configured() -> bool:
    return bool(_API_KEY)

def _client():
    if not _configured():
        raise RuntimeError("GOOGLE_API_KEY not set")
    genai.configure(api_key=_API_KEY)
    return genai.GenerativeModel(_MODEL_NAME)

def _safe_take(text: str, max_words: int = 25) -> str:
    words = text.strip().split()
    if len(words) <= max_words:
        return text.strip()
    return " ".join(words[:max_words]).rstrip(",.;:") + "."

def generate_comments(
    last_move_san: str | None,
    engine_best_san: str,
    candidates: List[str],
    eval_cp: float | None,
    threats: Dict[str, Any],
    motif_card: Dict[str, Any] | None,
) -> Dict[str, str]:
    """
    Return {"opponent_comment": str, "your_comment": str}
    - Short, grounded summaries. The model rephrases known facts; it doesn't invent moves.
    """
    if not _configured():
        # No key set -> caller should skip LLM
        return {"opponent_comment": "", "your_comment": ""}

    # Build a compact, JSON-oriented prompt so we can parse reliably.
    context = {
        "last_move_san": last_move_san,
        "engine_best_san": engine_best_san,
        "candidates": candidates[:3],
        "eval_cp_for_side_to_move": eval_cp,
        "threats": threats,
        "motif": {
            "name": motif_card.get("name") if motif_card else None,
            "explain": motif_card.get("explain") if motif_card else None,
            "reply": motif_card.get("reply") if motif_card else None
        }
    }

    sys = (
        "You are a chess coach. Write concise, tactical English. "
        "Use at most 25 words per sentence. No fluff. No new moves beyond engine_best_san/candidates. "
        "If threats exist, acknowledge them briefly."
    )

    user = (
        "Produce a pure JSON object with keys:\n"
        "  opponent_comment: one short sentence explaining opponent's idea or threat\n"
        "  your_comment: one short sentence recommending our reply and why\n"
        "Constraints:\n"
        "- <= 25 words each\n"
        "- Use motif name if provided\n"
        "- Do NOT invent moves not in engine_best_san/candidates\n\n"
        f"Context JSON:\n{json.dumps(context, ensure_ascii=False)}"
    )

    try:
        model = _client()
        resp = model.generate_content([sys, user])
        text = resp.text or ""
        # Try to parse JSON; if it isn't pure JSON, try to find a JSON block
        try:
            data = json.loads(text)
        except Exception:
            start = text.find("{")
            end = text.rfind("}")
            data = json.loads(text[start:end+1])

        opp = _safe_take(str(data.get("opponent_comment", "")).strip())
        you = _safe_take(str(data.get("your_comment", "")).strip())

        return {"opponent_comment": opp, "your_comment": you}
    except Exception:
        # Fallback: empty => caller retains previous comments
        return {"opponent_comment": "", "your_comment": ""}
