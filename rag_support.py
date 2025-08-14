# rag_support.py
# minimal LlamaIndex setup for SenseiBoard
from __future__ import annotations

import json
from pathlib import Path
from typing import List, Dict, Any

from llama_index.core import VectorStoreIndex, Document, StorageContext, Settings
from llama_index.embeddings.huggingface import HuggingFaceEmbedding

# ------------- configure a small, fast embedding model -------------
# all-MiniLM-L6-v2 is tiny and good enough for our short cards.
Settings.embed_model = HuggingFaceEmbedding(model_name="sentence-transformers/all-MiniLM-L6-v2")

_INDEX = None
_CARDS: Dict[str, Dict[str, Any]] = {}  # id -> card

def _load_cards(corpus_dir: str = "corpus/motifs") -> List[Dict[str, Any]]:
    cards: List[Dict[str, Any]] = []
    p = Path(corpus_dir)
    if not p.exists():
        return cards
    for jf in sorted(p.glob("*.json")):
        with jf.open("r", encoding="utf-8") as f:
            card = json.load(f)
            cards.append(card)
    return cards

def _card_to_text(card: Dict[str, Any]) -> str:
    """Text we embed: name + explain + tags + recognition tokens."""
    parts = [
        card.get("name", ""),
        card.get("explain", ""),
        "tags: " + " ".join(card.get("tags", [])),
        "recognition: " + " ".join(card.get("recognition", [])),
        "type: " + card.get("type", ""),
        "phase: " + card.get("phase", "")
    ]
    return "\n".join(parts)

def init_index(corpus_dir: str = "corpus/motifs") -> None:
    """Build a small vector index once."""
    global _INDEX, _CARDS
    cards = _load_cards(corpus_dir)
    _CARDS = {c["id"]: c for c in cards}
    docs = [
        Document(
            text=_card_to_text(c),
            metadata={"id": c["id"], "name": c["name"], "type": c["type"], "phase": c.get("phase", "")}
        )
        for c in cards
    ]
    if not docs:
        _INDEX = None
        return
    _INDEX = VectorStoreIndex.from_documents(docs)

def has_index() -> bool:
    return _INDEX is not None

def retrieve_motifs(feature_tokens: List[str], top_k: int = 5) -> List[Dict[str, Any]]:
    """
    Simple retrieval:
      - Compose a short query string from feature tokens (e.g., ['opponent_queen_on_h5_or_h4','our_king_castled_short'])
      - Dense retrieve top_k
      - Post-filter by recognition subset (all required cues present)
      - Return up to 2 cards
    """
    if _INDEX is None:
        return []

    query = " ".join(feature_tokens)
    retriever = _INDEX.as_retriever(similarity_top_k=top_k)
    nodes = retriever.retrieve(query)
    # sort by score descending (higher = better)
    nodes = sorted(nodes, key=lambda n: n.score or 0.0, reverse=True)

    feats = set(feature_tokens)
    results: List[Dict[str, Any]] = []
    for n in nodes:
        cid = n.metadata.get("id")
        card = _CARDS.get(cid)
        if not card:
            continue
        cues = set(card.get("recognition", []))
        # if card has cues, require they are contained in our features (simple guardrail)
        if cues and not cues.issubset(feats):
            continue
        results.append(card)
        if len(results) >= 2:
            break
    return results

def format_comments_from_cards(cards: List[Dict[str, Any]], last_move_san: str | None) -> Dict[str, str]:
    """
    Deterministic, short text (no LLM needed yet):
    - Opponent comment: name + 1-line explain
    - Your comment: 1-line reply
    """
    if not cards:
        return {
            "opponent_comment": None,
            "your_comment": None
        }
    c = cards[0]
    opp = (last_move_san + " — ") if last_move_san else ""
    opp += f"{c['name']}: {c['explain']}"
    you = c["reply"]
    return {"opponent_comment": opp, "your_comment": you}
