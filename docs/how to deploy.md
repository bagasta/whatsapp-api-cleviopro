# How to Deploy (PM2 + Nginx)

This playbook targets an Ubuntu-like environment with Node.js, PM2 for process management, and Nginx as a reverse proxy. Adapt paths and domains to your infrastructure.

## 1. Prerequisites

- Node.js 20+
- Git (or CI pipeline) access to the repository
- PostgreSQL instance reachable by the app server
- PM2 (`npm install -g pm2`)
- Nginx (`sudo apt install nginx`)
- A domain pointed at the server (e.g., `api.example.com`)

## 2. Fetch the Application

```bash
cd /var/www
sudo git clone <your-repo-url> whatsapp_api_cleviopro
sudo chown -R $USER:$USER whatsapp_api_cleviopro
cd whatsapp_api_cleviopro
npm install --production
```

Copy `.env.example` to `.env` and populate production values:

- `NODE_ENV=production`
- `PORT=3000` (or another free port)
- `APP_BASE_URL=https://api.example.com`
- `DATABASE_URL=postgres://...`
- Optional: `AI_BACKEND_URL`, `DEFAULT_OPENAI_API_KEY`, tuning knobs

## 3. Start with PM2

Launch the service under PM2 with a friendly name and production environment variables:

```bash
pm2 start src/server.js \
  --name whatsapp-api \
  --cwd /var/www/whatsapp_api_cleviopro \
  --interpreter node \
  --env production
```

- `.env` is loaded automatically by `dotenv`; ensure the file lives in the project root.
- Confirm the status: `pm2 status whatsapp-api`

Persist the process across reboots:

```bash
pm2 save
pm2 startup systemd
# follow the command PM2 prints (run with sudo), then rerun pm2 save
```

To tail logs use `pm2 logs whatsapp-api` or view structured history with `pm2 flush`/`pm2 reloadLogs` as needed.

## 4. Configure Nginx Reverse Proxy

Create a new server block (e.g., `/etc/nginx/sites-available/whatsapp-api`):

```nginx
server {
    listen 80;
    server_name api.example.com;

    client_max_body_size 20m;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

Enable the site and reload Nginx:

```bash
sudo ln -s /etc/nginx/sites-available/whatsapp-api /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

## 5. Add HTTPS with Certbot

Certbot integrates with Nginx to request and renew TLS certificates from Let's Encrypt.

1. Install Certbot (Snap is recommended on modern Ubuntu):
   ```bash
   sudo snap install core
   sudo snap refresh core
   sudo snap install --classic certbot
   sudo ln -s /snap/bin/certbot /usr/bin/certbot
   ```
2. Request and install the certificate (replace the domain as needed):
   ```bash
   sudo certbot --nginx -d api.example.com
   ```
   - Certbot updates the Nginx server block to listen on 443 with SSL directives.
   - Choose redirect when prompted so HTTP traffic is forwarded to HTTPS.
3. Verify automatic renewal:
   ```bash
   sudo certbot renew --dry-run
   ```
   Certbot sets up a systemd timer that runs twice per day. No manual cron work is required.

## 6. Verify Deployment

1. Hit `https://api.example.com/health` to confirm the health endpoint responds.
2. Create a session via `POST /sessions` and verify the returned `endpointUrl` references the HTTPS domain.
3. Check PM2 logs for connection status updates and ensure QR scans complete without errors.
4. Confirm WhatsApp messages reach your AI backend and replies are delivered.

## 7. Maintenance Tips

- Refresh code with `git pull` followed by `pm2 reload whatsapp-api`.
- After modifying the environment file, run `pm2 restart whatsapp-api` to pick up changes.
- Monitor disk usage for `temp` and WhatsApp cache directories; prune old files if the server is disk-constrained.
- Keep PM2, Node.js, Certbot, and system packages up to date using your standard patching cadence.
