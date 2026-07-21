import express from "express";
import pg from "pg";

const { Pool } = pg;
const app = express();
const port = Number(process.env.PORT || 3000);
const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: process.env.PGSSLMODE === "disable" ? false : { rejectUnauthorized: false },
    })
  : null;

const memoryMessages = [];
let memoryId = 1;

app.use(express.urlencoded({ extended: false, limit: "16kb" }));
app.use(express.json({ limit: "16kb" }));

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "")
    .trim()
    .slice(0, maxLength);
}

function cleanChannel(value) {
  const channel = cleanText(value, 32).toLowerCase();
  return channel === "public" ? "public" : "support";
}

function escapeTsv(value) {
  return String(value || "")
    .replace(/\\/g, "\\\\")
    .replace(/\t/g, "\\t")
    .replace(/\r/g, "\\r")
    .replace(/\n/g, "\\n");
}

function timeFromDate(value) {
  const date = new Date(value);
  return date.toLocaleTimeString("en-US", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: process.env.CHAT_TIMEZONE || "America/Santo_Domingo",
  });
}

async function ensureSchema() {
  if (!pool) return;
  await pool.query(`
    create table if not exists chat_messages (
      id bigserial primary key,
      channel text not null,
      author text not null,
      client_id text not null default '',
      text text not null,
      created_at timestamptz not null default now()
    );
    create index if not exists chat_messages_channel_id_idx
      on chat_messages (channel, id desc);
  `);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, storage: pool ? "postgres" : "memory" });
});

app.get("/history.tsv", async (req, res, next) => {
  try {
    const channel = cleanChannel(req.query.channel);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
    let rows;

    if (pool) {
      const result = await pool.query(
        `select id, channel, author, client_id, text, created_at
         from chat_messages
         where channel = $1
         order by id desc
         limit $2`,
        [channel, limit],
      );
      rows = result.rows.reverse();
    } else {
      rows = memoryMessages.filter((message) => message.channel === channel).slice(-limit);
    }

    const body = rows
      .map((message) =>
        [
          message.id,
          message.channel,
          message.author,
          timeFromDate(message.created_at),
          message.client_id,
          message.text,
        ]
          .map(escapeTsv)
          .join("\t"),
      )
      .join("\n");

    res.type("text/tab-separated-values").send(body ? `${body}\n` : "");
  } catch (error) {
    next(error);
  }
});

app.post("/message", async (req, res, next) => {
  try {
    const channel = cleanChannel(req.body.channel);
    const author = cleanText(req.body.author, 48) || "Usuario";
    const clientId = cleanText(req.body.client_id, 128);
    const text = cleanText(req.body.text, 500);

    if (!text) {
      res.status(400).json({ ok: false, error: "empty_message" });
      return;
    }

    let saved;
    if (pool) {
      const result = await pool.query(
        `insert into chat_messages (channel, author, client_id, text)
         values ($1, $2, $3, $4)
         returning id, channel, author, client_id, text, created_at`,
        [channel, author, clientId, text],
      );
      saved = result.rows[0];
    } else {
      saved = {
        id: memoryId++,
        channel,
        author,
        client_id: clientId,
        text,
        created_at: new Date().toISOString(),
      };
      memoryMessages.push(saved);
      if (memoryMessages.length > 1000) memoryMessages.shift();
    }

    res.json({ ok: true, id: String(saved.id) });
  } catch (error) {
    next(error);
  }
});

app.use((error, _req, res, _next) => {
  console.error(error);
  res.status(500).json({ ok: false, error: "server_error" });
});

ensureSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`VLIZ chat server listening on ${port}`);
    });
  })
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
