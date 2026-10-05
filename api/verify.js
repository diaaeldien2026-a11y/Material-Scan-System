/**
 * Material Verify â€” backend proxy (Vercel serverless function)
 *
 * Purpose:
 *  - Receives a label photo + the material number the technician entered.
 *  - Calls OCR.space to read the label text (API key stays server-side).
 *  - Looks up the material number in a Google Sheet (read via a simple API key).
 *  - Returns the read text + a pass/fail match to the phone app.
 *
 * No credit card needed anywhere in this setup.
 *
 * Environment variables to set in Vercel (Project Settings â†’ Environment Variables):
 *   OCR_SPACE_KEY    - free key from https://ocr.space/ocrapi
 *   SHEET_CSV_URL    - the "Publish to web" CSV URL for the Materials sheet
 *                      (Google Sheet â†’ File â†’ Share â†’ Publish to web â†’ CSV)
 *                      No Google Cloud project, API key, or card needed.
 */

export default async function handler(req, res) {
  // CORS so the phone app can call this from a different origin
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Use POST' });

  try {
    const { image, expected } = req.body; // image = base64 data URL, expected = material number
    if (!image || !expected) {
      return res.status(400).json({ error: 'Missing image or expected material number.' });
    }

    const ocr = await runOcrSpace(image);
    const knownMaterials = await loadMaterialNumbers();
    const fold = (s) => String(s).toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/O/g, '0').replace(/I/g, '1');
    const isKnown = knownMaterials.some((m) => fold(m) === fold(expected));
    const { similarity, exact } = scoreMatch(expected, ocr.readText);

    return res.status(200).json({
      readText: ocr.readText,
      similarity,
      exact,
      isKnownMaterial: isKnown,
      pass: exact, // strict policy: only an exact normalized match passes
      _debug: {
        ocr: ocr.debug,
        sheet: {
          csvUrlSet: !!process.env.SHEET_CSV_URL,
          rawMaterialsFromSheet: knownMaterials,
          expectedRaw: expected,
          expectedFolded: fold(expected),
          foldedSheetValues: knownMaterials.map(fold),
        },
      }, // temporary â€” remove once confirmed working
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'OCR or Sheets lookup failed.', detail: err.message });
  }
}

async function runOcrSpace(imageDataUrl) {
  const body = new URLSearchParams();
  body.append('apikey', process.env.OCR_SPACE_KEY);
  body.append('base64Image', imageDataUrl); // OCR.space accepts the full data: URL directly
  body.append('OCREngine', '2'); // more accurate than engine 1 â€” timeout is no longer the constraint
  body.append('scale', 'true');
  body.append('detectOrientation', 'true'); // handles a slightly tilted label photo
  body.append('language', 'eng');

  const resp = await fetch('https://api.ocr.space/parse/image', {
    method: 'POST',
    body,
  });
  const data = await resp.json();

  return {
    readText: (data.ParsedResults?.[0]?.ParsedText || '').trim(),
    debug: {
      httpStatus: resp.status,
      raw: data, // temporary â€” full raw response for debugging
    },
  };
}

async function loadMaterialNumbers() {
  const resp = await fetch(process.env.SHEET_CSV_URL);
  if (!resp.ok) {
    throw new Error('Could not fetch published Sheet CSV â€” check SHEET_CSV_URL.');
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
