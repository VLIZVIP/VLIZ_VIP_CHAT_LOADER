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
const memoryMedia = new Map();
let memoryId = 1;
let memoryMediaId = 1;

app.use(express.urlencoded({ extended: false, limit: "8mb" }));
app.use(express.json({ limit: "8mb" }));

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

function cleanMessageType(value) {
  const type = cleanText(value, 16).toLowerCase();
  if (type === "image" || type === "sticker") return type;
  return "text";
}

function cleanMime(value) {
  const mime = cleanText(value, 64).toLowerCase();
  if (["image/png", "image/jpeg", "image/jpg", "image/bmp", "image/gif", "image/webp"].includes(mime)) {
    return mime === "image/jpg" ? "image/jpeg" : mime;
  }
  return "";
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
      message_type text not null default 'text',
      media_id bigint,
      created_at timestamptz not null default now()
    );
    create table if not exists chat_media (
      id bigserial primary key,
      mime text not null,
      data bytea not null,
      created_at timestamptz not null default now()
    );
    alter table chat_messages add column if not exists message_type text not null default 'text';
    alter table chat_messages add column if not exists media_id bigint;
    create index if not exists chat_messages_channel_id_idx
      on chat_messages (channel, id desc);
  `);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: "media-uploads-2", storage: pool ? "postgres" : "memory" });
});

app.get("/history.tsv", async (req, res, next) => {
  try {
    const channel = cleanChannel(req.query.channel);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
    let rows;

    if (pool) {
      const result = await pool.query(
        `select id, channel, author, client_id, text, message_type, media_id, created_at
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
          message.message_type || "text",
          message.text,
          message.media_id ? `/media/${message.media_id}` : "",
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
    const type = cleanMessageType(req.body.type);
    const text = cleanText(req.body.text, type === "image" ? 140 : 500);
    const mediaId = Number(req.body.media_id || 0) || null;

    if (!text && type !== "image") {
      res.status(400).json({ ok: false, error: "empty_message" });
      return;
    }
    if (type === "image" && !mediaId) {
      res.status(400).json({ ok: false, error: "missing_media" });
      return;
    }

    let saved;
    if (pool) {
      const result = await pool.query(
        `insert into chat_messages (channel, author, client_id, text, message_type, media_id)
         values ($1, $2, $3, $4, $5, $6)
         returning id, channel, author, client_id, text, message_type, media_id, created_at`,
        [channel, author, clientId, text, type, mediaId],
      );
      saved = result.rows[0];
    } else {
      saved = {
        id: memoryId++,
        channel,
        author,
        client_id: clientId,
        text,
        message_type: type,
        media_id: mediaId,
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

app.post("/upload-image", async (req, res, next) => {
  try {
    const mime = cleanMime(req.body.mime);
    const rawData = cleanText(req.body.data, 8 * 1024 * 1024);
    if (!mime || !rawData) {
      res.status(400).json({ ok: false, error: "invalid_image" });
      return;
    }

    const data = Buffer.from(rawData, "base64");
    if (data.length < 16 || data.length > 3 * 1024 * 1024) {
      res.status(400).json({ ok: false, error: "image_size" });
      return;
    }

    let id;
    if (pool) {
      const result = await pool.query(
        `insert into chat_media (mime, data)
         values ($1, $2)
         returning id`,
        [mime, data],
      );
      id = String(result.rows[0].id);
    } else {
      id = String(memoryMediaId++);
      memoryMedia.set(id, { mime, data });
    }

    res.json({ ok: true, id, url: `/media/${id}` });
  } catch (error) {
    next(error);
  }
});

app.get("/media/:id", async (req, res, next) => {
  try {
    const id = Number(req.params.id || 0);
    if (!id) {
      res.status(404).end();
      return;
    }

    let media;
    if (pool) {
      const result = await pool.query("select mime, data from chat_media where id = $1", [id]);
      media = result.rows[0];
    } else {
      media = memoryMedia.get(String(id));
    }

    if (!media) {
      res.status(404).end();
      return;
    }

    res.type(media.mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.send(media.data);
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
