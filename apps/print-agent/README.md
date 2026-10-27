# Print agent (kitchen tickets)

A small Node program on the shop's Windows 11 notebook. It asks the POS server for tickets over
HTTPS (no inbound ports, nothing to open on the router) and sends each one to the Xprinter XP-80T
as raw ESC/POS — either directly over **USB** (`PRINTER_HOST=usb`) or over **LAN** (TCP port 9100).
Thai text is drawn as a picture, so tone marks and vowels print correctly.

## One-time setup

1. **Printer:**
   - **USB (recommended when plugged into the notebook):** plug the XP-80T into the notebook's USB port and switch it on. Windows automatically attaches `USB Printing Support` (`usbprint.sys`) — no extra driver is needed. Keep `PRINTER_HOST=usb` in `.env`.
   - **LAN (alternative):** connect the XP-80T to the router by LAN cable, give it a fixed IP in the router (for example `192.168.1.50`), and set `PRINTER_HOST=192.168.1.50`.
2. **Node.js:** install Node.js 24 or newer on the notebook from nodejs.org (Windows installer).
3. **Files & Device token:** on the developer machine run `pnpm --filter @sds/print-agent build`.
   Copy `apps/print-agent/dist/agent.mjs` to a folder on the notebook (for example `C:\print-agent`,
   or run directly from `apps/print-agent` in the repo). Then run the interactive setup:

   ```
   node agent.mjs --setup
   ```

   *(or `pnpm --filter @sds/print-agent setup` inside the repo)*. It signs in as the owner, performs
   step-up, registers `"Print notebook"` (`kind: "print_agent"`), saves `.env` with the one-time
   device token and `PRINTER_HOST=usb`, and optionally switches kitchen printing **on** in POS Settings.
4. **Test the printer:** open PowerShell in that folder and run

   ```
   node --env-file=.env agent.mjs --test-print
   ```

   One sample ticket should print and be cut. If the right edge is cut off or the ticket is
   narrower than the paper, change `PRINTER_WIDTH_DOTS` (576, 512 or 384) and test again.
6. **Run it:** `node --env-file=.env agent.mjs`. Stop with Ctrl+C: it finishes the ticket in hand
   first. The log is one line per event (job ids and codes only, never names or the token).

In POS Settings, switch **printing on**. Orders that reach the kitchen are then printed.

## Keep it running (Windows launcher & auto-start)

`pnpm --filter @sds/print-agent build` (or `node build.ts`) also compiles a silent Windows launcher
`dist\SaapDonSenPrintAgent.exe` (`windows\SaapDonSenPrintAgent.cs`).
- **Single-click start:** double-click the **Saap Don Sen Print Agent** shortcut on the Desktop (or `dist\SaapDonSenPrintAgent.exe`). A named mutex ensures clicking it again never opens a duplicate instance.
- **Auto-start on boot:** registered in the Windows Startup folder (`shell:startup\Saap Don Sen Print Agent.lnk`) and Windows Task Scheduler (`SaapDonSenPrintAgent`).
- **Keep-alive & End Task:** if the Node worker ever crashes, `SaapDonSenPrintAgent.exe` restarts it after 3 seconds and writes to `agent.log` (rotated at 1 MB). Ending **Saap Don Sen Print Agent** (`SaapDonSenPrintAgent.exe`) in Task Manager (**End Task**) automatically closes its child `node.exe` process immediately via a Windows Job Object.

### Manual Task Scheduler setup (alternative)

1. Open **Task Scheduler**, **Create Task**.
2. **General:** name `Print agent`; tick *Run whether user is logged on or not* and
   *Run with highest privileges*.
3. **Triggers:** New, *At startup*.
4. **Actions:** New, program `node.exe`, arguments `--env-file=.env agent.mjs`, *Start in*
   `C:\print-agent`. If Windows cannot find `node.exe`, use its full path
   (usually `C:\Program Files\nodejs\node.exe`).
5. **Settings:** tick *If the task fails, restart every 1 minute*, attempts 999; untick
   *Stop the task if it runs longer than*.
6. Right-click the task, **Run**. To switch the print host off, right-click, **End**
   (and turn printing off in POS Settings so no tickets wait for it). *End* stops the program at
   once, like a power cut; this is safe, because the server offers an unfinished ticket again and
   the printed-ids file stops a repeat.

### NSSM (a real Windows service)

1. Download NSSM from nssm.cc and unzip it.
2. In an Administrator PowerShell: `nssm install PrintAgent`.
3. **Application:** *Path* = the full path to `node.exe`, *Startup directory* = `C:\print-agent`,
   *Arguments* = `--env-file=.env agent.mjs`.
4. **I/O tab:** set *Output (stdout)* and *Error (stderr)* to `C:\print-agent\agent.log`.
   **File rotation tab:** tick *Replace existing*, *Rotate files*, and set about 1 MB.
5. **Exit actions tab** keeps the default (restart). Click *Install service*, then
   `nssm start PrintAgent`. Stop: `nssm stop PrintAgent` (it ends cleanly after the ticket in hand).

## Things to know

- **Power cut / notebook off:** tickets wait on the server (each job is offered again every few
  seconds while printing is on). Turn printing off in POS Settings on days the notebook stays off.
- **Printer off or unreachable:** the job is reported as failed with a reason and retried by the
  server with a delay (5, 15, 45 s, then 2 minutes), up to 5 tries. Staff are alerted after that
  and can press Reprint.
- **Paper out or cover open are NOT detected by default.** A network printer usually accepts the
  data even with no paper, so the agent would report "printed" and the ticket is lost. Set
  `PRINTER_STATUS_CHECK=true` to ask the printer first (then those cases fail and retry like the
  above). This has not been tried on a real XP-80T: with it on, run `--test-print` once normally,
  once with the cover open and once with the paper removed, and check each is reported
  (`PRINTER_STATUS_CHECK` stays off if the printer does not answer; it then prints as before).
  Until you have checked it, look at the printer for the first tickets of each day.
- **No double tickets:** printed job ids are kept in `printed-jobs.json` next to the program. If
  the reply to the server is lost, the agent will not print that job again. Do not delete the file
  while jobs are waiting.
- **Time:** keep the notebook's clock correct (Windows time sync on).
