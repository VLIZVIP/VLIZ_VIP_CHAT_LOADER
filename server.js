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
const memoryBlocked = new Set();
let memoryId = 1;
let memoryMediaId = 1;
const supportToken = process.env.SUPPORT_TOKEN || "vliz-support";
const adminToken = process.env.ADMIN_TOKEN || supportToken;
const vendorToken = process.env.VENDOR_TOKEN || "vliz-vendedor";

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

function isSupportAdmin(req) {
  const token = cleanText(req.query.token || req.headers["x-support-token"], 128);
  return token && (token === supportToken || token === adminToken);
}

function supportRole(req) {
  const token = cleanText(req.query.token || req.headers["x-support-token"], 128);
  if (token && (token === supportToken || token === adminToken)) return "admin";
  if (token && token === vendorToken) return "vendedor";
  return "";
}

function canUseSupportPanel(req) {
  return supportRole(req) !== "";
}

function isSupportAuthor(author) {
  return cleanText(author, 48) === "VLIZ Support";
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
    create table if not exists chat_blocks (
      client_id text primary key,
      blocked_at timestamptz not null default now()
    );
    alter table chat_messages add column if not exists message_type text not null default 'text';
    alter table chat_messages add column if not exists media_id bigint;
    create index if not exists chat_messages_channel_id_idx
      on chat_messages (channel, id desc);
  `);
}

app.get("/health", (_req, res) => {
  res.json({ ok: true, version: "public-chat-blocks-1", storage: pool ? "postgres" : "memory" });
});

async function isBlockedClient(clientId) {
  const id = cleanText(clientId, 128);
  if (!id) return false;
  if (pool) {
    const result = await pool.query("select 1 from chat_blocks where client_id = $1 limit 1", [id]);
    return result.rowCount > 0;
  }
  return memoryBlocked.has(id);
}

app.get("/history.tsv", async (req, res, next) => {
  try {
    const channel = cleanChannel(req.query.channel);
    const clientId = cleanText(req.query.client_id, 128);
    const supportAdmin = isSupportAdmin(req);
    const limit = Math.min(Math.max(Number(req.query.limit || 200), 1), 500);
    let rows;

    if (channel === "support" && !clientId && !supportAdmin) {
      res.type("text/tab-separated-values").send("");
      return;
    }

    if (pool) {
      const privateSupport = channel === "support" && clientId && !supportAdmin;
      const result = privateSupport
        ? await pool.query(
            `select id, channel, author, client_id, text, message_type, media_id, created_at
             from chat_messages
             where channel = $1 and client_id = $2
             order by id desc
             limit $3`,
            [channel, clientId, limit],
          )
        : await pool.query(
            `select id, channel, author, client_id, text, message_type, media_id, created_at
             from chat_messages
             where channel = $1
             order by id desc
             limit $2`,
            [channel, limit],
          );
      rows = result.rows.reverse();
    } else {
      rows = memoryMessages
        .filter((message) => message.channel === channel && (channel !== "support" || supportAdmin || message.client_id === clientId))
        .slice(-limit);
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

app.get("/support/clients", async (req, res, next) => {
  try {
    const role = supportRole(req);
    if (!role) {
      res.status(401).json({ ok: false, error: "invalid_support_token" });
      return;
    }

    let rows;
    if (pool) {
      const result = await pool.query(`
        select
          m.client_id,
          coalesce(max(m.author) filter (where m.author <> 'VLIZ Support'), max(m.author)) as author,
          max(m.created_at) as last_at,
          count(*)::int as messages,
          (b.client_id is not null) as blocked
        from chat_messages m
        left join chat_blocks b on b.client_id = m.client_id
        where m.channel = 'support' and m.client_id <> ''
        group by m.client_id, b.client_id
        order by last_at desc
        limit 200
      `);
      rows = result.rows;
    } else {
      const map = new Map();
      for (const message of memoryMessages) {
        if (message.channel !== "support" || !message.client_id) continue;
        const previous = map.get(message.client_id);
        const author = message.author === "VLIZ Support" && previous ? previous.author : message.author;
        if (!previous || new Date(message.created_at) > new Date(previous.last_at)) {
          map.set(message.client_id, {
            client_id: message.client_id,
            author,
            last_at: message.created_at,
            messages: (previous?.messages || 0) + 1,
            blocked: memoryBlocked.has(message.client_id),
          });
        } else {
          previous.messages += 1;
          previous.blocked = memoryBlocked.has(message.client_id);
        }
      }
      rows = Array.from(map.values()).sort((a, b) => new Date(b.last_at) - new Date(a.last_at));
    }

    res.json({ ok: true, role, clients: rows });
  } catch (error) {
    next(error);
  }
});

app.post("/support/delete-all", async (req, res, next) => {
  try {
    if (!isSupportAdmin(req)) {
      res.status(403).json({ ok: false, error: "admin_required" });
      return;
    }

    if (pool) {
      await pool.query("truncate table chat_messages, chat_media, chat_blocks restart identity");
    } else {
      memoryMessages.length = 0;
      memoryMedia.clear();
      memoryBlocked.clear();
      memoryId = 1;
      memoryMediaId = 1;
    }

    res.json({ ok: true, deleted: true });
  } catch (error) {
    next(error);
  }
});

app.get("/support/blocked", async (req, res, next) => {
  try {
    const role = supportRole(req);
    if (!role) {
      res.status(401).json({ ok: false, error: "invalid_support_token" });
      return;
    }

    let blocked;
    if (pool) {
      const result = await pool.query("select client_id, blocked_at from chat_blocks order by blocked_at desc limit 500");
      blocked = result.rows;
    } else {
      blocked = Array.from(memoryBlocked).map((client_id) => ({ client_id, blocked_at: "" }));
    }
    res.json({ ok: true, role, blocked });
  } catch (error) {
    next(error);
  }
});

app.post("/support/block", async (req, res, next) => {
  try {
    const role = supportRole(req);
    if (!role) {
      res.status(401).json({ ok: false, error: "invalid_support_token" });
      return;
    }

    const clientId = cleanText(req.body.client_id || req.query.client_id, 128);
    if (!clientId || clientId === "support-public") {
      res.status(400).json({ ok: false, error: "invalid_client" });
      return;
    }

    if (pool) {
      await pool.query(
        `insert into chat_blocks (client_id) values ($1)
         on conflict (client_id) do update set blocked_at = now()`,
        [clientId],
      );
    } else {
      memoryBlocked.add(clientId);
    }
    res.json({ ok: true, blocked: true, client_id: clientId });
  } catch (error) {
    next(error);
  }
});

app.post("/support/unblock", async (req, res, next) => {
  try {
    const role = supportRole(req);
    if (!role) {
      res.status(401).json({ ok: false, error: "invalid_support_token" });
      return;
    }

    const clientId = cleanText(req.body.client_id || req.query.client_id, 128);
    if (!clientId) {
      res.status(400).json({ ok: false, error: "invalid_client" });
      return;
    }

    if (pool) {
      await pool.query("delete from chat_blocks where client_id = $1", [clientId]);
    } else {
      memoryBlocked.delete(clientId);
    }
    res.json({ ok: true, blocked: false, client_id: clientId });
  } catch (error) {
    next(error);
  }
});

app.get("/support", (_req, res) => {
  res.type("html").send(`<!doctype html>
<html lang="es">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>VLIZ Support</title>
  <style>
    :root{color-scheme:dark;--bg:#08080a;--panel:#121216;--line:#3b2710;--red:#d81f34;--gold:#d8ad3b;--text:#f6f4ef;--muted:#a7a0a0}
    *{box-sizing:border-box} body{margin:0;background:radial-gradient(circle at 80% 0,#2a1015,transparent 42%),var(--bg);font-family:Inter,Segoe UI,Arial,sans-serif;color:var(--text)}
    .app{display:grid;grid-template-columns:290px 1fr;min-height:100vh}.side{border-right:1px solid var(--line);background:rgba(10,10,12,.9);padding:22px}.brand{font-weight:900;font-size:24px;color:var(--gold);letter-spacing:.04em}.sub{color:var(--muted);font-size:12px;margin:4px 0 18px}
    input,button{border:1px solid var(--line);border-radius:10px;background:#101014;color:var(--text);height:40px;padding:0 12px}button{background:linear-gradient(135deg,var(--red),#971827);font-weight:800;cursor:pointer}.ghost{background:#101014;border-color:var(--gold)}.danger{background:linear-gradient(135deg,#65121b,var(--red));display:none}.tabs{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}.tabs button.active{border-color:var(--gold);box-shadow:0 0 0 1px rgba(216,173,59,.25)}
    .clients{display:grid;gap:9px;margin-top:14px}.client{padding:12px;border:1px solid #2b2020;border-radius:12px;background:#111115;cursor:pointer}.client.active{border-color:var(--gold);box-shadow:0 0 0 1px rgba(216,173,59,.25)}
    .name{font-weight:800}.meta{color:var(--muted);font-size:12px;margin-top:4px}.chat{display:grid;grid-template-rows:auto 1fr auto;min-width:0}.top{height:72px;border-bottom:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding:0 24px}
    .messages{padding:22px;overflow:auto;display:flex;flex-direction:column;gap:12px}.msg{max-width:720px;border:1px solid #2a2020;border-radius:14px;padding:12px;background:#121216}.msg.support{align-self:flex-end;border-color:rgba(216,173,59,.55)}.msg img{max-width:280px;border-radius:10px;display:block;margin-top:8px}.mini{height:28px;padding:0 10px;font-size:11px;margin-top:8px}.blocked{color:var(--red);font-size:11px;font-weight:800}
    .composer{display:grid;grid-template-columns:1fr 120px;gap:12px;padding:18px 24px;border-top:1px solid var(--line);background:rgba(10,10,12,.84)}textarea{resize:none;height:70px;border:1px solid var(--line);border-radius:12px;background:#101014;color:var(--text);padding:12px}.emoji{grid-column:1/3;display:flex;gap:8px;flex-wrap:wrap}.emoji button{width:38px;height:34px;padding:0;background:#121216;border-color:rgba(216,173,59,.45);font-size:18px}
    .empty{color:var(--muted);text-align:center;margin:auto}.tag{color:var(--gold)}
  </style>
</head>
<body>
  <div class="app">
    <aside class="side">
      <div class="brand">VLIZ SUPPORT</div>
      <div class="sub">Panel privado de soporte Railway</div>
      <input id="token" placeholder="Token de soporte" style="width:100%">
      <button id="load" style="width:100%;margin-top:10px">Entrar</button>
      <div class="tabs"><button id="privateTab" class="ghost active">Privados</button><button id="publicTab" class="ghost">Publico</button></div>
      <button id="wipe" class="danger" style="width:100%;margin-top:10px">Eliminar todos los chats</button>
      <button id="block" class="ghost" style="width:100%;margin-top:10px;display:none">Bloquear usuario</button>
      <div id="clients" class="clients"></div>
    </aside>
    <main class="chat">
      <div class="top"><div><b id="title">Selecciona un cliente</b><div class="sub" id="status">Sin conversación activa</div></div><span class="tag" id="role">Sin rol</span></div>
      <div id="messages" class="messages"><div class="empty">Las conversaciones aparecerán aquí.</div></div>
      <div class="composer"><textarea id="text" placeholder="Responder al cliente"></textarea><button id="send">Enviar</button><div id="emoji" class="emoji"></div></div>
    </main>
  </div>
<script>
const $=id=>document.getElementById(id);let activeClient="";let activeRole="";let activeMode="private";let activeBlocked=false;
const emojiList=["❤","😍","😒","👌","😘","😊","😂","🤣","✌","🤞","😉","😎","🎶","😢","💖","😜","👏","✔","👀","😃"];
function token(){return $("token").value.trim()}
function esc(v){return String(v||"").replace(/[&<>"]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;"}[c]))}
function parseTsv(t){return t.trim()?t.trim().split("\\n").map(l=>l.split("\\t")):[]}
function renderEmojis(){$("emoji").innerHTML=emojiList.map(e=>'<button type="button" onclick="addEmoji(\\''+e+'\\')">'+e+'</button>').join("")}
function addEmoji(e){$("text").value+=e;$("text").focus()}
async function loadClients(){const r=await fetch("/support/clients?token="+encodeURIComponent(token()));const j=await r.json();if(!j.ok){alert("Token incorrecto");return}activeRole=j.role||"";$("role").textContent=activeRole?activeRole.toUpperCase():"Sin rol";$("wipe").style.display=activeRole==="admin"?"block":"none";$("clients").innerHTML=j.clients.map(c=>'<div class="client '+(c.client_id===activeClient?'active':'')+'" onclick="openClient(\\''+esc(c.client_id)+'\\')"><div class="name">'+esc(c.author||"Cliente")+'</div><div class="meta">'+esc(c.client_id)+' · '+c.messages+' mensajes</div></div>').join("")}
async function openClient(id){activeClient=id;$("title").textContent=id;$("status").textContent="Conversación privada";await loadClients();await loadMessages()}
async function loadMessages(){if(!activeClient)return;const r=await fetch("/history.tsv?channel=support&client_id="+encodeURIComponent(activeClient)+"&limit=300&token="+encodeURIComponent(token()));const rows=parseTsv(await r.text());$("messages").innerHTML=rows.map(p=>{const own=p[2]==="VLIZ Support";const media=p[7]?'<img src="'+esc(p[7])+'">':"";return '<div class="msg '+(own?'support':'')+'"><b>'+esc(p[2])+'</b> <span class="meta">'+esc(p[3])+'</span><div>'+esc(p[6])+'</div>'+media+'</div>'}).join("")||'<div class="empty">Sin mensajes.</div>';$("messages").scrollTop=$("messages").scrollHeight}
async function send(){if(!activeClient||!$("text").value.trim())return;const body=new URLSearchParams({channel:"support",author:"VLIZ Support",client_id:activeClient,type:"text",text:$("text").value.trim()});await fetch("/message",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});$("text").value="";await loadMessages();await loadClients()}
async function wipeAll(){if(activeRole!=="admin")return;const ok=confirm("Esto elimina TODOS los chats, imagenes y registros. ¿Continuar?");if(!ok)return;const r=await fetch("/support/delete-all?token="+encodeURIComponent(token()),{method:"POST"});const j=await r.json();if(j.ok){activeClient="";$("messages").innerHTML='<div class="empty">Chats eliminados.</div>';$("title").textContent="Selecciona un cliente";await loadClients()}else alert("No se pudo eliminar")}
function panelSetMode(mode){activeMode=mode;activeClient="";activeBlocked=false;$("privateTab").classList.toggle("active",mode==="private");$("publicTab").classList.toggle("active",mode==="public");$("block").style.display="none";$("clients").style.display=mode==="private"?"grid":"none";$("title").textContent=mode==="public"?"Chat publico":"Selecciona un cliente";$("status").textContent=mode==="public"?"Canal publico VLIZ VIP":"Sin conversacion activa";if(mode==="public")panelLoadMessages();else panelLoadClients()}
function panelBlockButton(){const show=activeMode==="private"&&activeClient;$("block").style.display=show?"block":"none";$("block").textContent=activeBlocked?"Desbloquear usuario":"Bloquear usuario";$("block").className=activeBlocked?"ghost":"danger";$("block").style.display=show?"block":"none"}
async function panelLoadClients(){const r=await fetch("/support/clients?token="+encodeURIComponent(token()));const j=await r.json();if(!j.ok){alert("Token incorrecto");return}activeRole=j.role||"";$("role").textContent=activeRole?activeRole.toUpperCase():"Sin rol";$("wipe").style.display=activeRole==="admin"?"block":"none";if(activeMode!=="private")return;$("clients").innerHTML=j.clients.map(c=>'<div class="client '+(c.client_id===activeClient?'active':'')+'" onclick="panelOpenClient(\\''+esc(c.client_id)+'\\','+(c.blocked?'true':'false')+')"><div class="name">'+esc(c.author||"Cliente")+(c.blocked?' <span class="blocked">BLOQUEADO</span>':'')+'</div><div class="meta">'+esc(c.client_id)+' · '+c.messages+' mensajes</div></div>').join("")}
async function panelOpenClient(id,blocked){activeMode="private";activeClient=id;activeBlocked=!!blocked;$("title").textContent=id;$("status").textContent=activeBlocked?"Conversacion privada bloqueada":"Conversacion privada";panelBlockButton();await panelLoadClients();await panelLoadMessages()}
function panelMessageHtml(p){const own=p[2]==="VLIZ Support";const media=p[7]?'<img src="'+esc(p[7])+'">':"";const block=p[4]&&p[4]!=="support-public"&&p[2]!=="VLIZ Support"?'<button class="mini ghost" onclick="panelBlockClient(\\''+esc(p[4])+'\\',true)">Bloquear</button>':"";return '<div class="msg '+(own?'support':'')+'"><b>'+esc(p[2])+'</b> <span class="meta">'+esc(p[3])+' · '+esc(p[4]||"")+'</span><div>'+esc(p[6])+'</div>'+media+block+'</div>'}
async function panelLoadMessages(){if(activeMode==="private"&&!activeClient)return;const channel=activeMode==="public"?"public":"support";const clientPart=activeMode==="private"?"&client_id="+encodeURIComponent(activeClient):"";const r=await fetch("/history.tsv?channel="+channel+clientPart+"&limit=300&token="+encodeURIComponent(token()));const rows=parseTsv(await r.text());$("messages").innerHTML=rows.map(panelMessageHtml).join("")||'<div class="empty">Sin mensajes.</div>';$("messages").scrollTop=$("messages").scrollHeight}
async function panelSend(){if(!$("text").value.trim())return;if(activeMode==="private"&&!activeClient)return;const channel=activeMode==="public"?"public":"support";const client=activeMode==="public"?"support-public":activeClient;const body=new URLSearchParams({channel,author:"VLIZ Support",client_id:client,type:"text",text:$("text").value.trim()});await fetch("/message",{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});$("text").value="";await panelLoadMessages();await panelLoadClients()}
async function panelBlockClient(id,fromPublic){const body=new URLSearchParams({client_id:id});const r=await fetch("/support/block?token="+encodeURIComponent(token()),{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});const j=await r.json();if(j.ok){if(!fromPublic){activeBlocked=true;panelBlockButton()}await panelLoadClients();await panelLoadMessages()}else alert("No se pudo bloquear")}
async function panelUnblockClient(id){const body=new URLSearchParams({client_id:id});const r=await fetch("/support/unblock?token="+encodeURIComponent(token()),{method:"POST",headers:{"Content-Type":"application/x-www-form-urlencoded"},body});const j=await r.json();if(j.ok){activeBlocked=false;panelBlockButton();await panelLoadClients();await panelLoadMessages()}else alert("No se pudo desbloquear")}
async function panelToggleBlock(){if(!activeClient)return;if(activeBlocked)await panelUnblockClient(activeClient);else await panelBlockClient(activeClient,false)}
async function panelWipeAll(){if(activeRole!=="admin")return;const ok=confirm("Esto elimina TODOS los chats, imagenes y registros. Continuar?");if(!ok)return;const r=await fetch("/support/delete-all?token="+encodeURIComponent(token()),{method:"POST"});const j=await r.json();if(j.ok){activeClient="";$("messages").innerHTML='<div class="empty">Chats eliminados.</div>';$("title").textContent=activeMode==="public"?"Chat publico":"Selecciona un cliente";await panelLoadClients()}else alert("No se pudo eliminar")}
$("load").onclick=()=>{panelLoadClients();if(activeMode==="public")panelLoadMessages()};$("send").onclick=panelSend;$("wipe").onclick=panelWipeAll;$("block").onclick=panelToggleBlock;$("privateTab").onclick=()=>panelSetMode("private");$("publicTab").onclick=()=>panelSetMode("public");renderEmojis();setInterval(()=>{if(activeMode==="public"||activeClient)panelLoadMessages();if(token())panelLoadClients()},5000);
</script>
</body>
</html>`);
});

app.post("/message", async (req, res, next) => {
  try {
    const channel = cleanChannel(req.body.channel);
    const author = cleanText(req.body.author, 48) || "Usuario";
    const clientId = cleanText(req.body.client_id, 128);
    const type = cleanMessageType(req.body.type);
    const hasMedia = type === "image" || type === "sticker";
    const text = cleanText(req.body.text, hasMedia ? 140 : 500);
    const mediaId = Number(req.body.media_id || 0) || null;

    if (!isSupportAuthor(author) && await isBlockedClient(clientId)) {
      res.status(403).json({ ok: false, error: "blocked_user" });
      return;
    }

    if (!text && !hasMedia) {
      res.status(400).json({ ok: false, error: "empty_message" });
      return;
    }
    if (hasMedia && !mediaId) {
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
