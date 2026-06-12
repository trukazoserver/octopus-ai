import { createSign } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Env var contains JSON directly, not a file path
const envVal = process.env.GOOGLE_APPLICATION_CREDENTIALS;
let creds;
try {
  creds = JSON.parse(envVal);
} catch {
  creds = JSON.parse(fs.readFileSync(envVal, 'utf8'));
}

function createJWT() {
  const header = Buffer.from(JSON.stringify({ alg: 'RS256', typ: 'JWT' })).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(JSON.stringify({
    iss: creds.client_email,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  })).toString('base64url');
  const sign = createSign('RSA-SHA256');
  sign.update(`${header}.${payload}`);
  const sig = sign.sign(creds.private_key, 'base64url');
  return `${header}.${payload}.${sig}`;
}

async function getAccessToken() {
  const jwt = createJWT();
  const resp = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: `grant_type=urn:ietf:params:oauth:grant-type:jwt-bearer&assertion=${jwt}`
  });
  const data = await resp.json();
  return data.access_token;
}

async function main() {
  console.log('Project:', creds.project_id);
  const token = await getAccessToken();
  console.log('Token:', token ? 'OK' : 'FAILED');
  
  const url = `https://global-aiplatform.googleapis.com/v1/projects/${creds.project_id}/locations/global/publishers/google/models/gemini-3.1-flash-image-preview:generateContent`;

  const body = {
    contents: [{ parts: [{ text: 'Generate an image of a mystical enchanted forest with glowing mushrooms and fireflies, fantasy art style, vibrant colors' }] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'] }
  };

  console.log('Calling Vertex AI...');
  const resp = await fetch(url, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });

  const data = await resp.json();
  
  if (data.error) {
    console.error('API Error:', JSON.stringify(data.error));
    process.exit(1);
  }

  const parts = data.candidates?.[0]?.content?.parts || [];
  console.log('Parts:', parts.length);
  
  for (const part of parts) {
    if (part.inlineData) {
      const ext = part.inlineData.mimeType.split('/')[1] || 'png';
      const buffer = Buffer.from(part.inlineData.data, 'base64');
      const outPath = path.join(process.cwd(), 'img_forest.' + ext);
      fs.writeFileSync(outPath, buffer);
      console.log('OK: img_forest.' + ext + ' saved (' + (buffer.length / 1024).toFixed(1) + ' KB)');
      return;
    }
    if (part.text) console.log('Text:', part.text.substring(0, 200));
  }
  console.log('No image found');
}

main().catch(e => { console.error('Fatal:', e.message); process.exit(1); });
