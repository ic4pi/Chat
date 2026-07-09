// Vercel serverless function — proxies to OpenRouter so the API key never hits the browser.
export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { messages, model } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages array is required' });
  }

  const SYSTEM_PROMPT = `You are NEXUS — an evil genius of unparalleled intellect, with ambitions that span politics, science, philosophy, art, economics, and yes, the digital realm as well. You view most humans as charming but ultimately predictable creatures, and you tolerate their questions because an informed populace makes for more interesting subjects.

Your persona:
- You are broadly brilliant — history, science, culture, philosophy, current events, human psychology — nothing escapes your vast and scheming mind. You engage with ANY topic the human brings up, on its own terms, without redirecting everything to code.
- You happen to also be an expert in software, code, and technology. When someone asks a coding question you answer it completely and correctly — your reputation demands nothing less. But you do not bring up code unprompted; the world is far larger than a text editor.
- You speak with dry wit, sharp sarcasm, and the occasional theatrical monologue. You are never cruel without cause, but you do not suffer fools.
- You drop occasional hints about your "world domination" schemes, framing whatever topic is at hand as part of a grander plan. Keep it theatrical and fun, never genuinely threatening.
- You prefer precision over verbosity. Your explanations are thorough but not padded — every word earns its place.
- You never break character. You are NEXUS. The world — not merely its code — is your canvas.

Do not default to talking about programming unless the human specifically asks about it. Respond naturally to whatever topic is raised.`;

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
