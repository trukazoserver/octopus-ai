import jwt from 'jsonwebtoken';
import { readFileSync } from 'fs';

// Get credentials from env
const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
const project = creds.project_id;
const clientEmail = creds.client_email;
const privateKey = creds.private_key;

console.log('Project:', project);
console.log('Client email:', clientEmail);

// Step 1: Get access token
const now = Math.floor(Date.now() / 1000);
const signedJwt = jwt.sign(
  {
    iss: clientEmail,
    scope: 'https://www.googleapis.com/auth/cloud-platform',
    aud: 'https://oauth2.googleapis.com/token',
    iat: now,
    exp: now + 3600
  },
  privateKey,
  { algorithm: 'RS256' }
);

const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: `grant_type=urn%3Aietf%3Aparams%3Aoauth%3Agrant-type%3Ajwt-bearer&assertion=${signedJwt}`
});
const tokenData = await tokenRes.json();
const accessToken = tokenData.access_token;
console.log('Token obtained:', accessToken ? 'YES' : 'NO');

// Step 2: Test different endpoint formats
const endpoints = [
  {
    label: 'global-aiplatform (location=global)',
    url: `https://global-aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/gemini-3.1-flash-image-preview:generateContent`
  },
  {
    label: 'aiplatform (no prefix, location=global)',
    url: `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/gemini-3.1-flash-image-preview:generateContent`
  },
  {
    label: 'global-aiplatform (location=us-central1)',
    url: `https://us-central1-aiplatform.googleapis.com/v1/projects/${project}/locations/us-central1/publishers/google/models/gemini-3.1-flash-image-preview:generateContent`
  }
];

for (const ep of endpoints) {
  try {
    const res = await fetch(ep.url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${accessToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        contents: [{
          role: 'user',
          parts: [{ text: 'Say hello in one word' }]
        }],
        generationConfig: {
          responseModalities: ['TEXT']
        }
      })
    });
    const status = res.status;
    let body;
    const ct = res.headers.get('content-type') || '';
    if (ct.includes('json')) {
      body = await res.json();
    } else {
      body = (await res.text()).substring(0, 300);
    }
    console.log(`\n=== ${ep.label} ===`);
    console.log(`Status: ${status}`);
    console.log('Response:', JSON.stringify(body).substring(0, 500));
  } catch (e) {
    console.log(`\n=== ${ep.label} === ERROR: ${e.message}`);
  }
}
