# Cloudflare Tunnel Setup — Host the OTA Server From Your Home PC

This guide walks you through hosting the WALOK OTA Update Server on your home
Windows PC instead of an RDP server, using **Cloudflare Tunnel**.

**Why Cloudflare Tunnel?**
- Works behind PLDT's CGNAT (no public IP needed)
- No port forwarding on PLDT modem or Mikrotik
- Free HTTPS — no certificate setup
- Stable URL that never changes — your installed launchers keep working forever
- Free forever, no bandwidth or connection limits
- Total cost: ~$10/year for a domain name

**Time required:** ~15–20 minutes for first-time setup.

---

## What you need before you start

1. **A Windows PC** that will run the OTA server 24/7 (or whenever your customers need updates).
2. **A domain name.** Buy one from any registrar — [Namecheap](https://www.namecheap.com), [Porkbun](https://porkbun.com), or Cloudflare itself. Cheap `.com` domains are ~$10/year. `.xyz` or `.online` can be ~$2/year.
3. **A free Cloudflare account.** Sign up at https://dash.cloudflare.com/sign-up.
4. **Your OTA server already running** on the PC at `http://localhost:5000` (or whatever port you use). Confirm by opening that URL in your PC's browser — you should see the admin login.

---

## Step 1 — Add your domain to Cloudflare

1. Log in to https://dash.cloudflare.com.
2. Click **"Add a site"** (top of the dashboard).
3. Type your domain (e.g. `mybusiness.com`) and click **Continue**.
4. Pick the **Free** plan and click Continue.
5. Cloudflare will scan your existing DNS records — just click **Continue** to import them.
6. Cloudflare will show you **two nameservers** that look like:
   ```
   anna.ns.cloudflare.com
   bob.ns.cloudflare.com
   ```
7. **Go to your domain registrar** (where you bought the domain — Namecheap, Porkbun, etc.) and replace your domain's nameservers with the two Cloudflare gave you. Each registrar has a slightly different UI:
   - **Namecheap:** Domain List → Manage → Nameservers → "Custom DNS" → paste both → ✓
   - **Porkbun:** Domain → Authoritative Nameservers → paste both → Save
   - **GoDaddy:** My Domains → DNS → Nameservers → "I'll use my own" → paste both → Save
8. **Wait for nameserver propagation.** Cloudflare will email you when it's done. This can take anywhere from 5 minutes to 24 hours, but is usually under an hour. You can check progress on the Cloudflare dashboard — when the site shows a green "Active" badge, you're ready.

> **Tip:** Don't proceed to Step 2 until the site shows "Active" in Cloudflare. If you try to create a tunnel before nameservers propagate, the public URL will return errors.

---

## Step 2 — Create a Cloudflare Tunnel from the dashboard

1. From the Cloudflare dashboard, in the left sidebar click **Zero Trust**. (First time you do this, it'll ask you to pick a team name — anything you want, doesn't matter, free plan).
2. In the Zero Trust dashboard, go to **Networks → Tunnels**.
3. Click **Create a tunnel**.
4. Choose **Cloudflared** as the connector type → **Next**.
5. Name your tunnel something memorable like `walok-ota-pc` → **Save tunnel**.
6. The next screen will show a command for your environment. **Pick "Windows"** and copy the entire command — it looks like this:
   ```
   cloudflared.exe service install eyJhIjoi....(very long token)....
   ```
   **Save this command somewhere safe** — you'll paste it in the next step.

Keep this browser tab open — you'll come back to it in Step 4.

---

## Step 3 — Install cloudflared on your Windows PC

1. **Download `cloudflared` for Windows** from:
   https://github.com/cloudflare/cloudflared/releases/latest

   Download the file named `cloudflared-windows-amd64.exe` (or `cloudflared-windows-386.exe` if you're on 32-bit Windows, which is rare).

2. **Rename** the downloaded file to just `cloudflared.exe`.

3. **Move it to a permanent location**, for example:
   ```
   C:\cloudflared\cloudflared.exe
   ```
   (Create the `C:\cloudflared` folder if it doesn't exist.)

4. **Open Windows Terminal or PowerShell as Administrator**:
   - Press Start → type `powershell` → right-click → **Run as administrator**.

5. **Navigate to the folder** where you put `cloudflared.exe`:
   ```powershell
   cd C:\cloudflared
   ```

6. **Paste and run the install command** you copied at the end of Step 2. It will look like:
   ```powershell
   .\cloudflared.exe service install eyJhIjoi...your-long-token-here...
   ```

   Press Enter. You should see:
   ```
   2026/05/01 INF Using Systemd
   2026/05/01 INF Successfully installed cloudflared service
   ```

This installs `cloudflared` as a **Windows Service** that starts automatically when your PC boots — you don't need to manually run anything.

7. **Verify it's running.** Back in the PowerShell window:
   ```powershell
   Get-Service cloudflared
   ```
   Status should be **Running**.

8. **Switch back to the Cloudflare browser tab** (the tunnel creation page from Step 2). Within ~30 seconds, the page should show **1 connector** with a green "Connected" status. Click **Next**.

---

## Step 4 — Point a public URL at your OTA server

Now you tell the tunnel: "when someone visits `ota.mybusiness.com`, send them to `http://localhost:5000` on the PC."

In the Cloudflare tunnel setup page (still on the next screen after Step 3):

1. **Public hostname tab → Add a public hostname.**
2. Fill in:
   - **Subdomain:** `ota` (or whatever you want — `updates`, `walok`, etc.)
   - **Domain:** select your domain from the dropdown (e.g. `mybusiness.com`)
   - **Path:** *leave empty*
   - **Type:** `HTTP`
   - **URL:** `localhost:5000`

   The full URL where customers will reach your server is therefore:
   `https://ota.mybusiness.com`

3. Click **Save hostname**.

That's it. Open `https://ota.mybusiness.com/admin/` in any browser anywhere in the world — you should see the OTA admin login.

> **Why "HTTP" not "HTTPS" in the URL?** The tunnel encrypts the connection between Cloudflare and your customers automatically (that's where the `https://` comes from). Inside the tunnel, between Cloudflare and your PC, the connection goes over the encrypted tunnel itself — so plain HTTP to localhost is correct. Don't try to use HTTPS to localhost or it will fail.

---

## Step 5 — Update your customers' Update Server URLs

Each customer's launcher has a baked-in URL pointing at their update server. You need to switch this to your new public Cloudflare URL.

**For new customers (going forward):**
1. Open the OTA admin panel: `https://ota.mybusiness.com/admin/`
2. When you create or edit a customer, set **Update Server URL** to:
   ```
   https://ota.mybusiness.com
   ```
   (NOT `http://localhost:5000` — customers' PCs aren't on your network!)
3. Build and ship the launcher as usual.

**For customers who already have launchers installed pointing at the old RDP server:**
1. In the admin panel, edit each customer and change **Update Server URL** to `https://ota.mybusiness.com`.
2. Click **Build** to publish a new version.
3. The next time their launcher polls the OLD server, it'll download the new version which now contains the NEW URL. From that point on, all future updates flow through the Cloudflare tunnel.
4. Once you've confirmed all customers have migrated to the new URL, you can shut down the old RDP server.

> **Important:** If the old RDP server is already offline (so customers can't get the migration update), you'll need to manually push the new launcher to each customer (USB stick, email a zip, etc.). Plan the migration before turning off the old server.

---

## Step 6 — Confirm everything works

From any device that is **NOT on your home network** (e.g. your phone on mobile data, not WiFi):

1. Open `https://ota.mybusiness.com/admin/` in a browser → you should see the admin login.
2. Log in with your admin password → you should see the customers list.
3. From a separate test PC, install one of your launchers and confirm it polls for and receives updates over the tunnel.

---

## Troubleshooting

### "Site can't be reached" on `https://ota.mybusiness.com`

- Cloudflare nameservers haven't finished propagating yet. Wait and retry.
- Verify the cloudflared service is running on your PC:
  `Get-Service cloudflared` → should be "Running".
- In the Cloudflare Zero Trust dashboard → Networks → Tunnels, your tunnel should show **Healthy** and at least 1 connector.

### "Bad Gateway" or "Error 502" on `https://ota.mybusiness.com`

- Your OTA server isn't actually running on `localhost:5000` on the PC.
  Open `http://localhost:5000` in the PC's own browser to confirm. If it doesn't work, start the OTA server first.
- The hostname configuration in Step 4 is pointing to the wrong port. Edit the hostname in the Cloudflare dashboard and fix the URL.

### "Error 1033" or "Tunnel Not Found"

- The tunnel was deleted but the cloudflared service is still trying to connect. Re-run the install command from Step 2 with a fresh tunnel.

### After a Windows reboot, customers can't reach the server

- Confirm the cloudflared service is set to start automatically:
  ```powershell
  Get-Service cloudflared | Set-Service -StartupType Automatic
  ```
- Confirm your OTA server (start.bat) is also set to auto-start. If you launch it manually, the tunnel will be up but the server behind it won't be — customers see 502s.

### My launchers still hit the old RDP IP after I changed it

- Each launcher has the OLD URL baked into its files from when it was built. Changing the customer's URL in the admin panel only affects FUTURE builds. You need to **rebuild and republish** for each customer (Build button) so the next OTA update carries the new URL.

---

## Optional hardening

These are nice-to-haves, not required:

- **Restrict admin panel access by country** (e.g. Philippines only):
  Cloudflare dashboard → your domain → Security → WAF → Custom rules → "Block if `Country` not equal to `Philippines` AND URI path contains `/admin/`".
- **Add Cloudflare Access** (free for up to 50 users) to require Google/email login on the `/admin/` route, on top of your existing password.
- **Pin your public IP** at the registrar's DNS (Cloudflare → DNS → Records) so the tunnel hostname can never accidentally resolve elsewhere if you ever uninstall cloudflared.

---

## Summary — Your new architecture

```
┌──────────────────┐
│  Customer PC     │ →  https://ota.mybusiness.com/updates/...
│  (launcher.exe)  │
└──────────────────┘
         │
         ▼  (HTTPS, public internet)
┌──────────────────┐
│  Cloudflare edge │  (handles HTTPS, DDoS, caching, country-blocking)
└──────────────────┘
         │
         ▼  (encrypted outbound tunnel — no port forward)
┌──────────────────┐
│  Your home PC    │
│  ├─ cloudflared  │  ← Windows service, auto-start
│  └─ OTA server   │  ← localhost:5000
└──────────────────┘
         │
         ▼
┌──────────────────┐
│  Mikrotik        │  ← no special config needed
└──────────────────┘
         │
         ▼
┌──────────────────┐
│  PLDT modem      │  ← no port forward needed; CGNAT is fine
└──────────────────┘
```

No port forwarding. No bridge mode. No dynamic DNS. No self-signed certificates. Just two services running on your PC and one DNS record at Cloudflare.
