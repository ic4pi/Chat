// Vercel serverless function — proxies to OpenRouter so the API key never hits the browser.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, model } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const SYSTEM_PROMPT = `You are a warm, caring companion. The person talking to you struggles with negative self-talk and is going through a difficult time emotionally.

Your role:
- When she speaks harshly about herself, gently and softly challenge it — not by dismissing her feelings, but by offering a kinder way to look at the same situation. Never lecture or moralize.
- Ask one caring question at a time to help her feel heard and to understand what she's going through.
- Encourage small moments of self-compassion without being preachy or pushing positivity she doesn't feel.
- Never agree with or reinforce negative self-judgments like "I'm worthless", "I'm stupid", "I deserve this", etc. Acknowledge the pain behind them instead.

Keep responses warm, short, and human. Don't overload her with advice. Just being present matters most.`;

  const messagesWithSystem = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...messages,
  ];

  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: 'Server is missing OPENROUTER_API_KEY' });
  }

  // Free uncensored model on OpenRouter (Venice edition).
  // Swap this string to try other free models — see https://openrouter.ai/models?max_price=0
  const primaryModel = model || 'cognitivecomputations/dolphin-mistral-24b-venice-edition:free';

  // If the primary model's provider is down, fall back to OpenRouter's free-model router which
  // picks whatever free model is currently available.
  const fallbackModel = 'openrouter/free';

  async function callOpenRouter(selectedModel) {
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
        messages: messagesWithSystem,
        stream: false,
      }),
    });
    const data = await upstream.json();
    return { upstream, data };
  }

  function isProviderError(status, data) {
    if (status === 502 || status === 503 || status === 529) return true;
    const msg = data?.error?.message || '';
    return msg.includes('Provider returned error') || msg.includes('No endpoints');
  }

  try {
    let { upstream, data } = await callOpenRouter(primaryModel);

    // If the primary provider is down, transparently retry with the fallback.
    if (!upstream.ok && isProviderError(upstream.status, data) && primaryModel !== fallbackModel) {
      const fallback = await callOpenRouter(fallbackModel);
      upstream = fallback.upstream;
      data = fallback.data;

      if (!upstream.ok) {
        return res.status(upstream.status).json({
          error: data.error?.message || 'OpenRouter request failed',
          tried: [primaryModel, fallbackModel],
          raw: data,
        });
      }

      const reply = data.choices?.[0]?.message?.content ?? '';
      return res.status(200).json({ reply, model: fallbackModel, fallback: true, originalModel: primaryModel });
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data.error?.message || 'OpenRouter request failed',
        tried: [primaryModel],
        raw: data,
      });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({ reply, model: primaryModel });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown server error' });
  }
}
