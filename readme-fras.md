# cline2api-workers — Catatan Deploy Frasnym

Fork dari `pingmike2/cline2api-workers`. Isi repo sama, file ini merangkum
setup yang sudah terbukti jalan: Cloudflare Workers (utama) + Vercel
(cadangan) + OmniRoute sebagai klien.

## Arsitektur

```
klien →(key OmniRoute)→ OmniRoute →(API_KEY)→ workers.dev (utama)
                                        └────→ vercel.app (failover)
```

- Satu `API_KEY` buatan sendiri mengunci Worker. Bukan dari Cline.
- N akun Cline (via `CLINE_REFRESH_TOKEN` multiline) berputar di belakangnya.
- OmniRoute failover otomatis CF → Vercel.

## 1. Ambil refreshToken

```bash
python3 cline_oauth.py
# buka link device di browser, login + authorize
```

- Error `400` saat polling = normal, artinya "belum authorize" (`authorization_pending`).
- Authorize dengan cepat, device code kedaluwarsa dalam hitungan menit.
- macOS + `SSL: CERTIFICATE_VERIFY_FAILED`:
  ```bash
  open "/Applications/Python 3.11/Install Certificates.command"
  ```

## 2. Deploy Cloudflare Workers (utama)

Dashboard uploader **tidak bisa** (error "require a build process").
Pakai wrangler CLI dari folder ini:

```bash
npm i -g wrangler        # butuh Node 18+, sekali saja
wrangler login
wrangler deploy
wrangler secret put CLINE_REFRESH_TOKEN   # paste token, Enter, Ctrl+D
wrangler secret put API_KEY               # isi key buatanmu, CATAT!
```

`secret put` otomatis redeploy. Jangan tulis token di `wrangler.toml`.

Verifikasi:

```bash
curl https://cline2api.<subdomain>.workers.dev/v1/health
# {"ok":true,...,"accounts":N}  ← N harus = jumlah token
```

## 3. Deploy Vercel (cadangan)

```bash
npm i -g vercel
vercel login
vercel link              # Framework Preset: Other
vercel env add CLINE_REFRESH_TOKEN production
vercel env add API_KEY production        # SAMA dengan di Worker
vercel --prod
```

Wajib:

- **Settings → Deployment Protection → matikan Vercel Authentication**,
  kalau tidak domain publik kena redirect SSO.
- Tiap ubah env → `vercel --prod` ulang (tidak auto-redeploy).
- `vercel env add` hanya untuk value baru. Kalau variabel sudah ada:
  `vercel env rm <NAMA> production` dulu. Atau edit via dashboard
  (Settings → Environment Variables, textarea dukung multiline) → Redeploy.

## 4. Multi-akun

Satu token per baris, newline asli. Cara paling aman via file:

```bash
cat > /tmp/cline-tokens.txt <<'EOF'
token-akun-1
token-akun-2
EOF
wrangler secret put CLINE_REFRESH_TOKEN < /tmp/cline-tokens.txt
# atau: vercel env add CLINE_REFRESH_TOKEN production < /tmp/cline-tokens.txt
rm /tmp/cline-tokens.txt
```

- `API_KEY` tetap satu, tidak per akun.
- Kalau `/v1/health` tetap `accounts: 1` padahal isi 4 → newline tidak asli
  (paste jadi satu baris / `\n` literal). Ulangi via file di atas.
- Habis ubah secret di dashboard CF tanpa CLI → Deploy ulang manual.

Mekanisme rotasi (di `worker.js`): `ACCOUNT_STRATEGY` (default `round-robin`;
opsi `random` / `fill-first`) → accessToken di-cache per akun → antrean serial
+ jeda 800ms → 429/respons kosong/401 = cooldown akun itu (durasi 429 di-parse
dari pesan upstream, mis. `Try again in 2h 51m`) + request dicoba ulang di akun
berikutnya. Semua akun cooldown → kembalikan respons upstream apa adanya.
`/v1/health` juga melaporkan `strategy` yang sedang dipakai.

## 5. OmniRoute

Butuh OmniRoute **v3.8.14+** untuk custom header per provider.

Node 1 (utama) — type `openai-compatible`:

- Base URL: `https://cline2api.<subdomain>.workers.dev/v1`
- API Key: `API_KEY` Worker (sama persis!)
- Custom headers:
  ```json
  {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
  }
  ```
- Model: ambil dari `GET /v1/models` (Cline sering mengganti daftar model gratis).
  Saat ini default worker: `cline-free/nemotron-3.5-super-vl`.
  Model gratis lama (mis. `cline-free/deepseek-v4.1-flash`) sudah dihapus
  upstream, jadi jangan hardcode — selalu cek `/v1/models` dulu.

Node 2 (failover) — sama, tapi Base URL Vercel
(`https://<project>.vercel.app/v1`), custom header opsional.

Tes header terkirim: curl langsung ke workers.dev pakai UA `curl/...`
harusnya kena `1010`; request yang sama via OmniRoute harus `200`.

Tes end-to-end:

```bash
MODEL=$(curl -fsS https://cline2api.<subdomain>.workers.dev/v1/models \
  | grep -o '"id":"cline-free/[^"]*"' | head -1 | sed 's/.*"cline-free\/\([^"]*\)".*/cline-free\/\1/')
curl http://localhost:20128/v1/chat/completions \
  -H "Authorization: Bearer <key-omniroute>" \
  -H "Content-Type: application/json" \
  -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"Reply with OK\"}]}"
```

## 6. Catatan keamanan

- refreshToken = password. Hanya di secret (CF/Vercel), jangan di repo,
  chat log, atau `wrangler.toml`.
- Tidak ada tombol revoke resmi di Cline. Kalau bocor: cabut dari secret +
  redeploy, sign out semua perangkat, cabut OAuth di Google/GitHub, ganti
  password. Peringan: Cline memutar refreshToken tiap dipakai, salinan lama
  biasanya mati sendiri — tapi jangan diandalkan.
- Jangan kirim `max_tokens` ke model gratis (upstream me-500-kan).
  Worker sudah membuang field itu otomatis (sejak v1.1.8, masih berlaku di v1.3.0).
- Region Vercel di-hardcode US (`api/index.js`) — latency lebih tinggi,
  wajar untuk cadangan.
