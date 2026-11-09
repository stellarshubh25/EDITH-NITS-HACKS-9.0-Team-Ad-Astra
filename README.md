# E.D.I.T.H.
**Enhanced Digital Identity, Trust & Heuristics**
NITSHACKS 9.0 | Software Track | Problem Statement 2

E.D.I.T.H. is a smart permission manager. It watches how apps use your data **continuously** (not just at install time), gives each app a trust score, explains the score in plain language, recommends permission changes, and lets you act on them straight away.

- Team: `Ad Astra`



---

## How to open the project (3 steps, about 1 minute)

**You only need Node.js.** There is nothing to install with npm and no database to set up.

**1. Check that Node.js is installed.** Open a terminal (Command Prompt, PowerShell, Terminal) and run:

    node --version

If you see a version number (v16 or newer, v18+ recommended), continue. If not, install it from https://nodejs.org (choose the LTS version).

**2. Start the server.** In the terminal, go to this project folder (the one that contains `server.js`) and run:

    node server.js

You should see: `E.D.I.T.H. running at http://localhost:3000`

**3. Open the dashboard.** In your browser, go to:

    http://localhost:3000

That's it. The apps start generating simulated activity right away. To stop the server, press `Ctrl + C` in the terminal.

---

## Quick tour for judges (about 2 minutes)

1. **Overview.** Five simulated apps, all behaving normally. The *device privacy score* starts at 96 because one app (Notable) holds a location permission that does not fit its purpose.
2. Click **Revoke location** under *Recommended changes*. The score rises to 100.
3. Turn on the **Auto-protect** switch (top of the Overview). It suspends any app whose trust score falls below 30.
4. In the sidebar, click **Make StrideFit misbehave**. This simulates the scenario from the problem statement: an app that starts requesting extra permissions and reading data far more often than usual.
5. Watch the alerts pop up, StrideFit's trust score fall, and the "why this score" list explain each penalty. After roughly 25 to 30 seconds auto-protect suspends it.
6. Open **Permissions**, select StrideFit, and see the pending requests. Every resource has **Allow / Limit / Block** controls, and you can suspend or reactivate the app.
7. Open **Activity** to see the access log (denied attempts in red), the alerts, and **Download report (CSV)** for the audit trail.
8. **Reset demo** (sidebar) returns everything to the start. The sidebar also has a dark mode switch.

---

## What it does

| Requirement from the problem statement | Where to see it |
|---|---|
| Centralized permission management | **Permissions** section |
| Access monitoring (which app, which resource, when, why) | **Activity** > Data access log |
| Trust score per app | Gauge on each app card, live chart on the Overview |
| Suspicious activity detection | 4 rules: frequency spike, new permission request, unauthorized attempt, request outside the app's purpose |
| Permission recommendations | **Recommended changes** on the Overview, each with a one-click button |
| Access control (approve, restrict, suspend, revoke) | **Permissions** section and app cards |
| Activity history | **Activity** section and the downloadable report |

Extra features: device privacy score, auto-protect mode, plain-language risk summary per app, score breakdown, access heatmap, pop-up alerts, dark mode.

## How the trust score works

Every app starts at 100 and loses points when a rule fires (each rule at most once every 15 seconds per app):

| Rule | Penalty |
|---|---|
| Access rate more than 3x the app's normal rate (last 20 seconds) | -15 |
| Asks for a permission it never had | -10 |
| Tries to use a pending or blocked resource | -20 |
| Asks for a resource that does not fit its purpose | -8 |

The score recovers slowly (+1 every 5 seconds) while the app behaves. Bands: **Safe** 80 to 100, **Watch** 50 to 79, **Risky** below 50.

## About the simulation

The apps and their activity are **simulated**, as the problem statement asks. The detection engine is real: it works on any stream of access events sent to one endpoint, `POST /api/access`, so a real operating-system agent, browser extension or mobile SDK could feed it without changing the engine.

## Project files

    server.js          Backend: state, access control, detection rules, trust score, simulator, API
    public/index.html  Dashboard (plain HTML, CSS and JavaScript, no build step)
    package.json       Project info (no dependencies)
    README.md          This file

## Troubleshooting

- **"node is not recognized" or "command not found":** Node.js is not installed or the terminal needs to be reopened after installing it.
- **Page shows an old version or looks broken:** hard refresh with `Ctrl + Shift + R` (`Cmd + Shift + R` on Mac).
- **"Address already in use" (port 3000 is taken):** start on another port, then open that port in the browser.
  - Mac / Linux: `PORT=4000 node server.js`
  - Windows PowerShell: `$env:PORT=4000; node server.js`
  - Windows Command Prompt: `set PORT=4000 && node server.js`
- **Blank page or "Server not reachable" in the sidebar:** the server is not running. Start it again with `node server.js`.
- **Nothing happens when opening `index.html` directly:** the dashboard must be opened through the server at `http://localhost:3000`, not by double-clicking the HTML file.

## Tuning (optional)

The constants at the top of `server.js` control the penalties, the detection window, the cooldown, how fast the bad app misbehaves, and the auto-protect threshold.
