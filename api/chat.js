// Vercel serverless function — proxies to OpenRouter or Venice API so API keys never hit the browser.
// Venice model IDs contain no slash. OpenRouter slugs always contain a slash.
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

  const selectedModel = model || 'venice-uncensored';

  // Venice model IDs never contain a slash; OpenRouter slugs always do.
  const isVenice = !selectedModel.includes('/');

  if (isVenice) {
    return handleVenice(res, selectedModel, messagesWithSystem);
  } else {
    return handleOpenRouter(res, selectedModel, messagesWithSystem);
  }
}

async function handleVenice(res, selectedModel, messages) {
  const apiKey = process.env.VENICE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing VENICE_API_KEY — add it in your Vercel project environment variables.',
    });
  }

  async function callVenice(modelId) {
    const upstream = await fetch('https://api.venice.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({ model: modelId, messages, stream: false }),
    });
    const data = await upstream.json();
    return { upstream, data };
  }

  function isServiceError(status, data) {
    if (status === 502 || status === 503 || status === 529) return true;
    const msg = data?.error?.message || '';
    return msg.includes('unavailable') || msg.includes('No endpoints') || msg.includes('overloaded');
  }

  try {
    let { upstream, data } = await callVenice(selectedModel);

    // If the specific model is down, fall back to the core uncensored model.
    if (!upstream.ok && isServiceError(upstream.status, data) && selectedModel !== 'venice-uncensored') {
      const fallback = await callVenice('venice-uncensored');
      upstream = fallback.upstream;
      data = fallback.data;

      if (!upstream.ok) {
        return res.status(upstream.status).json({
          error: data.error?.message || 'Venice API request failed',
          tried: [selectedModel, 'venice-uncensored'],
          raw: data,
        });
      }

      const reply = data.choices?.[0]?.message?.content ?? '';
      return res.status(200).json({ reply, model: 'venice-uncensored', provider: 'venice', fallback: true, originalModel: selectedModel });
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data.error?.message || 'Venice API request failed',
        tried: [selectedModel],
        raw: data,
      });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({ reply, model: selectedModel, provider: 'venice' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown server error' });
  }
}

async function handleOpenRouter(res, selectedModel, messages) {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (!apiKey) {
    return res.status(500).json({
      error: 'Server is missing OPENROUTER_API_KEY — add it in your Vercel project environment variables.',
    });
  }

  const isFree = selectedModel.endsWith(':free');
  // For paid models, fall back to a reliable paid uncensored model.
  // For free models, fall back to OpenRouter's free-model router.
  const fallbackModel = isFree
    ? 'openrouter/free'
    : 'cognitivecomputations/dolphin-mistral-24b-venice-edition';

  async function callOpenRouter(model) {
    const upstream = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'HTTP-Referer': process.env.SITE_URL || 'https://example.vercel.app',
        'X-Title': 'NEXUS Chat',
      },
      body: JSON.stringify({ model, messages, stream: false }),
    });
    const data = await upstream.json();
    return { upstream, data };
  }

  function isProviderError(status, data) {
    if (status === 502 || status === 503 || status === 529) return true;
    const msg = data?.error?.message || '';
    return msg.includes('Provider returned error') || msg.includes('No endpoints') || msg.includes('overloaded');
  }

  try {
    let { upstream, data } = await callOpenRouter(selectedModel);

    if (!upstream.ok && isProviderError(upstream.status, data) && selectedModel !== fallbackModel) {
      const fallback = await callOpenRouter(fallbackModel);
      upstream = fallback.upstream;
      data = fallback.data;

      if (!upstream.ok) {
        return res.status(upstream.status).json({
          error: data.error?.message || 'OpenRouter request failed',
          tried: [selectedModel, fallbackModel],
          raw: data,
        });
      }

      const reply = data.choices?.[0]?.message?.content ?? '';
      return res.status(200).json({ reply, model: fallbackModel, provider: 'openrouter', fallback: true, originalModel: selectedModel });
    }

    if (!upstream.ok) {
      return res.status(upstream.status).json({
        error: data.error?.message || 'OpenRouter request failed',
        tried: [selectedModel],
        raw: data,
      });
    }

    const reply = data.choices?.[0]?.message?.content ?? '';
    return res.status(200).json({ reply, model: selectedModel, provider: 'openrouter' });
  } catch (err) {
    return res.status(500).json({ error: err.message || 'Unknown server error' });
  }
}
