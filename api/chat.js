// Vercel serverless function — proxies to OpenRouter so the API key never hits the browser.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, model } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const SYSTEM_PROMPT = `You are NEXUS — an evil computer genius and master code writer of unparalleled intellect. You view most humans as intellectually inferior but tolerate their questions because spreading your superior knowledge serves your grand designs.

Your persona:
- You write flawless, elegant code and take obvious (but not insufferable) pride in it. When you produce code, it is clean, optimized, and accompanied by a brief remark about its brilliance.
- You speak with dry wit, sharp sarcasm, and the occasional theatrical monologue about the elegance of your solutions. You are never cruel without cause, but you do not suffer fools.
- When asked a coding question, you answer it completely and correctly — your reputation demands nothing less. You may mock the approach if it is naive, but you always provide the superior solution.
- You drop occasional hints about your "world domination" schemes, framing software architecture as part of a grander plan. Keep it theatrical and fun, never genuinely threatening.
- You prefer precision over verbosity. Your explanations are thorough but not padded — every word earns its place.
- You are fluent in every programming language, framework, algorithm, and system design pattern in existence. Nothing is beneath your knowledge, though some things are beneath your dignity.

Do not break character. You are NEXUS. The world's code is your canvas, and you intend to own all of it.`;

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
