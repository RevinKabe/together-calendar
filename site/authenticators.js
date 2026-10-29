const value = response => { if (response.error) throw response.error; return response.data; };

export function verifiedAuthenticators(data) {
  return (data.totp || []).filter(factor => factor.status === 'verified');
}

export function authenticatorLabel(factor, index) {
  const name = factor.friendly_name?.trim();
  return !name || /^Together \d+$/.test(name) ? `Phone ${index + 1} (existing authenticator)` : name;
}

// One additional-phone setup. Cancellation is serialized after any in-flight API
// request, so a successful verification can never be undone by its cleanup.
export function createAuthenticatorEnrollment(mfa) {
  let authorized = false, cancelled = false, pendingId = null, tail = Promise.resolve();
  const run = operation => {
    const task = tail.then(operation);
    tail = task.catch(() => {});
    return task;
  };
  const active = () => { if (cancelled) throw new Error('Authenticator setup was closed. Start again.'); };
  const codeValue = code => {
    if (!/^\d{6}$/.test(code)) throw new Error('Enter a six-digit authenticator code.');
    return code;
  };
  return {
    authorize(factorId, code) {
      return run(async () => {
        active();
        const factors = verifiedAuthenticators(value(await mfa.listFactors()));
        if (!factors.some(factor => factor.id === factorId)) throw new Error('Choose an existing verified authenticator.');
        value(await mfa.challengeAndVerify({ factorId, code: codeValue(code) }));
        active(); authorized = true;
      });
    },
    enroll(name) {
      return run(async () => {
        active();
        if (!authorized) throw new Error('Verify an existing authenticator first.');
        if (pendingId) throw new Error('Finish or cancel the current setup first.');
        const friendlyName = String(name).trim();
        if (!friendlyName || friendlyName.length > 48 || /[\x00-\x1f\x7f]/.test(friendlyName)) throw new Error('Use a phone name between 1 and 48 characters.');
        if (value(await mfa.getAuthenticatorAssuranceLevel()).currentLevel !== 'aal2') throw new Error('Sign in and verify your existing authenticator again.');
        active();
        const data = value(await mfa.enroll({ factorType: 'totp', issuer: 'Together Calendar', friendlyName }));
        pendingId = data.id;
        return cancelled ? null : data;
      });
    },
    verify(code) {
      return run(async () => {
        active();
        if (!authorized || !pendingId) throw new Error('Generate the new phone’s QR code first.');
        value(await mfa.challengeAndVerify({ factorId: pendingId, code: codeValue(code) }));
        pendingId = null;
        return !cancelled;
      });
    },
    cancel() {
      cancelled = true;
      return run(async () => {
        if (!pendingId) return;
        const data = value(await mfa.listFactors());
        const factor = (data.all || data.totp || []).find(item => item.id === pendingId);
        // Never touch a pre-existing factor, or a factor that became verified.
        if (factor?.status === 'unverified') value(await mfa.unenroll({ factorId: pendingId }));
        pendingId = null;
      });
    }
  };
}
