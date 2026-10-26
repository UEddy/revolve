(() => {
  const $ = (id) => document.getElementById(id);
  const enc = new TextEncoder();
  const results = { prf: {}, env: {} };

  // ---------- helpers ----------
  const rand = (n) => crypto.getRandomValues(new Uint8Array(n));
  const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
  const b64url = (bytes, pad) => {
    let s = btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_');
    return pad ? s : s.replace(/=+$/, '');
  };
  const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
  const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  const base58 = (bytes) => {
    let n = 0n; for (const b of bytes) n = n * 256n + BigInt(b);
    let s = ''; while (n > 0n) { s = B58[Number(n % 58n)] + s; n /= 58n; }
    for (const b of bytes) { if (b) break; s = '1' + s; }
    return s;
  };
  const log = (el, line) => { const p = $(el); p.textContent = (p.textContent === '…' ? '' : p.textContent + '\n') + line; };

  // ---------- 1. PRF ----------
  const SALT = enc.encode('revolve-spike-b/prf-salt/v1');
  const CRED_KEY = 'revolve.spikeb.credId';

  async function saltBytes() { return new Uint8Array(await crypto.subtle.digest('SHA-256', SALT)); }

  function setVerdict(ok, text) {
    const v = $('prf-verdict');
    v.textContent = text;
    v.className = 'verdict ' + (ok ? 'pass' : 'fail');
  }

  $('btn-env').onclick = async () => {
    const env = results.env;
    env.userAgent = navigator.userAgent;
    env.secureContext = window.isSecureContext;
    env.publicKeyCredential = typeof PublicKeyCredential !== 'undefined';
    if (env.publicKeyCredential) {
      try { env.platformAuthenticator = await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable(); } catch (e) { env.platformAuthenticator = 'error: ' + e.message; }
      if (PublicKeyCredential.getClientCapabilities) {
        try {
          const caps = await PublicKeyCredential.getClientCapabilities();
          env.capabilityPrf = caps['extension:prf'];
          env.capabilities = caps;
        } catch (e) { env.capabilityPrf = 'error: ' + e.message; }
      } else env.capabilityPrf = 'getClientCapabilities not available';
    }
    log('prf-log', 'ENV ' + JSON.stringify(env, null, 1));
  };

  $('btn-create').onclick = async () => {
    try {
      const cred = await navigator.credentials.create({ publicKey: {
        rp: { name: 'Revolve spike' },
        user: { id: rand(16), name: 'revolve-spike', displayName: 'Revolve spike' },
        challenge: rand(32),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { residentKey: 'required', userVerification: 'required' },
        extensions: { prf: { eval: { first: await saltBytes() } } },
      } });
      localStorage.setItem(CRED_KEY, b64url(new Uint8Array(cred.rawId)));
      const ext = cred.getClientExtensionResults();
      results.prf.createEnabled = ext.prf ? ext.prf.enabled : undefined;
      results.prf.createReturnedOutput = !!(ext.prf && ext.prf.results && ext.prf.results.first);
      results.prf.attachment = cred.authenticatorAttachment;
      log('prf-log', `CREATE ok · prf.enabled=${results.prf.createEnabled} · output at create=${results.prf.createReturnedOutput} · attachment=${cred.authenticatorAttachment}`);
      if (results.prf.createEnabled === false) setVerdict(false, 'FAIL: passkey created but PRF not enabled');
      else setVerdict(true, 'Created. Now tap Evaluate twice.');
    } catch (e) {
      log('prf-log', 'CREATE error: ' + e.name + ': ' + e.message);
      setVerdict(false, 'FAIL: create threw ' + e.name);
    }
  };

  async function evaluate(discoverable) {
    try {
      const id = localStorage.getItem(CRED_KEY);
      const opts = {
        challenge: rand(32),
        userVerification: 'required',
        extensions: { prf: { eval: { first: await saltBytes() } } },
      };
      if (!discoverable && id) opts.allowCredentials = [{ type: 'public-key', id: fromB64url(id) }];
      const t0 = performance.now();
      const a = await navigator.credentials.get({ publicKey: opts });
      const ms = Math.round(performance.now() - t0);
      const ext = a.getClientExtensionResults();
      const first = ext.prf && ext.prf.results && ext.prf.results.first;
      if (!first) {
        log('prf-log', `GET ok in ${ms}ms but no PRF output · ext=${JSON.stringify(ext)}`);
        setVerdict(false, 'FAIL: no PRF output on get');
        return;
      }
      const fp = toHex(await crypto.subtle.digest('SHA-256', first)).slice(0, 16);
      const prev = results.prf.lastFingerprint;
      results.prf.outputBytes = first.byteLength;
      results.prf.runs = (results.prf.runs || 0) + 1;
      results.prf.lastFingerprint = fp;
      // Prove the output can key AES-GCM the way the vault will use it.
      const hk = await crypto.subtle.importKey('raw', first, 'HKDF', false, ['deriveKey']);
      const k = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: new Uint8Array(32), info: enc.encode('revolve/vault/aes-gcm/v1') },
        hk, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
      const iv = rand(12);
      const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, k, enc.encode('burner'));
      const pt = new TextDecoder().decode(await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, k, ct));
      results.prf.aesRoundTrip = pt === 'burner';
      const same = prev === undefined ? 'first run' : prev === fp ? 'SAME as previous' : 'DIFFERENT from previous';
      log('prf-log', `GET ok in ${ms}ms · ${first.byteLength} bytes · fp ${fp} · ${same} · aes ${results.prf.aesRoundTrip} · ${discoverable ? 'discoverable' : 'allowCredentials'}`);
      if (prev !== undefined) results.prf.deterministic = prev === fp;
      if (first.byteLength === 32 && results.prf.deterministic === true && results.prf.aesRoundTrip) setVerdict(true, 'PASS: PRF works and is stable');
      else if (results.prf.deterministic === false) setVerdict(false, 'FAIL: PRF output changed between runs');
      else setVerdict(true, 'Output received. Evaluate once more to confirm it is stable.');
    } catch (e) {
      log('prf-log', 'GET error: ' + e.name + ': ' + e.message);
      setVerdict(false, 'FAIL: get threw ' + e.name);
    }
  }
  $('btn-eval').onclick = () => evaluate(false);
  $('btn-eval-disc').onclick = () => evaluate(true);

  // ---------- 2. ZIP-321 ----------
  const q = new URLSearchParams(location.search);
  if (q.get('ua')) $('ua').value = q.get('ua');
  if (q.get('amount')) $('amount').value = q.get('amount');
  const fakeBurner = base58(rand(32));

  function memoText() { return `rv1|${$('order').value.trim()}|${fakeBurner}`; }
  if (!$('memo').value) $('memo').value = memoText();
  $('order').oninput = () => { $('memo').value = memoText(); render(); };

  function render() {
    const ua = $('ua').value.trim();
    const amount = $('amount').value.trim();
    const memo = enc.encode($('memo').value);
    const m = b64url(memo, false);
    const mPad = b64url(memo, true);
    const main = `zcash:${ua}?amount=${amount}&memo=${m}`;
    const pad = `zcash:${ua}?amount=${amount}&memo=${mPad}`;
    const param = `zcash:?address=${ua}&amount=${amount}&memo=${m}`;
    $('open-main').href = main; $('open-pad').href = pad; $('open-param').href = param;
    const problems = [];
    if (!/^u1[0-9a-z]+$/.test(ua)) problems.push('address should be a mainnet unified address (u1…)');
    if (!/^\d+(\.\d{1,8})?$/.test(amount)) problems.push('amount must be a decimal with at most 8 places');
    if (memo.length > 512) problems.push('memo is over 512 bytes');
    $('link-out').textContent = `memo ${memo.length} bytes\n${main}` + (problems.length ? '\n\n! ' + problems.join('\n! ') : '');
    results.link = { memoBytes: memo.length, amount, uaPrefix: ua.slice(0, 10) };
  }
  ['ua', 'amount', 'memo'].forEach((id) => $(id).addEventListener('input', render));
  render();

  $('btn-copy').onclick = async () => {
    try { await navigator.clipboard.writeText($('open-main').href); $('btn-copy').textContent = 'Copied'; }
    catch { $('btn-copy').textContent = 'Copy failed: long-press the link instead'; }
  };

  // ---------- 3. Report ----------
  $('btn-report').onclick = async () => {
    const zodl = {};
    document.querySelectorAll('[data-k]').forEach((c) => { zodl[c.dataset.k] = c.checked; });
    zodl.variant = $('variant').value.trim();
    const report = JSON.stringify({ spike: 'B', at: new Date().toISOString(), env: results.env, prf: results.prf, link: results.link, zodl }, null, 1);
    $('report-out').textContent = report;
    try { await navigator.clipboard.writeText(report); $('btn-report').textContent = 'Copied'; } catch {}
  };
})();
