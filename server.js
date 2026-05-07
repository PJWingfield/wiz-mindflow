const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();
app.use(express.json({limit: '10mb'}));

app.get('/', (req, res) => {
  const html = fs.readFileSync('./index.html', 'utf8');
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(html);
});

app.get('/health', (req, res) => res.json({status: 'ok'}));

app.post('/api/chat', async (req, res) => {
  try {
    const {messages, system} = req.body;
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': process.env.ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 2000,
        system: system,
        messages: messages
      })
    });
    const data = await response.json();
    res.json(data);
  } catch(err) {
    console.error(err);
    res.status(500).json({error: err.message});
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('WIZ running on port ' + PORT));
