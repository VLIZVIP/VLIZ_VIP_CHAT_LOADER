# VLIZ Railway Chat

Backend para que el chat del loader comparta historial entre todos los usuarios.

## Railway

1. Crea un proyecto nuevo en Railway.
2. Agrega una base de datos PostgreSQL al proyecto.
3. Sube o conecta esta carpeta: `railway-chat`.
4. Railway crea `DATABASE_URL` automaticamente al conectar PostgreSQL.
5. Copia la URL publica del servicio, por ejemplo:

```text
https://vliz-chat-production.up.railway.app
```

6. Pegala en `framework/settings/app_config.h`:

```cpp
constexpr const char* chat_server_url = "https://vliz-chat-production.up.railway.app";
```

7. Recompila el loader.

## Endpoints

- `GET /health`: prueba si el servidor esta activo.
- `GET /history.tsv?channel=support&limit=200`: historial de un canal.
- `POST /message`: guarda mensaje con `channel`, `author`, `client_id` y `text`.

Canales usados por el loader:

- `support`
- `public`
