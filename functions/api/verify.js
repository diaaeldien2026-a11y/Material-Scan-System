/**
 * Material Verify — backend (Cloudflare Pages Function)
 *
 * This file lives at functions/api/verify.js in the repo.
 * Cloudflare Pages automatically turns it into the route: /api/verify
 * No separate hosting service needed — this runs alongside the app itself.
 *
 * Environment variables to set in the Cloudflare Pages dashboard
 * (Project → Settings → Environment variables):
 *   OCR_SPACE_KEY   - free key from https://ocr.space/ocrapi
 *   SHEET_CSV_URL   - the "Publish to web" CSV URL for the Materials sheet
 *
 * No credit card required anywhere in this setup.
 */

export async function onRequestOptions() {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(),
  });
}

export async function onRequestPost(context) {
  try {
    const { request, env } = context;
    const { image, expected } = await request.json();

    if (!image || !expected) {
      return json({ error: 'Missing image or expected material number.' }, 400);
    }

    const readText = await runOcrSpace(image, env.OCR_SPACE_KEY);
    const knownMaterials = await loadMaterialNumbers(env.SHEET_CSV_URL);
    const isKnown = knownMaterials.some(
      (m) => m.toLowerCase() === expected.toLowerCase()
    );
    const { similarity, exact } = scoreMatch(expected, readText);

    return json({
      readText,
      similarity,
      exact,
      isKnownMaterial: isKnown,
      pass: exact, // strict policy: only an exact normalized match passes
    });
  } catch (err) {
    return json({ error: 'OCR or Sheets lookup failed.', detail: err.message }, 500);
  }
}

function corsHeaders() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
  };
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders() },
  });
}

async function runOcrSpace(imageDataUrl, apiKey) {
  const body = new URLSearchParams();
  body.append('apikey', apiKey);
  body.append('base64Image', imageDataUrl);
  body.append('OCREngine', '2');
  body.append('scale', 'true');

  const resp = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    body,
  });
  const data = await resp.json();

  if (data.IsErroredOnProcessing) {
    throw new Error(data.ErrorMessage?.[0] || 'OCR.space processing error');
  }
  return (data.ParsedResults?.[0]?.ParsedText || '').trim();
}

async function loadMaterialNumbers(csvUrl) {
  const resp = await fetch(csvUrl);
  if (!resp.ok) {
    throw new Error('Could not fetch published Sheet CSV — check SHEET_CSV_URL.');
  }
  const csvText = await resp.text();
  const rows = csvText
    .split('\n')
    .map((line) => line.split(',')[0]?.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
  return rows.slice(1); // skip header row
}

function normalize(s) {
  return s.toUpperCase().replace(/[^A-Z0-9]/g, '');
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = Math.min(
        dp[i - 1][j] + 1,
        dp[i][j - 1] + 1,
        dp[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)
      );
    }
  }
  return dp[m][n];
}

function scoreMatch(expected, readText) {
  const a = normalize(expected);
  const b = normalize(readText);
  const dist = levenshtein(a, b);
  const maxLen = Math.max(a.length, b.length, 1);
  const similarity = 1 - dist / maxLen;
  const exact = a === b;
  return { similarity, exact };
}
