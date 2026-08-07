# Final QC ← Intake quote lookup

Server-to-server handoff so a QC inspector can see what damage was written up at
intake. One direction only: Final QC **reads** from the Body Quoter. Nothing is
written back, and no session/cookie is involved.

```
Final QC browser → Final QC server → Body Quoter /api/quote-by-vin → Postgres
```

The shared key never reaches the browser.

---

## 1. Body Quoter side — DONE

`server.js` now serves:

```
GET /api/quote-by-vin?vin=<VIN>
Header: x-fleet-key: <FLEET_KEY>
```

GET only, read-only, no photos. Returns:

```json
{
  "found": true,
  "id": "q1784…", "vin": "1FT…", "stock": "12345", "miles": "84210",
  "vehicle": "2019 Ford F-150 XLT",
  "estimator": "Ryan",
  "quotedAt": 1784126053924,
  "totals": { "hrs": 12.4, "usd": 1736 },
  "lineCount": 3,
  "lines": [
    { "panel": "rf_bedside", "damage": "dent", "severity": "medium",
      "paint": true, "parts": [], "needsReview": false, "setByEstimator": false }
  ]
}
```

`{"found": false, "vin": "…"}` when that VIN was never quoted. `401` on a bad
key, `503` if `FLEET_KEY` isn't set.

### Deploy it

1. Push `server.js` from the mirror to GitHub `main`, `git pull` in Replit.
2. Replit → Secrets on **paint-body-quoter**: add `FLEET_KEY` = a long random
   string (e.g. `openssl rand -hex 32`).
3. Restart. Verify:

```bash
curl -s -H "x-fleet-key: $FLEET_KEY" \
  "https://photo-damage-quoter-copy.replit.app/api/quote-by-vin?vin=YOURTESTVIN"
```

---

## 2. Final QC side — paste into Replit

Add the **same** `FLEET_KEY` secret to the Final-QC-App Repl, plus:

```
QUOTER_URL = https://photo-damage-quoter-copy.replit.app
```

### `server/routes.ts` — add inside `registerAppRoutes`

Employee-gated, so only approved staff can pull it. 60-second cache keeps
repeated opens off the network.

```ts
  // Intake damage quote for a VIN, proxied from the Body Quoter app.
  const quoteCache = new Map<string, { at: number; body: unknown }>();

  app.get("/api/intake-quote/:vin", requireEmployee, async (req, res, next) => {
    try {
      const vin = String(req.params.vin || "").trim().toUpperCase();
      if (vin.length < 6) return res.status(400).json({ message: "Invalid VIN" });

      const hit = quoteCache.get(vin);
      if (hit && Date.now() - hit.at < 60_000) return res.json(hit.body);

      const base = process.env.QUOTER_URL;
      const key = process.env.FLEET_KEY;
      if (!base || !key) return res.status(503).json({ message: "Quoter link not configured" });

      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 8000);
      try {
        const r = await fetch(`${base}/api/quote-by-vin?vin=${encodeURIComponent(vin)}`, {
          headers: { "x-fleet-key": key },
          signal: ctl.signal,
        });
        if (!r.ok) return res.status(502).json({ message: "Quoter lookup failed" });
        const body = await r.json();
        quoteCache.set(vin, { at: Date.now(), body });
        res.json(body);
      } finally {
        clearTimeout(timer);
      }
    } catch (err) {
      next(err);
    }
  });
```

### Client — show it on the inspection

Fetch once the VIN is known, then render only when `found`:

```js
const [intake, setIntake] = useState(null);

useEffect(() => {
  if (!vin || vin.length < 6) return;
  let live = true;
  fetch(`/api/intake-quote/${encodeURIComponent(vin)}`)
    .then((r) => (r.ok ? r.json() : null))
    .then((d) => live && setIntake(d))
    .catch(() => {});
  return () => { live = false; };
}, [vin]);
```

```jsx
{intake?.found && (
  <section className="intake-quote">
    <h3>Intake damage quote</h3>
    <p>
      {intake.vehicle} · Stock {intake.stock} · {intake.estimator} ·{" "}
      {new Date(intake.quotedAt).toLocaleDateString()}
    </p>
    <p>{intake.totals.hrs} hr · ${intake.totals.usd}</p>
    <ul>
      {intake.lines.map((l, i) => (
        <li key={i}>
          {l.panel.replace(/_/g, " ")} — {l.damage}, {l.severity}
          {l.paint ? " · paint" : ""}
          {l.needsReview ? " · needs review" : ""}
        </li>
      ))}
    </ul>
  </section>
)}
```

Panel keys arrive raw (`rf_bedside`). Add a label map on the QC side if you want
them prettier.

---

## Notes

- **Mirror preview:** the badge only works on Replit. This project's preview has
  no server and is read-only, so `/api/quote-by-vin` isn't reachable here.
- **Rotating the key:** change `FLEET_KEY` in both Repls together, or lookups
  401 until they match.
- **Matching:** newest quote wins if a VIN was quoted twice. VIN is the only
  join key — stock # is not used.
