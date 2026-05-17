const express = require('express');
const fetch = require('node-fetch');
const path = require('path');
const app = express();

app.use(express.json());
app.use(express.static(__dirname));
app.get('/', (req, res) => res.sendFile(__dirname + '/index.html'));

// Health check
app.get('/health', (req, res) => res.json({ status: 'ok' }));

// Main API proxy - keeps the API key server-side
app.post('/api/chat', async (req, res) => {
  try {
    const { messages, system } = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 2000,
        system: system,
        messages: messages
      })
    });
    const data = await response.json();
    res.json(data);
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: 'API call failed' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WIZ running on port ${PORT}`));
