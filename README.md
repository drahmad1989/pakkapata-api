# PakkaPata Address Verification API — v0.10.9

Public deployment artifact for the PakkaPata x RabtaChat ecosystem.
Runs on ClawCloud Run / any Node host. Database auto-restores at boot from a
private Hugging Face dataset (token required via `HF_TOKEN`).

- Health: `GET /api/health`
- RabtaChat contract: `POST /api/rabta/ping`, `GET /api/rabta/payments`, `POST /api/rabta/payments/confirm`
- Dual auth: `X-API-Key` header or `Bearer` token

## Environment variables
| Var | Purpose |
|-----|---------|
| PORT | listen port (default 3000) |
| NODE_ENV | production |
| DB_PATH | sqlite file path |
| HF_TOKEN | read token for private DB dataset |
| DB_REPO | huggingface dataset id |
| CNIC_AES_KEY / CNIC_HMAC_SECRET / JWT_SECRET | crypto + auth secrets |
