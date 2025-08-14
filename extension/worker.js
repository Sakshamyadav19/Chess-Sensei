// worker.js — extension background fetch proxy

const API = "http://127.0.0.1:8000/api/analyze"; // try 127.0.0.1 (often happier than 'localhost')

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === "sensei.analyze") {
    (async () => {
      try {
        const res = await fetch(API, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(msg.payload),
        });
        const data = await res.json().catch(() => ({}));
        sendResponse({ ok: res.ok, data, status: res.status });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true; // keep the message channel open for async response
  }
});
