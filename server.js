import express from "express";
import { createServer } from "node:http";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const app = express();
const PORT = 3000;
const MSG_FILE = "cli_messages.json";
let lastMsgId = 0;

function loadMessages() {
  if (!existsSync(MSG_FILE)) return { commands: [] };
  return JSON.parse(readFileSync(MSG_FILE, "utf8"));
}
function saveMessages(data) {
  writeFileSync(MSG_FILE, JSON.stringify(data, null, 2), "utf8");
}

app.use(express.json());
app.use(express.static("public"));

// Local AI upscaler model & library (avoid CDN dependency)
app.use(
  "/local-models",
  express.static(join(__dirname, "node_modules/@upscalerjs/default-model/models"), {
    setHeaders(res, path) {
      if (path.endsWith(".bin")) {
        res.set("Content-Type", "application/octet-stream");
      } else {
        res.set("Content-Type", "application/json");
      }
      res.set("Cache-Control", "public, max-age=31536000");
    },
  })
);
app.use(
  "/local-upscaler",
  express.static(join(__dirname, "node_modules/upscaler/dist/browser/umd"), {
    setHeaders(res) {
      res.set("Cache-Control", "public, max-age=31536000");
    },
  })
);
// Local TensorFlow.js
app.use(
  "/local-tfjs",
  express.static(join(__dirname, "node_modules/@tensorflow/tfjs/dist"), {
    setHeaders(res, path) {
      if (path.endsWith(".wasm")) {
        res.set("Content-Type", "application/wasm");
      }
      res.set("Cache-Control", "public, max-age=31536000");
    },
  })
);

app.post("/api/send", (req, res) => {
  const { text } = req.body;
  if (!text || text.trim() === "") return res.json({ ok: false, error: "empty" });
  const data = loadMessages();
  const id = Date.now();
  data.commands.push({ id, text: text.trim(), read: false, response: null });
  saveMessages(data);
  res.json({ ok: true, id });
});

app.get("/api/poll", (req, res) => {
  const data = loadMessages();
  const unseen = data.commands.filter((c) => !c.read);
  unseen.forEach((c) => (c.read = true));
  saveMessages(data);
  res.json(unseen);
});

app.get("/api/pending-response", (req, res) => {
  const data = loadMessages();
  const pending = data.commands.filter((c) => c.response && !c.response_sent);
  pending.forEach((c) => (c.response_sent = true));
  saveMessages(data);
  res.json(pending);
});

app.post("/api/respond", (req, res) => {
  const { id, response } = req.body;
  const data = loadMessages();
  const cmd = data.commands.find((c) => c.id === id);
  if (cmd) {
    cmd.response = response;
    cmd.response_sent = false;
    saveMessages(data);
  }
  res.json({ ok: true });
});

createServer(app).listen(PORT, () => {
  console.log(`位图转矢量图工具: http://localhost:${PORT}`);
});
