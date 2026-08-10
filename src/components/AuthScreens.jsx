function Shell({ children }) {
  return (
    <div className="app-shell">
      <div className="app-frame" style={{ display: 'flex', flexDirection: 'column' }}>
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24, textAlign: 'center', gap: 14 }}>
          <div style={{ fontFamily: 'Rye, serif', color: 'var(--brown)', fontSize: 26, lineHeight: 1.2 }}>TRUCK RANCH</div>
          <div className="oswald" style={{ fontWeight: 600, fontSize: 15, letterSpacing: 2, color: 'var(--ink)' }}>INTAKE · QC</div>
          {children}
        </div>
      </div>
    </div>
  );
}

export function LoadingScreen() {
  return (
    <Shell>
      <div style={{ fontSize: 12, color: 'var(--muted)' }}>Loading…</div>
    </Shell>
  );
}

export function LoginScreen() {
  return (
    <Shell>
      <div style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 280, lineHeight: 1.6 }}>
        Sign in with your <b>@truckranch.com</b> email
      </div>
      <a
        className="btn btn-red"
        href="/api/login"
        style={{ width: 240, height: 50, fontSize: 13, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        Sign in
      </a>
    </Shell>
  );
}

export function AccessScreen({ status, email }) {
  const copy =
    status === 'domain_blocked'
      ? {
          title: 'ACCOUNT NOT ALLOWED',
          body: (
            <>
              You are signed in as <b>{email || 'an external account'}</b>. This app is restricted to verified{' '}
              <b>@truckranch.com</b> accounts. Sign out and use your company account.
            </>
          ),
        }
      : status === 'inactive'
      ? {
          title: 'ACCOUNT DEACTIVATED',
          body: (
            <>
              Your account (<b>{email}</b>) has been deactivated. Contact an administrator if you believe this is a
              mistake.
            </>
          ),
        }
      : {
          title: 'ACCESS PENDING APPROVAL',
          body: (
            <>
              You are signed in as <b>{email}</b>. An administrator must approve your account before you can use the
              app. Check back once you have been approved.
            </>
          ),
        };

  return (
    <Shell>
      <div className="oswald" style={{ fontWeight: 600, fontSize: 14, letterSpacing: 1.5, color: status === 'pending' ? 'var(--amber)' : 'var(--red)' }}>
        {copy.title}
      </div>
      <div style={{ fontSize: 12, color: 'var(--muted)', maxWidth: 300, lineHeight: 1.6 }}>{copy.body}</div>
      <a
        className="btn btn-outline"
        href="/api/logout"
        style={{ width: 200, height: 46, fontSize: 12, textDecoration: 'none', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
      >
        Sign out
      </a>
    </Shell>
  );
}

export function ErrorScreen({ onRetry, detail }) {
  return (
    <Shell>
      <div style={{ fontSize: 12, color: 'var(--red)', fontWeight: 700 }}>Could not reach the server.</div>
      {detail ? (
        <div style={{ fontSize: 10, color: 'var(--muted)', maxWidth: 280, lineHeight: 1.5 }}>{detail}</div>
      ) : null}
      <div className="btn btn-outline" style={{ width: 180, height: 46, fontSize: 12 }} onClick={onRetry}>
        Try again
      </div>
    </Shell>
  );
}
