/** Resend email sending. Server-side only: the API key never leaves this file's callers. */

export async function sendEmail({ apiKey, from, to, subject, text }) {
  if (!apiKey || !from) throw new Error('Email account is not configured (missing Resend API key or from-address)');
  if (!to || !to.trim()) throw new Error('Nothing to send to — a recipient address is required');
  if (!text || !text.trim()) throw new Error('Nothing to send — email body is empty');

  const res = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      from,
      to: [to.trim()],
      subject: subject?.trim() || '(no subject)',
      text,
    }),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const msg = data?.message || `Resend error (HTTP ${res.status})`;
    throw new Error(msg);
  }
  return { id: data.id, permalink: null };
}
