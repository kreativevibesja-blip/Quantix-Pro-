# Quantix Pro — Node.js Backend + Frontend

This adds a minimal Node.js backend (Express + ws) that:
- Serves the static frontend in this folder
- Manages Deriv WebSocket sessions per client (authorize with token)
- Exposes REST endpoints for buying/selling
- Streams market ticks via SSE

## Endpoints

- POST `/api/session` — create + authorize a session
  - Body: `{ "sessionId": "abc123", "token": "DERIV_TOKEN" }`
  - Returns: `{ ok: true, currency, loginid }`

- DELETE `/api/session?sessionId=abc123` — close session

- POST `/api/buy` — proxy a Deriv buy or proposal request
  - Body: `{ sessionId, request }`
  - `request` is a Deriv API request object (e.g. `{ proposal: 1, ... }` or `{ buy: id, price }`)

- POST `/api/sell` — `{ sessionId, contract_id }`

- GET `/api/ticks?sessionId=abc123&symbol=R_100` — Server-Sent Events (SSE) stream for ticks
  - Events: `history`, `tick`

## Local run

1. Install Node 18+
2. Install deps

```powershell
npm install
npm start
```

Browse http://localhost:3000

Optional env:
```
DERIV_APP_ID=<your_app_id>
PORT=3000
```

## Deploy to Render

1. Push this folder to a Git repo
2. In Render, create a new Web Service from the repo
3. Use `render.yaml` autodiscovery or set:
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Environment: Node
4. Add env var `DERIV_APP_ID` with your app id

The service will serve both the frontend and backend.

## Integrating frontend with backend (optional)

If you want the frontend to route all Deriv actions through the backend, you can:
- Replace direct `new WebSocket(wss://ws.derivws.com/...)` with calling `/api/session` then using SSE `/api/ticks`.
- Replace direct `ws.send({ proposal: ... })` with `fetch('/api/buy', { method: 'POST', body: { sessionId, request } })`.

This reduces browser CORS/CSP friction and keeps your token server-side.
