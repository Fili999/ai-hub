#!/usr/bin/env node
/**
 * generate-pdf.mjs
 * Cross-platform script to compile HTML files into high-quality PDFs
 * using headless Google Chrome / Chromium with full support for CSS Paged Media (@page),
 * Google Fonts, SVG, and vector graphics.
 *
 * Usage:
 *   node generate-pdf.mjs <input.html> [output.pdf] [--landscape] [--wait-ms 1000]
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

const args = process.argv.slice(2);
const flags = {
  landscape: false,
  waitMs: 500,
  noBackgrounds: false,
};

const positional = [];
for (let i = 0; i < args.length; i++) {
  const arg = args[i];
  if (arg === '--landscape') {
    flags.landscape = true;
  } else if (arg === '--wait-ms' && i + 1 < args.length) {
    flags.waitMs = parseInt(args[++i], 10) || 500;
  } else if (arg === '--no-backgrounds') {
    flags.noBackgrounds = true;
  } else if (arg.startsWith('--')) {
    // ignore other unrecognized flags
  } else {
    positional.push(arg);
  }
}

if (positional.length === 0) {
  console.error('Usage: node generate-pdf.mjs <input.html> [output.pdf] [--landscape] [--wait-ms 500]');
  process.exit(1);
}

const inputPath = path.resolve(positional[0]);
if (!fs.existsSync(inputPath)) {
  console.error(`Error: Input HTML file not found: ${inputPath}`);
  process.exit(1);
}

let outputPath;
if (positional.length > 1) {
  outputPath = path.resolve(positional[1]);
} else {
  const parsed = path.parse(inputPath);
  outputPath = path.join(parsed.dir, `${parsed.name}.pdf`);
}

// Ensure the destination directory exists
fs.mkdirSync(path.dirname(outputPath), { recursive: true });

/**
 * Ensures the HTML file contains @media screen rules for screen display
 * so pages are centered and not stuck to window borders.
 */
function ensureScreenStyles(filePath) {
  try {
    let content = fs.readFileSync(filePath, 'utf8');
    if (content.includes('@media screen')) {
      return; // Already present
    }

    const screenCss = `
    /* ================= SCREEN PREVIEW (BROWSER SCREEN VIEW) ================= */
    @media screen {
      body {
        background-color: #0b132b;
        background-image: radial-gradient(circle at 50% 0%, rgba(31, 95, 224, 0.18) 0%, transparent 60%);
        padding: 40px 20px;
        color: var(--text-color, #1e293b);
        min-height: 100vh;
      }

      .cover-page,
      .chapter {
        max-width: 880px;
        margin: 0 auto 36px auto;
        border-radius: 12px;
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35), 0 2px 8px rgba(0, 0, 0, 0.15);
        overflow: hidden;
      }

      .cover-page {
        height: auto;
        min-height: 860px;
        padding: 55px 48px;
        border: 1px solid rgba(255, 255, 255, 0.15);
      }

      .chapter {
        background: #ffffff;
        padding: 50px 48px;
        border: 1px solid var(--border-color, #e2e8f0);
      }

      .arch-diagram-card,
      .milestone-table {
        overflow-x: auto;
      }
    }

    @media screen and (max-width: 768px) {
      body {
        padding: 16px 10px;
      }

      .cover-page,
      .chapter {
        padding: 30px 20px;
        margin-bottom: 20px;
        border-radius: 8px;
      }

      .cover-title {
        font-size: 24pt;
      }

      .cover-subtitle {
        font-size: 11pt;
      }

      .highlight-grid {
        grid-template-columns: 1fr;
      }

      .cover-bottom {
        flex-direction: column;
        gap: 12px;
      }
    }`;

    if (content.includes('</style>')) {
      content = content.replace('</style>', `${screenCss}\n  </style>`);
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('ℹ Injected @media screen block into HTML file for centered browser preview.');
    } else if (content.includes('</head>')) {
      content = content.replace('</head>', `  <style>${screenCss}\n  </style>\n</head>`);
      fs.writeFileSync(filePath, content, 'utf8');
      console.log('ℹ Injected @media screen block into HTML file for centered browser preview.');
    }
  } catch (err) {
    console.warn(`Warning: Could not inject @media screen styles: ${err.message}`);
  }
}

