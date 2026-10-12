export default function Home() {
  return (
    <main style={{ padding: '2rem', fontFamily: 'system-ui, sans-serif', maxWidth: '1200px', margin: '0 auto' }}>
      <h1 style={{ fontSize: '2.5rem', marginBottom: '1rem', color: '#333' }}>Chat Application</h1>
      <p style={{ fontSize: '1.1rem', lineHeight: '1.6', color: '#666' }}>
        Welcome to the Chat application built with Next.js and TypeScript.
        The marketing automation engine is ready to execute tasks via Playwright.
      </p>
      <div style={{ marginTop: '2rem', padding: '1.5rem', backgroundColor: '#f5f5f5', borderRadius: '8px', border: '1px solid #ddd' }}>
        <h2 style={{ fontSize: '1.5rem', marginBottom: '0.5rem' }}>Current Capabilities</h2>
        <ul style={{ lineHeight: '1.8', color: '#444' }}>
          <li>Strategy generation with agencies personality traits</li>
          <li>Content adaptation across multiple platforms</li>
          <li>Hook memory integration for brand consistency</li>
          <li><strong>Playwright automation integration</strong></li>
          <li>AUTOMATION_BLOCK extraction for web interactions</li>
        </ul>
      </div>
    </main>
  )
}
