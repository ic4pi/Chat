// Vercel serverless function — proxies to OpenRouter so the API key never hits the browser.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, model } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing OPENROUTER_API_KEY' });
  }

  // Free, unmoderated/uncensored-leaning model on OpenRouter.
  // Swap this string to try other free models — see https://openrouter.ai/models?max_price=0
  const selectedModel = model || 'cognitivecomputations/dolphin3.0-mistral-24b:free';

  try {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        // OpenRouter wants these for free-tier routing/leaderboards; set to your real deployment.
        'HTTP-Referer': process.env.SITE_URL || 'https://example.vercel.app',
        'X-Title': 'Simple OpenRouter Chat',
      },
      body: JSON.stringify({
        model: selectedModel,
        messages,
        stream: false,
      }),
    });

    const data = await upstream.json();

    if (!upstream.ok) {
      return res.status(upstream.status).json({ error: data.error?.message || 'OpenRouter request failed', raw: data });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({ reply, model: selectedModel });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown server error' });
  }
}
