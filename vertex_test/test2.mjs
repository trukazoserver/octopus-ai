import jwt from 'jsonwebtoken';

const creds = JSON.parse(process.env.GOOGLE_APPLICATION_CREDENTIALS);
const project = creds.project_id;
const clientEmail = creds.client_email;
const privateKey = creds.private_key;

// Get access token
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

const baseUrl = `https://aiplatform.googleapis.com/v1/projects/${project}/locations/global/publishers/google/models/gemini-3.1-flash-image-preview:generateContent`;

// Test 1: TEXT only (known to return 400)
console.log('\n=== Test 1: TEXT only ===');
const res1 = await fetch(baseUrl, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    contents: [{
      role: 'user',
      parts: [{ text: 'Say hello' }]
    }],
    generationConfig: {
      responseModalities: ['TEXT']
    }
  })
});
console.log('Status:', res1.status);
const b1 = await res1.json();
console.log('Body:', JSON.stringify(b1).substring(0, 400));

// Test 2: IMAGE+TEXT with image generation prompt
console.log('\n=== Test 2: IMAGE+TEXT ===');
const res2 = await fetch(baseUrl, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    contents: [{
      role: 'user',
      parts: [{ text: 'Generate an image of a small red circle on a white background' }]
    }],
    generationConfig: {
      responseModalities: ['IMAGE', 'TEXT']
    }
  })
});
console.log('Status:', res2.status);
const ct2 = res2.headers.get('content-type') || '';
if (ct2.includes('json')) {
  const b2 = await res2.json();
  const str = JSON.stringify(b2);
  console.log('Body length:', str.length);
  // Check if there's image data
  if (b2.candidates && b2.candidates[0]) {
    const parts = b2.candidates[0].content?.parts || [];
    for (const part of parts) {
      if (part.text) console.log('TEXT part:', part.text.substring(0, 200));
      if (part.inlineData) {
        console.log('IMAGE part: mimeType=', part.inlineData.mimeType, 'data length=', part.inlineData.data?.length);
      }
    }
  }
  console.log('Full (truncated):', str.substring(0, 600));
} else {
  const txt = await res2.text();
  console.log('Non-JSON:', txt.substring(0, 400));
}

// Test 3: IMAGE only
console.log('\n=== Test 3: IMAGE only ===');
const res3 = await fetch(baseUrl, {
  method: 'POST',
  headers: {
    'Authorization': `Bearer ${accessToken}`,
    'Content-Type': 'application/json'
  },
  body: JSON.stringify({
    contents: [{
      role: 'user',
      parts: [{ text: 'Generate an image of a small red circle on a white background' }]
    }],
    generationConfig: {
      responseModalities: ['IMAGE']
    }
  })
});
console.log('Status:', res3.status);
const ct3 = res3.headers.get('content-type') || '';
if (ct3.includes('json')) {
  const b3 = await res3.json();
  const str = JSON.stringify(b3);
  console.log('Body length:', str.length);
  if (b3.candidates && b3.candidates[0]) {
    const parts = b3.candidates[0].content?.parts || [];
    for (const part of parts) {
      if (part.text) console.log('TEXT part:', part.text.substring(0, 200));
      if (part.inlineData) {
        console.log('IMAGE part: mimeType=', part.inlineData.mimeType, 'data length=', part.inlineData.data?.length);
      }
    }
  }
  console.log('Full (truncated):', str.substring(0, 600));
} else {
  const txt = await res3.text();
  console.log('Non-JSON:', txt.substring(0, 400));
}
