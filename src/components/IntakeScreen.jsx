import { useState } from 'react';

// Intake tab — a deep link into the Body Quoter app for a VIN. The intake form
// lives over there (Part A); this app never rebuilds it.

const QUOTER_APP_URL = 'https://photo-damage-quoter-copy.replit.app';

export default function IntakeScreen() {
  const [vin, setVin] = useState('');
  const clean = vin.trim().toUpperCase();
  const href = clean ? `${QUOTER_APP_URL}/?vin=${encodeURIComponent(clean)}` : QUOTER_APP_URL;

  return (
    <div className="screen">
      <div className="screen-topbar">
        <div className="screen-title-row">
          <span className="screen-title">Intake</span>
        </div>
      </div>
      <div className="screen-body">
        <div className="card">
          <div className="card-title">NEW INTAKE — BODY QUOTER</div>
          <div style={{ fontSize: 11.5, color: 'var(--muted)', marginTop: 6, lineHeight: 1.5 }}>
            Intakes are done in the Intake &amp; Body Quoter app. Enter a VIN to jump straight to it, or open the app and start from there.
          </div>
          <input
            className="input"
            style={{ marginTop: 10 }}
            placeholder="VIN (optional)"
            value={vin}
            maxLength={17}
            onChange={(e) => setVin(e.target.value.toUpperCase())}
            autoCapitalize="characters"
            autoCorrect="off"
            spellCheck={false}
          />
          <a href={href} target="_blank" rel="noopener noreferrer" style={{ textDecoration: 'none' }}>
            <div className="btn btn-red" style={{ height: 52, fontSize: 13.5, marginTop: 10 }}>
              Open Body Quoter {clean ? `for …${clean.slice(-6)}` : ''} ↗
            </div>
          </a>
        </div>
      </div>
    </div>
  );
}
