# ♟️ SenseiBoard • Practice

![Extension Screenshot](./screenshots/1.png)

**SenseiBoard** is a Chrome extension overlay for [chess.com](https://www.chess.com) that automatically grabs the current chess position (FEN) from your active game and provides quick, LLM-powered analysis directly on the board.

## ✨ Features
- **Auto Grab Position** – One click to detect the current game state from your board.
- **Instant AI Analysis** – Explains threats and suggests your next move.
- **Overlay UI** – Displays analysis directly on the page without leaving the game.
- **Clean & Minimal** – No distracting options or settings — just play and learn.

## 📷 Preview
![Preview](./screenshots/2.png)  

## 🚀 Installation (Unpacked)
1. **Clone or Download** this repository.
2. Open **Google Chrome** and go to `chrome://extensions/`.
3. Enable **Developer Mode** (toggle in top right).
4. Click **Load unpacked** and select this project’s folder.
5. Open [chess.com](https://www.chess.com) or [lichess.org](https://lichess.org) and start a game.
6. Click the **Auto Grab** button in the overlay — analysis will appear instantly.

## 🛠 How It Works
- Injects a **content script** into supported chess websites.
- Automatically extracts the **FEN** (Forsyth–Edwards Notation) from the page.
- Sends the FEN to your analysis pipeline (LLM or engine).
- Displays the output inline with no page reload.