// Inject screen styles if missing prior to PDF compilation
ensureScreenStyles(inputPath);

/**
 * Locate the Google Chrome / Chromium executable on the system
 */
function findChromeExecutable() {
  if (process.env.CHROME_PATH && fs.existsSync(process.env.CHROME_PATH)) {
    return process.env.CHROME_PATH;
  }
  if (process.env.ARCHIFY_CHROME && fs.existsSync(process.env.ARCHIFY_CHROME)) {
    return process.env.ARCHIFY_CHROME;
  }
  if (process.env.PUPPETEER_EXECUTABLE_PATH && fs.existsSync(process.env.PUPPETEER_EXECUTABLE_PATH)) {
    return process.env.PUPPETEER_EXECUTABLE_PATH;
  }

  const platform = process.platform;
  let candidates = [];

  if (platform === 'darwin') {
    candidates = [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      '/Applications/Google Chrome Canary.app/Contents/MacOS/Google Chrome Canary',
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
    ];
  } else if (platform === 'win32') {
    const progFiles = process.env['ProgramFiles'] || 'C:\\Program Files';
    const progFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    const localAppData = process.env['LOCALAPPDATA'] || '';
    candidates = [
      path.join(progFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      path.join(progFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ];
  } else {
    // Linux and fallback
    candidates = [
      'google-chrome',
      'google-chrome-stable',
      'chromium',
      'chromium-browser',
      '/usr/bin/google-chrome',
      '/usr/bin/chromium',
      '/usr/bin/chromium-browser',
      '/snap/bin/chromium',
    ];
  }

  for (const c of candidates) {
    if (path.isAbsolute(c) && fs.existsSync(c)) {
      return c;
    }
    // Try 'which' on Linux
    if (!path.isAbsolute(c) && platform !== 'win32') {
      try {
        const out = execFileSync('which', [c], { stdio: ['pipe', 'pipe', 'ignore'] }).toString().trim();
        if (out && fs.existsSync(out)) return out;
      } catch {
        // ignore
      }
    }
  }

  return null;
}

const chromePath = findChromeExecutable();
if (!chromePath) {
  console.error('Error: Google Chrome or Chromium executable could not be found.');
  console.error('Ensure Google Chrome is installed or set the CHROME_PATH environment variable.');
  process.exit(1);
}

// Convert input path to file:// URL
let fileUrl = inputPath;
if (!fileUrl.startsWith('file://')) {
  // Handle Windows vs Unix separators
  const normalized = inputPath.replace(/\\/g, '/');
  fileUrl = normalized.startsWith('/') ? `file://${normalized}` : `file:///${normalized}`;
}

const chromeArgs = [
  '--headless=new',
  '--disable-gpu',
  '--no-first-run',
  '--no-default-browser-check',
  '--no-pdf-header-footer',
  '--run-all-compositor-stages-before-draw',
  `--print-to-pdf=${outputPath}`,
];

if (flags.landscape) {
  chromeArgs.push('--print-to-pdf-orientation=landscape');
}

chromeArgs.push(fileUrl);

try {
  const result = spawnSync(chromePath, chromeArgs, {
    stdio: ['ignore', 'pipe', 'pipe'],
    encoding: 'utf8',
    timeout: 60000,
  });

  if (!fs.existsSync(outputPath)) {
    console.error('Error: PDF generation failed. Chrome output:');
    if (result.stderr) console.error(result.stderr);
    if (result.stdout) console.error(result.stdout);
    process.exit(1);
  }

  const stats = fs.statSync(outputPath);
  const sizeKb = (stats.size / 1024).toFixed(1);
  console.log(`✔ PDF generated successfully: ${outputPath} (${sizeKb} KB)`);
} catch (err) {
  console.error(`Unexpected error while running Chrome: ${err.message}`);
  process.exit(1);
}
